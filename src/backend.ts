// Shared types for printer backends (Moonraker + Bambu).
//
// Both backend clients normalize printer state into a single `PrinterStatus`
// shape, so the <printer-card> UI doesn't care which protocol fed it.

export type KlippyState =
  | "ready"
  | "startup"
  | "shutdown"
  | "error"
  | "disconnected";

export interface AmsSlot {
  /** 0-based tray index within its AMS unit. */
  index: number;
  /** Hex color like "#ff8800", or null if empty / unknown. */
  color: string | null;
  /** Material tag like "PLA" / "PETG". */
  material: string | null;
  /** True if this tray is currently feeding the hotend. */
  active: boolean;
  /** Remaining material 0..100, if the AMS reports it. */
  remaining: number | null;
}

export interface PrinterStatus {
  wsConnected: boolean;
  klippy: KlippyState;
  /** Normalized: standby | printing | paused | complete | cancelled | error */
  printState: string;
  filename: string;
  progress: number; // 0..1
  nozzleTemp: number;
  nozzleTarget: number;
  bedTemp: number;
  bedTarget: number;
  chamberTemp: number | null;
  currentLayer: number | null;
  totalLayers: number | null;
  printDuration: number; // seconds (0 if unknown)
  totalDuration: number; // seconds (0 if unknown)
  etaSeconds: number | null;
  light: boolean | null;
  filamentDetected: boolean | null;
  modelFan: number | null; // 0..100
  auxFan: number | null;
  caseFan: number | null;
  /** Bambu printing substage ("heating bed", "auto-leveling", ...). */
  stage: string | null;
  /** AMS/CFS trays (Bambu); null means not applicable. */
  ams: AmsSlot[] | null;
}

export interface Webcam {
  name: string;
  /** Raw stream URL (may be relative; the UI resolves it). */
  stream: string;
  /** Raw snapshot URL (may be relative). */
  snapshot: string;
}

export function emptyStatus(): PrinterStatus {
  return {
    wsConnected: false,
    klippy: "disconnected",
    printState: "standby",
    filename: "",
    progress: 0,
    nozzleTemp: 0,
    nozzleTarget: 0,
    bedTemp: 0,
    bedTarget: 0,
    chamberTemp: null,
    currentLayer: null,
    totalLayers: null,
    printDuration: 0,
    totalDuration: 0,
    etaSeconds: null,
    light: null,
    filamentDetected: null,
    modelFan: null,
    auxFan: null,
    caseFan: null,
    stage: null,
    ams: null,
  };
}

/**
 * Common interface implemented by `MoonrakerClient` and `BambuClient`.
 * Keeps the printer view (main.ts) and the card decoupled from the protocol.
 */
export interface PrinterBackend {
  /** Base URL for HTTP calls (metadata, thumbnails). May be empty for Bambu. */
  readonly httpBase: string;

  onStatus(fn: (status: PrinterStatus) => void): () => void;
  connect(): void;
  dispose(): void;

  /** Change the target endpoint and reconnect (if different). */
  setEndpoint(host: string, port: number): void;

  // Printer controls (best-effort; implementations may reject if unsupported).
  pause(): Promise<unknown>;
  resume(): Promise<unknown>;
  cancel(): Promise<unknown>;
  home(): Promise<unknown>;
  setLight(on: boolean): Promise<unknown>;

  // Optional capabilities.
  getWebcam(): Promise<Webcam | null>;
  getPowerDevices(): Promise<string[]>;
  setPower(device: string, on: boolean): Promise<unknown>;
}
