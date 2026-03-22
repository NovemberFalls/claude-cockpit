"""FastAPI application for the cockpit relay server.

Serves:
- Tunnel WebSocket (/tunnel) for local cockpit connections
- Terminal WebSocket (/ws/terminal/...) for browser access
- REST API for dashboard, API key management, admin
- Google OAuth login flow
- React dashboard frontend (static files)
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from starlette.middleware.sessions import SessionMiddleware
from starlette.requests import Request

from .auth import get_session_user, is_admin, is_allowed, oauth
from .config import BASE_URL, GOOGLE_CLIENT_ID, SECRET_KEY
from .models import Database
from .routes import admin, api, terminal, tunnel
from .tunnel_manager import tunnel_manager

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger("relay")

# Dashboard static files path
DASHBOARD_DIST = Path(__file__).parent.parent / "dashboard" / "dist"


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown lifecycle."""
    # Initialize database
    db = Database()
    await db.connect()
    app.state.db = db
    logger.info("Database initialized")
    yield
    # Shutdown
    await tunnel_manager.shutdown()
    await db.close()
    logger.info("Relay server shut down")


app = FastAPI(title="Cockpit Relay", lifespan=lifespan)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.add_middleware(SessionMiddleware, secret_key=SECRET_KEY)

# Include route modules
app.include_router(tunnel.router)
app.include_router(terminal.router)
app.include_router(api.router)
app.include_router(admin.router)


# ── OAuth routes ─────────────────────────────────────────

@app.get("/")
async def index(request: Request):
    """Serve dashboard or redirect to login."""
    if DASHBOARD_DIST.is_dir() and (DASHBOARD_DIST / "index.html").exists():
        return FileResponse(DASHBOARD_DIST / "index.html")

    user = get_session_user(request)
    if not user:
        return HTMLResponse(
            "<h1>Cockpit Relay</h1>"
            '<p><a href="/login">Login with Google</a></p>'
        )
    return HTMLResponse(
        f"<h1>Cockpit Relay</h1>"
        f"<p>Logged in as {user.get('name', user.get('email', ''))}</p>"
        f"<p><a href='/api/instances'>My Instances</a></p>"
    )


@app.get("/login")
async def login(request: Request):
    """Initiate Google OAuth flow."""
    if not GOOGLE_CLIENT_ID:
        return HTMLResponse("<h1>OAuth not configured</h1><p>Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.</p>", 500)
    redirect_uri = str(request.url_for("auth_callback"))
    return await oauth.google.authorize_redirect(request, redirect_uri)


@app.get("/auth/callback")
async def auth_callback(request: Request):
    """Handle Google OAuth callback."""
    token = await oauth.google.authorize_access_token(request)
    userinfo = token.get("userinfo", {})
    email = userinfo.get("email", "")
    name = userinfo.get("name", email)
    picture = userinfo.get("picture", "")

    if not is_allowed(email):
        return HTMLResponse("<h1>Access Denied</h1><p>Your email is not authorized.</p>", 403)

    # Store in database
    db: Database = request.app.state.db
    user = await db.get_or_create_user(
        email=email,
        name=name,
        picture=picture,
        is_admin=is_admin(email),
    )

    request.session["user"] = {
        "email": user.email,
        "name": user.name,
        "picture": user.picture,
        "is_admin": user.is_admin,
    }

    await db.log_action("login", email)
    return RedirectResponse("/")


@app.get("/logout")
async def logout(request: Request):
    """Clear session and redirect to home."""
    request.session.clear()
    return RedirectResponse("/")


# ── Dashboard static files ───────────────────────────────

@app.get("/assets/{path:path}")
async def dashboard_assets(path: str):
    if DASHBOARD_DIST.is_dir():
        file_path = DASHBOARD_DIST / "assets" / path
        if file_path.is_file():
            return FileResponse(file_path)
    return HTMLResponse("Not found", 404)


@app.get("/favicon.svg")
@app.get("/favicon.ico")
async def dashboard_favicon(request: Request):
    if DASHBOARD_DIST.is_dir():
        filename = request.url.path.lstrip("/")
        file_path = DASHBOARD_DIST / filename
        if file_path.is_file():
            return FileResponse(file_path)
    return HTMLResponse("Not found", 404)


def main():
    """Run the relay server."""
    import uvicorn
    from .config import HOST, PORT

    print(f"\n  Cockpit Relay -> http://localhost:{PORT}\n")
    uvicorn.run(app, host=HOST, port=PORT)


if __name__ == "__main__":
    main()
