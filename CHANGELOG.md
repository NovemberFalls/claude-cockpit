# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Roadmap

### v0.3.0 — Cross-Platform & UX
- [ ] Linux PTY support (pty module + spawn)
- [ ] macOS PTY support
- [ ] Code splitting / lazy loading (bundle >500KB warning)
- [ ] Session search / filter
- [ ] Keyboard-driven session switching (Ctrl+Tab)
- [ ] Zoom controls (Ctrl+/-, Ctrl+mousewheel)

### v0.4.0 — Collaboration & Cloud
- [ ] Auto-update mechanism (Tauri updater plugin)
- [ ] Shared relay with user management
- [ ] Session sharing / spectator mode
- [ ] Export session transcripts

### Future
- [ ] Plugin system for custom session types
- [ ] Multi-monitor / detachable panes
- [ ] Session templates / presets

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
