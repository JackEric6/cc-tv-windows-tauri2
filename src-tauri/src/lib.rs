use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder};

const CZ4K_WEBVIEW_DEADLINE_MS: u64 = 30_000;
const WEBVIEW2_AUTOPLAY_ARGUMENT: &str = "--autoplay-policy=no-user-gesture-required";

fn allow_webview_media_autoplay() {
    let current = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
    if current
        .split_whitespace()
        .any(|argument| argument == WEBVIEW2_AUTOPLAY_ARGUMENT)
    {
        return;
    }

    let arguments = if current.trim().is_empty() {
        WEBVIEW2_AUTOPLAY_ARGUMENT.to_string()
    } else {
        format!("{} {}", current.trim(), WEBVIEW2_AUTOPLAY_ARGUMENT)
    };
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", arguments);
}

struct BackendProcess {
    base_url: String,
    token: String,
    data_dir: PathBuf,
    child: Mutex<Child>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendInfo {
    base_url: String,
    token: String,
}

#[derive(Deserialize)]
struct SidecarMessage {
    #[serde(rename = "type")]
    kind: String,
    name: Option<String>,
    payload: Option<Value>,
}

#[tauri::command]
fn backend_info(backend: State<'_, BackendProcess>) -> BackendInfo {
    BackendInfo {
        base_url: backend.base_url.clone(),
        token: backend.token.clone(),
    }
}

#[tauri::command]
fn start_cz4k_webview(
    app: AppHandle,
    backend: State<'_, BackendProcess>,
    request_id: String,
    url: String,
    referrer: String,
) -> Result<(), String> {
    if uuid::Uuid::parse_str(&request_id).is_err() {
        return Err("无效的厂长 WebView 请求编号".into());
    }
    let target = url.parse::<url::Url>().map_err(|error| error.to_string())?;
    let origin = referrer.parse::<url::Url>().map_err(|error| error.to_string())?;
    let allowed_host = |host: Option<&str>| matches!(host, Some("cz4k.com" | "www.cz4k.com"));
    if target.scheme() != "https" || !allowed_host(target.host_str()) || !allowed_host(origin.host_str()) {
        return Err("厂长 WebView 只允许访问 cz4k.com 的 HTTPS 页面".into());
    }

    let label = format!("cz4k-{request_id}");
    if app.get_webview_window(&label).is_some() {
        return Ok(());
    }
    let endpoint = format!("{}/webview-result", backend.base_url);
    let script = format!(
        r#"(() => {{
          const requestId = {request_id:?};
          const target = {url:?};
          const endpoint = {endpoint:?};
          const key = `__cctv_target_${{requestId}}`;
          try {{
            if (!sessionStorage.getItem(key)) {{
              sessionStorage.setItem(key, '1');
              const navigate = () => {{ if (location.href !== target) location.replace(target); }};
              if (document.readyState === 'complete') navigate();
              else addEventListener('load', navigate, {{ once: true }});
              return;
            }}
          }} catch {{}}
          let sent = false;
          const post = async (result, error) => {{
            if (sent) return;
            sent = true;
            try {{
              await fetch(endpoint, {{
                method: 'POST',
                headers: {{ 'Content-Type': 'application/json' }},
                body: JSON.stringify({{ requestId, result, error }})
              }});
            }} catch {{ sent = false; }}
          }};
          const deadline = Date.now() + {timeout_ms};
          let safeSince = 0;
          const check = async () => {{
            if (sent) return;
            const html = document.documentElement?.outerHTML || '';
            const title = document.title || '';
            const text = document.body?.innerText || '';
            const challenge = Boolean(document.querySelector('cap-widget'));
            const validationText = `${{title}} ${{text}}`;
            const blocked = /雷池|safeline|安全检查|访问验证|请稍候|正在验证|验证中|验证失败|checking your browser|verifying you are human|access denied|人机验证/i.test(validationText);
            if (html.length > 1000 && !challenge && !blocked) {{
              if (!safeSince) safeSince = Date.now();
              const resourceUrls = performance.getEntriesByType('resource').map((entry) => entry.name);
              if (new URL(target).pathname.startsWith('/v_play/')) {{
              const hasMedia = resourceUrls.some((value) => /\.(?:m3u8|mp4|mpd)(?:$|[?#])/i.test(value));
                if (!hasMedia && Date.now() - safeSince < 8000) {{
                  setTimeout(check, 350);
                  return;
                }}
              }}
              await post({{ html, resourceUrls, cookies: document.cookie }});
              return;
            }}
            if (Date.now() >= deadline) {{
              await post(undefined, '厂长 SafeLine 验证仍未通过');
              return;
            }}
            setTimeout(check, 500);
          }};
          addEventListener('load', () => setTimeout(check, 1500), {{ once: true }});
          setTimeout(check, {timeout_ms});
        }})();"#,
        request_id = request_id,
        url = url,
        endpoint = endpoint,
        timeout_ms = CZ4K_WEBVIEW_DEADLINE_MS
    );

    WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(origin))
        .title("厂长影视")
        .visible(false)
        .initialization_script(&script)
        .build()
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn close_cz4k_webview(app: AppHandle, request_id: String) -> Result<(), String> {
    if uuid::Uuid::parse_str(&request_id).is_err() {
        return Err("无效的厂长 WebView 请求编号".into());
    }
    if let Some(window) = app.get_webview_window(&format!("cz4k-{request_id}")) {
        window.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn project_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri must be inside the project")
        .to_path_buf()
}

fn app_data_directory(app: &AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let executable_dir = std::env::current_exe()?
        .parent()
        .ok_or("application executable has no parent directory")?
        .to_path_buf();
    let preferred = if cfg!(debug_assertions) {
        project_root().join("data")
    } else {
        executable_dir.join("data")
    };
    if !cfg!(debug_assertions) && !has_data(&preferred) {
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            let legacy = PathBuf::from(local_app_data)
                .join("Programs")
                .join("丛丛影视")
                .join("data");
            if has_data(&legacy) && fs::create_dir_all(&legacy).is_ok() {
                return Ok(legacy);
            }
        }
    }
    if fs::create_dir_all(&preferred).is_ok() {
        return Ok(preferred);
    }

    let fallback = app.path().app_data_dir()?;
    fs::create_dir_all(&fallback)?;
    Ok(fallback)
}

fn has_data(path: &Path) -> bool {
    fs::read_dir(path)
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false)
}

fn resource_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf), Box<dyn std::error::Error>> {
    if cfg!(debug_assertions) {
        let root = project_root();
        return Ok((
            root.join("src-tauri/resources/node.exe"),
            root.join("dist/backend.cjs"),
        ));
    }
    let resources = app.path().resource_dir()?;
    Ok((resources.join("node.exe"), resources.join("backend.cjs")))
}

fn node_compatible_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::{OsStrExt, OsStringExt};

        let path: Vec<u16> = path.as_os_str().encode_wide().collect();
        let verbatim_prefix: Vec<u16> = r"\\?\".encode_utf16().collect();
        if let Some(remainder) = path.as_slice().strip_prefix(verbatim_prefix.as_slice()) {
            let unc_prefix: Vec<u16> = "UNC\\".encode_utf16().collect();
            if let Some(unc_path) = remainder.strip_prefix(unc_prefix.as_slice()) {
                let mut compatible: Vec<u16> = r"\\".encode_utf16().collect();
                compatible.extend_from_slice(unc_path);
                return PathBuf::from(std::ffi::OsString::from_wide(&compatible));
            }
            return PathBuf::from(std::ffi::OsString::from_wide(remainder));
        }
    }

    path.to_path_buf()
}

fn start_backend(app: &AppHandle) -> Result<BackendProcess, Box<dyn std::error::Error>> {
    let (node_path, backend_path) = resource_paths(app)?;
    if !node_path.is_file() || !backend_path.is_file() {
        return Err(format!(
            "Tauri sidecar resources are missing: {} or {}",
            node_path.display(),
            backend_path.display()
        )
        .into());
    }

    let data_dir = app_data_directory(app)?;
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    drop(listener);
    let token = uuid::Uuid::new_v4().simple().to_string();
    let mut command = Command::new(node_path);
    command
        .arg(node_compatible_path(&backend_path))
        .arg("--port")
        .arg(port.to_string())
        .arg("--token")
        .arg(&token)
        .env("CCTV_DATA_DIR", node_compatible_path(&data_dir))
        .env("CCTV_APP_VERSION", env!("CARGO_PKG_VERSION"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn()?;

    let stdout = child.stdout.take().ok_or("failed to capture sidecar output")?;
    let (ready_tx, ready_rx) = mpsc::channel();
    let app_handle = app.clone();
    thread::spawn(move || {
        let mut ready_tx = Some(ready_tx);
        for line in BufReader::new(stdout).lines().flatten() {
            let Ok(message) = serde_json::from_str::<SidecarMessage>(&line) else {
                continue;
            };
            match message.kind.as_str() {
                "ready" => {
                    if let Some(sender) = ready_tx.take() {
                        let _ = sender.send(());
                    }
                }
                "event" => {
                    if let (Some(name), Some(payload)) = (message.name, message.payload) {
                        let _ = app_handle.emit("backend-event", serde_json::json!({
                            "name": name,
                            "payload": payload
                        }));
                    }
                }
                _ => {}
            }
        }
    });

    match ready_rx.recv_timeout(Duration::from_secs(90)) {
        Ok(()) => {}
        Err(mpsc::RecvTimeoutError::Timeout) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Node sidecar did not become ready within 90 seconds".into());
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            let status = child.try_wait()?;
            if status.is_none() {
                let _ = child.kill();
                let _ = child.wait();
            }
            return Err(format!("Node sidecar exited before becoming ready: {status:?}").into());
        }
    }

    Ok(BackendProcess {
        base_url: format!("http://127.0.0.1:{port}"),
        token,
        data_dir,
        child: Mutex::new(child),
    })
}

fn saved_window_size(data_dir: &Path) -> Option<(f64, f64)> {
    let settings = fs::read_to_string(data_dir.join("settings.json")).ok()?;
    let settings: Value = serde_json::from_str(&settings).ok()?;
    let window = settings.get("window")?;
    let width = window.get("width")?.as_f64()?;
    let height = window.get("height")?.as_f64()?;
    if !(1100.0..=4096.0).contains(&width) || !(700.0..=4096.0).contains(&height) {
        return None;
    }
    Some((width, height))
}

pub fn run() {
    allow_webview_media_autoplay();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![backend_info, start_cz4k_webview, close_cz4k_webview])
        .setup(|app| {
            let backend = start_backend(app.handle())?;
            if let Some((width, height)) = saved_window_size(&backend.data_dir) {
                if let Some(window) = app.get_webview_window("main") {
                    window.set_size(tauri::LogicalSize::new(width, height))?;
                    window.center()?;
                }
            }
            app.manage(backend);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Tauri application");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::Exit) {
            if let Some(backend) = app_handle.try_state::<BackendProcess>() {
                if let Ok(mut child) = backend.child.lock() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
    });
}
