"use strict";

function _str(v) {
  return typeof v === "string" ? v.trim() : "";
}

function _num(v, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return n;
}

function normalizeConfig(native) {
  const n = native || {};
  const listenHost = _str(n.listenHost) || "0.0.0.0";
  const listenPort = Math.min(65535, Math.max(1, Math.floor(_num(n.listenPort, 8787))));
  const authToken = _str(n.authToken);
  const canvasWidth = Math.min(8192, Math.max(1, Math.floor(_num(n.canvasWidth, 384))));
  const canvasHeight = Math.min(8192, Math.max(1, Math.floor(_num(n.canvasHeight, 64))));
  // Capture intervals: defaults used when a view does not override FPS.
  const captureMinIntervalMs = Math.min(60000, Math.max(50, Math.floor(_num(n.captureMinIntervalMs, 200))));
  const captureMaxIntervalMs = Math.min(600000, Math.max(captureMinIntervalMs, Math.floor(_num(n.captureMaxIntervalMs, 2000))));
  const autoReloadMs = Math.min(3600000, Math.max(0, Math.floor(_num(n.autoReloadMs, 0))));
  const cacheBustOnReload = n.cacheBustOnReload === true;
  const defaultView = _str(n.defaultView || n.activeView);

  // Limit concurrently rendered views (important for CPU usage).
  const maxActiveViews = Math.min(10, Math.max(1, Math.floor(_num(n.maxActiveViews, 2))));
  // When a view has no subscribers, keep it "active" for a short grace period after the last
  // request/subscribe so quick layout switches don't cause thrash.
  const inactiveGraceMs = Math.min(600000, Math.max(0, Math.floor(_num(n.inactiveGraceMs, 5000))));
  // Close the Playwright page for a view after it has been inactive for this long (CPU saver).
  // The browser stays up, so resume is still reasonably fast.
  const closePageAfterInactiveMs = Math.min(3600000, Math.max(0, Math.floor(_num(n.closePageAfterInactiveMs, 15000))));
  // Close the browser entirely after everything has been inactive for this long (max CPU saver).
  // Resume will be slower than keeping the browser warm, but CPU usage approaches zero.
  const closeBrowserAfterInactiveMs = Math.min(3600000, Math.max(0, Math.floor(_num(n.closeBrowserAfterInactiveMs, 30000))));

  const viewsIn = Array.isArray(n.views) ? n.views : [];
  const views = [];
  for (const v of viewsIn) {
    if (!v || typeof v !== "object") continue;
    const enabled = v.enabled !== false;
    const id = _str(v.id);
    const name = _str(v.name);
    const url = _str(v.url);
    if (!id || !url) continue;
    // Per-view busy FPS (best-effort). This is only the "fast" end; unchanged pages back off to captureMaxIntervalMs.
    const busyFps = Math.min(20, Math.max(1, Math.floor(_num(v.busyFps, 10))));
    views.push({ enabled, id, name, url, busyFps });
  }

  return {
    listenHost,
    listenPort,
    authToken,
    canvasWidth,
    canvasHeight,
    captureMinIntervalMs,
    captureMaxIntervalMs,
    autoReloadMs,
    cacheBustOnReload,
    defaultView,
    maxActiveViews,
    inactiveGraceMs,
    closePageAfterInactiveMs,
    closeBrowserAfterInactiveMs,
    views,
  };
}

module.exports = {
  normalizeConfig,
};

