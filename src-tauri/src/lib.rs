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
    let min_big: u64 = 10 * 1024 * 1024; // ≥10MB 的文件作为独立子项推给前端

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
                    if len >= min_big && big_file_count < 200 {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(ScanState::default())
        .invoke_handler(tauri::generate_handler![
            scan_start,
            scan_stop,
            scan_status,
            open_in_explorer
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
