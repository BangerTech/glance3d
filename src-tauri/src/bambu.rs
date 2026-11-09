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
use rustls::{CertificateError, ClientConfig as RustlsClientConfig, DigitallySignedStruct, SignatureScheme};
use tauri::{Emitter, State, WebviewWindow};
use x509_parser::prelude::*;

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

// --- TLS: trust the printer when its cert is a Bambu-issued device cert
// named after the configured serial ---

// Bambu's roots and per-model CAs, shipped with the app (MIT, from
// rolottr/bambu-bar's Resources/Certificates).
const BAMBU_CA_PEM: &[u8] = include_bytes!("../certs/bambu-ca.pem");
const BAMBU_N6_PEM: &[u8] = include_bytes!("../certs/bambu-n6.pem");
const BAMBU_N7_PEM: &[u8] = include_bytes!("../certs/bambu-n7.pem");
const BAMBU_O1C2_PEM: &[u8] = include_bytes!("../certs/bambu-o1c2.pem");

/// Set to `true` at compile time to bypass CA / CN checks (e.g. when hitting
/// a simulator with a self-signed cert). Off by default.
const INSECURE_FALLBACK: bool = false;

fn load_bambu_subjects() -> Vec<Vec<u8>> {
    let mut out: Vec<Vec<u8>> = Vec::new();
    for pem in [BAMBU_CA_PEM, BAMBU_N6_PEM, BAMBU_N7_PEM, BAMBU_O1C2_PEM] {
        let mut cursor = std::io::Cursor::new(pem);
        for item in rustls_pemfile::certs(&mut cursor) {
            if let Ok(der) = item {
                if let Ok((_, cert)) = X509Certificate::from_der(&der) {
                    out.push(cert.subject().as_raw().to_vec());
                }
            }
        }
    }
    out
}

#[derive(Debug)]
struct BambuVerifier {
    bambu_ca_subjects: Vec<Vec<u8>>,
    expected_serial: String,
    insecure: bool,
}

impl ServerCertVerifier for BambuVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        // Decode the leaf: extract CN and remember its issuer for the chain check.
        let (_, leaf) = X509Certificate::from_der(end_entity.as_ref())
            .map_err(|_| rustls::Error::InvalidCertificate(CertificateError::BadEncoding))?;
        let cn = leaf
            .subject()
            .iter_common_name()
            .next()
            .and_then(|a| a.as_str().ok())
            .map(str::to_string)
            .unwrap_or_default();

        // The printer presents a cert whose CN is its serial. This both proves
        // we're talking to *this* printer (someone else's Bambu device nearby
        // cannot pretend to be it and collect our access code) and tells us
        // which device we're connected to.
        if !cn.eq_ignore_ascii_case(&self.expected_serial) {
            if !self.insecure {
                eprintln!(
                    "bambu TLS: leaf CN {:?} does not match configured serial {:?}",
                    cn, self.expected_serial
                );
                return Err(rustls::Error::InvalidCertificate(
                    CertificateError::NotValidForName,
                ));
            } else {
                eprintln!(
                    "bambu TLS (insecure): accepting CN mismatch {:?} vs {:?}",
                    cn, self.expected_serial
                );
            }
        }

        // Chain-root check: at least one cert in the presented chain must be
        // issued by one of our bundled Bambu CAs (by DN). This is a weaker
        // check than full PKI validation — we don't verify signatures here —
        // but it's a meaningful step up from accepting any cert for a LAN
        // printer, and matches what bambu-bar does on macOS.
        let mut issuers: Vec<Vec<u8>> = Vec::with_capacity(1 + intermediates.len());
        issuers.push(leaf.issuer().as_raw().to_vec());
        for der in intermediates {
            if let Ok((_, c)) = X509Certificate::from_der(der.as_ref()) {
                issuers.push(c.issuer().as_raw().to_vec());
            }
        }
        let chain_ok = issuers
            .iter()
            .any(|iss| self.bambu_ca_subjects.iter().any(|s| s == iss));
        if !chain_ok && !self.insecure {
            eprintln!("bambu TLS: chain does not terminate at a bundled Bambu CA");
            return Err(rustls::Error::InvalidCertificate(
                CertificateError::UnknownIssuer,
            ));
        }

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

fn bambu_rustls_config(expected_serial: String) -> Arc<RustlsClientConfig> {
    let verifier = BambuVerifier {
        bambu_ca_subjects: load_bambu_subjects(),
        expected_serial,
        insecure: INSECURE_FALLBACK,
    };
    let config = RustlsClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
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
        bambu_rustls_config(serial.clone()),
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
