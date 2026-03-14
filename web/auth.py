"""Google OAuth authentication for Claude Cockpit Web."""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from authlib.integrations.starlette_client import OAuth
from starlette.config import Config

# Load from .env or environment
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "")
SECRET_KEY = os.getenv("SECRET_KEY", "change-me-in-production")

# Allowed email domains/addresses (empty = allow all authenticated users)
ALLOWED_EMAILS: list[str] = [
    e.strip()
    for e in os.getenv("ALLOWED_EMAILS", "").split(",")
    if e.strip()
]

oauth = OAuth()
oauth.register(
    name="google",
    client_id=GOOGLE_CLIENT_ID,
    client_secret=GOOGLE_CLIENT_SECRET,
    server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
    client_kwargs={"scope": "openid email profile"},
)


@dataclass
class User:
    email: str
    name: str
    picture: str = ""
    assigned_host: str = "localhost"  # The machine this user's sessions run on


@dataclass
class UserStore:
    """Simple in-memory user registry. Replace with DB for production."""

    users: dict[str, User] = field(default_factory=dict)
    # Map email -> assigned host for remote execution
    host_assignments: dict[str, str] = field(default_factory=dict)

    def get_or_create(self, email: str, name: str, picture: str = "") -> User:
        if email not in self.users:
            host = self.host_assignments.get(email, "localhost")
            self.users[email] = User(
                email=email, name=name, picture=picture, assigned_host=host
            )
        return self.users[email]

    def is_allowed(self, email: str) -> bool:
        if not ALLOWED_EMAILS:
            return True
        return email in ALLOWED_EMAILS or any(
            email.endswith(f"@{domain}") for domain in ALLOWED_EMAILS if "@" not in domain
        )


user_store = UserStore()
