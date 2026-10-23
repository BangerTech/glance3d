// Moonraker JSON-RPC-over-WebSocket client.
// Mirrors what OrcaSlicer's MoonrakerPrinterAgent does: connect to
// ws://<host>:7125/websocket, identify, then printer.objects.subscribe and
// consume notify_status_update events into a merged status cache.
//
// The actual socket lives in the Rust backend (see src-tauri/src/ws.rs): the
// packaged webview origin is not allowed by Moonraker's CORS, so we proxy the
// connection through Rust (which sends no Origin header and is accepted via
// trusted_clients). This module talks to that proxy via Tauri invoke/events.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type KlippyState =
  | "ready"
  | "startup"
  | "shutdown"
  | "error"
  | "disconnected";

export interface PrinterStatus {
  wsConnected: boolean;
  klippy: KlippyState;
  /** Raw print_stats.state: standby | printing | paused | complete | cancelled | error */
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
  printDuration: number; // seconds
  totalDuration: number; // seconds
  etaSeconds: number | null;
  light: boolean | null;
  filamentDetected: boolean | null;
  modelFan: number | null; // part/model cooling fan, 0..100
  auxFan: number | null; // side/aux fan, 0..100
  caseFan: number | null; // case/enclosure fan, 0..100
}

export interface Webcam {
  name: string;
  /** Raw stream_url from Moonraker (may be relative, e.g. "/webcam/?action=stream"). */
  stream: string;
  /** Raw snapshot_url from Moonraker (may be relative). */
  snapshot: string;
}

const SUBSCRIBE_OBJECTS: Record<string, null> = {
  print_stats: null,
  virtual_sdcard: null,
  extruder: null,
  heater_bed: null,
  display_status: null,
  toolhead: null,
  idle_timeout: null,
  gcode_move: null,
  "temperature_sensor chamber_temp": null,
  "output_pin LED": null,
  "output_pin fan0": null,
  "output_pin fan1": null,
  "output_pin fan2": null,
  "filament_switch_sensor filament_sensor": null,
};

type StatusListener = (status: PrinterStatus) => void;

interface Pending {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
}

export class MoonrakerClient {
  private host: string;
  private port: number;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private cache: Record<string, any> = {};
  private klippy: KlippyState = "disconnected";
  private wsConnected = false;
  private listeners = new Set<StatusListener>();
  private reconnectTimer: number | null = null;
  private reconnectDelay = 1000;
  private closedByUser = false;

  // Rust-proxy plumbing.
  private activeGen = -1;
  private open = false;
  private listenersReady: Promise<void> | null = null;
  private unlisten: UnlistenFn[] = [];

  constructor(host: string, port: number) {
    this.host = host;
    this.port = port;
  }

  onStatus(fn: StatusListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get httpBase(): string {
    return `http://${this.host}:${this.port}`;
  }

  connect(): void {
    this.closedByUser = false;
    void this.doConnect();
  }

  setEndpoint(host: string, port: number): void {
    if (host === this.host && port === this.port) return;
    this.host = host;
    this.port = port;
    this.reconnectDelay = 1000;
    void this.doConnect();
  }

  dispose(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.open = false;
    void invoke("ws_disconnect").catch(() => {});
    for (const u of this.unlisten) u();
    this.unlisten = [];
    this.listenersReady = null;
  }

  private ensureListeners(): Promise<void> {
    if (this.listenersReady) return this.listenersReady;
    this.listenersReady = (async () => {
      this.unlisten.push(
        await listen<number>("moonraker://open", (e) => {
          if (e.payload !== this.activeGen) return;
          void this.onOpen();
        })
      );
      this.unlisten.push(
        await listen<string>("moonraker://message", (e) => {
          this.handleMessage(e.payload);
        })
      );
      this.unlisten.push(
        await listen<number>("moonraker://closed", (e) => {
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
    try {
      await this.ensureListeners();
      const url = `ws://${this.host}:${this.port}/websocket`;
      this.activeGen = await invoke<number>("ws_connect", { url });
    } catch (err) {
      console.error("ws_connect failed", err);
      this.scheduleReconnect();
    }
  }

  private async onOpen(): Promise<void> {
    this.open = true;
    this.wsConnected = true;
    this.reconnectDelay = 1000;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      await this.handshake();
    } catch (err) {
      console.error("Moonraker handshake failed", err);
    }
    this.emit();
  }

  private onClosed(): void {
    this.open = false;
    this.wsConnected = false;
    this.klippy = "disconnected";
    this.rejectAllPending(new Error("socket closed"));
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

  private async handshake(): Promise<void> {
    await this.call("server.connection.identify", {
      client_name: "orca-widget",
      version: "0.1.0",
      type: "other",
      url: "https://github.com/BangerTech/Prism-Dashboard",
    });

    try {
      const info = await this.call("server.info");
      this.klippy = (info?.klippy_state as KlippyState) ?? "disconnected";
    } catch {
      /* ignore */
    }

    const sub = await this.call("printer.objects.subscribe", {
      objects: SUBSCRIBE_OBJECTS,
    });
    if (sub?.status) {
      this.mergeStatus(sub.status);
    }
    this.emit();
  }

  private handleMessage(data: string): void {
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(msg.error);
      else p.resolve(msg.result);
      return;
    }

    switch (msg.method) {
      case "notify_status_update":
        if (Array.isArray(msg.params) && msg.params[0]) {
          this.mergeStatus(msg.params[0]);
          this.emit();
        }
        break;
      case "notify_klippy_ready":
        this.klippy = "ready";
        // Re-subscribe after Klipper restart so we get fresh objects.
        this.call("printer.objects.subscribe", { objects: SUBSCRIBE_OBJECTS })
          .then((r) => {
            if (r?.status) this.mergeStatus(r.status);
            this.emit();
          })
          .catch(() => {});
        this.emit();
        break;
      case "notify_klippy_shutdown":
        this.klippy = "shutdown";
        this.emit();
        break;
      case "notify_klippy_disconnected":
        this.klippy = "disconnected";
        this.emit();
        break;
    }
  }

  private mergeStatus(update: Record<string, any>): void {
    for (const [key, value] of Object.entries(update)) {
      this.cache[key] = { ...(this.cache[key] ?? {}), ...(value ?? {}) };
    }
  }

  private call(method: string, params?: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.open) {
        reject(new Error("socket not open"));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const text = JSON.stringify({
        jsonrpc: "2.0",
        method,
        params: params ?? {},
        id,
      });
      invoke("ws_send", { text }).catch((err) => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(err);
        }
      });
      // Safety timeout so a lost response does not leak a pending entry.
      window.setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, 10000);
    });
  }

  private rejectAllPending(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  // ---- Controls ----

  pause(): Promise<any> {
    return this.call("printer.print.pause");
  }

  resume(): Promise<any> {
    return this.call("printer.print.resume");
  }

  cancel(): Promise<any> {
    return this.call("printer.print.cancel");
  }

  home(): Promise<any> {
    return this.call("printer.gcode.script", { script: "G28" });
  }

  setLight(on: boolean): Promise<any> {
    return this.call("printer.gcode.script", {
      script: `SET_PIN PIN=LED VALUE=${on ? 1 : 0}`,
    });
  }

  /** Returns the first configured webcam's raw stream/snapshot URLs, or null. */
  async getWebcam(): Promise<Webcam | null> {
    try {
      const res = await this.call("server.webcams.list");
      const cams: any[] = res?.webcams ?? [];
      if (!cams.length) return null;
      const cam = cams[0];
      const stream: string = cam.stream_url ?? "";
      if (!stream) return null;
      return {
        name: cam.name ?? "Camera",
        stream,
        snapshot: cam.snapshot_url ?? "",
      };
    } catch {
      return null;
    }
  }

  /** Returns configured power device names, or [] if the component is disabled. */
  async getPowerDevices(): Promise<string[]> {
    try {
      const res = await this.call("machine.device_power.devices");
      const devices: any[] = res?.devices ?? [];
      return devices.map((d) => d.device).filter(Boolean);
    } catch {
      return [];
    }
  }

  setPower(device: string, on: boolean): Promise<any> {
    return this.call("machine.device_power.post_device", {
      device,
      action: on ? "on" : "off",
    });
  }

  // ---- Normalization ----

  private emit(): void {
    const status = this.buildStatus();
    for (const fn of this.listeners) fn(status);
  }

  private buildStatus(): PrinterStatus {
    const c = this.cache;
    const printStats = c["print_stats"] ?? {};
    const vsd = c["virtual_sdcard"] ?? {};
    const extruder = c["extruder"] ?? {};
    const bed = c["heater_bed"] ?? {};
    const display = c["display_status"] ?? {};
    const chamber = c["temperature_sensor chamber_temp"] ?? {};
    const led = c["output_pin LED"] ?? {};
    const fan0 = c["output_pin fan0"];
    const fan1 = c["output_pin fan1"];
    const fan2 = c["output_pin fan2"];
    const fil = c["filament_switch_sensor filament_sensor"] ?? {};

    const progress =
      typeof vsd.progress === "number"
        ? vsd.progress
        : typeof display.progress === "number"
          ? display.progress
          : 0;

    const printDuration =
      typeof printStats.print_duration === "number"
        ? printStats.print_duration
        : 0;
    const totalDuration =
      typeof printStats.total_duration === "number"
        ? printStats.total_duration
        : 0;

    const printState: string = printStats.state ?? "standby";

    let etaSeconds: number | null = null;
    if (printState === "printing" && progress > 0.001) {
      etaSeconds = Math.max(0, (printDuration * (1 - progress)) / progress);
    }

    const info = printStats.info ?? {};

    return {
      wsConnected: this.wsConnected,
      klippy: this.klippy,
      printState,
      filename: printStats.filename ?? "",
      progress: Math.min(1, Math.max(0, progress)),
      nozzleTemp: num(extruder.temperature),
      nozzleTarget: num(extruder.target),
      bedTemp: num(bed.temperature),
      bedTarget: num(bed.target),
      chamberTemp:
        typeof chamber.temperature === "number" ? chamber.temperature : null,
      currentLayer:
        typeof info.current_layer === "number" ? info.current_layer : null,
      totalLayers:
        typeof info.total_layer === "number" ? info.total_layer : null,
      printDuration,
      totalDuration,
      etaSeconds,
      light: typeof led.value === "number" ? led.value > 0 : null,
      filamentDetected:
        typeof fil.filament_detected === "boolean"
          ? fil.filament_detected
          : null,
      modelFan: fanPercent(fan0),
      auxFan: fanPercent(fan1),
      caseFan: fanPercent(fan2),
    };
  }
}

function fanPercent(obj: any): number | null {
  if (obj && typeof obj.value === "number") return Math.round(obj.value * 100);
  return null;
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
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
  };
}
