// Bambu Lab MQTT `report` parser.
//
// Ported from bambu-bar's Sources/BambuBar/Printer/ReportParser.swift and
// the `ReportDocument` merge type (MIT, by NINA LABS).
//
// - `ReportDocument` keeps a merged picture of the `print` map: a full
//   `pushall`/`push_status` reply replaces the map; delta messages merge
//   recursively (and arrays keyed by `id`, or `lights_report` by `node`,
//   merge entry-by-entry). It also tracks firmware modules from
//   `get_version` so AMS types can be detected.
// - `parseReport(doc, model)` produces a fully-populated `PrinterStatus` with
//   model-aware temps/fans, AMS units (incl. AMS 3H 9-slot), external spool,
//   active slot, mounted hotend (H3C rack), stage text, speed, issues and
//   firmware version.

import {
  type AmsKind,
  type AmsSlot,
  type AmsUnit,
  type PrinterIssue,
  type PrinterStatus,
  type SpeedLevel,
  type IssueSeverity,
  emptyStatus,
} from "./backend";
import {
  type BambuModel,
  findModel,
  fitToModel,
  modelInfo,
} from "./bambu-models";
import { stageText } from "./bambu-stages";
import { errorText, hmsText } from "./hms-catalog";
import { colorName, preset as presetLookup } from "./filament-catalog";

// ---------------------------------------------------------------------------
// ReportDocument
// ---------------------------------------------------------------------------

export interface FirmwareModule {
  product: string;
  version: string;
}

/**
 * Merged view of a Bambu printer's MQTT reports. One `ReportDocument` per
 * printer; feed each incoming JSON message into `apply()`.
 */
export class ReportDocument {
  print: Record<string, any> = {};
  modules: Record<string, FirmwareModule> = {};
  hasFullReport = false;

  /**
   * Merge one message from `device/<serial>/report`. Returns true if the
   * print-state view changed.
   */
  apply(message: Record<string, any> | null | undefined): boolean {
    if (!message || typeof message !== "object") return false;
    let changed = false;

    const p = message.print;
    if (p && typeof p === "object") {
      const cmd = typeof p.command === "string" ? p.command : null;
      // Command acknowledgements echo the request back; only status pushes
      // actually describe the printer.
      if (cmd === null || cmd === "push_status") {
        const isFull = p.msg === 0 && p.gcode_state !== undefined;
        if (isFull) {
          // A full report replaces everything — stale AMS units and cleared
          // errors fall off.
          this.hasFullReport = true;
          this.print = { ...p };
        } else {
          this.print = mergeMaps(this.print, p);
        }
        changed = true;
      }
    }

    const info = message.info;
    if (
      info &&
      typeof info === "object" &&
      info.command === "get_version" &&
      Array.isArray(info.module)
    ) {
      for (const m of info.module) {
        if (!m || typeof m !== "object" || typeof m.name !== "string") continue;
        this.modules[m.name] = {
          product: typeof m.product_name === "string" ? m.product_name : "",
          version: typeof m.sw_ver === "string" ? m.sw_ver : "",
        };
      }
      changed = true;
    }

    return changed;
  }

  reset(): void {
    this.print = {};
    this.modules = {};
    this.hasFullReport = false;
  }
}

/** Recursive merge. See `ReportDocument` notes above. */
function mergeMaps(
  base: Record<string, any>,
  delta: Record<string, any>
): Record<string, any> {
  const out: Record<string, any> = { ...base };
  for (const [key, value] of Object.entries(delta)) {
    const idKey = key === "lights_report" ? "node" : "id";
    const oldValue = out[key];
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      oldValue &&
      typeof oldValue === "object" &&
      !Array.isArray(oldValue)
    ) {
      out[key] = mergeMaps(oldValue, value);
    } else if (
      Array.isArray(value) &&
      Array.isArray(oldValue) &&
      value.length > 0 &&
      value.every(
        (item) =>
          item && typeof item === "object" && item[idKey] !== undefined
      )
    ) {
      const merged = [...(oldValue as any[])];
      for (const item of value) {
        const id = String(item[idKey]);
        const i = merged.findIndex(
          (m) => m && typeof m === "object" && String(m[idKey] ?? "") === id
        );
        if (i >= 0) {
          merged[i] = mergeMaps(merged[i], item);
        } else {
          merged.push(item);
        }
      }
      out[key] = merged;
    } else {
      out[key] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// parseReport
// ---------------------------------------------------------------------------

/**
 * Build a `PrinterStatus` snapshot from the merged report. Pass the
 * configured model if known (or null to auto-detect from the serial / code
 * seen in the report).
 */
export function parseReport(
  doc: ReportDocument,
  explicitModel: BambuModel | null = null,
  wsConnected = true
): PrinterStatus {
  const s = emptyStatus();
  s.wsConnected = wsConnected;
  s.klippy = wsConnected ? "ready" : "disconnected";

  const p = doc.print;
  const device = (p?.device as Record<string, any> | undefined) ?? undefined;

  // Model — explicit beats auto-detected.
  const detected =
    explicitModel ?? findModel(str(p?.printer_type) ?? "", "");
  s.model = modelInfo(detected);

  // State / job
  const state = mapState(str(p?.gcode_state) ?? "IDLE");
  s.printState = state;

  // stg_cur — override to 255 (no stage) when idle with print_type=idle,
  // matching bambu-bar.
  let stageId = asInt(p?.stg_cur);
  if (stageId === null) {
    const nested = p?.stage as Record<string, any> | undefined;
    stageId = asInt(nested?._id);
  }
  if (
    stageId === 0 &&
    str(p?.print_type) === "idle" &&
    !isActiveState(state)
  ) {
    stageId = 255;
  }
  s.stageId = stageId;
  s.stage = stageText(stageId);

  s.filename = cleanJobName(
    str(p?.subtask_name) ?? "",
    str(p?.gcode_file) ?? ""
  );

  s.progress = clamp((asInt(p?.mc_percent) ?? 0) / 100, 0, 1);
  const remainingMin = Math.max(0, asInt(p?.mc_remaining_time) ?? 0);
  s.etaSeconds = remainingMin * 60;
  s.currentLayer = asInt(p?.layer_num);
  s.totalLayers = asInt(p?.total_layer_num);

  // Temperatures
  const extInfo = parseExtruders(device);
  const packedNozzle = asInt(extInfo.byId.get(0)?.temp);
  if (packedNozzle !== null) {
    const t = unpackTemp(packedNozzle);
    s.nozzleTemp = t.current;
    s.nozzleTarget = t.target;
  } else {
    s.nozzleTemp = asFloat(p?.nozzle_temper) ?? 0;
    s.nozzleTarget = asFloat(p?.nozzle_target_temper) ?? 0;
  }

  const bedBlock = (device?.bed as Record<string, any> | undefined)?.info as
    | Record<string, any>
    | undefined;
  const bedPacked = asInt(bedBlock?.temp) ?? asInt(device?.bed_temp);
  if (bedPacked !== null) {
    const t = unpackTemp(bedPacked);
    s.bedTemp = t.current;
    s.bedTarget = t.target;
  } else {
    s.bedTemp = asFloat(p?.bed_temper) ?? 0;
    s.bedTarget = asFloat(p?.bed_target_temper) ?? 0;
  }

  const ctcInfo = (device?.ctc as Record<string, any> | undefined)?.info as
    | Record<string, any>
    | undefined;
  const ctcPacked = asInt(ctcInfo?.temp);
  if (ctcPacked !== null) {
    const t = unpackTemp(ctcPacked);
    s.chamberTemp = t.current;
    s.chamberTarget = t.target;
  } else {
    const infoTemp = asFloat((p?.info as any)?.temp);
    const legacy = asFloat(p?.chamber_temper);
    const t = infoTemp ?? legacy;
    if (t !== null) {
      s.chamberTemp = t;
      // The X1E's heater target, in the older report format.
      s.chamberTarget = asFloat(p?.ctt);
    }
  }
  if (s.chamberTemp !== null && (s.chamberTemp <= 0 || s.chamberTemp > 120)) {
    s.chamberTemp = null;
    s.chamberTarget = null;
  }

  // Fans
  const airduct = (device?.airduct as Record<string, any> | undefined)?.parts;
  if (Array.isArray(airduct) && airduct.length > 0) {
    for (const part of airduct) {
      const id = asInt(part?.id);
      const state = asInt(part?.state);
      if (id === null || state === null) continue;
      const pct = clamp(state & 0xff, 0, 100);
      switch ((id >> 4) & 0xff) {
        case 1:
          s.modelFan = pct;
          break;
        case 2:
          s.auxFan = pct;
          break;
        case 3:
          s.caseFan = pct;
          break;
        // 10 (left-aux) and 15 (chamber) are H3C-specific; we fold them
        // into aux/case so they still show on the card.
        case 10:
          if (s.auxFan === null) s.auxFan = pct;
          break;
        case 15:
          if (s.caseFan === null) s.caseFan = pct;
          break;
      }
    }
  } else {
    s.modelFan = fanPercent(p?.cooling_fan_speed);
    s.auxFan = fanPercent(p?.big_fan1_speed);
    s.caseFan = fanPercent(p?.big_fan2_speed);
  }

  // Speed
  const spd = asInt(p?.spd_lvl);
  if (spd !== null && spd >= 1 && spd <= 4) {
    s.speed = spd as SpeedLevel;
  }

  // Light (chamber only; headlight, work etc. not exposed on this card)
  const lights = p?.lights_report;
  if (Array.isArray(lights)) {
    const chamber = lights.find(
      (l) => l && typeof l === "object" && l.node === "chamber_light"
    );
    if (chamber) {
      s.light = str(chamber.mode) !== "off";
    }
  }

  // Firmware (from get_version)
  s.firmware = doc.modules["ota"]?.version ?? null;

  // Tool mounted (H3C rack) — the nozzle entry whose id matches the printing
  // extruder; fall back to the first one.
  const nozzleBlock = device?.nozzle as Record<string, any> | undefined;
  const nozzles = Array.isArray(nozzleBlock?.info)
    ? (nozzleBlock!.info as any[])
    : [];
  const mounted =
    nozzles.find((n) => asInt(n?.id) === extInfo.current) ?? nozzles[0];
  if (mounted) {
    const diameter = asFloat(mounted.diameter);
    const type = str(mounted.type);
    const parts: string[] = [];
    if (diameter !== null && diameter > 0)
      parts.push(`${diameter.toFixed(1)} mm`);
    if (type) parts.push(type);
    s.toolMounted = parts.length ? parts.join(" ") : null;
  }

  // AMS + external spool + active slot
  parseFilament(p, device, doc, extInfo, s);

  // Issues (HMS + print_error)
  s.issues = parseIssues(p);

  // Model-fit: drop readings this printer can't produce.
  fitToModel(s, detected);

  return s;
}

// ---------------------------------------------------------------------------
// Filament
// ---------------------------------------------------------------------------

type ExtruderMap = { byId: Map<number, Record<string, any>>; current: number };

function parseExtruders(device: Record<string, any> | undefined): ExtruderMap {
  const root = device?.extruder as Record<string, any> | undefined;
  const byId = new Map<number, Record<string, any>>();
  const infoList = Array.isArray(root?.info) ? (root!.info as any[]) : [];
  infoList.forEach((e, i) => {
    if (!e || typeof e !== "object") return;
    const id = asInt(e.id) ?? i;
    byId.set(id, e);
  });
  const rawState = asInt(root?.state);
  const current = rawState !== null ? (rawState >> 4) & 0xf : 0;
  return { byId, current: byId.has(current) ? current : 0 };
}

const AMS_3H_BASE = 1024;
const AMS_B_BASE = 1056;
const EXTERNAL_ID = 254;

function parseFilament(
  p: Record<string, any> | undefined,
  device: Record<string, any> | undefined,
  doc: ReportDocument,
  ext: ExtruderMap,
  s: PrinterStatus
): void {
  const amsRoot = p?.ams as Record<string, any> | undefined;
  const units = Array.isArray(amsRoot?.ams) ? (amsRoot!.ams as any[]) : [];
  const existBits = parseHexBits(str(amsRoot?.tray_exist_bits));
  const rfidBits = parseHexBits(str(amsRoot?.tray_is_bbl_bits));

  const amsUnits: AmsUnit[] = [];
  for (const u of units) {
    if (!u || typeof u !== "object") continue;
    const id = asInt(u.id);
    if (id === null) continue;
    const typeInfo = amsType(id, str(u.info) ?? null, doc.modules);
    const kind = typeInfo.kind;
    const traysRaw = Array.isArray(u.tray) ? (u.tray as any[]) : [];
    const slots: AmsSlot[] = [];
    for (const t of traysRaw) {
      if (!t || typeof t !== "object") continue;
      const slot = asInt(t.id);
      if (slot === null) continue;
      const spool = spoolFrom(
        t,
        typeInfo.spoolId(id, slot),
        id,
        slot,
        kind
      );
      const bit = typeInfo.trayBit(id, slot);
      if (bit !== null && bit >= 0 && bit < 64) {
        const mask = BigInt(1) << BigInt(bit);
        if (existBits !== null && (existBits & mask) === BigInt(0)) {
          spool.isLoaded = false;
        }
        if (rfidBits !== null && (rfidBits & mask) === BigInt(0)) {
          spool.isBambu = false;
        }
      }
      describeSpool(spool);
      slots.push(spool);
    }
    slots.sort((a, b) => a.slot - b.slot);

    // Humidity — AMS 3H measures per zone; show the dampest.
    const zones = Array.isArray(u.zone_info) ? (u.zone_info as any[]) : [];
    const hasOwn = u.humidity_raw !== undefined || u.humidity !== undefined;
    const sensor =
      hasOwn || zones.length === 0
        ? u
        : zones.reduce(
            (max, z) =>
              (asInt(z?.humidity_raw) ?? -1) > (asInt(max?.humidity_raw) ?? -1)
                ? z
                : max,
            zones[0]
          );
    let humidity = asInt(sensor?.humidity_raw);
    if (humidity !== null && (humidity < 1 || humidity > 100)) humidity = null;
    let levelRaw = asInt(sensor?.humidity);
    if (levelRaw !== null && (levelRaw < 1 || levelRaw > 5)) levelRaw = null;
    // Bambu reports "1 (dry) to 5 (wet)" as 1=driest; bambu-bar inverts to
    // "1 (wet) to 5 (dry)" via `6 - raw`. Match that so the card can read it
    // as "fuller = drier".
    const humidityLevel = levelRaw !== null ? 6 - levelRaw : null;
    let temp = asFloat(sensor?.temp);
    if (temp !== null && (temp <= 0 || temp > 100)) temp = null;

    // AMS Lite has neither humidity nor temperature sensor; it reports
    // placeholders (`5`, `0.0`).
    const finalHumidity = kind === "lite" ? null : humidity;
    const finalLevel = kind === "lite" ? null : humidityLevel;
    const finalTemp = kind === "lite" ? null : temp;

    amsUnits.push({
      id,
      kind,
      title: unitTitle(id, kind),
      humidity: finalHumidity,
      humidityLevel: finalLevel,
      temperature: finalTemp,
      dryingMinutesLeft: asInt(u.dry_time) ?? 0,
      slots,
    });
  }
  amsUnits.sort((a, b) => a.id - b.id);
  s.ams = amsUnits.length ? amsUnits : null;

  // External spool (virtual slots `vir_slot`, else legacy `vt_tray`).
  const virSlots = Array.isArray(p?.vir_slot)
    ? (p!.vir_slot as any[])
    : null;
  const nozzles =
    (device?.nozzle as Record<string, any> | undefined)?.info;
  const mountedAddr = Array.isArray(nozzles)
    ? asInt((nozzles as any[]).find((n) => asInt(n?.id) === ext.current)?.addr_id)
    : null;
  const wanted = 255 - (mountedAddr ?? ext.current);
  const virtual =
    virSlots?.find((v) => asInt(v?.id) === wanted) ??
    virSlots?.[0] ??
    (p?.vt_tray as Record<string, any> | undefined);
  if (virtual) {
    const ext = spoolFrom(virtual, EXTERNAL_ID, 255, 0, "ams");
    ext.isLoaded = !!(str(virtual.tray_type) ?? "");
    // Nothing weighs the external spool; `remain` is a placeholder.
    ext.remain = null;
    ext.gramsLeft = null;
    ext.label = "Ext";
    describeSpool(ext);
    s.externalSpool = ext;
  }

  // Active spool: `snow` on the current extruder (newer firmware), else
  // AMS-level `tray_now`.
  const snow = asInt(ext.byId.get(ext.current)?.snow);
  if (snow !== null && snow !== 0xffff) {
    const unitId = snow >> 8;
    const slot = snow & 0xff;
    if (unitId >= 247 && unitId <= 255) {
      s.activeSpoolId = slot === 255 ? null : EXTERNAL_ID;
    } else {
      const unit = s.ams?.find((u) => u.id === unitId);
      const match = unit?.slots.find((sl) => sl.slot === slot);
      if (match) {
        s.activeSpoolId = match.id;
      } else if (unitId >= 128) {
        s.activeSpoolId = unitId;
      } else {
        s.activeSpoolId = unitId * 4 + (slot & 0x3);
      }
    }
  } else {
    const now = asInt(amsRoot?.tray_now);
    if (now !== null) {
      if (now === 255) s.activeSpoolId = null;
      else if (now === 254) s.activeSpoolId = EXTERNAL_ID;
      else s.activeSpoolId = now;
    }
  }

  // Clear and mark actives.
  if (s.activeSpoolId !== null && s.ams) {
    for (const unit of s.ams) {
      for (const slot of unit.slots) {
        slot.active = slot.id === s.activeSpoolId;
      }
    }
    if (s.externalSpool) {
      s.externalSpool.active = s.externalSpool.id === s.activeSpoolId;
    }
  }

  // Only meaningful while actually printing.
  if (
    !isActiveState(s.printState) &&
    s.activeSpoolId !== null &&
    activeSpool(s)?.isLoaded !== true
  ) {
    s.activeSpoolId = null;
  }
}

function activeSpool(s: PrinterStatus): AmsSlot | null {
  if (s.activeSpoolId === null) return null;
  if (s.activeSpoolId === EXTERNAL_ID) return s.externalSpool;
  for (const unit of s.ams ?? []) {
    for (const slot of unit.slots) {
      if (slot.id === s.activeSpoolId) return slot;
    }
  }
  return null;
}

function spoolFrom(
  t: Record<string, any>,
  id: number,
  unit: number,
  slot: number,
  kind: AmsKind
): AmsSlot {
  const material = str(t.tray_type) ?? "";
  const state = asInt(t.state);
  let loaded = material !== "";
  if (state !== null && state > 3) {
    loaded =
      ((state & 0x01) !== 0 && (state & 0x08) !== 0) || state === 9;
  }
  const colorRaw = str(t.tray_color) ?? "00000000";
  const color = normaliseHex(colorRaw);
  const colsRaw = Array.isArray(t.cols)
    ? (t.cols as any[]).filter((c) => typeof c === "string" && c.length >= 6)
    : [];
  const colors = colsRaw.length
    ? colsRaw.map((c) => normaliseHex(c as string))
    : [color];
  let remain = asInt(t.remain);
  if (remain !== null && (remain < 0 || remain > 100)) remain = null;
  let weight = asInt(t.tray_weight);
  if (weight !== null && (weight <= 0 || weight > 10000)) weight = null;
  const tag = str(t.tag_uid) ?? "";
  const isBambu = tag !== "" && !/^0+$/.test(tag);
  const presetId = str(t.tray_info_idx) || null;
  const nMin = asInt(t.nozzle_temp_min);
  const nMax = asInt(t.nozzle_temp_max);
  const spool: AmsSlot = {
    id,
    unit,
    slot,
    material: material || null,
    name: str(t.tray_sub_brands) || null,
    color,
    colors,
    remain,
    weight,
    gramsLeft:
      weight !== null && remain !== null && weight > 0
        ? Math.round((weight * remain) / 100)
        : null,
    active: false,
    isLoaded: loaded,
    isBambu,
    preset: presetId,
    brand: null,
    colorName: colorName(str(t.tray_id_name) ?? "", presetId, color),
    nozzleTempMin: nMin,
    nozzleTempMax: nMax && nMin && nMax >= nMin ? nMax : null,
    label: spoolLabel(id, unit, slot, kind),
  };
  return spool;
}

function describeSpool(spool: AmsSlot): void {
  if (!spool.isLoaded) {
    spool.material = null;
    spool.name = null;
    spool.remain = null;
    spool.gramsLeft = null;
    spool.weight = null;
    spool.brand = null;
    spool.colorName = null;
    spool.isBambu = false;
    return;
  }
  const info = spool.preset ? presetLookup(spool.preset) : null;
  spool.brand = spool.isBambu ? "Bambu Lab" : info?.vendor ?? null;
  if (
    (!spool.name || spool.name === "") &&
    info?.product &&
    info.product.toLowerCase() !== (spool.material ?? "").toLowerCase()
  ) {
    spool.name = info.product;
  }
}

function spoolLabel(
  id: number,
  unit: number,
  slot: number,
  _kind: AmsKind
): string {
  if (id === EXTERNAL_ID) return "Ext";
  if (id >= AMS_3H_BASE) return String(slot + 1);
  if (unit >= 128) return `HT${unit - 127}`;
  const letter = String.fromCharCode(65 + Math.min(unit, 25));
  return `${letter}${slot + 1}`;
}

function unitTitle(id: number, kind: AmsKind): string {
  const base: Record<AmsKind, string> = {
    ams: "AMS",
    lite: "AMS Lite",
    pro2: "AMS 2 Pro",
    ht: "AMS HT",
    ams3h: "AMS 3H",
    amsB: "AMS-B",
  };
  if (kind === "ams3h" || kind === "amsB") return base[kind];
  if (id >= 128) return `${base[kind]} ${id - 127}`;
  return `${base[kind]} ${String.fromCharCode(65 + Math.min(id, 25))}`;
}

type AmsTypeInfo = {
  kind: AmsKind;
  trayBit(unit: number, slot: number): number | null;
  spoolId(unit: number, slot: number): number;
};

function amsType(
  id: number,
  info: string | null,
  modules: Record<string, FirmwareModule>
): AmsTypeInfo {
  const typeNibble = info
    ? Number(BigInt("0x" + info) & BigInt(0xf))
    : null;

  if (typeNibble === 6 || modules[`n10a/${id}`]) return amsTypeInfo("ams3h");
  if (typeNibble === 7) return amsTypeInfo("amsB");
  if (typeNibble === 5) return amsTypeInfo("liteMixed");
  if (id >= 128 || modules[`n3s/${id}`]) return amsTypeInfo("ht");
  if (modules[`n3f/${id}`]) return amsTypeInfo("pro2");
  if (modules[`ams_f1/${id}`]) return amsTypeInfo("lite");
  if (modules[`ams/${id}`]) return amsTypeInfo("ams");
  switch (typeNibble) {
    case 2:
      return amsTypeInfo("lite");
    case 3:
      return amsTypeInfo("pro2");
    case 4:
      return amsTypeInfo("ht");
    default:
      return amsTypeInfo("ams");
  }
}

function amsTypeInfo(
  tag:
    | "ams"
    | "lite"
    | "liteMixed"
    | "pro2"
    | "ht"
    | "ams3h"
    | "amsB"
): AmsTypeInfo {
  const kind: AmsKind = tag === "liteMixed" ? "lite" : tag;
  return {
    kind,
    trayBit(unit, slot) {
      switch (tag) {
        case "ams":
        case "lite":
        case "pro2":
          return unit * 4 + slot;
        case "ht":
          return unit >= 128 ? 16 + (unit - 128) + slot : null;
        case "liteMixed":
          return 24 + slot;
        case "ams3h":
          return 28 + slot;
        case "amsB":
          return 37 + slot;
      }
    },
    spoolId(unit, slot) {
      switch (tag) {
        case "ht":
          return unit >= 128 ? unit : unit * 4 + slot;
        case "ams3h":
          return AMS_3H_BASE + slot;
        case "amsB":
          return AMS_B_BASE + slot;
        default:
          return unit * 4 + slot;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

function parseIssues(p: Record<string, any> | undefined): PrinterIssue[] {
  const out: PrinterIssue[] = [];
  const hms = Array.isArray(p?.hms) ? (p!.hms as any[]) : [];
  for (const entry of hms) {
    if (!entry || typeof entry !== "object") continue;
    const attr = asInt(entry.attr);
    const code = asInt(entry.code);
    if (attr === null || code === null) continue;
    const a = attr >>> 0;
    const c = code >>> 0;
    if ((c & 0xffff) < 0x4000 && c >>> 16 === 0) continue;
    const key = hex8(a) + hex8(c);
    const pretty =
      "HMS_" +
      hex4(a >>> 16) +
      "_" +
      hex4(a & 0xffff) +
      "_" +
      hex4(c >>> 16) +
      "_" +
      hex4(c & 0xffff);
    const sev = severityFromLevel(c >>> 16);
    out.push({
      id: pretty,
      severity: sev,
      message: hmsText(key) ?? `Der Drucker meldet ${pretty}.`,
      wikiURL: "https://wiki.bambulab.com/en/hms/home",
    });
  }
  const pe = asInt(p?.print_error);
  if (pe !== null && pe !== 0) {
    const e = pe >>> 0;
    const key = hex8(e);
    // 0300_400C / 0500_400E are the printer echoing a user cancel.
    if (key !== "0300400C" && key !== "0500400E") {
      const pretty = hex4(e >>> 16) + "_" + hex4(e & 0xffff);
      const level = (e & 0xf000) >>> 12;
      const sev: IssueSeverity =
        level === 0x4 ? "fatal" : level === 0x8 ? "serious" : "common";
      if (!out.some((i) => i.id.endsWith(pretty))) {
        out.push({
          id: pretty,
          severity: sev,
          message: errorText(key) ?? `Der Drucker meldet Fehler ${pretty}.`,
          wikiURL: "https://wiki.bambulab.com/en/hms/home",
        });
      }
    }
  }
  const order: Record<IssueSeverity, number> = {
    fatal: 1,
    serious: 2,
    common: 3,
    info: 4,
  };
  out.sort((a, b) => order[a.severity] - order[b.severity]);
  return out;
}

/** True when `print_error` is a user-cancel code. */
export function wasCanceled(doc: ReportDocument): boolean {
  const pe = asInt(doc.print.print_error);
  if (pe === null) return false;
  const key = hex8(pe >>> 0);
  return key === "0300400C" || key === "0500400E";
}

function severityFromLevel(level: number): IssueSeverity {
  switch (level) {
    case 1:
      return "fatal";
    case 2:
      return "serious";
    case 3:
      return "common";
    default:
      return "info";
  }
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

function mapState(raw: string): string {
  const s = raw.toUpperCase();
  switch (s) {
    case "RUNNING":
      return "printing";
    case "PAUSE":
      return "paused";
    case "FINISH":
      return "complete";
    case "FAILED":
      return "error";
    case "PREPARE":
    case "SLICING":
      return "printing";
    default:
      return "standby";
  }
}

function isActiveState(state: string): boolean {
  return state === "printing" || state === "paused";
}

function unpackTemp(packed: number): { current: number; target: number } {
  // Plain values (no target packed in) stay below 0x10000; a heater off
  // reports target 0.
  return {
    current: packed & 0xffff,
    target: (packed >> 16) & 0xffff,
  };
}

function fanPercent(v: unknown): number | null {
  const n = asInt(v);
  if (n === null) return null;
  if (n <= 15) return Math.round((n / 15) * 100);
  return Math.min(100, Math.round((n / 255) * 100));
}

function cleanJobName(name: string, file: string): string {
  let n = name.trim();
  if (n === "") {
    const base = file.split(/[\\/]/).pop() ?? "";
    if (base.startsWith("plate_")) n = "";
    else n = base;
  }
  for (const ext of [".gcode.3mf", ".3mf", ".gcode"]) {
    if (n.toLowerCase().endsWith(ext)) n = n.slice(0, -ext.length);
  }
  if (!n.includes(" ")) n = n.replace(/_/g, " ");
  return n;
}

function parseHexBits(v: string | null): bigint | null {
  if (!v) return null;
  try {
    return BigInt("0x" + v);
  } catch {
    return null;
  }
}

function normaliseHex(c: string): string {
  const clean = c.replace(/^#/, "").slice(0, 6);
  return "#" + clean.padEnd(6, "0");
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function asInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

function asFloat(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function str(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return null;
}

function hex4(n: number): string {
  return (n >>> 0).toString(16).padStart(4, "0").toUpperCase();
}

function hex8(n: number): string {
  return (n >>> 0).toString(16).padStart(8, "0").toUpperCase();
}
