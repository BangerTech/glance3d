// Moonraker WebSocket proxy, per-window.
//
// Each printer window owns its own Moonraker connection. We key the connection
// state by the calling window's label and only emit events back to that same
// window, so multiple printer windows never cross-talk.
//
// (See the module-level doc from the original single-connection version for
// why the socket has to run in Rust at all: packaged webview Origin is not in
// Moonraker's cors_domains, so a browser WebSocket is rejected. A Rust client
// sends no Origin header and is accepted via trusted_clients.)

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use tauri::{Emitter, State, WebviewWindow};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

#[derive(Default)]
pub struct WsState {
    inner: Arc<Mutex<HashMap<String, WsInner>>>,
}

#[derive(Default)]
struct WsInner {
    generation: u64,
    sender: Option<mpsc::UnboundedSender<Message>>,
}

pub fn init() -> WsState {
    WsState::default()
}

/// Opens (or re-opens) the Moonraker WebSocket for the calling window. Returns
/// the generation id of this connection; `open`/`closed` events carry the same
/// id so the frontend can ignore events from superseded connections.
#[tauri::command]
pub async fn ws_connect(
    window: WebviewWindow,
    state: State<'_, WsState>,
    url: String,
) -> Result<u64, String> {
    let inner = state.inner.clone();
    let label = window.label().to_string();

    let my_gen = {
        let mut map = inner.lock().unwrap();
        let entry = map.entry(label.clone()).or_default();
        entry.generation += 1;
        entry.sender = None;
        entry.generation
    };

    let window_bg = window.clone();
    let label_bg = label.clone();
    tauri::async_runtime::spawn(async move {
        match tokio_tungstenite::connect_async(&url).await {
            Ok((ws_stream, _)) => {
                let (mut write, mut read) = ws_stream.split();
                let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

                {
                    let mut map = inner.lock().unwrap();
                    let entry = match map.get_mut(&label_bg) {
                        Some(e) => e,
                        None => return,
                    };
                    if entry.generation != my_gen {
                        return; // superseded before we finished connecting
                    }
                    entry.sender = Some(tx);
                }

                let _ = window_bg.emit("moonraker://open", my_gen);

                let writer = tauri::async_runtime::spawn(async move {
                    while let Some(msg) = rx.recv().await {
                        if write.send(msg).await.is_err() {
                            break;
                        }
                    }
                });

                while let Some(item) = read.next().await {
                    {
                        let map = inner.lock().unwrap();
                        match map.get(&label_bg) {
                            Some(entry) if entry.generation == my_gen => {}
                            _ => break,
                        }
                    }
                    match item {
                        Ok(Message::Text(text)) => {
                            let _ = window_bg
                                .emit("moonraker://message", text.as_str().to_string());
                        }
                        Ok(Message::Close(_)) | Err(_) => break,
                        _ => {}
                    }
                }

                writer.abort();
                {
                    let mut map = inner.lock().unwrap();
                    if let Some(entry) = map.get_mut(&label_bg) {
                        if entry.generation == my_gen {
                            entry.sender = None;
                        }
                    }
                }
                let _ = window_bg.emit("moonraker://closed", my_gen);
            }
            Err(e) => {
                eprintln!("moonraker ws connect error ({label_bg}): {e}");
                let _ = window_bg.emit("moonraker://closed", my_gen);
            }
        }
    });

    Ok(my_gen)
}

/// Sends a raw JSON-RPC text frame on the calling window's Moonraker socket.
#[tauri::command]
pub fn ws_send(
    window: WebviewWindow,
    state: State<'_, WsState>,
    text: String,
) -> Result<(), String> {
    let label = window.label().to_string();
    let map = state.inner.lock().unwrap();
    let entry = map.get(&label).ok_or_else(|| "not connected".to_string())?;
    match &entry.sender {
        Some(tx) => tx
            .send(Message::Text(text.into()))
            .map_err(|e| e.to_string()),
        None => Err("not connected".into()),
    }
}

/// Closes the current connection for the calling window.
#[tauri::command]
pub fn ws_disconnect(window: WebviewWindow, state: State<'_, WsState>) {
    let label = window.label().to_string();
    let mut map = state.inner.lock().unwrap();
    if let Some(entry) = map.get_mut(&label) {
        entry.generation += 1;
        entry.sender = None;
    }
}
