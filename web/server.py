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
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from starlette.middleware.sessions import SessionMiddleware
from starlette.requests import Request

load_dotenv()

import logging_config
logging_config.setup()
logger = logging.getLogger("cockpit.server")

from auth import SECRET_KEY, oauth, user_store
from pty_manager import pty_manager
from tunnel import TunnelClient

START_TIME = _time.time()

app = FastAPI(
    title="Claude Cockpit Web",
    description="Multi-session Claude CLI terminal manager",
    version="0.2.0-alpha",
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

app.add_middleware(SessionMiddleware, secret_key=SECRET_KEY)

# ── Tunnel Client (Cloud Relay) ──────────────────────────
tunnel_client = TunnelClient(pty_manager)

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


# ── Auth Routes ──────────────────────────────────────────


@app.get("/")
async def index(request: Request):
    # Serve React frontend dist if available (production build)
    if FRONTEND_DIST.is_dir() and (FRONTEND_DIST / "index.html").exists():
        return FileResponse(FRONTEND_DIST / "index.html")
    # Fallback to legacy static frontend
    user = request.session.get("user")
    if not user:
        if request.url.hostname in ("localhost", "127.0.0.1"):
            return FileResponse(STATIC_DIR / "index.html")
        return FileResponse(STATIC_DIR / "login.html")
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/login")
async def login(request: Request):
    redirect_uri = request.url_for("auth_callback")
    return await oauth.google.authorize_redirect(request, redirect_uri)


@app.get("/auth/callback")
async def auth_callback(request: Request):
    token = await oauth.google.authorize_access_token(request)
    userinfo = token.get("userinfo", {})
    email = userinfo.get("email", "")
    name = userinfo.get("name", email)
    picture = userinfo.get("picture", "")

    if not user_store.is_allowed(email):
        return HTMLResponse("<h1>Access Denied</h1><p>Your email is not authorized.</p>", 403)

    user = user_store.get_or_create(email, name, picture)
    request.session["user"] = {
        "email": user.email,
        "name": user.name,
        "picture": user.picture,
        "host": user.assigned_host,
    }
    return RedirectResponse("/")


@app.get("/logout")
async def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/")


@app.get("/api/me")
async def me(request: Request):
    user = request.session.get("user")
    if not user:
        if request.url.hostname in ("localhost", "127.0.0.1"):
            return {"authenticated": True, "mode": "local", "email": "local@localhost", "name": "Local User"}
        return {"authenticated": False}
    return {"authenticated": True, "mode": "local", **user}


# ── File Upload ──────────────────────────────────────────


@app.post("/api/upload")
async def upload_files(request: Request, files: list[UploadFile] = File(...)):
    """Accept multipart file uploads, save to temp dir, return paths."""
    saved_paths: list[str] = []
    errors: list[str] = []

    for upload in files:
        ext = Path(upload.filename or "").suffix.lower()
        if ext not in ALLOWED_EXTENSIONS:
            errors.append(f"Rejected '{upload.filename}': unsupported file type '{ext}'")
            continue

        # Read with size check
        content = await upload.read()

        # Check total upload directory size
        current_size = sum(f.stat().st_size for f in UPLOAD_DIR.iterdir() if f.is_file())
        if current_size + len(content) > MAX_UPLOAD_DIR_SIZE:
            errors.append(f"Rejected '{upload.filename}': upload directory full (200MB limit)")
            continue

        if len(content) > MAX_FILE_SIZE:
            errors.append(f"Rejected '{upload.filename}': exceeds 50MB limit")
            continue

        # Save with unique prefix to avoid collisions
        safe_name = f"{uuid.uuid4().hex[:8]}_{upload.filename}"
        dest = UPLOAD_DIR / safe_name
        dest.write_bytes(content)
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
        # Return drive roots on Windows
        import string
        drives = []
        for letter in string.ascii_uppercase:
            drive = f"{letter}:\\"
            if os.path.isdir(drive):
                drives.append(drive)
        return JSONResponse({"dirs": drives, "parent": ""})

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

    async def pty_to_ws():
        """Read from PTY and forward to WebSocket."""
        # Use session.alive (bool) instead of session.pty.isalive() (kernel call)
        # in the loop condition. read_pty handles EOFError and sets alive=False.
        while session.alive:
            try:
                data = await pty_manager.read_pty(terminal_id)
                if data:
                    session.tracker.feed(data)
                    await websocket.send_text(data)
                    # Forward to cloud relay if connected
                    tunnel_client.forward_pty_output(terminal_id, data)
                    # Yield to event loop so the WS receive handler (user input)
                    # gets a chance to run during heavy output bursts
                    await asyncio.sleep(0)
                else:
                    await asyncio.sleep(0.01)
            except (WebSocketDisconnect, RuntimeError, ConnectionError):
                break
            except Exception as e:
                logger.debug("PTY->WS forward error: %s", e)
                await asyncio.sleep(0.05)

        # PTY died -- notify client
        try:
            await websocket.send_text("\r\n\x1b[33m[Session ended]\x1b[0m\r\n")
        except Exception:
            pass

    async def heartbeat():
        """Send periodic ping to detect stale connections."""
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
                # Check for JSON control messages (resize, pong)
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
                # Regular terminal input (async to avoid blocking event loop)
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


# ── Cloud Tunnel ─────────────────────────────────────────


@app.post("/api/tunnel/connect")
async def tunnel_connect(request: Request):
    """Connect to cloud relay server."""
    body = await request.json()
    relay_url = body.get("relay_url", "")
    api_key = body.get("api_key", "")

    if not relay_url or not api_key:
        return JSONResponse({"error": "relay_url and api_key required"}, status_code=400)

    await tunnel_client.connect(relay_url, api_key)
    return JSONResponse({"status": "connecting", "relay_url": relay_url})


@app.post("/api/tunnel/disconnect")
async def tunnel_disconnect():
    """Disconnect from cloud relay server."""
    await tunnel_client.disconnect()
    TunnelClient.clear_settings()
    return JSONResponse({"status": "disconnected"})


@app.get("/api/tunnel/status")
async def tunnel_status():
    """Get cloud tunnel connection status."""
    return JSONResponse(tunnel_client.status())


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
            return FileResponse(file_path)
    return HTMLResponse("Not found", 404)


# Serve other frontend static files (favicon, icons, etc.)
@app.get("/favicon.svg")
@app.get("/icons.svg")
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
    """Clean up orphans, write PID file, auto-connect tunnel, start idle cleanup."""
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

    # 3. Auto-connect to cloud relay if previously configured
    settings = TunnelClient.load_settings()
    if settings and settings.get("auto_connect"):
        relay_url = settings.get("relay_url", "")
        api_key = settings.get("api_key", "")
        if relay_url and api_key:
            await tunnel_client.connect(relay_url, api_key)

    # 4. Start idle session cleanup loop
    async def idle_cleanup_loop():
        while True:
            await asyncio.sleep(60)
            pty_manager.cleanup_idle_sessions()
    asyncio.create_task(idle_cleanup_loop())

    logger.info("Startup complete (PID %d)", os.getpid())


@app.on_event("shutdown")
async def shutdown_event():
    """Graceful shutdown: disconnect tunnel, kill sessions, clean up."""
    logger.info("Shutdown: disconnecting tunnel...")
    await tunnel_client.disconnect()
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
