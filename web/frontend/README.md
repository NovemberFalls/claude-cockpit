# Plexar Studio frontend

React, Vite and xterm.js provide the desktop workspace for Claude Code and Codex CLI sessions. The local Python server owns PTYs, native conversation bindings and usage data; the frontend renders terminals, saved messages, reports and settings.

See the [project README](../../README.md) for CLI authentication, configuration and desktop packaging.

## Development

Use Node.js 20.19+ or 22.12+. From the repository root in PowerShell:

```powershell
npm --prefix web/frontend ci
python -m pip install -r web/requirements.txt
python web/server.py
```

In a second terminal, also from the repository root:

```powershell
npm --prefix web/frontend run dev
```

Open `http://localhost:5174`. Vite proxies API requests and terminal sockets to `http://localhost:8420`. The Windows CLI/PTY path is native and does not require WSL.

## Checks

```powershell
npm --prefix web/frontend test
npm --prefix web/frontend run lint
npm --prefix web/frontend run build
```

Tests cover terminal identity, replay ordering, native-history pagination and usage rendering. Browser rendering and real CLI interaction require their own checks; a mocked terminal does not establish visual or input behavior.

## Desktop bundle

Build the frontend before freezing the Python sidecar. The installed app serves the frontend embedded in that sidecar. Follow the [desktop build sequence](../../README.md#building-the-desktop-app-yourself), including `verify_sidecar_bundle.py`, before building the Tauri installer.

The public app is **Plexar Studio**. Existing internal storage keys, sidecar bundle name and installed application identifier remain compatible with earlier versions. Do not rename those identifiers as a cosmetic change.
