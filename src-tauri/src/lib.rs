// DiskLens — 磁盘空间分析（treemap 客户端）
// 扫描引擎 v0：单线程 DFS + 增量事件（对齐 Map-Reloc.ps1 原型的 flush 设计：
// 32MB / 400 项 / 250ms 任一触发即向前端推送部分大小；目录完成推 done 事件）。
// 跳过 reparse point（junction/symlink，避免环与重复计数）与 deny 目录。

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use notify::Watcher as _;

#[cfg(windows)]
use std::os::windows::fs::MetadataExt;

#[derive(Default)]
pub struct ScanState {
    stop: Arc<AtomicBool>,
    running: Mutex<bool>,
    /// 未终结的扫描线程数（主扫描计 1，每个用户点击的优先扫描各计 1）；
    /// 减到 0 的那个线程负责发 scan-finished
    active: Mutex<usize>,
    /// 已完成子树的大小表：lower(path) -> (逻辑字节, 磁盘占用)。
    /// 并行工作线程/优先扫描到达某目录时若表里已有（被另一方先行完成）则直接采用，不再重扫
    sizes: Arc<Mutex<HashMap<String, (u64, u64)>>>,
    /// 大文件登记表（AI 通道 /api/tree 展示用）：lower(父目录) -> [(文件名, 逻辑字节, 占用)]。
    /// 与事件流同口径：仅 ≥MIN_BIG_FILE，且每目录最多 MAX_BIG_FILES_PER_DIR 条
    big_files: Arc<Mutex<HashMap<String, Vec<(String, u64, u64)>>>>,
}

/// 扫描完成后的实时监视状态：多盘齐扫时每个根一个 watcher
#[derive(Default)]
pub struct WatchState {
    inner: Mutex<Vec<WatchRun>>,
}

struct WatchRun {
    stop: Arc<AtomicBool>,
    root_lower: Option<String>,
    join: Option<std::thread::JoinHandle<()>>,
}

/// 监视事件合批后发给前端的一条变更：upsert（新建/修改，带类型与大小）或 remove
#[derive(Clone, serde::Serialize)]
struct FsEvent {
    path: String,
    kind: String, // "upsert" | "remove"
    is_dir: bool,
    size: u64,
    /// 磁盘占用口径（簇对齐近似；云占位文件为 0）
    al: u64,
}

#[derive(Clone, serde::Serialize)]
struct NodeEvent {
    path: String,
    parent: String,
    name: String,
    size: u64,
    /// 磁盘占用口径：普通文件按簇取整，≥DEDUP_MIN 文件取精确 AllocationSize；
    /// 云占位文件为 0；硬链接副本计 0（字节只记在首见路径）
    al: u64,
    done: bool,
    file: bool,
    /// 硬链接副本：同一数据已在另一路径计数，本节点字节/占用计 0
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    dup: bool,
    /// 云端占位文件（OneDrive 按需下载等）：本地无完整数据
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    cloud: bool,
    /// 目录无权限 / 部分条目读失败：体积为已读到的部分
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    denied: bool,
}

const DENY_DIRS: &[&str] = &["system volume information", "$winreagent", "recovery"];

/// ≥ 此大小的文件作为独立节点事件推给前端（也是"大文件榜"的数据来源下限）
const MIN_BIG_FILE: u64 = 10 * 1024 * 1024;
/// 单目录最多独立上报的大文件数（超出的并入目录大小，防止海量大文件刷爆事件流）
const MAX_BIG_FILES_PER_DIR: u64 = 200;
/// ≥ 此大小的文件才开句柄查硬链接身份与精确磁盘占用；小文件用簇对齐近似
/// （≥1MB 的文件占条目数极小却贡献绝大部分字节，WinSxS 的中大型 DLL 全覆盖）
#[cfg(windows)]
const DEDUP_MIN: u64 = 1024 * 1024;

// FILE_ATTRIBUTE_REPARSE_POINT
#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
// 以下属性位只用于位运算判定（读自 file_attributes()），不依赖平台 API，
// 常量不带 cfg 以便测试在任意平台编译
#[allow(dead_code)] // 仅单测用作"与 recall 无关的属性位"样本
const FILE_ATTRIBUTE_ARCHIVE: u32 = 0x20;
const FILE_ATTRIBUTE_COMPRESSED: u32 = 0x800;
const FILE_ATTRIBUTE_SPARSE_FILE: u32 = 0x200;
const FILE_ATTRIBUTE_RECALL_ON_OPEN: u32 = 0x4_0000;
const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS: u32 = 0x40_0000;

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

/// 云端占位（OneDrive 按需下载等）：本地无完整数据，磁盘占用视为 0
fn is_cloud_placeholder(attrs: u32) -> bool {
    attrs & (FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS) != 0
}

/// 磁盘占用（allocated 口径）近似：普通文件按簇取整；压缩/稀疏文件的真实占用
/// 无法便宜地取到，直接用逻辑大小（不取整，避免对压缩文件严重高估）
fn approx_alloc(len: u64, cluster: u32, attrs: u32) -> u64 {
    if len == 0 || cluster == 0 {
        return len;
    }
    if attrs & (FILE_ATTRIBUTE_COMPRESSED | FILE_ATTRIBUTE_SPARSE_FILE) != 0 {
        return len;
    }
    len.div_ceil(cluster as u64) * cluster as u64
}

/// 簇大小缓存：lower(盘根如 "c:") -> 簇字节数。API 很快，但没必要每文件查一次
#[cfg(windows)]
fn cluster_for(path: &str) -> u32 {
    use std::sync::OnceLock;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceW;
    static CACHE: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let lower = path.to_lowercase();
    let key: String = if lower.len() > 3 { lower[..3].to_string() } else { lower };
    if let Ok(m) = cache.lock() {
        if let Some(v) = m.get(&key) {
            return *v;
        }
    }
    let mut wide: Vec<u16> = key.encode_utf16().collect();
    if !wide.ends_with(&[b'\\' as u16]) {
        wide.push(b'\\' as u16);
    }
    wide.push(0);
    let (mut spc, mut bps): (u32, u32) = (0, 0);
    let (mut free_clusters, mut total_clusters): (u32, u32) = (0, 0);
    let ok = unsafe {
        GetDiskFreeSpaceW(wide.as_ptr(), &mut spc, &mut bps, &mut free_clusters, &mut total_clusters)
    } != 0;
    let v = if ok { spc * bps } else { 0 };
    if let Ok(mut m) = cache.lock() {
        m.insert(key, v);
    }
    v
}

#[cfg(not(windows))]
fn cluster_for(_path: &str) -> u32 {
    0
}

// 已计数的硬链接文件 ID（仅链接数>1 且 ≥DEDUP_MIN 的文件入集，内存只有几万条）。
// 全局集合：主扫描、优先扫描、监视补扫共用，保证同一数据只在首见路径计数一次
#[cfg(windows)]
static HL_SEEN: std::sync::LazyLock<Mutex<std::collections::HashSet<(u32, u64)>>> =
    std::sync::LazyLock::new(|| Mutex::new(std::collections::HashSet::new()));

/// 返回 true = 首次见到（应当计数）；false = 已在别处计数（本路径计 0）
#[cfg(windows)]
fn hl_seen_insert(id: (u32, u64)) -> bool {
    let mut g = HL_SEEN.lock().unwrap_or_else(|e| e.into_inner());
    g.insert(id)
}

#[cfg(windows)]
fn hl_seen_clear() {
    let mut g = HL_SEEN.lock().unwrap_or_else(|e| e.into_inner());
    g.clear();
}

/// ≥DEDUP_MIN 文件的一次句柄查询结果：精确磁盘占用 + 硬链接数 + 全局唯一身份
#[cfg(windows)]
struct FileIdentity {
    alloc: u64,
    links: u32,
    id: (u32, u64),
}

/// 只读属性方式打开文件（不取数据流、不与占用冲突），一次拿到
/// AllocationSize / nNumberOfLinks / (卷序列号, 文件索引)
#[cfg(windows)]
fn file_identity(path: &Path) -> Option<FileIdentity> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, GetFileInformationByHandleEx,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, FileStandardInfo, OPEN_EXISTING, BY_HANDLE_FILE_INFORMATION,
        FILE_STANDARD_INFO,
    };
    let wide: Vec<u16> = path.as_os_str().to_string_lossy().encode_utf16().chain([0]).collect();
    let h = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if h.is_null() || h == INVALID_HANDLE_VALUE {
        return None;
    }
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    let ok = unsafe { GetFileInformationByHandle(h, &mut info) } != 0;
    let mut stdi: FILE_STANDARD_INFO = unsafe { std::mem::zeroed() };
    let ok2 = unsafe {
        GetFileInformationByHandleEx(
            h,
            FileStandardInfo,
            &mut stdi as *mut FILE_STANDARD_INFO as *mut core::ffi::c_void,
            std::mem::size_of::<FILE_STANDARD_INFO>() as u32,
        )
    } != 0;
    unsafe { CloseHandle(h) };
    if !ok {
        return None;
    }
    Some(FileIdentity {
        alloc: if ok2 && stdi.AllocationSize > 0 { stdi.AllocationSize as u64 } else { 0 },
        links: info.nNumberOfLinks,
        id: (
            info.dwVolumeSerialNumber,
            ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
        ),
    })
}

/// 单文件的口径判定：(计入逻辑字节, 磁盘占用, 云占位, 硬链接副本)。
/// dup 时字节/占用计 0（已记在首见路径）；云占位逻辑字节照常、占用为 0
#[cfg(windows)]
fn file_metrics(path: &Path, sm: &fs::Metadata, cluster: u32) -> (u64, u64, bool, bool) {
    let len = sm.len();
    let attrs = sm.file_attributes();
    if is_cloud_placeholder(attrs) {
        return (len, 0, true, false);
    }
    if len >= DEDUP_MIN {
        if let Some(id) = file_identity(path) {
            let dup = id.links > 1 && !hl_seen_insert(id.id);
            let al = if dup {
                0
            } else if id.alloc > 0 {
                id.alloc
            } else {
                approx_alloc(len, cluster, attrs)
            };
            return (if dup { 0 } else { len }, al, false, dup);
        }
    }
    (len, approx_alloc(len, cluster, attrs), false, false)
}

#[cfg(not(windows))]
fn file_metrics(_path: &Path, sm: &fs::Metadata, _cluster: u32) -> (u64, u64, bool, bool) {
    (sm.len(), sm.len(), false, false)
}

fn emit(app: &AppHandle, ev: &NodeEvent) {
    let _ = app.emit("scan-update", ev);
}

// 单个目录的 DFS：返回子树 (逻辑字节, 磁盘占用)。开始时推 size=0 占位事件，期间按阈值推
// 部分大小，完成时推 done 事件。前端按 parent 链组装树、按 done 驱动折叠/特效。
// sizes：已完成子树的大小表——若本目录已被优先扫描先行扫完，直接采用记录值、不再重扫
// （跳过时不发任何事件，返回值供父目录聚合，总量保持一致）。
// 目录打不开（无权限）或条目读失败时照常 done，但事件带 denied:true，体积为已读到的部分。
fn scan_dir(
    app: &AppHandle,
    dir: &Path,
    parent: String,
    name: String,
    depth: u32,
    stop: &AtomicBool,
    sizes: &Mutex<HashMap<String, (u64, u64)>>,
    big_files: &Mutex<HashMap<String, Vec<(String, u64, u64)>>>,
) -> (u64, u64) {
    let path_str = dir.to_string_lossy().to_string();
    let lower = path_str.to_lowercase();
    {
        let m = sizes.lock();
        if let Ok(m) = m {
            if let Some(sz) = m.get(&lower) {
                return *sz;
            }
        }
    }
    emit(
        app,
        &NodeEvent {
            path: path_str.clone(),
            parent: parent.clone(),
            name: name.clone(),
            size: 0,
            al: 0,
            done: false,
            file: false,
            dup: false,
            cloud: false,
            denied: false,
        },
    );

    let cluster = cluster_for(&path_str);
    let mut pending: u64 = 0;
    let mut pending_al: u64 = 0;
    let mut n_items: u64 = 0;
    let mut last_flush = Instant::now();
    let mut big_file_count: u64 = 0;

    let rd = fs::read_dir(dir);
    let mut total: u64 = 0;
    let mut total_al: u64 = 0;
    let mut had_err = false;
    if let Ok(rd) = rd {
        for entry in rd.flatten() {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            n_items += 1;
            let got = (|| -> Option<(u64, u64)> {
                let sm = fs::symlink_metadata(entry.path()).ok()?;
                if is_reparse(&sm) {
                    return Some((0, 0)); // junction/symlink 计 0：不重复计数、不成环
                }
                if sm.is_dir() {
                    let child_name = entry.file_name().to_string_lossy().to_string();
                    if is_deny(&child_name) {
                        return Some((0, 0));
                    }
                    if depth == 0 {
                        return Some((0, 0)); // 深度兜底（防异常深树爆栈）
                    }
                    Some(scan_dir(
                        app,
                        &entry.path(),
                        path_str.clone(),
                        child_name,
                        depth - 1,
                        stop,
                        sizes,
                        big_files,
                    ))
                } else {
                    let (counted, al, cloud, dup) = file_metrics(&entry.path(), &sm, cluster);
                    if sm.len() >= MIN_BIG_FILE && big_file_count < MAX_BIG_FILES_PER_DIR {
                        big_file_count += 1;
                        register_big_file(big_files, &lower, &entry.file_name(), counted, al);
                        emit(
                            app,
                            &NodeEvent {
                                path: entry.path().to_string_lossy().to_string(),
                                parent: path_str.clone(),
                                name: entry.file_name().to_string_lossy().to_string(),
                                size: counted,
                                al,
                                done: true,
                                file: true,
                                dup,
                                cloud,
                                denied: false,
                            },
                        );
                    }
                    Some((counted, al))
                }
            })();
            match got {
                Some((v, a)) => {
                    pending += v;
                    pending_al += a;
                }
                None => had_err = true, // 条目元数据拿不到（被删/被拒）：目录标记受限
            }
            // flush：32MB / 400 项 / 250ms 任一触发（时间驱动保证小目录也持续出数）
            if pending >= 32 * 1024 * 1024
                || n_items % 400 == 0
                || last_flush.elapsed() >= Duration::from_millis(250)
            {
                total += pending;
                total_al += pending_al;
                pending = 0;
                pending_al = 0;
                emit(
                    app,
                    &NodeEvent {
                        path: path_str.clone(),
                        parent: parent.clone(),
                        name: name.clone(),
                        size: total,
                        al: total_al,
                        done: false,
                        file: false,
                        dup: false,
                        cloud: false,
                        denied: false,
                    },
                );
                last_flush = Instant::now();
            }
        }
    } else {
        had_err = true; // read_dir 打不开：无权限
    }
    total += pending;
    total_al += pending_al;
    emit(
        app,
        &NodeEvent {
            path: path_str,
            parent,
            name,
            size: total,
            al: total_al,
            done: true,
            file: false,
            dup: false,
            cloud: false,
            denied: had_err,
        },
    );
    if let Ok(mut m) = sizes.lock() {
        m.insert(lower, (total, total_al));
    }
    (total, total_al)
}

#[tauri::command]
fn scan_start(app: AppHandle, roots: Vec<String>) -> Result<(), String> {
    do_scan_start(&app, roots)
}

/// 大文件登记（AI 通道 /api/tree 的 files 数据源）：与事件流同口径逐条登记，
/// 每目录上限 MAX_BIG_FILES_PER_DIR（与上报事件的上限一致）
fn register_big_file(
    files: &Mutex<HashMap<String, Vec<(String, u64, u64)>>>,
    parent_lower: &str,
    name: &std::ffi::OsStr,
    s: u64,
    al: u64,
) {
    if let Ok(mut m) = files.lock() {
        let e = m.entry(parent_lower.to_string()).or_default();
        if (e.len() as u64) < MAX_BIG_FILES_PER_DIR {
            e.push((name.to_string_lossy().into_owned(), s, al));
        }
    }
}

/// 扫描启动主体：前端「开始扫描」按钮与 AI 联动通道（POST /api/scan）共用。
/// roots 支持多个盘根（多盘齐扫）；成功启动后发 scan-started（payload = roots 数组）
fn do_scan_start(app: &AppHandle, roots: Vec<String>) -> Result<(), String> {
    let mut root_paths: Vec<std::path::PathBuf> = Vec::new();
    for r in &roots {
        let rp = Path::new(r).to_path_buf();
        if !rp.is_dir() {
            return Err(format!("目录不存在：{}", r));
        }
        root_paths.push(rp);
    }
    if root_paths.is_empty() {
        return Err("未指定扫描范围".into());
    }
    let state = app.state::<ScanState>();
    {
        let mut running = state.running.lock().map_err(|e| e.to_string())?;
        if *running {
            return Err("已有扫描在进行".into());
        }
        *running = true;
    }
    state.stop.store(false, Ordering::Relaxed);
    if let Ok(mut m) = state.sizes.lock() {
        m.clear();
    }
    if let Ok(mut m) = state.big_files.lock() {
        m.clear();
    }
    #[cfg(windows)]
    hl_seen_clear(); // 新扫描重新去重：同一数据仍然只计首见路径
    if let Ok(mut a) = state.active.lock() {
        *a = 1; // 主扫描占 1 个名额，优先扫描线程各再 +1
    }

    let app2 = app.clone();
    std::thread::spawn(move || {
        let t0 = Instant::now();

        // ===== 并行扫描引擎：N 个工作线程共享一个任务队列 =====
        // 每个目录一个 DState：工作线程读完目录项后，子目录入队、文件累计；
        // 子目录完成时把体积上缴父目录（remaining-- 到 0 且自身读完 → 级联完成）。
        // 多盘齐扫：每个盘根都是独立 DState（parent=None），共享同一个工作队列。
        let jobs: Arc<Mutex<VecDeque<Arc<DState>>>> = Arc::new(Mutex::new(VecDeque::new()));
        let cv: Arc<Condvar> = Arc::new(Condvar::new());
        let n_roots = root_paths.len();
        for rp in &root_paths {
            let root_name = rp
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| rp.to_string_lossy().to_string());
            let parent = rp
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            jobs.lock().unwrap().push_back(Arc::new(DState {
                path: rp.to_string_lossy().to_string(),
                parent_path: parent,
                name: root_name,
                depth: 48,
                remaining: AtomicUsize::new(0),
                size: Mutex::new(0),
                alloc: Mutex::new(0),
                denied: AtomicBool::new(false),
                iter_done: AtomicBool::new(false),
                parent: None,
            }));
        }
        // 机械盘上几十个线程随机 read_dir 会互相 seek 抖动，8 个以内最稳
        let n_workers = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .clamp(4, 8);
        let alive = Arc::new(AtomicUsize::new(n_workers));
        let finished = Arc::new(AtomicBool::new(false));
        let st = app2.state::<ScanState>();
        let ctx = Arc::new(EngineCtx {
            app: app2.clone(),
            sizes: st.sizes.clone(),
            big_files: st.big_files.clone(),
            stop: st.stop.clone(),
            finished: finished.clone(),
            roots_left: Arc::new(AtomicUsize::new(n_roots)),
            cv: cv.clone(),
            out: Arc::new(Mutex::new(Vec::new())),
        });
        for _ in 0..n_workers {
            let ctx = ctx.clone();
            let jobs = jobs.clone();
            let cv = cv.clone();
            let alive = alive.clone();
            std::thread::spawn(move || worker_loop(ctx, jobs, cv, alive));
        }
        // 协调者：等全部根完成（finished）或全部 worker 退出（停止）
        loop {
            std::thread::sleep(Duration::from_millis(120));
            if finished.load(Ordering::Relaxed) || alive.load(Ordering::Relaxed) == 0 {
                break;
            }
        }
        flush_out(&ctx); // 排空残留事件批次
        let msg = if finished.load(Ordering::Relaxed) {
            format!(
                "扫描完成，{} 个盘，用时 {:.1}s",
                n_roots,
                t0.elapsed().as_secs_f32()
            )
        } else {
            "已停止".to_string()
        };
        // 最后一个结束的线程（主扫描或任一优先扫描）负责宣布完成
        let mut announce = String::new();
        {
            let st = app2.state::<ScanState>();
            if let Ok(mut a) = st.active.lock() {
                if *a > 0 {
                    *a -= 1;
                }
                if *a == 0 {
                    announce = msg;
                }
            }
        }
        if !announce.is_empty() {
            let _ = app2.emit("scan-finished", announce);
            if let Ok(mut r) = app2.state::<ScanState>().running.lock() {
                *r = false;
            }
        }
    });
    // 通知前端进入扫描 UI 态（AI 经 POST /api/scan 触发时前端没有按钮上下文）
    let _ = app.emit("scan-started", &roots);
    Ok(())
}

// ======================== 并行扫描引擎 ========================
// 与串行 scan_dir（优先扫描用）共享 sizes 完成表：任何一方完成某目录即登记，
// 另一方遇到时直接采用，避免重复扫描。

/// 一个正在扫描的目录的共享状态：工作线程读完目录项后，子目录入队、文件累计；
/// 子目录完成时把体积上缴父目录，父目录 remaining 减到 0 且自身目录项已读完 → 级联完成。
struct DState {
    path: String,
    parent_path: String,
    name: String,
    depth: u32,
    /// 尚未完成的子目录任务数
    remaining: AtomicUsize,
    /// 自身文件 + 已完成子目录的累计逻辑字节
    size: Mutex<u64>,
    /// 同上口径的磁盘占用
    alloc: Mutex<u64>,
    /// read_dir 打不开 / 条目元数据读失败（体积为已读到的部分）
    denied: AtomicBool,
    /// 目录项是否已读完（read_dir 迭代结束）
    iter_done: AtomicBool,
    parent: Option<Arc<DState>>,
}

struct EngineCtx {
    app: AppHandle,
    sizes: Arc<Mutex<HashMap<String, (u64, u64)>>>,
    /// 大文件登记表（AI 通道用），与 sizes 同生命周期（扫描开始时清空）
    big_files: Arc<Mutex<HashMap<String, Vec<(String, u64, u64)>>>>,
    stop: Arc<AtomicBool>,
    finished: Arc<AtomicBool>,
    /// 尚未完成的盘根数（多盘齐扫：最后一个根完成时才置 finished）
    roots_left: Arc<AtomicUsize>,
    cv: Arc<Condvar>,
    /// 待发事件缓冲：攒批合并成 scan-batch 再发，避免并行时事件洪流淹没前端
    out: Arc<Mutex<Vec<NodeEvent>>>,
}

/// 事件入批；满 256 条立即刷出。并行扫描时事件量是串行的几十倍，
/// 必须合并成批量 IPC，否则前端 JS 线程被逐条事件淹没导致界面冻结。
fn push_event(ctx: &EngineCtx, ev: NodeEvent) {
    let full = {
        let mut b = ctx.out.lock().unwrap_or_else(|e| e.into_inner());
        b.push(ev);
        b.len() >= 256
    };
    if full {
        flush_out(ctx);
    }
}

fn flush_out(ctx: &EngineCtx) {
    let batch = {
        let mut b = ctx.out.lock().unwrap_or_else(|e| e.into_inner());
        if b.is_empty() {
            return;
        }
        std::mem::take(&mut *b)
    };
    let _ = ctx.app.emit("scan-batch", &batch);
}

/// 完成一步聚合：登记 sizes、向父目录上缴体积；父目录若因此完成则返回它及其总价。
fn settle(
    state: &Arc<DState>,
    total: u64,
    alloc: u64,
    sizes: &Mutex<HashMap<String, (u64, u64)>>,
) -> Option<(Arc<DState>, u64, u64)> {
    if let Ok(mut m) = sizes.lock() {
        m.insert(state.path.to_lowercase(), (total, alloc));
    }
    let p = state.parent.as_ref()?;
    {
        let mut ps = p.size.lock().ok()?;
        *ps += total;
        let mut pa = p.alloc.lock().ok()?;
        *pa += alloc;
    }
    // fetch_sub 返回旧值 == 1 说明减到 0：目录项已读完 → 父目录级联完成。
    // 旧值为 0 说明已被人（停止时的强制完成）减过 → 不再动它，防回绕
    let prev = p.remaining.fetch_sub(1, Ordering::Relaxed);
    if prev == 1 && p.iter_done.load(Ordering::Relaxed) {
        let pt = *p.size.lock().ok()?;
        let pa = *p.alloc.lock().ok()?;
        return Some((p.clone(), pt, pa));
    }
    None
}

/// 目录完成：发 done 事件并沿父链级联；根目录完成时置 finished 唤醒协调者。
fn complete_dir(ctx: &EngineCtx, state: &Arc<DState>, total: u64, alloc: u64, already_emitted: bool) {
    let mut cur = state.clone();
    let mut t = total;
    let mut ta = alloc;
    let mut first = already_emitted; // true：done 事件已由别处发过，只做聚合
    loop {
        if !first {
            push_event(
                ctx,
                NodeEvent {
                    path: cur.path.clone(),
                    parent: cur.parent_path.clone(),
                    name: cur.name.clone(),
                    size: t,
                    al: ta,
                    done: true,
                    file: false,
                    dup: false,
                    cloud: false,
                    denied: cur.denied.load(Ordering::Relaxed),
                },
            );
        }
        first = false;
        match settle(&cur, t, ta, &ctx.sizes) {
            Some((p, pt, pa)) => {
                cur = p;
                t = pt;
                ta = pa;
            }
            None => {
                if cur.parent.is_none() {
                    // 一个盘根完成；最后一个根完成 → 本次扫描结束
                    if ctx.roots_left.fetch_sub(1, Ordering::Relaxed) == 1 {
                        ctx.finished.store(true, Ordering::Relaxed);
                        ctx.cv.notify_all();
                    }
                }
                return;
            }
        }
    }
}

fn worker_loop(
    ctx: Arc<EngineCtx>,
    jobs: Arc<Mutex<VecDeque<Arc<DState>>>>,
    cv: Arc<Condvar>,
    alive: Arc<AtomicUsize>,
) {
    loop {
        if ctx.finished.load(Ordering::Relaxed) || ctx.stop.load(Ordering::Relaxed) {
            break;
        }
        let job = {
            let mut g = match jobs.lock() {
                Ok(g) => g,
                Err(_) => break,
            };
            match g.pop_front() {
                Some(j) => j,
                None => {
                    let _ = cv.wait_timeout(g, Duration::from_millis(150));
                    continue;
                }
            }
        };
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            process_job(&ctx, &jobs, &cv, &job);
        }));
        // worker 意外崩溃时也要让该目录收敛完成（按已累计体积），
        // 否则父目录 remaining 永远减不到 0，整棵树卡在"扫描中"
        if !job.iter_done.load(Ordering::Relaxed) {
            job.iter_done.store(true, Ordering::Relaxed);
            let total = *job.size.lock().unwrap_or_else(|e| e.into_inner());
            let alloc = *job.alloc.lock().unwrap_or_else(|e| e.into_inner());
            complete_dir(&ctx, &job, total, alloc, false);
        }
    }
    alive.fetch_sub(1, Ordering::Relaxed);
    ctx.cv.notify_all();
}

fn process_job(
    ctx: &EngineCtx,
    jobs: &Mutex<VecDeque<Arc<DState>>>,
    cv: &Condvar,
    job: &Arc<DState>,
) {
    // 已被优先扫描（或其他线程）完成 → 直接按记录值完成聚合，不重扫、不重复发事件
    {
        let known = ctx
            .sizes
            .lock()
            .ok()
            .and_then(|m| m.get(&job.path.to_lowercase()).copied());
        if let Some((sz, al)) = known {
            complete_dir(ctx, job, sz, al, true);
            return;
        }
    }
    push_event(
        ctx,
        NodeEvent {
            path: job.path.clone(),
            parent: job.parent_path.clone(),
            name: job.name.clone(),
            size: 0,
            al: 0,
            done: false,
            file: false,
            dup: false,
            cloud: false,
            denied: false,
        },
    );
    let cluster = cluster_for(&job.path);
    let mut pending: u64 = 0;
    let mut pending_al: u64 = 0;
    let mut n_items: u64 = 0;
    let mut big_file_count: u64 = 0;
    let mut last_flush = Instant::now();
    if let Ok(rd) = fs::read_dir(&job.path) {
        for entry in rd.flatten() {
            if ctx.stop.load(Ordering::Relaxed) {
                break;
            }
            n_items += 1;
            let got = (|| -> Option<(u64, u64)> {
                let sm = fs::symlink_metadata(entry.path()).ok()?;
                if is_reparse(&sm) {
                    return Some((0, 0));
                }
                if sm.is_dir() {
                    let child_name = entry.file_name().to_string_lossy().to_string();
                    if is_deny(&child_name) {
                        return Some((0, 0));
                    }
                    if job.depth == 0 {
                        return Some((0, 0));
                    }
                    let child_path = entry.path().to_string_lossy().to_string();
                    // 已由另一方完成的子树：体积直接并入，不入队
                    {
                        let m = ctx.sizes.lock();
                        if let Ok(m) = &m {
                            if let Some(&(sz, al)) = m.get(&child_path.to_lowercase()) {
                                return Some((sz, al));
                            }
                        }
                    }
                    let child = Arc::new(DState {
                        path: child_path.clone(),
                        parent_path: job.path.clone(),
                        name: child_name.clone(),
                        depth: job.depth - 1,
                        remaining: AtomicUsize::new(0),
                        size: Mutex::new(0),
                        alloc: Mutex::new(0),
                        denied: AtomicBool::new(false),
                        iter_done: AtomicBool::new(false),
                        parent: Some(job.clone()),
                    });
                    job.remaining.fetch_add(1, Ordering::Relaxed);
                    if let Ok(mut g) = jobs.lock() {
                        g.push_back(child);
                    }
                    cv.notify_one();
                    // 入队即发占位事件：父目录一迭代到子目录名，前端立刻出现
                    // "统计中"块（配合前端最小可见面积，扫描中目录全程可见）
                    push_event(
                        ctx,
                        NodeEvent {
                            path: child_path,
                            parent: job.path.clone(),
                            name: child_name,
                            size: 0,
                            al: 0,
                            done: false,
                            file: false,
                            dup: false,
                            cloud: false,
                            denied: false,
                        },
                    );
                    return Some((0, 0)); // 子目录体积经完成级联上缴
                }
                let len = sm.len();
                let (counted, al, cloud, dup) = file_metrics(&entry.path(), &sm, cluster);
                if len >= MIN_BIG_FILE && big_file_count < MAX_BIG_FILES_PER_DIR {
                    big_file_count += 1;
                    register_big_file(
                        &ctx.big_files,
                        &job.path.to_lowercase(),
                        &entry.file_name(),
                        counted,
                        al,
                    );
                    push_event(
                        ctx,
                        NodeEvent {
                            path: entry.path().to_string_lossy().to_string(),
                            parent: job.path.clone(),
                            name: entry.file_name().to_string_lossy().to_string(),
                            size: counted,
                            al,
                            done: true,
                            file: true,
                            dup,
                            cloud,
                            denied: false,
                        },
                    );
                }
                Some((counted, al))
            })();
            match got {
                Some((v, a)) => {
                    pending += v;
                    pending_al += a;
                }
                None => job.denied.store(true, Ordering::Relaxed),
            }
            // flush 节流：体积驱动（16MB）/ 条目驱动（2000 项）/ 定时（250ms 且确有进展）。
            // 并行时几千个目录同时在线，无进展的定时 flush 会造成事件洪流
            let due = pending >= 16 * 1024 * 1024
                || n_items % 2000 == 0
                || (last_flush.elapsed() >= Duration::from_millis(250) && pending > 0);
            if due {
                {
                    let mut s = job.size.lock().unwrap_or_else(|e| e.into_inner());
                    *s += pending;
                    let mut a = job.alloc.lock().unwrap_or_else(|e| e.into_inner());
                    *a += pending_al;
                }
                pending = 0;
                pending_al = 0;
                push_event(
                    ctx,
                    NodeEvent {
                        path: job.path.clone(),
                        parent: job.parent_path.clone(),
                        name: job.name.clone(),
                        size: *job.size.lock().unwrap_or_else(|e| e.into_inner()),
                        al: *job.alloc.lock().unwrap_or_else(|e| e.into_inner()),
                        done: false,
                        file: false,
                        dup: false,
                        cloud: false,
                        denied: false,
                    },
                );
                last_flush = Instant::now();
                flush_out(ctx); // 批量缓冲随节拍刷出，避免低事件量时期批积压延迟
            }
        }
    } else {
        job.denied.store(true, Ordering::Relaxed); // read_dir 打不开：无权限
    }
    {
        let mut s = job.size.lock().unwrap_or_else(|e| e.into_inner());
        *s += pending;
        let mut a = job.alloc.lock().unwrap_or_else(|e| e.into_inner());
        *a += pending_al;
    }
    job.iter_done.store(true, Ordering::Relaxed);
    // 停止时强制完成（部分体积），让前端各目录状态收敛、不再永久转圈
    if ctx.stop.load(Ordering::Relaxed) || job.remaining.load(Ordering::Relaxed) == 0 {
        let total = *job.size.lock().unwrap_or_else(|e| e.into_inner());
        let alloc = *job.alloc.lock().unwrap_or_else(|e| e.into_inner());
        complete_dir(ctx, job, total, alloc, false);
    }
}

/// 用户在扫描进行中（或扫描完成后的监视模式下）点击/自动调度了一个还没扫到的目录：
/// 立刻起一个线程优先扫这个子树。主 DFS 之后到达该目录时会从共享 sizes 表取结果直接跳过，
/// 不重复耗 IO。监视模式下（无主扫描）同样可用：新出现的目录点开即扫。
#[tauri::command]
/// 优先扫描主体：后台线程扫单个子树（扫描中点击未扫到的目录 / 监视模式补扫共用）。
/// force=true 时忽略 sizes 表的"已扫完"记录，强制重扫（右键重新扫描 / 提案执行后刷新）
fn spawn_priority_scan(app: &AppHandle, path: String, force: bool) -> Result<(), String> {
    let state = app.state::<ScanState>();
    let running = match state.running.lock() {
        Ok(g) => *g,
        Err(_) => false,
    };
    if running && state.stop.load(Ordering::Relaxed) {
        return Err("扫描正在停止".into());
    }
    let p = norm_path(&path);
    let bp = Path::new(&p);
    if !bp.is_dir() {
        return Err(format!("目录不存在：{}", p));
    }
    if !force {
        let m = state.sizes.lock().map_err(|e| e.to_string())?;
        if m.contains_key(&p.to_lowercase()) {
            return Ok(()); // 已扫完，无需优先
        }
    }
    let app2 = app.clone();
    {
        let st = app2.state::<ScanState>();
        if let Ok(mut a) = st.active.lock() {
            if running {
                *a += 1;
            } else {
                // 监视模式：没有主扫描占名额，本线程自己占 1，扫完后负责宣布完成
                *a = 1;
            }
        }
    }
    let name = bp
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| p.clone());
    let parent = bp
        .parent()
        .map(|x| x.to_string_lossy().to_string())
        .unwrap_or_default();
    std::thread::spawn(move || {
        let st2 = app2.state::<ScanState>();
        let bp2 = Path::new(&p);
        scan_dir(&app2, bp2, parent, name, 48, &st2.stop, &st2.sizes, &st2.big_files);
        let mut announce = false;
        if let Ok(mut a) = st2.active.lock() {
            if *a > 0 {
                *a -= 1;
            }
            announce = *a == 0;
        }
        if announce {
            let _ = app2.emit("scan-finished", "扫描完成".to_string());
            if let Ok(mut r) = st2.running.lock() {
                *r = false;
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn scan_priority(app: AppHandle, path: String) -> Result<(), String> {
    spawn_priority_scan(&app, path, false)
}

/// 强制重扫子树：先清 sizes 表里该子树的全部完成记录（含自身），再走优先扫描。
/// 用于「右键重新扫描此目录」与提案执行后的局部刷新
#[tauri::command]
fn scan_refresh(app: AppHandle, path: String) -> Result<(), String> {
    let p = norm_path(&path);
    if !Path::new(&p).is_dir() {
        return Err(format!("目录不存在：{}", p));
    }
    let state = app.state::<ScanState>();
    let base = p.to_lowercase();
    // 盘根键自带尾杠（"c:\"），子目录键无尾杠——前缀按此归一
    let prefix = if base.ends_with('\\') {
        base.clone()
    } else {
        format!("{}\\", base)
    };
    {
        let mut m = state.sizes.lock().map_err(|e| e.to_string())?;
        m.retain(|k, _| k.as_str() != base.as_str() && !k.starts_with(prefix.as_str()));
    }
    {
        // 大文件登记表按父目录键清：子树内所有父目录的登记一并失效，重扫后重新登记
        if let Ok(mut m) = state.big_files.lock() {
            m.retain(|k, _| k.as_str() != base.as_str() && !k.starts_with(prefix.as_str()));
        }
    }
    spawn_priority_scan(&app, p, true)
}

#[tauri::command]
fn scan_stop(state: State<'_, ScanState>) {
    state.stop.store(true, Ordering::Relaxed);
}

// ======================== 扫描完成后的实时监视 ========================
// notify 递归 watcher → 原始事件 channel → 合批线程：静默 300ms 或攒满 256 条即
// emit "fs-batch"。前端按 upsert/remove 增量应用并沿祖先链传播体积差值。
// 与扫描引擎同一套语义：跳过 reparse point 与 deny 目录，大文件阈值同 MIN_BIG_FILE。

#[derive(Clone)]
enum RawOp {
    Upsert,
    Remove,
}

fn watch_allowed(root_lower: &str, path_lower: &str) -> bool {
    if !path_lower.starts_with(root_lower) || path_lower == root_lower {
        return false;
    }
    let rel = &path_lower[root_lower.len()..];
    let depth = rel.split('\\').filter(|s| !s.is_empty()).count();
    if depth > 48 {
        return false;
    }
    !rel.split('\\').any(is_deny)
}

#[tauri::command]
fn watch_start(
    app: AppHandle,
    wstate: State<'_, WatchState>,
    root: String,
) -> Result<(), String> {
    let root_n = norm_path(&root);
    if !Path::new(&root_n).is_dir() {
        return Err(format!("目录不存在：{}", root_n));
    }
    // 同根查重：先停掉旧 watcher（换根重开 / 多盘逐根挂载互不影响）
    {
        let mut g = wstate.inner.lock().map_err(|e| e.to_string())?;
        let root_lower = root_n.to_lowercase();
        let mut kept = Vec::new();
        for run in g.drain(..) {
            if let Some(r) = run.root_lower.as_ref() {
                if *r == root_lower {
                    run.stop.store(true, Ordering::Relaxed);
                    if let Some(h) = run.join {
                        let _ = h.join();
                    }
                    continue;
                }
            }
            kept.push(run);
        }
        *g = kept;
    }

    let (raw_tx, raw_rx) = std::sync::mpsc::channel::<(String, RawOp)>();
    // notify 回调只做转投递，绝不做重活（它在 notify 自己的线程上跑）
    let mut watcher = notify::recommended_watcher(
        move |res: Result<notify::Event, notify::Error>| {
            let ev = match res {
                Ok(e) => e,
                Err(_) => return,
            };
            let op = match ev.kind {
                notify::EventKind::Create(_) => Some(RawOp::Upsert),
                notify::EventKind::Remove(_) => Some(RawOp::Remove),
                notify::EventKind::Modify(notify::event::ModifyKind::Name(
                    notify::event::RenameMode::From,
                )) => Some(RawOp::Remove),
                notify::EventKind::Modify(notify::event::ModifyKind::Name(
                    notify::event::RenameMode::To,
                )) => Some(RawOp::Upsert),
                notify::EventKind::Modify(notify::event::ModifyKind::Name(
                    notify::event::RenameMode::Both,
                )) => {
                    // paths = [from, to]：旧路径删、新路径增
                    if let Some(p) = ev.paths.first() {
                        let _ = raw_tx.send((p.to_string_lossy().to_string(), RawOp::Remove));
                    }
                    if let Some(p) = ev.paths.get(1) {
                        let _ = raw_tx.send((p.to_string_lossy().to_string(), RawOp::Upsert));
                    }
                    None
                }
                notify::EventKind::Modify(
                    notify::event::ModifyKind::Data(_)
                    | notify::event::ModifyKind::Metadata(_)
                    | notify::event::ModifyKind::Other,
                ) => Some(RawOp::Upsert),
                _ => None, // Access 等噪音
            };
            if let Some(op) = op {
                for p in &ev.paths {
                    let _ = raw_tx.send((p.to_string_lossy().to_string(), op.clone()));
                }
            }
        },
    )
    .map_err(|e| format!("无法启动文件监视：{}", e))?;
    watcher
        .watch(Path::new(&root_n), notify::RecursiveMode::Recursive)
        .map_err(|e| format!("无法监视该目录：{}", e))?;

    let stop = Arc::new(AtomicBool::new(false));
    let root_lower = root_n.to_lowercase();
    let stop2 = stop.clone();
    let app2 = app.clone();
    let join = std::thread::spawn(move || {
        let _keep = watcher; // watcher 必须活到线程结束，drop 即停止监视
        let mut pending: HashMap<String, (String, RawOp, u64)> = HashMap::new(); // lower → (原始路径, op, seq)
        let mut seq: u64 = 0;
        loop {
            if stop2.load(Ordering::Relaxed) {
                return;
            }
            // 静默 300ms 出一批：recv 超时即认为暂无新事件
            match raw_rx.recv_timeout(Duration::from_millis(300)) {
                Ok((path, op)) => {
                    let lower = path.to_lowercase();
                    if !watch_allowed(&root_lower, &lower) {
                        continue;
                    }
                    seq += 1;
                    pending.insert(lower, (path, op, seq));
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => return, // sender 全部关闭
            }
            if pending.is_empty() {
                continue;
            }
            // 有静默窗口或积压过多才发
            let due = raw_rx.try_recv().is_err() || pending.len() >= 256;
            if !due {
                continue;
            }
            // 按事件顺序合并（同一路径后到者覆盖）：先收集排序再定型
            let mut items: Vec<(u64, String, String, RawOp)> = pending
                .drain()
                .map(|(lower, (path, op, s))| (s, lower, path, op))
                .collect();
            items.sort_by_key(|(s, _, _, _)| *s);
            let mut batch: Vec<FsEvent> = Vec::with_capacity(items.len());
            for (_, lower, path, op) in items {
                let _ = lower;
                match op {
                    RawOp::Remove => batch.push(FsEvent {
                        path,
                        kind: "remove".into(),
                        is_dir: false,
                        size: 0,
                        al: 0,
                    }),
                    RawOp::Upsert => {
                        // 事件与 stat 之间文件可能已消失：拿不到元数据就跳过（真删了会有 Remove 事件）
                        let sm = match fs::symlink_metadata(&path) {
                            Ok(m) => m,
                            Err(_) => continue,
                        };
                        if is_reparse(&sm) {
                            continue; // junction/symlink 与扫描同语义：不计
                        }
                        let is_dir = sm.is_dir();
                        // 占用口径走扫描同一套近似（云占位=0、压缩/稀疏按逻辑、普通按簇取整）；
                        // 硬链接去重在此不做（需开句柄，监视事件量大，接受少量漂移）
                        #[cfg(windows)]
                        let al = if is_dir {
                            0
                        } else {
                            let attrs = sm.file_attributes();
                            if is_cloud_placeholder(attrs) {
                                0
                            } else {
                                approx_alloc(sm.len(), cluster_for(&path), attrs)
                            }
                        };
                        #[cfg(not(windows))]
                        let al = if is_dir { 0 } else { sm.len() };
                        batch.push(FsEvent {
                            path,
                            kind: "upsert".into(),
                            is_dir,
                            size: if is_dir { 0 } else { sm.len() },
                            al,
                        });
                    }
                }
            }
            if !batch.is_empty() {
                let _ = app2.emit("fs-batch", &batch);
            }
        }
    });

    let mut g = wstate.inner.lock().map_err(|e| e.to_string())?;
    g.push(WatchRun {
        stop,
        root_lower: Some(root_n.to_lowercase()),
        join: Some(join),
    });
    Ok(())
}

#[tauri::command]
fn watch_stop(wstate: State<'_, WatchState>) {
    // 停掉全部 watcher（多盘）
    let Ok(mut g) = wstate.inner.lock() else { return };
    for run in g.drain(..) {
        run.stop.store(true, Ordering::Relaxed);
        if let Some(h) = run.join {
            let _ = h.join();
        }
    }
}


#[tauri::command]
fn scan_status(state: State<'_, ScanState>) -> bool {
    match state.running.lock() {
        Ok(g) => *g,
        Err(_) => false,
    }
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

/// 枚举本地卷。映射的网络盘断连时 API 会阻塞数秒——async + 线程池，不阻塞 UI
#[tauri::command]
async fn list_volumes() -> Vec<VolumeInfo> {
    tauri::async_runtime::spawn_blocking(probe_volumes)
        .await
        .unwrap_or_default()
}

/// 前端 CSV 导出落盘：路径由原生保存对话框给出，内容为前端拼好的完整字符串
#[tauri::command]
fn save_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents.as_bytes()).map_err(|e| format!("写入失败：{}", e))
}

// ======================== 扫描缓存（启动秒开 + 历史对比） ========================
// scan-cache.json = 最近一次扫描摘要；写入时把旧文件轮换为 scan-cache.prev.json，
// 前端重扫完成后可做「上次 vs 本次」对比。

fn cache_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{}", e))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建数据目录：{}", e))?;
    Ok(dir)
}

// ======================== 诊断日志（问题反馈 / 异常退出追溯） ========================
// logs/current.log 为当前会话；启动时把上一份轮换为 prev-1..3（最多留 3 份）。
// 正常退出写入 EXIT_MARKER，上一份没有该标记 = 异常退出（崩溃/被杀/断电），
// 前端「关于 → 问题反馈」据此引导用户带日志提 Issue。日志只落本机，不做静默上传。

const LOG_EXIT_MARKER: &str = "── 会话正常退出 ──";
static DIAG_LOG_PATH: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

#[derive(Default)]
struct DiagState {
    last_abnormal: AtomicBool,
}

/// UTC 时间戳（无 chrono 依赖，civil_from_days 算法）
fn utc_stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        y,
        m,
        d,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

fn diag_log_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?.join("logs");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn diag_append_file(path: &std::path::Path, line: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{}", line);
    }
}

/// 轮换上一会话日志并检测其是否异常退出（无正常退出标记）。返回 prev 是否异常。
fn diag_rotate_dir(dir: &std::path::Path) -> bool {
    let _ = std::fs::create_dir_all(dir);
    let cur = dir.join("current.log");
    let mut abnormal = false;
    if cur.exists() {
        if let Ok(content) = std::fs::read_to_string(&cur) {
            abnormal = !content.contains(LOG_EXIT_MARKER);
        }
        let _ = std::fs::remove_file(dir.join("prev-3.log"));
        let _ = std::fs::rename(dir.join("prev-2.log"), dir.join("prev-3.log"));
        let _ = std::fs::rename(dir.join("prev-1.log"), dir.join("prev-2.log"));
        let _ = std::fs::rename(&cur, dir.join("prev-1.log"));
    }
    abnormal
}

fn diag_tail(path: &std::path::Path, max_chars: usize) -> Option<String> {
    let s = std::fs::read_to_string(path).ok()?;
    let count = s.chars().count();
    Some(if count > max_chars {
        s.chars().skip(count - max_chars).collect()
    } else {
        s
    })
}

fn install_diag_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let bt = std::backtrace::Backtrace::force_capture().to_string();
        let bt = bt.lines().take(12).collect::<Vec<_>>().join(" | ");
        let line = format!(
            "[UTC {}] [panic] {} | backtrace: {}",
            utc_stamp(),
            info.to_string().replace(['\n', '\r'], " "),
            bt
        );
        if let Some(p) = DIAG_LOG_PATH.get() {
            diag_append_file(p, &line);
        }
        eprintln!("{}", line);
    }));
}

/// 前端/关键路径写日志行（含体积护栏：超 1MB 后丢弃非 error 行，防错误风暴刷爆磁盘）
#[tauri::command]
fn app_log(app: AppHandle, level: String, msg: String) -> Result<(), String> {
    let Some(dir) = diag_log_dir(&app) else { return Ok(()) };
    let f = dir.join("current.log");
    let level = if level.is_empty() { "info".into() } else { level };
    if level != "error" {
        if let Ok(md) = std::fs::metadata(&f) {
            if md.len() > 1024 * 1024 {
                return Ok(());
            }
        }
    }
    let safe = msg.replace(['\n', '\r'], " ");
    diag_append_file(&f, &format!("[UTC {}] [{}] {}", utc_stamp(), level, safe));
    Ok(())
}

/// 诊断报告：上次会话退出状态、panic 计数、前后日志尾部（前端组装后由用户决定提交）
#[tauri::command]
fn diag_report(app: AppHandle, state: State<'_, DiagState>) -> serde_json::Value {
    let dir = diag_log_dir(&app);
    let prev_tail = dir
        .as_ref()
        .and_then(|d| diag_tail(&d.join("prev-1.log"), 16000))
        .unwrap_or_default();
    let cur_tail = dir
        .as_ref()
        .and_then(|d| diag_tail(&d.join("current.log"), 16000))
        .unwrap_or_default();
    let panics = prev_tail.matches("[panic]").count() + cur_tail.matches("[panic]").count();
    serde_json::json!({
        "lastAbnormal": state.last_abnormal.load(Ordering::Relaxed),
        "panics": panics,
        "version": env!("CARGO_PKG_VERSION"),
        "os": format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        "prevTail": prev_tail,
        "curTail": cur_tail,
    })
}



/// 写入扫描缓存：当前缓存轮换为 prev（供对比），新结果覆盖 current
#[tauri::command]
fn write_scan_cache(app: AppHandle, json: String) -> Result<(), String> {
    let dir = cache_dir(&app)?;
    let cur = dir.join("scan-cache.json");
    let prev = dir.join("scan-cache.prev.json");
    if cur.exists() {
        let _ = std::fs::rename(&cur, &prev);
    }
    std::fs::write(&cur, json.as_bytes()).map_err(|e| format!("写入缓存失败：{}", e))
}

/// 读取扫描缓存：which = "current" | "prev"；不存在返回 Ok(None)
#[tauri::command]
fn read_scan_cache(app: AppHandle, which: String) -> Result<Option<String>, String> {
    let dir = cache_dir(&app)?;
    let file = if which == "prev" {
        dir.join("scan-cache.prev.json")
    } else {
        dir.join("scan-cache.json")
    };
    if !file.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(&file)
        .map(Some)
        .map_err(|e| format!("读取缓存失败：{}", e))
}

// ======================== 回收站删除与迁移撤销 ========================

/// 移入回收站（FOF_ALLOWUNDO，可在回收站还原）——清理类操作的安全执行方式。
/// 大目录入回收站可能耗时——async + 线程池，不阻塞 UI
#[tauri::command]
async fn recycle_delete(paths: Vec<String>) -> Vec<String> {
    let task = paths.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut failed = Vec::new();
        for p in &task {
            if !recycle_one(p) {
                failed.push(p.clone());
            }
        }
        failed
    })
    .await
    .unwrap_or_else(|_| paths)
}

#[cfg(windows)]
fn recycle_one(path: &str) -> bool {
    use windows_sys::Win32::UI::Shell::{
        SHFileOperationW, FO_DELETE, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI,
        FOF_SILENT, SHFILEOPSTRUCTW,
    };
    if !Path::new(path).exists() {
        return false;
    }
    // pFrom 要求双零结尾的可变 UTF-16 缓冲
    let mut from: Vec<u16> = path.encode_utf16().collect();
    from.push(0);
    from.push(0);
    let mut op: SHFILEOPSTRUCTW = unsafe { std::mem::zeroed() };
    op.hwnd = std::ptr::null_mut();
    op.wFunc = FO_DELETE;
    op.pFrom = from.as_ptr();
    op.pTo = std::ptr::null();
    op.fFlags = (FOF_SILENT | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_ALLOWUNDO) as u16;
    let r = unsafe { SHFileOperationW(&mut op) };
    r == 0 && op.fAnyOperationsAborted == 0
}

#[cfg(not(windows))]
fn recycle_one(_path: &str) -> bool {
    false
}

/// 撤销迁移：删掉源位置 junction，把数据从目标搬回原位（逆向走一遍迁移事务）。
/// 安全校验：src 必须是 reparse point 且 dest 真实存在——两者任一不满足即拒绝（防误删真数据）
#[tauri::command]
fn migrate_undo(app: AppHandle, state: State<'_, MigrateState>, src: String, dest_root: String) -> Result<(), String> {
    {
        let mut running = state.running.lock().map_err(|e| e.to_string())?;
        if *running {
            return Err("已有迁移/撤销在进行".into());
        }
        *running = true;
    }
    state.stop.store(false, Ordering::Relaxed);

    let src_n = norm_path(&src);
    let basename = src_n
        .trim_end_matches('\\')
        .rsplit('\\')
        .next()
        .unwrap_or("")
        .to_string();
    let dest_path = format!("{}\\{}", dest_root.trim_end_matches('\\'), basename);

    let ok_sm = fs::symlink_metadata(&src_n);
    let is_link = ok_sm.as_ref().map(|m| is_reparse(m)).unwrap_or(false);
    let dest_exists = Path::new(&dest_path).is_dir();
    if !is_link || !dest_exists {
        if let Ok(mut r) = state.running.lock() {
            *r = false;
        }
        return Err(format!(
            "撤销校验失败：{} 不是 junction 或 {} 不存在，拒绝执行（数据可能已被手动处理）",
            src_n, dest_path
        ));
    }

    let app2 = app.clone();
    std::thread::spawn(move || {
        let st = app2.state::<MigrateState>();
        let stop = &st.stop;
        let src_p = Path::new(&src_n);
        let dest_p = Path::new(&dest_path);
        let mut locked: Vec<String> = Vec::new();
        macro_rules! bail {
            ($msg:expr) => {{
                let m: &str = &$msg;
                emit_mig(&app2, "error", m, "", 0, 0, 0, 0, &locked);
                if let Ok(mut r) = st.running.lock() {
                    *r = false;
                }
                return;
            }};
        }

        // 第一步：删掉源位置的 junction（对 reparse point 只删链接，不碰目标数据）
        if fs::remove_dir(src_p).is_err() {
            bail!(format!("删除 junction 失败（可能被占用）：{}", src_n));
        }
        emit_mig(&app2, "switch", "已移除 junction，正在恢复原目录…", "", 0, 0, 0, 0, &[]);

        if volume_prefix(&src_n) == volume_prefix(dest_root.as_str()) {
            // 同卷：rename 瞬时还原
            if fs::rename(dest_p, src_p).is_ok() {
                emit_mig(&app2, "done", "撤销完成：数据已回到原位", "", 0, 0, 0, 0, &[]);
            } else {
                // rename 失败：把 junction 重新建回去，保持可迁移状态
                let _ = fs::create_dir(src_p);
                let _ = create_junction(&src_n, &dest_path);
                bail!("还原 rename 失败（目录被占用），已恢复 junction 可稍后重试");
            }
        } else {
            // 跨卷：复制回 → 对账 → 清掉目标
            let mut stats = WalkStats::default();
            walk_stats(dest_p, stop, &mut stats);
            if stats.inner_links {
                bail!("目标目录内含链接，撤销中止");
            }
            if stop.load(Ordering::Relaxed) {
                emit_mig(&app2, "aborted", "撤销已停止", "", 0, 0, 0, 0, &[]);
                if let Ok(mut r) = st.running.lock() {
                    *r = false;
                }
                return;
            }
            emit_mig(
                &app2, "copy", "撤销迁移：把数据从目标复制回原位…", "",
                0, stats.bytes, 0, stats.files, &[],
            );
            let mut ctx = CopyCtx {
                app: &app2,
                bytes_done: 0,
                files_done: 0,
                last_emit: Instant::now(),
                errors: Vec::new(),
            };
            if fs::create_dir_all(src_p).is_err() {
                bail!("重建原目录失败");
            }
            match copy_tree(&mut ctx, dest_p, src_p, stats.bytes, stats.files, stop) {
                Ok(()) => {}
                Err(CopyAbort::Stopped) => {
                    emit_mig(&app2, "aborted", "撤销已停止（已完成部分保留，junction 未动，可重新发起撤销）", "", ctx.bytes_done, stats.bytes, ctx.files_done, stats.files, &[]);
                    if let Ok(mut r) = st.running.lock() {
                        *r = false;
                    }
                    return;
                }
                Err(CopyAbort::Failed) => {
                    let msg = if ctx.errors.is_empty() { "复制失败".to_string() } else { format!("复制失败（{} 项错误，已复制部分保留，可重试续传）", ctx.errors.len()) };
                    bail!(msg);
                }
            }
            // 对账
            let mut vstats = WalkStats::default();
            walk_stats(src_p, stop, &mut vstats);
            if vstats.bytes != stats.bytes || vstats.files != stats.files {
                bail!(format!(
                    "对账不一致（源 {} 字节/{} 文件 vs 回移 {} / {}）——原位数据保留，junction 未动，请人工检查",
                    stats.bytes, stats.files, vstats.bytes, vstats.files
                ));
            }
            // 清掉目标侧
            delete_contents(dest_p, stop, &mut locked);
            if !locked.is_empty() {
                emit_mig(&app2, "locked", "撤销基本完成，目标侧部分文件被占用未能删除", "", 0, 0, 0, 0, &locked);
            } else if fs::remove_dir(dest_p).is_err() {
                emit_mig(&app2, "locked", "目标空壳目录删除失败（可稍后手动删除）", "", 0, 0, 0, 0, &[dest_path.clone()]);
            }
            if stop.load(Ordering::Relaxed) {
                emit_mig(&app2, "aborted", "撤销已停止", "", 0, 0, 0, 0, &[]);
            } else {
                emit_mig(&app2, "done", "撤销完成：数据已回到原位，目标侧已清理", "", stats.bytes, stats.bytes, stats.files, stats.files, &[]);
            }
        }
        if let Ok(mut r) = st.running.lock() {
            *r = false;
        }
    });
    Ok(())
}

// ======================== 窗口显示与无感重启 ========================
// 用户双击启动 → 正常 show（前台，符合预期）；--no-focus 启动（自动更新重启等后台拉起）
// → SW_SHOWNOACTIVATE：显示但绝不抢正在使用的前台应用焦点。

static NO_FOCUS: AtomicBool = AtomicBool::new(false);

/// 显示主窗口。--no-focus 模式走 ShowWindow(SW_SHOWNOACTIVATE)，不激活不置顶
#[tauri::command]
fn show_window(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        #[cfg(windows)]
        if NO_FOCUS.load(Ordering::Relaxed) {
            use windows_sys::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWNOACTIVATE};
            if let Ok(h) = win.hwnd() {
                // tauri(windows crate) 的 HWND(isize) → windows-sys 的 *mut c_void
                unsafe { ShowWindow(h.0 as *mut core::ffi::c_void, SW_SHOWNOACTIVATE) };
                return;
            }
        }
        let _ = win.show();
    }
}

/// 自动更新后的重启：以 --no-focus 拉起新进程（新窗口不抢焦点）再退出当前
#[tauri::command]
fn relaunch_no_focus(app: AppHandle) {
    let exe = std::env::current_exe().unwrap_or_default();
    let _ = std::process::Command::new(exe).arg("--no-focus").spawn();
    app.exit(0);
}

// ======================== AI 联动通道（本地 HTTP） ========================
// 设计：AI 助手（ZCode / Claude Code 等）经 127.0.0.1 拉取扫描快照、回传迁移/清理
// 提案；用户在应用内确认后由本应用复用迁移引擎执行（AI 不直接碰文件系统）。
// 安全三道门：① 仅绑定 127.0.0.1；② Host 头必须是 127.0.0.1/localhost（防 DNS
// rebinding）；③ 自定义头 X-DiskLens-Token 匹配会话 token（自定义头天然阻断
// 浏览器 CSRF form）。快照由前端聚合推送，Rust 原样回传、零解析。

/// 会话 token：RandomState（OS 种子）+ 纳秒时钟哈希，零依赖的不可预测串
fn gen_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64;
    let mut out = String::new();
    for i in 0..2usize {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(nanos.wrapping_add(i as u64 * 0x9E37_79B9_7F4A_7C15));
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

pub struct AiChannelState {
    /// 前端聚合好的扫描快照 JSON 字符串
    snapshot: Mutex<Option<String>>,
    /// 当前提案 {id, summary, items, status: pending|accepted|rejected|done, results}
    proposal: Mutex<Option<serde_json::Value>>,
    enabled: AtomicBool,
    /// HTTP 服务端口（0 = 未启动）
    port: AtomicUsize,
    token: String,
}

impl AiChannelState {
    fn new() -> Self {
        Self {
            snapshot: Mutex::new(None),
            proposal: Mutex::new(None),
            enabled: AtomicBool::new(true),
            port: AtomicUsize::new(0),
            token: gen_token(),
        }
    }
}

/// 下钻：从 sizes 完成表取某目录的直接子目录（一层，无大小阈值）。
/// 表键是小写路径；返回按大小降序。注意：监视模式的增量未反映在此表（陈旧可接受）
fn tree_children(
    sizes: &HashMap<String, (u64, u64)>,
    path_lower: &str,
) -> Vec<(String, u64, u64)> {
    let prefix = format!("{}\\", path_lower.trim_end_matches('\\'));
    let mut out: Vec<(String, u64, u64)> = Vec::new();
    for (k, v) in sizes.iter() {
        if let Some(rest) = k.strip_prefix(prefix.as_str()) {
            // 直接子层：余段不含 '\'（子目录自身的键），排除更深层
            if !rest.is_empty() && !rest.contains('\\') {
                out.push((k.clone(), v.0, v.1));
            }
        }
    }
    out.sort_by(|a, b| b.1.cmp(&a.1));
    out
}

/// 手写 percent-decode（%XX；'+' 不当空格），供 /api/tree 的 path 查询参数用
fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = |c: u8| -> Option<u8> {
                match c {
                    b'0'..=b'9' => Some(c - b'0'),
                    b'a'..=b'f' => Some(c - b'a' + 10),
                    b'A'..=b'F' => Some(c - b'A' + 10),
                    _ => None,
                }
            };
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// 查询串解析：k=v&k2=v2，值做 percent-decode（面向 AI 的宽容解析，缺 '=' 视为空值）
fn parse_query(q: &str) -> Vec<(String, String)> {
    q.split('&')
        .filter(|s| !s.is_empty())
        .map(|kv| {
            let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
            (pct_decode(k), pct_decode(v))
        })
        .collect()
}

/// AI 传入路径的宽容归一：正/反斜杠等价、去引号与空白、尾杠整理、裸盘符补 \、统一小写。
/// 让 AI 写 "C:/Users/x"、"c:\\\\users\\\\x"（JSON 转义后）、"C:\\Users\\X\\" 都能命中
fn norm_query_path(raw: &str) -> String {
    let mut s = raw.trim().trim_matches('"').replace('/', "\\");
    while s.len() > 3 && s.ends_with('\\') {
        s.pop();
    }
    if s.len() == 2 && s.as_bytes().get(1) == Some(&b':') {
        s.push('\\'); // "c:" → "c:\"
    }
    s.to_lowercase()
}

/// 快照 tree 裁剪到 depth 层（depth=0 即折叠本层全部子项）。
/// 被 VP 掉的层不丢信息：子项数量与字节并入该节点的 agg{n,s,al}（与已有 agg 合并）
fn prune_snapshot_tree(node: &mut serde_json::Value, depth: u32) {
    let Some(obj) = node.as_object_mut() else { return };
    let Some(mut children_val) = obj.remove("c") else { return };
    if depth == 0 {
        let mut n: u64 = 0;
        let mut s: u64 = 0;
        let mut al: u64 = 0;
        if let Some(children) = children_val.as_array() {
            for c in children {
                n += 1;
                s += c.get("s").and_then(|x| x.as_u64()).unwrap_or(0);
                al += c.get("al").and_then(|x| x.as_u64()).unwrap_or(0);
            }
        }
        if let Some(a) = obj.get("agg").and_then(|x| x.as_object()).cloned() {
            n += a.get("n").and_then(|x| x.as_u64()).unwrap_or(0);
            s += a.get("s").and_then(|x| x.as_u64()).unwrap_or(0);
            al += a.get("al").and_then(|x| x.as_u64()).unwrap_or(0);
        }
        let mut agg = serde_json::Map::new();
        agg.insert("n".into(), n.into());
        agg.insert("s".into(), s.into());
        if al > 0 {
            agg.insert("al".into(), al.into());
        }
        obj.insert("agg".into(), agg.into());
        return;
    }
    if let Some(children) = children_val.as_array_mut() {
        for ch in children.iter_mut() {
            prune_snapshot_tree(ch, depth - 1);
        }
    }
    obj.insert("c".into(), children_val);
}

/// 在快照 tree 里按路径（小写）找子树节点（前端快照的 p 为原大小写，两侧都归一小写）
fn find_snapshot_tree_node<'a>(
    node: &'a mut serde_json::Value,
    path_lower: &str,
) -> Option<&'a mut serde_json::Value> {
    let matches = node
        .get("p")
        .and_then(|x| x.as_str())
        .map(|s| s.to_lowercase())
        .as_deref()
        == Some(path_lower);
    if matches {
        return Some(node);
    }
    let arr = node.get_mut("c")?.as_array_mut()?;
    for ch in arr.iter_mut() {
        if let Some(found) = find_snapshot_tree_node(ch, path_lower) {
            return Some(found);
        }
    }
    None
}

/// /api/tree 单目录单列子项上限：其余按 `more` 计数（配合预算防"一大坨"）
const TREE_MAX_CHILDREN: usize = 200;
/// /api/tree 单次响应的全局节点预算：超出即停止下钻并标 truncated
const TREE_NODE_BUDGET: usize = 2000;

/// 多层级树节点构建（纯函数，供 /api/tree 与单测）：
/// 一次返回 path 下 depth 层的目录与大文件（≥min 单列，<min 聚合进 agg），
/// 每目录最多 TREE_MAX_CHILDREN 个单列子项，全局 TREE_NODE_BUDGET 节点预算。
/// 返回 (节点 JSON, 子树是否被预算截断)。节点字段：
///   name/path/s/al + file?（文件）+ agg?{n,s}（低于 min 的聚合）+ more?（超上限未单列数）
///   + children?[]（子目录继续展开）+ truncated?（预算截断标记）
fn build_tree_node(
    sizes: &HashMap<String, (u64, u64)>,
    files: &HashMap<String, Vec<(String, u64, u64)>>,
    path_lower: &str,
    depth: u32,
    min: u64,
    budget: &mut usize,
) -> (serde_json::Value, bool) {
    let (s, al) = sizes.get(path_lower).copied().unwrap_or((0, 0));
    let name = path_lower
        .trim_end_matches('\\')
        .rsplit('\\')
        .next()
        .unwrap_or("")
        .to_string();

    // 直接子层：目录来自 sizes 完成表（tree_children 已按大小降序），文件来自登记表
    let dirs = tree_children(sizes, path_lower);
    let dir_iter = dirs
        .into_iter()
        .map(|(p, cs, cal)| {
            let nm = p.rsplit('\\').next().unwrap_or("").to_string();
            (nm, cs, cal, p, false)
        })
        .collect::<Vec<_>>();
    let file_iter = files
        .get(path_lower)
        .map(|v| v.as_slice())
        .unwrap_or(&[])
        .iter()
        .map(|(nm, cs, cal)| (nm.clone(), *cs, *cal, String::new(), true))
        .collect::<Vec<_>>();
    let mut entries = dir_iter;
    entries.extend(file_iter);
    entries.sort_by(|a, b| b.1.cmp(&a.1));

    let mut agg_n: u64 = 0;
    let mut agg_s: u64 = 0;
    let mut more: u64 = 0;
    let mut listed = 0usize;
    let mut children: Vec<serde_json::Value> = Vec::new();
    let mut truncated = false;

    for (nm, cs, cal, child_path, is_file) in entries {
        if cs < min {
            // 低于阈值不单列：聚合计数与字节（信息不丢，体量可控）
            agg_n += 1;
            agg_s += cs;
            continue;
        }
        if listed >= TREE_MAX_CHILDREN {
            more += 1;
            continue;
        }
        if *budget == 0 {
            // 全局预算耗尽：不再发节点，剩余计 more 并标记截断
            truncated = true;
            more += 1;
            continue;
        }
        *budget -= 1;
        listed += 1;
        if is_file {
            children.push(serde_json::json!({
                "name": nm, "path": child_path, "s": cs, "al": cal, "file": true
            }));
        } else if depth > 1 {
            let (mut cobj, ctrunc) =
                build_tree_node(sizes, files, &child_path, depth - 1, min, budget);
            if ctrunc {
                truncated = true;
                cobj["truncated"] = serde_json::json!(true);
            }
            children.push(cobj);
        } else {
            children.push(serde_json::json!({
                "name": nm, "path": child_path, "s": cs, "al": cal
            }));
        }
    }

    let mut node = serde_json::json!({
        "name": name,
        "path": path_lower,
        "s": s,
        "al": al,
    });
    if agg_n > 0 {
        node["agg"] = serde_json::json!({"n": agg_n, "s": agg_s});
    }
    if more > 0 {
        node["more"] = more.into();
    }
    if !children.is_empty() {
        node["children"] = serde_json::Value::Array(children);
    }
    (node, truncated)
}

/// 设置/覆盖提案；已有 pending 提案时拒绝（AI 需先等用户处理上一个）
fn try_set_proposal(state: &AiChannelState, v: serde_json::Value) -> Result<(), String> {
    let mut g = state.proposal.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(p) = g.as_ref() {
        if p.get("status").and_then(|s| s.as_str()) == Some("pending") {
            return Err("已有待确认的提案".into());
        }
    }
    *g = Some(v);
    Ok(())
}

/// 解析后的请求头（头部名统一小写）
struct ReqHead {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
}

fn req_header<'a>(h: &'a ReqHead, name: &str) -> Option<&'a str> {
    h.headers
        .iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.as_str())
}

/// 纯函数：解析请求头文本（到 \r\n\r\n 为止的段），便于单测
fn parse_head(text: &str) -> Option<ReqHead> {
    let mut lines = text.split("\r\n");
    let first = lines.next()?;
    let mut it = first.split(' ');
    let method = it.next()?.to_string();
    let path = it.next()?.to_string();
    if method.is_empty() || !path.starts_with('/') {
        return None;
    }
    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if let Some(idx) = line.find(':') {
            headers.push((
                line[..idx].trim().to_ascii_lowercase(),
                line[idx + 1..].trim().to_string(),
            ));
        }
    }
    Some(ReqHead { method, path, headers })
}

/// Host 头校验：只接受 127.0.0.1 / [::1] / localhost（防 DNS rebinding）
fn host_allowed(host: &str) -> bool {
    let h = host.trim();
    // IPv6 字面量带端口是 "[::1]:9000"：先取方括号段，再按 : 切端口
    let h = if h.starts_with('[') {
        match h.find(']') {
            Some(i) => &h[..=i],
            None => h,
        }
    } else {
        h.split(':').next().unwrap_or("")
    };
    h == "127.0.0.1" || h == "localhost" || h == "[::1]"
}

fn http_res(stream: &mut std::net::TcpStream, status: u16, reason: &str, body: &str) {
    use std::io::Write;
    let _ = write!(
        stream,
        "HTTP/1.1 {} {}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{}",
        status, reason, body.len(), body
    );
    let _ = stream.flush();
}

fn handle_ai_conn(app: &AppHandle, mut stream: std::net::TcpStream, token: &str) {
    use std::io::Read;
    // 读到头部结束（上限 16KB 防滥用）
    let mut buf: Vec<u8> = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    let head_end;
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => return,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if let Some(pos) = find_head_end(&buf) {
                    head_end = pos;
                    break;
                }
                if buf.len() > 16 * 1024 {
                    http_res(&mut stream, 431, "Request Header Fields Too Large", "{\"error\":\"header too large\"}");
                    return;
                }
            }
            Err(_) => return,
        }
    }
    let head_text = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let head = match parse_head(&head_text) {
        Some(h) => h,
        None => {
            http_res(&mut stream, 400, "Bad Request", "{\"error\":\"bad request\"}");
            return;
        }
    };
    let state = app.state::<AiChannelState>();
    // 三道门
    if !state.enabled.load(Ordering::Relaxed) {
        http_res(&mut stream, 403, "Forbidden", "{\"error\":\"channel disabled\"}");
        return;
    }
    if !req_header(&head, "host").map(host_allowed).unwrap_or(false) {
        http_res(&mut stream, 403, "Forbidden", "{\"error\":\"host not allowed\"}");
        return;
    }
    if req_header(&head, "x-disklens-token") != Some(token) {
        http_res(&mut stream, 403, "Forbidden", "{\"error\":\"bad token\"}");
        return;
    }
    let content_len: usize = req_header(&head, "content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    if content_len > 1024 * 1024 {
        http_res(&mut stream, 413, "Payload Too Large", "{\"error\":\"body too large\"}");
        return;
    }
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < content_len {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => body.extend_from_slice(&chunk[..n]),
            Err(_) => break,
        }
    }

    // 路由匹配用去查询串的路径；查询参数交给需要的分支（/api/tree）
    let route = head.path.split('?').next().unwrap_or("").to_string();
    match (head.method.as_str(), route.as_str()) {
        ("GET", "/api/info") => {
            let root = state
                .snapshot
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_ref()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
                .and_then(|v| v.get("root").cloned());
            let body = serde_json::json!({
                "app": "disklens",
                "version": env!("CARGO_PKG_VERSION"),
                "root": root,
                "flow": "推荐：GET /api/tree（不带 path，一次拿根下 3 层全景）→ 对目标目录 GET /api/tree?path=...&depth=3 精准下钻。所有响应都是几 KB 的 JSON，直接读 stdout，不要 -o 落盘再解析；只在需要类型分布/卷口径/受限目录时才拉 /api/scan?tree=0&depth=1",
                "endpoints": [
                    "GET  /api/status    — 扫描状态 {scanning, hasSnapshot, root}（先查这个）",
                    "POST /api/scan      — 触发扫描 {\"root\":\"C:\\\\\"} 或 {\"roots\":[\"C:\\\\\",\"D:\\\\\"]}（未扫描/换盘时用）",
                    "GET  /api/tree      — 多层级下钻：?path=<目录>&depth=<1..=8,默认3>&min=<字节,默认10MB>。一次返回 depth 层的目录+大文件（含 file 标记），<min 聚合进 agg{n,s}，more=未单列数，truncated=预算截断。path 不带则用根；正/反斜杠等价、大小写不敏感",
                    "GET  /api/scan      — 扫描快照：全量时树+类型+卷口径+受限目录 denied（MB 级）。裁剪参数：?depth=4 树只留 4 层（被裁层折叠进 agg）、?tree=0 不要树只要统计、?path=<目录> 只取子树——带参数的响应为 KB 级",
                    "GET  /api/proposal  — 当前提案状态（轮询执行结果）",
                    "POST /api/proposal  — 提交提案 {summary, items:[{action:migrate|cleanup|note, src, dest_root?, reason?}]}"
                ],
            });
            http_res(&mut stream, 200, "OK", &body.to_string());
        }
        ("GET", "/api/status") => {
            let scanning = app
                .state::<ScanState>()
                .running
                .lock()
                .map(|g| *g)
                .unwrap_or(false);
            let snap = state.snapshot.lock().unwrap_or_else(|e| e.into_inner());
            let (has_snapshot, root, scanning_snap) = match snap.as_ref() {
                Some(s) => match serde_json::from_str::<serde_json::Value>(s) {
                    Ok(v) => (
                        true,
                        v.get("root").cloned(),
                        v.get("scanning").and_then(|b| b.as_bool()),
                    ),
                    Err(_) => (true, None, None),
                },
                None => (false, None, None),
            };
            let body = serde_json::json!({
                "scanning": scanning || scanning_snap.unwrap_or(false),
                "hasSnapshot": has_snapshot,
                "root": root,
            });
            http_res(&mut stream, 200, "OK", &body.to_string());
        }
        ("POST", "/api/scan") => {
            let body_v = serde_json::from_slice::<serde_json::Value>(&body).ok();
            // 兼容 {"root":"C:\\"} 单盘 与 {"roots":["C:\\","D:\\"]} 多盘
            let roots: Vec<String> = body_v
                .as_ref()
                .and_then(|v| v.get("roots").and_then(|r| r.as_array()).cloned())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect()
                })
                .or_else(|| {
                    body_v
                        .as_ref()
                        .and_then(|v| v.get("root").and_then(|r| r.as_str()).map(String::from))
                        .map(|r| vec![r])
                })
                .unwrap_or_else(|| vec!["C:\\".to_string()]);
            match do_scan_start(app, roots) {
                Ok(()) => http_res(&mut stream, 200, "OK", "{\"started\":true}"),
                Err(e) if e.contains("已有扫描") => {
                    http_res(&mut stream, 409, "Conflict", &format!("{{\"error\":\"{}\"}}", e))
                }
                Err(e) => http_res(&mut stream, 400, "Bad Request", &format!("{{\"error\":\"{}\"}}", e)),
            }
        }
        ("GET", "/api/tree") => {
            // 多层级下钻：path（缺省=快照根）+ depth（1..=8，默认 3）+ min（子项单列阈值字节，默认 10MB）
            let q = head.path.split_once('?').map(|(_, q)| q).unwrap_or("");
            let params = parse_query(q);
            let get_p = |k: &str| {
                params
                    .iter()
                    .find(|(kk, _)| kk == k)
                    .map(|(_, v)| v.clone())
            };
            let scan_state = app.state::<ScanState>();
            let lower = match get_p("path") {
                Some(p) if !p.trim().is_empty() => norm_query_path(&p),
                _ => state
                    .snapshot
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .as_ref()
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
                    .and_then(|v| v.get("root").and_then(|r| r.as_str()).map(String::from))
                    .unwrap_or_default()
                    .to_lowercase(),
            };
            if lower.is_empty() {
                http_res(&mut stream, 404, "Not Found", "{\"error\":\"no scan yet\"}");
                return;
            }
            let depth = get_p("depth")
                .and_then(|d| d.trim().parse::<u32>().ok())
                .unwrap_or(3)
                .clamp(1, 8);
            let min = get_p("min")
                .and_then(|m| m.trim().parse::<u64>().ok())
                .unwrap_or(MIN_BIG_FILE);
            let g = scan_state.sizes.lock().unwrap_or_else(|e| e.into_inner());
            if !g.contains_key(&lower) {
                // 未扫描/不存在的路径：明确 404 + 下一步指引，而不是返回空 children 让 AI 猜
                let body = serde_json::json!({
                    "error": "path not found in scan records (未扫描或不在此范围内)",
                    "hint": "先 GET /api/tree（不带 path）从根开始；路径传小写、/ 或 \\ 均可；已完成扫描的范围见 GET /api/status 的 root"
                });
                http_res(&mut stream, 404, "Not Found", &body.to_string());
                return;
            }
            let f = scan_state
                .big_files
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let mut budget = TREE_NODE_BUDGET;
            let (node, truncated) = build_tree_node(&g, &f, &lower, depth, min, &mut budget);
            let mut root = serde_json::json!({
                "path": lower,
                "depth": depth,
                "min": min,
                "total": node["s"],
                "rootAl": node["al"],
                "truncated": truncated,
            });
            for k in ["agg", "more", "children"] {
                if node.get(k).is_some() {
                    root[k] = node[k].clone();
                }
            }
            root["note"] = serde_json::json!(
                "children 已展开 depth 层（目录+≥min 的大文件，按大小降序）；<min 的子项聚合成 agg{n,s}；more=超上限未单列数；truncated=节点预算截断，请用更小的 path/depth 精准下钻；路径均为小写；监视中的增量变化可能未反映；受限目录清单见 GET /api/scan 的 denied"
            );
            http_res(&mut stream, 200, "OK", &root.to_string());
        }
        ("GET", "/api/scan") => {
            let g = state.snapshot.lock().unwrap_or_else(|e| e.into_inner());
            match g.as_ref() {
                None => http_res(&mut stream, 404, "Not Found", "{\"error\":\"no scan yet\"}"),
                Some(s) => {
                    // 无裁剪参数：原样回传全量快照（MB 级，兼容旧行为）
                    let q = head.path.split_once('?').map(|(_, q)| q).unwrap_or("");
                    let params = parse_query(q);
                    let get_p = |k: &str| {
                        params
                            .iter()
                            .find(|(kk, _)| kk == k)
                            .map(|(_, v)| v.clone())
                    };
                    if get_p("depth").is_none()
                        && get_p("tree").is_none()
                        && get_p("path").is_none()
                    {
                        http_res(&mut stream, 200, "OK", s);
                        return;
                    }
                    // 带裁剪参数：解析快照后按需瘦身——响应小到能直接读 stdout，
                    // AI 不必 -o 落盘再解析（落盘易踩 Git Bash /tmp 与原生程序路径错位）
                    let mut v: serde_json::Value = match serde_json::from_str(s) {
                        Ok(v) => v,
                        Err(_) => {
                            http_res(&mut stream, 200, "OK", s);
                            return;
                        }
                    };
                    if let Some(p) = get_p("path") {
                        if !p.trim().is_empty() {
                            let lower = norm_query_path(&p);
                            let found = v
                                .get_mut("tree")
                                .and_then(|t| find_snapshot_tree_node(t, &lower));
                            match found {
                                Some(sub) => {
                                    let taken = sub.take();
                                    if let Some(obj) = v.as_object_mut() {
                                        obj.insert("tree".into(), taken);
                                    }
                                    v["root"] = serde_json::json!(lower);
                                }
                                None => {
                                    let body = serde_json::json!({
                                        "error": "path not found in snapshot tree",
                                        "hint": "路径小写；先 GET /api/tree?depth=3 看看快照里有哪些目录"
                                    });
                                    http_res(&mut stream, 404, "Not Found", &body.to_string());
                                    return;
                                }
                            }
                        }
                    }
                    if get_p("tree").as_deref() == Some("0") {
                        if let Some(obj) = v.as_object_mut() {
                            obj.remove("tree");
                        }
                    } else if let Some(d) = get_p("depth") {
                        let depth = d.trim().parse::<u32>().unwrap_or(u32::MAX).min(16);
                        if let Some(tree) = v.get_mut("tree") {
                            prune_snapshot_tree(tree, depth);
                        }
                    }
                    http_res(&mut stream, 200, "OK", &v.to_string());
                }
            }
        }
        ("GET", "/api/proposal") => {
            let g = state.proposal.lock().unwrap_or_else(|e| e.into_inner());
            let v = g.clone().unwrap_or(serde_json::json!({"status": "none"}));
            http_res(&mut stream, 200, "OK", &v.to_string());
        }
        ("POST", "/api/proposal") => {
            let parsed: Result<serde_json::Value, _> = serde_json::from_slice(&body);
            let mut v = match parsed {
                Ok(v) => v,
                Err(e) => {
                    http_res(&mut stream, 400, "Bad Request", &format!("{{\"error\":\"invalid json: {}\"}}", e));
                    return;
                }
            };
            let items_ok = v.get("items").and_then(|i| i.as_array()).map(|a| !a.is_empty()).unwrap_or(false);
            if !items_ok {
                http_res(&mut stream, 400, "Bad Request", "{\"error\":\"items must be a non-empty array\"}");
                return;
            }
            let id = format!(
                "p{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
            );
            if let Some(o) = v.as_object_mut() {
                o.insert("id".into(), serde_json::json!(id));
                o.insert("status".into(), serde_json::json!("pending"));
                o.insert("results".into(), serde_json::json!([]));
            }
            match try_set_proposal(&state, v.clone()) {
                Ok(()) => {
                    let _ = app.emit("ai-proposal", &v);
                    http_res(&mut stream, 200, "OK", &format!("{{\"id\":\"{}\"}}", id));
                }
                Err(e) => http_res(&mut stream, 409, "Conflict", &format!("{{\"error\":\"{}\"}}", e)),
            }
        }
        _ => http_res(&mut stream, 404, "Not Found", "{\"error\":\"unknown endpoint\"}"),
    }
}

fn find_head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

/// 后台 HTTP 服务：绑定 127.0.0.1 随机端口，thread-per-connection（本机低流量）
fn run_ai_channel(app: AppHandle) {
    let listener = match std::net::TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(_) => return, // 端口绑定失败：通道不可用，应用其余功能不受影响
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let token = app.state::<AiChannelState>().token.clone();
    app.state::<AiChannelState>()
        .port
        .store(port as usize, Ordering::Relaxed);
    // dev 日志可见（tauri dev 的 stderr），方便用 curl 联调；发布版无控制台输出
    eprintln!(
        "[disklens] AI channel listening: http://127.0.0.1:{} (token: {})",
        port, token
    );
    for conn in listener.incoming() {
        let Ok(stream) = conn else { continue };
        let app2 = app.clone();
        let token = token.clone();
        std::thread::spawn(move || {
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(10)));
            handle_ai_conn(&app2, stream, &token);
        });
    }
}

#[tauri::command]
fn ai_snapshot(state: State<'_, AiChannelState>, json: String) -> Result<(), String> {
    *state.snapshot.lock().map_err(|e| e.to_string())? = Some(json);
    Ok(())
}

#[tauri::command]
fn ai_channel_info(state: State<'_, AiChannelState>) -> serde_json::Value {
    serde_json::json!({
        "port": state.port.load(Ordering::Relaxed) as u64,
        "token": state.token,
        "enabled": state.enabled.load(Ordering::Relaxed),
    })
}

#[tauri::command]
fn ai_channel_set_enabled(state: State<'_, AiChannelState>, enabled: bool) {
    state.enabled.store(enabled, Ordering::Relaxed);
}

/// 前端在提案处理完（执行完毕 / 用户忽略）后回写终态，供 AI 轮询
#[tauri::command]
fn ai_proposal_result(
    state: State<'_, AiChannelState>,
    id: String,
    status: String,
    results: serde_json::Value,
) -> Result<(), String> {
    let mut g = state.proposal.lock().map_err(|e| e.to_string())?;
    if let Some(p) = g.as_mut() {
        if p.get("id").and_then(|i| i.as_str()) == Some(id.as_str()) {
            if let Some(o) = p.as_object_mut() {
                o.insert("status".into(), serde_json::json!(status));
                o.insert("results".into(), results);
            }
        }
    }
    Ok(())
}

/// 评估可迁移性。walk_stats 递归统计大目录可能耗时数秒——async + 线程池执行，
/// 不阻塞 UI 主线程（否则转圈动画外的整个界面冻结，观感"未响应"）
#[tauri::command]
async fn migrate_check(src: String, dest_root: String) -> Result<CheckResult, String> {
    tauri::async_runtime::spawn_blocking(move || migrate_check_impl(src, dest_root))
        .await
        .map_err(|e| format!("内部错误：{}", e))?
}

fn migrate_check_impl(src: String, dest_root: String) -> Result<CheckResult, String> {
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
    if !Path::new(&dest_root_n).is_dir() {
        blockers.push(format!("目标文件夹不存在：{}", dest_root_n));
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
            // 同卷快速路径：rename 瞬时完成，再回原位建 junction。
            // 目标父目录必须存在 rename 才能成功（用户可能选了一个待创建的层级）
            if let Some(parent) = Path::new(&dest_path).parent() {
                if let Err(e) = fs::create_dir_all(parent) {
                    emit_mig(&app2, "error", &format!("无法创建目标父目录 {}：{}", parent.display(), e), "", 0, 0, 0, 0, &[]);
                    return;
                }
            }
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
    // 后台拉起（自动更新重启/开机自启快捷方式带参）时不抢前台焦点
    if std::env::args().any(|a| a == "--no-focus") {
        NO_FOCUS.store(true, Ordering::Relaxed);
    }
    install_diag_panic_hook();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(ScanState::default())
        .manage(MigrateState::default())
        .manage(WatchState::default())
        .manage(AiChannelState::new())
        .manage(DiagState::default())
        .invoke_handler(tauri::generate_handler![
            scan_start,
            scan_stop,
            scan_priority,
            scan_refresh,
            scan_status,
            open_in_explorer,
            list_volumes,
            save_text_file,
            write_scan_cache,
            read_scan_cache,
            recycle_delete,
            migrate_undo,
            scan_refresh,
            show_window,
            relaunch_no_focus,
            ai_snapshot,
            ai_channel_info,
            ai_channel_set_enabled,
            ai_proposal_result,
            migrate_check,
            migrate_start,
            migrate_stop,
            watch_start,
            watch_stop,
            app_log,
            diag_report
        ])
        .setup(|app| {
            // 应用内自动更新（updater + 重启）+ 原生文件夹选择对话框：仅桌面端
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
                app.handle().plugin(tauri_plugin_dialog::init())?;
            }
            // 诊断日志：轮换上一会话 + 标记异常退出 + 写会话头
            let dir = diag_log_dir(app.handle());
            if let Some(dir) = dir {
                let abnormal = diag_rotate_dir(&dir);
                app.state::<DiagState>()
                    .last_abnormal
                    .store(abnormal, Ordering::Relaxed);
                let cur = dir.join("current.log");
                let _ = DIAG_LOG_PATH.set(cur.clone());
                diag_append_file(
                    &cur,
                    &format!(
                        "[UTC {}] [session] 启动 v{} {} {}",
                        utc_stamp(),
                        env!("CARGO_PKG_VERSION"),
                        std::env::consts::OS,
                        std::env::consts::ARCH
                    ),
                );
            }
            // AI 联动通道：本地 127.0.0.1 随机端口的迷你 HTTP 服务（仅桌面端有意义；
            // 端口/token 通过 ai_channel_info 给前端展示）
            let handle = app.handle().clone();
            std::thread::spawn(move || run_ai_channel(handle));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, event| {
            // 正常退出打标记：下一份日志没有该标记即视为异常退出（崩溃/被杀/断电）
            if let tauri::RunEvent::Exit = event {
                if let Some(p) = DIAG_LOG_PATH.get() {
                    diag_append_file(p, LOG_EXIT_MARKER);
                }
            }
        });
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
            al: 130,
            done: true,
            file: false,
            dup: true,
            cloud: false,
            denied: false,
        };
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["path"], r"C:\Users");
        assert_eq!(v["parent"], r"C:\");
        assert_eq!(v["name"], "Users");
        assert_eq!(v["size"], 123);
        assert_eq!(v["al"], 130);
        assert_eq!(v["done"], true);
        assert_eq!(v["file"], false);
        // 标记字段按需序列化：true 必须出现，false 省略（省 IPC 流量）
        assert_eq!(v["dup"], true);
        assert!(v.get("cloud").is_none());
        assert!(v.get("denied").is_none());
    }

    #[test]
    fn approx_alloc_rounds_to_cluster() {
        // 普通文件按簇取整
        assert_eq!(approx_alloc(1, 4096, 0), 4096);
        assert_eq!(approx_alloc(4096, 4096, 0), 4096);
        assert_eq!(approx_alloc(4097, 4096, 0), 8192);
        // 压缩 / 稀疏文件不取整（真实占用拿不到，逻辑大小是更近的近似）
        assert_eq!(approx_alloc(3000, 4096, FILE_ATTRIBUTE_COMPRESSED), 3000);
        assert_eq!(approx_alloc(7000, 4096, FILE_ATTRIBUTE_SPARSE_FILE), 7000);
        // 云占位独立于 approx_alloc 判定，这里只看普通/压缩两分支
        assert_eq!(approx_alloc(0, 4096, 0), 0);
        assert_eq!(approx_alloc(123, 0, 0), 123); // 无簇大小信息时退化为逻辑大小
    }

    #[test]
    fn cloud_placeholder_detects_recall_bits() {
        assert!(is_cloud_placeholder(FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS));
        assert!(is_cloud_placeholder(FILE_ATTRIBUTE_RECALL_ON_OPEN));
        assert!(is_cloud_placeholder(
            FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS | FILE_ATTRIBUTE_ARCHIVE
        ));
        assert!(!is_cloud_placeholder(FILE_ATTRIBUTE_ARCHIVE));
        assert!(!is_cloud_placeholder(0));
    }

    #[test]
    fn ai_http_parse_head_and_host_check() {
        let h = parse_head("POST /api/proposal HTTP/1.1\r\nHost: 127.0.0.1:8431\r\n\
                           X-DiskLens-Token: abc123\r\nContent-Length: 42\r\n\r\n")
            .expect("合法请求头应解析成功");
        assert_eq!(h.method, "POST");
        assert_eq!(h.path, "/api/proposal");
        assert_eq!(req_header(&h, "host"), Some("127.0.0.1:8431"));
        assert_eq!(req_header(&h, "x-disklens-token"), Some("abc123")); // 头部名小写化
        assert_eq!(req_header(&h, "content-length"), Some("42"));
        assert!(parse_head("garbage").is_none());
        assert!(parse_head("GET ftp://x HTTP/1.1\r\n\r\n").is_none()); // 路径必须以 / 开头
        // Host 白名单：本机放行，外域拒（防 DNS rebinding）
        assert!(host_allowed("127.0.0.1:8431"));
        assert!(host_allowed("localhost"));
        assert!(host_allowed("[::1]:9000"));
        assert!(!host_allowed("evil.example.com"));
        assert!(!host_allowed(""));
    }

    #[test]
    fn ai_token_is_long_and_changes() {
        let a = gen_token();
        let b = gen_token();
        assert_eq!(a.len(), 32); // 2 × u64 hex
        assert_ne!(a, b);        // 同纳秒窗口内也因 RandomState 种子不同而互异
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn ai_tree_children_direct_layer_only() {
        let mut m: HashMap<String, (u64, u64)> = HashMap::new();
        m.insert("c:\\a".into(), (100, 110));
        m.insert("c:\\a\\b".into(), (60, 66));          // 直接子层
        m.insert("c:\\a\\b\\deep".into(), (10, 11));     // 更深层：不下钻
        m.insert("c:\\a\\c".into(), (40, 44));           // 直接子层
        m.insert("c:\\ab".into(), (999, 999));           // 前缀相似但非子目录：排除
        m.insert("c:\\x".into(), (1, 1));
        let kids = tree_children(&m, "c:\\a");
        assert_eq!(kids.len(), 2);
        assert_eq!(kids[0].0, "c:\\a\\b");               // 按大小降序
        assert_eq!(kids[0].1, 60);
        assert_eq!(kids[1].0, "c:\\a\\c");
        // 尾部反斜杠的输入归一化
        assert_eq!(tree_children(&m, "c:\\a\\").len(), 2);
        // 盘根（ trim 后为 "c:"，前缀 "c:\\" ）
        let root_kids = tree_children(&m, "c:\\");
        assert_eq!(root_kids.len(), 3);                  // a / ab / x
    }

    #[test]
    fn ai_pct_decode_paths() {
        assert_eq!(pct_decode("c%3A%5Cusers%5Cdemo"), "c:\\users\\demo");
        assert_eq!(pct_decode("c:\\plain"), "c:\\plain");   // 未编码原样通过
        assert_eq!(pct_decode("a%2"), "a%2");               // 非法序列不吞字符
        assert_eq!(pct_decode("%E4%B8%AD"), "中");           // UTF-8 百分号编码
    }

    #[test]
    fn query_parses_multiple_params() {
        let q = parse_query("path=C%3A%5Cusers&depth=3&min=10485760&x=");
        assert_eq!(q[0], ("path".into(), "C:\\users".into())); // 只解码；小写归一在 norm_query_path
        assert_eq!(q[1], ("depth".into(), "3".into()));
        assert_eq!(q[2], ("min".into(), "10485760".into()));
        assert_eq!(q[3], ("x".into(), "".into()));
    }

    #[test]
    fn norm_query_path_tolerates_ai_input_forms() {
        // 正斜杠、大小写、尾杠、裸盘符、引号——AI 常见写法都要命中
        assert_eq!(norm_query_path("C:/Users/HetFrame"), "c:\\users\\hetframe");
        assert_eq!(norm_query_path("c:\\users\\"), "c:\\users");
        assert_eq!(norm_query_path("\"C:\\Users\\X\""), "c:\\users\\x");
        assert_eq!(norm_query_path("C:"), "c:\\");
        assert_eq!(norm_query_path("C:\\"), "c:\\");
        assert_eq!(norm_query_path("  D:\\big  "), "d:\\big");
    }

    /// 测试夹具：根下 a（内含 b/deep 与两个文件）、c 三层结构
    fn tree_fixture() -> (
        HashMap<String, (u64, u64)>,
        HashMap<String, Vec<(String, u64, u64)>>,
    ) {
        let mut sizes: HashMap<String, (u64, u64)> = HashMap::new();
        sizes.insert("c:\\".into(), (1000, 1100));
        sizes.insert("c:\\a".into(), (600, 660));
        sizes.insert("c:\\a\\b".into(), (500, 550));
        sizes.insert("c:\\a\\b\\deep".into(), (400, 440));
        sizes.insert("c:\\a\\small".into(), (5, 5));
        sizes.insert("c:\\c".into(), (300, 330));
        let mut files: HashMap<String, Vec<(String, u64, u64)>> = HashMap::new();
        files.insert(
            "c:\\a".into(),
            vec![("big.iso".into(), 120, 130), ("tiny.log".into(), 1, 1)],
        );
        files.insert("c:\\a\\b\\deep".into(), vec![("core.vhdx".into(), 380, 400)]);
        (sizes, files)
    }

    #[test]
    fn tree_multi_expands_depth_and_includes_files() {
        let (sizes, files) = tree_fixture();
        let mut budget = TREE_NODE_BUDGET;
        // depth=3：根 → a/b → deep，文件以 file 标记单列
        let (node, trunc) = build_tree_node(&sizes, &files, "c:\\", 3, 10, &mut budget);
        assert!(!trunc);
        let kids = node["children"].as_array().unwrap();
        // c:\ 根的子项按大小降序：a(600) > c(300) > big.iso(120)
        assert_eq!(kids[0]["path"], "c:\\a");
        // a 的单列子项 = b(500) + big.iso(120)；small(5)、tiny.log(1) < min=10 → 聚合进 agg
        assert_eq!(kids[0]["children"].as_array().unwrap().len(), 2);
        let a_node = &kids[0];
        // a 的子项：b(500)、big.iso(120)单列；small(5)、tiny.log(1) <min=10 聚合
        assert_eq!(a_node["agg"]["n"], 2);
        assert_eq!(a_node["agg"]["s"], 6);
        let a_kids = a_node["children"].as_array().unwrap();
        assert_eq!(a_kids[0]["path"], "c:\\a\\b");
        assert_eq!(a_kids[1]["file"], true); // big.iso
        assert_eq!(a_kids[1]["s"], 120);
        // depth=3：根 → a(第1层) → b(第2层) → deep(第3层，到顶不再下钻)
        let b_node = &a_kids[0];
        let b_kids = b_node["children"].as_array().unwrap();
        assert_eq!(b_kids[0]["path"], "c:\\a\\b\\deep");
        assert!(b_kids[0]["children"].is_null(), "depth 用尽：deep 不再下钻");
    }

    #[test]
    fn tree_multi_depth1_lists_direct_only() {
        let (sizes, files) = tree_fixture();
        let mut budget = TREE_NODE_BUDGET;
        let (node, trunc) = build_tree_node(&sizes, &files, "c:\\a", 1, 10, &mut budget);
        assert!(!trunc);
        let kids = node["children"].as_array().unwrap();
        assert_eq!(kids.len(), 2); // b + big.iso（small/tiny 聚合进 agg）
        assert!(kids.iter().all(|k| k["children"].is_null()), "depth=1 不展开");
    }

    #[test]
    fn tree_multi_budget_truncates_with_more_count() {
        let (sizes, files) = tree_fixture();
        let mut budget = 2usize; // 只够 a、b 两个节点
        let (node, trunc) = build_tree_node(&sizes, &files, "c:\\", 3, 10, &mut budget);
        assert!(trunc, "预算耗尽应标记截断");
        // 预算 2：a 消耗 1（其下层 b 再消耗 1 后耗尽），c 不再发节点、计入根的 more
        let kids = node["children"].as_array().unwrap();
        assert_eq!(kids.len(), 1);
        assert_eq!(node["more"], 1);
        let a_node = &kids[0];
        assert_eq!(a_node["truncated"], true, "a 的下层被截断应带标记");
        assert_eq!(a_node["more"], 1, "耗尽后剩余单列子项计入 more（big.iso）");
    }

    #[test]
    fn tree_multi_caps_children_per_dir() {
        let mut sizes: HashMap<String, (u64, u64)> = HashMap::new();
        sizes.insert("c:\\".into(), (1 << 30, 1 << 30));
        for i in 0..TREE_MAX_CHILDREN + 15 {
            sizes.insert(format!("c:\\d{:03}", i), ((i as u64) + 1, (i as u64) + 1));
        }
        let files: HashMap<String, Vec<(String, u64, u64)>> = HashMap::new();
        let mut budget = TREE_NODE_BUDGET;
        let (node, _) = build_tree_node(&sizes, &files, "c:\\", 1, 0, &mut budget);
        let kids = node["children"].as_array().unwrap();
        assert_eq!(kids.len(), TREE_MAX_CHILDREN);
        assert_eq!(node["more"], 15);
        // 排序仍按大小降序：d014 最大在前
        assert_eq!(kids[0]["path"], format!("c:\\d{:03}", TREE_MAX_CHILDREN + 14));
    }

    #[test]
    fn ai_proposal_rejects_second_pending() {
        let st = AiChannelState::new();
        let p1 = serde_json::json!({"id":"p1","items":[{"action":"migrate","src":"C:\\x"}],"status":"pending"});
        assert!(try_set_proposal(&st, p1).is_ok());
        // pending 未处理时新提案被拒（409 语义）
        let p2 = serde_json::json!({"id":"p2","items":[{"action":"note","src":"C:\\y"}],"status":"pending"});
        assert!(try_set_proposal(&st, p2).is_err());
        // 终态后可再提交
        let done = serde_json::json!({"id":"p1","items":[],"status":"done","results":[]});
        *st.proposal.lock().unwrap() = Some(done);
        let p3 = serde_json::json!({"id":"p3","items":[{"action":"note","src":"C:\\z"}],"status":"pending"});
        assert!(try_set_proposal(&st, p3).is_ok());
    }

    #[test]
    #[cfg(windows)]
    fn file_identity_and_cluster_probe_work() {
        // 用本仓库 Cargo.toml 当样本：真实 Win32 路径验证句柄查询与簇大小
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        let id = file_identity(&p).expect("FILE_READ_ATTRIBUTES 句柄打开失败");
        assert!(id.alloc > 0, "AllocationSize 应 > 0");
        assert!(id.links >= 1);
        assert!(id.id.0 != 0, "卷序列号非零");
        // 同一文件二次查询身份与占用一致
        let id2 = file_identity(&p).unwrap();
        assert_eq!(id.id, id2.id);
        assert_eq!(id.alloc, id2.alloc);
        let c = cluster_for("C:\\");
        assert!(c > 0 && (c & (c - 1)) == 0, "簇大小应为 2 的幂，实际 {}", c);
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
        assert_eq!(fmt_bytes(2 * 1073741824), "2.00 GB");
        assert_eq!(fmt_bytes(2 * 1048576), "2.0 MB");
    }

    fn dstate(path: &str, parent: Option<Arc<DState>>) -> Arc<DState> {
        Arc::new(DState {
            path: path.into(),
            parent_path: String::new(),
            name: String::new(),
            depth: 48,
            remaining: AtomicUsize::new(0),
            size: Mutex::new(0),
            alloc: Mutex::new(0),
            denied: AtomicBool::new(false),
            iter_done: AtomicBool::new(false),
            parent,
        })
    }

    #[test]
    fn settle_propagates_totals_up_the_chain() {
        let sizes: Mutex<HashMap<String, (u64, u64)>> = Mutex::new(HashMap::new());
        let root = dstate("C:\\r", None);
        let child = dstate("C:\\r\\c", Some(root.clone()));
        // 父目录有一个未完成的子目录任务
        root.remaining.store(1, Ordering::Relaxed);
        // 子目录完成（体积 100）→ 上缴父目录；但父目录还没读完目录项 → 不级联
        let r = settle(&child, 100, 110, &sizes);
        assert!(r.is_none(), "父目录 iter_done=false 不应级联");
        assert_eq!(*root.size.lock().unwrap(), 100);
        assert_eq!(*root.alloc.lock().unwrap(), 110);
        assert_eq!(root.remaining.load(Ordering::Relaxed), 0);
        assert_eq!(sizes.lock().unwrap().get("c:\\r\\c"), Some(&(100, 110)));
        // 父目录自己读完（自带 5 字节文件，总计 105）→ 级联条件满足但自身是根 → 返回 None
        root.iter_done.store(true, Ordering::Relaxed);
        let r = settle(&root, 105, 115, &sizes);
        assert!(r.is_none(), "根目录没有父级");
        assert_eq!(sizes.lock().unwrap().get("c:\\r"), Some(&(105, 115)));
    }

    #[test]
    fn settle_cascades_when_parent_ready() {
        let sizes: Mutex<HashMap<String, (u64, u64)>> = Mutex::new(HashMap::new());
        let root = dstate("C:\\p", None);
        let mid = dstate("C:\\p\\m", Some(root.clone()));
        let leaf = dstate("C:\\p\\m\\l", Some(mid.clone()));
        mid.remaining.store(1, Ordering::Relaxed);
        mid.iter_done.store(true, Ordering::Relaxed);
        // 叶子完成 → mid 减到 0 且已读完 → 级联返回 mid（总价 7 = 自身 0 + 叶子 7）
        let r = settle(&leaf, 7, 8, &sizes);
        assert_eq!(
            r.map(|(s, t, a)| (s.path.clone(), t, a)),
            Some(("C:\\p\\m".into(), 7, 8))
        );
        // mid 再完成 → 上缴 root；root 未读完 → None
        let r = settle(&mid, 7, 8, &sizes);
        assert!(r.is_none());
        assert_eq!(*root.size.lock().unwrap(), 7);
        assert_eq!(*root.alloc.lock().unwrap(), 8);
        assert_eq!(mid.remaining.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn diag_rotate_detects_abnormal_prev_session() {
        let dir = std::env::temp_dir().join(format!("dl-diag-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // 第一次启动：无 previous → 正常
        assert!(!diag_rotate_dir(&dir));
        // 上一会话没有正常退出标记 → 异常
        diag_append_file(&dir.join("current.log"), "[UTC x] [info] working");
        assert!(diag_rotate_dir(&dir), "无退出标记应判异常");
        assert!(dir.join("prev-1.log").exists());
        assert!(!dir.join("current.log").exists());
        // 再轮换一次（上一份有标记）→ 正常
        diag_append_file(&dir.join("current.log"), "[UTC x] [info] x");
        diag_append_file(&dir.join("current.log"), LOG_EXIT_MARKER);
        assert!(!diag_rotate_dir(&dir), "有退出标记应判正常");
        // 轮换链最多保留 3 份 prev
        for i in 0..5 {
            diag_append_file(&dir.join("current.log"), &format!("session {}", i));
            diag_rotate_dir(&dir);
        }
        assert!(dir.join("prev-1.log").exists());
        assert!(dir.join("prev-2.log").exists());
        assert!(dir.join("prev-3.log").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn diag_tail_truncates_from_head() {
        let dir = std::env::temp_dir().join(format!("dl-diag-tail-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        let f = dir.join("current.log");
        diag_append_file(&f, "line1");           // 6 字符（含 \n）
        diag_append_file(&f, "line2-longer");    // 13 字符（含 \n），合计 19
        let tail = diag_tail(&f, 13).unwrap();
        assert!(tail.contains("line2-longer"), "尾部应保留最后内容");
        let tail_all = diag_tail(&f, 9999).unwrap();
        assert!(tail_all.contains("line1"), "小于上限时全量返回");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn utc_stamp_shape() {
        let s = utc_stamp();
        // YYYY-MM-DD HH:MM:SS
        assert_eq!(s.len(), 19);
        assert_eq!(s.as_bytes()[4], b'-');
        assert_eq!(s.as_bytes()[10], b' ');
    }
}
