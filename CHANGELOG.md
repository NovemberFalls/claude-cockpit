# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Roadmap

### v0.3.0 — Linux & UX
- [x] Linux/macOS PTY support (`unix_pty.py` via ptyprocess, registered in `get_backend()`)
- [ ] Code splitting / lazy loading (bundle >500KB warning)
- [ ] Session search / filter
- [ ] Keyboard-driven session switching (Ctrl+Tab)
- [x] Zoom controls (Ctrl+/-, Ctrl+mousewheel, Ctrl+0 reset)

### v0.4.0 — Cross-Platform
- [x] Linux PTY backend (`UnixPtyProcess` in `unix_pty.py`, implements `PtyProcess` ABC)
- [x] macOS PTY backend (same `UnixPtyProcess` — ptyprocess works on both)
- [ ] CI matrix: Linux + macOS runners
- [ ] Homebrew formula / apt package

### Future
- [ ] Plugin system for custom session types
- [ ] Multi-monitor / detachable panes
- [ ] Session templates / presets
- [ ] Session sharing / spectator mode

## [Unreleased]

### Changed
- New app branding: neon eye/code-bracket logo replaces hexagon icon across all locations (Tauri icons, favicon, TopBar)
- Ctrl+C now copies selected text to clipboard instead of sending interrupt; Ctrl+C without selection still sends `\x03`
- Ctrl+V / Ctrl+Shift+V paste from clipboard into terminal
- Idle session timeout disabled by default (`IDLE_TIMEOUT=0`) — sessions no longer self-close after 2 hours

### Removed
- Token/cost display removed from status bar (regex-based parsing was unreliable — matched arbitrary numbers/dollar amounts in terminal output)

### Fixed
- PTY write/read operations now have timeout protection (5s write, 10s read) to prevent session lockups from zombie processes
- Failed PTY writes mark session as dead immediately instead of silently failing
- Pane drag-and-drop reordering broken by file-drop handler calling `stopPropagation()` on all drags — now only intercepts actual file drops, letting pane-swap events bubble to the parent wrapper

## [0.2.18-alpha] - 2026-03-24

### Added
- Linux and macOS PTY support via `unix_pty.py` (`UnixPtyProcess` implementing the `PtyProcess` ABC using `ptyprocess`)
- `get_backend()` now routes to `UnixPtyProcess` for `linux` and `darwin` platforms
- Platform-aware working directory picker (`/api/browse` returns `["/"]` root on Linux/macOS)
- 38 new tests for backend factory routing, ABC compliance, and non-blocking read contract

### Changed
- PATH construction in `create_terminal()` is now platform-aware (`os.pathsep` throughout; Linux/macOS prepends `~/.local/bin` and `/usr/local/bin`)
- MCP config path validation accepts POSIX absolute paths on Linux/macOS (with `shlex.quote` for injection safety)
- `pywinpty` dependency is now Windows-only; `ptyprocess` added for Linux/macOS

## [0.2.0-alpha] - 2026-03-15

### Open Source Release
- Licensed under AGPL-3.0
- Added LICENSE, CONTRIBUTING.md, SECURITY.md, CODE_OF_CONDUCT.md
- Added GitHub issue templates (bug report, feature request) and PR template
- Release artifacts distributed via GitHub Releases (removed from git history)
- Repository cleaned from 164MB to 295KB via git-filter-repo
- Added project management skills: /review-pr, /audit-repo, /triage-issues
- Updated README with download links, platform notice, contributing section
- Added license fields to pyproject.toml, package.json, Cargo.toml

### Auto-Update (Desktop)
- Tauri updater plugin with signed NSIS artifacts
- Checks for updates on startup via GitHub Releases (latest.json)
- In-app toast notification with "Install & Restart" button
- Signing keypair generated, builds produce signed update bundles

### UI
- MCP Servers button in sidebar links to official registry
- Disabled Tauri drag-drop interception so web file drop works in desktop app

### Added (Stability Sprint — 2026-03-14)

- Structured logging (cockpit.server, cockpit.pty loggers)
- Health check endpoint (GET /health)
- Orphaned process cleanup on startup (psutil)
- PID file for crash detection
- Session reconciliation on backend restart
- React ErrorBoundary component
- Toast notification system for API errors
- WebSocket heartbeat (ping/pong every 30s)
- Max session limit (configurable, default 8)
- Idle session timeout (configurable, default 2h)
- Upload directory size limit (200MB)
- Python test suite (24 tests)
- GitHub Actions CI pipeline
- CLAUDE.md project conventions

### Changed
- Replaced all print() with structured logging
- Tightened CORS (explicit methods/headers instead of wildcards)
- Graceful shutdown with upload cleanup and PID file removal
- Version bumped to 0.2.0-alpha

### Fixed
- Bare `except Exception: pass` blocks now log errors
- Stale localStorage sessions after backend crash

### Security
- SECRET_KEY warning on non-localhost with default value
- Tauri CSP (was null, now restrictive)
