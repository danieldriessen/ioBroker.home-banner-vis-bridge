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
  const captureMinIntervalMs = Math.min(60000, Math.max(50, Math.floor(_num(n.captureMinIntervalMs, 200))));
  const captureMaxIntervalMs = Math.min(600000, Math.max(captureMinIntervalMs, Math.floor(_num(n.captureMaxIntervalMs, 2000))));
  const autoReloadMs = Math.min(3600000, Math.max(0, Math.floor(_num(n.autoReloadMs, 0))));
  const cacheBustOnReload = n.cacheBustOnReload === true;
  const defaultView = _str(n.defaultView || n.activeView);

  const viewsIn = Array.isArray(n.views) ? n.views : [];
  const views = [];
  for (const v of viewsIn) {
    if (!v || typeof v !== "object") continue;
    const enabled = v.enabled !== false;
    const id = _str(v.id);
    const name = _str(v.name);
    const url = _str(v.url);
    if (!id || !url) continue;
    views.push({ enabled, id, name, url });
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
    views,
  };
}

module.exports = {
  normalizeConfig,
};

