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
        App.jsx        # Root component, all session state, session reconciliation, bridge polling
        components/    # Sidebar, TerminalPane, TopBar, StatusBar, NewSessionDialog, BridgeModal,
                       # ErrorBoundary, Toast, HexGrid, OnboardingModal, StateIcon, PopoutTerminal
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
- **Ctrl+C handling:** `TerminalPane.jsx` has a `customKeyEventHandler` — Ctrl+C copies when text is selected, sends `\x03` only when no selection.
- **Ctrl+V / paste handling:** A capture-phase `paste` DOM listener on the terminal container handles paste BEFORE xterm's own listener fires (avoiding double-paste / auto-submit). Image items in `clipboardData.items` are uploaded via `/api/upload` and the path is injected. Plain text uses `xterm.paste(text)` so xterm wraps it in bracketed-paste sequences when the PTY is in that mode (Claude Code is, by default). The `customKeyEventHandler` just returns `false` for Ctrl+V to suppress xterm sending the raw `\x16` character.

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

- **Manual relay (V1):** one-shot. The Bridge icon in any pane header opens `BridgeModal`. Pick another running session, choose "Relay my latest reply" (auto-fetches via `GET /api/terminals/{id}/latest-assistant`) or a custom message + preset chips, click Send. Backend wraps in bracketed paste and injects to the peer's PTY with a `[From session "<name>"]:` prefix.
- **Autonomous relay (V2):** the Auto tab in `BridgeModal` labels the initiating session "Lead" and the receiving session "Worker". Shows a neon-red warning panel + a confirm-twice gate. On confirm, both sessions get a framed kickoff prompt, and `bridge_manager` watches each side's JSONL via `tail_jsonl`. Each new assistant turn is auto-relayed to the peer (idle-gated, bracketed-paste wrapped). Bridge ends on: turn cap (`max_turns`, default 4), `BRIDGE-DONE` sentinel in any reply, user clicks Stop, either session dies, or PTY write fails.
- **Channel (V3):** the Channel tab in `BridgeModal` enables hub-topology N-session coordination (1 lead + N workers). User picks a lead (radio) and workers (checkboxes) then provides a kickoff prompt. The lead receives all worker output; the lead's output is broadcast to all workers. `channel_manager` (singleton in `bridge_manager.py`) manages `_ChannelRecord` instances and spawns N+1 relay tasks. Channel ends on: turn cap (`max_turns`, default 6), `BRIDGE-DONE` sentinel from any participant, user Stop, session death, or write failure. Lead pane shows "CHANNEL LEAD · turn X/Y · Stop" overlay (orange glow via `@keyframes channel-active-glow`); worker panes show "CHANNEL WORKER · turn X/Y · Stop".
- **Conflict guard:** `/api/bridge/auto` and `/api/bridge/channel` both return 409 if any requested session is already in an active bridge or active channel (`channel_manager.member_ids()`).
- **Active indicators:** App.jsx polls `GET /api/bridge` and `GET /api/bridge/channel` every 3s. Bridge panes show pulsing red glow; channel panes show pulsing orange glow.
- **Routes:** `GET /api/terminals/{id}/latest-assistant`, `POST /api/bridge/manual`, `POST /api/bridge/auto`, `DELETE /api/bridge/{id}`, `GET /api/bridge`, `POST /api/bridge/channel`, `DELETE /api/bridge/channel/{channel_id}`, `GET /api/bridge/channel`.

## Quick Resume Undo

Closing a pane via X kills the backend terminal but the local session record's `claude_session_id` is captured first. App.jsx then shows a 12-second Toast with an "Undo" action that calls `createSession` with `resumeSessionId: <claude_session_id>` (preferred) or `continueSession: true` (fallback when the session never produced a JSONL).

## Known Issues (Chat Mode)

- **`/remote-control` and `/rc` don't work from chat mode.** Claude Code returns "Unknown skill" for both commands. This appears to be an upstream Claude Code bug ([#29265](https://github.com/anthropics/claude-code/issues/29265)). Workaround: enable Remote Control globally via `/config` → "Enable Remote Control for all sessions", or start sessions with `claude --remote-control` flag.
- **Terminal view toggle is functional but limited.** The `>_` button switches to xterm.js terminal view. In chat mode, the PTY output queue is not consumed by the WebSocket, so terminal view may show stale output. Toggle back to chat mode for the canonical conversation view.

## Community Management

- **Weekly cadence:** Run `/triage-issues` and `/audit-repo` roughly once a week to review PRs, issues, and repo health.
- **PR review:** Always run `/review-pr {number}` before merging any contribution.
- **User context:** The project owner is new to open-source. When presenting PR/issue summaries, explain in plain English what the contributor wants to change and what risks it poses. Avoid git jargon.
