//! Window, tray, and boot orchestration of the desktop shell.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::backend;
use crate::host::bridge::HostState;
use crate::host::client::HostClient;
use crate::supervisor::{self, AppState, HostLaunch};

/// The window label the shell owns.
pub const MAIN_WINDOW: &str = "main";
/// The window label of the desktop plugin manager.
pub const PLUGIN_WINDOW: &str = "plugins";
/// Loading-page fragment carrying the failure text of an exited server.
const MESSAGE_FRAGMENT: &str = "message=";
/// Window title, also the initial document title the loading page replaces.
const WINDOW_TITLE: &str = "DeepSeek Harness Desktop";
/// Plugin window title, matching the replaced Electron shell.
const PLUGIN_WINDOW_TITLE: &str = "DeepSeek Harness — Desktop Plugins";
/// Initial window size, matching the replaced Electron shell.
const WINDOW_SIZE: (f64, f64) = (1400.0, 900.0);
/// Plugin window size, matching the replaced Electron shell.
const PLUGIN_WINDOW_SIZE: (f64, f64) = (900.0, 620.0);
/// Renderer transport the shell installs before the application document runs.
const TRANSPORT_SCRIPT: &str = include_str!("../transport/desktop-transport.js");
/// Desktop API the shell's own and the Host's pages read through `window.dsh`.
const SHELL_API_SCRIPT: &str = include_str!("../shell-api.js");

/// Build the window and tray, record the loading page, and start the application.
pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let window = tauri::WebviewWindowBuilder::new(
        app,
        MAIN_WINDOW,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title(WINDOW_TITLE)
    .inner_size(WINDOW_SIZE.0, WINDOW_SIZE.1)
    // The transport is installed here rather than by the Host, whose own
    // injection targets a shell that can stream a protocol response.
    .initialization_script(TRANSPORT_SCRIPT)
    .initialization_script(SHELL_API_SCRIPT)
    .build()?;
    if let Ok(url) = window.url() {
        handle.state::<AppState>().set_initial_url(url);
    }
    build_tray(app)?;
    // The dsh boot is the long pole; start it immediately so the plugin-tree
    // boot runs while Tauri finishes its own initialisation.
    std::thread::spawn(move || boot(&handle));
    Ok(())
}

/// Bring the main window back to the foreground.
pub fn focus(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Show the loading page with the failure text of an exited or failed application.
///
/// The text rides the fragment, so the page renders it on load and on a
/// same-document fragment change without a post-navigation script handshake.
pub fn report_failure(app: &AppHandle, message: &str) {
    supervisor::boot_log(&format!("dsh unavailable: {message}"));
    backend::publish_error(app, message);
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let Some(mut url) = app.state::<AppState>().initial_url() else {
        return;
    };
    url.set_fragment(Some(&format!("{MESSAGE_FRAGMENT}{message}")));
    let _ = window.show();
    let _ = window.navigate(url);
}

/// Start the application: the packaged Host when the application carries one,
/// otherwise the supervised `dsh --profile desktop` CLI.
fn boot(app: &AppHandle) {
    backend::publish_starting(app);
    match supervisor::host_launch(app) {
        Some(launch) => boot_host(app, launch),
        None => boot_supervised(app),
    }
}

/// Serve the harness web GUI from the packaged Host over the private carrier.
fn boot_host(app: &AppHandle, launch: HostLaunch) {
    supervisor::boot_log("starting the packaged desktop Host");
    supervisor::boot_log(&format!(
        "launch: node={} core={} runtime={} profile={}",
        launch.node.display(),
        launch.entry.display(),
        launch.runtime_dir.display(),
        launch.project_dir.display(),
    ));
    let environment = supervisor::host_environment();
    let failed = app.clone();
    let client = HostClient::start(
        &launch.node.to_string_lossy(),
        &launch.entry,
        &launch.runtime_dir,
        &launch.project_dir,
        launch.allow_linked,
        environment,
        move |message| report_failure(&failed, &message),
    );
    match client {
        Ok(client) => {
            supervisor::boot_log(&format!("host ready: dsh {}", client.dsh_version));
            app.state::<HostState>().install(Arc::new(client));
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                match application_url() {
                    Ok(url) => {
                        backend::publish_ready(app);
                        let _ = window.navigate(url);
                    }
                    Err(error) => report_failure(app, &error),
                }
            }
        }
        Err(error) => report_failure(app, &error),
    }
}

/// Supervise the `dsh` CLI and load the authenticated URL it announces.
fn boot_supervised(app: &AppHandle) {
    match supervisor::start(app) {
        Ok(url) => {
            supervisor::boot_log("server ready, navigating");
            let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
                return;
            };
            match url::Url::parse(&url) {
                Ok(parsed) => {
                    backend::publish_ready(app);
                    let _ = window.navigate(parsed);
                }
                Err(error) => report_failure(app, &format!("dsh announced an unusable URL: {error}")),
            }
        }
        Err(error) => report_failure(app, &error),
    }
}

/// The application page the Host serves through the `dsh-app` protocol.
///
/// Windows and Android serve custom protocols as `http://<scheme>.localhost`.
fn application_url() -> Result<url::Url, String> {
    let text = if cfg!(any(windows, target_os = "android")) {
        "http://dsh-app.localhost/index.html"
    } else {
        "dsh-app://localhost/index.html"
    };
    url::Url::parse(text).map_err(|error| format!("the shell cannot address its application page: {error}"))
}

/// Stop whatever serves the GUI, so profile files are free for a transaction.
pub fn stop_backend(app: &AppHandle) {
    if let Some(client) = app.state::<HostState>().take() {
        client.stop();
    }
    supervisor::stop(app);
}

/// Serializes restarts, so two recovery actions cannot interleave stopping and
/// booting the backend the way the replaced Electron controller serialized its
/// attempts.
static RESTARTING: AtomicBool = AtomicBool::new(false);

/// Stop the current application and start a fresh one.
pub fn restart(app: &AppHandle) {
    if RESTARTING.swap(true, Ordering::SeqCst) {
        supervisor::boot_log("restart already in progress");
        return;
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        supervisor::boot_log("restarting dsh");
        stop_backend(&handle);
        boot(&handle);
        RESTARTING.store(false, Ordering::SeqCst);
    });
}

/// Stop the application and end the shell.
pub fn quit(app: &AppHandle) {
    if app.state::<AppState>().begin_shutdown() {
        stop_backend(app);
    }
    app.exit(0);
}

/// Restart the application from the loading page.
#[tauri::command]
pub fn restart_dsh(app: AppHandle) {
    restart(&app);
}

/// Relaunch the whole application, as the startup page's restart action.
#[tauri::command]
pub fn application_restart(app: AppHandle) {
    stop_backend(&app);
    app.restart()
}

/// Open the desktop plugin window, or focus the one that is already open.
///
/// The window loads a shell-owned page, so it carries the same shell API the
/// loading page reads and never the Host-served application document.
/// @returns the transport failure, when the window cannot be created.
#[tauri::command]
pub fn open_plugin_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(PLUGIN_WINDOW) {
        let _ = window.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(
        &app,
        PLUGIN_WINDOW,
        tauri::WebviewUrl::App("plugin-manager.html".into()),
    )
    .title(PLUGIN_WINDOW_TITLE)
    .inner_size(PLUGIN_WINDOW_SIZE.0, PLUGIN_WINDOW_SIZE.1)
    .initialization_script(SHELL_API_SCRIPT)
    .build()
    .map_err(|error| format!("desktop shell: cannot open the plugin window: {error}"))?;
    Ok(())
}

/// The tray menu's Show / Restart dsh / Quit surface.
fn build_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show_item = MenuItemBuilder::with_id("show", "Show").build(app)?;
    let plugins_item = MenuItemBuilder::with_id("plugins", "Desktop Plugins…").build(app)?;
    let updates_item = MenuItemBuilder::with_id("updates", "Check for Updates…").build(app)?;
    let restart_item = MenuItemBuilder::with_id("restart", "Restart dsh").build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&show_item)
        .item(&plugins_item)
        .item(&updates_item)
        .item(&restart_item)
        .separator()
        .item(&quit_item)
        .build()?;
    TrayIconBuilder::new()
        .icon(app.default_window_icon().cloned().unwrap())
        .tooltip("DeepSeek Harness Desktop")
        .menu(&menu)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { .. } = event {
                focus(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// Dispatch the tray menu.
pub fn on_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match event.id().as_ref() {
        "show" => focus(app),
        "plugins" => {
            if let Err(error) = open_plugin_window(app.clone()) {
                supervisor::boot_log(&error);
            }
        }
        "updates" => crate::update::check_and_prompt(app.clone()),
        "restart" => restart(app),
        "quit" => quit(app),
        _ => {}
    }
}

/// Resident mode: closing the window hides it instead of ending the session.
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = window.hide();
    }
}
