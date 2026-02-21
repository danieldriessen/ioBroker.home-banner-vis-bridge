"use strict";

const crypto = require("node:crypto");
const { URL } = require("node:url");
const { chromium } = require("playwright");

function _sha1Hex(buf) {
  return crypto.createHash("sha1").update(buf).digest("hex");
}

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Multi-view VIS renderer pool.
 *
 * Design intent:
 * - Keep one persistent Chromium browser
 * - Maintain per-view pages (created on demand; closed when inactive to save CPU)
 * - Capture when "dirty" (DOM mutations) + adaptive periodic probes for silent visual updates (e.g. canvas)
 * - Store latest PNG bytes + ETag in memory per view
 */
function _cacheBustedUrl(raw, cacheBustOnReload) {
  const u0 = String(raw || "").trim();
  if (!u0) return u0;
  if (!cacheBustOnReload) return u0;
  try {
    const u = new URL(u0);
    // VIS classic uses the query string to select the project prefix:
    // `index.html?<project>#<View>`. Adding arbitrary query parameters breaks that.
    if (/\/vis\/index\.html$/i.test(u.pathname)) return u0;
    u.searchParams.set("hb_ts", String(Date.now()));
    return u.toString();
  } catch {
    return u0;
  }
}

class _ViewSession {
  constructor({ log, ctx, width, height, captureMinIntervalMs, captureMaxIntervalMs, autoReloadMs, cacheBustOnReload }) {
    this.log = log;
    this.ctx = ctx;
    this.width = width;
    this.height = height;
    this.captureMinIntervalMs = Math.max(50, Math.floor(Number(captureMinIntervalMs || 200)));
    this.captureMaxIntervalMs = Math.max(this.captureMinIntervalMs, Math.floor(Number(captureMaxIntervalMs || 2000)));
    this.autoReloadMs = Math.max(0, Math.floor(Number(autoReloadMs || 0)));
    this.cacheBustOnReload = cacheBustOnReload === true;

    this.view = null; // {id,url}
    this.page = null;

    this._running = false;
    this._loopPromise = null;

    this._wantCaptureNow = false;
    this._wantReloadNow = false;
    this._probeMs = this.captureMinIntervalMs;
    this._lastReloadTs = 0;
    this._lastCaptureTs = 0;
    this._lastError = "";
    this._lastFrame = null; // {png, etag, ts}

    this._subscribers = 0;
    this._lastHttpSeenTs = 0;
    this._lastInactiveTs = 0;
    this._enabled = false; // set by tick() based on wanted()
  }

  setView(view, captureMinIntervalMs) {
    this.view = view;
    if (captureMinIntervalMs) {
      this.captureMinIntervalMs = Math.max(50, Math.floor(Number(captureMinIntervalMs)));
      this.captureMaxIntervalMs = Math.max(this.captureMinIntervalMs, this.captureMaxIntervalMs);
    }
    this._wantCaptureNow = true;
    this._probeMs = this.captureMinIntervalMs;
  }

  subscribe() {
    this._subscribers = Math.max(0, Number(this._subscribers || 0)) + 1;
    this._lastInactiveTs = 0;
    this._wantCaptureNow = true;
    this._enabled = true;
  }

  unsubscribe() {
    this._subscribers = Math.max(0, Math.floor(Number(this._subscribers || 0)) - 1);
    if (this._subscribers <= 0) {
      this._subscribers = 0;
      this._lastInactiveTs = Date.now();
    }
  }

  touchHttp() {
    this._lastHttpSeenTs = Date.now();
    this._lastInactiveTs = 0;
    this._wantCaptureNow = true;
    this._enabled = true;
  }

  wanted(nowMs, inactiveGraceMs) {
    if (this._subscribers > 0) return true;
    const last = Math.max(Number(this._lastHttpSeenTs || 0), Number(this._lastInactiveTs || 0));
    if (!last) return false;
    return nowMs - last <= Math.max(0, Number(inactiveGraceMs || 0));
  }

  getFrame() {
    return this._lastFrame;
  }

  getStatus() {
    return {
      activeView: this.view ? { id: this.view.id, url: this.view.url } : null,
      subscribers: this._subscribers,
      lastHttpSeenTs: this._lastHttpSeenTs || null,
      lastCaptureTs: this._lastCaptureTs || null,
      lastError: this._lastError || null,
      hasFrame: !!this._lastFrame,
      etag: this._lastFrame ? this._lastFrame.etag : null,
      pageOpen: !!this.page,
    };
  }

  async _ensurePage() {
    if (this.page || !this.ctx) return;
    this.page = await this.ctx.newPage();

    // Install dirtiness tracker early (per-page).
    await this.page.addInitScript(() => {
      try {
        // Force a dark background so transient "white page" states (during load/reload)
        // do not flash as a full-white frame on the LED matrix.
        // eslint-disable-next-line no-undef
        const applyDarkBg = () => {
          try {
            // eslint-disable-next-line no-undef
            const de = document && document.documentElement ? document.documentElement : null;
            // eslint-disable-next-line no-undef
            const b = document && document.body ? document.body : null;
            if (de) {
              de.style.background = "#000";
              // Help the browser pick dark default UI styles where applicable.
              // eslint-disable-next-line no-undef
              de.style.colorScheme = "dark";
            }
            if (b) b.style.background = "#000";
          } catch {}
        };
        applyDarkBg();
        // eslint-disable-next-line no-undef
        window.addEventListener("DOMContentLoaded", applyDarkBg, true);

        // eslint-disable-next-line no-undef
        window.__hb = { dirty: true, dirtyTs: Date.now(), seq: 0 };
        // eslint-disable-next-line no-undef
        const mark = () => {
          // eslint-disable-next-line no-undef
          if (!window.__hb) return;
          // eslint-disable-next-line no-undef
          window.__hb.dirty = true;
          // eslint-disable-next-line no-undef
          window.__hb.dirtyTs = Date.now();
          // eslint-disable-next-line no-undef
          window.__hb.seq++;
        };
        // eslint-disable-next-line no-undef
        const root = document && document.documentElement ? document.documentElement : null;
        if (root) {
          // eslint-disable-next-line no-undef
          new MutationObserver(() => mark()).observe(root, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
          });
        } else {
          // eslint-disable-next-line no-undef
          window.addEventListener("DOMContentLoaded", () => {
            // eslint-disable-next-line no-undef
            const r2 = document && document.documentElement ? document.documentElement : null;
            if (!r2) return;
            // eslint-disable-next-line no-undef
            new MutationObserver(() => mark()).observe(r2, {
              subtree: true,
              childList: true,
              attributes: true,
              characterData: true,
            });
          });
        }
        // eslint-disable-next-line no-undef
        window.addEventListener("resize", mark, true);
        // eslint-disable-next-line no-undef
        window.addEventListener("scroll", mark, true);
      } catch {}
    });
  }

  async _waitForPaint() {
    if (!this.page) return;
    try {
      // Wait for at least one browser paint after DOM changes.
      // Using requestAnimationFrame avoids capturing transient intermediate states (e.g. text nodes
      // briefly removed/replaced), which can look like "text flicker" in the downscaled matrix view.
      await this.page.evaluate(() => new Promise((resolve) => {
        // eslint-disable-next-line no-undef
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
      }));
    } catch {}
  }

  async _goto(url) {
    if (!this.page) return;
    try {
      this._lastError = "";
      await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await this.page.evaluate(() => {
        // eslint-disable-next-line no-undef
        if (window.__hb) window.__hb.dirty = true;
      });
      this._lastReloadTs = Date.now();
      this._wantCaptureNow = true;
      this._probeMs = this.captureMinIntervalMs;
    } catch (e) {
      this._lastError = String(e && e.message ? e.message : e);
      this.log.warn(`renderer: goto failed (${this.view ? this.view.id : "?"}): ${this._lastError}`);
    }
  }

  async _reload() {
    if (!this.page || !this.view) return false;
    try {
      const url0 = _cacheBustedUrl(this.view.url, this.cacheBustOnReload);
      const cur = String(this.page.url ? this.page.url() : "");
      if (url0 && cur && url0 !== cur) {
        await this.page.goto(url0, { waitUntil: "domcontentloaded", timeout: 45000 });
      } else {
        await this.page.reload({ waitUntil: "domcontentloaded", timeout: 45000 });
      }
      await this.page.evaluate(() => {
        // eslint-disable-next-line no-undef
        if (window.__hb) window.__hb.dirty = true;
      });
      this._lastError = "";
      this._lastReloadTs = Date.now();
      this._wantCaptureNow = true;
      this._probeMs = this.captureMinIntervalMs;
      return true;
    } catch (e) {
      this._lastError = String(e && e.message ? e.message : e);
      this.log.warn(`renderer: reload failed (${this.view ? this.view.id : "?"}): ${this._lastError}`);
      return false;
    }
  }

  async _consumeDirty() {
    if (!this.page) return { dirty: false };
    try {
      const r = await this.page.evaluate(() => {
        // eslint-disable-next-line no-undef
        const hb = window.__hb;
        if (!hb) return { dirty: false };
        const dirty = !!hb.dirty;
        hb.dirty = false;
        return { dirty };
      });
      return { dirty: !!r.dirty };
    } catch {
      return { dirty: false };
    }
  }

  async _capturePng() {
    if (!this.page) return null;
    let png;
    try {
      png = await this.page.screenshot({
        type: "png",
        // Avoid capturing "mid-animation" artifacts and blinking carets.
        // (Best-effort; older Playwright versions may not support these options.)
        animations: "disabled",
        caret: "hide",
      });
    } catch {
      png = await this.page.screenshot({ type: "png" });
    }
    const etag = `"${_sha1Hex(png)}"`;
    return { png: Buffer.from(png), etag, ts: Date.now() };
  }

  async start() {
    if (this._running) return;
    this._running = true;
    this._loopPromise = this._loop();
  }

  async stop() {
    this._running = false;
    try {
      await this._loopPromise;
    } catch {}
    this._loopPromise = null;
    await this.closePage();
  }

  async closePage() {
    if (!this.page) return;
    try {
      await this.page.close();
    } catch {}
    this.page = null;
    this._enabled = false;
  }

  async tick({ inactiveGraceMs, closePageAfterInactiveMs }) {
    const now = Date.now();
    const want = this.wanted(now, inactiveGraceMs);
    this._enabled = want;
    if (!want) {
      const lastAct = Math.max(Number(this._lastHttpSeenTs || 0), Number(this._lastInactiveTs || 0));
      if (this.page && closePageAfterInactiveMs > 0 && lastAct && now - lastAct >= closePageAfterInactiveMs) {
        await this.closePage();
      }
      return;
    }

    // Ensure we have a page and are on the correct URL.
    await this._ensurePage();
    if (this.page && this.view) {
      const cur = String(this.page.url ? this.page.url() : "");
      const wantUrl = String(this.view.url || "");
      if (wantUrl && (!cur || cur !== wantUrl)) {
        await this._goto(wantUrl);
      }
    }
  }

  async _loop() {
    const quietSleepMs = 200;
    const backoffFactor = 1.5;
    let lastChangeTs = 0;

    while (this._running) {
      try {
        if (!this._enabled || !this.page || !this.view) {
          await _sleep(quietSleepMs);
          continue;
        }

        const now = Date.now();

        if (this._wantReloadNow || (this.autoReloadMs > 0 && now - (this._lastReloadTs || 0) >= this.autoReloadMs)) {
          this._wantReloadNow = false;
          await this._reload();
          await _sleep(quietSleepMs);
          continue;
        }

        let want = false;
        if (this._wantCaptureNow) {
          want = true;
          this._wantCaptureNow = false;
        } else {
          const { dirty } = await this._consumeDirty();
          if (dirty) {
            want = true;
            lastChangeTs = now;
            this._probeMs = this.captureMinIntervalMs;
          } else if (now - this._lastCaptureTs >= this._probeMs) {
            want = true;
          }
        }

        // Throttle capture during bursts.
        if (want && lastChangeTs && now - lastChangeTs < 2000) {
          if (now - this._lastCaptureTs < this.captureMinIntervalMs) {
            await _sleep(this.captureMinIntervalMs);
            continue;
          }
        }

        if (!want) {
          await _sleep(quietSleepMs);
          continue;
        }

        // Debounce paint to avoid capturing transient DOM states right after mutations.
        await this._waitForPaint();

        const frame = await this._capturePng();
        if (!frame) {
          await _sleep(quietSleepMs);
          continue;
        }

        this._lastError = "";
        this._lastCaptureTs = frame.ts;
        const changed = !this._lastFrame || this._lastFrame.etag !== frame.etag;
        if (changed) {
          this._lastFrame = frame;
          this._probeMs = this.captureMinIntervalMs;
          lastChangeTs = frame.ts;
          if (typeof this.onFrame === "function") {
            try {
              this.onFrame(frame, this.view.id);
            } catch {}
          }
        } else {
          this._probeMs = Math.min(this.captureMaxIntervalMs, Math.floor(this._probeMs * backoffFactor));
        }
      } catch (e) {
        this._lastError = String(e && e.message ? e.message : e);
        this.log.warn(`renderer: loop error (${this.view ? this.view.id : "?"}): ${this._lastError}`);
        await _sleep(1000);
      }
    }
  }
}

class RendererPool {
  constructor({
    log,
    width,
    height,
    captureMinIntervalMs,
    captureMaxIntervalMs,
    autoReloadMs,
    cacheBustOnReload,
    maxActiveViews,
    inactiveGraceMs,
    closePageAfterInactiveMs,
    closeBrowserAfterInactiveMs,
  }) {
    this.log = log;
    this.width = width;
    this.height = height;
    this.captureMinIntervalMs = Math.max(50, Math.floor(Number(captureMinIntervalMs || 200)));
    this.captureMaxIntervalMs = Math.max(this.captureMinIntervalMs, Math.floor(Number(captureMaxIntervalMs || 2000)));
    this.autoReloadMs = Math.max(0, Math.floor(Number(autoReloadMs || 0)));
    this.cacheBustOnReload = cacheBustOnReload === true;

    this.maxActiveViews = Math.min(10, Math.max(1, Math.floor(Number(maxActiveViews || 2))));
    this.inactiveGraceMs = Math.max(0, Math.floor(Number(inactiveGraceMs || 5000)));
    this.closePageAfterInactiveMs = Math.max(0, Math.floor(Number(closePageAfterInactiveMs || 15000)));
    this.closeBrowserAfterInactiveMs = Math.max(0, Math.floor(Number(closeBrowserAfterInactiveMs || 30000)));

    this._browser = null;
    this._ctx = null;
    this._sessions = new Map(); // viewId -> _ViewSession
    this._tickTimer = null;
    this._running = false;
    this._lastAnyActiveTs = 0;
  }

  async start() {
    if (this._running) return;
    this._running = true;
    // Periodic maintenance: close inactive pages.
    this._tickTimer = setInterval(() => {
      this.tick().catch(() => {});
    }, 1000);
  }

  async stop() {
    this._running = false;
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
    for (const s of this._sessions.values()) {
      try {
        await s.stop();
      } catch {}
    }
    this._sessions.clear();
    try {
      if (this._browser) await this._browser.close();
    } catch {}
    this._browser = null;
    this._ctx = null;
  }

  async _closeBrowser() {
    // Close pages first (helps reduce noise and ensures view loops stop cleanly).
    for (const s of this._sessions.values()) {
      try {
        await s.stop();
      } catch {}
      try {
        s.ctx = null;
      } catch {}
    }
    try {
      if (this._browser) await this._browser.close();
    } catch {}
    this._browser = null;
    this._ctx = null;
  }

  async _ensureBrowser() {
    if (this._browser && this._ctx) return;
    this._browser = await chromium.launch({
      headless: true,
      args: ["--disable-dev-shm-usage", "--disable-application-cache"],
    });
    this._ctx = await this._browser.newContext({
      viewport: { width: this.width, height: this.height },
      deviceScaleFactor: 1,
    });
    const noCache = (headers) => ({
      ...headers,
      "cache-control": "no-cache",
      pragma: "no-cache",
    });
    try {
      await this._ctx.route(/\/vis\.0\/.*\/vis-views\.json(\?.*)?$/i, (route, req) => route.continue({ headers: noCache(req.headers()) }));
      await this._ctx.route(/\/vis\.0\/.*\/vis-user\.css(\?.*)?$/i, (route, req) => route.continue({ headers: noCache(req.headers()) }));
    } catch {}
  }

  _busyFpsToMinIntervalMs(busyFps) {
    const fps = Math.min(20, Math.max(1, Math.floor(Number(busyFps || 0) || 0)));
    if (!fps) return this.captureMinIntervalMs;
    return Math.max(50, Math.floor(1000 / fps));
  }

  _activeViewIds(nowMs) {
    const out = [];
    for (const [vid, s] of this._sessions.entries()) {
      if (s.wanted(nowMs, this.inactiveGraceMs)) out.push(vid);
    }
    return out;
  }

  _canActivate(viewId) {
    const now = Date.now();
    const act = this._activeViewIds(now);
    if (act.includes(viewId)) return { ok: true, active: act };
    if (act.length >= this.maxActiveViews) return { ok: false, active: act };
    return { ok: true, active: act };
  }

  canActivate(viewId) {
    const id = String(viewId || "").trim();
    const g = this._canActivate(id);
    return { ok: !!g.ok, limit: this.maxActiveViews, activeViews: Array.isArray(g.active) ? g.active : [] };
  }

  async _ensureSession(viewCfg) {
    await this._ensureBrowser();
    const id = String(viewCfg && viewCfg.id ? viewCfg.id : "").trim();
    const url = String(viewCfg && viewCfg.url ? viewCfg.url : "").trim();
    if (!id || !url) return null;

    let s = this._sessions.get(id);
    if (!s) {
      s = new _ViewSession({
        log: this.log,
        ctx: this._ctx,
        width: this.width,
        height: this.height,
        captureMinIntervalMs: this.captureMinIntervalMs,
        captureMaxIntervalMs: this.captureMaxIntervalMs,
        autoReloadMs: this.autoReloadMs,
        cacheBustOnReload: this.cacheBustOnReload,
      });
      s.onFrame = (frame, viewId) => {
        if (typeof this.onFrame === "function") this.onFrame(frame, viewId);
      };
      this._sessions.set(id, s);
    } else {
      // Browser/context might have been restarted after idling.
      s.ctx = this._ctx;
    }
    // Make sure its loop is running (it may have been stopped when we closed the browser).
    await s.start();

    const minMs = this._busyFpsToMinIntervalMs(viewCfg.busyFps);
    s.setView({ id, url }, minMs);
    return s;
  }

  async subscribe(viewCfg) {
    const id = String(viewCfg && viewCfg.id ? viewCfg.id : "").trim();
    const gate = this._canActivate(id);
    if (!gate.ok) {
      const err = new Error("too_many_active_views");
      err.code = "too_many_active_views";
      err.limit = this.maxActiveViews;
      err.activeViews = gate.active;
      throw err;
    }
    const s = await this._ensureSession(viewCfg);
    if (!s) return null;
    s.subscribe();
    await s.tick({ inactiveGraceMs: this.inactiveGraceMs, closePageAfterInactiveMs: this.closePageAfterInactiveMs });
    return s;
  }

  async unsubscribe(viewId) {
    const id = String(viewId || "").trim();
    const s = this._sessions.get(id);
    if (!s) return;
    s.unsubscribe();
  }

  async touchHttp(viewCfg) {
    const id = String(viewCfg && viewCfg.id ? viewCfg.id : "").trim();
    const gate = this._canActivate(id);
    if (!gate.ok) {
      const err = new Error("too_many_active_views");
      err.code = "too_many_active_views";
      err.limit = this.maxActiveViews;
      err.activeViews = gate.active;
      throw err;
    }
    const s = await this._ensureSession(viewCfg);
    if (!s) return null;
    s.touchHttp();
    await s.tick({ inactiveGraceMs: this.inactiveGraceMs, closePageAfterInactiveMs: this.closePageAfterInactiveMs });
    return s;
  }

  getFrame(viewId) {
    const s = this._sessions.get(String(viewId || "").trim());
    return s ? s.getFrame() : null;
  }

  getStatus(viewId) {
    const s = this._sessions.get(String(viewId || "").trim());
    return s ? s.getStatus() : null;
  }

  getPoolStatus() {
    const now = Date.now();
    const activeViews = this._activeViewIds(now);
    const views = {};
    for (const [vid, s] of this._sessions.entries()) {
      views[vid] = s.getStatus();
    }
    return {
      width: this.width,
      height: this.height,
      activeViews,
      maxActiveViews: this.maxActiveViews,
      inactiveGraceMs: this.inactiveGraceMs,
      closePageAfterInactiveMs: this.closePageAfterInactiveMs,
      closeBrowserAfterInactiveMs: this.closeBrowserAfterInactiveMs,
      browserOpen: !!this._browser,
      views,
    };
  }

  async tick() {
    const now = Date.now();
    const active = this._activeViewIds(now);
    if (active.length > 0) this._lastAnyActiveTs = now;
    if (active.length === 0 && this._lastAnyActiveTs === 0) this._lastAnyActiveTs = now;

    // If nothing is active for a while, close Chromium entirely (max CPU saver).
    if (this._browser && this.closeBrowserAfterInactiveMs > 0 && now - this._lastAnyActiveTs >= this.closeBrowserAfterInactiveMs) {
      await this._closeBrowser();
    }

    // If the browser is closed and nothing is active, do not poll all sessions every tick.
    // They will be re-activated on demand by subscribe()/touchHttp().
    if (!this._browser && active.length === 0) return;

    const opts = { inactiveGraceMs: this.inactiveGraceMs, closePageAfterInactiveMs: this.closePageAfterInactiveMs };
    for (const s of this._sessions.values()) {
      await s.tick(opts);
    }
  }
}

module.exports = {
  RendererPool,
};

