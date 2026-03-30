"""FastAPI web server for Claude Cockpit -- PTY-bridged interactive terminals."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time as _time
import uuid
import webbrowser
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from starlette.requests import Request

load_dotenv()

import logging_config
logging_config.setup()
logger = logging.getLogger("cockpit.server")

from pty_manager import pty_manager
import workspace_manager
from workspace_watcher import WorkspaceWatcher

START_TIME = _time.time()

app = FastAPI(
    title="Claude Cockpit Web",
    description="Multi-session Claude CLI terminal manager",
    version="1.0.0",
)

# CORS: allow Tauri webview origins + Vite dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "tauri://localhost",
        "https://tauri.localhost",
        "http://localhost:5174",
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)

# Detect PyInstaller bundle for static file path
if getattr(sys, "_MEIPASS", None):
    STATIC_DIR = Path(sys._MEIPASS) / "static"
    FRONTEND_DIST = Path(sys._MEIPASS) / "frontend_dist"
else:
    STATIC_DIR = Path(__file__).parent / "static"
    FRONTEND_DIST = Path(__file__).parent / "frontend" / "dist"

# Session-scoped temp directory for file uploads
UPLOAD_DIR = Path(tempfile.mkdtemp(prefix="cockpit_uploads_"))
# Temp directory for MCP config files (one per orchestrator session)
_MCP_CONFIG_DIR = Path(tempfile.mkdtemp(prefix="cockpit_mcp_"))

# ── MCP script bootstrap ──────────────────────────────────────────────────────
# Write cockpit_mcp.py to the config dir ONCE at startup so all orchestrator
# sessions share a single stable, non-volatile path.  This is resilient to:
#   • PyInstaller bundles where _MEIPASS is volatile (old builds without spec fix)
#   • Dev mode where the source tree may be at any path
#   • Future builds — the path is always _MCP_CONFIG_DIR/cockpit_mcp.py
_MCP_SCRIPT_PATH: Path | None = None

def _bootstrap_mcp_script() -> None:
    """Locate cockpit_mcp.py and write a stable copy to _MCP_CONFIG_DIR.

    Call once at startup.  Sets _MCP_SCRIPT_PATH or logs a clear error.
    """
    global _MCP_SCRIPT_PATH
    candidates = [
        Path(__file__).parent / "cockpit_mcp.py",          # dev or bundled (spec-fixed)
        Path(sys.executable).parent / "cockpit_mcp.py",    # beside exe fallback
    ]
    src: Path | None = None
    for c in candidates:
        if c.exists():
            src = c
            break

    dest = _MCP_CONFIG_DIR / "cockpit_mcp.py"
    if src is not None:
        shutil.copy2(src, dest)
        logger.info("MCP script bootstrapped from %s → %s", src, dest)
    else:
        # Source not found (old bundle without spec fix) — log loudly so it's debuggable.
        logger.error(
            "cockpit_mcp.py not found in any candidate location %s. "
            "Orchestrator mode will be unavailable until the app is rebuilt.",
            [str(c) for c in candidates],
        )
        return  # _MCP_SCRIPT_PATH stays None
    _MCP_SCRIPT_PATH = dest

_bootstrap_mcp_script()

# ── Workspace watcher & WebSocket broadcaster ────────────────────────────────
# Lock protecting workspace_events lists on TerminalSession objects.
# Shared between the watcher thread (writer) and the REST handler (reader/drainer).
_workspace_events_lock = threading.Lock()

# Connected workspace UI WebSocket clients (set of WebSocket objects)
_workspace_ws_clients: set = set()
_workspace_ws_lock = threading.Lock()

# Event loop reference — set at startup so the watcher thread can schedule
# coroutines onto the main asyncio loop via run_coroutine_threadsafe.
_app_event_loop: asyncio.AbstractEventLoop | None = None


async def _broadcast_workspace_event(compound_id: str, filename: str) -> None:
    """Broadcast a workspace file-change event to all connected UI clients."""
    if not _workspace_ws_clients:
        return
    msg = json.dumps({"type": "file_changed", "compound_id": compound_id, "filename": filename})
    dead = set()
    with _workspace_ws_lock:
        clients = set(_workspace_ws_clients)
    for ws in clients:
        try:
            await ws.send_text(msg)
        except Exception:
            dead.add(ws)
    if dead:
        with _workspace_ws_lock:
            _workspace_ws_clients.difference_update(dead)


def _on_workspace_file_event(compound_id: str, filename: str) -> None:
    """Called from watcher thread — schedules broadcast on the main event loop."""
    if _app_event_loop is not None:
        asyncio.run_coroutine_threadsafe(
            _broadcast_workspace_event(compound_id, filename),
            _app_event_loop,
        )


_workspace_watcher = WorkspaceWatcher(
    pty_manager.sessions,
    _workspace_events_lock,
    on_event=_on_workspace_file_event,
)

MAX_FILE_SIZE = 50 * 1024 * 1024  # 50MB
MAX_UPLOAD_DIR_SIZE = 200 * 1024 * 1024  # 200MB total
_upload_dir_size = 0  # Running total of bytes in UPLOAD_DIR
# Lock serialises the quota-check-then-write sequence in upload_files().
# Without this, concurrent async requests can both read a stale _upload_dir_size,
# both pass the quota check, and together exceed MAX_UPLOAD_DIR_SIZE.
_upload_lock = asyncio.Lock()

# PID file for crash detection
PID_FILE = Path(__file__).parent / ".cockpit.pid"

ALLOWED_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
    ".txt", ".md", ".csv", ".json", ".xml", ".yaml", ".yml",
    ".py", ".js", ".ts", ".tsx", ".jsx", ".rs", ".go", ".java",
    ".c", ".cpp", ".h", ".hpp", ".cs", ".rb", ".php", ".sh",
    ".bash", ".zsh", ".sql", ".html", ".css", ".scss", ".toml",
    ".ini", ".cfg", ".env", ".lua", ".kt", ".swift", ".r",
    ".pdf",
}


# ── Health Check ──────────────────────────────────────────


@app.get("/health")
async def health():
    """Health check endpoint for monitoring."""
    return JSONResponse({
        "status": "ok",
        "sessions": len(pty_manager.sessions),
        "uptime_seconds": int(_time.time() - START_TIME),
    })


# ── Routes ───────────────────────────────────────────────


@app.get("/")
async def index():
    # Serve React frontend dist if available (production build)
    if FRONTEND_DIST.is_dir() and (FRONTEND_DIST / "index.html").exists():
        # Never cache index.html — it references versioned asset hashes that change
        # on every build.  If WebView2 (or a browser) caches this, users see stale
        # JS/CSS after an update because the old index.html still points to the old
        # hashed asset filenames.
        return FileResponse(
            FRONTEND_DIST / "index.html",
            headers={"Cache-Control": "no-store, no-cache, must-revalidate"},
        )
    # Fallback to legacy static frontend
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/me")
async def me():
    """Always authenticated in local mode."""
    return {"authenticated": True, "mode": "local", "email": "local@localhost", "name": "Local User"}


# ── File Upload ──────────────────────────────────────────


@app.post("/api/upload")
async def upload_files(request: Request, files: list[UploadFile] = File(...)):
    """Accept multipart file uploads, save to temp dir, return paths."""
    global _upload_dir_size
    saved_paths: list[str] = []
    errors: list[str] = []

    for upload in files:
        ext = Path(upload.filename or "").suffix.lower()
        if ext not in ALLOWED_EXTENSIONS:
            errors.append(f"Rejected '{upload.filename}': unsupported file type '{ext}'")
            continue

        content = await upload.read()
        file_size = len(content)

        if file_size > MAX_FILE_SIZE:
            errors.append(f"Rejected '{upload.filename}': exceeds 50MB limit")
            continue

        # Security: strip directory components from the user-supplied filename.
        # upload.filename comes from the multipart Content-Disposition header and
        # is fully attacker-controlled.  A value like "../../etc/cron.d/evil"
        # would cause pathlib to resolve the destination outside UPLOAD_DIR.
        # Path.name returns only the final component ("evil"), neutralising the
        # traversal.  The `or "upload"` fallback handles the edge case where the
        # filename is *only* directory separators (e.g. "../../"), which yields
        # an empty string after .name.
        stripped_name = Path(upload.filename or "").name or "upload"

        # Lock the quota-check-and-write as an atomic unit.  Without this,
        # two concurrent requests could both read the same _upload_dir_size,
        # both pass the check, and together exceed the 200MB limit.
        async with _upload_lock:
            if _upload_dir_size + file_size > MAX_UPLOAD_DIR_SIZE:
                errors.append(f"Rejected '{upload.filename}': upload directory full (200MB limit)")
                continue

            safe_name = f"{uuid.uuid4().hex[:8]}_{stripped_name}"
            dest = UPLOAD_DIR / safe_name
            dest.write_bytes(content)
            _upload_dir_size += file_size

        saved_paths.append(str(dest))

    result: dict = {"paths": saved_paths}
    if errors:
        result["errors"] = errors
    return JSONResponse(result)


# ── Directory Browse ─────────────────────────────────────


@app.get("/api/browse")
async def browse_directories(path: str = ""):
    """List subdirectories of the given path for folder autocomplete."""
    if not path:
        if sys.platform == "win32":
            # Return drive roots on Windows
            import string
            drives = []
            for letter in string.ascii_uppercase:
                drive = f"{letter}:\\"
                if os.path.isdir(drive):
                    drives.append(drive)
            return JSONResponse({"dirs": drives, "parent": ""})
        else:
            return JSONResponse({"dirs": ["/"], "parent": ""})

    target = Path(path)
    if not target.is_dir():
        # Try parent if path is partial (e.g. "C:\Cod" -> list "C:\" filtered to "Cod*")
        parent = target.parent
        prefix = target.name.lower()
        if parent.is_dir():
            try:
                dirs = sorted(
                    [
                        str(p)
                        for p in parent.iterdir()
                        if p.is_dir()
                        and p.name.lower().startswith(prefix)
                        and not p.name.startswith(".")
                    ]
                )[:20]
                return JSONResponse({"dirs": dirs, "parent": str(parent)})
            except PermissionError:
                return JSONResponse({"dirs": [], "parent": str(parent)})
        return JSONResponse({"dirs": [], "parent": ""})

    try:
        dirs = sorted(
            [
                str(p)
                for p in target.iterdir()
                if p.is_dir() and not p.name.startswith(".")
            ]
        )[:50]
        return JSONResponse({"dirs": dirs, "parent": str(target)})
    except PermissionError:
        return JSONResponse({"dirs": [], "parent": str(target)})


# ── Git Status ────────────────────────────────────────────


@app.get("/api/git/status")
async def git_status(path: str):
    """Get git branch and dirty state for a directory."""
    target = Path(path)
    if not target.is_dir():
        return JSONResponse({"git": False})

    try:
        branch_result = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=str(target), capture_output=True, text=True, timeout=5,
        )
        if branch_result.returncode != 0:
            return JSONResponse({"git": False})

        branch = branch_result.stdout.strip()

        status_result = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=str(target), capture_output=True, text=True, timeout=5,
        )
        lines = [l for l in status_result.stdout.strip().split("\n") if l.strip()]
        dirty = len(lines) > 0

        return JSONResponse({
            "git": True,
            "branch": branch,
            "dirty": dirty,
            "files_changed": len(lines),
        })
    except Exception:
        logger.debug("Git status failed for %s", path, exc_info=True)
        return JSONResponse({"git": False})


# ── Terminal Output Buffer (for MCP orchestrator) ─────────


@app.get("/api/terminals/{terminal_id}/output")
async def get_terminal_output(terminal_id: str, since: int = 0):
    """Return ANSI-stripped terminal output (used by MCP orchestrator).

    Args:
        since: Return only lines at index >= since (0 = all lines).
               Use the returned total_lines value as the next since cursor.
    """
    session = pty_manager.get_terminal(terminal_id)
    if not session:
        return JSONResponse({"error": "Terminal not found"}, status_code=404)
    all_lines = pty_manager.get_output_buffer(terminal_id)
    total = len(all_lines)
    sliced = all_lines[since:] if since > 0 else all_lines
    activity_state = session.tracker.state
    return JSONResponse({
        "terminal_id": terminal_id,
        "lines": sliced,
        "total_lines": total,
        "activity_state": activity_state,
    })


def _resolve_python() -> str:
    """Return a path to the Python interpreter for launching MCP subprocesses.

    Inside a PyInstaller bundle sys.executable is the frozen exe, which cannot
    run .py scripts.  Fall back to the first 'python' on PATH.
    """
    if not getattr(sys, "_MEIPASS", None):
        return sys.executable  # Dev mode — interpreter is correct
    found = shutil.which("python")
    if found:
        return found
    raise FileNotFoundError(
        "Cannot find a Python interpreter on PATH.  "
        "Orchestrator mode requires Python installed alongside the desktop app."
    )


def _write_mcp_config(terminal_id: str, compound_id: str = "") -> str:
    """Write a temp MCP config JSON for an orchestrator session.

    Uses the stable cockpit_mcp.py copy written at startup by _bootstrap_mcp_script().
    Raises RuntimeError if bootstrap failed (e.g. old bundle without spec fix).
    Returns the absolute path to the written config file.
    """
    if _MCP_SCRIPT_PATH is None:
        raise RuntimeError(
            "cockpit_mcp.py could not be located at startup. "
            "Rebuild the desktop app to restore Orchestrator mode."
        )
    port = int(os.getenv("PORT", "8420"))
    # compound_id encodes the full ancestry chain for workspace scoping.
    # Falls back to terminal_id for top-level orchestrators with no parent.
    effective_compound_id = compound_id or terminal_id
    config = {
        "mcpServers": {
            "cockpit": {
                "command": _resolve_python(),
                "args": [str(_MCP_SCRIPT_PATH)],
                "env": {
                    "COCKPIT_API_URL": f"http://localhost:{port}",
                    "COCKPIT_ORCHESTRATOR_ID": terminal_id,
                    "COCKPIT_COMPOUND_ID": effective_compound_id,
                },
            }
        }
    }
    config_path = _MCP_CONFIG_DIR / f"mcp_{terminal_id}.json"
    config_path.write_text(json.dumps(config, indent=2))
    logger.info(
        "Wrote MCP config for orchestrator %s (compound: %s) → %s",
        terminal_id, effective_compound_id, config_path,
    )
    return str(config_path)


# ── Background PTY Reader ─────────────────────────────────


async def _session_reader(terminal_id: str):
    """Drain PTY output for a session — feeds state tracker and queues data for WebSocket consumers.

    Runs as a background task for every session. Without this, sessions with no
    active WebSocket connection (e.g. MCP-spawned workers) have their PTY output
    buffer fill up, stalling or killing the underlying Claude process.
    """
    session = pty_manager.get_terminal(terminal_id)
    if not session:
        return
    while session.alive:
        data = await pty_manager.read_pty(terminal_id)
        if data:
            session.tracker.feed(data)
            if "\ufffd" in data:
                logger.debug(
                    "PTY replacement chars in terminal %s: %r",
                    terminal_id,
                    data[max(0, data.index("\ufffd") - 20): data.index("\ufffd") + 20],
                )
            try:
                session.output_queue.put_nowait(data)
            except asyncio.QueueFull:
                pass  # WebSocket consumer is slow — data is already in ring buffer
        else:
            if not session.alive:
                break
            await asyncio.sleep(0.01)


# ── Terminal Input ────────────────────────────────────────


@app.post("/api/terminals/{terminal_id}/input")
async def send_terminal_input(terminal_id: str, request: Request):
    """Send text input to a terminal's PTY."""
    body = await request.json()
    text = body.get("text", "")
    if not text:
        return JSONResponse({"error": "No text provided"}, status_code=400)
    if pty_manager.write_pty(terminal_id, text):
        return JSONResponse({"status": "sent"})
    return JSONResponse({"error": "Terminal not found or dead"}, status_code=404)


# ── Terminal Management (REST) ───────────────────────────


@app.post("/api/terminals")
async def create_terminal(request: Request):
    """Create a new interactive Claude CLI terminal session."""
    body = await request.json()
    name = body.get("name", "")
    workdir = body.get("workdir", str(Path.cwd()))
    model = body.get("model", "sonnet")
    resume_id = body.get("resume_session_id", "")
    continue_last = body.get("continue", False)
    bypass_permissions = body.get("bypassPermissions", False)
    is_orchestrator = body.get("isOrchestrator", False)
    system_prompt_file = body.get("systemPromptFile", "")
    cols = body.get("cols", 120)
    rows = body.get("rows", 30)
    # Compound ID of the parent session (set by MCP create_session tool).
    # When present, this session gets a workspace folder as a child of that tree.
    parent_compound_id = body.get("parentCompoundId", "")

    # Pre-generate terminal ID whenever we need to reference it before spawn
    # (orchestrators need it for MCP config; sessions with a parent need it for workspace).
    needs_pregen = is_orchestrator or bool(parent_compound_id)
    terminal_id_override = uuid.uuid4().hex[:8] if needs_pregen else ""

    # Compute this session's compound ID.
    # Top-level orchestrator: compound_id = terminal_id
    # Child session: compound_id = parent_compound_id + "+" + terminal_id
    compound_id = ""
    if needs_pregen:
        own_id = terminal_id_override
        compound_id = f"{parent_compound_id}+{own_id}" if parent_compound_id else own_id

    try:
        mcp_config_path = (
            _write_mcp_config(terminal_id_override, compound_id=compound_id)
            if is_orchestrator else ""
        )
        session = pty_manager.create_terminal(
            name=name,
            workdir=workdir,
            model=model,
            resume_session_id=resume_id,
            continue_last=continue_last,
            bypass_permissions=bypass_permissions,
            cols=cols,
            rows=rows,
            mcp_config_path=mcp_config_path,
            terminal_id_override=terminal_id_override,
            system_prompt_file=system_prompt_file,
            compound_id=compound_id,
        )

        # Create workspace folder for agent sessions (orchestrators or MCP-spawned children)
        if compound_id:
            try:
                ws_path = workspace_manager.create_workspace(
                    compound_id=compound_id,
                    agent_name=name or "Agent",
                    agent_role="Orchestrator" if is_orchestrator else "Specialist",
                    model=model,
                    character_file=system_prompt_file,
                    parent_session_id=parent_compound_id.split("+")[-1] if parent_compound_id else "",
                    workdir=workdir or str(Path.cwd()),
                    pid=0,  # PID not available until after spawn; updated below
                )
                session.workspace_path = str(ws_path)
                logger.info("Workspace created for session %s at %s", session.id, ws_path)
            except Exception:
                logger.warning("Failed to create workspace for session %s", session.id, exc_info=True)
        # Post-spawn health check: give Claude CLI time to initialize Node.js.
        # asyncio.sleep keeps the event loop responsive (replaces the blocking
        # time.sleep(1.5) that was previously inside pty_manager.create_terminal).
        await asyncio.sleep(1.5)
        if not session.pty.isalive():
            exit_code = getattr(session.pty, "exitstatus", "?")
            logger.error("Session %s died on spawn (exit: %s)", session.id, exit_code)
            pty_manager.kill_terminal(session.id)
            return JSONResponse(
                {"error": "Claude process exited immediately after spawn. "
                          "Ensure 'claude' CLI is installed and authenticated."},
                status_code=500,
            )
        logger.info("Session %s alive after spawn", session.id)
        # Start background PTY reader — keeps output buffer drained for sessions
        # with no active WebSocket connection (e.g. MCP-spawned worker sessions).
        asyncio.create_task(_session_reader(session.id))
        return JSONResponse({
            "id": session.id,
            "name": session.name,
            "model": session.model,
            "created_at": session.created_at,
            "is_orchestrator": is_orchestrator,
            "compound_id": compound_id,
            "workspace_path": session.workspace_path,
        })
    except FileNotFoundError:
        return JSONResponse(
            {"error": "'claude' CLI not found. Make sure it's installed and in PATH."},
            status_code=500,
        )
    except Exception as e:
        return JSONResponse(
            {"error": f"Failed to spawn terminal: {str(e)}"},
            status_code=500,
        )


@app.get("/api/terminals")
async def list_terminals():
    """List all active terminal sessions."""
    return JSONResponse({"terminals": pty_manager.list_terminals()})


@app.delete("/api/terminals/{terminal_id}")
async def delete_terminal(terminal_id: str):
    """Kill a terminal session."""
    session = pty_manager.sessions.get(terminal_id)
    compound_id = session.compound_id if session else ""
    if pty_manager.kill_terminal(terminal_id):
        if compound_id:
            workspace_manager.update_status(compound_id, "idle")
        return JSONResponse({"status": "killed", "id": terminal_id})
    return JSONResponse({"error": "Terminal not found"}, status_code=404)


# ── Workspace REST API ───────────────────────────────────


@app.post("/api/workspaces/{compound_id}/write")
async def workspace_write(compound_id: str, request: Request):
    """Write a file to a session's workspace folder (called by MCP workspace_write tool)."""
    body = await request.json()
    filename = body.get("filename", "")
    content = body.get("content", "")
    if not filename:
        return JSONResponse({"error": "filename is required"}, status_code=400)
    try:
        path = workspace_manager.write_file(compound_id, filename, content)
        return JSONResponse({"status": "written", "path": str(path)})
    except (ValueError, OSError) as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@app.get("/api/workspaces/{compound_id}/read")
async def workspace_read(compound_id: str, filename: str = ""):
    """Read a file from a session's workspace folder (called by MCP workspace_read tool)."""
    if not filename:
        return JSONResponse({"error": "filename query parameter is required"}, status_code=400)
    try:
        content = workspace_manager.read_file(compound_id, filename)
        return JSONResponse({"compound_id": compound_id, "filename": filename, "content": content})
    except FileNotFoundError as e:
        return JSONResponse({"error": str(e)}, status_code=404)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@app.get("/api/workspaces/{compound_id}/list")
async def workspace_list(compound_id: str):
    """List all workspaces in a session's tree (called by MCP workspace_list tool)."""
    try:
        workspaces = workspace_manager.list_workspaces(compound_id)
        return JSONResponse({"compound_id": compound_id, "workspaces": workspaces})
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@app.get("/api/workspaces/{terminal_id}/events")
async def workspace_events(terminal_id: str):
    """Return and clear pending workspace notifications for a session.

    Uses terminal_id (8-char hex) rather than compound_id so the MCP server
    can look up its own session without knowing its full ancestry chain.
    """
    with _workspace_events_lock:
        session = pty_manager.sessions.get(terminal_id)
        if not session:
            return JSONResponse({"error": "Session not found"}, status_code=404)
        events = list(session.workspace_events)
        session.workspace_events.clear()
    return JSONResponse({"terminal_id": terminal_id, "events": events})


@app.post("/api/workspaces/{compound_id}/compact")
async def workspace_compact(compound_id: str, request: Request):
    """Compact a workspace — concatenate all .md files into compacted.md."""
    body = await request.json()
    keep_originals = bool(body.get("keep_originals", False))
    try:
        path = workspace_manager.compact_workspace(compound_id, keep_originals=keep_originals)
        return JSONResponse({"status": "compacted", "path": str(path), "compound_id": compound_id})
    except FileNotFoundError as e:
        return JSONResponse({"error": str(e)}, status_code=404)
    except (ValueError, OSError) as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@app.get("/api/workspaces/all")
async def workspace_list_all():
    """List all workspaces (no scope restriction). For UI use."""
    return JSONResponse({"workspaces": workspace_manager.list_all_workspaces()})


@app.websocket("/ws/workspaces")
async def websocket_workspaces(websocket: WebSocket):
    """Push workspace tree updates to the UI.

    On connect: sends the full workspace tree snapshot.
    On file change: broadcasts { type: "file_changed", compound_id, filename }.
    Client can use this to refresh the tree and live-viewer tabs.
    """
    await websocket.accept()
    with _workspace_ws_lock:
        _workspace_ws_clients.add(websocket)
    try:
        # Send initial tree snapshot
        tree = workspace_manager.list_all_workspaces()
        await websocket.send_text(json.dumps({"type": "tree", "workspaces": tree}))
        # Keep connection alive — server pushes events, client just needs to stay connected
        while True:
            msg = await websocket.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            # Clients may send { type: "refresh" } to re-fetch the full tree
            if msg.get("type") == "websocket.receive":
                try:
                    data = json.loads(msg.get("text") or "{}")
                    if data.get("type") == "refresh":
                        tree = workspace_manager.list_all_workspaces()
                        await websocket.send_text(json.dumps({"type": "tree", "workspaces": tree}))
                except Exception:
                    pass
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.debug("Workspace WS error", exc_info=True)
    finally:
        with _workspace_ws_lock:
            _workspace_ws_clients.discard(websocket)


@app.post("/api/terminals/{terminal_id}/resize")
async def resize_terminal(terminal_id: str, request: Request):
    """Resize a terminal's PTY."""
    body = await request.json()
    cols = body.get("cols", 120)
    rows = body.get("rows", 30)
    if pty_manager.resize_terminal(terminal_id, cols, rows):
        return JSONResponse({"status": "resized", "cols": cols, "rows": rows})
    return JSONResponse({"error": "Terminal not found or dead"}, status_code=404)


# ── WebSocket Terminal Bridge ────────────────────────────


@app.websocket("/ws/terminal/{terminal_id}")
async def websocket_terminal(websocket: WebSocket, terminal_id: str):
    """Bridge xterm.js <-> PTY via WebSocket."""
    session = pty_manager.get_terminal(terminal_id)
    await websocket.accept()

    if not session:
        await websocket.close(code=4004, reason="Terminal not found")
        return

    last_pong = _time.time()

    async def pty_to_ws():
        """Forward PTY output to WebSocket (reads from session queue; background reader drains PTY)."""
        while session.alive:
            try:
                try:
                    data = await asyncio.wait_for(session.output_queue.get(), timeout=0.5)
                except asyncio.TimeoutError:
                    continue
                await websocket.send_text(data)
                await asyncio.sleep(0)
            except (WebSocketDisconnect, RuntimeError, ConnectionError):
                break
            except Exception as e:
                logger.debug("PTY->WS forward error: %s", e)
                await asyncio.sleep(0.05)

        # Drain any buffered data before the "Session ended" banner
        while not session.output_queue.empty():
            try:
                data = session.output_queue.get_nowait()
                await websocket.send_text(data)
            except Exception:
                break

        try:
            await websocket.send_text("\r\n\x1b[33m[Session ended]\x1b[0m\r\n")
        except Exception:
            pass

    async def heartbeat():
        """Send periodic ping; close connection if client stops responding."""
        nonlocal last_pong
        while True:
            await asyncio.sleep(30)
            # If no pong received for 2 heartbeat cycles, connection is dead
            if _time.time() - last_pong > 90:
                logger.info("WS client unresponsive for terminal %s — closing", terminal_id)
                try:
                    await websocket.close(code=1001, reason="Pong timeout")
                except Exception:
                    pass
                break
            try:
                await websocket.send_text('{"type":"ping"}')
            except Exception:
                break

    reader_task = asyncio.create_task(pty_to_ws())
    heartbeat_task = asyncio.create_task(heartbeat())

    try:
        while True:
            msg = await websocket.receive()

            if msg.get("type") == "websocket.disconnect":
                break

            text = msg.get("text")
            if text:
                if text.startswith("{"):
                    try:
                        ctrl = json.loads(text)
                        if ctrl.get("type") == "resize":
                            pty_manager.resize_terminal(
                                terminal_id,
                                ctrl.get("cols", 120),
                                ctrl.get("rows", 30),
                            )
                            continue
                        if ctrl.get("type") == "pong":
                            last_pong = _time.time()
                            continue
                    except json.JSONDecodeError:
                        pass
                await pty_manager.write_pty_async(terminal_id, text)

            data = msg.get("bytes")
            if data:
                await pty_manager.write_pty_async(terminal_id, data.decode("utf-8", errors="replace"))

    except WebSocketDisconnect:
        pass
    except Exception:
        logger.warning("WS handler error for terminal %s", terminal_id, exc_info=True)
    finally:
        reader_task.cancel()
        heartbeat_task.cancel()
        try:
            await reader_task
        except asyncio.CancelledError:
            pass
        try:
            await heartbeat_task
        except asyncio.CancelledError:
            pass


@app.post("/api/open-url")
async def open_url(request: Request):
    """Open a URL in the system's default browser."""
    body = await request.json()
    url = body.get("url", "")
    if not url.startswith("https://"):
        return JSONResponse({"error": "Only HTTPS URLs allowed"}, 400)
    try:
        webbrowser.open(url)
        return JSONResponse({"ok": True})
    except Exception:
        logger.exception("Failed to open URL: %s", url)
        return JSONResponse({"error": "Failed to open URL"}, 500)


# ── Static files ─────────────────────────────────────────


# Serve React frontend assets (JS, CSS, images from Vite build)
@app.get("/assets/{path:path}")
async def frontend_assets(path: str):
    if FRONTEND_DIST.is_dir():
        file_path = FRONTEND_DIST / "assets" / path
        if file_path.is_file():
            # Vite content-hashes all asset filenames (e.g. index-Cy6SfuEk.js),
            # so these are safe to cache forever.
            return FileResponse(
                file_path,
                headers={"Cache-Control": "public, max-age=31536000, immutable"},
            )
    return HTMLResponse("Not found", 404)


# Serve frontend root-level static files (favicon, icons, etc.)
@app.get("/favicon.svg")
@app.get("/favicon.png")
@app.get("/icons.svg")
@app.get("/app-icon.png")
@app.get("/icon-192.png")
@app.get("/icon-512.png")
async def frontend_root_files(request: Request):
    if FRONTEND_DIST.is_dir():
        filename = request.url.path.lstrip("/")
        file_path = FRONTEND_DIST / filename
        if file_path.is_file():
            return FileResponse(file_path)
    return HTMLResponse("Not found", 404)


@app.get("/static/{path:path}")
async def static_files(path: str):
    file_path = STATIC_DIR / path
    if file_path.is_file():
        return FileResponse(file_path)
    return HTMLResponse("Not found", 404)


@app.on_event("startup")
async def startup_event():
    """Clean up orphans, write PID file, start idle cleanup."""
    # 0. Capture event loop for cross-thread workspace broadcasts
    global _app_event_loop
    _app_event_loop = asyncio.get_event_loop()

    # 1. Clean up orphaned processes from previous crashes
    pty_manager.cleanup_orphans()

    # 2. PID file for crash detection
    try:
        import psutil
        if PID_FILE.exists():
            old_pid = int(PID_FILE.read_text().strip())
            if psutil.pid_exists(old_pid):
                logger.warning("Another cockpit instance may be running (PID %d)", old_pid)
            else:
                logger.info("Previous instance (PID %d) crashed — cleaned up", old_pid)
    except Exception:
        pass
    PID_FILE.write_text(str(os.getpid()))

    # 3. Start idle session cleanup loop (tracked for graceful shutdown)
    async def idle_cleanup_loop():
        loop = asyncio.get_event_loop()
        try:
            while True:
                await asyncio.sleep(60)
                # Run in executor: cleanup_idle_sessions uses time.sleep(0.1)
                # for the two-pass CPU check — keeps the event loop unblocked.
                await loop.run_in_executor(None, pty_manager.cleanup_idle_sessions)
        except asyncio.CancelledError:
            pass
    app.state.idle_cleanup_task = asyncio.create_task(idle_cleanup_loop())

    # 4. Start workspace file watcher
    try:
        _workspace_watcher.start()
    except Exception:
        logger.warning("WorkspaceWatcher failed to start — workspace notifications disabled", exc_info=True)

    logger.info("Startup complete (PID %d)", os.getpid())


@app.post("/api/shutdown")
async def api_shutdown():
    """Initiate graceful shutdown — called by the auto-updater before replacing the sidecar exe."""
    loop = asyncio.get_event_loop()
    loop.call_later(0.3, lambda: os.kill(os.getpid(), 15))  # SIGTERM after response is sent
    return {"status": "shutting down"}


@app.on_event("shutdown")
async def shutdown_event():
    """Graceful shutdown: kill sessions, clean up."""
    # Cancel idle cleanup loop
    cleanup_task = getattr(app.state, "idle_cleanup_task", None)
    if cleanup_task:
        cleanup_task.cancel()
        try:
            await cleanup_task
        except asyncio.CancelledError:
            pass
    # Stop workspace watcher before killing sessions
    try:
        _workspace_watcher.stop()
    except Exception:
        logger.warning("WorkspaceWatcher stop error", exc_info=True)

    logger.info("Shutdown: terminating %d session(s)...", len(pty_manager.sessions))
    pty_manager.shutdown()
    logger.info("Shutdown: cleaning upload dir...")
    shutil.rmtree(UPLOAD_DIR, ignore_errors=True)
    shutil.rmtree(_MCP_CONFIG_DIR, ignore_errors=True)
    PID_FILE.unlink(missing_ok=True)
    logger.info("Shutdown complete")


def main():
    import uvicorn
    port = int(os.getenv("PORT", "8420"))
    host = os.getenv("HOST", "0.0.0.0")
    url = f"http://localhost:{port}"
    logger.info("Claude Cockpit -> %s", url)
    # Auto-open browser unless suppressed
    if os.getenv("NO_BROWSER", "").lower() not in ("1", "true", "yes"):
        import threading
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    main()
