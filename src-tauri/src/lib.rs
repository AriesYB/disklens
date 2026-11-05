// DiskLens — 磁盘空间分析（treemap 客户端）
// 扫描引擎 v0：单线程 DFS + 增量事件（对齐 Map-Reloc.ps1 原型的 flush 设计：
// 32MB / 400 项 / 250ms 任一触发即向前端推送部分大小；目录完成推 done 事件）。
// 跳过 reparse point（junction/symlink，避免环与重复计数）与 deny 目录。

use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct ScanState {
    stop: AtomicBool,
    running: Mutex<bool>,
}

#[derive(Clone, serde::Serialize)]
struct NodeEvent {
    path: String,
    parent: String,
    name: String,
    size: u64,
    done: bool,
    file: bool,
}

const DENY_DIRS: &[&str] = &["system volume information", "$winreagent", "recovery"];

/// ≥ 此大小的文件作为独立节点事件推给前端（也是"大文件榜"的数据来源下限）
const MIN_BIG_FILE: u64 = 10 * 1024 * 1024;
/// 单目录最多独立上报的大文件数（超出的并入目录大小，防止海量大文件刷爆事件流）
const MAX_BIG_FILES_PER_DIR: u64 = 200;

// FILE_ATTRIBUTE_REPARSE_POINT
#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

fn is_deny(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    DENY_DIRS.iter().any(|d| *d == n)
}

fn is_reparse(sm: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        sm.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        sm.file_type().is_symlink()
    }
}

fn emit(app: &AppHandle, ev: &NodeEvent) {
    let _ = app.emit("scan-update", ev);
}

// 单个目录的 DFS：返回子树总大小。开始时推 size=0 占位事件，期间按阈值推部分大小，
// 完成时推 done 事件。前端按 parent 链组装树、按 done 驱动折叠/特效。
fn scan_dir(
    app: &AppHandle,
    dir: &Path,
    parent: String,
    name: String,
    depth: u32,
    stop: &AtomicBool,
) -> u64 {
    let path_str = dir.to_string_lossy().to_string();
    emit(
        app,
        &NodeEvent {
            path: path_str.clone(),
            parent: parent.clone(),
            name: name.clone(),
            size: 0,
            done: false,
            file: false,
        },
    );

    let mut pending: u64 = 0;
    let mut n_items: u64 = 0;
    let mut last_flush = Instant::now();
    let mut big_file_count: u64 = 0;

    let rd = fs::read_dir(dir);
    let mut total: u64 = 0;
    if let Ok(rd) = rd {
        for entry in rd.flatten() {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            n_items += 1;
            let got = (|| -> Option<u64> {
                let sm = fs::symlink_metadata(entry.path()).ok()?;
                if is_reparse(&sm) {
                    return Some(0); // junction/symlink 计 0：不重复计数、不成环
                }
                if sm.is_dir() {
                    let child_name = entry.file_name().to_string_lossy().to_string();
                    if is_deny(&child_name) {
                        return Some(0);
                    }
                    if depth == 0 {
                        return Some(0); // 深度兜底（防异常深树爆栈）
                    }
                    Some(scan_dir(
                        app,
                        &entry.path(),
                        path_str.clone(),
                        child_name,
                        depth - 1,
                        stop,
                    ))
                } else {
                    let len = sm.len();
                    if len >= MIN_BIG_FILE && big_file_count < MAX_BIG_FILES_PER_DIR {
                        big_file_count += 1;
                        emit(
                            app,
                            &NodeEvent {
                                path: entry.path().to_string_lossy().to_string(),
                                parent: path_str.clone(),
                                name: entry.file_name().to_string_lossy().to_string(),
                                size: len,
                                done: true,
                                file: true,
                            },
                        );
                    }
                    Some(len)
                }
            })();
            if let Some(v) = got {
                pending += v;
            }
            // flush：32MB / 400 项 / 250ms 任一触发（时间驱动保证小目录也持续出数）
            if pending >= 32 * 1024 * 1024
                || n_items % 400 == 0
                || last_flush.elapsed() >= Duration::from_millis(250)
            {
                total += pending;
                pending = 0;
                emit(
                    app,
                    &NodeEvent {
                        path: path_str.clone(),
                        parent: parent.clone(),
                        name: name.clone(),
                        size: total,
                        done: false,
                        file: false,
                    },
                );
                last_flush = Instant::now();
            }
        }
    }
    total += pending;
    emit(
        app,
        &NodeEvent {
            path: path_str,
            parent,
            name,
            size: total,
            done: true,
            file: false,
        },
    );
    total
}

#[tauri::command]
fn scan_start(app: AppHandle, state: State<'_, ScanState>, root: String) -> Result<(), String> {
    let root_path = Path::new(&root).to_path_buf();
    if !root_path.is_dir() {
        return Err(format!("目录不存在：{}", root));
    }
    {
        let mut running = state.running.lock().map_err(|e| e.to_string())?;
        if *running {
            return Err("已有扫描在进行".into());
        }
        *running = true;
    }
    state.stop.store(false, Ordering::Relaxed);

    let app2 = app.clone();
    std::thread::spawn(move || {
        let root_name = root_path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| root_path.to_string_lossy().to_string());
        let parent = root_path
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let t0 = Instant::now();
        scan_dir(
            &app2,
            &root_path,
            parent,
            root_name,
            48,
            &app2.state::<ScanState>().stop,
        );
        let _ = app2.emit(
            "scan-finished",
            format!("扫描完成，用时 {:.1}s", t0.elapsed().as_secs_f32()),
        );
        if let Ok(mut r) = app2.state::<ScanState>().running.lock() {
            *r = false;
        }
    });
    Ok(())
}

#[tauri::command]
fn scan_stop(state: State<'_, ScanState>) {
    state.stop.store(true, Ordering::Relaxed);
}

#[tauri::command]
fn scan_status(state: State<'_, ScanState>) -> bool {
    matches!(state.running.lock(), Ok(true))
}

#[tauri::command]
fn open_in_explorer(path: String, select: bool) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err(format!("路径不存在：{}", path));
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // explorer 的 /select 语法要求引号内逗号且不做标准转义，必须 raw_arg
        let arg = if select {
            format!("/select,\"{}\"", path)
        } else {
            format!("\"{}\"", path)
        };
        std::process::Command::new("explorer.exe")
            .raw_arg(arg)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let cmd = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        std::process::Command::new(cmd)
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

// ======================== 迁移（junction 方式） ========================
// 设计见 DESIGN.md「迁移功能评估」。核心原则：**先复制后切换，任何失败源目录保持原样**。
// 三阶段事务：copy（同卷 rename 直达 / 跨卷复制，断点续传）→ verify（对账）→
// switch（删源内容 + 原位建 junction）。被占用文件只会让 switch 停下并返回清单，
// 数据永远同时存在于两侧之一。

#[derive(Default)]
pub struct MigrateState {
    stop: AtomicBool,
    running: Mutex<bool>,
}

#[derive(Clone, serde::Serialize)]
struct VolumeInfo {
    mount: String,
    label: String,
    fs: String,
    free_bytes: u64,
    total_bytes: u64,
}

#[derive(Clone, serde::Serialize)]
struct CheckResult {
    ok: bool,
    blockers: Vec<String>,
    warnings: Vec<String>,
    src_bytes: u64,
    src_files: u64,
    dest_path: String,
    dest_free: u64,
    same_volume: bool,
}

#[derive(Clone, serde::Serialize)]
struct MigrateEvent {
    stage: String, // copy|verify|switch|done|error|locked|aborted
    bytes_done: u64,
    bytes_total: u64,
    files_done: u64,
    files_total: u64,
    current: String,
    locked: Vec<String>,
    message: String,
}

fn norm_path(p: &str) -> String {
    let t = p.trim();
    if t.len() > 3 {
        t.trim_end_matches('\\').to_string()
    } else {
        t.to_string() // 盘根 "C:\" 保留尾反斜杠
    }
}

fn volume_prefix(p: &str) -> String {
    let b = p.as_bytes();
    if b.len() >= 3 && b[1] == b':' && (b[2] == b'\\') {
        p[..3].to_string()
    } else {
        String::new()
    }
}

fn is_under(child: &str, parent: &str) -> bool {
    let c = child.to_ascii_lowercase();
    let mut p = parent.to_ascii_lowercase();
    if !p.ends_with('\\') {
        p.push('\\');
    }
    c.len() > p.len() && c.starts_with(&p)
}

/// 硬性禁止迁移的位置（返回原因）
fn system_guard(p: &str) -> Option<&'static str> {
    let pl = p.to_ascii_lowercase();
    if pl.len() <= 3 {
        return Some("不能迁移盘根");
    }
    if pl.starts_with("c:\\windows") {
        return Some("系统目录（C:\\Windows）不可迁移");
    }
    if DENY_DIRS
        .iter()
        .any(|d| pl.contains(&format!("\\{}", d)))
    {
        return Some("系统保留目录不可迁移");
    }
    None
}

fn fmt_bytes(b: u64) -> String {
    if b >= 1073741824 {
        format!("{:.2} GB", b as f64 / 1073741824.0)
    } else if b >= 1048576 {
        format!("{:.1} MB", b as f64 / 1048576.0)
    } else if b >= 1024 {
        format!("{:.0} KB", b as f64 / 1024.0)
    } else {
        format!("{} B", b)
    }
}

#[derive(Default)]
struct WalkStats {
    bytes: u64,
    files: u64,
    unreadable: u64,
    inner_links: bool,
}

/// 预检/对账共用的子树统计；遇到 reparse point 标记 inner_links（跳过内容）
fn walk_stats(dir: &Path, stop: &AtomicBool, st: &mut WalkStats) {
    if stop.load(Ordering::Relaxed) {
        return;
    }
    let rd = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => {
            st.unreadable += 1;
            return;
        }
    };
    for entry in rd.flatten() {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        let sm = match fs::symlink_metadata(entry.path()) {
            Ok(m) => m,
            Err(_) => {
                st.unreadable += 1;
                continue;
            }
        };
        if is_reparse(&sm) {
            st.inner_links = true;
            continue;
        }
        if sm.is_dir() {
            walk_stats(&entry.path(), stop, st);
        } else {
            st.files += 1;
            st.bytes += sm.len();
        }
    }
}

#[cfg(windows)]
fn probe_volumes() -> Vec<VolumeInfo> {
    use windows_sys::Win32::Storage::FileSystem::{
        GetDiskFreeSpaceExW, GetLogicalDriveStringsW, GetVolumeInformationW,
    };
    let mut out = Vec::new();
    unsafe {
        let mut buf = [0u16; 512];
        let n = GetLogicalDriveStringsW(buf.len() as u32, buf.as_mut_ptr()) as usize;
        let mut start = 0usize;
        while start < n {
            let rel = &buf[start..n];
            let off = match rel.iter().position(|&c| c == 0) {
                Some(o) => o,
                None => break,
            };
            let mount = String::from_utf16_lossy(&rel[..off]);
            start += off + 1;
            if mount.len() < 3 || mount.as_bytes()[1] != b':' {
                continue;
            }
            let w: Vec<u16> = mount.encode_utf16().chain([0]).collect();
            let mut free: u64 = 0;
            let mut total: u64 = 0;
            let has_space = GetDiskFreeSpaceExW(w.as_ptr(), std::ptr::null_mut(), &mut total, &mut free) != 0;
            let mut name = [0u16; 261];
            let mut fsname = [0u16; 64];
            let mut serial: u32 = 0;
            let mut maxlen: u32 = 0;
            let mut flags: u32 = 0;
            let has_info = GetVolumeInformationW(
                w.as_ptr(),
                name.as_mut_ptr(),
                261,
                &mut serial,
                &mut maxlen,
                &mut flags,
                fsname.as_mut_ptr(),
                64,
            ) != 0;
            let cut = |s: &[u16]| -> String {
                let l = s.iter().position(|&c| c == 0).unwrap_or(s.len());
                String::from_utf16_lossy(&s[..l])
            };
            out.push(VolumeInfo {
                mount,
                label: if has_info { cut(&name) } else { String::new() },
                fs: if has_info { cut(&fsname) } else { String::new() },
                free_bytes: if has_space { free } else { 0 },
                total_bytes: if has_space { total } else { 0 },
            });
        }
    }
    out
}

#[cfg(not(windows))]
fn probe_volumes() -> Vec<VolumeInfo> {
    Vec::new()
}

#[tauri::command]
fn list_volumes() -> Vec<VolumeInfo> {
    probe_volumes()
}

#[tauri::command]
fn migrate_check(src: String, dest_root: String) -> Result<CheckResult, String> {
    let src_n = norm_path(&src);
    let dest_root_n = norm_path(&dest_root);
    let mut blockers: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    let md = fs::symlink_metadata(&src_n).map_err(|e| format!("无法读取源路径：{}", e))?;
    if !md.is_dir() {
        blockers.push("源不是目录（junction 方式只适用于目录；文件请到对应软件里改路径）".into());
    }
    if is_reparse(&md) {
        blockers.push("源本身已是链接（junction/symlink），无需重复迁移".into());
    }
    if volume_prefix(&src_n).is_empty() {
        blockers.push("暂不支持该路径类型（需要本地盘符路径）".into());
    }
    if volume_prefix(&dest_root_n).is_empty() {
        blockers.push("目标需为本地盘符路径（如 D:\\）".into());
    }
    if let Some(g) = system_guard(&src_n) {
        blockers.push(g.into());
    }
    let basename = src_n.rsplit('\\').next().unwrap_or("").to_string();
    if basename.is_empty() {
        blockers.push("无法解析目录名".into());
    }
    let dest_path = format!("{}\\{}", dest_root_n, basename);
    if is_under(&dest_root_n, &src_n) {
        blockers.push("目标不能位于源目录内部".into());
    }
    if fs::symlink_metadata(&dest_path).is_ok() {
        blockers.push(format!("目标位置已存在：{}", dest_path));
    }

    let stop = AtomicBool::new(false);
    let mut stats = WalkStats::default();
    walk_stats(Path::new(&src_n), &stop, &mut stats);
    if stats.inner_links {
        blockers.push("源目录内含其他链接（junction/symlink），暂不支持嵌套链接迁移".into());
    }
    if stats.unreadable > 0 {
        warnings.push(format!(
            "{} 个子项无法读取（权限限制），迁移会在这些项上失败",
            stats.unreadable
        ));
    }

    let src_vol = volume_prefix(&src_n);
    let same_volume = !src_vol.is_empty()
        && src_vol.eq_ignore_ascii_case(&volume_prefix(&dest_root_n));
    let mut dest_free: u64 = 0;
    for v in probe_volumes() {
        if v.mount.eq_ignore_ascii_case(&volume_prefix(&dest_root_n)) {
            dest_free = v.free_bytes;
            if !same_volume && v.fs.eq_ignore_ascii_case("FAT32") {
                warnings.push("目标卷为 FAT32（单文件 4GB 上限），建议选择 NTFS 卷".into());
            }
        }
    }
    if !same_volume && stats.bytes > dest_free {
        blockers.push(format!(
            "目标空间不足：需要 {}，目标仅剩 {}",
            fmt_bytes(stats.bytes),
            fmt_bytes(dest_free)
        ));
    }
    if is_under(&src_n, "C:\\Program Files")
        || is_under(&src_n, "C:\\Program Files (x86)")
        || is_under(&src_n, "C:\\ProgramData")
    {
        warnings.push(
            "这是软件安装/公共数据目录：junction 对程序透明，通常无感；但带自更新校验的软件可能异常，建议优先在软件内改路径".into(),
        );
    }
    warnings.push("开始迁移前请关闭正在使用该目录的程序".into());

    Ok(CheckResult {
        ok: blockers.is_empty(),
        blockers,
        warnings,
        src_bytes: stats.bytes,
        src_files: stats.files,
        dest_path,
        dest_free,
        same_volume,
    })
}

fn emit_mig(
    app: &AppHandle,
    stage: &str,
    msg: &str,
    current: &str,
    bytes_done: u64,
    bytes_total: u64,
    files_done: u64,
    files_total: u64,
    locked: &[String],
) {
    let _ = app.emit(
        "migrate-update",
        MigrateEvent {
            stage: stage.into(),
            bytes_done,
            bytes_total,
            files_done,
            files_total,
            current: current.into(),
            locked: locked.to_vec(),
            message: msg.into(),
        },
    );
}

fn create_junction(link: &str, target: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // mklink 对结尾反斜杠 + 引号解析有坑，统一去掉
        let link = link.trim_end_matches('\\');
        let target = target.trim_end_matches('\\');
        let out = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J", link, target])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            let md = fs::symlink_metadata(link).map_err(|e| e.to_string())?;
            if is_reparse(&md) {
                return Ok(());
            }
            return Err("命令成功但未检测到 reparse point".into());
        }
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (link, target);
        Err("仅 Windows 支持 junction".into())
    }
}

enum CopyAbort {
    Stopped,
    Failed,
}

struct CopyCtx<'a> {
    app: &'a AppHandle,
    bytes_done: u64,
    files_done: u64,
    last_emit: Instant,
    errors: Vec<String>,
}

/// 复制 src 子树到 dst（dst 为对应的目标根，自身不存在则创建）。
/// 断点续传：同名同大小文件跳过。任何一项失败即中止（数据安全优先）。
fn copy_tree(
    ctx: &mut CopyCtx,
    src: &Path,
    dst: &Path,
    total_bytes: u64,
    total_files: u64,
    stop: &AtomicBool,
) -> Result<(), CopyAbort> {
    if stop.load(Ordering::Relaxed) {
        return Err(CopyAbort::Stopped);
    }
    if let Err(e) = fs::create_dir_all(dst) {
        ctx.errors.push(format!("{}（创建目录失败：{}）", dst.display(), e));
        return Err(CopyAbort::Failed);
    }
    let rd = match fs::read_dir(src) {
        Ok(r) => r,
        Err(e) => {
            ctx.errors.push(format!("{}（{}）", src.display(), e));
            return Err(CopyAbort::Failed);
        }
    };
    for entry in rd.flatten() {
        if stop.load(Ordering::Relaxed) {
            return Err(CopyAbort::Stopped);
        }
        let sp = entry.path();
        let sm = match fs::symlink_metadata(&sp) {
            Ok(m) => m,
            Err(e) => {
                ctx.errors.push(format!("{}（{}）", sp.display(), e));
                return Err(CopyAbort::Failed);
            }
        };
        if is_reparse(&sm) {
            ctx.errors
                .push(format!("{}（内含链接，不支持嵌套迁移）", sp.display()));
            return Err(CopyAbort::Failed);
        }
        let dp = dst.join(entry.file_name());
        if sm.is_dir() {
            copy_tree(ctx, &sp, &dp, total_bytes, total_files, stop)?;
        } else {
            let mut need = true;
            if let Ok(dm) = fs::metadata(&dp) {
                if dm.len() == sm.len() {
                    need = false; // 断点续传：已复制过
                }
            }
            if need {
                if let Err(e) = fs::copy(&sp, &dp) {
                    ctx.errors.push(format!("{}（{}）", sp.display(), e));
                    return Err(CopyAbort::Failed);
                }
            }
            ctx.bytes_done += sm.len();
            ctx.files_done += 1;
            if ctx.last_emit.elapsed() >= Duration::from_millis(250) {
                emit_mig(
                    ctx.app, "copy", "复制中…", &sp.display().to_string(),
                    ctx.bytes_done, total_bytes, ctx.files_done, total_files, &[],
                );
                ctx.last_emit = Instant::now();
            }
        }
    }
    Ok(())
}

/// 自底向上删除源目录内容；被占用/失败的路径进 locked（数据无损，可重试）
fn delete_contents(dir: &Path, stop: &AtomicBool, locked: &mut Vec<String>) {
    let rd = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(e) => {
            locked.push(format!("{}（{}）", dir.display(), e));
            return;
        }
    };
    for entry in rd.flatten() {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        let p = entry.path();
        let is_dir = fs::symlink_metadata(&p).map(|m| m.is_dir()).unwrap_or(false);
        if is_dir {
            delete_contents(&p, stop, locked);
            if let Err(e) = fs::remove_dir(&p) {
                locked.push(format!("{}（{}）", p.display(), e));
            }
        } else if let Err(e) = fs::remove_file(&p) {
            locked.push(format!("{}（{}）", p.display(), e));
        }
    }
}

#[tauri::command]
fn migrate_start(
    app: AppHandle,
    state: State<'_, MigrateState>,
    src: String,
    dest_root: String,
) -> Result<(), String> {
    let src_n = norm_path(&src);
    let dest_root_n = norm_path(&dest_root);
    if !fs::symlink_metadata(&src_n)
        .map_err(|e| e.to_string())?
        .is_dir()
    {
        return Err("源必须是目录".into());
    }
    {
        let mut r = state.running.lock().map_err(|e| e.to_string())?;
        if *r {
            return Err("已有迁移在进行".into());
        }
        *r = true;
    }
    state.stop.store(false, Ordering::Relaxed);

    let app2 = app.clone();
    std::thread::spawn(move || {
        let mig = app2.state::<MigrateState>();
        let stop = &mig.stop;
        let basename = src_n.rsplit('\\').next().unwrap_or("").to_string();
        let dest_path = format!("{}\\{}", dest_root_n, basename);
        let same_volume = volume_prefix(&src_n).eq_ignore_ascii_case(&volume_prefix(&dest_root_n))
            && !volume_prefix(&src_n).is_empty();
        let mut aborted = false;

        if same_volume {
            // 同卷快速路径：rename 瞬时完成，再回原位建 junction
            emit_mig(&app2, "switch", "同卷迁移：重命名（瞬时）…", "", 0, 0, 0, 0, &[]);
            if let Err(e) = fs::rename(&src_n, &dest_path) {
                emit_mig(&app2, "error", &format!("重命名失败（可能有程序占用目录）：{}", e), "", 0, 0, 0, 0, &[]);
            } else if let Err(e) = create_junction(&src_n, &dest_path) {
                let _ = fs::rename(&dest_path, &src_n); // 回滚，数据归位
                emit_mig(&app2, "error", &format!("创建链接失败，已回滚：{}", e), "", 0, 0, 0, 0, &[]);
            } else {
                emit_mig(&app2, "done", "迁移完成（同卷 rename + junction）", "", 0, 0, 0, 0, &[]);
            }
        } else {
            // 阶段 1：复制（断点续传）
            let mut stats = WalkStats::default();
            walk_stats(Path::new(&src_n), stop, &mut stats);
            if stats.inner_links {
                emit_mig(&app2, "error", "源目录内含其他链接，无法迁移（见预检）", "", 0, 0, 0, 0, &[]);
            } else if stop.load(Ordering::Relaxed) {
                aborted = true;
            } else {
                emit_mig(&app2, "copy", "复制中…", "", 0, stats.bytes, 0, stats.files, &[]);
                let mut ctx = CopyCtx {
                    app: &app2,
                    bytes_done: 0,
                    files_done: 0,
                    last_emit: Instant::now(),
                    errors: Vec::new(),
                };
                match copy_tree(
                    &mut ctx,
                    Path::new(&src_n),
                    Path::new(&dest_path),
                    stats.bytes,
                    stats.files,
                    stop,
                ) {
                    Err(CopyAbort::Stopped) => aborted = true,
                    Err(CopyAbort::Failed) => emit_mig(
                        &app2, "error", "复制失败：请解决下列文件后重试（已复制的会自动跳过）", "",
                        ctx.bytes_done, stats.bytes, ctx.files_done, stats.files, &ctx.errors,
                    ),
                    Ok(()) => {
                        // 阶段 2：对账
                        emit_mig(&app2, "verify", "校验中…", "", ctx.bytes_done, stats.bytes, ctx.files_done, stats.files, &[]);
                        let mut vstats = WalkStats::default();
                        walk_stats(Path::new(&dest_path), stop, &mut vstats);
                        if stop.load(Ordering::Relaxed) {
                            aborted = true;
                        } else if vstats.bytes != stats.bytes || vstats.files != stats.files {
                            emit_mig(&app2, "error",
                                &format!("校验不一致（源 {} 项/{}，目标 {} 项/{}）——迁移期间目录可能被修改",
                                    stats.files, fmt_bytes(stats.bytes), vstats.files, fmt_bytes(vstats.bytes)),
                                "", ctx.bytes_done, stats.bytes, ctx.files_done, stats.files, &[]);
                        } else {
                            // 阶段 3：切换（删源内容 → 建链接）
                            emit_mig(&app2, "switch", "切换中：删除源目录内容…", "", ctx.bytes_done, stats.bytes, ctx.files_done, stats.files, &[]);
                            let mut locked: Vec<String> = Vec::new();
                            delete_contents(Path::new(&src_n), stop, &mut locked);
                            if stop.load(Ordering::Relaxed) {
                                aborted = true;
                            } else if !locked.is_empty() {
                                emit_mig(&app2, "locked", "部分文件被占用，源目录保持原样；关闭相关程序后点「重试」", "",
                                    ctx.bytes_done, stats.bytes, ctx.files_done, stats.files, &locked);
                            } else if let Err(e) = fs::remove_dir(&src_n) {
                                emit_mig(&app2, "error", &format!("移除源空目录失败：{}", e), "", 0, 0, 0, 0, &[]);
                            } else if let Err(e) = create_junction(&src_n, &dest_path) {
                                let _ = fs::create_dir(&src_n); // 恢复空目录占位，数据在目标侧完好
                                emit_mig(&app2, "error", &format!("创建链接失败：{}（数据已完整保存在目标）", e), "", 0, 0, 0, 0, &[]);
                            } else {
                                emit_mig(&app2, "done", "迁移完成：原路径已是指向新位置的 junction", "",
                                    stats.bytes, stats.bytes, stats.files, stats.files, &[]);
                            }
                        }
                    }
                }
            }
        }
        if aborted {
            emit_mig(&app2, "aborted", "已停止：已完成部分保留，重新发起会自动续传", "", 0, 0, 0, 0, &[]);
        }
        if let Ok(mut r) = mig.running.lock() {
            *r = false;
        }
    });
    Ok(())
}

#[tauri::command]
fn migrate_stop(state: State<'_, MigrateState>) {
    state.stop.store(true, Ordering::Relaxed);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(ScanState::default())
        .manage(MigrateState::default())
        .invoke_handler(tauri::generate_handler![
            scan_start,
            scan_stop,
            scan_status,
            open_in_explorer,
            list_volumes,
            migrate_check,
            migrate_start,
            migrate_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deny_dirs_match_case_insensitively() {
        assert!(is_deny("System Volume Information"));
        assert!(is_deny("$WinREAgent"));
        assert!(is_deny("RECOVERY"));
        assert!(!is_deny("Windows"));
        assert!(!is_deny("users"));
    }

    #[test]
    fn node_event_serializes_expected_fields() {
        let ev = NodeEvent {
            path: r"C:\Users".into(),
            parent: r"C:\".into(),
            name: "Users".into(),
            size: 123,
            done: true,
            file: false,
        };
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["path"], r"C:\Users");
        assert_eq!(v["parent"], r"C:\");
        assert_eq!(v["name"], "Users");
        assert_eq!(v["size"], 123);
        assert_eq!(v["done"], true);
        assert_eq!(v["file"], false);
    }

    #[test]
    fn big_file_threshold_is_10mb() {
        assert_eq!(MIN_BIG_FILE, 10 * 1024 * 1024);
        assert!(MAX_BIG_FILES_PER_DIR > 0);
    }

    #[test]
    fn norm_path_keeps_drive_root_trailing_slash() {
        assert_eq!(norm_path("C:\\"), "C:\\");
        assert_eq!(norm_path("C:\\Users\\"), "C:\\Users");
        assert_eq!(norm_path(" C:\\Users\\Demo\\\\ "), "C:\\Users\\Demo");
    }

    #[test]
    fn volume_prefix_extracts_drive() {
        assert_eq!(volume_prefix("C:\\Users"), "C:\\");
        assert_eq!(volume_prefix("D:\\"), "D:\\");
        assert_eq!(volume_prefix("relative\\path"), "");
        assert_eq!(volume_prefix("\\\\server\\share"), "");
    }

    #[test]
    fn is_under_checks_boundary() {
        assert!(is_under("C:\\Users\\X\\Big", "C:\\Users\\X"));
        assert!(is_under("C:\\Users\\x\\BIG", "c:\\users"));
        assert!(!is_under("C:\\Users\\Xy", "C:\\Users\\X")); // 前缀不能是半个目录名
        assert!(!is_under("C:\\Users\\X", "C:\\Users\\X"));
    }

    #[test]
    fn system_guard_blocks_roots_and_system_dirs() {
        assert_eq!(system_guard("C:\\"), Some("不能迁移盘根"));
        assert!(system_guard("C:\\Windows\\System32").is_some());
        assert!(system_guard("D:\\System Volume Information").is_some());
        assert_eq!(system_guard("D:\\MyData\\Cache"), None);
    }

    #[test]
    fn fmt_bytes_units() {
        assert_eq!(fmt_bytes(512), "512 B");
        assert_eq!(fmt_bytes(2048), "2 KB");
        assert_eq!(fmt_bytes(3 * 1024 * 1024 * 1024 / 10), "0.30 GB");
    }
}
