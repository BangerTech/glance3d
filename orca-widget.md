# orca-widget

A lightweight, transparent, always-on-top Windows desktop widget that shows live
3D-printer status, styled after the Home Assistant Prism cards
(`prism-creality` / `prism-3dprinter`). It connects directly to the printer's
Moonraker backend over WebSocket - the same mechanism OrcaSlicer's
`MoonrakerPrinterAgent` uses - so no Home Assistant is required.

Target printer: a rooted Creality running Klipper + Moonraker at
`192.168.2.240:7125` (open API, no key).

## Tech stack

- Tauri 2 (Rust shell, WebView2 on Windows) - frameless, transparent,
  always-on-top, hidden from the taskbar.
- Vite + TypeScript + Lit 3 (web components) for the UI.
- Plugins: `tauri-plugin-store` (config), `tauri-plugin-http` (CORS-free
  metadata fetch), `tauri-plugin-global-shortcut` (click-through toggle).
- Rust WebSocket proxy (`tokio-tungstenite`) for the Moonraker connection.

Printer parsing/logic lives in the frontend, but the raw WebSocket is opened in
the Rust backend and bridged to the frontend via Tauri events (see below).

## Architecture

```
index.html  ->  src/main.ts (orchestrator)
                 |- src/config.ts        persisted settings (plugin-store)
                 |- src/moonraker.ts     WebSocket JSON-RPC client + status cache
                 |- src/printer-card.ts  <printer-card> glassmorphism Lit card
                 |- src/settings.ts      <settings-panel> Lit overlay
```

`main.ts` loads config, restores window position/always-on-top, creates the
`MoonrakerClient`, renders `<printer-card>`, and wires card events
(pause/resume/cancel/home/toggle-light/startdrag/open-settings) to the client
and the Tauri window APIs.

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
`ws_connect(url) -> gen`, `ws_send(text)`, `ws_disconnect()`. Incoming frames
are forwarded to the frontend as the event `moonraker://message`; connection
state as `moonraker://open` / `moonraker://closed` (both carrying the
connection `gen` so superseded connections are ignored). `src/moonraker.ts`
drives this via `invoke`/`listen` and keeps all JSON-RPC parsing/normalization.

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

## Data model (not a database)

This project has no SQL database. Two schemas are relevant instead.

### Persisted config (`orca-widget.json`, plugin-store, key `config`)

| Field           | Type                      | Default         | Description                          |
| --------------- | ------------------------- | --------------- | ------------------------------------ |
| `host`          | string                    | `192.168.2.240` | Printer IP / hostname                |
| `port`          | number                    | `7125`          | Moonraker port                       |
| `showThumbnail` | boolean                   | `true`          | Show model preview as card cover     |
| `alwaysOnTop`   | boolean                   | `true`          | Keep widget above other windows      |
| `pos`           | `{ x: number, y: number }`| unset           | Last window position (physical px)   |

### Normalized live status (`PrinterStatus` in `src/moonraker.ts`)

`wsConnected`, `klippy`, `printState`, `filename`, `progress` (0..1),
`nozzleTemp`/`nozzleTarget`, `bedTemp`/`bedTarget`, `chamberTemp`,
`currentLayer`/`totalLayers`, `printDuration`/`totalDuration`, `etaSeconds`
(derived: `printDuration * (1 - progress) / progress`), `light`,
`filamentDetected`.

## Window behavior

- Frameless, transparent, always-on-top, `skipTaskbar`, non-resizable,
  360x250, centered on first launch.
- Drag anywhere on the card header (`startDragging()` on mousedown, ignoring
  buttons).
- Position is persisted (debounced) and restored on launch.
- Click-through toggle: global shortcut `Ctrl+Alt+P` toggles
  `setIgnoreCursorEvents`; the window dims to 75% opacity while click-through
  is active (press the shortcut again to regain control).

## Develop / build

```powershell
npm install
npm run tauri dev     # live widget against the printer
npm run tauri build   # produces an installer/exe in src-tauri/target/release
```

Prerequisites: Node 18+, Rust toolchain (`rustup`), WebView2 (bundled with
Windows 11).

### Release artifacts

After `npm run tauri build`:

- `src-tauri/target/release/orca-widget.exe` — portable executable
- `src-tauri/target/release/bundle/nsis/Orca Widget_0.1.0_x64-setup.exe` — NSIS installer (~3.2 MiB)
- `src-tauri/target/release/bundle/msi/Orca Widget_0.1.0_x64_en-US.msi` — MSI (~4.3 MiB)

## Troubleshooting

- Widget shows "Keine Verbindung": verify `http://<host>:7125/server/info`
  responds and the host/port in Settings is correct.
- If Moonraker rejects the browser Origin, add the widget origin to
  `cors_domains` in `moonraker.conf` (e.g. `cors_domains: ['*']`) or ensure the
  PC's subnet is in `trusted_clients`.
- CFS / filament-slot display is not available over standard Moonraker objects
  and is intentionally out of scope for this build.
