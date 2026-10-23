import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { AppConfig } from "./config";

export interface SettingsSaveDetail {
  host: string;
  port: number;
  showThumbnail: boolean;
  alwaysOnTop: boolean;
  autostart: boolean;
  onlyWhenPrinting: boolean;
  cameraUrl: string;
}

@customElement("settings-panel")
export class SettingsPanel extends LitElement {
  @property({ attribute: false })
  config!: AppConfig;

  @state() private host = "";
  @state() private port = 7125;
  @state() private showThumbnail = true;
  @state() private alwaysOnTop = true;
  @state() private autostart = false;
  @state() private onlyWhenPrinting = false;
  @state() private cameraUrl = "";

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
    input[type="number"] {
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
    input:focus {
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
      margin-top: -4px;
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
      padding: 7px 14px;
      cursor: pointer;
    }
    button.primary {
      background: linear-gradient(90deg, #2563eb, #3b82f6);
      border-color: transparent;
      color: #fff;
      font-weight: 600;
    }
    button:hover {
      filter: brightness(1.1);
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.host = this.config.host;
    this.port = this.config.port;
    this.showThumbnail = this.config.showThumbnail;
    this.alwaysOnTop = this.config.alwaysOnTop;
    this.autostart = this.config.autostart;
    this.onlyWhenPrinting = this.config.onlyWhenPrinting;
    this.cameraUrl = this.config.cameraUrl;
  }

  render() {
    return html`
      <div class="panel">
        <h2>Einstellungen</h2>
        <div class="row">
          <div class="field" style="flex: 3 1 0">
            <label>Drucker-IP / Host</label>
            <input
              type="text"
              .value=${this.host}
              @input=${(e: Event) =>
                (this.host = (e.target as HTMLInputElement).value.trim())}
              placeholder="192.168.2.240"
            />
          </div>
          <div class="field">
            <label>Port</label>
            <input
              type="number"
              .value=${String(this.port)}
              @input=${(e: Event) =>
                (this.port = Number((e.target as HTMLInputElement).value) || 7125)}
            />
          </div>
        </div>

        <label class="toggle">
          <input
            type="checkbox"
            .checked=${this.showThumbnail}
            @change=${(e: Event) =>
              (this.showThumbnail = (e.target as HTMLInputElement).checked)}
          />
          Modell-Vorschau anzeigen
        </label>

        <label class="toggle">
          <input
            type="checkbox"
            .checked=${this.alwaysOnTop}
            @change=${(e: Event) =>
              (this.alwaysOnTop = (e.target as HTMLInputElement).checked)}
          />
          Immer im Vordergrund
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

        <label class="toggle">
          <input
            type="checkbox"
            .checked=${this.onlyWhenPrinting}
            @change=${(e: Event) =>
              (this.onlyWhenPrinting = (e.target as HTMLInputElement).checked)}
          />
          Nur während des Drucks anzeigen
        </label>
        <div class="hint">
          „Nur während des Drucks“ blendet das Fenster ein/aus, sobald Moonraker
          einen Druck meldet (auch von Orca Slicer). Das Widget muss dafür
          bereits laufen — am besten zusammen mit „Mit Windows starten“.
        </div>

        <div class="field">
          <label>Kamera-URL (optional, leer = automatisch)</label>
          <input
            type="text"
            .value=${this.cameraUrl}
            @input=${(e: Event) =>
              (this.cameraUrl = (e.target as HTMLInputElement).value.trim())}
            placeholder="http://192.168.2.240:8080/?action=stream"
          />
        </div>

        <div class="actions">
          <button @click=${() => this.dispatchEvent(new CustomEvent("close"))}>
            Abbrechen
          </button>
          <button class="primary" @click=${this.save}>Speichern</button>
        </div>
      </div>
    `;
  }

  private save = () => {
    const detail: SettingsSaveDetail = {
      host: this.host || "192.168.2.240",
      port: this.port || 7125,
      showThumbnail: this.showThumbnail,
      alwaysOnTop: this.alwaysOnTop,
      autostart: this.autostart,
      onlyWhenPrinting: this.onlyWhenPrinting,
      cameraUrl: this.cameraUrl,
    };
    this.dispatchEvent(new CustomEvent("save", { detail }));
  };
}

declare global {
  interface HTMLElementTagNameMap {
    "settings-panel": SettingsPanel;
  }
}
