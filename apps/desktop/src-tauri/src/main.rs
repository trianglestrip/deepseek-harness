//! DeepSeek Harness Desktop: a Tauri shell over the dsh application.
//!
//! The shell renders the harness web GUI in the operating system's webview. It
//! serves that GUI from the packaged desktop Host over a private framed carrier
//! when the application carries a bundled runtime, and otherwise supervises
//! `dsh --profile desktop` and loads the authenticated URL the server prints.

mod backend;
mod host;
mod locale;
mod shell;
mod supervisor;



fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            shell::focus(app);
        }))
        .manage(supervisor::AppState::default())
        .manage(backend::BackendStatus::default())
        .manage(host::bridge::HostState::default())
        .invoke_handler(tauri::generate_handler![
            shell::restart_dsh,
            backend::backend_status,
            backend::backend_retry,
            locale::locale_get,
            host::bridge::dsh_request_start,
            host::bridge::dsh_request_body,
            host::bridge::dsh_request_end,
            host::bridge::dsh_request_cancel,
        ])
        .register_asynchronous_uri_scheme_protocol("dsh-app", |context, request, responder| {
            let app = context.app_handle().clone();
            std::thread::spawn(move || {
                responder.respond(host::bridge::buffered_fetch(&app, &request));
            });
        })
        .setup(shell::setup)
        .on_menu_event(shell::on_menu_event)
        .on_window_event(shell::on_window_event)
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
