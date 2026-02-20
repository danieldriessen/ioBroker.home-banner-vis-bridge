"use strict";

const { WebSocketServer } = require("ws");
const url = require("node:url");

function createWsServer({ httpServer, authToken, onMessage }) {
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws, req) => {
    try {
      if (authToken) {
        const u = url.parse(req.url || "/", true);
        const token = String(u.query && u.query.token ? u.query.token : "");
        if (token !== authToken) {
          try {
            ws.close(4001, "unauthorized");
          } catch {}
          return;
        }
      }

      ws.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(String(raw || ""));
        } catch {
          return;
        }
        if (!msg || typeof msg !== "object") return;
        onMessage(ws, msg);
      });
    } catch {
      try {
        ws.close(1011, "internal_error");
      } catch {}
    }
  });

  function broadcast(obj) {
    const payload = Buffer.from(JSON.stringify(obj), "utf-8");
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(payload);
        } catch {}
      }
    }
  }

  return {
    broadcast,
    close: () =>
      new Promise((resolve) => {
        try {
          wss.close(() => resolve());
        } catch {
          resolve();
        }
      }),
  };
}

module.exports = {
  createWsServer,
};

