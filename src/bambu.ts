// Bambu Lab client (local LAN MQTT).
//
// Mirrors the Moonraker client shape: a small protocol client that normalizes
// into `PrinterStatus` and drives card events. The actual MQTT socket lives
// in the Rust backend (see src-tauri/src/bambu.rs) because the printer uses
// TLS with a self-signed cert that the webview can't accept.
//
// Protocol notes (reconstructed from publicly documented work like bambuddy):
//   * On connect, we must publish a `pushall` to receive a full snapshot;
//     everything after that is delta updates on `device/{serial}/report`.
//   * Commands go to `device/{serial}/request`.
//     - print.command: pause | resume | stop | gcode_line (param = "G28\n")
//     - system.ledctrl: toggles chamber_light.
//   * `print.gcode_state`: IDLE | PREPARE | SLICING | RUNNING | PAUSE | FINISH | FAILED
//   * Fan speeds are reported as either 0..15 gears or percent; we normalize.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  emptyStatus,
  type AmsSlot,
  type PrinterBackend,
  type PrinterStatus,
  type Webcam,
} from "./backend";

export class BambuClient implements PrinterBackend {
  private host: string;
  private serial: string;
  private accessCode: string;

  private cache: Record<string, any> = {};
  private listeners = new Set<(status: PrinterStatus) => void>();

  private activeGen = -1;
  private open = false;
  private wsConnected = false;
  private closedByUser = false;
  private reconnectTimer: number | null = null;
  private reconnectDelay = 1000;
  private seq = 1000;
  private unlisten: UnlistenFn[] = [];
  private listenersReady: Promise<void> | null = null;

  constructor(host: string, serial: string, accessCode: string) {
    this.host = host;
    this.serial = serial;
    this.accessCode = accessCode;
  }

  get httpBase(): string {
    // Bambu's local HTTP endpoint is not useful for us; return a plausible base.
    return `http://${this.host}`;
  }

  onStatus(fn: (status: PrinterStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  connect(): void {
    this.closedByUser = false;
    void this.doConnect();
  }

  dispose(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.open = false;
    this.wsConnected = false;
    void invoke("bambu_disconnect").catch(() => {});
    for (const u of this.unlisten) u();
    this.unlisten = [];
    this.listenersReady = null;
  }

  /** Changes the IP/hostname and reconnects. Port is ignored (always 8883). */
  setEndpoint(host: string, _port: number): void {
    if (host === this.host) return;
    this.host = host;
    this.reconnectDelay = 1000;
    void this.doConnect();
  }

  /** Bambu-specific: update credentials and reconnect. */
  setCredentials(serial: string, accessCode: string): void {
    if (serial === this.serial && accessCode === this.accessCode) return;
    this.serial = serial;
    this.accessCode = accessCode;
    this.reconnectDelay = 1000;
    void this.doConnect();
  }

  // ---- Event plumbing ----

  private ensureListeners(): Promise<void> {
    if (this.listenersReady) return this.listenersReady;
    this.listenersReady = (async () => {
      this.unlisten.push(
        await listen<number>("bambu://open", (e) => {
          if (e.payload !== this.activeGen) return;
          this.onOpen();
        })
      );
      this.unlisten.push(
        await listen<string>("bambu://message", (e) => {
          this.handleMessage(e.payload);
        })
      );
      this.unlisten.push(
        await listen<number>("bambu://closed", (e) => {
          if (e.payload !== this.activeGen) return;
          this.onClosed();
        })
      );
    })();
    return this.listenersReady;
  }

  private async doConnect(): Promise<void> {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!this.host || !this.serial || !this.accessCode) {
      this.wsConnected = false;
      this.open = false;
      this.emit();
      return;
    }
    try {
      await this.ensureListeners();
      this.activeGen = await invoke<number>("bambu_connect", {
        ip: this.host,
        serial: this.serial,
        accessCode: this.accessCode,
      });
    } catch (err) {
      console.error("bambu_connect failed", err);
      this.scheduleReconnect();
    }
  }

  private onOpen(): void {
    this.open = true;
    this.wsConnected = true;
    this.reconnectDelay = 1000;
    // Request a full snapshot. Without this, only deltas arrive and the UI
    // would start out blank.
    void this.publish({
      pushing: {
        command: "pushall",
        sequence_id: this.nextSeq(),
        version: 1,
        push_target: 1,
      },
    }).catch(() => {});
    this.emit();
  }

  private onClosed(): void {
    this.open = false;
    this.wsConnected = false;
    this.emit();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closedByUser) return;
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.doConnect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10000);
  }

  private handleMessage(data: string): void {
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (msg.print && typeof msg.print === "object") {
      this.cache = { ...this.cache, ...msg.print };
    }
    if (msg.system && typeof msg.system === "object") {
      if (Array.isArray(msg.system.lights_report)) {
        this.cache.lights_report = msg.system.lights_report;
      }
    }
    this.emit();
  }

  private publish(obj: unknown): Promise<unknown> {
    if (!this.open) return Promise.reject(new Error("not connected"));
    return invoke("bambu_send", { text: JSON.stringify(obj) });
  }

  private nextSeq(): string {
    return String(this.seq++);
  }

  // ---- Controls ----

  pause(): Promise<unknown> {
    return this.publish({
      print: { command: "pause", sequence_id: this.nextSeq(), param: "" },
    });
  }

  resume(): Promise<unknown> {
    return this.publish({
      print: { command: "resume", sequence_id: this.nextSeq(), param: "" },
    });
  }

  cancel(): Promise<unknown> {
    return this.publish({
      print: { command: "stop", sequence_id: this.nextSeq(), param: "" },
    });
  }

  home(): Promise<unknown> {
    return this.publish({
      print: {
        command: "gcode_line",
        sequence_id: this.nextSeq(),
        param: "G28\n",
      },
    });
  }

  setLight(on: boolean): Promise<unknown> {
    return this.publish({
      system: {
        command: "ledctrl",
        led_node: "chamber_light",
        led_mode: on ? "on" : "off",
        led_on_time: 500,
        led_off_time: 500,
        loop_times: 0,
        interval_time: 0,
        sequence_id: this.nextSeq(),
      },
    });
  }

  /** No webcam over MQTT; RTSP support is a separate phase (ffmpeg sidecar). */
  async getWebcam(): Promise<Webcam | null> {
    return null;
  }

  async getPowerDevices(): Promise<string[]> {
    return [];
  }

  async setPower(_device: string, _on: boolean): Promise<unknown> {
    return;
  }

  // ---- Normalization ----

  private emit(): void {
    const status = this.buildStatus();
    for (const fn of this.listeners) fn(status);
  }

  private buildStatus(): PrinterStatus {
    const c = this.cache;
    const s = emptyStatus();
    s.wsConnected = this.wsConnected;
    s.klippy = this.wsConnected ? "ready" : "disconnected";

    s.printState = mapState(c.gcode_state);
    s.filename =
      (typeof c.subtask_name === "string" && c.subtask_name) ||
      (typeof c.gcode_file === "string" ? c.gcode_file : "");

    const pct = typeof c.mc_percent === "number" ? c.mc_percent : 0;
    s.progress = Math.min(1, Math.max(0, pct / 100));

    s.nozzleTemp = numeric(c.nozzle_temper);
    s.nozzleTarget = numeric(c.nozzle_target_temper);
    s.bedTemp = numeric(c.bed_temper);
    s.bedTarget = numeric(c.bed_target_temper);
    s.chamberTemp =
      typeof c.chamber_temper === "number" ? c.chamber_temper : null;

    s.currentLayer =
      typeof c.layer_num === "number" ? c.layer_num : null;
    s.totalLayers =
      typeof c.total_layer_num === "number" ? c.total_layer_num : null;

    const remainMin =
      typeof c.mc_remaining_time === "number" ? c.mc_remaining_time : null;
    s.etaSeconds = remainMin !== null ? Math.max(0, remainMin * 60) : null;

    s.modelFan = fanToPercent(c.cooling_fan_speed);
    s.auxFan = fanToPercent(c.big_fan1_speed);
    s.caseFan = fanToPercent(c.big_fan2_speed);

    const lights = Array.isArray(c.lights_report) ? c.lights_report : [];
    const chamber = lights.find(
      (l: any) => l && l.node === "chamber_light"
    );
    s.light = chamber ? chamber.mode === "on" : null;

    s.stage =
      typeof c.mc_print_stage === "string"
        ? c.mc_print_stage
        : typeof c.stg_cur === "number"
          ? `stage ${c.stg_cur}`
          : null;

    s.ams = parseAms(c.ams);

    return s;
  }
}

function numeric(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function mapState(raw: unknown): string {
  const s = typeof raw === "string" ? raw.toUpperCase() : "";
  switch (s) {
    case "RUNNING":
    case "PRINTING":
      return "printing";
    case "PAUSE":
    case "PAUSED":
      return "paused";
    case "FINISH":
    case "FINISHED":
    case "SUCCESS":
      return "complete";
    case "FAILED":
    case "ERROR":
      return "error";
    case "PREPARE":
    case "PREPARING":
    case "SLICING":
      return "printing";
    default:
      return "standby";
  }
}

/**
 * Bambu reports fan speed either as a 0..15 "gear" or as a percent. We treat
 * values <=15 as gear and scale, otherwise clamp as percent.
 */
function fanToPercent(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  if (n <= 15) return Math.round((n / 15) * 100);
  return Math.max(0, Math.min(100, Math.round(n)));
}

function parseAms(ams: any): AmsSlot[] | null {
  if (!ams || typeof ams !== "object") return null;
  const units = Array.isArray(ams.ams) ? ams.ams : [];
  if (!units.length) return null;
  const active = typeof ams.tray_now === "string" ? ams.tray_now : null;

  const slots: AmsSlot[] = [];
  for (const unit of units) {
    const trays = Array.isArray(unit?.tray) ? unit.tray : [];
    const unitId = Number(unit?.id ?? 0);
    for (const tray of trays) {
      const idx = Number(tray?.id ?? 0);
      const globalId = unitId * 4 + idx;
      const color =
        typeof tray?.tray_color === "string" && tray.tray_color
          ? "#" + tray.tray_color.replace(/^#/, "").slice(0, 6)
          : null;
      slots.push({
        index: globalId,
        color,
        material:
          typeof tray?.tray_type === "string" ? tray.tray_type : null,
        active: active !== null && active === String(globalId),
        remaining:
          typeof tray?.remain === "number" ? tray.remain : null,
      });
    }
  }
  return slots.length ? slots : null;
}
