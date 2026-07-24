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
- [ ] **Provider registry.** Today the broker base is a single env var
  (`COCKPIT_BROKER_URL`), LM Studio only. The stated goal was a foundation for
  *multiple* local providers (Ollama, vLLM, …) — promote to a real registry
  (`{id, label, queue_url, metrics_url, capabilities}`) when the second provider
  lands. Keep the browser out of URL selection (SSRF).
- [ ] **Surface broker config in the UI.** Enablement is a `localStorage` flag with
  no way to see/change the broker URL or reachability from the drawer.
- [ ] **Decouple metrics polling cadence.** Queue + metrics + spill all poll at 3s;
  metrics change slowly and could poll less often.
- [ ] (Optional) **FleetView integration** — surface local queue depth / tps
  alongside the per-session usage tiles.

### Broker-side (owned by broker team, tracked here for the handoff)
- [x] Spill-control endpoint (`PUT /config/spill`) — shipped; Cockpit wired.
- [ ] Nothing outstanding on Cockpit's behalf. `/queue` key names (above) are the
  only open contract question.
