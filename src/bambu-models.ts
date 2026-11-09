// Bambu Lab model catalog + capability fit.
//
// Ported from bambu-bar's Sources/Shared/PrinterModel.swift (MIT, by NINA LABS).
// The capability flags here let us hide readings a particular model can't
// produce (a P1S sends a chamber temperature without a sensor, an A1 sends
// zeroed-out aux/chamber fan fields, etc.) and let the H3C surface its
// AMS 3H and hotend rack correctly.

import type { PrinterModelInfo, PrinterStatus } from "./backend";

export interface BambuModel {
  /** Bambu's model id ("N10", "BL-P001", ...). */
  code: string;
  /** Marketing name ("H3C", "X1 Carbon", ...). */
  name: string;
  /** First three characters of the serial number. */
  serialPrefix: string;
  isEnclosed: boolean;
  hasChamberSensor: boolean;
  /** °C a heated-chamber model can heat to; null if not heated. */
  chamberHeaterMax: number | null;
  hasAuxFan: boolean;
  hasChamberFan: boolean;
  hasChamberLight: boolean;
  hasAMSHumidity: boolean;
  usesAMSLite: boolean;
  /** Number of nozzles (H2D/H2C/X2D = 2, others 1; the H3C has 1, fed from a rack). */
  nozzleCount: number;
}

/**
 * All known Bambu Lab consumer/prosumer models. Order doesn't matter;
 * `find()` scans linearly.
 */
export const BAMBU_MODELS: BambuModel[] = [
  { code: "N7", name: "P2S", serialPrefix: "22E", isEnclosed: true, hasChamberSensor: true, chamberHeaterMax: null, hasAuxFan: true, hasChamberFan: true, hasChamberLight: true, hasAMSHumidity: true, usesAMSLite: false, nozzleCount: 1 },
  { code: "C12", name: "P1S", serialPrefix: "01P", isEnclosed: true, hasChamberSensor: false, chamberHeaterMax: null, hasAuxFan: true, hasChamberFan: true, hasChamberLight: true, hasAMSHumidity: true, usesAMSLite: false, nozzleCount: 1 },
  { code: "C11", name: "P1P", serialPrefix: "01S", isEnclosed: false, hasChamberSensor: false, chamberHeaterMax: null, hasAuxFan: true, hasChamberFan: true, hasChamberLight: true, hasAMSHumidity: true, usesAMSLite: false, nozzleCount: 1 },
  { code: "BL-P001", name: "X1 Carbon", serialPrefix: "00M", isEnclosed: true, hasChamberSensor: true, chamberHeaterMax: null, hasAuxFan: true, hasChamberFan: true, hasChamberLight: true, hasAMSHumidity: true, usesAMSLite: false, nozzleCount: 1 },
  { code: "BL-P002", name: "X1", serialPrefix: "00W", isEnclosed: true, hasChamberSensor: true, chamberHeaterMax: null, hasAuxFan: true, hasChamberFan: true, hasChamberLight: true, hasAMSHumidity: true, usesAMSLite: false, nozzleCount: 1 },
  { code: "C13", name: "X1E", serialPrefix: "03W", isEnclosed: true, hasChamberSensor: true, chamberHeaterMax: 60, hasAuxFan: true, hasChamberFan: true, hasChamberLight: true, hasAMSHumidity: true, usesAMSLite: false, nozzleCount: 1 },
  { code: "N6", name: "X2D", serialPrefix: "20P", isEnclosed: true, hasChamberSensor: true, chamberHeaterMax: 65, hasAuxFan: true, hasChamberFan: true, hasChamberLight: true, hasAMSHumidity: true, usesAMSLite: false, nozzleCount: 2 },
  { code: "N2S", name: "A1", serialPrefix: "039", isEnclosed: false, hasChamberSensor: false, chamberHeaterMax: null, hasAuxFan: false, hasChamberFan: false, hasChamberLight: false, hasAMSHumidity: false, usesAMSLite: true, nozzleCount: 1 },
  { code: "N1", name: "A1 mini", serialPrefix: "030", isEnclosed: false, hasChamberSensor: false, chamberHeaterMax: null, hasAuxFan: false, hasChamberFan: false, hasChamberLight: false, hasAMSHumidity: false, usesAMSLite: true, nozzleCount: 1 },
  { code: "N9", name: "A2L", serialPrefix: "26A", isEnclosed: false, hasChamberSensor: false, chamberHeaterMax: null, hasAuxFan: false, hasChamberFan: false, hasChamberLight: false, hasAMSHumidity: false, usesAMSLite: false, nozzleCount: 1 },
  { code: "O1D", name: "H2D", serialPrefix: "094", isEnclosed: true, hasChamberSensor: true, chamberHeaterMax: 65, hasAuxFan: true, hasChamberFan: true, hasChamberLight: true, hasAMSHumidity: true, usesAMSLite: false, nozzleCount: 2 },
  { code: "O1E", name: "H2D Pro", serialPrefix: "239", isEnclosed: true, hasChamberSensor: true, chamberHeaterMax: 65, hasAuxFan: true, hasChamberFan: true, hasChamberLight: true, hasAMSHumidity: true, usesAMSLite: false, nozzleCount: 2 },
  { code: "O1C", name: "H2C", serialPrefix: "31B", isEnclosed: true, hasChamberSensor: true, chamberHeaterMax: 65, hasAuxFan: true, hasChamberFan: true, hasChamberLight: true, hasAMSHumidity: true, usesAMSLite: false, nozzleCount: 2 },
  { code: "N10", name: "H3C", serialPrefix: "32X", isEnclosed: true, hasChamberSensor: true, chamberHeaterMax: 65, hasAuxFan: true, hasChamberFan: true, hasChamberLight: true, hasAMSHumidity: true, usesAMSLite: false, nozzleCount: 1 },
  { code: "O1S", name: "H2S", serialPrefix: "093", isEnclosed: true, hasChamberSensor: true, chamberHeaterMax: 65, hasAuxFan: true, hasChamberFan: true, hasChamberLight: true, hasAMSHumidity: true, usesAMSLite: false, nozzleCount: 1 },
];

/** Older firmware, Pro and V2 variants whose SSDP id aliases a known model. */
export const BAMBU_MODEL_ALIASES: Record<string, string> = {
  "BL-P003": "C13",
  A12: "N1",
  A04: "N1",
  A11: "N2S",
  O2D: "O1E",
  O1C2: "O1C",
  "N6-V2": "N6",
  "N7-V2": "N7",
  "N10-V2": "N10",
  "O1C2-V2": "O1C",
  "O1D-V2": "O1D",
  "O1E-V2": "O1E",
  "O1S-V2": "O1S",
};

/**
 * Find a model by (code, serial). The serial prefix wins because setups
 * before bambu-bar 1.2 saved "N7" for printers typed in by hand, which
 * would name an A1 "P2S" everywhere.
 */
export function findModel(
  code: string,
  serial = ""
): BambuModel | null {
  const prefix = serial.slice(0, 3).toUpperCase();
  if (prefix) {
    const byPrefix = BAMBU_MODELS.find((m) => m.serialPrefix === prefix);
    if (byPrefix) return byPrefix;
  }
  const upper = (code ?? "").toUpperCase();
  if (!upper) return null;
  const id = BAMBU_MODEL_ALIASES[upper] ?? upper;
  return BAMBU_MODELS.find((m) => m.code === id) ?? null;
}

/** Short `{code,name}` form used in `PrinterStatus.model`. */
export function modelInfo(model: BambuModel | null): PrinterModelInfo | null {
  return model ? { code: model.code, name: model.name } : null;
}

/**
 * Null out readings the model has no sensor or fan for. Some firmware reports
 * placeholders there (a P1S sends a chamber temperature without a sensor, an
 * A1 sends fan fields it doesn't have).
 *
 * Called at the tail of the Bambu report parser.
 */
export function fitToModel(status: PrinterStatus, model: BambuModel | null): void {
  if (!model) return;
  if (!model.hasChamberSensor) {
    status.chamberTemp = null;
    status.chamberTarget = null;
  }
  if (model.chamberHeaterMax === null) {
    status.chamberTarget = null;
  }
  if (!model.hasAuxFan) {
    status.auxFan = null;
  }
  if (!model.hasChamberFan) {
    status.caseFan = null;
  }
  if (!model.hasChamberLight) {
    status.light = null;
  }
  if (!model.hasAMSHumidity && status.ams) {
    for (const unit of status.ams) {
      if (unit.kind === "lite") {
        unit.humidity = null;
        unit.humidityLevel = null;
      }
    }
  }
}
