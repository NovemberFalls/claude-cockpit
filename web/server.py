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


# ── Terminal Output Buffer ────────────────────────────────


@app.get("/api/terminals/{terminal_id}/output")
async def get_terminal_output(terminal_id: str, since: int = 0):
    """Return ANSI-stripped terminal output.

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
        "context_percent": session.tracker.context_percent,
    })


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
    cols = body.get("cols", 120)
    rows = body.get("rows", 30)

    try:
        session = pty_manager.create_terminal(
            name=name,
            workdir=workdir,
            model=model,
            resume_session_id=resume_id,
            continue_last=continue_last,
            bypass_permissions=bypass_permissions,
            cols=cols,
            rows=rows,
        )
        # Post-spawn health check: give Claude CLI time to initialize Node.js.
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
        asyncio.create_task(_session_reader(session.id))
        return JSONResponse({
            "id": session.id,
            "name": session.name,
            "model": session.model,
            "created_at": session.created_at,
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
    if pty_manager.kill_terminal(terminal_id):
        return JSONResponse({"status": "killed", "id": terminal_id})
    return JSONResponse({"error": "Terminal not found"}, status_code=404)


@app.get("/api/system")
async def system_stats():
    """Return system resource usage: CPU, RAM, and GPU (if available).

    GPU utilization is fetched via nvidia-smi. If nvidia-smi is unavailable
    or times out, gpu_percent is null — this never causes the endpoint to fail.
    All float values are rounded to 1 decimal place.
    """
    import psutil

    cpu = round(psutil.cpu_percent(interval=0.1), 1)

    vm = psutil.virtual_memory()
    ram_percent = round(vm.percent, 1)
    ram_used_gb = round(vm.used / (1024 ** 3), 1)
    ram_total_gb = round(vm.total / (1024 ** 3), 1)

    gpu_percent: float | None = None
    try:
        proc = await asyncio.create_subprocess_exec(
            "nvidia-smi",
            "--query-gpu=utilization.gpu",
            "--format=csv,noheader,nounits",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=2.0)
            first_line = stdout.decode("utf-8", errors="replace").strip().splitlines()[0]
            gpu_percent = round(float(first_line), 1)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
        except (ValueError, IndexError):
            pass
    except (FileNotFoundError, OSError):
        pass
    except Exception:
        logger.debug("GPU query failed", exc_info=True)

    return JSONResponse({
        "cpu_percent": cpu,
        "ram_percent": ram_percent,
        "ram_used_gb": ram_used_gb,
        "ram_total_gb": ram_total_gb,
        "gpu_percent": gpu_percent,
    })


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


# ── JSONL Message Stream (SSE) ───────────────────────────


from starlette.responses import StreamingResponse


@app.get("/api/terminals/{terminal_id}/messages")
async def get_terminal_messages(terminal_id: str):
    """Return all parsed messages from a session's JSONL file."""
    from jsonl_watcher import read_all_messages

    session = pty_manager.get_terminal(terminal_id)
    if not session:
        return JSONResponse({"error": "Terminal not found"}, status_code=404)

    jsonl_path = pty_manager._get_jsonl_path(session)
    if not jsonl_path:
        return JSONResponse({"messages": [], "jsonl_path": None})

    messages = read_all_messages(jsonl_path)
    return JSONResponse({
        "messages": messages,
        "jsonl_path": jsonl_path,
        "claude_session_id": session.claude_session_id,
    })


@app.get("/api/terminals/{terminal_id}/messages/stream")
async def stream_terminal_messages(terminal_id: str, from_beginning: str = "true"):
    """SSE stream of new messages from a session's JSONL file.

    Each SSE event is a JSON-encoded message object.
    Keeps streaming until the client disconnects.
    """
    from jsonl_watcher import tail_jsonl

    session = pty_manager.get_terminal(terminal_id)
    if not session:
        return JSONResponse({"error": "Terminal not found"}, status_code=404)

    jsonl_path = pty_manager._get_jsonl_path(session)
    if not jsonl_path:
        return JSONResponse({"error": "No JSONL path available"}, status_code=404)

    async def event_generator():
        try:
            async for message in tail_jsonl(
                jsonl_path,
                from_beginning=(from_beginning.lower() == "true"),
            ):
                data = json.dumps(message)
                yield f"data: {data}\n\n"
        except asyncio.CancelledError:
            pass

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ── Awareness API ────────────────────────────────────────


def _read_json_file(path: Path) -> dict | list | None:
    try:
        if path.is_file():
            return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        logger.debug("Failed to read JSON: %s", path, exc_info=True)
    return None


def _read_text_file(path: Path, max_bytes: int = 8192) -> str | None:
    try:
        if path.is_file():
            content = path.read_text(encoding="utf-8", errors="replace")
            if len(content) > max_bytes:
                content = content[:max_bytes] + "\n...(truncated)"
            return content
    except Exception:
        logger.debug("Failed to read text: %s", path, exc_info=True)
    return None


def _get_mcp_servers(workdir: str) -> list[dict]:
    servers = []
    home = Path.home()
    user_settings = _read_json_file(home / ".claude" / "settings.json")
    if user_settings and isinstance(user_settings.get("mcpServers"), dict):
        for name, config in user_settings["mcpServers"].items():
            servers.append({"name": name, "source": "user", "command": config.get("command", "")})
    project_mcp = _read_json_file(Path(workdir) / ".mcp.json")
    if project_mcp and isinstance(project_mcp.get("mcpServers"), dict):
        for name, config in project_mcp["mcpServers"].items():
            servers.append({"name": name, "source": "project", "command": config.get("command", "")})
    return servers


def _get_skills(workdir: str) -> list[dict]:
    skills = []
    seen = set()

    def scan_dir(base: Path, source: str):
        if not base.is_dir():
            return
        for f in sorted(base.iterdir()):
            if f.suffix != ".md" or f.name.startswith("."):
                continue
            name = f.stem
            if name in seen:
                continue
            seen.add(name)
            desc = ""
            try:
                content = f.read_text(encoding="utf-8", errors="replace")[:1024]
                for line in content.split("\n"):
                    stripped = line.strip()
                    if stripped.startswith("description:"):
                        desc = stripped[len("description:"):].strip().strip('"').strip("'")
                        break
            except Exception:
                pass
            skills.append({"name": name, "description": desc, "source": source})

    scan_dir(Path(workdir) / ".claude" / "commands", "project")
    scan_dir(Path.home() / ".claude" / "commands", "user")
    return skills


def _get_memory(workdir: str) -> dict:
    home = Path.home()
    claude_projects = home / ".claude" / "projects"
    if not claude_projects.is_dir():
        return {"index": None, "files": []}

    # Derive project ID from workdir
    project_id = workdir.replace("\\", "-").replace("/", "-").replace(":", "-").lstrip("-")
    memory_dir = claude_projects / project_id / "memory"

    if not memory_dir.is_dir():
        return {"index": None, "files": []}

    index = _read_text_file(memory_dir / "MEMORY.md", max_bytes=4096)
    files = [{"name": f.stem, "filename": f.name}
             for f in sorted(memory_dir.iterdir())
             if f.suffix == ".md" and f.name != "MEMORY.md"]
    return {"index": index, "files": files, "path": str(memory_dir)}


def _get_claude_md(workdir: str) -> str | None:
    current = Path(workdir)
    for _ in range(10):
        for name in ("CLAUDE.md", ".claude/CLAUDE.md"):
            content = _read_text_file(current / name, max_bytes=4096)
            if content is not None:
                return content
        parent = current.parent
        if parent == current:
            break
        current = parent
    return None


@app.get("/api/awareness")
async def get_awareness(workdir: str = ""):
    """Return Claude Code context awareness for a given working directory."""
    if not workdir:
        return JSONResponse({"error": "workdir parameter required"}, status_code=400)
    return JSONResponse({
        "mcp_servers": _get_mcp_servers(workdir),
        "skills": _get_skills(workdir),
        "memory": _get_memory(workdir),
        "claude_md": _get_claude_md(workdir),
    })


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

    logger.info("Shutdown: terminating %d session(s)...", len(pty_manager.sessions))
    pty_manager.shutdown()
    logger.info("Shutdown: cleaning upload dir...")
    shutil.rmtree(UPLOAD_DIR, ignore_errors=True)
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
