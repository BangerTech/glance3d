import { LitElement, html, svg, css, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { emptyStatus, type PrinterStatus } from "./moonraker";
import type { AmsSlot } from "./backend";

@customElement("printer-card")
export class PrinterCard extends LitElement {
  @property({ attribute: false })
  status: PrinterStatus = emptyStatus();

  @property({ type: String })
  name = "Creality Printer";

  @property({ type: String })
  printerImage = "/printer-creality-k1.jpg";

  @property({ attribute: false })
  coverUrl: string | null = null;

  @property({ attribute: false })
  cameraUrl: string | null = null;

  @property({ type: Boolean })
  showCamera = false;

  @property({ type: Boolean })
  powerAvailable = false;

  @property({ type: Boolean })
  powerOn = false;

  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      box-sizing: border-box;
      font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
      color: #fff;
    }
    * {
      box-sizing: border-box;
    }

    .card {
      position: relative;
      width: 100%;
      height: 100%;
      border-radius: 28px;
      padding: 18px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background-color: rgba(30, 32, 36, 0.82);
      backdrop-filter: blur(20px) saturate(140%);
      -webkit-backdrop-filter: blur(20px) saturate(140%);
      border: 1px solid rgba(255, 255, 255, 0.06);
      box-shadow: 0 20px 40px -10px rgba(0, 0, 0, 0.6);
    }

    /* Header */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      z-index: 20;
      cursor: grab;
    }
    .header:active {
      cursor: grabbing;
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 12px;
      flex: 1 1 auto;
      min-width: 0;
      cursor: grab;
    }
    .header-left:active {
      cursor: grabbing;
    }
    .printer-icon {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: linear-gradient(145deg, #2d3038, #22252b);
      display: flex;
      align-items: center;
      justify-content: center;
      color: #0096ff;
      box-shadow:
        3px 3px 6px rgba(0, 0, 0, 0.4),
        -2px -2px 4px rgba(255, 255, 255, 0.03),
        inset 1px 1px 2px rgba(255, 255, 255, 0.05);
    }
    .printer-icon svg {
      width: 22px;
      height: 22px;
      filter: drop-shadow(0 0 4px rgba(0, 150, 255, 0.5));
    }
    .printer-icon.printing {
      animation: iconGlow 2s ease-in-out infinite;
    }
    .printer-icon.paused {
      color: #fbbf24;
    }
    .printer-icon.paused svg {
      filter: drop-shadow(0 0 4px rgba(251, 191, 36, 0.5));
    }
    .printer-icon.offline {
      background: linear-gradient(145deg, #1c1e24, #25282e);
      color: rgba(255, 255, 255, 0.25);
      box-shadow:
        inset 3px 3px 6px rgba(0, 0, 0, 0.5),
        inset -2px -2px 4px rgba(255, 255, 255, 0.03);
    }
    .printer-icon.offline svg {
      filter: none;
    }
    @keyframes iconGlow {
      0%,
      100% {
        color: #0096ff;
      }
      50% {
        color: #4db8ff;
      }
    }
    .printer-info {
      display: flex;
      flex-direction: column;
      justify-content: center;
    }
    .title {
      font-size: 1.05rem;
      font-weight: 700;
      line-height: 1;
      color: rgba(255, 255, 255, 0.92);
    }
    .status-row {
      display: flex;
      align-items: center;
      gap: 7px;
      margin-top: 5px;
    }
    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
    }
    .status-text {
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .header-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .header-icon-btn {
      width: 30px;
      height: 30px;
      border-radius: 50%;
      flex: 0 0 auto;
      background: linear-gradient(145deg, #2d3038, #22252b);
      border: none;
      display: flex;
      align-items: center;
      justify-content: center;
      color: rgba(255, 255, 255, 0.4);
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.23, 1, 0.32, 1);
      box-shadow:
        3px 3px 6px rgba(0, 0, 0, 0.4),
        -2px -2px 4px rgba(255, 255, 255, 0.03),
        inset 1px 1px 2px rgba(255, 255, 255, 0.05);
    }
    .header-icon-btn:hover {
      color: rgba(255, 255, 255, 0.75);
    }
    .header-icon-btn.close:hover {
      color: #fb7185;
    }
    .header-icon-btn.close:hover svg {
      filter: drop-shadow(0 0 5px rgba(251, 113, 133, 0.6));
    }
    .header-icon-btn:active {
      transform: scale(0.95);
    }
    .header-icon-btn svg {
      width: 17px;
      height: 17px;
    }
    .header-icon-btn.active {
      background: linear-gradient(145deg, #1c1e24, #25282e);
      color: #fbbf24;
      box-shadow:
        inset 3px 3px 6px rgba(0, 0, 0, 0.5),
        inset -2px -2px 4px rgba(255, 255, 255, 0.03);
    }
    .header-icon-btn.active svg {
      filter: drop-shadow(0 0 5px rgba(251, 191, 36, 0.6));
    }
    .header-icon-btn.cam-active {
      color: #0096ff;
    }
    .header-icon-btn.cam-active svg {
      filter: drop-shadow(0 0 5px rgba(0, 150, 255, 0.6));
    }

    /* Main visual */
    .main-visual {
      position: relative;
      flex: 1;
      border-radius: 20px;
      background-color: rgba(0, 0, 0, 0.2);
      border: 1px solid rgba(255, 255, 255, 0.05);
      margin-bottom: 16px;
      min-height: 150px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .main-visual-inner {
      position: relative;
      width: 100%;
      height: 100%;
      border-radius: 20px;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .printer-img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      padding: 10px;
      filter: drop-shadow(0 0 30px rgba(0, 150, 255, 0.15)) brightness(1.05);
      transition: filter 0.3s ease;
    }
    .printer-img.dimmed {
      filter: drop-shadow(0 0 10px rgba(0, 0, 0, 0.3)) brightness(0.4);
    }
    .camera-feed {
      width: 100%;
      height: 100%;
      object-fit: cover;
      cursor: pointer;
    }
    .printer-fallback {
      color: rgba(255, 255, 255, 0.18);
    }
    .printer-fallback svg {
      width: 72px;
      height: 72px;
    }

    /* Power button */
    .power-btn {
      position: absolute;
      top: -14px;
      right: -14px;
      z-index: 50;
      width: 42px;
      height: 42px;
      border-radius: 50%;
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(145deg, #2a2d35, #1e2027);
      box-shadow:
        5px 5px 10px rgba(0, 0, 0, 0.5),
        inset 0 0 0 3px rgba(30, 32, 38, 1),
        inset 2px 2px 4px rgba(0, 0, 0, 0.3);
      color: rgba(255, 255, 255, 0.25);
      transition: transform 0.2s ease;
    }
    .power-btn svg {
      width: 18px;
      height: 18px;
    }
    .power-btn.on {
      color: #4ade80;
    }
    .power-btn.on svg {
      filter: drop-shadow(0 0 6px rgba(74, 222, 128, 0.6));
    }
    .power-btn:active {
      transform: scale(0.95);
    }

    /* Cover image build-up */
    .cover-container {
      position: absolute;
      bottom: 24%;
      left: 50%;
      transform: translateX(-50%);
      width: 38%;
      max-width: 140px;
      z-index: 15;
      pointer-events: none;
    }
    .cover-wrapper {
      position: relative;
      width: 100%;
      padding-bottom: 100%;
    }
    .cover-ghost,
    .cover-progress {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    .cover-ghost {
      opacity: 0.4;
      filter: drop-shadow(0 4px 8px rgba(0, 0, 0, 0.4)) grayscale(0.3)
        brightness(0.75);
    }
    .cover-progress {
      clip-path: inset(calc(88% - var(--ph, 0%)) 0 0 0);
      filter: drop-shadow(0 0 5px rgba(74, 222, 128, 0.7))
        drop-shadow(0 0 3px rgba(74, 222, 128, 0.9)) brightness(1.12)
        contrast(1.18);
    }
    .cover-wrapper.paused .cover-progress {
      filter: drop-shadow(0 0 5px rgba(251, 191, 36, 0.7))
        drop-shadow(0 0 3px rgba(251, 191, 36, 0.9)) brightness(1.12)
        contrast(1.18);
    }
    .cover-wrapper.idle .cover-ghost {
      opacity: 0.28;
      filter: grayscale(0.3) brightness(0.5);
    }
    .cover-wrapper.idle .cover-progress {
      opacity: 0;
    }
    .cover-badge {
      position: absolute;
      bottom: -18px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.85);
      padding: 2px 9px;
      border-radius: 9px;
      font-size: 10px;
      font-weight: 700;
      font-family: monospace;
      color: #4ade80;
      border: 1px solid rgba(74, 222, 128, 0.4);
    }
    .cover-wrapper.paused .cover-badge {
      color: #fbbf24;
      border-color: rgba(251, 191, 36, 0.4);
    }

    /* Overlays */
    .overlay-left,
    .overlay-right {
      position: absolute;
      top: 10px;
      bottom: 10px;
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 7px;
      z-index: 20;
    }
    .overlay-left {
      left: 10px;
    }
    .overlay-right {
      right: 10px;
    }
    .pill {
      display: flex;
      align-items: center;
      gap: 7px;
      background-color: rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 999px;
      padding: 5px 10px 5px 6px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);
    }
    .pill.right {
      flex-direction: row-reverse;
      padding: 5px 6px 5px 10px;
      text-align: right;
    }
    .pill-icon {
      width: 22px;
      height: 22px;
      min-width: 22px;
      border-radius: 50%;
      background-color: rgba(255, 255, 255, 0.1);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .pill-icon svg {
      width: 13px;
      height: 13px;
    }
    .pill-icon.nozzle {
      color: #fb7185;
    }
    .pill-icon.bed {
      color: #fbbf24;
    }
    .pill-icon.box {
      color: #38bdf8;
    }
    .pill-icon.fan {
      color: #60a5fa;
    }
    .pill-content {
      display: flex;
      flex-direction: column;
      line-height: 1.1;
    }
    .pill-value {
      font-size: 12px;
      font-weight: 700;
      color: rgba(255, 255, 255, 0.92);
    }
    .pill-value .t {
      font-size: 10px;
      font-weight: 400;
      opacity: 0.55;
    }
    .pill-label {
      font-size: 8px;
      font-weight: 700;
      text-transform: uppercase;
      color: rgba(255, 255, 255, 0.4);
    }

    /* Stats row */
    .stats-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0 6px;
      margin-bottom: 8px;
    }
    .stat-group {
      display: flex;
      flex-direction: column;
    }
    .stat-group.right {
      text-align: right;
    }
    .stat-label {
      font-size: 0.65rem;
      color: rgba(255, 255, 255, 0.4);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-weight: 700;
    }
    .stat-val {
      font-size: 1.1rem;
      font-family: monospace;
      font-weight: 700;
      color: #fff;
    }
    .stat-val .t {
      opacity: 0.4;
    }

    /* Progress */
    .progress-bar {
      width: 100%;
      height: 14px;
      background-color: rgba(0, 0, 0, 0.4);
      border-radius: 999px;
      overflow: hidden;
      position: relative;
      box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.5);
      border: 1px solid rgba(255, 255, 255, 0.05);
      margin-bottom: 14px;
    }
    .progress-fill {
      height: 100%;
      background: linear-gradient(to right, #0096ff, #00c8ff);
      transition: width 0.4s ease;
    }
    .progress-text {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-weight: 700;
      color: #fff;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
    }

    /* Controls */
    .controls {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
    }
    .btn {
      height: 46px;
      border-radius: 15px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      border: none;
      cursor: pointer;
      font-weight: 700;
      font-size: 14px;
      color: rgba(255, 255, 255, 0.5);
      background: linear-gradient(145deg, #2d3038, #22252b);
      box-shadow:
        4px 4px 8px rgba(0, 0, 0, 0.4),
        -2px -2px 6px rgba(255, 255, 255, 0.03),
        inset 1px 1px 2px rgba(255, 255, 255, 0.05);
      transition: all 0.2s cubic-bezier(0.23, 1, 0.32, 1);
    }
    .btn svg {
      width: 20px;
      height: 20px;
    }
    .btn:hover:not(:disabled) {
      color: rgba(255, 255, 255, 0.85);
    }
    .btn:active:not(:disabled) {
      transform: scale(0.97);
    }
    .btn-home:hover:not(:disabled) {
      color: #0096ff;
    }
    .btn-stop:hover:not(:disabled) {
      color: #f87171;
    }
    .btn-primary {
      grid-column: span 2;
      color: #0096ff;
    }
    .btn-primary svg {
      filter: drop-shadow(0 0 4px rgba(0, 150, 255, 0.5));
    }
    .btn-primary.printing {
      background: linear-gradient(145deg, #1c1e24, #25282e);
      box-shadow:
        inset 3px 3px 6px rgba(0, 0, 0, 0.5),
        inset -2px -2px 4px rgba(255, 255, 255, 0.03);
    }
    .btn:disabled {
      opacity: 0.3;
      cursor: not-allowed;
    }
    /* AMS strip (Bambu) */
    .ams-row {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
      margin: 6px 0 8px;
    }
    .ams-chip {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 3px 7px 3px 4px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
      font-size: 10px;
      line-height: 1;
      color: rgba(255, 255, 255, 0.75);
    }
    .ams-chip.active {
      background: rgba(59, 130, 246, 0.18);
      border-color: rgba(59, 130, 246, 0.6);
      color: #fff;
    }
    .ams-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      border: 1px solid rgba(255, 255, 255, 0.25);
    }
    .ams-label small {
      opacity: 0.6;
      margin-left: 2px;
    }
    @keyframes pulse {
      0%,
      100% {
        opacity: 1;
      }
      50% {
        opacity: 0.4;
      }
    }
  `;

  render() {
    const s = this.status;
    const printing = s.printState === "printing";
    const paused = s.printState === "paused";
    const active = printing || paused;
    const iconClass = !s.wsConnected
      ? "offline"
      : printing
        ? "printing"
        : paused
          ? "paused"
          : "";
    const sc = this.stateColors(s);

    return html`
      <div class="card" @mousedown=${this.onCardMouseDown}>
        <div class="header">
          <div class="header-left" data-tauri-drag-region>
            <div class="printer-icon ${iconClass}" data-tauri-drag-region>
              ${ICONS.printer}
            </div>
            <div class="printer-info" data-tauri-drag-region>
              <div class="title" data-tauri-drag-region>${this.name}</div>
              <div class="status-row" data-tauri-drag-region>
                <span
                  class="status-dot"
                  style=${`background:${sc.dot};animation:${printing ? "pulse 2s infinite" : "none"}`}
                ></span>
                <span class="status-text" style=${`color:${sc.text}`}
                  >${this.stateLabel(s)}</span
                >
              </div>
            </div>
          </div>
          <div class="header-right">
            ${s.light !== null
              ? html`<button
                  class="header-icon-btn ${s.light ? "active" : ""}"
                  title="Licht"
                  @click=${() => this.dispatch("toggle-light")}
                >
                  ${ICONS.bulb}
                </button>`
              : nothing}
            ${this.cameraUrl
              ? html`<button
                  class="header-icon-btn ${this.showCamera ? "cam-active" : ""}"
                  title="Kamera"
                  @click=${() => this.dispatch("toggle-camera")}
                >
                  ${ICONS.camera}
                </button>`
              : nothing}
            <button
              class="header-icon-btn"
              title="Einstellungen"
              @click=${() => this.dispatch("open-settings")}
            >
              ${ICONS.gear}
            </button>
            <button
              class="header-icon-btn close"
              title="Widget schließen"
              @click=${() => this.dispatch("close-app")}
            >
              ${ICONS.close}
            </button>
          </div>
        </div>

        <div class="main-visual">
          ${this.powerAvailable
            ? html`<button
                class="power-btn ${this.powerOn ? "on" : "off"}"
                title="Power"
                @click=${() => this.dispatch("toggle-power")}
              >
                ${ICONS.power}
              </button>`
            : nothing}
          <div class="main-visual-inner">
            ${this.renderVisual(s)}
          </div>
          ${this.renderCover(s, printing, paused)}
          <div class="overlay-left">${this.renderFans(s)}</div>
          <div class="overlay-right">${this.renderTemps(s)}</div>
        </div>

        ${this.renderAms(s.ams)}

        <div class="stats-row">
          <div class="stat-group">
            <span class="stat-label">Time Left</span>
            <span class="stat-val">${etaText(active ? s.etaSeconds : null)}</span>
          </div>
          <div class="stat-group right">
            <span class="stat-label">Layer</span>
            <span class="stat-val">${this.layerText(s, active)}</span>
          </div>
        </div>

        <div class="progress-bar">
          <div class="progress-fill" style=${`width:${s.progress * 100}%`}></div>
          <div class="progress-text">${Math.round(s.progress * 100)}%</div>
        </div>

        <div class="controls">
          <button
            class="btn btn-home"
            title="Home (G28)"
            ?disabled=${active || !s.wsConnected}
            @click=${() => this.dispatch("home")}
          >
            ${ICONS.home}
          </button>
          <button
            class="btn btn-stop"
            title="Stop"
            ?disabled=${!active}
            @click=${() => this.dispatch("cancel")}
          >
            ${ICONS.stop}
          </button>
          <button
            class="btn btn-primary ${printing ? "printing" : ""}"
            ?disabled=${!active}
            @click=${() => this.dispatch(paused ? "resume" : "pause")}
          >
            ${paused ? ICONS.play : ICONS.pause}
            ${printing ? "Pause" : paused ? "Resume" : "Control"}
          </button>
        </div>
      </div>
    `;
  }

  private renderVisual(s: PrinterStatus): TemplateResult {
    if (this.showCamera && this.cameraUrl) {
      return html`<img
        class="camera-feed"
        src=${this.cameraUrl}
        alt="camera"
        @click=${() => this.dispatch("toggle-camera")}
      />`;
    }
    if (this.printerImage) {
      return html`<img
        class="printer-img ${s.light === false ? "dimmed" : ""}"
        src=${this.printerImage}
        alt="printer"
      />`;
    }
    return html`<div class="printer-fallback">${ICONS.printer}</div>`;
  }

  private renderCover(
    s: PrinterStatus,
    printing: boolean,
    paused: boolean
  ): TemplateResult | typeof nothing {
    if (this.showCamera || !this.coverUrl) return nothing;
    const cls = printing ? "printing" : paused ? "paused" : "idle";
    const pct = Math.round(s.progress * 100);
    return html`
      <div class="cover-container">
        <div class="cover-wrapper ${cls}">
          <img class="cover-ghost" src=${this.coverUrl} alt="" />
          <img
            class="cover-progress"
            src=${this.coverUrl}
            alt=""
            style=${`--ph:${s.progress * 100}%`}
          />
          ${printing || paused
            ? html`<div class="cover-badge">${pct}%</div>`
            : nothing}
        </div>
      </div>
    `;
  }

  private renderTemps(s: PrinterStatus): TemplateResult {
    return html`
      <div class="pill right">
        <div class="pill-icon nozzle">${ICONS.thermo}</div>
        <div class="pill-content">
          <span class="pill-value"
            >${Math.round(s.nozzleTemp)}°<span class="t"
              >/${Math.round(s.nozzleTarget)}°</span
            ></span
          >
          <span class="pill-label">Nozzle</span>
        </div>
      </div>
      <div class="pill right">
        <div class="pill-icon bed">${ICONS.thermo}</div>
        <div class="pill-content">
          <span class="pill-value"
            >${Math.round(s.bedTemp)}°<span class="t"
              >/${Math.round(s.bedTarget)}°</span
            ></span
          >
          <span class="pill-label">Bed</span>
        </div>
      </div>
      ${s.chamberTemp !== null
        ? html`<div class="pill right">
            <div class="pill-icon box">${ICONS.thermo}</div>
            <div class="pill-content">
              <span class="pill-value">${Math.round(s.chamberTemp)}°</span>
              <span class="pill-label">Box</span>
            </div>
          </div>`
        : nothing}
    `;
  }

  private renderAms(ams: AmsSlot[] | null): TemplateResult | typeof nothing {
    if (!ams || ams.length === 0) return nothing;
    return html`
      <div class="ams-row">
        ${ams.map(
          (slot) => html`
            <div class="ams-chip ${slot.active ? "active" : ""}">
              <span
                class="ams-dot"
                style=${`background:${slot.color ?? "rgba(255,255,255,0.2)"}`}
              ></span>
              <span class="ams-label"
                >${slot.material ?? "–"}${slot.remaining !== null
                  ? html` <small>${slot.remaining}%</small>`
                  : nothing}</span
              >
            </div>
          `
        )}
      </div>
    `;
  }

  private renderFans(s: PrinterStatus): TemplateResult {
    const fan = (label: string, val: number | null) =>
      val === null
        ? nothing
        : html`<div class="pill">
            <div class="pill-icon fan">${ICONS.fan}</div>
            <div class="pill-content">
              <span class="pill-value">${val}%</span>
              <span class="pill-label">${label}</span>
            </div>
          </div>`;
    return html`${fan("Model", s.modelFan)}${fan("Aux", s.auxFan)}`;
  }

  private layerText(s: PrinterStatus, active: boolean): TemplateResult {
    if (active && s.currentLayer !== null && s.totalLayers !== null) {
      return html`${s.currentLayer}<span class="t"> / ${s.totalLayers}</span>`;
    }
    return html`--<span class="t"> / --</span>`;
  }

  private stateLabel(s: PrinterStatus): string {
    if (!s.wsConnected) return "Offline";
    if (s.klippy === "shutdown") return "Klipper Off";
    if (s.klippy === "error") return "Klipper Error";
    switch (s.printState) {
      case "printing":
        return "Printing";
      case "paused":
        return "Paused";
      case "complete":
        return "Complete";
      case "cancelled":
        return "Cancelled";
      case "error":
        return "Error";
      default:
        return "Standby";
    }
  }

  private stateColors(s: PrinterStatus): { dot: string; text: string } {
    if (!s.wsConnected || s.klippy === "shutdown" || s.klippy === "error")
      return { dot: "#ef4444", text: "#f87171" };
    if (s.printState === "printing")
      return { dot: "#22c55e", text: "#4ade80" };
    if (s.printState === "paused") return { dot: "#fbbf24", text: "#fbbf24" };
    return { dot: "rgba(255,255,255,0.2)", text: "rgba(255,255,255,0.6)" };
  }

  private onCardMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const path = e.composedPath();
    // Don't steal clicks from buttons, inputs, or the progress/control strip.
    const interactive = path.some((el) => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      if (tag === "BUTTON" || tag === "INPUT" || tag === "A") return true;
      return (
        el.classList.contains("header-icon-btn") ||
        el.classList.contains("power-btn") ||
        el.classList.contains("footer-btn") ||
        el.classList.contains("controls") ||
        el.classList.contains("no-drag")
      );
    });
    if (interactive) return;
    this.dispatch("startdrag");
  };

  private dispatch(name: string): void {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true }));
  }
}

function etaText(seconds: number | null): string {
  if (seconds === null) return "--";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s % 60}s`;
}

const svgWrap = (inner: TemplateResult): TemplateResult =>
  html`<svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    ${inner}
  </svg>`;

const ICONS = {
  printer: svgWrap(
    svg`<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5" /><path d="M12 22V12" />`
  ),
  pause: svgWrap(
    svg`<rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" />`
  ),
  play: svgWrap(svg`<path d="M7 5l12 7-12 7z" />`),
  stop: svgWrap(svg`<rect x="6" y="6" width="12" height="12" rx="2" />`),
  home: svgWrap(svg`<path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" />`),
  bulb: svgWrap(
    svg`<path d="M9 18h6" /><path d="M10 22h4" /><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V17h6v-.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z" />`
  ),
  camera: svgWrap(
    svg`<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" /><circle cx="12" cy="13" r="3" />`
  ),
  gear: svgWrap(
    svg`<circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 8 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H2a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 3.6 8a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H8a1.65 1.65 0 0 0 1-1.51V2a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V8a1.65 1.65 0 0 0 1.51 1H22a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />`
  ),
  power: svgWrap(
    svg`<path d="M12 2v10" /><path d="M18.4 6.6a9 9 0 1 1-12.77.04" />`
  ),
  close: svgWrap(svg`<path d="M18 6 6 18" /><path d="m6 6 12 12" />`),
  thermo: svgWrap(
    svg`<path d="M14 14.76V5a2 2 0 0 0-4 0v9.76a4 4 0 1 0 4 0z" />`
  ),
  fan: svgWrap(
    svg`<path d="M10.83 16.38a6.08 6.08 0 0 1-8.62-7l5.41 1.45a6.08 6.08 0 0 1 7-8.62l-1.45 5.41a6.08 6.08 0 0 1 8.62 7l-5.41-1.45a6.08 6.08 0 0 1-7 8.62z" /><circle cx="12" cy="12" r="1.2" />`
  ),
};

declare global {
  interface HTMLElementTagNameMap {
    "printer-card": PrinterCard;
  }
}
