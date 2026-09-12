use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::Manager;

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

/// Shared state for the supervised dsh process.
struct AppState {
    child: Mutex<Option<Child>>,
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Second instance: focus the existing window.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(AppState {
            child: Mutex::new(None),
        })
        .setup(setup)
        .on_menu_event(on_menu_event)
        .on_window_event(|window, event| {
            // Resident mode: closing the window hides it instead of exiting.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();

    // --- Tray icon --------------------------------------------------------
    let show_item = MenuItemBuilder::with_id("show", "Show").build(app)?;
    let restart_item = MenuItemBuilder::with_id("restart", "Restart dsh").build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&show_item)
        .item(&restart_item)
        .separator()
        .item(&quit_item)
        .build()?;

    let _tray = TrayIconBuilder::new()
        .icon(app.default_window_icon().cloned().unwrap())
        .tooltip("DeepSeek Harness Desktop")
        .menu(&menu)
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click { .. } = event {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    // --- Spawn dsh --------------------------------------------------------
    // The dsh boot is the long pole; start it immediately so the multi-second
    // plugin-tree boot runs while Tauri finishes its own initialisation.
    let setup_handle = handle.clone();
    std::thread::spawn(move || {
        match spawn_dsh(&setup_handle) {
            Ok(url) => {
                boot_log("server ready, navigating");
                if let Some(window) = setup_handle.get_webview_window("main") {
                    if let Ok(parsed) = url::Url::parse(&url) {
                        let _ = window.navigate(parsed);
                    }
                }
            }
            Err(e) => {
                boot_log(&format!("dsh failed: {e}"));
                if let Some(window) = setup_handle.get_webview_window("main") {
                    let escaped = serde_json::to_string(&e.to_string()).unwrap_or_default();
                    let _ = window.eval(&format!(
                        "document.getElementById('message').textContent = {escaped}"
                    ));
                    let _ = window.eval("document.getElementById('restart').hidden = false");
                }
            }
        }
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// Menu events
// ---------------------------------------------------------------------------

fn on_menu_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    match event.id().as_ref() {
        "show" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        "restart" => {
            let handle = app.clone();
            std::thread::spawn(move || {
                // Kill the current child if any.
                {
                    let state = handle.state::<AppState>();
                    let mut guard = state.child.lock().unwrap();
                    if let Some(ref mut child) = *guard {
                        kill_process_tree(child.id());
                    }
                    *guard = None;
                }
                boot_log("restarting dsh");
                match spawn_dsh(&handle) {
                    Ok(url) => {
                        boot_log("server ready after restart, navigating");
                        if let Some(window) = handle.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                            if let Ok(parsed) = url::Url::parse(&url) {
                                let _ = window.navigate(parsed);
                            }
                        }
                    }
                    Err(e) => {
                        boot_log(&format!("dsh restart failed: {e}"));
                        if let Some(window) = handle.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                            let escaped =
                                serde_json::to_string(&e.to_string()).unwrap_or_default();
                            let _ = window.eval(&format!(
                                "document.getElementById('message').textContent = {escaped}"
                            ));
                        }
                    }
                }
            });
        }
        "quit" => {
            // Kill the supervised dsh tree, then exit.
            let state = app.state::<AppState>();
            let mut guard = state.child.lock().unwrap();
            if let Some(ref mut child) = *guard {
                kill_process_tree(child.id());
            }
            *guard = None;
            app.exit(0);
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// dsh supervision
// ---------------------------------------------------------------------------

/// The readiness line prefix that `dsh web` prints once the server can serve.
const LAUNCH_LINE_PREFIX: &str = "dsh web: ";
/// Upper bound on dsh boot.
const READY_TIMEOUT_MS: u64 = 180_000;

/// Pick the profile to boot: explicit `DSH_DESKTOP_PROFILE` wins, then the
/// `desktop` profile when it exists in the Harness home, then the shipped `web`.
fn resolve_profile() -> String {
    if let Ok(override_val) = std::env::var("DSH_DESKTOP_PROFILE") {
        if !override_val.is_empty() {
            return override_val;
        }
    }
    let home = std::env::var("DSH_HOME").unwrap_or_else(|_| {
        dirs_or_home().join(".dsh").to_string_lossy().into_owned()
    });
    let desktop_profile = std::path::PathBuf::from(&home).join("profiles").join("desktop");
    if desktop_profile.exists() {
        "desktop".to_string()
    } else {
        "web".to_string()
    }
}

fn dirs_or_home() -> std::path::PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
}

/// Resolve the dsh runtime for dev mode (node + built checkout CLI).
/// Packaged mode will use a bundled Node runtime — not yet implemented.
///
/// In dev mode the cargo process runs from `src-tauri/`, so we walk up three
/// levels to reach the repository root (`apps/desktop/src-tauri` → `apps/desktop`
/// → `apps` → root).
fn resolve_dsh_runtime() -> Result<(String, Vec<String>, std::path::PathBuf), String> {
    let repo_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent().unwrap()  // apps/desktop
        .parent().unwrap()  // apps
        .parent().unwrap()  // repo root
        .to_path_buf();
    let cli_entry = repo_root.join("apps").join("cli").join("lib").join("bin.js");
    if !cli_entry.exists() {
        return Err(format!(
            "the built dsh CLI is missing at {}; run \"pnpm run build\" in the checkout first.",
            cli_entry.display()
        ));
    }
    let base_args = vec![
        cli_entry.to_string_lossy().into_owned(),
        "--profile".into(),
        resolve_profile(),
        "--no-open".into(),
        "--port".into(),
        "0".into(),
    ];
    Ok(("node".into(), base_args, repo_root))
}

/// Spawn `dsh web` as a supervised child and wait for its readiness line.
/// Returns the authenticated URL once the server announces it.
fn spawn_dsh(app: &tauri::AppHandle) -> Result<String, Box<dyn std::error::Error>> {
    let (command, base_args, cwd) = resolve_dsh_runtime()?;

    boot_log("spawning dsh");
    let mut child = Command::new(&command)
        .args(&base_args)
        .current_dir(&cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn dsh: {e}"))?;

    let stdout = child.stdout.take().ok_or("missing stdout")?;

    // Store the child for later cleanup.
    {
        let state = app.state::<AppState>();
        *state.child.lock().unwrap() = Some(child);
    }

    // Read stdout line by line, with a timeout.
    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    boot_log(&line);
                    if let Some(url) = parse_launch_line(&line) {
                        let _ = tx.send(Ok(url));
                        return;
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(format!("stdout read error: {e}")));
                    return;
                }
            }
        }
        let _ = tx.send(Err("dsh exited before readiness".into()));
    });

    match rx.recv_timeout(std::time::Duration::from_millis(READY_TIMEOUT_MS)) {
        Ok(Ok(url)) => Ok(url),
        Ok(Err(e)) => Err(e.into()),
        Err(_) => Err(format!("dsh did not report readiness within {READY_TIMEOUT_MS}ms").into()),
    }
}

/// Parse one `dsh web` stdout line into the authenticated URL.
/// Only the announce line carries `?token=…`; other `dsh web:` lines are not
/// the readiness signal.
fn parse_launch_line(line: &str) -> Option<String> {
    let rest = line.strip_prefix(LAUNCH_LINE_PREFIX)?;
    let first_token = rest.trim().split_whitespace().next()?;
    if first_token.is_empty() {
        return None;
    }
    let url = url::Url::parse(first_token).ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    if !url.query_pairs().any(|(k, _)| k == "token") {
        return None;
    }
    Some(url.to_string())
}

// ---------------------------------------------------------------------------
// Process tree kill
// ---------------------------------------------------------------------------

/// Kill the whole dsh process tree. On Windows this is `taskkill /T /F`; on
/// POSIX we signal the detached child's process group.
fn kill_process_tree(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("taskkill")
            .args(["/pid", &pid.to_string(), "/T", "/F"])
            .output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        // The child was spawned detached, so it leads its own process group.
        // Signal the whole group (negative pid).
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

use std::sync::OnceLock;

static BOOT_T0: OnceLock<std::time::Instant> = OnceLock::new();

fn boot_log(stage: &str) {
    let t0 = BOOT_T0.get_or_init(std::time::Instant::now);
    let elapsed = t0.elapsed().as_secs_f64();
    eprintln!("[desktop] {stage} at {elapsed:.1}s");
}
