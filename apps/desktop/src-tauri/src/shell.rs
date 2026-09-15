//! Window, tray, and boot orchestration of the desktop shell.

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
/// Loading-page fragment carrying the failure text of an exited server.
const MESSAGE_FRAGMENT: &str = "message=";
/// Window title, also the initial document title the loading page replaces.
const WINDOW_TITLE: &str = "DeepSeek Harness Desktop";
/// Initial window size, matching the replaced Electron shell.
const WINDOW_SIZE: (f64, f64) = (1400.0, 900.0);
/// Renderer transport the shell installs before the application document runs.
const TRANSPORT_SCRIPT: &str = include_str!("../transport/desktop-transport.js");

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

/// Stop whatever serves the GUI.
fn stop_application(app: &AppHandle) {
    if let Some(client) = app.state::<HostState>().take() {
        client.stop();
    }
    supervisor::stop(app);
}

/// Stop the current application and start a fresh one.
pub fn restart(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        supervisor::boot_log("restarting dsh");
        stop_application(&handle);
        boot(&handle);
    });
}

/// Stop the application and end the shell.
pub fn quit(app: &AppHandle) {
    if app.state::<AppState>().begin_shutdown() {
        stop_application(app);
    }
    app.exit(0);
}

/// Restart the application from the loading page.
#[tauri::command]
pub fn restart_dsh(app: AppHandle) {
    restart(&app);
}

/// The tray menu's Show / Restart dsh / Quit surface.
fn build_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show_item = MenuItemBuilder::with_id("show", "Show").build(app)?;
    let restart_item = MenuItemBuilder::with_id("restart", "Restart dsh").build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&show_item)
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
