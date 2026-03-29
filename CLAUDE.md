# Claude Cockpit

Multi-session Claude Code manager with a FastAPI backend and React/Vite frontend, packaged via Tauri for desktop distribution. Licensed under AGPL-3.0.

## Project Structure

```
claude-cockpit/
  web/
    server.py          # FastAPI app (port 8420), auth, terminal CRUD, WS bridge
    pty_manager.py     # ConPTY process manager (Windows-specific, winpty)
    logging_config.py  # Structured logging setup (cockpit.server, cockpit.pty)
    auth.py            # (removed — local-only, no auth needed)
    tests/             # Python test suite (pytest + pytest-asyncio, 24 tests)
    frontend/
      src/
        App.jsx        # Root component, all session state, session reconciliation
        components/    # Sidebar, TerminalPane, TopBar, StatusBar, NewSessionDialog,
                       # ErrorBoundary, Toast, ConfirmDialog, HexGrid, ApiKeysPanel
        __tests__/     # Frontend tests (vitest, 70 tests)
        hooks/         # useTheme (active)
        themes/        # themeData.js (20 themes: 10 palettes x dark/light)
      src-tauri/       # Tauri desktop wrapper (Rust, NSIS installer)
    static/            # Legacy vanilla JS app (unused)
  src/cockpit/         # Legacy TUI (Textual, not actively used)
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
- **React components:** Sidebar sub-components (`SessionItem`, `LocationNode`, `InstanceGroup`) are module-scope, not nested inside parent components. They receive all dependencies via props to avoid React identity/re-render issues.
- **Themes:** 10 color palettes with dark/light variants in `themeData.js`. Theme context provided by `useTheme` hook.
- **Error handling:** No bare `except Exception: pass`. Always log with `exc_info=True`.
- **User errors:** Surface via Toast notifications, not console.log.

## Architecture

- **ConPTY ctypes wrapper:** `pty_manager.py` uses `winpty.PtyProcess` to spawn `claude --model {model}` processes. For bundled (Tauri) mode, a ctypes wrapper around Windows ConPTY APIs handles pseudo-terminal creation.
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
- **Ctrl+C handling:** `TerminalPane.jsx` has a `customKeyEventHandler` — Ctrl+C copies when text is selected, sends `\x03` only when no selection. Ctrl+V pastes from clipboard.

## Build & Release

- **Build order matters:** Frontend → PyInstaller → copy sidecar to `src-tauri/binaries/` → Tauri. A stale sidecar = broken desktop app.
- Release artifacts (exe files) are NOT committed to git — they are distributed via GitHub Releases.
- Use `/push-cockpit` to build, commit source, push, and upload to GitHub Releases.
- Use `/build-cockpit` for local builds only.
- Tauri targets NSIS only (MSI doesn't support alpha pre-release identifiers).
- **Auto-update:** Desktop app checks GitHub Releases for `latest.json` on startup. Tauri does NOT auto-generate `latest.json` — the push skill builds it from the `.nsis.zip.sig` file. Builds must be signed with `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` env vars. Signing key at `C:\Code\.tauri\claude-cockpit.key` (password-protected).
- **CRITICAL build lesson:** Always copy the fresh PyInstaller exe to `src-tauri/binaries/cockpit-server-x86_64-pc-windows-msvc.exe` BEFORE building Tauri. A stale sidecar = "Internal Server Error" on desktop launch.
- **Tauri webview:** `dragDropEnabled: false` in tauri.conf.json so the web-native file drop handler works in the desktop app.

## Community Management

- **Weekly cadence:** Run `/triage-issues` and `/audit-repo` roughly once a week to review PRs, issues, and repo health.
- **PR review:** Always run `/review-pr {number}` before merging any contribution.
- **User context:** The project owner is new to open-source. When presenting PR/issue summaries, explain in plain English what the contributor wants to change and what risks it poses. Avoid git jargon.
