"""Authentication for the relay server.

Two auth mechanisms:
1. Google OAuth — for browser dashboard access
2. API keys — for tunnel connections from local cockpits
"""

from __future__ import annotations

import time
from collections import defaultdict

from authlib.integrations.starlette_client import OAuth
from starlette.requests import Request

from .config import (
    ADMIN_EMAILS,
    ALLOWED_EMAILS,
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    RATE_LIMIT_CONNECTIONS,
)

# ── Google OAuth setup ───────────────────────────────────

oauth = OAuth()

if GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET:
    oauth.register(
        name="google",
        client_id=GOOGLE_CLIENT_ID,
        client_secret=GOOGLE_CLIENT_SECRET,
        server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
        client_kwargs={"scope": "openid email profile"},
    )


def is_admin(email: str) -> bool:
    """Check if an email is in the admin list."""
    return email.lower() in [e.lower() for e in ADMIN_EMAILS]


def is_allowed(email: str) -> bool:
    """Check if an email is allowed to use the service."""
    if not ALLOWED_EMAILS:
        return True  # No whitelist = allow all
    return email.lower() in [e.lower() for e in ALLOWED_EMAILS]


def get_session_user(request: Request) -> dict | None:
    """Get the authenticated user from the session, or None."""
    user = request.session.get("user")
    if not user:
        # Allow localhost access without auth
        if request.url.hostname in ("localhost", "127.0.0.1"):
            return {
                "email": "local@localhost",
                "name": "Local User",
                "is_admin": True,
            }
        return None
    return user


# ── API key rate limiting ────────────────────────────────

class RateLimiter:
    """Simple in-memory rate limiter for API key connection attempts."""

    def __init__(self, max_per_minute: int = RATE_LIMIT_CONNECTIONS):
        self._max = max_per_minute
        self._attempts: dict[str, list[float]] = defaultdict(list)

    def check(self, key_id: str) -> bool:
        """Return True if the request is allowed, False if rate-limited."""
        now = time.time()
        cutoff = now - 60

        # Clean old entries
        self._attempts[key_id] = [t for t in self._attempts[key_id] if t > cutoff]

        if len(self._attempts[key_id]) >= self._max:
            return False

        self._attempts[key_id].append(now)
        return True


rate_limiter = RateLimiter()
