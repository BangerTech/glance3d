// Bambu Lab client (local LAN MQTT).
//
// Mirrors the Moonraker client shape: a small protocol client that normalizes
// into `PrinterStatus` and drives card events. The actual MQTT socket lives
// in the Rust backend (see src-tauri/src/bambu.rs) because the printer uses
// TLS with a self-signed cert that the webview can't accept.
//
// Protocol notes (reconstructed from the publicly documented work in
// bambuddy and rolottr/bambu-bar):
//   * On connect we publish a `pushall` + `get_version` to receive a full
//     snapshot and the firmware module list (used for AMS type detection).
//   * Commands go to `device/{serial}/request`.
//     - print.command: pause | resume | stop | gcode_line | print_speed
//     - system.ledctrl: toggles chamber_light.
//   * `print.gcode_state`: IDLE | PREPARE | SLICING | RUNNING | PAUSE | FINISH | FAILED
//
// The full report parse lives in `src/bambu-report.ts` (ported from
// bambu-bar's ReportParser.swift). This client just owns the socket and feeds
// every incoming message into a `ReportDocument`.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  emptyStatus,
  type PrinterBackend,
  type PrinterStatus,
  type SpeedLevel,
  type Webcam,
} from "./backend";
import { ReportDocument, parseReport } from "./bambu-report";
import { findModel, type BambuModel } from "./bambu-models";

export class BambuClient implements PrinterBackend {
  private host: string;
  private serial: string;
  private accessCode: string;

  private doc = new ReportDocument();
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

  private model: BambuModel | null;

  constructor(host: string, serial: string, accessCode: string) {
    this.host = host;
    this.serial = serial;
    this.accessCode = accessCode;
    this.model = findModel("", serial);
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
    this.model = findModel("", serial);
    this.doc.reset();
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
    // Full snapshot...
    void this.publish({
      pushing: {
        command: "pushall",
        sequence_id: this.nextSeq(),
        version: 1,
        push_target: 1,
      },
    }).catch(() => {});
    // ...and the module list so AMS type detection has something to work with.
    void this.publish({
      info: { command: "get_version", sequence_id: this.nextSeq() },
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
    if (this.doc.apply(msg)) {
      this.emit();
    }
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

  setSpeed(level: SpeedLevel): Promise<unknown> {
    return this.publish({
      print: {
        command: "print_speed",
        param: String(level),
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
    if (!this.wsConnected) {
      const s = emptyStatus();
      s.wsConnected = false;
      s.klippy = "disconnected";
      return s;
    }
    return parseReport(this.doc, this.model, true);
  }
}
