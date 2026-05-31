"""FastAPI web server for Claude Cockpit -- PTY-bridged interactive terminals."""

from __future__ import annotations

import asyncio
import datetime
import json
import logging
import os
import re
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
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from starlette.requests import Request
from starlette.responses import StreamingResponse

load_dotenv()

import logging_config
logging_config.setup()
logger = logging.getLogger("cockpit.server")

from pty_manager import pty_manager
from bridge_manager import bridge_manager, channel_manager, cleanup_relay_dir

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
    FRONTEND_DIST = Path(sys._MEIPASS) / "frontend_dist"
else:
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
    return HTMLResponse("Frontend not built. Run: cd web/frontend && npm run build", 404)


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
    active WebSocket connection (e.g. detached/background terminals) have their
    PTY output buffer fill up, stalling or killing the underlying Claude process.
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

    # Bump the generation counter and capture this connection's generation value.
    # If another WS connects to the same terminal later it will bump again, making
    # this forwarder's my_generation stale — the check in pty_to_ws() will stop it.
    # Safe without a lock: all WS handlers run on the single asyncio event loop.
    session.active_consumer += 1
    my_generation = session.active_consumer

    async def pty_to_ws():
        """Forward PTY output to WebSocket (reads from session queue; background reader drains PTY).

        Only the forwarder whose my_generation matches session.active_consumer is the active
        consumer. If a newer WS connects, active_consumer is bumped and this forwarder stops
        draining — "latest connection wins" — preventing split-stream corruption.
        """
        while session.alive and session.active_consumer == my_generation:
            try:
                try:
                    data = await asyncio.wait_for(session.output_queue.get(), timeout=0.5)
                except asyncio.TimeoutError:
                    continue
                # Re-check generation after get() returns — another WS may have connected
                # in the brief window between the get() call and now. If superseded, do NOT
                # send: put the item back so the new consumer receives it intact.
                if session.active_consumer != my_generation:
                    try:
                        session.output_queue.put_nowait(data)
                    except asyncio.QueueFull:
                        pass  # Queue full: one item lost is acceptable on supersession
                    logger.debug(
                        "PTY->WS forwarder for terminal %s superseded (gen %d → %d); stopping.",
                        terminal_id, my_generation, session.active_consumer,
                    )
                    break
                await websocket.send_text(data)
                await asyncio.sleep(0)
            except (WebSocketDisconnect, RuntimeError, ConnectionError):
                break
            except Exception as e:
                logger.debug("PTY->WS forward error: %s", e)
                await asyncio.sleep(0.05)

        # Only send the drain + "[Session ended]" banner when the session actually died.
        # A superseded forwarder (session still alive, just displaced) must NOT send the
        # banner — that would falsely signal session death to an active popout window.
        if not session.alive:
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
        """Send periodic ping to keep the connection alive."""
        while True:
            await asyncio.sleep(30)
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
                            continue
                    except json.JSONDecodeError:
                        pass
                session = pty_manager.get_terminal(terminal_id)
                if session is not None:
                    session.last_user_input_time = _time.monotonic()
                await pty_manager.write_pty_async(terminal_id, text)

            data = msg.get("bytes")
            if data:
                session = pty_manager.get_terminal(terminal_id)
                if session is not None:
                    session.last_user_input_time = _time.monotonic()
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


# ── Bridge / Peer Coordination ────────────────────────────


@app.get("/api/terminals/{terminal_id}/latest-assistant")
async def get_latest_assistant(terminal_id: str):
    """Return the text content of the most recent assistant turn from this session's JSONL."""
    from jsonl_watcher import read_all_messages

    session = pty_manager.get_terminal(terminal_id)
    if not session:
        return JSONResponse({"error": "Terminal not found"}, status_code=404)

    jsonl_path = pty_manager._get_jsonl_path(session)
    if not jsonl_path:
        return JSONResponse({"text": None, "reason": "no JSONL yet"})

    messages = read_all_messages(jsonl_path)
    for entry in reversed(messages):
        if entry.get("type") != "assistant":
            continue
        text_parts = [
            b.get("text", "")
            for b in entry.get("content", [])
            if isinstance(b, dict) and b.get("type") == "text"
        ]
        joined = "\n".join(p for p in text_parts if p).strip()
        if joined:
            return JSONResponse({
                "text": joined,
                "message_id": entry.get("id"),
                "timestamp": entry.get("timestamp"),
            })
    return JSONResponse({"text": None, "reason": "no assistant message found"})


@app.get("/api/terminals/{terminal_id}/workflows")
def get_workflows(terminal_id: str):
    """Return recent Workflow tool invocations from this session's JSONL.

    For each `tool_use` whose name is "Workflow", pairs it with its matching
    `tool_result` (if present) and reports `status` as "in_progress" or "completed".
    Used by the per-pane WorkflowsPanel in the frontend.
    """
    from jsonl_watcher import read_all_messages

    session = pty_manager.get_terminal(terminal_id)
    if session is None:
        return JSONResponse({"error": "Terminal not found"}, status_code=404)
    jsonl_path = pty_manager._get_jsonl_path(session)
    if not jsonl_path:
        return {"workflows": []}

    messages = read_all_messages(jsonl_path)
    # Build map of tool_use_id -> tool_result entry for status pairing
    tool_results: dict[str, dict] = {}
    for m in messages:
        if m.get("type") == "tool_result":
            for block in m.get("content", []):
                tuid = block.get("tool_use_id")
                if tuid:
                    tool_results[tuid] = {
                        "completed_at": m.get("timestamp"),
                        "is_error": block.get("is_error", False),
                    }

    workflows: list[dict] = []
    for m in messages:
        if m.get("type") != "assistant":
            continue
        for block in m.get("content", []):
            if block.get("type") != "tool_use":
                continue
            if block.get("tool_name") != "Workflow":
                continue
            tool_id = block.get("tool_id", "")
            inp = block.get("input", {}) or {}
            # `script` may be huge — _summarize_tool_input already truncates to 200 chars.
            # We only surface the script meta-fields; the raw script body is not shown.
            result = tool_results.get(tool_id)
            workflows.append({
                "tool_id": tool_id,
                "name": inp.get("name") or inp.get("title") or "workflow",
                "description": inp.get("description") or "",
                "args": inp.get("args"),
                "script_preview": (inp.get("script") if isinstance(inp.get("script"), str) else None),
                "script_path": inp.get("scriptPath"),
                "started_at": m.get("timestamp"),
                "completed_at": result["completed_at"] if result else None,
                "is_error": result["is_error"] if result else False,
                "status": "completed" if result else "in_progress",
            })

    # Most recent first
    workflows.sort(key=lambda w: w.get("started_at") or "", reverse=True)
    # Cap to 20 most recent — keeps the response small for polling
    return {"workflows": workflows[:20]}


@app.post("/api/bridge/manual")
async def bridge_manual(request: Request):
    """One-shot relay: inject a message from one session's latest output into another session."""
    body = await request.json()
    from_id = body.get("from_terminal_id", "")
    to_id = body.get("to_terminal_id", "")
    message = body.get("message", "")
    prefix = body.get("prefix")  # optional attribution prefix, may be None
    if not from_id or not to_id or not message:
        return JSONResponse(
            {"ok": False, "error": "from_terminal_id, to_terminal_id, message required"},
            status_code=400,
        )
    if from_id == to_id:
        return JSONResponse(
            {"ok": False, "error": "Cannot bridge a session to itself"},
            status_code=400,
        )
    result = await bridge_manager.start_manual(from_id, to_id, message, prefix)
    status = 200 if result.get("ok") else 400
    return JSONResponse(result, status_code=status)


@app.post("/api/bridge/auto")
async def bridge_auto(request: Request):
    """Start an autonomous two-session bridge with a shared kickoff prompt."""
    body = await request.json()
    from_id = body.get("from_terminal_id", "")
    to_id = body.get("to_terminal_id", "")
    kickoff = body.get("kickoff_prompt", "")
    try:
        max_turns = int(body.get("max_turns", 4))
    except (TypeError, ValueError):
        return JSONResponse(
            {"ok": False, "error": "max_turns must be an integer"},
            status_code=400,
        )
    if not from_id or not to_id or not kickoff:
        return JSONResponse(
            {"ok": False, "error": "from_terminal_id, to_terminal_id, kickoff_prompt required"},
            status_code=400,
        )
    if from_id == to_id:
        return JSONResponse(
            {"ok": False, "error": "Cannot bridge a session to itself"},
            status_code=400,
        )
    if not 1 <= max_turns <= 10:
        return JSONResponse(
            {"ok": False, "error": "max_turns must be between 1 and 10"},
            status_code=400,
        )
    # Guard: refuse if either session is already enrolled in an active bridge.
    # Two active bridges on the same session would interleave writes to its PTY
    # input buffer and produce corrupt, unpredictable output.
    active = [b for b in bridge_manager.list_active() if b.get("state") == "active"]
    busy_ids = {b["from_id"] for b in active} | {b["to_id"] for b in active}
    busy_ids |= channel_manager.member_ids()
    if from_id in busy_ids or to_id in busy_ids:
        return JSONResponse(
            {"ok": False, "error": "One or both sessions already in an active bridge or channel"},
            status_code=409,
        )
    result = await bridge_manager.start_auto(from_id, to_id, kickoff, max_turns)
    status = 200 if result.get("ok") else 400
    return JSONResponse(result, status_code=status)


@app.delete("/api/bridge/{bridge_id}")
async def bridge_stop(bridge_id: str):
    """Stop an active auto bridge by bridge_id."""
    ok = bridge_manager.stop(bridge_id)
    if not ok:
        return JSONResponse({"ok": False, "error": "Bridge not found"}, status_code=404)
    return JSONResponse({"ok": True})


@app.get("/api/bridge")
async def bridge_list():
    """List all known bridges (active and recently ended)."""
    return JSONResponse({"bridges": bridge_manager.list_active()})


@app.post("/api/bridge/channel")
async def channel_start(request: Request):
    """Start an N-session channel: one lead coordinating N workers."""
    body = await request.json()
    lead_id = body.get("lead_id", "")
    worker_ids = body.get("worker_ids", [])
    kickoff = body.get("kickoff_prompt", "")
    try:
        max_turns = int(body.get("max_turns", 6))
    except (TypeError, ValueError):
        return JSONResponse({"ok": False, "error": "max_turns must be an integer"}, status_code=400)

    # Validation
    if not lead_id or not worker_ids or not kickoff:
        return JSONResponse(
            {"ok": False, "error": "lead_id, worker_ids, kickoff_prompt required"},
            status_code=400,
        )
    if not isinstance(worker_ids, list) or not all(isinstance(w, str) for w in worker_ids):
        return JSONResponse({"ok": False, "error": "worker_ids must be a list of strings"}, status_code=400)
    if len(worker_ids) > 7:  # lead + 7 workers = 8 total, matches MAX_SESSIONS default
        return JSONResponse({"ok": False, "error": "Maximum 7 workers per channel"}, status_code=400)
    if not 1 <= max_turns <= 20:
        return JSONResponse({"ok": False, "error": "max_turns must be between 1 and 20"}, status_code=400)

    # Conflict guard: reject if any session is in an active 2-session bridge OR active channel
    active_bridges = [b for b in bridge_manager.list_active() if b.get("state") == "active"]
    bridge_busy = {b["from_id"] for b in active_bridges} | {b["to_id"] for b in active_bridges}
    channel_busy = channel_manager.member_ids()
    all_busy = bridge_busy | channel_busy
    all_requested = {lead_id} | set(worker_ids)
    overlap = all_requested & all_busy
    if overlap:
        return JSONResponse(
            {"ok": False, "error": f"Sessions already in an active bridge or channel: {sorted(overlap)}"},
            status_code=409,
        )

    result = await channel_manager.start(lead_id, worker_ids, kickoff, max_turns)
    status = 200 if result.get("ok") else 400
    return JSONResponse(result, status_code=status)


@app.delete("/api/bridge/channel/{channel_id}")
async def channel_stop(channel_id: str):
    """Stop an active channel by channel_id."""
    ok = channel_manager.stop(channel_id)
    if not ok:
        return JSONResponse({"ok": False, "error": "Channel not found"}, status_code=404)
    return JSONResponse({"ok": True})


@app.get("/api/bridge/channel")
async def channel_list():
    """List all known channels (active and recently ended)."""
    return JSONResponse({"channels": channel_manager.list_active()})


# ── JSONL Message Stream (SSE) ───────────────────────────


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


# ── Session History ─────────────────────────────────────

_history_cache: dict[str, tuple[float, list[dict]]] = {}


def _derive_project_id(workdir: str) -> str:
    """Derive the Claude Code project ID from a working directory path.

    Must match the logic in pty_manager.py (line 562).
    """
    return workdir.replace("\\", "-").replace("/", "-").replace(":", "-").lstrip("-")


def _read_last_line(filepath: Path) -> str:
    """Efficiently read the last line of a file by seeking backwards from EOF."""
    try:
        with open(filepath, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            if size == 0:
                return ""
            # Seek backwards to find the last newline
            pos = size - 1
            # Skip trailing newline(s)
            while pos > 0:
                f.seek(pos)
                ch = f.read(1)
                if ch != b"\n" and ch != b"\r":
                    break
                pos -= 1
            # Now find the newline before the last line
            while pos > 0:
                f.seek(pos)
                ch = f.read(1)
                if ch == b"\n":
                    break
                pos -= 1
            if pos > 0:
                f.seek(pos + 1)
            else:
                f.seek(0)
            return f.read().decode("utf-8", errors="replace").strip()
    except Exception:
        logger.debug("Failed to read last line of %s", filepath, exc_info=True)
        return ""


_COMMAND_ARGS_RE = re.compile(r"<command-args>([\s\S]*?)</command-args>")
_XML_BLOCK_RE = re.compile(r"<(?:system-reminder|local-command-caveat)[^>]*>[\s\S]*?</(?:system-reminder|local-command-caveat)>")
_XML_SIMPLE_RE = re.compile(r"</?(?:command-message|command-name|command-args|scheduled-task)[^>]*>")


def _clean_first_message(text: str) -> str:
    """Strip Claude Code command/system XML tags from a user message preview."""
    if not text:
        return text
    # Strip block-level tags (system-reminder, local-command-caveat)
    cleaned = _XML_BLOCK_RE.sub("", text)
    # Extract command-args content if present
    m = _COMMAND_ARGS_RE.search(cleaned)
    if m:
        return m.group(1).strip()
    # Strip remaining simple tags
    cleaned = _XML_SIMPLE_RE.sub("", cleaned).strip()
    return cleaned or text


def _scan_session_file(filepath: Path) -> dict | None:
    """Extract metadata from a single JSONL session file.

    Reads the first 20 lines for session info and the last line for
    last_modified timestamp. Returns a session metadata dict or None.
    """
    try:
        file_size = filepath.stat().st_size
        if file_size == 0:
            return None
    except OSError:
        return None

    session_id: str | None = None
    first_user_message: str | None = None
    model: str | None = None
    cwd: str | None = None

    # Read first 20 lines for metadata
    try:
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            for i, line in enumerate(f):
                if i >= 20:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue

                if session_id is None:
                    session_id = obj.get("sessionId")

                entry_type = obj.get("type")
                msg = obj.get("message", {})

                if first_user_message is None and entry_type == "user":
                    content = msg.get("content", "")
                    if isinstance(content, str) and content.strip():
                        first_user_message = content.strip()
                    elif isinstance(content, list):
                        # Extract text from content blocks
                        for block in content:
                            if isinstance(block, dict) and block.get("type") == "text":
                                text = block.get("text", "").strip()
                                if text:
                                    first_user_message = text
                                    break

                if model is None and entry_type == "assistant":
                    model = msg.get("model")

                if cwd is None:
                    cwd = obj.get("cwd")
    except Exception:
        logger.debug("Failed to read head of %s", filepath, exc_info=True)
        return None

    if not session_id:
        return None

    # Read last line for timestamp
    last_modified_iso: str | None = None
    last_line = _read_last_line(filepath)
    if last_line:
        try:
            last_obj = json.loads(last_line)
            ts = last_obj.get("timestamp")
            if ts:
                last_modified_iso = ts
        except json.JSONDecodeError:
            pass

    if not last_modified_iso:
        # Fall back to file mtime
        mtime = filepath.stat().st_mtime
        last_modified_iso = datetime.datetime.fromtimestamp(
            mtime, tz=datetime.timezone.utc
        ).isoformat()

    # Count lines via file size heuristic (read first 10KB, count lines, extrapolate)
    message_count = 0
    try:
        chunk_size = min(10240, file_size)
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            chunk = f.read(chunk_size)
        lines_in_chunk = chunk.count("\n")
        if chunk_size < file_size:
            message_count = int(lines_in_chunk * (file_size / chunk_size))
        else:
            message_count = lines_in_chunk
    except Exception:
        pass

    # Clean command XML tags from the preview text
    if first_user_message:
        first_user_message = _clean_first_message(first_user_message)

    return {
        "session_id": session_id,
        "first_message": first_user_message or "(no message)",
        "last_modified": last_modified_iso,
        "message_count": message_count,
        "model": model,
        "file_size_kb": round(file_size / 1024, 1),
        "workdir": cwd or "",
    }


def _sort_ts(s: dict) -> float:
    """Sort key for history sessions — converts any timestamp format to epoch seconds."""
    ts = s.get("last_modified", "")
    if not ts:
        return 0.0
    try:
        val = float(ts)
        return val / 1000 if val > 1e12 else val  # ms → s if needed
    except (ValueError, TypeError):
        pass
    try:
        return datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return 0.0


def _get_all_history_sessions() -> list[dict]:
    """Scan ALL Claude Code project directories and return merged session list."""
    projects_dir = Path.home() / ".claude" / "projects"
    if not projects_dir.is_dir():
        return []

    # Cache the all-sessions result keyed on the projects dir mtime
    try:
        dir_mtime = projects_dir.stat().st_mtime
    except OSError:
        return []

    cache_key = "__all__"
    if cache_key in _history_cache:
        cached_mtime, cached_result = _history_cache[cache_key]
        if cached_mtime == dir_mtime:
            return cached_result

    all_sessions: list[dict] = []
    try:
        for project_dir in projects_dir.iterdir():
            if not project_dir.is_dir():
                continue
            for entry in project_dir.iterdir():
                if entry.suffix != ".jsonl" or not entry.is_file():
                    continue
                meta = _scan_session_file(entry)
                if meta:
                    all_sessions.append(meta)
    except OSError:
        logger.debug("Failed to scan projects dir", exc_info=True)

    all_sessions.sort(key=_sort_ts, reverse=True)
    _history_cache[cache_key] = (dir_mtime, all_sessions)
    return all_sessions


def _get_history_sessions(workdir: str) -> list[dict]:
    """Scan JSONL session files for a project and return metadata list.

    Uses a simple mtime-based cache to avoid rescanning unchanged directories.
    """
    project_id = _derive_project_id(workdir)
    home = Path.home()
    jsonl_dir = home / ".claude" / "projects" / project_id

    if not jsonl_dir.is_dir():
        return []

    try:
        dir_mtime = jsonl_dir.stat().st_mtime
    except OSError:
        return []

    cache_key = project_id
    if cache_key in _history_cache:
        cached_mtime, cached_result = _history_cache[cache_key]
        if cached_mtime == dir_mtime:
            return cached_result

    sessions: list[dict] = []
    try:
        for entry in jsonl_dir.iterdir():
            if entry.suffix != ".jsonl" or not entry.is_file():
                continue
            meta = _scan_session_file(entry)
            if meta:
                # Prefer cwd from the JSONL file; fall back to the requested workdir
                if not meta.get("workdir"):
                    meta["workdir"] = workdir
                sessions.append(meta)
    except OSError:
        logger.debug("Failed to scan JSONL dir: %s", jsonl_dir, exc_info=True)

    sessions.sort(key=_sort_ts, reverse=True)

    _history_cache[cache_key] = (dir_mtime, sessions)
    return sessions


@app.get("/api/history")
async def get_history(workdir: str = ""):
    """Return session metadata. Without workdir, returns ALL sessions across every project."""
    if workdir:
        sessions = _get_history_sessions(workdir)
    else:
        sessions = _get_all_history_sessions()
    return JSONResponse({"sessions": sessions})


@app.get("/api/history/{session_id}/messages")
async def get_history_messages(session_id: str, workdir: str = ""):
    """Return all parsed messages from a specific history session's JSONL file.

    Read-only viewing of past conversation content.
    """
    if not workdir:
        return JSONResponse({"error": "workdir parameter required"}, status_code=400)

    project_id = _derive_project_id(workdir)
    home = Path.home()
    jsonl_path = home / ".claude" / "projects" / project_id / f"{session_id}.jsonl"

    if not jsonl_path.is_file():
        return JSONResponse(
            {"error": f"Session file not found: {session_id}"},
            status_code=404,
        )

    from jsonl_watcher import read_all_messages

    messages = read_all_messages(str(jsonl_path))
    return JSONResponse({"session_id": session_id, "messages": messages})


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
    logger.info("Shutdown: cleaning relay dir...")
    cleanup_relay_dir()
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
