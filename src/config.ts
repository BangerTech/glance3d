// Multi-printer persisted config.
//
// Each printer instance owns its own window (window label = printer.id) and
// its own backend (Moonraker or Bambu). A small set of toggles stays global
// across the whole app (alwaysOnTop, autostart).
//
// The schema is versioned so we can migrate an older single-printer config
// (`host`, `port`, ...) into one `moonraker` entry transparently.

import { load, type Store } from "@tauri-apps/plugin-store";

export type PrinterType = "moonraker" | "bambu";

export interface PrinterInstance {
  /** Stable id; also used as the Tauri window label. */
  id: string;
  name: string;
  type: PrinterType;

  /** Common connection: IP / hostname. */
  host: string;
  /** Moonraker only. Ignored for Bambu. */
  port: number;

  /** Bambu: printer serial (`BBL-xxx` style). */
  bambuSerial?: string;
  /** Bambu: 8-digit access code shown on the printer under LAN mode. */
  bambuAccessCode?: string;

  /** Optional manual camera URL (overrides auto-detect for Moonraker). */
  cameraUrl?: string;

  showThumbnail: boolean;
  onlyWhenPrinting: boolean;

  /** Last window position (physical px). */
  pos?: { x: number; y: number };
}

export interface AppConfig {
  version: number;
  printers: PrinterInstance[];
  /** Global: keep every printer window on top. */
  alwaysOnTop: boolean;
  /** Global: launch the widget with Windows. */
  autostart: boolean;
}

const CURRENT_VERSION = 2;
const STORE_FILE = "orca-widget.json";
const CONFIG_KEY = "config";

export const DEFAULT_CONFIG: AppConfig = {
  version: CURRENT_VERSION,
  printers: [],
  alwaysOnTop: true,
  autostart: false,
};

let store: Store | null = null;
let cached: AppConfig = { ...DEFAULT_CONFIG, printers: [] };

export function newPrinterId(): string {
  // crypto.randomUUID is available in WebView2 / modern browsers.
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return "p-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function defaultPrinter(type: PrinterType = "moonraker"): PrinterInstance {
  return {
    id: newPrinterId(),
    name: type === "bambu" ? "Bambu Lab" : "Creality Printer",
    type,
    host: type === "bambu" ? "192.168.2.1" : "192.168.2.240",
    port: 7125,
    bambuSerial: type === "bambu" ? "" : undefined,
    bambuAccessCode: type === "bambu" ? "" : undefined,
    cameraUrl: "",
    showThumbnail: true,
    onlyWhenPrinting: false,
  };
}

export async function initConfig(): Promise<AppConfig> {
  store = await load(STORE_FILE, { autoSave: true });
  const raw = (await store.get<any>(CONFIG_KEY)) ?? null;
  cached = normalize(raw);
  if (!raw || raw.version !== CURRENT_VERSION) {
    // Persist the migrated/normalized version.
    await store.set(CONFIG_KEY, cached);
    await store.save();
  }
  return cached;
}

export function getConfig(): AppConfig {
  return cached;
}

export function getPrinter(id: string): PrinterInstance | undefined {
  return cached.printers.find((p) => p.id === id);
}

export async function setGlobals(
  patch: Partial<Pick<AppConfig, "alwaysOnTop" | "autostart">>
): Promise<AppConfig> {
  cached = { ...cached, ...patch };
  await persist();
  return cached;
}

export async function upsertPrinter(printer: PrinterInstance): Promise<PrinterInstance> {
  const i = cached.printers.findIndex((p) => p.id === printer.id);
  if (i >= 0) {
    cached.printers[i] = printer;
  } else {
    cached.printers = [...cached.printers, printer];
  }
  await persist();
  return printer;
}

export async function updatePrinter(
  id: string,
  patch: Partial<PrinterInstance>
): Promise<PrinterInstance | undefined> {
  const i = cached.printers.findIndex((p) => p.id === id);
  if (i < 0) return undefined;
  const merged = { ...cached.printers[i], ...patch, id };
  cached.printers = [
    ...cached.printers.slice(0, i),
    merged,
    ...cached.printers.slice(i + 1),
  ];
  await persist();
  return merged;
}

export async function removePrinter(id: string): Promise<void> {
  cached.printers = cached.printers.filter((p) => p.id !== id);
  await persist();
}

export async function setPrinterPos(
  id: string,
  pos: { x: number; y: number }
): Promise<void> {
  await updatePrinter(id, { pos });
}

async function persist(): Promise<void> {
  if (!store) return;
  await store.set(CONFIG_KEY, cached);
  await store.save();
}

/** Normalize + migrate anything we read from disk into a current AppConfig. */
function normalize(raw: any): AppConfig {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_CONFIG, printers: [] };
  }

  // Already v2+: trust fields but defensively coerce.
  if (Array.isArray(raw.printers)) {
    return {
      version: CURRENT_VERSION,
      printers: raw.printers
        .filter((p: any) => p && typeof p.id === "string")
        .map(coercePrinter),
      alwaysOnTop: raw.alwaysOnTop !== false,
      autostart: !!raw.autostart,
    };
  }

  // v1 legacy: single-printer config, promote into one Moonraker entry.
  if (typeof raw.host === "string") {
    const legacy: PrinterInstance = {
      id: newPrinterId(),
      name: "Creality Printer",
      type: "moonraker",
      host: raw.host,
      port: typeof raw.port === "number" ? raw.port : 7125,
      cameraUrl: typeof raw.cameraUrl === "string" ? raw.cameraUrl : "",
      showThumbnail: raw.showThumbnail !== false,
      onlyWhenPrinting: !!raw.onlyWhenPrinting,
      pos:
        raw.pos && typeof raw.pos.x === "number" && typeof raw.pos.y === "number"
          ? { x: raw.pos.x, y: raw.pos.y }
          : undefined,
    };
    return {
      version: CURRENT_VERSION,
      printers: [legacy],
      alwaysOnTop: raw.alwaysOnTop !== false,
      autostart: !!raw.autostart,
    };
  }

  return { ...DEFAULT_CONFIG, printers: [] };
}

function coercePrinter(p: any): PrinterInstance {
  const type: PrinterType = p.type === "bambu" ? "bambu" : "moonraker";
  return {
    id: String(p.id),
    name: typeof p.name === "string" && p.name ? p.name : defaultPrinter(type).name,
    type,
    host: typeof p.host === "string" ? p.host : "",
    port: typeof p.port === "number" ? p.port : 7125,
    bambuSerial: typeof p.bambuSerial === "string" ? p.bambuSerial : undefined,
    bambuAccessCode:
      typeof p.bambuAccessCode === "string" ? p.bambuAccessCode : undefined,
    cameraUrl: typeof p.cameraUrl === "string" ? p.cameraUrl : "",
    showThumbnail: p.showThumbnail !== false,
    onlyWhenPrinting: !!p.onlyWhenPrinting,
    pos:
      p.pos && typeof p.pos.x === "number" && typeof p.pos.y === "number"
        ? { x: p.pos.x, y: p.pos.y }
        : undefined,
  };
}
