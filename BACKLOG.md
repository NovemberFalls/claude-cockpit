# Backlog

Outstanding work, most-actionable first. Delete items as they land.

## Local Model Broker (branch `feat/local-broker-panel`)

Foundation shipped on the branch (commits `0d9ed3b`, `ec5e759`): read-only queue +
metrics panels and per-class spill control, all against the confirmed broker
contract. Everything below is *not yet done*.

### Ship / release
- [ ] **Verify against a LIVE broker at `127.0.0.1:1235`.** First live test
  (2026-07-24) hit **LM Studio directly, not the broker** — its dev server
  answered `/metrics` + `/config/spill` with "200 anyway" garbage. That led to
  the identity middleware (`/api/local/status`, shape validation → 502). Still
  outstanding: a real end-to-end run against the actual lane-broker process.
- [ ] **Confirm the `/queue` field shape.** The panel reads defensively across
  `in_flight|inflight|current`, `queued|queue`, `spill|spill_count` because the
  broker's exact `/queue` JSON keys were never pinned. Once live, lock to the real
  names and drop the guesses.
- [ ] **Vitest cache corruption after Tauri/PyInstaller builds** (seen twice):
  full suite dies with bogus `expect is not defined` / only ~73 tests collected.
  Fix is `rm -rf node_modules/.vite` — consider automating in the build skill.
- [ ] **Rebuild the desktop installer** — the last build predates both branch
  commits, so the installed app can't exercise the spill sliders.
- [ ] **Open PR** for `feat/local-broker-panel` → `master`.
- [ ] **Version bump** to 1.4.1+ before shipping. Same-version respins never
  trigger the auto-updater (see the v1.3.9 lesson).
- [ ] **Update the top-level `README.md`** — this feature is documented in
  `CLAUDE.md` but has no user-facing README section yet.

### Foundation / follow-ups
- [x] **Provider registry.** Module-level `_PROVIDERS` + optional
  `COCKPIT_PROVIDERS_FILE` override. `GET /api/local/providers` surfaces metadata
  (id, label, kind, scope, capabilities) to the frontend; ProviderPicker
  persists selection to localStorage. URLs and auth stay server-side (SSRF
  stance). Shipped 2026-07-24.
- [x] **Surface broker config in the UI.** `ProviderPicker.jsx` in the drawer
  (shows all registered providers, remote-scope entries tagged). Capability gating
  via `GET /api/local/providers` — panels render only when their cap exists.
  Spill sliders only when cap `spill` AND `scope=="local"`. Shipped 2026-07-24.
- [ ] **Remote sharing (the expansion target):** Cloudflare Tunnel + Access
  (owner-controlled auth — Access policies/service tokens; cockpit proxies with
  `CF-Access-Client-Id`/`CF-Access-Client-Secret` headers via registry
  `auth: {type: 'cf-access'}`, secrets server-side only). Registry
  `scope:"remote"` entry + broker `--readonly-remote` flag; writes stay
  owner-only regardless of auth.
- [ ] **Decouple metrics polling cadence.** Queue + metrics + spill all poll at 3s;
  metrics change slowly and could poll less often.
- [ ] (Optional) **FleetView integration** — surface local queue depth / tps
  alongside the per-session usage tiles.

### Broker-side (owned by broker team, tracked here for the handoff)
- [x] Spill-control endpoint (`PUT /config/spill`) — shipped; Cockpit wired.
- [ ] Nothing outstanding on Cockpit's behalf. `/queue` key names (above) are the
  only open contract question.
