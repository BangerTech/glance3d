import { getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import {
  register,
  unregister,
  isRegistered,
} from "@tauri-apps/plugin-global-shortcut";
import {
  enable as enableAutostart,
  disable as disableAutostart,
  isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart";

import { initConfig, getConfig, setConfig, type AppConfig } from "./config";
import { MoonrakerClient, emptyStatus, type PrinterStatus } from "./moonraker";
import { PrinterCard } from "./printer-card";
import { SettingsPanel, type SettingsSaveDetail } from "./settings";
import printerK1Image from "./assets/printer-creality-k1.png";

// Ensure custom elements are registered (side-effect imports).
void PrinterCard;
void SettingsPanel;

const CLICKTHROUGH_SHORTCUT = "CommandOrControl+Alt+P";

const appWindow = getCurrentWindow();
const root = document.getElementById("app")!;

let client: MoonrakerClient;
let card: PrinterCard;
let settingsEl: SettingsPanel | null = null;
let clickThrough = false;

let lastThumbKey = "";
let lastStatus: PrinterStatus = emptyStatus();
let wasConnected = false;
let powerDevice: string | null = null;
let windowHidden = false;

async function main() {
  const cfg = await initConfig();

  await restoreWindow(cfg);
  await syncAutostart(cfg.autostart);

  card = document.createElement("printer-card");
  card.status = emptyStatus();
  card.printerImage = printerK1Image;
  root.appendChild(card);

  wireCardEvents();

  client = new MoonrakerClient(cfg.host, cfg.port);
  client.onStatus((status) => onStatus(status));
  client.connect();

  setupWindowPersistence();
  await setupClickThrough();
}

function onStatus(status: PrinterStatus) {
  lastStatus = status;
  card.status = status;
  void maybeUpdateThumbnail(status);
  void applyVisibility(status);

  // On a fresh connection, discover camera + power devices once.
  if (status.wsConnected && !wasConnected) {
    wasConnected = true;
    void discoverCapabilities();
  } else if (!status.wsConnected) {
    wasConnected = false;
  }
}

async function discoverCapabilities() {
  await resolveCamera();
  try {
    const devices = await client.getPowerDevices();
    powerDevice = devices[0] ?? null;
    card.powerAvailable = powerDevice !== null;
  } catch {
    card.powerAvailable = false;
  }
}

// ---- Camera resolution ----
// Moonraker reports a stream_url (e.g. "/webcam/?action=stream") that assumes
// an nginx reverse proxy which may not exist. We probe likely endpoints via the
// CORS-free Rust HTTP plugin and pick the first that serves an image.

async function resolveCamera() {
  const cfg = getConfig();
  if (cfg.cameraUrl) {
    card.cameraUrl = cfg.cameraUrl;
    return;
  }
  let cam: Awaited<ReturnType<MoonrakerClient["getWebcam"]>> = null;
  try {
    cam = await client.getWebcam();
  } catch {
    /* ignore */
  }
  const candidates = cameraCandidates(cfg.host, cam?.stream ?? "", cam?.snapshot ?? "");
  for (const c of candidates) {
    if (await probeImage(c.snapshot)) {
      card.cameraUrl = c.stream;
      return;
    }
  }
  // Last resort: if a stream candidate exists, use the first one anyway.
  card.cameraUrl = candidates[0]?.stream ?? null;
}

function cameraCandidates(
  host: string,
  stream: string,
  snapshot: string
): Array<{ stream: string; snapshot: string }> {
  const list: Array<{ stream: string; snapshot: string }> = [];
  const abs = (u: string) => /^https?:\/\//i.test(u);

  // 1. mjpg-streamer default on :8080 (typical for Creality K1 and crowsnest).
  list.push({
    stream: `http://${host}:8080/?action=stream`,
    snapshot: `http://${host}:8080/?action=snapshot`,
  });
  // 2. Absolute URLs as reported by Moonraker.
  if (abs(stream)) {
    list.push({ stream, snapshot: abs(snapshot) ? snapshot : stream });
  }
  // 3. Relative URLs resolved against the host (nginx proxy on :80).
  if (stream && !abs(stream)) {
    list.push({
      stream: `http://${host}${stream}`,
      snapshot: `http://${host}${snapshot || stream}`,
    });
  }
  // 4. Alternate streamer port seen on some firmwares.
  list.push({
    stream: `http://${host}:4408/?action=stream`,
    snapshot: `http://${host}:4408/?action=snapshot`,
  });
  return list;
}

async function probeImage(url: string): Promise<boolean> {
  if (!url) return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await tauriFetch(url, { method: "GET", signal: ctrl.signal });
    clearTimeout(timer);
    const ct = res.headers.get("content-type") ?? "";
    return res.ok && ct.toLowerCase().startsWith("image");
  } catch {
    return false;
  }
}

// ---- Autostart + visibility ----

async function syncAutostart(wanted: boolean) {
  try {
    const enabled = await isAutostartEnabled();
    if (wanted && !enabled) await enableAutostart();
    else if (!wanted && enabled) await disableAutostart();
  } catch (err) {
    logErr(err);
  }
}

async function applyVisibility(status: PrinterStatus) {
  const cfg = getConfig();
  if (!cfg.onlyWhenPrinting) {
    if (windowHidden) {
      windowHidden = false;
      try {
        await appWindow.show();
      } catch (err) {
        logErr(err);
      }
    }
    return;
  }
  const active = status.printState === "printing" || status.printState === "paused";
  if (active && windowHidden) {
    windowHidden = false;
    try {
      await appWindow.show();
    } catch (err) {
      logErr(err);
    }
  } else if (!active && !windowHidden) {
    windowHidden = true;
    try {
      await appWindow.hide();
    } catch (err) {
      logErr(err);
    }
  }
}

function wireCardEvents() {
  const actions: Record<string, () => void> = {
    pause: () => void client.pause().catch(logErr),
    resume: () => void client.resume().catch(logErr),
    cancel: () => {
      if (confirm("Druck wirklich abbrechen?")) {
        void client.cancel().catch(logErr);
      }
    },
    home: () => void client.home().catch(logErr),
    "toggle-light": () => {
      const next = !(lastStatus.light ?? false);
      void client.setLight(next).catch(logErr);
    },
    "toggle-camera": () => {
      card.showCamera = !card.showCamera;
    },
    "toggle-power": () => {
      if (!powerDevice) return;
      const next = !card.powerOn;
      card.powerOn = next;
      void client.setPower(powerDevice, next).catch(logErr);
    },
    startdrag: () => void appWindow.startDragging().catch(logErr),
    "open-settings": () => openSettings(),
    "close-app": () => void appWindow.close().catch(logErr),
  };

  for (const [name, handler] of Object.entries(actions)) {
    card.addEventListener(name, handler as EventListener);
  }
}

// ---- Settings ----

function openSettings() {
  if (settingsEl) return;
  settingsEl = document.createElement("settings-panel");
  settingsEl.config = { ...getConfig() };
  settingsEl.addEventListener("close", closeSettings);
  settingsEl.addEventListener("save", (e) => {
    void onSettingsSave((e as CustomEvent<SettingsSaveDetail>).detail);
  });
  root.appendChild(settingsEl);
}

function closeSettings() {
  settingsEl?.remove();
  settingsEl = null;
}

async function onSettingsSave(detail: SettingsSaveDetail) {
  const cfg = await setConfig({
    host: detail.host,
    port: detail.port,
    showThumbnail: detail.showThumbnail,
    alwaysOnTop: detail.alwaysOnTop,
    autostart: detail.autostart,
    onlyWhenPrinting: detail.onlyWhenPrinting,
    cameraUrl: detail.cameraUrl,
  });

  await appWindow.setAlwaysOnTop(cfg.alwaysOnTop);
  await syncAutostart(cfg.autostart);

  if (!cfg.showThumbnail) {
    card.coverUrl = null;
    lastThumbKey = "";
  }

  client.setEndpoint(cfg.host, cfg.port);
  // Force a thumbnail refresh for the new endpoint.
  lastThumbKey = "";
  void maybeUpdateThumbnail(lastStatus);

  // Re-resolve camera (manual URL or auto) and re-apply visibility.
  void resolveCamera();
  void applyVisibility(lastStatus);

  closeSettings();
}

// ---- Thumbnail (optional cover image) ----

async function maybeUpdateThumbnail(status: PrinterStatus) {
  const cfg = getConfig();
  if (!cfg.showThumbnail || !status.wsConnected || !status.filename) {
    if (!status.filename) {
      card.coverUrl = null;
      lastThumbKey = "";
    }
    return;
  }

  const key = `${cfg.host}:${cfg.port}|${status.filename}`;
  if (key === lastThumbKey) return;
  lastThumbKey = key;

  try {
    const url =
      `${client.httpBase}/server/files/metadata?filename=` +
      encodeURIComponent(status.filename);
    const res = await tauriFetch(url, { method: "GET" });
    if (!res.ok) return;
    const data = await res.json();
    const thumbs: any[] = data?.result?.thumbnails ?? [];
    if (!thumbs.length) {
      card.coverUrl = null;
      return;
    }
    const best = [...thumbs].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
    const dir = status.filename.includes("/")
      ? status.filename.slice(0, status.filename.lastIndexOf("/") + 1)
      : "";
    card.coverUrl =
      `${client.httpBase}/server/files/gcodes/${dir}${best.relative_path}`;
  } catch (err) {
    // Thumbnail is best-effort; ignore failures.
    console.debug("thumbnail fetch failed", err);
  }
}

// ---- Window: position persistence + always-on-top ----

async function restoreWindow(cfg: AppConfig) {
  try {
    await appWindow.setAlwaysOnTop(cfg.alwaysOnTop);
  } catch (err) {
    logErr(err);
  }
  if (cfg.pos) {
    try {
      await appWindow.setPosition(new PhysicalPosition(cfg.pos.x, cfg.pos.y));
    } catch (err) {
      logErr(err);
    }
  }
}

function setupWindowPersistence() {
  let saveTimer: number | null = null;
  void appWindow.onMoved(({ payload }) => {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      void setConfig({ pos: { x: payload.x, y: payload.y } });
    }, 400);
  });
}

// ---- Click-through toggle (global shortcut) ----

async function setupClickThrough() {
  try {
    if (await isRegistered(CLICKTHROUGH_SHORTCUT)) {
      await unregister(CLICKTHROUGH_SHORTCUT);
    }
    await register(CLICKTHROUGH_SHORTCUT, (event) => {
      if (event.state === "Pressed") void toggleClickThrough();
    });
  } catch (err) {
    logErr(err);
  }
}

async function toggleClickThrough() {
  clickThrough = !clickThrough;
  try {
    await appWindow.setIgnoreCursorEvents(clickThrough);
    document.body.style.opacity = clickThrough ? "0.75" : "1";
  } catch (err) {
    logErr(err);
  }
}

function logErr(err: unknown) {
  console.error(err);
}

window.addEventListener("DOMContentLoaded", () => {
  void main();
});
