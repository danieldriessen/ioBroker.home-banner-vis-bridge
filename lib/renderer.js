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
 * Minimal VIS renderer.
 *
 * Design intent:
 * - Keep a persistent browser+page open
 * - Capture when "dirty" (DOM mutations) + adaptive periodic probes for silent visual updates (e.g. canvas)
 * - Optionally reload periodically to pick up edits that don't propagate to open clients
 * - Store latest PNG bytes + ETag in memory
 */
class Renderer {
  constructor({ log, width, height, captureMinIntervalMs, captureMaxIntervalMs, autoReloadMs, cacheBustOnReload }) {
    this.log = log;
    this.width = width;
    this.height = height;
    this.captureMinIntervalMs = Math.max(50, Math.floor(Number(captureMinIntervalMs || 200)));
    this.captureMaxIntervalMs = Math.max(this.captureMinIntervalMs, Math.floor(Number(captureMaxIntervalMs || 2000)));
    this.autoReloadMs = Math.max(0, Math.floor(Number(autoReloadMs || 0)));
    this.cacheBustOnReload = cacheBustOnReload === true;
    this.browser = null;
    this.page = null;

    this.activeView = null; // {id,url}
    this._running = false;
    this._wantCaptureNow = false;
    this._probeMs = this.captureMinIntervalMs;

    this._lastFrame = null; // { png: Buffer, etag: string, ts: number }
    this._lastCaptureTs = 0;
    this._lastError = "";

    this._wantReloadNow = false;
    this._lastReloadTs = 0;
  }

  getFrame() {
    return this._lastFrame;
  }

  getStatus() {
    return {
      width: this.width,
      height: this.height,
      activeView: this.activeView ? { id: this.activeView.id, url: this.activeView.url } : null,
      lastCaptureTs: this._lastCaptureTs || null,
      lastError: this._lastError || null,
      hasFrame: !!this._lastFrame,
      etag: this._lastFrame ? this._lastFrame.etag : null,
    };
  }

  async start() {
    if (this._running) return;
    this._running = true;

    this.browser = await chromium.launch({
      headless: true,
      args: [
        "--disable-dev-shm-usage",
        // VIS classic uses legacy AppCache (`cache.manifest`) which can make view edits appear "stuck"
        // until the manifest changes. Disable it for headless rendering so reloads pick up changes.
        "--disable-application-cache",
      ],
    });

    const ctx = await this.browser.newContext({
      viewport: { width: this.width, height: this.height },
      deviceScaleFactor: 1,
    });

    // VIS classic serves view/project files (e.g. `/vis.0/main/vis-views.json`) with short-lived caching.
    // When users edit/save a view, we want reloads to pick up changes immediately.
    // We cannot cache-bust VIS classic via query params, because it uses the query string for project selection.
    const noCache = (headers) => ({
      ...headers,
      "cache-control": "no-cache",
      pragma: "no-cache",
    });
    try {
      await ctx.route(/\/vis\.0\/.*\/vis-views\.json(\?.*)?$/i, (route, req) => route.continue({ headers: noCache(req.headers()) }));
      await ctx.route(/\/vis\.0\/.*\/vis-user\.css(\?.*)?$/i, (route, req) => route.continue({ headers: noCache(req.headers()) }));
    } catch {}
    this.page = await ctx.newPage();

    // Install dirtiness tracker early.
    await this.page.addInitScript(() => {
      try {
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

    // Start loop (fire and forget).
    this._loopPromise = this._loop();
  }

  async stop() {
    this._running = false;
    try {
      await this._loopPromise;
    } catch {}
    try {
      if (this.browser) await this.browser.close();
    } catch {}
    this.browser = null;
    this.page = null;
  }

  async setActiveView(view) {
    this.activeView = view;
    this._wantCaptureNow = true;
    this._probeMs = this.captureMinIntervalMs;
    if (!this.page || !view) return;
    try {
      this._lastError = "";
      await this.page.goto(view.url, { waitUntil: "domcontentloaded", timeout: 45000 });
      // Mark dirty after navigation so we capture first stable frame.
      await this.page.evaluate(() => {
        // eslint-disable-next-line no-undef
        if (window.__hb) window.__hb.dirty = true;
      });
      this._lastReloadTs = Date.now();
    } catch (e) {
      this._lastError = String(e && e.message ? e.message : e);
      this.log.warn(`renderer: goto failed: ${this._lastError}`);
    }
  }

  captureNow() {
    this._wantCaptureNow = true;
    this._probeMs = this.captureMinIntervalMs;
  }

  reloadNow() {
    this._wantReloadNow = true;
    this._probeMs = this.captureMinIntervalMs;
    this._wantCaptureNow = true;
  }

  _cacheBustedUrl(raw) {
    const u0 = String(raw || "").trim();
    if (!u0) return u0;
    if (!this.cacheBustOnReload) return u0;
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

  async _reloadActiveView() {
    if (!this.page || !this.activeView) return false;
    try {
      const url0 = this._cacheBustedUrl(this.activeView.url);
      const cur = String(this.page.url ? this.page.url() : "");
      if (url0 && cur && url0 !== cur) {
        await this.page.goto(url0, { waitUntil: "domcontentloaded", timeout: 45000 });
      } else {
        // Navigating to the exact same URL (especially same hash) can be a no-op.
        // Force a real reload so VIS re-reads `vis-views.json`.
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
      this.log.warn(`renderer: reload failed: ${this._lastError}`);
      return false;
    }
  }

  async _consumeDirty() {
    if (!this.page) return { dirty: false, dirtyTs: 0 };
    try {
      const r = await this.page.evaluate(() => {
        // eslint-disable-next-line no-undef
        const hb = window.__hb;
        if (!hb) return { dirty: false, dirtyTs: 0 };
        const dirty = !!hb.dirty;
        const dirtyTs = Number(hb.dirtyTs || 0);
        hb.dirty = false;
        return { dirty, dirtyTs };
      });
      return { dirty: !!r.dirty, dirtyTs: Number(r.dirtyTs || 0) };
    } catch {
      return { dirty: false, dirtyTs: 0 };
    }
  }

  async _capturePng() {
    if (!this.page) return null;
    const png = await this.page.screenshot({ type: "png" });
    const etag = `"${_sha1Hex(png)}"`;
    return { png: Buffer.from(png), etag, ts: Date.now() };
  }

  async _loop() {
    const minHotIntervalMs = this.captureMinIntervalMs; // after a change burst
    const quietSleepMs = 200;
    const backoffFactor = 1.5;

    let lastChangeTs = 0;
    while (this._running) {
      try {
        if (!this.activeView || !this.page) {
          await _sleep(quietSleepMs);
          continue;
        }

        const now = Date.now();

        // Periodic reload (useful when VIS view edits do not propagate to already-open clients).
        if (this._wantReloadNow || (this.autoReloadMs > 0 && now - (this._lastReloadTs || 0) >= this.autoReloadMs)) {
          this._wantReloadNow = false;
          await this._reloadActiveView();
          // Continue; next iteration will capture immediately due to _wantCaptureNow.
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
          if (now - this._lastCaptureTs < minHotIntervalMs) {
            await _sleep(minHotIntervalMs);
            continue;
          }
        }

        if (!want) {
          await _sleep(quietSleepMs);
          continue;
        }

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
          this.log.debug(`renderer: new frame etag=${frame.etag}`);
          if (typeof this.onFrame === "function") {
            try {
              this.onFrame(frame);
            } catch {}
          }
        } else {
          // No visible change. Back off probing up to captureMaxIntervalMs.
          this._probeMs = Math.min(this.captureMaxIntervalMs, Math.floor(this._probeMs * backoffFactor));
        }
      } catch (e) {
        this._lastError = String(e && e.message ? e.message : e);
        this.log.warn(`renderer: loop error: ${this._lastError}`);
        await _sleep(1000);
      }
    }
  }
}

module.exports = {
  Renderer,
};

