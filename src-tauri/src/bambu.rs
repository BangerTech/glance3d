// Bambu Lab local MQTT proxy, per-window.
//
// Each printer window opens its own MQTT/TLS connection to the Bambu Lab
// printer (LAN Only + Developer Mode enabled). We key state by the calling
// window's label and emit events only back to that window so multiple printer
// windows never cross-talk.
//
// Protocol summary (reconstructed from the public Bambu/bambuddy work):
// * TLS on port 8883. The printer uses a self-signed cert; we accept it.
// * Credentials: user "bblp", password = the printer's Access Code.
// * Status: subscribe to `device/{serial}/report`.
// * Commands: publish to `device/{serial}/request` (JSON payloads).
// * On connect the client should publish a `pushall` to get a full snapshot;
//   that happens in the frontend (src/bambu.ts) so we stay protocol-agnostic.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rumqttc::{
    AsyncClient, Event, MqttOptions, Packet, QoS, TlsConfiguration, Transport,
};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig as RustlsClientConfig, DigitallySignedStruct, SignatureScheme};
use tauri::{Emitter, State, WebviewWindow};

#[derive(Default)]
pub struct BambuState {
    inner: Arc<Mutex<HashMap<String, BambuInner>>>,
}

#[derive(Default)]
struct BambuInner {
    generation: u64,
    client: Option<AsyncClient>,
    request_topic: String,
}

pub fn init() -> BambuState {
    // rustls 0.22 uses `ring` as the default crypto provider when the
    // corresponding feature is enabled, so no explicit install is needed.
    BambuState::default()
}

// --- TLS: accept the printer's self-signed cert ---

#[derive(Debug)]
struct NoVerifier;

impl ServerCertVerifier for NoVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }
    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![
            SignatureScheme::RSA_PKCS1_SHA256,
            SignatureScheme::RSA_PKCS1_SHA384,
            SignatureScheme::RSA_PKCS1_SHA512,
            SignatureScheme::RSA_PSS_SHA256,
            SignatureScheme::RSA_PSS_SHA384,
            SignatureScheme::RSA_PSS_SHA512,
            SignatureScheme::ECDSA_NISTP256_SHA256,
            SignatureScheme::ECDSA_NISTP384_SHA384,
            SignatureScheme::ECDSA_NISTP521_SHA512,
            SignatureScheme::ED25519,
        ]
    }
}

fn insecure_rustls_config() -> Arc<RustlsClientConfig> {
    let config = RustlsClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(NoVerifier))
        .with_no_client_auth();
    Arc::new(config)
}

// --- Commands ---

/// Opens an MQTT connection for the calling window. Returns the generation id;
/// `bambu://open` / `bambu://closed` carry the same id so the frontend can
/// ignore events from superseded connections.
#[tauri::command]
pub async fn bambu_connect(
    window: WebviewWindow,
    state: State<'_, BambuState>,
    ip: String,
    serial: String,
    access_code: String,
) -> Result<u64, String> {
    let inner = state.inner.clone();
    let label = window.label().to_string();
    let request_topic = format!("device/{serial}/request");
    let report_topic = format!("device/{serial}/report");

    let my_gen = {
        let mut map = inner.lock().unwrap();
        let entry = map.entry(label.clone()).or_default();
        entry.generation += 1;
        entry.client = None;
        entry.request_topic = request_topic.clone();
        entry.generation
    };

    let mut opts = MqttOptions::new(
        format!("glance3d-{label}-{my_gen}"),
        ip,
        8883,
    );
    opts.set_credentials("bblp", access_code);
    opts.set_transport(Transport::Tls(TlsConfiguration::Rustls(
        insecure_rustls_config(),
    )));
    opts.set_keep_alive(Duration::from_secs(30));
    opts.set_clean_session(true);

    let (client, mut eventloop) = AsyncClient::new(opts, 32);

    {
        let mut map = inner.lock().unwrap();
        if let Some(entry) = map.get_mut(&label) {
            if entry.generation != my_gen {
                return Ok(my_gen); // superseded
            }
            entry.client = Some(client.clone());
        }
    }

    let window_bg = window.clone();
    let label_bg = label.clone();
    let inner_bg = inner.clone();
    let client_bg = client.clone();
    let report_topic_bg = report_topic.clone();

    tauri::async_runtime::spawn(async move {
        let mut subscribed = false;
        loop {
            // Bail out if the frontend asked for a reconnect / disconnect.
            {
                let map = inner_bg.lock().unwrap();
                match map.get(&label_bg) {
                    Some(entry) if entry.generation == my_gen => {}
                    _ => break,
                }
            }

            match eventloop.poll().await {
                Ok(Event::Incoming(Packet::ConnAck(_))) => {
                    if !subscribed {
                        if let Err(e) = client_bg
                            .subscribe(&report_topic_bg, QoS::AtMostOnce)
                            .await
                        {
                            eprintln!("bambu subscribe error ({label_bg}): {e}");
                        } else {
                            subscribed = true;
                        }
                    }
                    let _ = window_bg.emit("bambu://open", my_gen);
                }
                Ok(Event::Incoming(Packet::Publish(p))) => {
                    let text = String::from_utf8_lossy(&p.payload).to_string();
                    let _ = window_bg.emit("bambu://message", text);
                }
                Ok(_) => {}
                Err(e) => {
                    eprintln!("bambu eventloop error ({label_bg}): {e}");
                    let _ = window_bg.emit("bambu://closed", my_gen);
                    // Short pause so an immediate reconnect loop doesn't melt
                    // the CPU; the frontend will issue a fresh connect anyway.
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    break;
                }
            }
        }

        // Final cleanup: drop the client reference if it's still ours.
        let mut map = inner_bg.lock().unwrap();
        if let Some(entry) = map.get_mut(&label_bg) {
            if entry.generation == my_gen {
                entry.client = None;
            }
        }
    });

    Ok(my_gen)
}

/// Publishes a JSON command string to the calling window's `device/{serial}/request`.
#[tauri::command]
pub async fn bambu_send(
    window: WebviewWindow,
    state: State<'_, BambuState>,
    text: String,
) -> Result<(), String> {
    let label = window.label().to_string();
    let (client, topic) = {
        let map = state.inner.lock().unwrap();
        let entry = map
            .get(&label)
            .ok_or_else(|| "not connected".to_string())?;
        match (&entry.client, entry.request_topic.clone()) {
            (Some(c), t) if !t.is_empty() => (c.clone(), t),
            _ => return Err("not connected".into()),
        }
    };
    client
        .publish(topic, QoS::AtMostOnce, false, text.into_bytes())
        .await
        .map_err(|e| e.to_string())
}

/// Closes the current MQTT connection for the calling window.
#[tauri::command]
pub fn bambu_disconnect(window: WebviewWindow, state: State<'_, BambuState>) {
    let label = window.label().to_string();
    let mut map = state.inner.lock().unwrap();
    if let Some(entry) = map.get_mut(&label) {
        entry.generation += 1;
        entry.client = None;
        entry.request_topic.clear();
    }
}
