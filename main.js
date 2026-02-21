"use strict";

const utils = require("@iobroker/adapter-core");
const { normalizeConfig } = require("./lib/config");
const { createHttpServer } = require("./lib/http_server");
const { createWsServer } = require("./lib/ws_server");
const { RendererPool } = require("./lib/renderer");

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
    this._pool = null;
    this._poolStarted = false;
    this._activeViewId = ""; // legacy/admin default (used for compatibility only)

    // WS connection state: ws -> { viewId }
    this._wsMeta = new Map();
    // Subscriptions: viewId -> Set(ws)
    this._subs = new Map();
    // Views: viewId -> cfg entry
    this._viewsById = new Map();

    // Pending activations (race guard): viewId -> expiresAtMs
    this._pendingActive = new Map();

    // HTTP waiters: viewId -> Set(resolveFn)
    this._frameWaiters = new Map();
  }

  async onReady() {
    this._cfg = normalizeConfig(this.config);
    this._viewsById.clear();
    for (const v of this._cfg.views || []) {
      if (!v || typeof v !== "object") continue;
      const id = String(v.id || "").trim();
      if (!id) continue;
      this._viewsById.set(id, v);
    }

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

    this._pool = new RendererPool({
      log: this.log,
      width: this._cfg.canvasWidth,
      height: this._cfg.canvasHeight,
      captureMinIntervalMs: this._cfg.captureMinIntervalMs,
      captureMaxIntervalMs: this._cfg.captureMaxIntervalMs,
      autoReloadMs: this._cfg.autoReloadMs,
      cacheBustOnReload: this._cfg.cacheBustOnReload,
      maxActiveViews: this._cfg.maxActiveViews,
      inactiveGraceMs: this._cfg.inactiveGraceMs,
      closePageAfterInactiveMs: this._cfg.closePageAfterInactiveMs,
      closeBrowserAfterInactiveMs: this._cfg.closeBrowserAfterInactiveMs,
    });
    this._pool.onFrame = async (frame, viewId) => {
      await this._onFrame(viewId, frame);
    };

    // Start HTTP server first (frame endpoint + WS upgrade).
    const statusFn = () => ({
      config: {
        host: this._cfg.listenHost,
        port: this._cfg.listenPort,
        width: this._cfg.canvasWidth,
        height: this._cfg.canvasHeight,
      },
      // Compatibility: keep activeViewId, but multi-view clients should use activeViews / views.
      activeViewId: this._activeViewId || null,
      pool: this._pool ? this._pool.getPoolStatus() : null,
    });

    this._http = createHttpServer({
      host: this._cfg.listenHost,
      port: this._cfg.listenPort,
      authToken: this._cfg.authToken,
      getStatus: statusFn,
      getFrame: (viewId) => (this._pool ? this._pool.getFrame(viewId) : null),
      onFrameRequest: (viewId) => this._onHttpFrameRequest(viewId),
      waitForFrame: (viewId, waitMs) => this._waitForFrame(viewId, waitMs),
    });
    await this._http.start();

    this._ws = createWsServer({
      httpServer: this._http.rawServer,
      authToken: this._cfg.authToken,
      onMessage: (ws, msg) => this._onWsMessage(ws, msg),
    });

    await this.setStateAsync("info.connection", { val: true, ack: true });
    this.log.info(`Listening on http://${this._cfg.listenHost}:${this._cfg.listenPort} (token ${this._cfg.authToken ? "enabled" : "disabled"})`);
  }

  async _ensurePoolStarted() {
    if (!this._pool || this._poolStarted) return;
    this._poolStarted = true;
    try {
      await this._pool.start();
    } catch (e) {
      this._poolStarted = false;
      throw e;
    }
  }

  _viewCfg(viewId) {
    const id = String(viewId || "").trim();
    const v = this._viewsById.get(id);
    if (!v || v.enabled === false) return null;
    return v;
  }

  _subscribeWs(ws, viewId) {
    const id = String(viewId || "").trim();
    if (!id) return false;
    let set = this._subs.get(id);
    if (!set) {
      set = new Set();
      this._subs.set(id, set);
    }
    set.add(ws);
    this._wsMeta.set(ws, { viewId: id });
    return true;
  }

  _unsubscribeWs(ws) {
    const meta = this._wsMeta.get(ws);
    const id = meta && meta.viewId ? String(meta.viewId) : "";
    this._wsMeta.delete(ws);
    if (id) {
      const set = this._subs.get(id);
      if (set) {
        try {
          set.delete(ws);
        } catch {}
        if (set.size === 0) this._subs.delete(id);
      }
    }
    return id;
  }

  async _onHttpFrameRequest(viewId) {
    const v = this._viewCfg(viewId);
    if (!v) {
      return { ok: false, error: "unknown_view", viewId: String(viewId || ""), statusCode: 404 };
    }
    if (!this._pool) {
      return { ok: false, error: "renderer_not_ready", statusCode: 503 };
    }
    const gate = this._canActivateNow(String(viewId || ""));
    if (!gate.ok) {
      return {
        ok: false,
        error: "too_many_active_views",
        statusCode: 429,
        limit: gate.limit,
        activeViews: gate.activeViews,
        requested: String(viewId || ""),
      };
    }
    // Start pool and mark view active due to HTTP polling.
    this._pendingMark(String(viewId || ""));
    try {
      await this._ensurePoolStarted();
      await this._pool.touchHttp(v);
    } catch {
      // ignore; caller may still return cached frames or no_frame
    }
    return null;
  }

  _waitForFrame(viewId, waitMs) {
    const id = String(viewId || "").trim();
    const ms = Math.max(0, Math.floor(Number(waitMs || 0)));
    if (!id || !this._pool) return Promise.resolve(false);
    try {
      const fr = this._pool.getFrame(id);
      if (fr && fr.png && fr.etag) return Promise.resolve(true);
    } catch {}
    if (ms <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      let set = this._frameWaiters.get(id);
      if (!set) {
        set = new Set();
        this._frameWaiters.set(id, set);
      }
      set.add(resolve);
      setTimeout(() => {
        try {
          const s2 = this._frameWaiters.get(id);
          if (s2) {
            s2.delete(resolve);
            if (s2.size === 0) this._frameWaiters.delete(id);
          }
        } catch {}
        resolve(false);
      }, ms);
    });
  }

  async _onFrame(viewId, frame) {
    try {
      await this.setStateAsync("info.lastCaptureTs", { val: frame.ts, ack: true });
      await this.setStateAsync("info.lastEtag", { val: frame.etag, ack: true });
      await this.setStateAsync("info.lastError", { val: "", ack: true });
    } catch {}

    const id = String(viewId || "").trim();

    // Resolve any HTTP waiters for this view (first frame warmup).
    try {
      const waiters = this._frameWaiters.get(id);
      if (waiters && waiters.size) {
        this._frameWaiters.delete(id);
        for (const r of waiters) {
          try {
            r(true);
          } catch {}
        }
      }
    } catch {}

    const set = this._subs.get(id);
    if (set && this._ws) {
      for (const ws of set) {
        try {
          this._ws.send(ws, { type: "frame", viewId: id, etag: frame.etag, ts: frame.ts, url: `/frame/${encodeURIComponent(id)}.png` });
        } catch {}
      }
    }
  }

  async onStateChange(id, state) {
    if (!state || state.ack) return;

    const short = id.split(".").slice(2).join(".");
    if (short === "control.activeView") {
      this._activeViewId = String(state.val || "");
      await this.setStateAsync("control.activeView", { val: this._activeViewId, ack: true });
      return;
    }

    if (short === "control.captureNow") {
      await this.setStateAsync("control.captureNow", { val: false, ack: true });
      // Deprecated in multi-view mode (kept for compatibility).
      return;
    }

    if (short === "control.reloadNow") {
      await this.setStateAsync("control.reloadNow", { val: false, ack: true });
      // Deprecated in multi-view mode (kept for compatibility).
      return;
    }
  }

  _onWsMessage(ws, msg) {
    const t = String(msg.type || "");
    if (t === "_close") {
      const old = this._unsubscribeWs(ws);
      if (old && this._pool) {
        this._pool.unsubscribe(old).catch(() => {});
      }
      return;
    }
    if (t === "hello") {
      try {
        const viewId = String((this._wsMeta.get(ws) || {}).viewId || "");
        const st = this._pool ? this._pool.getPoolStatus() : null;
        const frame = viewId && this._pool ? this._pool.getFrame(viewId) : null;
        this._ws.send(ws, {
          type: "hello_ack",
          activeViewId: this._activeViewId || null,
          subscribedViewId: viewId || null,
          pool: st,
          frame: frame ? { viewId, etag: frame.etag, ts: frame.ts, url: `/frame/${encodeURIComponent(viewId)}.png` } : null,
        });
      } catch {}
      return;
    }
    if (t === "subscribe" || t === "setView") {
      const viewId = String(msg.viewId || "");
      const v = this._viewCfg(viewId);
      if (!v || !this._pool || !this._ws) {
        this._ws.send(ws, { type: "error", error: "unknown_view", viewId: viewId || null });
        return;
      }
      // Unsubscribe old view first.
      const old = this._unsubscribeWs(ws);
      if (old && this._pool) this._pool.unsubscribe(old).catch(() => {});

      const gate = this._canActivateNow(String(viewId || ""));
      if (!gate.ok) {
        this._ws.send(ws, { type: "error", error: "too_many_active_views", limit: gate.limit, activeViews: gate.activeViews, requested: viewId });
        return;
      }

      this._subscribeWs(ws, viewId);
      this._pendingMark(String(viewId || ""));
      this._ensurePoolStarted()
        .then(() => this._pool.subscribe(v))
        .then(() => {
          this._ws.send(ws, { type: "subscribed", viewId });
        })
        .catch((e) => {
          const code = e && e.code ? String(e.code) : "subscribe_failed";
          this._ws.send(ws, {
            type: "error",
            error: code,
            viewId,
            limit: e && e.limit ? e.limit : undefined,
            activeViews: e && e.activeViews ? e.activeViews : undefined,
          });
        });
      return;
    }
    if (t === "captureNow") {
      // Deprecated in multi-view mode (kept for compatibility).
      return;
    }
    if (t === "reload") {
      // Deprecated in multi-view mode (kept for compatibility).
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
      if (this._pool) await this._pool.stop();
    } catch {}
    callback();
  }

  _pendingMark(viewId) {
    const id = String(viewId || "").trim();
    if (!id) return;
    // Short-lived reservation to avoid concurrent requests briefly bypassing the limit.
    this._pendingActive.set(id, Date.now() + 5000);
  }

  _activeViewsNow() {
    const now = Date.now();
    const out = new Set();
    try {
      if (this._pool) {
        const st = this._pool.getPoolStatus();
        for (const v of st && Array.isArray(st.activeViews) ? st.activeViews : []) out.add(String(v));
      }
    } catch {}
    for (const [vid, exp] of this._pendingActive.entries()) {
      if (Number(exp || 0) > now) out.add(String(vid));
      else this._pendingActive.delete(vid);
    }
    return out;
  }

  _canActivateNow(viewId) {
    const id = String(viewId || "").trim();
    const active = this._activeViewsNow();
    if (active.has(id)) return { ok: true, limit: this._cfg.maxActiveViews, activeViews: Array.from(active) };
    const limit = Math.min(10, Math.max(1, Math.floor(Number(this._cfg.maxActiveViews || 2))));
    if (active.size >= limit) return { ok: false, limit, activeViews: Array.from(active) };
    return { ok: true, limit, activeViews: Array.from(active) };
  }
}

if (require.main !== module) {
  module.exports = (options) => new HomeBannerAdapter(options);
} else {
  // eslint-disable-next-line no-new
  new HomeBannerAdapter();
}

