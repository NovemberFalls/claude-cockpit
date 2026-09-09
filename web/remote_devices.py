"""Paired-device store for Studio Remote (protocol v1).

A phone pairs once with a short code the desktop shows, and is issued a bearer
token from then on. This module owns both halves of that: the short-lived
pairing codes and the durable device records.

Two rules shape everything here:

* **Only a sha256 digest of a token is ever written to disk**, and comparison
  is ``hmac.compare_digest`` on the hex digest. The plaintext token exists
  exactly once -- in the response to ``redeem_pairing`` -- and is never logged,
  never re-derivable, and never present in an error message.
* **Every pairing failure is the same failure.** ``PairingError`` always carries
  the literal text ``"invalid or expired code"``. Unknown, expired, already
  used and too-many-attempts are indistinguishable to the caller on purpose: a
  code is 8 characters from a 32-symbol alphabet, and telling an attacker that
  a code *existed* but was expired halves the work of finding one that has not.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import secrets
import tempfile
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger("cockpit.remote")

# os.replace refuses to replace a file another replace is still mid-flight on,
# on Windows -- WinError 5 "Access is denied". The phone polls messages every
# 1.5s and sessions every 3s plus a stream, and every one of those requests
# bumps last_seen, so concurrent requests race os.replace routinely. Retry
# briefly rather than propagate: this is a bookkeeping write, never worth
# failing the caller's actual request over.
_WRITE_RETRIES = 5
_WRITE_RETRY_SLEEP_S = 0.02

# authenticate() is called on every phone request (1.5-3s cadence); persisting
# last_seen on every one of those was the write-storm that produced the race
# above. Debounce persistence -- the in-memory value still advances so a
# caller within the process sees a fresh timestamp, but the disk write lands
# at most this often per device.
_LAST_SEEN_FLUSH_S = 30.0

# A failed bookkeeping write must never fail the request that triggered it,
# but must not go silent either. Rate-limit the warning so a sustained
# failure (e.g. a locked-down directory) logs once a minute, not once a poll.
_WRITE_WARN_INTERVAL_S = 60.0

# No 0/O/1/I -- a pairing code gets read off one screen and typed into another,
# and those four are the pairs people transcribe wrong.
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CODE_LENGTH = 8
PAIRING_TTL_SECONDS = 300.0
MAX_OUTSTANDING_PAIRINGS = 3
MAX_PAIRING_ATTEMPTS = 5
MAX_DEVICE_NAME = 64


class PairingError(Exception):
    """Raised for every pairing failure, with one indistinguishable message.

    ``reason`` is carried for server-side logging ONLY (never sent to the
    client, never derived from the code or token itself) -- one of
    "unknown code", "expired", "already used", "too many attempts".
    """

    MESSAGE = "invalid or expired code"

    def __init__(self, reason: str = "unknown code") -> None:
        super().__init__(self.MESSAGE)
        self.reason = reason


@dataclass
class Device:
    id: str
    name: str
    created_at: str
    last_seen: str | None
    revoked_at: str | None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "created_at": self.created_at,
            "last_seen": self.last_seen,
            "revoked_at": self.revoked_at,
        }


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def _sha256_hex(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def normalize_code(code: str) -> str:
    """Upper-case *code* and drop dashes/whitespace for comparison."""
    return "".join(ch for ch in str(code).upper() if ch.isalnum())


def _format_code(raw: str) -> str:
    return f"{raw[:4]}-{raw[4:]}"


class DeviceStore:
    """JSON-backed store of paired devices and outstanding pairing codes.

    *now* is injectable so expiry is testable without sleeping.
    """

    def __init__(self, path: str | os.PathLike, *, now=time.time) -> None:
        self._path = Path(path)
        self._now = now
        # Guards every read-modify-write sequence below. The routes run on
        # the asyncio loop today, but authenticate() is also safe to call
        # from an executor thread -- this lock makes that true rather than
        # merely assumed.
        self._lock = threading.Lock()
        # last_seen debounce + write-failure rate limiting, both in-memory
        # and per-process (not persisted -- restarting the server is a fine
        # time to flush and warn again).
        self._last_seen_flush: dict[str, float] = {}
        self._last_seen_memory: dict[str, str] = {}
        self._last_write_warn: float = 0.0

    # -- persistence --------------------------------------------------------

    def _read(self) -> dict:
        """Read the store, returning an empty shape for missing/corrupt files."""
        if not self._path.is_file():
            return {"devices": [], "pairings": [], "recently_used": []}
        try:
            raw = self._path.read_text(encoding="utf-8")
        except OSError:
            logger.warning(
                "Failed to read remote device store %s -- treating as empty",
                self._path,
                exc_info=True,
            )
            return {"devices": [], "pairings": [], "recently_used": []}
        if not raw.strip():
            return {"devices": [], "pairings": [], "recently_used": []}
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning(
                "Remote device store %s contains invalid JSON -- treating as empty",
                self._path,
                exc_info=True,
            )
            return {"devices": [], "pairings": [], "recently_used": []}
        if not isinstance(data, dict):
            logger.warning(
                "Remote device store %s did not contain an object -- treating as empty",
                self._path,
            )
            return {"devices": [], "pairings": [], "recently_used": []}
        devices = data.get("devices")
        pairings = data.get("pairings")
        recently_used = data.get("recently_used")
        return {
            "devices": devices if isinstance(devices, list) else [],
            "pairings": pairings if isinstance(pairings, list) else [],
            "recently_used": recently_used if isinstance(recently_used, list) else [],
        }

    def _write(self, data: dict) -> None:
        """Atomically write *data*, then best-effort tighten the mode to 0600.

        os.replace is atomic on POSIX and Windows alike, so a crash mid-write
        can never leave a half-written store. The chmod is best effort: on
        Windows the POSIX mode bits are largely cosmetic, and failing to
        restrict a file is not a reason to lose the write.
        """
        parent = self._path.parent
        parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(
            prefix="remote_devices_", suffix=".json.tmp", dir=str(parent)
        )
        tmp_path = Path(tmp_name)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
        except OSError:
            logger.warning("Failed to write remote device store %s", self._path, exc_info=True)
            try:
                tmp_path.unlink(missing_ok=True)
            except OSError:
                logger.debug("Failed to clean up temp store %s", tmp_path, exc_info=True)
            raise
        last_exc: OSError | None = None
        for attempt in range(_WRITE_RETRIES):
            try:
                os.replace(tmp_path, self._path)
                last_exc = None
                break
            except PermissionError as exc:
                # Another replace on the same destination is mid-flight
                # (Windows refuses a concurrent os.replace). Brief and
                # retriable -- not the same as a genuinely broken path.
                last_exc = exc
                if attempt < _WRITE_RETRIES - 1:
                    time.sleep(_WRITE_RETRY_SLEEP_S)
            except OSError as exc:
                last_exc = exc
                break
        if last_exc is not None:
            try:
                tmp_path.unlink(missing_ok=True)
            except OSError:
                logger.debug("Failed to clean up temp store %s", tmp_path, exc_info=True)
            raise last_exc
        try:
            os.chmod(self._path, 0o600)
        except OSError:
            logger.debug("Could not chmod 0600 %s", self._path, exc_info=True)

    def _warn_write_failed_rate_limited(self, now: float) -> None:
        if now - self._last_write_warn >= _WRITE_WARN_INTERVAL_S:
            self._last_write_warn = now
            logger.warning(
                "Failed to persist remote device bookkeeping to %s "
                "(will keep retrying; in-memory state unaffected)",
                self._path,
                exc_info=True,
            )

    # -- pairings -----------------------------------------------------------

    def _live_pairings(self, pairings: list, now: float) -> list:
        return [
            p
            for p in pairings
            if isinstance(p, dict) and float(p.get("expires_at", 0)) > now
        ]

    def create_pairing(self) -> dict:
        """Mint a new pairing code. Returns ``{"code", "expires_at"}``."""
        with self._lock:
            now = self._now()
            data = self._read()
            live = self._live_pairings(data["pairings"], now)
            raw = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
            code = _format_code(raw)
            entry = {"code": code, "expires_at": now + PAIRING_TTL_SECONDS, "attempts": 0}
            live.append(entry)
            # Oldest first out: a stale code the user has forgotten about is a
            # bigger liability than the one they are looking at right now.
            data["pairings"] = live[-MAX_OUTSTANDING_PAIRINGS:]
            self._write(data)
        logger.info("Remote pairing code issued (expires in %ss)", int(PAIRING_TTL_SECONDS))
        return {"code": code, "expires_at": entry["expires_at"]}

    def redeem_pairing(self, code: str, device_name: str) -> tuple[str, str]:
        """Redeem *code*, registering a device. Returns ``(device_id, token)``.

        Raises PairingError for every failure mode, with one client-facing
        message; ``exc.reason`` distinguishes them for server-side logging
        only.
        """
        name = (device_name or "").strip()
        if not name:
            raise PairingError("unknown code")
        name = name[:MAX_DEVICE_NAME]

        wanted = normalize_code(code)
        with self._lock:
            now = self._now()
            data = self._read()
            all_pairings = data["pairings"] if isinstance(data["pairings"], list) else []
            pairings = self._live_pairings(all_pairings, now)

            match = None
            for entry in pairings:
                if normalize_code(entry.get("code", "")) == wanted and wanted:
                    match = entry
                    break

            if match is None:
                reason = self._miss_reason(wanted, all_pairings, data.get("recently_used"), now)
                # A wrong guess cannot be attributed to any one code -- the
                # guesser by definition did not name a live one -- so it
                # counts against EVERY outstanding pairing. Five wrong
                # guesses therefore burn the window the user has open, which
                # is the brute-force bound: 5 tries per 300 s against a
                # 32^8 space. The sweep is persisted on the miss path too, so
                # expired codes never linger.
                for entry in list(pairings):
                    entry["attempts"] = int(entry.get("attempts", 0)) + 1
                    if entry["attempts"] >= MAX_PAIRING_ATTEMPTS:
                        pairings.remove(entry)
                data["pairings"] = pairings
                self._write(data)
                raise PairingError(reason)

            token = secrets.token_urlsafe(32)
            device_id = f"dv_{secrets.token_hex(6)}"
            device = {
                "id": device_id,
                "name": name,
                "token_sha256": _sha256_hex(token),
                "created_at": _iso(now),
                "last_seen": None,
                "revoked_at": None,
            }
            pairings.remove(match)  # single use
            data["pairings"] = pairings
            data["devices"] = list(data["devices"]) + [device]
            # Kept briefly so a repeat submission of an already-redeemed code
            # can be logged as "already used" rather than the indistinguishable
            # "unknown code" -- logging-only, never consulted for the client
            # response.
            recently_used = [
                r
                for r in (data.get("recently_used") or [])
                if isinstance(r, dict) and float(r.get("expires_at", 0)) > now
            ]
            recently_used.append({"code": match.get("code", ""), "expires_at": now + PAIRING_TTL_SECONDS})
            data["recently_used"] = recently_used[-MAX_OUTSTANDING_PAIRINGS:]
            self._write(data)
        logger.info("Remote device paired: %s (%s)", device_id, name)
        return device_id, token

    @staticmethod
    def _miss_reason(wanted: str, all_pairings: list, recently_used: list | None, now: float) -> str:
        """Best-effort classification of a redeem miss, for logging only."""
        if not wanted:
            return "unknown code"
        for entry in recently_used or []:
            if isinstance(entry, dict) and normalize_code(entry.get("code", "")) == wanted:
                return "already used"
        for entry in all_pairings:
            if not isinstance(entry, dict) or normalize_code(entry.get("code", "")) != wanted:
                continue
            if float(entry.get("expires_at", 0)) <= now:
                return "expired"
            if int(entry.get("attempts", 0)) + 1 >= MAX_PAIRING_ATTEMPTS:
                return "too many attempts"
            return "unknown code"
        return "unknown code"

    # -- devices ------------------------------------------------------------

    def authenticate(self, token: str) -> Device | None:
        """Return the live Device holding *token*, or None.

        Comparison is constant time over the hex digest. A revoked device is
        None: revocation must be indistinguishable from never having existed.
        """
        if not token or not isinstance(token, str):
            return None
        digest = _sha256_hex(token)
        now = self._now()
        with self._lock:
            data = self._read()
            for entry in data["devices"]:
                if not isinstance(entry, dict):
                    continue
                stored = entry.get("token_sha256")
                if not isinstance(stored, str):
                    continue
                if not hmac.compare_digest(stored, digest):
                    continue
                if entry.get("revoked_at"):
                    return None
                device_id = entry.get("id", "")
                # last_seen advances in memory on every call; persistence is
                # debounced (see _LAST_SEEN_FLUSH_S) -- the phone polls every
                # 1.5-3s, and writing the whole store on every one of those
                # is exactly the concurrent-os.replace race this exists to
                # avoid.
                iso_now = _iso(now)
                self._last_seen_memory[device_id] = iso_now
                last_flush = self._last_seen_flush.get(device_id, 0.0)
                if now - last_flush >= _LAST_SEEN_FLUSH_S:
                    entry["last_seen"] = iso_now
                    try:
                        self._write(data)
                        self._last_seen_flush[device_id] = now
                    except OSError:
                        # Bookkeeping only -- authentication itself already
                        # succeeded above. Never fail the caller's request
                        # over a store write that lost a race or a locked
                        # directory; log it, rate-limited, and move on.
                        self._warn_write_failed_rate_limited(now)
                return Device(
                    id=device_id,
                    name=entry.get("name", ""),
                    created_at=entry.get("created_at", ""),
                    last_seen=self._last_seen_memory.get(device_id, entry.get("last_seen")),
                    revoked_at=entry.get("revoked_at"),
                )
        return None

    def list_devices(self) -> list[Device]:
        """Every device record, revoked ones included (the UI shows status)."""
        data = self._read()
        out: list[Device] = []
        for entry in data["devices"]:
            if not isinstance(entry, dict):
                continue
            out.append(
                Device(
                    id=entry.get("id", ""),
                    name=entry.get("name", ""),
                    created_at=entry.get("created_at", ""),
                    last_seen=entry.get("last_seen"),
                    revoked_at=entry.get("revoked_at"),
                )
            )
        return out

    def revoke(self, device_id: str) -> bool:
        """Stamp *device_id* revoked. Returns False if it was unknown."""
        with self._lock:
            data = self._read()
            for entry in data["devices"]:
                if isinstance(entry, dict) and entry.get("id") == device_id:
                    if entry.get("revoked_at"):
                        return True
                    entry["revoked_at"] = _iso(self._now())
                    self._write(data)
                    logger.info("Remote device revoked: %s", device_id)
                    return True
            return False
