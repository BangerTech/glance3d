mod ws;

use tauri::Manager;

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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ws::ws_connect,
            ws::ws_send,
            ws::ws_disconnect
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
