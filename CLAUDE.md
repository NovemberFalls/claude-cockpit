# Claude Cockpit

Multi-session Claude Code manager with a FastAPI backend and React/Vite frontend, packaged via Tauri for desktop distribution.

## Project Structure

```
claude-cockpit/
  web/
    server.py          # FastAPI app (port 8420), auth, terminal CRUD, WS bridge
    pty_manager.py     # ConPTY process manager (Windows-specific, winpty)
    tests/             # Python test suite (pytest + pytest-asyncio)
    frontend/
      src/
        App.jsx        # Root component, all session state
        components/    # Sidebar, TerminalPane, TopBar, StatusBar, NewSessionDialog, HexGrid
        hooks/         # useTheme (active), useSessions/useWebSocket (unused)
        themes/        # themeData.js (20 themes: 10 palettes x dark/light)
      src-tauri/       # Tauri desktop wrapper (Rust)
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

## Architecture

- **ConPTY ctypes wrapper:** `pty_manager.py` uses `winpty.PtyProcess` to spawn `claude --model {model}` processes. For bundled (Tauri) mode, a ctypes wrapper around Windows ConPTY APIs handles pseudo-terminal creation.
- **SessionStateTracker:** Parses ANSI escape sequences from terminal output to track session state (model, status, token usage).
- **WebSocket bridge:** `/ws/terminal/{id}` proxies between the browser and ConPTY, with ping/pong heartbeat every 30 seconds.
- **Session model:** `{ id, name, terminalId, model, status, workdir }` -- workdir supported end-to-end from frontend through REST API to ConPTY cwd.

## Key Constraints

- **Windows-only PTY:** The ConPTY/winpty backend only works on Windows. No Linux/macOS PTY support.
- **Max 8 sessions:** Default concurrent session limit is 8, configurable via `MAX_SESSIONS` env var.
- **Idle timeout:** Sessions idle for 2 hours (configurable via `IDLE_TIMEOUT`) are automatically cleaned up.
