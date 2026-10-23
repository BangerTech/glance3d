// Moonraker WebSocket proxy.
//
// The browser cannot open ws:// to the printer in the packaged build: the
// webview origin (http://tauri.localhost) is not in Moonraker's cors_domains,
// so Moonraker rejects the browser WebSocket. A Rust client sends no Origin
// header, so Moonraker treats it as a non-browser request and accepts it via
// trusted_clients. We open the socket here and bridge it to the frontend via
// Tauri events.

use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

#[derive(Default)]
pub struct WsState {
    inner: Arc<Mutex<WsInner>>,
}

#[derive(Default)]
struct WsInner {
    generation: u64,
    sender: Option<mpsc::UnboundedSender<Message>>,
}

pub fn init() -> WsState {
    WsState::default()
}

/// Opens (or re-opens) the Moonraker WebSocket. Returns the generation id of
/// this connection; `open`/`closed` events carry the same id so the frontend
/// can ignore events from superseded connections.
#[tauri::command]
pub async fn ws_connect(
    app: AppHandle,
    state: State<'_, WsState>,
    url: String,
) -> Result<u64, String> {
    let inner = state.inner.clone();

    let my_gen = {
        let mut g = inner.lock().unwrap();
        g.generation += 1;
        g.sender = None;
        g.generation
    };

    tauri::async_runtime::spawn(async move {
        match tokio_tungstenite::connect_async(&url).await {
            Ok((ws_stream, _)) => {
                let (mut write, mut read) = ws_stream.split();
                let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

                {
                    let mut g = inner.lock().unwrap();
                    if g.generation != my_gen {
                        return; // superseded before we finished connecting
                    }
                    g.sender = Some(tx);
                }

                let _ = app.emit("moonraker://open", my_gen);

                let writer = tauri::async_runtime::spawn(async move {
                    while let Some(msg) = rx.recv().await {
                        if write.send(msg).await.is_err() {
                            break;
                        }
                    }
                });

                while let Some(item) = read.next().await {
                    {
                        let g = inner.lock().unwrap();
                        if g.generation != my_gen {
                            break;
                        }
                    }
                    match item {
                        Ok(Message::Text(text)) => {
                            let _ = app.emit("moonraker://message", text.as_str().to_string());
                        }
                        Ok(Message::Close(_)) | Err(_) => break,
                        _ => {}
                    }
                }

                writer.abort();
                {
                    let mut g = inner.lock().unwrap();
                    if g.generation == my_gen {
                        g.sender = None;
                    }
                }
                let _ = app.emit("moonraker://closed", my_gen);
            }
            Err(e) => {
                eprintln!("moonraker ws connect error: {e}");
                let _ = app.emit("moonraker://closed", my_gen);
            }
        }
    });

    Ok(my_gen)
}

/// Sends a raw JSON-RPC text frame to Moonraker.
#[tauri::command]
pub fn ws_send(state: State<'_, WsState>, text: String) -> Result<(), String> {
    let g = state.inner.lock().unwrap();
    match &g.sender {
        Some(tx) => tx.send(Message::Text(text.into())).map_err(|e| e.to_string()),
        None => Err("not connected".into()),
    }
}

/// Closes the current connection (used on dispose).
#[tauri::command]
pub fn ws_disconnect(state: State<'_, WsState>) {
    let mut g = state.inner.lock().unwrap();
    g.generation += 1;
    g.sender = None;
}
