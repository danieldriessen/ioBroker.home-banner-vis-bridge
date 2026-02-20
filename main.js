"use strict";

const utils = require("@iobroker/adapter-core");
const { normalizeConfig } = require("./lib/config");
const { createHttpServer } = require("./lib/http_server");
const { createWsServer } = require("./lib/ws_server");
const { Renderer } = require("./lib/renderer");

class HomeBannerAdapter extends utils.Adapter {
  constructor(options = {}) {
    super({
      ...options,
      name: "home-banner-vis-bridge",
    });

    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));

    this._cfg = null;
    this._http = null;
    this._ws = null;
    this._renderer = null;
    this._activeViewId = "";
  }

  async onReady() {
    this._cfg = normalizeConfig(this.config);

    await this.setObjectNotExistsAsync("info.connection", {
      type: "state",
      common: { name: "Connected", type: "boolean", role: "indicator.connected", read: true, write: false, def: false },
      native: {},
    });
    await this.setObjectNotExistsAsync("info.lastCaptureTs", {
      type: "state",
      common: { name: "Last capture ts", type: "number", role: "value.time", read: true, write: false, def: 0 },
      native: {},
    });
    await this.setObjectNotExistsAsync("info.lastEtag", {
      type: "state",
      common: { name: "Last frame ETag", type: "string", role: "text", read: true, write: false, def: "" },
      native: {},
    });
    await this.setObjectNotExistsAsync("info.lastError", {
      type: "state",
      common: { name: "Last error", type: "string", role: "text", read: true, write: false, def: "" },
      native: {},
    });

    await this.setObjectNotExistsAsync("control.activeView", {
      type: "state",
      common: { name: "Active view id", type: "string", role: "text", read: true, write: true, def: "" },
      native: {},
    });
    await this.setObjectNotExistsAsync("control.captureNow", {
      type: "state",
      common: { name: "Capture now", type: "boolean", role: "button", read: true, write: true, def: false },
      native: {},
    });
    await this.setObjectNotExistsAsync("control.reloadNow", {
      type: "state",
      common: { name: "Reload view now", type: "boolean", role: "button", read: true, write: true, def: false },
      native: {},
    });

    await this.subscribeStatesAsync("control.*");

    // Resolve initial active view id: state → config default → first enabled view.
    const cur = await this.getStateAsync("control.activeView");
    if (cur && cur.val) this._activeViewId = String(cur.val);
    if (!this._activeViewId && this._cfg.defaultView) this._activeViewId = this._cfg.defaultView;
    if (!this._activeViewId) {
      const first = (this._cfg.views || []).find((v) => v.enabled);
      if (first) this._activeViewId = first.id;
    }
    await this.setStateAsync("control.activeView", { val: this._activeViewId, ack: true });

    // Start HTTP server first (frame endpoint + WS upgrade).
    const statusFn = () => ({
      config: {
        host: this._cfg.listenHost,
        port: this._cfg.listenPort,
        width: this._cfg.canvasWidth,
        height: this._cfg.canvasHeight,
      },
      activeViewId: this._activeViewId || null,
      renderer: this._renderer ? this._renderer.getStatus() : null,
    });
    const frameFn = () => (this._renderer ? this._renderer.getFrame() : null);

    this._http = createHttpServer({
      host: this._cfg.listenHost,
      port: this._cfg.listenPort,
      authToken: this._cfg.authToken,
      getStatus: statusFn,
      getFrame: frameFn,
    });
    await this._http.start();

    this._ws = createWsServer({
      httpServer: this._http.rawServer,
      authToken: this._cfg.authToken,
      onMessage: (ws, msg) => this._onWsMessage(ws, msg),
    });

    // Start renderer.
    this._renderer = new Renderer({
      log: this.log,
      width: this._cfg.canvasWidth,
      height: this._cfg.canvasHeight,
      captureMinIntervalMs: this._cfg.captureMinIntervalMs,
      captureMaxIntervalMs: this._cfg.captureMaxIntervalMs,
      autoReloadMs: this._cfg.autoReloadMs,
      cacheBustOnReload: this._cfg.cacheBustOnReload,
    });
    this._renderer.onFrame = async (frame) => {
      try {
        await this.setStateAsync("info.lastCaptureTs", { val: frame.ts, ack: true });
        await this.setStateAsync("info.lastEtag", { val: frame.etag, ack: true });
        await this.setStateAsync("info.lastError", { val: "", ack: true });
      } catch {}
      try {
        this._ws.broadcast({ type: "frame", etag: frame.etag, ts: frame.ts, url: "/frame.png" });
      } catch {}
    };
    await this._renderer.start();

    await this._applyActiveView();

    await this.setStateAsync("info.connection", { val: true, ack: true });
    this.log.info(`Listening on http://${this._cfg.listenHost}:${this._cfg.listenPort} (token ${this._cfg.authToken ? "enabled" : "disabled"})`);
  }

  async _applyActiveView() {
    const v = (this._cfg.views || []).find((x) => x.enabled && x.id === this._activeViewId);
    if (!v) {
      const msg = `No enabled view found for id=${this._activeViewId}`;
      await this.setStateAsync("info.lastError", { val: msg, ack: true });
      this.log.warn(msg);
      return;
    }
    await this._renderer.setActiveView({ id: v.id, url: v.url });
  }

  async onStateChange(id, state) {
    if (!state || state.ack) return;

    const short = id.split(".").slice(2).join(".");
    if (short === "control.activeView") {
      this._activeViewId = String(state.val || "");
      await this.setStateAsync("control.activeView", { val: this._activeViewId, ack: true });
      await this._applyActiveView();
      return;
    }

    if (short === "control.captureNow") {
      await this.setStateAsync("control.captureNow", { val: false, ack: true });
      if (this._renderer) this._renderer.captureNow();
      return;
    }

    if (short === "control.reloadNow") {
      await this.setStateAsync("control.reloadNow", { val: false, ack: true });
      if (this._renderer) this._renderer.reloadNow();
      return;
    }
  }

  _onWsMessage(ws, msg) {
    const t = String(msg.type || "");
    if (t === "hello") {
      const frame = this._renderer ? this._renderer.getFrame() : null;
      const status = this._renderer ? this._renderer.getStatus() : null;
      try {
        ws.send(
          JSON.stringify({
            type: "hello_ack",
            activeViewId: this._activeViewId || null,
            status,
            frame: frame ? { etag: frame.etag, ts: frame.ts, url: "/frame.png" } : null,
          }),
        );
      } catch {}
      return;
    }
    if (t === "setView") {
      const viewId = String(msg.viewId || "");
      if (viewId) {
        // Write through the state path so scripts/Admin stay consistent.
        this.setState("control.activeView", { val: viewId, ack: false });
      }
      return;
    }
    if (t === "captureNow") {
      if (this._renderer) this._renderer.captureNow();
      return;
    }
    if (t === "reload") {
      if (this._renderer) this._renderer.reloadNow();
      return;
    }
  }

  async onUnload(callback) {
    try {
      await this.setStateAsync("info.connection", { val: false, ack: true });
    } catch {}
    try {
      if (this._ws) await this._ws.close();
    } catch {}
    try {
      if (this._http) await this._http.close();
    } catch {}
    try {
      if (this._renderer) await this._renderer.stop();
    } catch {}
    callback();
  }
}

if (require.main !== module) {
  module.exports = (options) => new HomeBannerAdapter(options);
} else {
  // eslint-disable-next-line no-new
  new HomeBannerAdapter();
}

