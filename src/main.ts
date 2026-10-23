// Entry point for both modes:
//
//  * The hidden "main" (coordinator) window reads the printer list, spawns one
//    freely-placeable window per printer, keeps the app alive, and owns things
//    that are global (autostart, click-through shortcut).
//  * Every other window is a per-printer view (label = printer.id) that owns
//    its own backend connection, card, and settings overlay.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emit, listen } from "@tauri-apps/api/event";
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

import {
  initConfig,
  getConfig,
  getPrinter,
  updatePrinter,
  upsertPrinter,
  removePrinter,
  setGlobals,
  defaultPrinter,
  type PrinterInstance,
  type PrinterType,
} from "./config";
import { MoonrakerClient } from "./moonraker";
import { BambuClient } from "./bambu";
import { PrinterCard } from "./printer-card";
import { SettingsPanel, type SettingsSaveDetail } from "./settings";
import {
  emptyStatus,
  type PrinterBackend,
  type PrinterStatus,
  type Webcam,
} from "./backend";
import printerK1Image from "./assets/printer-creality-k1.png";

// Register the Lit components (side-effect imports).
void PrinterCard;
void SettingsPanel;

const CLICKTHROUGH_SHORTCUT = "CommandOrControl+Alt+P";
const WIDGET_WIDTH = 380;
const WIDGET_HEIGHT = 600;
const EVT_PRINTERS_CHANGED = "glance3d:printers-changed";
const EVT_OPEN_PRINTER = "glance3d:open-printer";
const EVT_GLOBALS_CHANGED = "glance3d:globals-changed";

const appWindow = getCurrentWindow();

window.addEventListener("DOMContentLoaded", () => {
  const label = appWindow.label;
  if (label === "main") {
    void runCoordinator();
  } else {
    void runPrinterView(label);
  }
});

// ============================================================
// Coordinator (the hidden "main" window)
// ============================================================

async function runCoordinator(): Promise<void> {
  const cfg = await initConfig();

  // On a fresh install there are no printers yet; seed a default Moonraker
  // entry so the user has a visible window to configure.
  if (cfg.printers.length === 0) {
    await upsertPrinter(defaultPrinter("moonraker"));
  }

  await syncAutostart(getConfig().autostart);
  await setupClickThrough();
  await reconcileWindows();

  await listen<void>(EVT_PRINTERS_CHANGED, () => {
    void reconcileWindows();
  });
  await listen<string>(EVT_OPEN_PRINTER, (e) => {
    if (typeof e.payload === "string") void openPrinterWindow(e.payload);
  });
  await listen<void>(EVT_GLOBALS_CHANGED, () => {
    void applyGlobals();
  });
}

async function reconcileWindows(): Promise<void> {
  const cfg = getConfig();
  for (const p of cfg.printers) {
    const existing = await WebviewWindow.getByLabel(p.id);
    if (!existing) await openPrinterWindow(p.id);
  }
}

async function openPrinterWindow(id: string): Promise<void> {
  const p = getPrinter(id);
  if (!p) return;
  const existing = await WebviewWindow.getByLabel(id);
  if (existing) {
    try {
      await existing.show();
      await existing.setFocus();
    } catch (err) {
      console.error(err);
    }
    return;
  }
  const wv = new WebviewWindow(id, {
    url: `index.html?printer=${encodeURIComponent(id)}`,
    title: p.name,
    width: WIDGET_WIDTH,
    height: WIDGET_HEIGHT,
    x: p.pos?.x,
    y: p.pos?.y,
    decorations: false,
    transparent: true,
    alwaysOnTop: getConfig().alwaysOnTop,
    skipTaskbar: true,
    resizable: false,
    shadow: false,
    center: !p.pos,
    visible: true,
  });
  wv.once("tauri://error", (e) => console.error("window error", id, e));
}

async function applyGlobals(): Promise<void> {
  const cfg = getConfig();
  await syncAutostart(cfg.autostart);
  for (const p of cfg.printers) {
    const wv = await WebviewWindow.getByLabel(p.id);
    if (!wv) continue;
    try {
      await wv.setAlwaysOnTop(cfg.alwaysOnTop);
    } catch (err) {
      console.error(err);
    }
  }
}

async function syncAutostart(wanted: boolean): Promise<void> {
  try {
    const enabled = await isAutostartEnabled();
    if (wanted && !enabled) await enableAutostart();
    else if (!wanted && enabled) await disableAutostart();
  } catch (err) {
    console.error(err);
  }
}

let clickThrough = false;
async function setupClickThrough(): Promise<void> {
  try {
    if (await isRegistered(CLICKTHROUGH_SHORTCUT)) {
      await unregister(CLICKTHROUGH_SHORTCUT);
    }
    await register(CLICKTHROUGH_SHORTCUT, async (event) => {
      if (event.state !== "Pressed") return;
      clickThrough = !clickThrough;
      const cfg = getConfig();
      for (const p of cfg.printers) {
        const wv = await WebviewWindow.getByLabel(p.id);
        if (!wv) continue;
        try {
          await wv.setIgnoreCursorEvents(clickThrough);
        } catch {
          /* ignore */
        }
      }
    });
  } catch (err) {
    console.error(err);
  }
}

// ============================================================
// Per-printer window
// ============================================================

async function runPrinterView(id: string): Promise<void> {
  await initConfig();
  let printer = getPrinter(id);
  if (!printer) {
    // The printer was removed while this window was opening; just close.
    try {
      await appWindow.close();
    } catch (err) {
      console.error(err);
    }
    return;
  }

  try {
    await appWindow.setAlwaysOnTop(getConfig().alwaysOnTop);
  } catch (err) {
    console.error(err);
  }

  const root = document.getElementById("app")!;
  const card = document.createElement("printer-card");
  card.status = emptyStatus();
  card.name = printer.name;
  card.printerImage = printerK1Image;
  root.appendChild(card);

  let backend: PrinterBackend = makeBackend(printer);
  let lastStatus: PrinterStatus = emptyStatus();
  let wasConnected = false;
  let powerDevice: string | null = null;
  let windowHidden = false;
  let lastThumbKey = "";
  let settingsEl: SettingsPanel | null = null;

  const subscribe = (b: PrinterBackend) =>
    b.onStatus((s) => {
      lastStatus = s;
      card.status = s;
      void maybeUpdateThumbnail(s);
      void applyVisibility(s);
      if (s.wsConnected && !wasConnected) {
        wasConnected = true;
        void discoverCapabilities();
      } else if (!s.wsConnected) {
        wasConnected = false;
      }
    });
  let unsub = subscribe(backend);
  backend.connect();

  async function discoverCapabilities(): Promise<void> {
    await resolveCamera();
    try {
      const devices = await backend.getPowerDevices();
      powerDevice = devices[0] ?? null;
      card.powerAvailable = powerDevice !== null;
    } catch {
      card.powerAvailable = false;
    }
  }

  async function resolveCamera(): Promise<void> {
    const p = getPrinter(id);
    if (!p) return;
    if (p.cameraUrl) {
      card.cameraUrl = p.cameraUrl;
      return;
    }
    // Bambu RTSP needs the ffmpeg sidecar (not shipped yet).
    if (p.type !== "moonraker") {
      card.cameraUrl = null;
      return;
    }
    let cam: Webcam | null = null;
    try {
      cam = await backend.getWebcam();
    } catch {
      /* ignore */
    }
    const candidates = cameraCandidates(p.host, cam?.stream ?? "", cam?.snapshot ?? "");
    for (const c of candidates) {
      if (await probeImage(c.snapshot)) {
        card.cameraUrl = c.stream;
        return;
      }
    }
    card.cameraUrl = candidates[0]?.stream ?? null;
  }

  async function applyVisibility(status: PrinterStatus): Promise<void> {
    const p = getPrinter(id);
    if (!p) return;
    if (!p.onlyWhenPrinting) {
      if (windowHidden) {
        windowHidden = false;
        try {
          await appWindow.show();
        } catch (err) {
          console.error(err);
        }
      }
      return;
    }
    const active =
      status.printState === "printing" || status.printState === "paused";
    if (active && windowHidden) {
      windowHidden = false;
      try {
        await appWindow.show();
      } catch (err) {
        console.error(err);
      }
    } else if (!active && !windowHidden) {
      windowHidden = true;
      try {
        await appWindow.hide();
      } catch (err) {
        console.error(err);
      }
    }
  }

  async function maybeUpdateThumbnail(status: PrinterStatus): Promise<void> {
    const p = getPrinter(id);
    if (!p || !p.showThumbnail || !status.wsConnected || !status.filename) {
      if (!status.filename) {
        card.coverUrl = null;
        lastThumbKey = "";
      }
      return;
    }
    // Only Moonraker exposes a thumbnail metadata endpoint.
    if (p.type !== "moonraker") {
      card.coverUrl = null;
      return;
    }
    const key = `${p.host}:${p.port}|${status.filename}`;
    if (key === lastThumbKey) return;
    lastThumbKey = key;
    try {
      const url =
        `${backend.httpBase}/server/files/metadata?filename=` +
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
        `${backend.httpBase}/server/files/gcodes/${dir}${best.relative_path}`;
    } catch (err) {
      console.debug("thumbnail fetch failed", err);
    }
  }

  // ---- Card events ----
  const actions: Record<string, () => void> = {
    pause: () => void backend.pause().catch(console.error),
    resume: () => void backend.resume().catch(console.error),
    cancel: () => {
      if (confirm("Druck wirklich abbrechen?")) {
        void backend.cancel().catch(console.error);
      }
    },
    home: () => void backend.home().catch(console.error),
    "toggle-light": () => {
      const next = !(lastStatus.light ?? false);
      void backend.setLight(next).catch(console.error);
    },
    "toggle-camera": () => {
      card.showCamera = !card.showCamera;
    },
    "toggle-power": () => {
      if (!powerDevice) return;
      const next = !card.powerOn;
      card.powerOn = next;
      void backend.setPower(powerDevice, next).catch(console.error);
    },
    startdrag: () => void appWindow.startDragging().catch(console.error),
    "open-settings": openSettings,
    "close-app": () => void appWindow.close().catch(console.error),
  };
  for (const [name, handler] of Object.entries(actions)) {
    card.addEventListener(name, handler as EventListener);
  }

  // ---- Window position persistence ----
  let saveTimer: number | null = null;
  void appWindow.onMoved(({ payload }) => {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      void updatePrinter(id, { pos: { x: payload.x, y: payload.y } });
    }, 400);
  });

  // React to coordinator-driven globals changes.
  await listen<void>(EVT_GLOBALS_CHANGED, () => {
    try {
      void appWindow.setAlwaysOnTop(getConfig().alwaysOnTop);
    } catch (err) {
      console.error(err);
    }
  });

  // ---- Settings panel ----

  function openSettings(): void {
    if (settingsEl) return;
    const p = getPrinter(id);
    if (!p) return;
    settingsEl = document.createElement("settings-panel");
    settingsEl.printer = p;
    settingsEl.printers = getConfig().printers;
    settingsEl.globals = {
      alwaysOnTop: getConfig().alwaysOnTop,
      autostart: getConfig().autostart,
    };
    settingsEl.addEventListener("close", closeSettings);
    settingsEl.addEventListener("save", (e) =>
      void onSettingsSave(e as CustomEvent<SettingsSaveDetail>)
    );
    settingsEl.addEventListener("remove-printer", () => void onRemovePrinter());
    settingsEl.addEventListener("add-printer", (e) =>
      void onAddPrinter(e as CustomEvent<{ type: PrinterType }>)
    );
    settingsEl.addEventListener("open-printer", (e) => {
      const other = (e as CustomEvent<{ id: string }>).detail.id;
      if (other && other !== id) void emit(EVT_OPEN_PRINTER, other);
    });
    root.appendChild(settingsEl);
  }

  function closeSettings(): void {
    settingsEl?.remove();
    settingsEl = null;
  }

  async function onSettingsSave(e: CustomEvent<SettingsSaveDetail>): Promise<void> {
    const detail = e.detail;

    // Globals (saved + propagated to all windows + coordinator autostart).
    const prevGlobals = {
      alwaysOnTop: getConfig().alwaysOnTop,
      autostart: getConfig().autostart,
    };
    if (
      detail.alwaysOnTop !== prevGlobals.alwaysOnTop ||
      detail.autostart !== prevGlobals.autostart
    ) {
      await setGlobals({
        alwaysOnTop: detail.alwaysOnTop,
        autostart: detail.autostart,
      });
      await emit(EVT_GLOBALS_CHANGED);
    }

    // Printer patch.
    const before = getPrinter(id)!;
    const updated: PrinterInstance = {
      ...before,
      name: detail.name || before.name,
      type: detail.type,
      host: detail.host,
      port: detail.port,
      bambuSerial: detail.bambuSerial,
      bambuAccessCode: detail.bambuAccessCode,
      cameraUrl: detail.cameraUrl,
      showThumbnail: detail.showThumbnail,
      onlyWhenPrinting: detail.onlyWhenPrinting,
    };
    await upsertPrinter(updated);
    card.name = updated.name;
    printer = updated;

    // Reconnect strategy: swap the backend if the type changed; otherwise
    // forward the endpoint/credentials change.
    if (updated.type !== before.type) {
      unsub();
      backend.dispose();
      backend = makeBackend(updated);
      unsub = subscribe(backend);
      backend.connect();
    } else if (updated.type === "moonraker") {
      backend.setEndpoint(updated.host, updated.port);
    } else {
      (backend as BambuClient).setCredentials(
        updated.bambuSerial ?? "",
        updated.bambuAccessCode ?? ""
      );
      backend.setEndpoint(updated.host, 8883);
    }

    lastThumbKey = "";
    void maybeUpdateThumbnail(lastStatus);
    void resolveCamera();
    void applyVisibility(lastStatus);

    await emit(EVT_PRINTERS_CHANGED);
    closeSettings();
  }

  async function onRemovePrinter(): Promise<void> {
    if (!confirm("Diesen Drucker wirklich entfernen?")) return;
    await removePrinter(id);
    await emit(EVT_PRINTERS_CHANGED);
    try {
      await appWindow.close();
    } catch (err) {
      console.error(err);
    }
  }

  async function onAddPrinter(e: CustomEvent<{ type: PrinterType }>): Promise<void> {
    const p = defaultPrinter(e.detail.type);
    await upsertPrinter(p);
    await emit(EVT_PRINTERS_CHANGED);
    await emit(EVT_OPEN_PRINTER, p.id);
    closeSettings();
  }
}

// ============================================================
// Shared helpers
// ============================================================

function makeBackend(p: PrinterInstance): PrinterBackend {
  if (p.type === "bambu") {
    return new BambuClient(p.host, p.bambuSerial ?? "", p.bambuAccessCode ?? "");
  }
  return new MoonrakerClient(p.host, p.port);
}

function cameraCandidates(
  host: string,
  stream: string,
  snapshot: string
): Array<{ stream: string; snapshot: string }> {
  const list: Array<{ stream: string; snapshot: string }> = [];
  const abs = (u: string) => /^https?:\/\//i.test(u);
  list.push({
    stream: `http://${host}:8080/?action=stream`,
    snapshot: `http://${host}:8080/?action=snapshot`,
  });
  if (abs(stream)) {
    list.push({ stream, snapshot: abs(snapshot) ? snapshot : stream });
  }
  if (stream && !abs(stream)) {
    list.push({
      stream: `http://${host}${stream}`,
      snapshot: `http://${host}${snapshot || stream}`,
    });
  }
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
