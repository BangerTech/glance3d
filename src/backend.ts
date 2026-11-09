// Shared types for printer backends (Moonraker + Bambu).
//
// Both backend clients normalize printer state into a single `PrinterStatus`
// shape, so the <printer-card> UI doesn't care which protocol fed it. The
// extended Bambu fields (grouped AMS, grams, named colors, speed, issues,
// model, mounted hotend) are additive/optional; Moonraker simply leaves them
// null and the card renders nothing for them.

export type KlippyState =
  | "ready"
  | "startup"
  | "shutdown"
  | "error"
  | "disconnected";

// ---- AMS / spool model (Bambu) --------------------------------------------

/** AMS variant Bambu Studio distinguishes by the `info` nibble / module id. */
export type AmsKind = "ams" | "lite" | "pro2" | "ht" | "ams3h" | "amsB";

/**
 * A single filament slot: an AMS tray or the external spool holder.
 *
 * `id` is the global slot id used by the printer (`unit * 4 + slot` for
 * four-slot units, `128 + n` for AMS HT, `1024 + slot` for the H3C's AMS 3H,
 * `1056 + slot` for AMS-B, and 254 for the external spool).
 */
export interface AmsSlot {
  id: number;
  unit: number;
  /** 0-based tray index within its AMS unit. */
  slot: number;
  /** Material tag like "PLA" / "PETG"; empty when the slot is empty. */
  material: string | null;
  /** Full product name ("PLA Matte"); null for third-party spools. */
  name: string | null;
  /** Hex color like "#ff8800" (may include alpha); null if unknown. */
  color: string | null;
  /** Additional colors for multi-color spools (may be empty). */
  colors: string[];
  /** Remaining material 0..100, if the AMS reports it. */
  remain: number | null;
  /** Net filament weight of a full spool in grams (from the RFID tag). */
  weight: number | null;
  /** Grams left (`weight * remain / 100`), null when either input is unknown. */
  gramsLeft: number | null;
  /** True if this tray is currently feeding the hotend. */
  active: boolean;
  /** True if the slot has filament loaded. */
  isLoaded: boolean;
  /** True if the spool has a Bambu Lab RFID tag. */
  isBambu: boolean;
  /** Bambu Studio preset id like "GFA01", or null. */
  preset: string | null;
  /** Brand name ("Bambu Lab" for RFID, else from preset). */
  brand: string | null;
  /** Bambu's own color name ("Grass Green") when known. */
  colorName: string | null;
  /** Lowest nozzle temperature the filament is rated for. */
  nozzleTempMin: number | null;
  /** Highest nozzle temperature the filament is rated for. */
  nozzleTempMax: number | null;
  /** Human-readable slot label: "A1", "HT1", "Ext", or "1" for AMS 3H. */
  label: string;
}

/** One AMS unit (four-slot AMS, AMS Lite, AMS HT, AMS 3H, AMS-B). */
export interface AmsUnit {
  id: number;
  kind: AmsKind;
  /** Display title ("AMS A", "AMS 3H", "AMS HT1"). */
  title: string;
  /** Relative humidity (percent), null if unsupported. */
  humidity: number | null;
  /** 1 (dry) to 5 (wet), Bambu Studio's inverted scale. Null if unsupported. */
  humidityLevel: number | null;
  /** Unit temperature in °C; null if unsupported (Lite). */
  temperature: number | null;
  /** Remaining drying minutes; 0 when not drying. */
  dryingMinutesLeft: number;
  slots: AmsSlot[];
}

// ---- Issues ---------------------------------------------------------------

export type IssueSeverity = "fatal" | "serious" | "common" | "info";

export interface PrinterIssue {
  /** HMS code like "HMS_0300_0100_0001_0007" or print_error "0700_8006". */
  id: string;
  severity: IssueSeverity;
  message: string;
  wikiURL: string | null;
}

// ---- Model ----------------------------------------------------------------

export interface PrinterModelInfo {
  /** Bambu's model id ("N10", "BL-P001", ...). */
  code: string;
  /** Marketing name ("H3C", "X1 Carbon", ...). */
  name: string;
}

/** Bambu print-speed profile (`spd_lvl`). */
export type SpeedLevel = 1 | 2 | 3 | 4;

// ---- Normalized status ----------------------------------------------------

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
  /** Active chamber heater target (°C) on models that heat the chamber. */
  chamberTarget: number | null;
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
  /** Bambu printing substage, resolved to readable text when possible. */
  stage: string | null;
  /** Numeric stage id (Bambu `stg_cur`), or null. */
  stageId: number | null;
  /** AMS/CFS units (Bambu); null means not applicable (e.g. Moonraker). */
  ams: AmsUnit[] | null;
  /** External-spool holder as a pseudo slot, when present. */
  externalSpool: AmsSlot | null;
  /** Global id of the slot feeding the hotend right now, if known. */
  activeSpoolId: number | null;
  /** Current print-speed profile (Bambu), null when unknown. */
  speed: SpeedLevel | null;
  /** Bambu HMS + print_error issues. */
  issues: PrinterIssue[];
  /** Detected Bambu model (null for Moonraker or unknown). */
  model: PrinterModelInfo | null;
  /** The hotend mounted on the active extruder (H3C rack), e.g. "0.4 mm H". */
  toolMounted: string | null;
  /** Firmware version string, when reported. */
  firmware: string | null;
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
    chamberTarget: null,
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
    stageId: null,
    ams: null,
    externalSpool: null,
    activeSpoolId: null,
    speed: null,
    issues: [],
    model: null,
    toolMounted: null,
    firmware: null,
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
  /** Bambu print-speed profile. Moonraker ignores this. */
  setSpeed?(level: SpeedLevel): Promise<unknown>;

  // Optional capabilities.
  getWebcam(): Promise<Webcam | null>;
  getPowerDevices(): Promise<string[]>;
  setPower(device: string, on: boolean): Promise<unknown>;
}
