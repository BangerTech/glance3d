import { load, type Store } from "@tauri-apps/plugin-store";

export interface AppConfig {
  host: string;
  port: number;
  showThumbnail: boolean;
  alwaysOnTop: boolean;
  /** Launch the widget automatically on Windows login. */
  autostart: boolean;
  /** Only show the window while a print is running; hide when idle. */
  onlyWhenPrinting: boolean;
  /** Optional manual camera stream URL. Empty = auto-detect. */
  cameraUrl: string;
  pos?: { x: number; y: number };
}

export const DEFAULT_CONFIG: AppConfig = {
  host: "192.168.2.240",
  port: 7125,
  showThumbnail: true,
  alwaysOnTop: true,
  autostart: false,
  onlyWhenPrinting: false,
  cameraUrl: "",
};

const STORE_FILE = "orca-widget.json";
const CONFIG_KEY = "config";

let store: Store | null = null;
let cached: AppConfig = { ...DEFAULT_CONFIG };

export async function initConfig(): Promise<AppConfig> {
  store = await load(STORE_FILE, { autoSave: true });
  const saved = await store.get<AppConfig>(CONFIG_KEY);
  cached = { ...DEFAULT_CONFIG, ...(saved ?? {}) };
  return cached;
}

export function getConfig(): AppConfig {
  return cached;
}

export async function setConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  cached = { ...cached, ...patch };
  if (store) {
    await store.set(CONFIG_KEY, cached);
    await store.save();
  }
  return cached;
}
