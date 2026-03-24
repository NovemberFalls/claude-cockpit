# Claude Cockpit

The only multi-session [Claude Code](https://docs.anthropic.com/en/docs/claude-code) manager with built-in **agent orchestration**. Run one Claude session as a coordinator that delegates tasks to other Claude sessions — no other tool does this. Also works as a standalone multi-session terminal with tabs, themes, and a native desktop app.

![Claude Cockpit](screenshot.svg)

---

## Orchestrator Mode

Claude Cockpit's defining feature: run one Claude Code session as an **orchestrator** that coordinates other Claude sessions as workers via MCP (Model Context Protocol).

- The orchestrator session acts as a planner and dispatcher
- Worker sessions receive delegated subtasks and report results back
- Multiple agents collaborate in parallel within a single Cockpit window
- No competing product (Wave Terminal, Warp, VS Code) has this capability

**How to use it:** Open the info legend (ⓘ icon in the top bar) and select **Orchestrator Mode** for step-by-step setup instructions.

This is the feature that makes Claude Cockpit unique. If you're running complex multi-agent Claude workflows, this is why you're here.

---

## What Is This?

Claude Cockpit lets you:

- **Orchestrate multiple Claude agents** — one session coordinates others via MCP (unique capability)
- Run **up to 8 Claude Code sessions** simultaneously, view 1, 2, or 4 at a time in split panes
- Organize sessions by **project folder** (workspace)
- Choose from **20 themes** (dark and light variants)
- **Drag and drop files** into sessions
- Resume previous Claude sessions
- Pick your Claude model (Sonnet, Opus, Haiku)

It works by wrapping the `claude` CLI in a web-based terminal emulator (xterm.js), managed through a FastAPI backend that handles the PTY (pseudo-terminal) connections.

---

## Prerequisites

> **Platform:** Claude Cockpit currently supports **Windows 10/11** only. Linux and macOS support is not yet available — contributions welcome!

Before you start, make sure you have these installed:

| Requirement | How to check | How to install |
|-------------|-------------|----------------|
| **Python 3.11+** | `python --version` | [python.org/downloads](https://www.python.org/downloads/) |
| **Node.js 18+** | `node --version` | [nodejs.org](https://nodejs.org/) |
| **Claude CLI** | `claude --version` | `npm install -g @anthropic-ai/claude-code` |

Claude CLI must be logged in and working. Run `claude` in your terminal first to make sure it works on its own.

---

## Quick Start (Development)

### 1. Clone the repo

```bash
git clone https://github.com/NovemberFalls/claude-cockpit.git
cd claude-cockpit
```

### 2. Install Python dependencies

```bash
pip install -r web/requirements.txt
```

> **Note:** You also need `pywinpty` on Windows:
> ```bash
> pip install pywinpty
> ```

### 3. Install frontend dependencies

```bash
cd web/frontend
npm install
cd ../..
```

### 4. Start the backend server

```bash
cd web
python server.py
```

This starts the API server on **http://localhost:8420**.

### 5. Start the frontend dev server (separate terminal)

```bash
cd web/frontend
npm run dev
```

This starts the Vite dev server on **http://localhost:5174**.

### 6. Open the app

Go to **http://localhost:5174** in your browser. You should see the cockpit interface. Click the **+** button in the sidebar to create your first Claude session.

---

## Download

Pre-built executables are available on the [GitHub Releases](https://github.com/NovemberFalls/claude-cockpit/releases) page.

### Option A: Browser-Based (simplest)

1. Download **`claude-cockpit-browser.exe`** from the latest release
2. Double-click it
3. Your browser will automatically open to **http://localhost:8420**
4. That's it — the server and frontend are bundled together

To stop: close the terminal window that appeared, or press `Ctrl+C`.

> **Tip:** You can suppress the auto-browser-open by setting the environment variable `NO_BROWSER=1`.

### Option B: Desktop App (native window)

1. Download **`Claude Cockpit_x64-setup.exe`** from the latest release
2. Follow the installer prompts (installs to your user folder, no admin needed)
3. Launch "Claude Cockpit" from your Start Menu or Desktop shortcut
4. The app opens in its own native window — no browser needed

The desktop app bundles the server internally and starts it automatically.

> **Auto-Update:** The desktop app checks for updates on startup. When a new version is available, you'll see a notification with an **Install & Restart** button — one click to update.

---

## Building the Executables Yourself

### Browser-Based exe

```bash
# 1. Build the React frontend
cd web/frontend
npm run build

# 2. Build the Python executable
cd ..
python -m PyInstaller --clean --noconfirm cockpit-server.spec
```

Output: `web/dist/claude-cockpit.exe` (~41 MB)

### Desktop App (Tauri)

Requires [Rust](https://rustup.rs/) to be installed.

```bash
# 1. Build the React frontend
cd web/frontend
npm run build

# 2. Build the PyInstaller sidecar
cd ..
python -m PyInstaller --clean --noconfirm cockpit-server.spec

# 3. Copy sidecar to Tauri binaries
cp dist/claude-cockpit.exe frontend/src-tauri/binaries/cockpit-server-x86_64-pc-windows-msvc.exe

# 4. Build the Tauri app
cd frontend
npx tauri build
```

Output: `web/frontend/src-tauri/target/release/bundle/nsis/Claude Cockpit_<version>_x64-setup.exe` (~42 MB)

---

## How to Use the App

### Creating a Session

1. Click the **+** button in the sidebar (or press `Ctrl+Shift+N`)
2. Pick a **working directory** — this is the project folder Claude will work in
3. Optionally give the session a name
4. Choose your model (Sonnet is the default)
5. Click **Create**

### Layouts

Use the layout buttons in the bottom status bar to switch between:

- **1x1** — single pane (full screen)
- **2x1** — two panes side by side
- **2x2** — four panes in a grid

Or use keyboard shortcuts: `Ctrl+Shift+!` (1x1), `Ctrl+Shift+@` (2x1), `Ctrl+Shift+$` (2x2).

### Sidebar

- **Active sessions** are grouped by their working directory
- **Locations** shows your saved project directories for quick access
- Click a session to focus it in a pane
- Right-click for options (new session in same folder, remove location)

### Themes

Click the palette icon in the top bar to cycle through 20 themes:

Tokyo Night, Nord, Dracula, Gruvbox, One Dark, Solarized, Synthwave, Monokai, Catppuccin, GitHub — each with dark and light variants.

### File Upload

Drag and drop files directly onto a terminal pane. Supported file types include code files, images, PDFs, JSON, CSV, and more (up to 50 MB each).

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+N` | New session |
| `Ctrl+Shift+B` | Toggle sidebar |
| `Ctrl+Shift+!` | 1x1 layout |
| `Ctrl+Shift+@` | 2x1 layout |
| `Ctrl+Shift+$` | 2x2 layout |

---

## Configuration

Copy `web/.env.example` to `web/.env` and edit as needed:

```env
# Server config
HOST=0.0.0.0
PORT=8420

# Maximum concurrent sessions (default: 8)
MAX_SESSIONS=8

# Idle session timeout in seconds (default: 7200 = 2 hours)
IDLE_TIMEOUT=7200
```

---

## MCP Servers

Claude sessions running inside Cockpit automatically use any [MCP servers](https://modelcontextprotocol.io/) configured in your Claude Code setup. MCP servers extend what Claude can do — browser automation, database access, file management, and more.

> **Cockpit uses MCP for its Orchestrator Mode.** The orchestrator session connects to worker sessions via MCP, enabling true agent-to-agent coordination. See the [Orchestrator Mode](#orchestrator-mode) section above for details.

### Finding MCP Servers

- **[Official MCP Registry](https://registry.modelcontextprotocol.io/)** — The canonical directory of MCP servers
- **[MCP Server Repository](https://github.com/modelcontextprotocol/servers)** — Reference implementations and community servers

### Configuring MCP Servers

MCP servers are configured in your Claude Code settings (`~/.claude/settings.json`). Example:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@anthropic-ai/mcp-filesystem"]
    },
    "browser": {
      "command": "npx",
      "args": ["-y", "@anthropic-ai/mcp-browser"]
    }
  }
}
```

Once configured, MCP tools are available in every Claude session — including those launched from Cockpit. No additional setup needed inside the app.

---

## Project Structure

```
claude-cockpit/
├── web/
│   ├── server.py           # FastAPI backend (REST + WebSocket)
│   ├── pty_manager.py      # PTY session manager
│   ├── pty_backend.py      # PTY backend abstraction (add Linux/macOS backends here)
│   ├── conpty.py           # Windows ConPTY ctypes wrapper (PyInstaller mode)
│   ├── logging_config.py   # Structured logging setup
│   ├── cockpit_mcp.py      # MCP orchestrator tools
│   ├── tests/              # Python test suite (24 tests)
│   ├── requirements.txt    # Python dependencies
│   ├── cockpit-server.spec # PyInstaller build config
│   └── frontend/
│       ├── src/
│       │   ├── App.jsx              # Main app component
│       │   ├── components/          # UI components
│       │   ├── __tests__/           # Frontend tests (70 tests)
│       │   ├── themes/themeData.js  # 20 theme definitions
│       │   └── hooks/useTheme.jsx   # Theme provider
│       ├── src-tauri/               # Tauri desktop wrapper
│       ├── vitest.config.js
│       └── package.json
├── .github/workflows/       # CI/CD (GitHub Actions)
├── pyproject.toml
├── CONTRIBUTING.md
└── README.md
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST` | `0.0.0.0` | Bind address |
| `PORT` | `8420` | Server port |
| `MAX_SESSIONS` | `8` | Maximum concurrent terminal sessions |
| `IDLE_TIMEOUT` | `7200` | Kill idle sessions after N seconds (0 = disabled) |
| `NO_BROWSER` | `0` | Set to `1` to suppress auto-opening browser |

---

## Testing

### Backend Tests (Python)

```bash
cd web
python -m pytest tests/ -v
```

Runs **24 tests** covering:

| Test File | What It Tests |
|-----------|--------------|
| `test_server.py` | Health endpoint, browse API, auth, git status |
| `test_pty_manager.py` | Session lifecycle, max limits, kill/shutdown |
| `test_session_state_tracker.py` | State transitions, token/cost parsing, idle detection |

### Frontend Tests (Vitest)

```bash
cd web/frontend
npm test
```

Runs **70 tests** covering:

| Test File | What It Tests |
|-----------|--------------|
| `themeData.test.js` | All 20 themes have required properties, getTheme/listThemes/applyThemeToDOM |

### CI/CD

Tests run automatically on push and PR via GitHub Actions (`.github/workflows/ci.yml`).

---

## Troubleshooting

### "claude CLI not found"

The app needs the `claude` CLI installed and in your system PATH.

```bash
npm install -g @anthropic-ai/claude-code
claude --version   # should print a version number
```

### Port 8420 already in use

Something else is using port 8420. Either stop it, or change the port:

```bash
PORT=9000 python server.py
```

### Terminal shows "[Session ended]"

The Claude process exited. This can happen if:
- Claude CLI isn't authenticated (run `claude` manually first)
- The working directory doesn't exist
- Claude crashed (check the terminal output for errors)

### WebSocket errors in the console

Transient `ECONNABORTED` or `ECONNRESET` errors in the Vite dev server console are normal during page reloads. They don't affect functionality.

### The exe won't start / antivirus blocks it

PyInstaller executables are sometimes flagged by antivirus software. You may need to add an exception for `claude-cockpit.exe` or `Claude Cockpit` in your antivirus settings.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Python, FastAPI, Uvicorn, pywinpty |
| Frontend | React 19, Vite 8, xterm.js, Tailwind CSS |
| Desktop | Tauri 2 (Rust + WebView2) |
| Packaging | PyInstaller (server exe), NSIS (installer) |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

---

## Privacy

Claude Cockpit runs entirely on your machine. No data is collected, transmitted, or stored on external servers. Your sessions, code, and conversations never leave your computer.

---

## License

Claude Cockpit is licensed under the [GNU Affero General Public License v3.0](LICENSE).

Copyright (c) 2026 NovemberFalls
