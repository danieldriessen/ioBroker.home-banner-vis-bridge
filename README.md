## ioBroker adapter: Home-Banner VIS Bridge (draft) (`home-banner-vis-bridge`)

This adapter runs on an ioBroker host and renders **VIS classic** / **VIS-2** views into a small
image stream suitable for Home-Banner LED matrix devices (e.g. 384×64).

Design goals:

- **One Home-Banner device per adapter instance** (use multiple instances for multiple devices)
- **Multiple views per instance** (user-defined in adapter config; clients request/subscribe per view)
- **Responsive rendering** (DOM change detection + adaptive periodic captures for “silent” changes like canvas updates)
- **Optional auto-reload** for VIS layout edits that don’t propagate to already-open clients
- **Push notifications** via WebSocket (two-way; per-connection subscriptions)
- **Frame delivery** via HTTP with `ETag` / `If-None-Match` (cheap “no change” responses)
- **Safety**: configurable max concurrently rendered views (clear error when exceeded)
- **Idle CPU**: stop rendering when not needed; close pages/browser after idle timeouts

Status: **prototype working** (HTTP `/frame/<viewId>.png`, HTTP `/status.json`, WS subscribe, Playwright-based renderer).

Notes:

- VIS classic view edits are stored in `vis-views.json`. Already-open VIS clients may not pick up edits until a reload.
  - Use `autoReloadMs` (adapter config) to reload periodically.
  - (Legacy) `control.reloadNow` exists but is not used by the multi-view client protocol.

Endpoints (HTTP):

- **`GET /frame/<viewId>.png`**: latest PNG frame for a specific view id (ETag-enabled).
- **`GET /frame.png`**: legacy compatibility endpoint (uses default/active view).
- **`GET /status.json`**: current adapter + renderer pool status.

Protocol (WebSocket):

- Client sends `{"type":"hello"}` then `{"type":"subscribe","viewId":"<id>"}`.
- Adapter sends `{"type":"frame","viewId":"<id>",...,"url":"/frame/<id>.png"}` notifications.

