// Bambu Lab printer network discovery (SSDP-style, UDP port 2021).
//
// Logic inspired by rolottr/bambu-bar's Sources/BambuBar/Printer/Discovery.swift
// (MIT): Bambu printers answer an `M-SEARCH * HTTP/1.1` with SSDP-formatted
// headers (`USN` = serial, `Location` = IP, `DevModel.bambu.com` = model code,
// `DevName.bambu.com` = display name). We blast M-SEARCH on 239.255.255.250
// (ports 2021 + 1990) + the local broadcast, then listen for unicast replies
// on an ephemeral UDP socket for `seconds` seconds.
//
// Returned entries are de-duplicated by serial.

use std::collections::HashMap;
use std::net::{Ipv4Addr, UdpSocket};
use std::time::{Duration, Instant};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovered {
    pub serial: String,
    pub host: String,
    pub name: String,
    /// Bambu model code ("N10", "BL-P001", ...). Empty if not announced.
    pub model: String,
    pub firmware: String,
    /// "lan" (LAN Only mode) or "cloud".
    pub connect_mode: String,
}

/// Scans for Bambu printers for approximately `seconds` seconds.
#[tauri::command]
pub async fn discovery_scan(seconds: u64) -> Result<Vec<Discovered>, String> {
    let secs = seconds.clamp(1, 30);
    tauri::async_runtime::spawn_blocking(move || scan(secs))
        .await
        .map_err(|e| e.to_string())?
}

fn scan(seconds: u64) -> Result<Vec<Discovered>, String> {
    let sock = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    sock.set_broadcast(true).ok();
    let _ = sock.join_multicast_v4(
        &Ipv4Addr::new(239, 255, 255, 250),
        &Ipv4Addr::UNSPECIFIED,
    );
    sock.set_read_timeout(Some(Duration::from_millis(500))).ok();

    let msearch = b"M-SEARCH * HTTP/1.1\r\n\
HOST: 239.255.255.250:1990\r\n\
MAN: \"ssdp:discover\"\r\n\
MX: 3\r\n\
ST: urn:bambulab-com:device:3dprinter:1\r\n\
\r\n";
    for addr in [
        "239.255.255.250:2021",
        "239.255.255.250:1990",
        "255.255.255.255:2021",
    ] {
        let _ = sock.send_to(msearch, addr);
    }

    let deadline = Instant::now() + Duration::from_secs(seconds);
    let mut by_serial: HashMap<String, Discovered> = HashMap::new();
    let mut buf = [0u8; 4096];
    while Instant::now() < deadline {
        match sock.recv_from(&mut buf) {
            Ok((n, from)) => {
                let text = String::from_utf8_lossy(&buf[..n]).to_string();
                if let Some(d) = parse(&text, &from.ip().to_string()) {
                    by_serial.entry(d.serial.clone()).or_insert(d);
                }
            }
            Err(_) => { /* timeout; loop and check deadline */ }
        }
    }
    let mut out: Vec<Discovered> = by_serial.into_values().collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn parse(text: &str, sender: &str) -> Option<Discovered> {
    if !(text.starts_with("NOTIFY") || text.starts_with("HTTP/1.1 200")) {
        return None;
    }
    let mut headers: HashMap<String, String> = HashMap::new();
    for line in text.split("\r\n").skip(1) {
        if let Some(colon) = line.find(':') {
            let key = line[..colon].trim().to_ascii_lowercase();
            let value = line[colon + 1..].trim().to_string();
            headers.insert(key, value);
        }
    }
    let notify_type = headers.get("nt").map(String::as_str).unwrap_or("");
    let search_type = headers.get("st").map(String::as_str).unwrap_or("");
    if !notify_type.contains("bambulab") && !search_type.contains("bambulab") {
        return None;
    }
    let serial = headers.get("usn")?.to_ascii_uppercase();
    if serial.is_empty() {
        return None;
    }
    let host = headers
        .get("location")
        .filter(|s| !s.is_empty())
        .cloned()
        .unwrap_or_else(|| sender.to_string());
    let name = headers
        .get("devname.bambu.com")
        .cloned()
        .unwrap_or_else(|| serial.clone());
    let model = headers
        .get("devmodel.bambu.com")
        .cloned()
        .unwrap_or_default();
    let firmware = headers
        .get("devversion.bambu.com")
        .cloned()
        .unwrap_or_default();
    let connect_mode = headers
        .get("devconnect.bambu.com")
        .cloned()
        .unwrap_or_default();

    Some(Discovered {
        serial,
        host,
        name,
        model,
        firmware,
        connect_mode,
    })
}
