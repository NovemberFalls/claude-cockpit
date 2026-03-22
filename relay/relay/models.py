"""SQLite database models and helpers for the relay server."""

from __future__ import annotations

import json
import secrets
import time
from dataclasses import dataclass, field
from pathlib import Path

import aiosqlite
import bcrypt

from .config import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS api_keys (
    id          TEXT PRIMARY KEY,
    user_email  TEXT NOT NULL,
    key_hash    TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    created_at  REAL NOT NULL,
    last_used   REAL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    max_sessions INTEGER NOT NULL DEFAULT 10
);

CREATE TABLE IF NOT EXISTS users (
    email       TEXT PRIMARY KEY,
    name        TEXT NOT NULL DEFAULT '',
    picture     TEXT NOT NULL DEFAULT '',
    is_admin    INTEGER NOT NULL DEFAULT 0,
    created_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   REAL NOT NULL,
    action      TEXT NOT NULL,
    user_email  TEXT NOT NULL DEFAULT '',
    instance_id TEXT NOT NULL DEFAULT '',
    details     TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_email);
CREATE INDEX IF NOT EXISTS idx_audit_log_time ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_email);
"""


@dataclass
class ApiKey:
    id: str
    user_email: str
    key_hash: str
    name: str
    created_at: float
    last_used: float | None = None
    enabled: bool = True
    max_sessions: int = 10


@dataclass
class User:
    email: str
    name: str
    picture: str = ""
    is_admin: bool = False
    created_at: float = field(default_factory=time.time)


class Database:
    """Async SQLite database wrapper for relay data."""

    def __init__(self, db_path: Path | None = None):
        self._path = str(db_path or DB_PATH)
        self._db: aiosqlite.Connection | None = None

    async def connect(self):
        # Ensure data directory exists
        Path(self._path).parent.mkdir(parents=True, exist_ok=True)
        self._db = await aiosqlite.connect(self._path)
        self._db.row_factory = aiosqlite.Row
        await self._db.executescript(SCHEMA)
        await self._db.commit()

    async def close(self):
        if self._db:
            await self._db.close()
            self._db = None

    # ── API Keys ─────────────────────────────────────────

    def generate_api_key(self) -> str:
        """Generate a new API key: cpk_ + 32 hex chars."""
        return "cpk_" + secrets.token_hex(16)

    def hash_key(self, raw_key: str) -> str:
        """Bcrypt-hash an API key."""
        return bcrypt.hashpw(raw_key.encode(), bcrypt.gensalt()).decode()

    def verify_key(self, raw_key: str, key_hash: str) -> bool:
        """Check a raw key against its bcrypt hash."""
        try:
            return bcrypt.checkpw(raw_key.encode(), key_hash.encode())
        except Exception:
            return False

    async def create_api_key(self, user_email: str, name: str = "", max_sessions: int = 10) -> tuple[str, ApiKey]:
        """Create a new API key. Returns (raw_key, ApiKey)."""
        raw_key = self.generate_api_key()
        key_id = secrets.token_hex(8)
        key_hash = self.hash_key(raw_key)
        now = time.time()

        await self._db.execute(
            "INSERT INTO api_keys (id, user_email, key_hash, name, created_at, max_sessions) VALUES (?, ?, ?, ?, ?, ?)",
            (key_id, user_email, key_hash, name, now, max_sessions),
        )
        await self._db.commit()

        api_key = ApiKey(
            id=key_id,
            user_email=user_email,
            key_hash=key_hash,
            name=name,
            created_at=now,
            max_sessions=max_sessions,
        )
        return raw_key, api_key

    async def validate_api_key(self, raw_key: str) -> ApiKey | None:
        """Validate a raw API key. Returns ApiKey if valid and enabled, else None."""
        if not raw_key.startswith("cpk_"):
            return None

        async with self._db.execute("SELECT * FROM api_keys WHERE enabled = 1") as cursor:
            async for row in cursor:
                if self.verify_key(raw_key, row["key_hash"]):
                    # Update last_used
                    await self._db.execute(
                        "UPDATE api_keys SET last_used = ? WHERE id = ?",
                        (time.time(), row["id"]),
                    )
                    await self._db.commit()
                    return ApiKey(
                        id=row["id"],
                        user_email=row["user_email"],
                        key_hash=row["key_hash"],
                        name=row["name"],
                        created_at=row["created_at"],
                        last_used=row["last_used"],
                        enabled=bool(row["enabled"]),
                        max_sessions=row["max_sessions"],
                    )
        return None

    async def list_api_keys(self, user_email: str | None = None) -> list[ApiKey]:
        """List API keys, optionally filtered by user."""
        if user_email:
            query = "SELECT * FROM api_keys WHERE user_email = ? ORDER BY created_at DESC"
            params = (user_email,)
        else:
            query = "SELECT * FROM api_keys ORDER BY created_at DESC"
            params = ()

        keys = []
        async with self._db.execute(query, params) as cursor:
            async for row in cursor:
                keys.append(ApiKey(
                    id=row["id"],
                    user_email=row["user_email"],
                    key_hash=row["key_hash"],
                    name=row["name"],
                    created_at=row["created_at"],
                    last_used=row["last_used"],
                    enabled=bool(row["enabled"]),
                    max_sessions=row["max_sessions"],
                ))
        return keys

    async def update_api_key(self, key_id: str, enabled: bool | None = None, name: str | None = None, max_sessions: int | None = None) -> bool:
        """Update an API key's properties."""
        updates = []
        params = []
        if enabled is not None:
            updates.append("enabled = ?")
            params.append(int(enabled))
        if name is not None:
            updates.append("name = ?")
            params.append(name)
        if max_sessions is not None:
            updates.append("max_sessions = ?")
            params.append(max_sessions)

        if not updates:
            return False

        params.append(key_id)
        result = await self._db.execute(
            f"UPDATE api_keys SET {', '.join(updates)} WHERE id = ?",
            params,
        )
        await self._db.commit()
        return result.rowcount > 0

    async def delete_api_key(self, key_id: str) -> bool:
        """Delete an API key."""
        result = await self._db.execute("DELETE FROM api_keys WHERE id = ?", (key_id,))
        await self._db.commit()
        return result.rowcount > 0

    # ── Users ────────────────────────────────────────────

    async def get_or_create_user(self, email: str, name: str = "", picture: str = "", is_admin: bool = False) -> User:
        """Get existing user or create new one."""
        async with self._db.execute("SELECT * FROM users WHERE email = ?", (email,)) as cursor:
            row = await cursor.fetchone()
            if row:
                return User(
                    email=row["email"],
                    name=row["name"],
                    picture=row["picture"],
                    is_admin=bool(row["is_admin"]),
                    created_at=row["created_at"],
                )

        now = time.time()
        await self._db.execute(
            "INSERT INTO users (email, name, picture, is_admin, created_at) VALUES (?, ?, ?, ?, ?)",
            (email, name, picture, int(is_admin), now),
        )
        await self._db.commit()
        return User(email=email, name=name, picture=picture, is_admin=is_admin, created_at=now)

    async def get_user(self, email: str) -> User | None:
        """Get a user by email."""
        async with self._db.execute("SELECT * FROM users WHERE email = ?", (email,)) as cursor:
            row = await cursor.fetchone()
            if row:
                return User(
                    email=row["email"],
                    name=row["name"],
                    picture=row["picture"],
                    is_admin=bool(row["is_admin"]),
                    created_at=row["created_at"],
                )
        return None

    # ── Audit Log ────────────────────────────────────────

    async def log_action(self, action: str, user_email: str = "", instance_id: str = "", details: dict | None = None):
        """Write an audit log entry."""
        await self._db.execute(
            "INSERT INTO audit_log (timestamp, action, user_email, instance_id, details) VALUES (?, ?, ?, ?, ?)",
            (time.time(), action, user_email, instance_id, json.dumps(details or {})),
        )
        await self._db.commit()

    async def get_audit_log(self, limit: int = 100, user_email: str | None = None) -> list[dict]:
        """Get recent audit log entries."""
        if user_email:
            query = "SELECT * FROM audit_log WHERE user_email = ? ORDER BY timestamp DESC LIMIT ?"
            params = (user_email, limit)
        else:
            query = "SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?"
            params = (limit,)

        entries = []
        async with self._db.execute(query, params) as cursor:
            async for row in cursor:
                entries.append({
                    "id": row["id"],
                    "timestamp": row["timestamp"],
                    "action": row["action"],
                    "user_email": row["user_email"],
                    "instance_id": row["instance_id"],
                    "details": json.loads(row["details"]),
                })
        return entries
