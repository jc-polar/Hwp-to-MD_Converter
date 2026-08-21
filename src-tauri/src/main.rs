#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::{command, Emitter, Manager};

#[command]
async fn read_file_binary(path: String) -> Result<Vec<u8>, String> {
    fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))
}

fn bytes_to_base64(data: &[u8]) -> String {
    const CHARSET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity((data.len() + 2) / 3 * 4);
    let mut i = 0;
    while i < data.len() {
        let b0 = data[i] as usize;
        let b1 = if i + 1 < data.len() { data[i + 1] as usize } else { 0 };
        let b2 = if i + 2 < data.len() { data[i + 2] as usize } else { 0 };

        let triple = (b0 << 16) | (b1 << 8) | b2;

        result.push(CHARSET[(triple >> 18) & 0x3F] as char);
        result.push(CHARSET[(triple >> 12) & 0x3F] as char);
        if i + 1 < data.len() {
            result.push(CHARSET[(triple >> 6) & 0x3F] as char);
        } else {
            result.push('=');
        }
        if i + 2 < data.len() {
            result.push(CHARSET[triple & 0x3F] as char);
        } else {
            result.push('=');
        }
        i += 3;
    }
    result
}

#[command]
async fn read_file_base64(path: String) -> Result<String, String> {
    let data = fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;
    Ok(bytes_to_base64(&data))
}

#[command]
fn get_core_dir(app: tauri::AppHandle) -> Result<String, String> {
    let core_dir = if cfg!(debug_assertions) {
        let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
        let a = cwd.join("core");                    // cwd = src-tauri/
        let b = cwd.join("src-tauri").join("core");  // cwd = project root/
        if a.exists() { a } else { b }
    } else {
        app.path().resource_dir().map_err(|e| e.to_string())?.join("core")
    };
    let mut s = core_dir.to_string_lossy().to_string();
    if s.starts_with("\\\\?\\") { s = s[4..].to_string(); }
    Ok(s)
}

#[command]
async fn eval_in_webview(app: tauri::AppHandle, label: String, script: String) -> Result<(), String> {
    let webview = app.get_webview_window(&label).ok_or("Window not found")?;
    webview.eval(&script).map_err(|e| e.to_string())?;
    Ok(())
}

#[command]
async fn get_webview_url(app: tauri::AppHandle, label: String) -> Result<String, String> {
    let webview = app.get_webview_window(&label).ok_or("Window not found")?;
    let url = webview.url().map_err(|e| e.to_string())?;
    Ok(url.to_string())
}

#[command]
async fn get_webview_title(app: tauri::AppHandle, label: String) -> Result<String, String> {
    let webview = app.get_webview_window(&label).ok_or("Window not found")?;
    let title = webview.title().map_err(|e| e.to_string())?;
    Ok(title.to_string())
}

#[command]
async fn hide_webview(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview_window(&label) {
        webview.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[command]
async fn close_webview(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview_window(&label) {
        webview.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[command]
async fn get_clipboard_files() -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-Command", "Get-Clipboard -Format FileDropList"]);
        cmd.creation_flags(0x08000000);
        let output = cmd.output().map_err(|e| e.to_string())?;
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let paths: Vec<String> = stdout
                .lines()
                .map(|line| line.trim().to_string())
                .filter(|line| !line.is_empty())
                .collect();
            return Ok(paths);
        }
    }
    Ok(Vec::new())
}

#[command]
fn save_error_log(app: tauri::AppHandle, content: String) -> Result<String, String> {
    use std::io::Write;
    let exe_dir = std::env::current_exe()
        .map(|p| p.parent().unwrap().to_path_buf())
        .unwrap_or_else(|_| std::env::current_dir().unwrap());
    
    let log_path = exe_dir.join("upload_error_log.txt");
    
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| e.to_string())?;
        
    writeln!(file, "{}\n----------------------------------------\n", content)
        .map_err(|e| e.to_string())?;
        
    Ok(log_path.to_string_lossy().to_string())
}

fn collect_files(
    dir: &PathBuf, 
    expanded_files: &mut Vec<String>, 
    unsupported_files: &mut Vec<String>, 
    include_sub: bool
) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
                if ["hwp", "hwpx", "pdf", "doc", "docx", "xls", "xlsx", "txt"].contains(&ext.as_str()) {
                    expanded_files.push(path.to_string_lossy().to_string());
                } else {
                    unsupported_files.push(path.to_string_lossy().to_string());
                }
            } else if path.is_dir() && include_sub {
                collect_files(&path, expanded_files, unsupported_files, include_sub);
            }
        }
    }
}

#[command]
async fn preview_folder_files(folder_path: String, include_sub: bool) -> Result<Vec<String>, String> {
    let path = PathBuf::from(&folder_path);
    if !path.exists() || !path.is_dir() {
        return Err("유효한 폴더가 아닙니다.".to_string());
    }
    let mut expanded_files = Vec::new();
    let mut unsupported_files = Vec::new();
    collect_files(&path, &mut expanded_files, &mut unsupported_files, include_sub);
    Ok(expanded_files)
}

#[derive(serde::Deserialize, Clone)]
struct FileRequest {
    path: String,
    #[serde(rename = "rootPath")]
    root_path: String,
}

#[derive(serde::Serialize)]
struct ConversionResult {
    pdf_paths: Vec<String>,
    md_paths: Vec<String>,
}

#[command]
async fn process_dual_documents(
    app: tauri::AppHandle,
    state: tauri::State<'_, std::sync::Mutex<Vec<u32>>>,
    files: Vec<FileRequest>,
    mode: String, // "DUAL", "PDF", "MD"
    optimize: bool,
    local_save: bool,
    include_sub: bool,
    open_folder: bool
) -> Result<ConversionResult, String> {
    let mut expanded_files = Vec::new();
    let mut unsupported_files = Vec::new();

    for req in &files {
        let path = PathBuf::from(&req.path);
        if path.is_dir() {
            let mut temp_expanded = Vec::new();
            let mut temp_unsupp = Vec::new();
            collect_files(&path, &mut temp_expanded, &mut temp_unsupp, include_sub);
            for f in temp_expanded {
                expanded_files.push(FileRequest { path: f, root_path: req.root_path.clone() });
            }
            for f in temp_unsupp {
                unsupported_files.push(FileRequest { path: f, root_path: req.root_path.clone() });
            }
        } else if path.is_file() {
            let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
            if ["hwp", "hwpx", "pdf", "doc", "docx", "xls", "xlsx", "txt"].contains(&ext.as_str()) {
                expanded_files.push(req.clone());
            } else {
                unsupported_files.push(req.clone());
            }
        }
    }

    let mut result_pdf_paths = Vec::new();
    let mut result_md_paths = Vec::new();

    if expanded_files.is_empty() && unsupported_files.is_empty() {
        return Ok(ConversionResult {
            pdf_paths: result_pdf_paths,
            md_paths: result_md_paths,
        });
    }

    // DUAL: "통합_변환", PDF: "PDF_변환", MD: "MD_변환"
    let folder_name = match mode.as_str() {
        "PDF" => "PDF_변환",
        "MD" => "MD_변환",
        _ => "통합_변환",
    };

    let temp_base = std::env::temp_dir().join("hwp_converter_temp");
    if !temp_base.exists() {
        let _ = fs::create_dir_all(&temp_base);
    }

    let output_dir = if local_save && !files.is_empty() {
        let first_req = &files[0];
        let base_dir = if !first_req.root_path.is_empty() {
            PathBuf::from(&first_req.root_path)
        } else {
            let first_path = PathBuf::from(&first_req.path);
            if first_path.is_dir() {
                first_path
            } else {
                first_path.parent().unwrap_or(&first_path).to_path_buf()
            }
        };
        let target = base_dir.join(folder_name);
        if !target.exists() {
            let _ = fs::create_dir_all(&target);
        }
        target
    } else {
        temp_base.clone()
    };

    // 미지원 파일 원본 복사 (로컬 저장 시)
    if local_save {
        for req in &unsupported_files {
            let src = PathBuf::from(&req.path);
            if let Some(name) = src.file_name() {
                let dest = output_dir.join(name);
                let _ = fs::copy(&src, &dest);
            }
        }

        // DUAL 또는 PDF 모드일 때: 입력된 원본 PDF 파일도 결과 폴더에 복사 보존
        if mode == "DUAL" || mode == "PDF" {
            for req in &expanded_files {
                let src = PathBuf::from(&req.path);
                let ext = src.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
                if ext == "pdf" {
                    if let Some(name) = src.file_name() {
                        let dest = output_dir.join(name);
                        if src != dest {
                            let _ = fs::copy(&src, &dest);
                        }
                    }
                }
            }
        }
    }

    let core_dir_str = get_core_dir(app.clone())?;
    let core_dir = PathBuf::from(&core_dir_str);

    let do_pdf = mode == "DUAL" || mode == "PDF";
    let do_md = mode == "DUAL" || mode == "MD";

    let hwp_files: Vec<FileRequest> = expanded_files.iter().filter(|req| {
        let ext = PathBuf::from(&req.path).extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
        ext == "hwp" || ext == "hwpx"
    }).cloned().collect();

    let clean_hwp_dir = temp_base.join("clean_hwp");
    if !clean_hwp_dir.exists() {
        let _ = fs::create_dir_all(&clean_hwp_dir);
    }

    let clean_hwp_map_mutex = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::<String, String>::new()));

    if !hwp_files.is_empty() {
        let pdf_exe = core_dir.join("pdf_worker.exe");
        if pdf_exe.exists() {
            const CONCURRENCY: usize = 3;
            let chunk_size = (hwp_files.len() + CONCURRENCY - 1) / CONCURRENCY;
            let chunks: Vec<Vec<FileRequest>> = hwp_files.chunks(chunk_size).map(|c| c.to_vec()).collect();

            let mut handles = Vec::new();
            let pdf_paths_mutex = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let local_pids_mutex = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));

            for chunk in chunks {
                let pdf_exe_path = pdf_exe.clone();
                let output_dir_clone = output_dir.clone();
                let clean_hwp_dir_clone = clean_hwp_dir.clone();
                let app_clone = app.clone();
                let pdf_paths_clone = pdf_paths_mutex.clone();
                let clean_hwp_map_clone = clean_hwp_map_mutex.clone();
                let local_pids_clone = local_pids_mutex.clone();

                let handle = std::thread::spawn(move || {
                    let mut cmd = Command::new(&pdf_exe_path);
                    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
                    #[cfg(target_os = "windows")]
                    {
                        use std::os::windows::process::CommandExt;
                        cmd.creation_flags(0x08000000);
                    }

                    if let Ok(mut child) = cmd.spawn() {
                        if let Ok(mut pids) = local_pids_clone.lock() {
                            pids.push(child.id());
                        }

                        if let Some(mut stdin) = child.stdin.take() {
                            let stdout = child.stdout.take();
                            
                            let chunk_clone = chunk.clone();
                            let out_dir = output_dir_clone.clone();
                            let clean_dir = clean_hwp_dir_clone.clone();

                            std::thread::spawn(move || {
                                for req in &chunk_clone {
                                    let path = PathBuf::from(&req.path);
                                    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
                                    let _ext = path.extension().and_then(|s| s.to_str()).unwrap_or("hwp");
                                    
                                    let pdf_path = if do_pdf {
                                        out_dir.join(format!("{}.pdf", stem)).to_string_lossy().to_string()
                                    } else {
                                        "".to_string()
                                    };

                                    let clean_hwp_path = clean_dir.join(format!("{}_clean.hwpx", stem)).to_string_lossy().to_string();

                                    let line = format!("{}|{}|{}\n", req.path, pdf_path, clean_hwp_path);
                                    let _ = stdin.write_all(line.as_bytes());
                                    let _ = stdin.flush();
                                }
                                let _ = stdin.write_all(b"EXIT\n");
                                let _ = stdin.flush();
                            });

                            if let Some(stdout) = stdout {
                                let reader = BufReader::new(stdout);
                                for line in reader.lines().flatten() {
                                    if line.starts_with("RESULT|SUCCESS|") {
                                        let parts: Vec<&str> = line.split('|').collect();
                                        if parts.len() >= 3 {
                                            let orig_f = parts[2].trim().to_string();
                                            let pdf_p = if parts.len() >= 4 { parts[3].trim().to_string() } else { "".to_string() };
                                            let clean_hwp_p = if parts.len() >= 5 { parts[4].trim().to_string() } else { "".to_string() };

                                            if !pdf_p.is_empty() && do_pdf {
                                                if let Ok(mut paths) = pdf_paths_clone.lock() {
                                                    paths.push(pdf_p.clone());
                                                }
                                                let _ = app_clone.emit("pdf-converted", pdf_p);
                                            }

                                            if !clean_hwp_p.is_empty() {
                                                if let Ok(mut map) = clean_hwp_map_clone.lock() {
                                                    map.insert(orig_f, clean_hwp_p);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        let _ = child.wait();
                    }
                });
                handles.push(handle);
            }

            for handle in handles {
                let _ = handle.join();
            }

            let pids_lock = local_pids_mutex.lock();
            if let Ok(pids_guard) = pids_lock {
                if let Ok(mut state_pids) = state.lock() {
                    state_pids.extend(pids_guard.iter());
                }
            }

            let paths_lock = pdf_paths_mutex.lock();
            if let Ok(paths_guard) = paths_lock {
                for p in paths_guard.iter() {
                    result_pdf_paths.push(p.clone());
                }
            }
        }
    }

    if do_md {
        let md_target_files: Vec<FileRequest> = expanded_files.iter().filter(|req| {
            let ext = PathBuf::from(&req.path).extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
            ["hwp", "hwpx", "pdf", "doc", "docx", "xls", "xlsx", "txt"].contains(&ext.as_str())
        }).cloned().collect();

        if !md_target_files.is_empty() {
            let clean_map = clean_hwp_map_mutex.lock().unwrap_or_else(|e| e.into_inner());

            let mut tasks = Vec::new();
            for req in &md_target_files {
                let parse_file_path = if let Some(clean_p) = clean_map.get(&req.path) {
                    if PathBuf::from(clean_p).exists() {
                        clean_p.clone()
                    } else {
                        req.path.clone()
                    }
                } else {
                    req.path.clone()
                };

                tasks.push(serde_json::json!({
                    "filePath": parse_file_path,
                    "origFilePath": req.path.clone(),
                    "outputDir": output_dir.to_string_lossy(),
                    "isNotebookLMMode": optimize,
                    "rootPath": req.root_path
                }));
            }

            let task_json_path = temp_base.join("hwp_tasks.json");
            if let Ok(task_json_str) = serde_json::to_string(&tasks) {
                let _ = fs::write(&task_json_path, task_json_str);

                let node_filename = if cfg!(target_os = "windows") { "node.exe" } else { "node" };
                let mut node_path_str = core_dir.join(node_filename).to_string_lossy().to_string();
                let mut script_path_str = core_dir.join("worker_bundle.cjs").to_string_lossy().to_string();
                let mut task_path_str = task_json_path.to_string_lossy().to_string();

                if node_path_str.starts_with("\\\\?\\") { node_path_str = node_path_str[4..].to_string(); }
                if script_path_str.starts_with("\\\\?\\") { script_path_str = script_path_str[4..].to_string(); }
                if task_path_str.starts_with("\\\\?\\") { task_path_str = task_path_str[4..].to_string(); }

                let mut cmd = Command::new(&node_path_str);
                cmd.arg(&script_path_str).arg(&task_path_str)
                   .stdout(Stdio::piped())
                   .stderr(Stdio::piped());

                #[cfg(target_os = "windows")]
                {
                    use std::os::windows::process::CommandExt;
                    cmd.creation_flags(0x08000000);
                }

                if let Ok(mut child) = cmd.spawn() {
                    if let Ok(mut pids) = state.lock() {
                        pids.push(child.id());
                    }

                    let stdout = child.stdout.take();
                    let stderr = child.stderr.take();

                    let stderr_handle = std::thread::spawn(move || {
                        if let Some(stderr) = stderr {
                            let mut s = String::new();
                            let _ = BufReader::new(stderr).read_to_string(&mut s);
                        }
                    });

                    if let Some(stdout) = stdout {
                        let reader = BufReader::new(stdout);
                        for line in reader.lines().flatten() {
                            if line.starts_with("RESULT|SUCCESS|") || line.starts_with("RESULT|COPIED|") {
                                let parts: Vec<&str> = line.split('|').collect();
                                if parts.len() >= 4 {
                                    let md_path = parts[3].trim().to_string();
                                    result_md_paths.push(md_path.clone());
                                    let _ = app.emit("md-converted", md_path);
                                }
                            }
                        }
                    }

                    let _ = child.wait();
                    let _ = stderr_handle.join();
                    let _ = fs::remove_file(&task_json_path);
                }
            }
        }
    }

    if clean_hwp_dir.exists() {
        let _ = fs::remove_dir_all(&clean_hwp_dir);
    }
    if local_save && temp_base.exists() {
        let _ = fs::remove_dir_all(&temp_base);
    }

    if open_folder && local_save && output_dir.exists() {
        #[cfg(target_os = "windows")]
        {
            let _ = Command::new("explorer").arg(&output_dir).spawn();
        }
    }

    Ok(ConversionResult {
        pdf_paths: result_pdf_paths,
        md_paths: result_md_paths,
    })
}

#[command]
async fn cleanup_temp_files() -> Result<(), String> {
    let temp_base = std::env::temp_dir().join("hwp_converter_temp");
    if temp_base.exists() {
        let _ = fs::remove_dir_all(&temp_base);
    }
    Ok(())
}

#[command]
async fn kill_zombie_processes() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let script = "Get-CimInstance Win32_Process -Filter \"(Name='Hwp.exe' OR Name='HwpMac.exe') AND CommandLine LIKE '%Embedding%'\" | Invoke-CimMethod -MethodName Terminate";
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-Command", script]);
        cmd.creation_flags(0x08000000);
        let _ = cmd.output();
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(std::sync::Mutex::new(Vec::<u32>::new()))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    if let Some(state) = window.try_state::<std::sync::Mutex<Vec<u32>>>() {
                        if let Ok(mut pids) = state.lock() {
                            #[cfg(target_os = "windows")]
                            use std::os::windows::process::CommandExt;
                            
                            for pid in pids.drain(..) {
                                let mut cmd = Command::new("taskkill");
                                cmd.args(["/F", "/T", "/PID", &pid.to_string()]);
                                #[cfg(target_os = "windows")]
                                {
                                    cmd.creation_flags(0x08000000);
                                }
                                let _ = cmd.output();
                            }
                            
                            #[cfg(target_os = "windows")]
                            {
                                let script = "Get-CimInstance Win32_Process -Filter \"(Name='Hwp.exe' OR Name='HwpMac.exe') AND CommandLine LIKE '%Embedding%'\" | Invoke-CimMethod -MethodName Terminate";
                                let mut cmd = Command::new("powershell");
                                cmd.args(["-NoProfile", "-Command", script]);
                                cmd.creation_flags(0x08000000);
                                let _ = cmd.output();
                            }
                        }
                    }
                    std::process::exit(0);
                }
            }
        })
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
                if args.len() > 1 {
                    let _ = app.emit("single-instance-args", &args[1..]);
                }
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            read_file_binary,
            read_file_base64, 
            get_core_dir,
            eval_in_webview,
            get_webview_url,
            get_webview_title,
            hide_webview,
            close_webview,
            save_error_log,
            preview_folder_files,
            process_dual_documents,
            cleanup_temp_files,
            kill_zombie_processes,
            get_clipboard_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
