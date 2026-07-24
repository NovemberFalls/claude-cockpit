# Claude Cockpit

Multi-session Claude Code manager with a FastAPI backend and React/Vite frontend, packaged via Tauri for desktop distribution. Licensed under AGPL-3.0.

## Project Structure

```
claude-cockpit/
  web/
    server.py          # FastAPI app (port 8420), terminal CRUD, WS + bridge routes
    pty_manager.py     # PTY session manager (cross-platform via pty_backend.py)
    bridge_manager.py  # Peer-bridge: V1 manual relay + V2 autonomous loop between two sessions
    logging_config.py  # Structured logging setup (cockpit.server, cockpit.pty, cockpit.bridge)
    tests/             # Python test suite (pytest + pytest-asyncio)
    frontend/
      src/
        App.jsx        # Root component, all session state, session reconciliation, bridge + workflows polling
        components/    # Sidebar, TerminalPane, TopBar, StatusBar, NewSessionDialog, BridgeModal,
                       # ErrorBoundary, Toast, HexGrid, OnboardingModal, StateIcon, PopoutTerminal,
                       # WorkflowsPanel
        __tests__/     # Frontend tests (vitest)
        hooks/         # useTheme (active)
        themes/        # themeData.js (20 themes: 10 palettes x dark/light)
      src-tauri/       # Tauri desktop wrapper (Rust, NSIS installer)
  # Legacy directories (static/, src/cockpit/) removed in v1.3.0 hygiene sweep
```

## How to Run

**Backend:**
```bash
cd web && python server.py
```
Starts FastAPI on port 8420. Requires Python 3.11+.

**Frontend dev server:**
```bash
cd web/frontend && npm run dev
```
Vite dev server on port 5174, proxies API calls to the backend.

**Tauri desktop (dev):**
```bash
cd web/frontend && npm run tauri:dev
```

## How to Test

**Python backend tests:**
```bash
cd web && python -m pytest tests/ -v
```

**Frontend tests:**
```bash
cd web/frontend && npm test
```

**Lint frontend:**
```bash
cd web/frontend && npm run lint
```

## Conventions

- **CSS hover utilities:** Use CSS hover classes (`hover-bg-surface`, `hover-color-red`, etc.) defined in `index.css` instead of JS `onMouseEnter`/`onMouseLeave` handlers for performance.
- **Python logging:** Use `cockpit.server`, `cockpit.pty`, and other `cockpit.*` loggers via `logging.getLogger()`. No `print()` statements.
- **React components:** Sidebar sub-components (`SessionItem`, `LocationNode`, `LocationContextMenu`) are module-scope, not nested inside parent components. They receive all dependencies via props to avoid React identity/re-render issues.
- **Themes:** 10 color palettes with dark/light variants in `themeData.js`. Theme context provided by `useTheme` hook.
- **Error handling:** No bare `except Exception: pass`. Always log with `exc_info=True`.
- **User errors:** Surface via Toast notifications, not console.log.

## Architecture

- **PTY backend abstraction:** `pty_backend.py` provides `get_backend()` which selects the platform-appropriate PTY implementation: `winpty.PtyProcess` (dev mode on Windows), `conpty.PtyProcess` (bundled/Tauri mode on Windows), or `unix_pty.UnixPtyProcess` (Linux/macOS). `pty_manager.py` calls this factory to spawn `claude --model {model}` processes.
- **SessionStateTracker:** Parses ANSI escape sequences from terminal output to track session activity state (idle, busy, waiting, starting).
- **WebSocket bridge:** `/ws/terminal/{id}` proxies between the browser and ConPTY, with ping/pong heartbeat every 30 seconds.
- **Session model:** `{ id, name, terminalId, model, status, workdir }` -- workdir supported end-to-end from frontend through REST API to ConPTY cwd.
- **Startup cleanup:** Orphaned claude.exe processes killed via psutil, PID file for crash detection, session reconciliation with frontend.
- **Graceful shutdown:** Terminate sessions → cleanup uploads → delete PID → log.

## Drag-and-Drop Architecture

Two independent DnD systems share the same drop targets — be careful not to let one swallow the other:

- **File drops** (`onDrop` / `onDragOver` on the terminal area div in `TerminalPane.jsx`): uploads files via `/api/upload`. Must call `stopPropagation()` to prevent the pane-swap handler in `App.jsx` from also firing.
- **Pane swaps** (`onDrop` / `onDragOver` on the wrapper div in `App.jsx`): swaps `activeIds` array positions via `swapPanes()`. Triggered by dragging a pane header.
- **Session placement** (same wrapper handlers): drags a session from the sidebar into a specific slot via `placeSession()`.

**Critical rule:** The terminal-area file-drop handlers (`handleDrop`, `handleDragOver` in `TerminalPane.jsx`) MUST check whether the drag contains actual files BEFORE calling `stopPropagation()`. If `stopPropagation()` runs unconditionally, pane-swap drags are silently swallowed and the overlay never appears. Check `e.dataTransfer.types.includes("Files")` in `handleDragOver` and `e.dataTransfer.files.length` in `handleDrop` before intercepting.

## Key Constraints

- **Windows primary PTY:** ConPTY/winpty backend for Windows; `unix_pty.py` via ptyprocess for Linux/macOS.
- **Max 8 sessions:** Default concurrent session limit is 8, configurable via `MAX_SESSIONS` env var.
- **No idle timeout:** Idle timeout is disabled by default (`IDLE_TIMEOUT=0`). Dead sessions (process exited) are still purged after 30s.
- **PTY timeout protection:** Writes timeout after 5s, reads after 10s — prevents session lockups from zombie processes.
- **Per-session write serialization:** Every `TerminalSession` carries its own `asyncio.Lock`. The entire body of `write_pty_async` runs under `async with session.write_lock:`, so user keystrokes (from the WS handler) and bridge/channel injection (bracketed-paste chunks) never interleave their bytes inside the ConPTY pipe. Different sessions remain fully parallel.
- **Ctrl+C handling:** `TerminalPane.jsx` has a `customKeyEventHandler` — Ctrl+C copies when text is selected, sends `\x03` only when no selection.
- **Ctrl+V / paste handling:** A capture-phase `paste` DOM listener on the terminal container handles paste BEFORE xterm's own listener fires (avoiding double-paste / auto-submit). Image items in `clipboardData.items` are uploaded via `/api/upload` and the returned path is injected via `xterm.paste(path)` (NOT raw `ws.send`) so it is bracketed-paste wrapped — raw injection clobbers in-progress input in interactive prompts. Plain text likewise uses `xterm.paste(text)` so xterm wraps it in bracketed-paste sequences when the PTY is in that mode (Claude Code is, by default). The same image-paste path applies in `PopoutTerminal.jsx`. The `customKeyEventHandler` just returns `false` for Ctrl+V to suppress xterm sending the raw `\x16` character.

## Build & Release

- **Build order matters:** Frontend → PyInstaller → copy sidecar to `src-tauri/binaries/` → Tauri. A stale sidecar = broken desktop app.
- Release artifacts (exe files) are NOT committed to git — they are distributed via GitHub Releases.
- Use `/push-cockpit` to build, commit source, push, and upload to GitHub Releases.
- Use `/build-cockpit` for local builds only.
- Tauri targets NSIS only (MSI doesn't support alpha pre-release identifiers).
- **Auto-update:** Desktop app checks GitHub Releases for `latest.json` on startup. Tauri does NOT auto-generate `latest.json` — the push skill builds it from the `.nsis.zip.sig` file. Builds must be signed with `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` env vars. Signing key at `C:\Code\.tauri\claude-cockpit.key` (password-protected).
- **CRITICAL build lesson:** Always copy the fresh PyInstaller exe to `src-tauri/binaries/cockpit-server-x86_64-pc-windows-msvc.exe` BEFORE building Tauri. A stale sidecar = "Internal Server Error" on desktop launch.
- **Tauri webview:** `dragDropEnabled: false` in tauri.conf.json so the web-native file drop handler works in the desktop app.

## Peer Bridge

Two running cockpit sessions can exchange messages via `bridge_manager.py`:

- **Manual relay (V1):** one-shot. The Bridge icon in any pane header opens `BridgeModal`. Pick another running session, choose "Relay my latest reply" (auto-fetches via `GET /api/terminals/{id}/latest-assistant`) or a custom message + preset chips, click Send. Backend waits for the target to be idle (`_wait_for_idle_simple`; returns `{ok: False, "...busy..."}` if it never settles), then wraps in bracketed paste and injects to the peer's PTY with a `[From session "<name>"]:` prefix.
- **Typing-quiet gate:** both `_wait_for_idle` (V2 / V3) and `_wait_for_idle_simple` (V1) additionally block injection while the target session's user is actively typing. The WS handler stamps `session.last_user_input_time = time.monotonic()` on every keystroke; the gate refuses to advance until at least `_TYPING_QUIET_WINDOW` (1.0s) of typing-quiet has elapsed. Combined with the per-session write lock, this prevents the "bridge stutter" failure mode where bracketed-paste chunks fragment user input mid-burst.
- **Large-message file handoff:** all relay modes route through size-aware injection. Messages larger than `_RELAY_INLINE_MAX` (2048 bytes) are NOT pasted inline — ConPTY's input pipe drops bytes under a large fast burst, truncating the message. Instead `_maybe_file_handoff` writes the full text to a temp relay file (`_RELAY_DIR`, created via `tempfile.mkdtemp(prefix="cockpit_relays_")`) and injects a compact prompt naming the file path; the receiving session reads it. Relay files are GC'd opportunistically after `_RELAY_FILE_MAX_AGE` (10 min) on each new handoff and the whole dir is removed by `cleanup_relay_dir()` on graceful shutdown.
- **Autonomous relay (V2):** the Auto tab in `BridgeModal` labels the initiating session "Lead" and the receiving session "Worker". Shows a neon-red warning panel + a confirm-twice gate. On confirm, both sessions get a framed kickoff prompt, and `bridge_manager` watches each side's JSONL via `tail_jsonl`. Each new assistant turn is auto-relayed to the peer (idle-gated, bracketed-paste wrapped). Bridge ends on: turn cap (`max_turns`, default 4), `BRIDGE-DONE` sentinel in any reply, user clicks Stop, either session dies, or PTY write fails.
- **Channel (V3):** the Channel tab in `BridgeModal` enables hub-topology N-session coordination (1 lead + N workers). User picks a lead (radio) and workers (checkboxes) then provides a kickoff prompt. The lead receives all worker output; the lead's output is broadcast to all workers. `channel_manager` (singleton in `bridge_manager.py`) manages `_ChannelRecord` instances and spawns N+1 relay tasks. Channel ends on: turn cap (`max_turns`, default 6), `BRIDGE-DONE` sentinel from any participant, user Stop, session death, or write failure. Lead pane shows "CHANNEL LEAD · turn X/Y · Stop" overlay (orange glow via `@keyframes channel-active-glow`); worker panes show "CHANNEL WORKER · turn X/Y · Stop".
- **Conflict guard:** `/api/bridge/auto` and `/api/bridge/channel` both return 409 if any requested session is already in an active bridge or active channel (`channel_manager.member_ids()`).
- **Active indicators:** App.jsx polls `GET /api/bridge` and `GET /api/bridge/channel` every 3s. Bridge panes show pulsing red glow; channel panes show pulsing orange glow.
- **Routes:** `GET /api/terminals/{id}/latest-assistant`, `POST /api/bridge/manual`, `POST /api/bridge/auto`, `DELETE /api/bridge/{id}`, `GET /api/bridge`, `POST /api/bridge/channel`, `DELETE /api/bridge/channel/{channel_id}`, `GET /api/bridge/channel`.

## Workflow Status Panel

Cockpit surfaces a per-session view of in-flight Claude Code `Workflow` tool invocations (the harness's dynamic multi-agent runtime). The panel is read-only — Cockpit does not orchestrate workflows; it just observes what's running inside each session.

- **Data source:** `GET /api/terminals/{id}/workflows` reads the session's JSONL via `jsonl_watcher.read_all_messages`, extracts `tool_use` entries whose `tool_name == "Workflow"`, pairs each with its matching `tool_result` (by `tool_use_id`), and returns the 20 most recent — sorted newest first.
- **Response shape (per workflow):** `{tool_id, name, description, args, script_preview, script_path, started_at, completed_at|null, is_error, status: "in_progress"|"completed"}`. The `script_preview` is truncated by `_summarize_tool_input` (max ~200 chars) and is intentionally NOT surfaced in the UI — workflow scripts can carry sensitive prompts.
- **UI:** `WorkflowsPanel.jsx` renders a popover with one row per workflow: status dot (pulsing accent = in progress, green = completed clean, red = completed with error), name, description, and relative time. The popover is opened by a `Workflow` icon in the `TerminalPane` header that is conditionally rendered when `workflowSummary.count > 0`; an inline badge shows `inProgressCount` when nonzero.
- **Polling:** `App.jsx` runs a single shared `setInterval` (3s) that fans out one `fetch` per active session and stores summaries in `workflowsByTerminal`. Errors are silently swallowed — workflow polling is best-effort background work.

## Local Model Broker (LM Studio lane broker)

Cockpit surfaces a **machine-global** (not per-session) read-only view of a local-lane broker that fronts LM Studio (and, later, other local model servers). The broker is a separate process; Cockpit only observes it. Foundation for future local-provider integrations.

- **Backend proxy (`server.py`):** `GET /api/local/queue` and `GET /api/local/metrics?window=lifetime|24h|session` proxy the broker (base URL fixed server-side via `COCKPIT_BROKER_URL`, default `http://127.0.0.1:1235`). The browser never supplies the broker URL — only the *validated* `window` param is forwarded (SSRF guard). An unreachable broker returns `503 {reachable: false}` so the poller stays quiet.
- **Spill control (`server.py`):** `GET /api/local/spill` proxies the broker's per-class thresholds + counters; `POST/PUT /api/local/spill` sets them. **Spill = seconds of predicted wait per lane class** (`interactive` / `worker` / `batch`), NOT queue depth. Body is a partial `{class: seconds|null}` map (`null` disables spill for that class); validated all-or-nothing server-side (unknown class or value outside `0..86400` → 400, nothing forwarded) then sent to the broker as `PUT /config/spill`. The change is **session-only on the broker** (`persisted: false`) — resets to CLI defaults on broker restart, so it is fully reversible; durable changes stay with the operator's `--spill-*` flags. This is the *only* write on the service.
- **Broker contract (confirmed by broker team):** `/queue` → in-flight job + class, queued jobs in order, `estimated_clear_seconds`, spill count. `/metrics` → `runs_total`, `prompts_total`, `tokens_total {prompt, completion}`, `tokens_per_sec {current, avg}`, `run_time_ms {min, max, avg, p50, p95}`, and `by_session[]` / `by_agent[]` / `by_lane_class[]`, plus `window_start` + `persisted`. **Definitions (rendered verbatim in the UI):** run = one completion call to a lane; prompt = one client dispatch (distinct `X-Trace-Id`); session = `X-Client-Id`; agent = `X-Agent-Id`. tps = completion tokens ÷ wall clock (includes prompt-processing) — a floor on decode speed, not LM Studio's stats number.
- **UI:** a `Cpu` indicator in the `TopBar` (COCKPIT bar) shows live queue depth + tps when enabled; clicking opens a drawer composing `LaneQueuePanel.jsx` (queue tile + one live per-class spill slider each, labeled in seconds, `off` toggle = null) and `LocalMetricsPanel.jsx` (reporting dashboard + `lifetime|24h|session` window selector). Slider commits fire on release (`onMouseUp`/`onKeyUp`) via `App.jsx`'s `commitSpill(cls, value)` → `POST /api/local/spill`; the broker's echoed full state replaces local state. Enablement is a `localStorage` flag (`cockpit-local-enabled`).
- **Polling (`App.jsx`):** a single 3s `setInterval` fetches `/api/local/queue` + `/api/local/metrics` + `/api/local/spill`, **gated on `localEnabled`** so a disabled feature does zero background work. Errors are swallowed and rendered as an offline state (mirrors the WorkflowsPanel best-effort pattern).

## Quick Resume Undo

Closing a pane via X kills the backend terminal but the local session record's `claude_session_id` is captured first. App.jsx then shows a 12-second Toast with an "Undo" action that calls `createSession` with `resumeSessionId: <claude_session_id>` (preferred) or `continueSession: true` (fallback when the session never produced a JSONL).

## Community Management

- **Weekly cadence:** Run `/triage-issues` and `/audit-repo` roughly once a week to review PRs, issues, and repo health.
- **PR review:** Always run `/review-pr {number}` before merging any contribution.
- **User context:** The project owner is new to open-source. When presenting PR/issue summaries, explain in plain English what the contributor wants to change and what risks it poses. Avoid git jargon.
