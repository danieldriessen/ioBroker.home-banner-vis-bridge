"use strict";

const http = require("node:http");
const url = require("node:url");

function _sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj || {}), "utf-8");
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

function _sendPng(res, code, buf, etag) {
  res.statusCode = code;
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "no-cache");
  if (etag) res.setHeader("ETag", etag);
  res.end(buf);
}

async function _maybeWaitForFirstFrame({ viewId, getFrame, waitForFrame, waitMs }) {
  try {
    const fr0 = getFrame ? getFrame(String(viewId)) : null;
    if (fr0 && fr0.png && fr0.etag) return fr0;
  } catch {}
  if (typeof waitForFrame !== "function") return null;
  const ok = await waitForFrame(String(viewId), Math.max(0, Math.floor(Number(waitMs || 0))));
  if (!ok) return null;
  try {
    const fr1 = getFrame ? getFrame(String(viewId)) : null;
    if (fr1 && fr1.png && fr1.etag) return fr1;
  } catch {}
  return null;
}

function createHttpServer({ host, port, authToken, getStatus, getFrame, onFrameRequest, waitForFrame }) {
  const srv = http.createServer(async (req, res) => {
    try {
      const u = url.parse(req.url || "/", true);
      const path = String(u.pathname || "/");

      // Very small, explicit API surface:
      // - GET /frame.png?viewId=<id>         (legacy)
      // - GET /frame/<viewId>.png           (preferred)
      // - GET /status.json
      // - GET /healthz
      if (req.method !== "GET") {
        _sendJson(res, 405, { ok: false, error: "method_not_allowed" });
        return;
      }

      // Token auth (optional).
      if (authToken) {
        const token = String(u.query && u.query.token ? u.query.token : "");
        const hdr = String(req.headers["authorization"] || "");
        const bearer = hdr.toLowerCase().startsWith("bearer ") ? hdr.slice(7).trim() : "";
        if (token !== authToken && bearer !== authToken) {
          _sendJson(res, 401, { ok: false, error: "unauthorized" });
          return;
        }
      }

      if (path === "/healthz") {
        _sendJson(res, 200, { ok: true });
        return;
      }

      if (path === "/status.json") {
        _sendJson(res, 200, { ok: true, status: getStatus() });
        return;
      }

      if (path === "/frame.png") {
        let viewId = String((u.query && (u.query.viewId || u.query.view_id)) || "");
        if (!viewId) {
          try {
            const st = getStatus ? getStatus() : null;
            if (st && st.activeViewId) viewId = String(st.activeViewId || "");
          } catch {}
        }
        if (!viewId) {
          _sendJson(res, 400, { ok: false, error: "missing_view_id" });
          return;
        }
        try {
          if (typeof onFrameRequest === "function") {
            const r = await onFrameRequest(String(viewId));
            if (r && typeof r === "object" && r.error) {
              _sendJson(res, Number(r.statusCode || 429), r);
              return;
            }
          }
        } catch {}
        let frame = getFrame ? getFrame(String(viewId)) : null;
        if (!frame || !frame.png || !frame.etag) {
          // Cold start: allow a brief wait for the first frame instead of immediately returning no_frame.
          frame = await _maybeWaitForFirstFrame({ viewId, getFrame, waitForFrame, waitMs: 900 });
        }
        if (!frame || !frame.png || !frame.etag) {
          _sendJson(res, 503, { ok: false, error: "no_frame", viewId });
          return;
        }
        const inm = String(req.headers["if-none-match"] || "");
        if (inm && inm === frame.etag) {
          res.statusCode = 304;
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("ETag", frame.etag);
          res.end();
          return;
        }
        _sendPng(res, 200, frame.png, frame.etag);
        return;
      }

      if (path.startsWith("/frame/") && path.endsWith(".png")) {
        const raw = path.slice("/frame/".length, path.length - ".png".length);
        const viewId = decodeURIComponent(String(raw || ""));
        if (!viewId) {
          _sendJson(res, 400, { ok: false, error: "missing_view_id" });
          return;
        }
        try {
          if (typeof onFrameRequest === "function") {
            const r = await onFrameRequest(String(viewId));
            if (r && typeof r === "object" && r.error) {
              _sendJson(res, Number(r.statusCode || 429), r);
              return;
            }
          }
        } catch {}
        let frame = getFrame ? getFrame(String(viewId)) : null;
        if (!frame || !frame.png || !frame.etag) {
          frame = await _maybeWaitForFirstFrame({ viewId, getFrame, waitForFrame, waitMs: 900 });
        }
        if (!frame || !frame.png || !frame.etag) {
          _sendJson(res, 503, { ok: false, error: "no_frame", viewId });
          return;
        }
        const inm = String(req.headers["if-none-match"] || "");
        if (inm && inm === frame.etag) {
          res.statusCode = 304;
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("ETag", frame.etag);
          res.end();
          return;
        }
        _sendPng(res, 200, frame.png, frame.etag);
        return;
      }

      _sendJson(res, 404, { ok: false, error: "not_found" });
    } catch (e) {
      _sendJson(res, 500, { ok: false, error: "internal_error" });
    }
  });

  return {
    start: () =>
      new Promise((resolve, reject) => {
        srv.once("error", reject);
        srv.listen(port, host, () => resolve());
      }),
    close: () =>
      new Promise((resolve) => {
        try {
          srv.close(() => resolve());
        } catch {
          resolve();
        }
      }),
    rawServer: srv,
  };
}

module.exports = {
  createHttpServer,
};

