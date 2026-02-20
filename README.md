## ioBroker adapter: Home-Banner VIS Bridge (draft) (`home-banner-vis-bridge`)

This adapter runs on an ioBroker host and renders **VIS classic** / **VIS-2** views into a small
image stream suitable for Home-Banner LED matrix devices (e.g. 384×64).

Design goals:

- **One Home-Banner device per adapter instance** (use multiple instances for multiple devices)
- **Multiple views per instance** (user-defined in adapter config; adapter exposes an active view state)
- **Responsive rendering** (DOM change detection + adaptive periodic captures for “silent” changes like canvas updates)
- **Optional auto-reload** for VIS layout edits that don’t propagate to already-open clients
- **Push notifications** via WebSocket (two-way, for future interactivity)
- **Frame delivery** via HTTP with `ETag` / `If-None-Match` (cheap “no change” responses)

Status: **prototype working** (HTTP `/frame.png`, HTTP `/status.json`, WS control channel, Playwright-based renderer).

Notes:

- VIS classic view edits are stored in `vis-views.json`. Already-open VIS clients may not pick up edits until a reload.
  - Use `autoReloadMs` (adapter config) to reload periodically.
  - Or toggle `home-banner-vis-bridge.0.control.reloadNow` (button state) to reload immediately.

