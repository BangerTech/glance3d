mod bambu;
mod discovery;
mod ws;

use tauri::{AppHandle, Manager, RunEvent};

/// Fully quit Glance3D (bypasses the ExitRequested keep-alive used while
/// printer windows are merely hidden for "only while printing").
#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init());

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ));

    builder
        .setup(|app| {
            app.manage(ws::init());
            app.manage(bambu::init());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ws::ws_connect,
            ws::ws_send,
            ws::ws_disconnect,
            bambu::bambu_connect,
            bambu::bambu_send,
            bambu::bambu_disconnect,
            discovery::discovery_scan,
            quit_app
        ])
        // Keep the process alive when printer windows are closed/hidden so
        // "only while printing" can show them again. Programmatic quit_app()
        // still exits (ExitRequested carries an exit code).
        .build(tauri::generate_context!())
        .expect("error while building Glance3D")
        .run(|_app, event| {
            if let RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
