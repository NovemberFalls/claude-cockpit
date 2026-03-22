"""Relay server configuration from environment variables."""

from __future__ import annotations

import os
import secrets
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


# ── Paths ────────────────────────────────────────────────
DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))
DB_PATH = DATA_DIR / "relay.db"

# ── Security ─────────────────────────────────────────────
SECRET_KEY = os.getenv("SECRET_KEY", secrets.token_hex(32))

# ── Google OAuth ─────────────────────────────────────────
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "")

# ── Admin emails (comma-separated) ──────────────────────
ADMIN_EMAILS: list[str] = [
    e.strip()
    for e in os.getenv("ADMIN_EMAILS", "").split(",")
    if e.strip()
]

# ── Allowed user emails (comma-separated, empty = allow all) ──
ALLOWED_EMAILS: list[str] = [
    e.strip()
    for e in os.getenv("ALLOWED_EMAILS", "").split(",")
    if e.strip()
]

# ── Tunnel limits ────────────────────────────────────────
MAX_SESSIONS_PER_KEY = int(os.getenv("MAX_SESSIONS_PER_KEY", "10"))
HEARTBEAT_INTERVAL = int(os.getenv("HEARTBEAT_INTERVAL", "30"))  # seconds
HEARTBEAT_MISSES_ALLOWED = int(os.getenv("HEARTBEAT_MISSES_ALLOWED", "2"))
RATE_LIMIT_CONNECTIONS = int(os.getenv("RATE_LIMIT_CONNECTIONS", "5"))  # per minute per key
RATE_LIMIT_MESSAGES = int(os.getenv("RATE_LIMIT_MESSAGES", "1000"))  # per second per tunnel

# ── Server ───────────────────────────────────────────────
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8430"))
BASE_URL = os.getenv("BASE_URL", f"http://localhost:{PORT}")
