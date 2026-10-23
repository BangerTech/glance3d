# Glance3D (orca-widget)

A lightweight, transparent, always-on-top Windows desktop widget for live 3D
printer status, styled after Home Assistant Prism cards. Each printer runs in
its own freely placeable window.

Supported backends:

- **Creality / Klipper / Moonraker** over WebSocket JSON-RPC — the same
  mechanism OrcaSlicer's `MoonrakerPrinterAgent` uses, so no Home Assistant is
  required.
- **Bambu Lab** (X1, X1C, H2D, ...) over the printer's local MQTT/TLS protocol
  (LAN Only + Developer Mode).

Reference printers used during development: a rooted Creality K1 Max at
`192.168.2.240:7125` (open API, no key) and a Bambu Lab X1 on the LAN.

## Tech stack

- Tauri 2 (Rust shell, WebView2 on Windows) — frameless, transparent,
  always-on-top windows hidden from the taskbar.
- Vite + TypeScript + Lit 3 (web components) for the UI.
- Plugins: `tauri-plugin-store` (config), `tauri-plugin-http` (CORS-free
  metadata fetch), `tauri-plugin-global-shortcut` (click-through toggle),
  `tauri-plugin-autostart`.
- Rust transport layer:
  - `tokio-tungstenite` for the Moonraker WebSocket.
  - `rumqttc` + `rustls` (with a permissive cert verifier) for Bambu MQTT/TLS.

Printer parsing/logic lives in the frontend, but the raw sockets are opened in
the Rust backend and bridged to the frontend via Tauri events.

## Architecture

```
index.html  ->  src/main.ts (entry: branches on window label)
   |- coordinator  (label "main", hidden): spawns a window per printer,
   |                                        owns global toggles & shortcuts.
   |- printer view (label = printer.id):
         |- src/config.ts         persisted multi-printer settings
         |- src/backend.ts        PrinterBackend interface + PrinterStatus
         |- src/moonraker.ts      Moonraker WebSocket client
         |- src/bambu.ts          Bambu Lab MQTT client
         |- src/printer-card.ts   <printer-card> glassmorphism Lit card
         |- src/settings.ts       <settings-panel> Lit overlay
```

Each printer window chooses its backend from `printer.type` (`moonraker` or
`bambu`), subscribes to normalized `PrinterStatus` updates, and persists its
own window position back into its printer entry.

## Multi-window model

- `tauri.conf.json` ships one `main` window that is hidden (1x1 off-screen,
  `visible: false`). It is the **coordinator**: it reads the printer list,
  spawns one `WebviewWindow` per printer (label = `printer.id`), owns autostart
  and the global click-through shortcut, and keeps the app alive even when
  every printer window is closed.
- Printer windows are created at runtime with `new WebviewWindow(id, { url:
  'index.html?printer=<id>', ... })`. Each one branches `main.ts` into the
  printer-view path and binds to its own printer entry.
- Tauri events coordinate changes across windows:
  - `glance3d:printers-changed` — a printer was added, removed, or edited; the
    coordinator reconciles its window set.
  - `glance3d:open-printer` (payload = printer id) — focus or create that
    printer's window.
  - `glance3d:globals-changed` — `alwaysOnTop` / `autostart` toggles were
    changed; the coordinator and every printer window re-apply them.

## Moonraker integration

### Why the WebSocket runs in Rust

In the packaged build the webview origin is `http://tauri.localhost`, which is
not in Moonraker's `cors_domains` (it only lists `localhost`), so a browser
WebSocket is rejected with a CORS error - the widget shows OFFLINE even though
the printer is reachable. `trusted_clients` covers the PC's IP but does not
bypass the browser Origin check. A Rust client (`tokio-tungstenite`) sends no
`Origin` header, so Moonraker treats it as a non-browser request and accepts it
via `trusted_clients`.

The proxy lives in `src-tauri/src/ws.rs` and exposes three commands:
`ws_connect(url) -> gen`, `ws_send(text)`, `ws_disconnect()`. State is keyed
per calling window label, so multiple printer windows can run independent
Moonraker connections. Incoming frames are forwarded to the calling window as
the event `moonraker://message`; connection state as `moonraker://open` /
`moonraker://closed` (both carrying the connection `gen` so superseded
connections are ignored). `src/moonraker.ts` drives this via `invoke`/`listen`
and keeps all JSON-RPC parsing/normalization.

- Connect: `ws://<host>:<port>/websocket` (opened by the Rust proxy).
- Handshake: `server.connection.identify` -> `server.info` (klippy state) ->
  `printer.objects.subscribe`.
- Subscribed objects: `print_stats`, `virtual_sdcard`, `extruder`,
  `heater_bed`, `display_status`, `toolhead`, `idle_timeout`, `gcode_move`,
  `temperature_sensor chamber_temp`, `output_pin LED`,
  `filament_switch_sensor filament_sensor`.
- Live updates via `notify_status_update`; connection state via
  `notify_klippy_ready` / `notify_klippy_shutdown` / `notify_klippy_disconnected`.
- Controls: `printer.print.pause`, `printer.print.resume`,
  `printer.print.cancel`, `printer.gcode.script` (`G28` for home, and
  `SET_PIN PIN=LED VALUE=1|0` for the light).
- Thumbnail (optional cover image): `server.files.metadata` (via plugin-http)
  then `GET /server/files/gcodes/<dir>/<relative_path>` as an `<img>` source.
- Auto-reconnect with exponential backoff (1s -> 10s max).

## Bambu Lab integration

Bambu Lab printers use MQTT over TLS on port 8883. Enable **LAN Only Mode** and
then **Developer Mode** on the printer; note the Access Code (8 digits) and the
printer's Serial. Credentials are username `bblp`, password = Access Code. The
TLS cert is self-signed and must be accepted.

The MQTT client lives in `src-tauri/src/bambu.rs` and exposes three commands:
`bambu_connect(ip, serial, access_code) -> gen`, `bambu_send(text)`,
`bambu_disconnect()`. State is keyed per calling window label (like the
Moonraker proxy). Events: `bambu://open`, `bambu://message`, `bambu://closed`.
TLS is handled with `rumqttc` + a custom `rustls` verifier that accepts any
certificate.

- Subscribe: `device/{serial}/report`.
- On connect the frontend publishes a `pushall` so a full snapshot arrives
  immediately (otherwise only deltas stream in).
- Commands (publish to `device/{serial}/request`):
  - Pause/Resume/Stop: `{"print":{"command":"pause"|"resume"|"stop", ...}}`
  - Home: `{"print":{"command":"gcode_line","param":"G28\n", ...}}`
  - Chamber light: `{"system":{"command":"ledctrl","led_node":"chamber_light","led_mode":"on"|"off", ...}}`
- Status mapping (`src/bambu.ts`):
  - `print.gcode_state` → `printState` (IDLE/PREPARE/SLICING/RUNNING/PAUSE/FINISH/FAILED)
  - `mc_percent` → `progress`; `mc_remaining_time` (min) → `etaSeconds`
  - `nozzle_temper`/`nozzle_target_temper`, `bed_temper`/`bed_target_temper`, `chamber_temper`
  - `layer_num`/`total_layer_num`
  - `subtask_name`/`gcode_file` → `filename`
  - `cooling_fan_speed`/`big_fan1_speed`/`big_fan2_speed` → fan percentages
    (0..15 gear or 0..100 percent — normalized)
  - `lights_report[chamber_light]` → `light`
  - `ams` → `AmsSlot[]` with color / material / active / remaining%

Camera (RTSP on X1/H2D at `rtsps://bblp:<code>@<ip>:322/streaming/live/1`) is
not yet implemented; WebView2 can't play RTSP directly, so this will ship as a
bundled ffmpeg sidecar in a later release.

## Data model (not a database)

This project has no SQL database. The config is a plugin-store JSON file.

### Persisted config (`orca-widget.json`, plugin-store, key `config`)

```ts
interface AppConfig {
  version: number;
  printers: PrinterInstance[];
  alwaysOnTop: boolean;
  autostart: boolean;
}
interface PrinterInstance {
  id: string;                        // uuid; also the Tauri window label
  name: string;
  type: "moonraker" | "bambu";
  host: string;                      // ip/hostname
  port: number;                      // moonraker only
  bambuSerial?: string;              // bambu only
  bambuAccessCode?: string;          // bambu only
  cameraUrl?: string;                // optional manual stream URL
  showThumbnail: boolean;
  onlyWhenPrinting: boolean;
  pos?: { x: number; y: number };    // last window position (physical px)
}
```

A legacy v1 single-printer config (`{ host, port, ... }`) is migrated on first
launch into one `moonraker` entry named "Creality Printer".

### Normalized live status (`PrinterStatus` in `src/backend.ts`)

`wsConnected`, `klippy`, `printState`, `filename`, `progress` (0..1),
`nozzleTemp`/`nozzleTarget`, `bedTemp`/`bedTarget`, `chamberTemp`,
`currentLayer`/`totalLayers`, `printDuration`/`totalDuration`, `etaSeconds`,
`light`, `filamentDetected`, `modelFan`/`auxFan`/`caseFan`, `stage` (Bambu),
`ams` (`AmsSlot[] | null`, Bambu).

## Window behavior

- Frameless, transparent, always-on-top, `skipTaskbar`, non-resizable,
  380x600, centered on first launch (per printer).
- Drag anywhere on the card except interactive controls.
- Position is persisted (debounced) and restored on launch per printer.
- Click-through toggle: global shortcut `Ctrl+Alt+P` toggles
  `setIgnoreCursorEvents` on every printer window.

## Develop / build

```powershell
npm install
npm run tauri dev     # live widget
npm run tauri build   # produces an installer/exe in src-tauri/target/release
```

Prerequisites: Node 18+, Rust toolchain (`rustup`), WebView2 (bundled with
Windows 11).

### Release artifacts

After `npm run tauri build`:

- `src-tauri/target/release/orca-widget.exe` — portable executable
- `src-tauri/target/release/bundle/nsis/Orca Widget_0.1.0_x64-setup.exe` — NSIS installer (~2.9 MiB)
- `src-tauri/target/release/bundle/msi/Orca Widget_0.1.0_x64_en-US.msi` — MSI (~4.1 MiB)

## Troubleshooting

- **Widget shows "Keine Verbindung" (Moonraker)**: verify
  `http://<host>:7125/server/info` responds and the host/port in Settings is
  correct.
- **Moonraker rejects the browser Origin**: add the widget origin to
  `cors_domains` in `moonraker.conf` (e.g. `cors_domains: ['*']`) or ensure the
  PC's subnet is in `trusted_clients`.
- **Bambu stays offline**: the printer needs **LAN Only Mode + Developer Mode**
  (both toggles). Verify the Access Code and Serial, and that no firewall is
  blocking TCP 8883 from your PC.
- **Camera for Bambu**: not yet supported; RTSP transcoding ships in a later
  milestone.
