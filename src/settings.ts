import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { PrinterInstance, PrinterType } from "./config";

export interface SettingsSaveDetail {
  // Per-printer fields.
  name: string;
  type: PrinterType;
  host: string;
  port: number;
  bambuSerial?: string;
  bambuAccessCode?: string;
  cameraUrl: string;
  showThumbnail: boolean;
  onlyWhenPrinting: boolean;
  // Global toggles.
  alwaysOnTop: boolean;
  autostart: boolean;
}

@customElement("settings-panel")
export class SettingsPanel extends LitElement {
  /** The printer this window represents (the one being edited). */
  @property({ attribute: false }) printer!: PrinterInstance;

  /** Full printer list (for the "Other printers" section). */
  @property({ attribute: false }) printers: PrinterInstance[] = [];

  /** Globals shared across all windows. */
  @property({ attribute: false }) globals: {
    alwaysOnTop: boolean;
    autostart: boolean;
  } = { alwaysOnTop: true, autostart: false };

  // --- Form state (initialized from `printer`/`globals` in connectedCallback) ---
  @state() private name = "";
  @state() private type: PrinterType = "moonraker";
  @state() private host = "";
  @state() private port = 7125;
  @state() private bambuSerial = "";
  @state() private bambuAccessCode = "";
  @state() private cameraUrl = "";
  @state() private showThumbnail = true;
  @state() private onlyWhenPrinting = false;
  @state() private alwaysOnTop = true;
  @state() private autostart = false;

  static styles = css`
    :host {
      position: absolute;
      inset: 0;
      z-index: 10;
      display: block;
      font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
      color: #e7ecf3;
    }
    .panel {
      position: absolute;
      inset: 0;
      box-sizing: border-box;
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 9px;
      overflow-y: auto;
      border-radius: 18px;
      background: linear-gradient(
        160deg,
        rgba(24, 28, 38, 0.96),
        rgba(14, 17, 24, 0.98)
      );
      backdrop-filter: blur(22px);
      -webkit-backdrop-filter: blur(22px);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    h2 {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
    }
    h3 {
      margin: 10px 0 2px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      opacity: 0.55;
    }
    label {
      font-size: 11px;
      opacity: 0.7;
      display: block;
      margin-bottom: 3px;
    }
    .row {
      display: flex;
      gap: 8px;
    }
    .field {
      flex: 1 1 0;
    }
    input[type="text"],
    input[type="number"],
    input[type="password"],
    select {
      width: 100%;
      box-sizing: border-box;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 8px;
      color: #fff;
      padding: 6px 8px;
      font-size: 12px;
      outline: none;
    }
    input:focus,
    select:focus {
      border-color: rgba(59, 130, 246, 0.7);
    }
    .toggle {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      cursor: pointer;
    }
    .toggle input {
      accent-color: #3b82f6;
    }
    .hint {
      font-size: 10px;
      line-height: 1.35;
      opacity: 0.55;
      margin-top: -2px;
    }
    .printer-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .printer-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.04);
      font-size: 12px;
    }
    .printer-row.me {
      background: rgba(59, 130, 246, 0.14);
      border: 1px solid rgba(59, 130, 246, 0.3);
    }
    .printer-row .meta {
      flex: 1 1 auto;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .printer-row .meta .type {
      font-size: 10px;
      opacity: 0.6;
    }
    .add-row {
      display: flex;
      gap: 6px;
    }
    .actions {
      margin-top: auto;
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }
    button {
      border-radius: 9px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(255, 255, 255, 0.06);
      color: #e7ecf3;
      font-size: 12px;
      padding: 6px 12px;
      cursor: pointer;
    }
    button.primary {
      background: linear-gradient(90deg, #2563eb, #3b82f6);
      border-color: transparent;
      color: #fff;
      font-weight: 600;
    }
    button.danger {
      border-color: rgba(239, 68, 68, 0.4);
      color: #fecaca;
    }
    button:hover {
      filter: brightness(1.1);
    }
    .mini {
      padding: 3px 8px;
      font-size: 11px;
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.name = this.printer.name;
    this.type = this.printer.type;
    this.host = this.printer.host;
    this.port = this.printer.port;
    this.bambuSerial = this.printer.bambuSerial ?? "";
    this.bambuAccessCode = this.printer.bambuAccessCode ?? "";
    this.cameraUrl = this.printer.cameraUrl ?? "";
    this.showThumbnail = this.printer.showThumbnail;
    this.onlyWhenPrinting = this.printer.onlyWhenPrinting;
    this.alwaysOnTop = this.globals.alwaysOnTop;
    this.autostart = this.globals.autostart;
  }

  render() {
    const isBambu = this.type === "bambu";
    return html`
      <div class="panel">
        <h2>Einstellungen</h2>

        <div class="field">
          <label>Name</label>
          <input
            type="text"
            .value=${this.name}
            @input=${(e: Event) =>
              (this.name = (e.target as HTMLInputElement).value)}
            placeholder="Mein Drucker"
          />
        </div>

        <div class="row">
          <div class="field">
            <label>Typ</label>
            <select
              .value=${this.type}
              @change=${(e: Event) =>
                (this.type = (e.target as HTMLSelectElement)
                  .value as PrinterType)}
            >
              <option value="moonraker">Creality / Moonraker</option>
              <option value="bambu">Bambu Lab (LAN)</option>
            </select>
          </div>
        </div>

        <div class="row">
          <div class="field" style="flex: 3 1 0">
            <label>Drucker-IP / Host</label>
            <input
              type="text"
              .value=${this.host}
              @input=${(e: Event) =>
                (this.host = (e.target as HTMLInputElement).value.trim())}
              placeholder=${isBambu ? "192.168.2.1" : "192.168.2.240"}
            />
          </div>
          ${isBambu
            ? nothing
            : html`<div class="field">
                <label>Port</label>
                <input
                  type="number"
                  .value=${String(this.port)}
                  @input=${(e: Event) =>
                    (this.port =
                      Number((e.target as HTMLInputElement).value) || 7125)}
                />
              </div>`}
        </div>

        ${isBambu
          ? html`
              <div class="field">
                <label>Serial (Bambu)</label>
                <input
                  type="text"
                  .value=${this.bambuSerial}
                  @input=${(e: Event) =>
                    (this.bambuSerial = (
                      e.target as HTMLInputElement
                    ).value.trim())}
                  placeholder="z.B. 01S00A000000000"
                />
              </div>
              <div class="field">
                <label>Access Code (Bambu)</label>
                <input
                  type="password"
                  .value=${this.bambuAccessCode}
                  @input=${(e: Event) =>
                    (this.bambuAccessCode = (
                      e.target as HTMLInputElement
                    ).value.trim())}
                  placeholder="8-stelliger Code vom Drucker"
                />
              </div>
              <div class="hint">
                Am Drucker: Einstellungen &rarr; Netzwerk &rarr;
                <b>LAN Only Mode</b> aktivieren, dann <b>Developer Mode</b>.
                Access Code und Serial werden dort angezeigt.
              </div>
            `
          : nothing}

        <label class="toggle">
          <input
            type="checkbox"
            .checked=${this.showThumbnail}
            @change=${(e: Event) =>
              (this.showThumbnail = (e.target as HTMLInputElement).checked)}
          />
          Modell-Vorschau anzeigen
          ${isBambu
            ? html`<span class="hint" style="margin-left:4px">
                (nur Moonraker)
              </span>`
            : nothing}
        </label>

        <label class="toggle">
          <input
            type="checkbox"
            .checked=${this.onlyWhenPrinting}
            @change=${(e: Event) =>
              (this.onlyWhenPrinting = (e.target as HTMLInputElement).checked)}
          />
          Nur während des Drucks anzeigen
        </label>

        <div class="field">
          <label>Kamera-URL (optional, leer = automatisch)</label>
          <input
            type="text"
            .value=${this.cameraUrl}
            @input=${(e: Event) =>
              (this.cameraUrl = (e.target as HTMLInputElement).value.trim())}
            placeholder=${isBambu
              ? "RTSP wird in einer späteren Version unterstützt"
              : "http://192.168.2.240:8080/?action=stream"}
          />
        </div>

        <h3>Global</h3>
        <label class="toggle">
          <input
            type="checkbox"
            .checked=${this.alwaysOnTop}
            @change=${(e: Event) =>
              (this.alwaysOnTop = (e.target as HTMLInputElement).checked)}
          />
          Immer im Vordergrund (alle Fenster)
        </label>
        <label class="toggle">
          <input
            type="checkbox"
            .checked=${this.autostart}
            @change=${(e: Event) =>
              (this.autostart = (e.target as HTMLInputElement).checked)}
          />
          Mit Windows starten (Hintergrund)
        </label>
        <div class="hint">
          „Nur während des Drucks“ blendet das Fenster ein/aus, sobald der
          Drucker einen Druck meldet (auch von Orca Slicer). Das Widget muss
          dafür bereits laufen — am besten zusammen mit „Mit Windows starten“.
        </div>

        <h3>Drucker verwalten</h3>
        <div class="printer-list">
          ${this.printers.map((p) => this.renderPrinterRow(p))}
        </div>
        <div class="add-row">
          <button class="mini" @click=${() => this.addPrinter("moonraker")}>
            + Creality / Moonraker
          </button>
          <button class="mini" @click=${() => this.addPrinter("bambu")}>
            + Bambu Lab
          </button>
        </div>

        <div class="actions">
          <button
            class="danger"
            @click=${() =>
              this.dispatchEvent(new CustomEvent("remove-printer"))}
          >
            Diesen Drucker entfernen
          </button>
          <button @click=${() => this.dispatchEvent(new CustomEvent("close"))}>
            Abbrechen
          </button>
          <button class="primary" @click=${this.save}>Speichern</button>
        </div>
      </div>
    `;
  }

  private renderPrinterRow(p: PrinterInstance) {
    const me = p.id === this.printer.id;
    return html`
      <div class="printer-row ${me ? "me" : ""}">
        <div class="meta">
          <div>${p.name}${me ? html` <em>(dieses Fenster)</em>` : nothing}</div>
          <div class="type">
            ${p.type === "bambu" ? "Bambu Lab" : "Moonraker"} • ${p.host}
          </div>
        </div>
        ${me
          ? nothing
          : html`<button
              class="mini"
              @click=${() =>
                this.dispatchEvent(
                  new CustomEvent("open-printer", { detail: { id: p.id } })
                )}
            >
              Öffnen
            </button>`}
      </div>
    `;
  }

  private addPrinter(type: PrinterType) {
    this.dispatchEvent(
      new CustomEvent("add-printer", { detail: { type } })
    );
  }

  private save = () => {
    const detail: SettingsSaveDetail = {
      name: this.name || this.printer.name,
      type: this.type,
      host: this.host || this.printer.host,
      port: this.port || 7125,
      bambuSerial: this.type === "bambu" ? this.bambuSerial : undefined,
      bambuAccessCode:
        this.type === "bambu" ? this.bambuAccessCode : undefined,
      cameraUrl: this.cameraUrl,
      showThumbnail: this.showThumbnail,
      onlyWhenPrinting: this.onlyWhenPrinting,
      alwaysOnTop: this.alwaysOnTop,
      autostart: this.autostart,
    };
    this.dispatchEvent(new CustomEvent("save", { detail }));
  };
}

declare global {
  interface HTMLElementTagNameMap {
    "settings-panel": SettingsPanel;
  }
}
