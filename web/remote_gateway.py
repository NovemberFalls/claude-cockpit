"""Studio Remote gateway (protocol v1) -- routers, auth and the stream registry.

Two routers live here and they are deliberately different animals:

* ``admin_router`` (``/api/remote``) is the DESKTOP's control surface. It is an
  ordinary ``/api`` route family and keeps the browser origin guard.
* ``router`` (``/remote/v1``) is the PHONE's surface. It is exempt from the
  origin guard (see ``origin_guard.is_remote_path``) because a phone through a
  tunnel presents a non-loopback Host and no Origin; the device bearer token is
  the boundary there instead.

This module NEVER imports ``server``. Everything it needs from the running
application arrives through ``configure(RemoteBackend, DeviceStore)`` as plain
callables, so the gateway can be exercised on its own against fakes.
"""

from __future__ import annotations

import inspect
import json
import logging
import os
import re
import shutil
import socket
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable

from fastapi import APIRouter, Body, Depends, HTTPException, Request, WebSocket
from fastapi.responses import JSONResponse

import app_paths
from remote_devices import Device, DeviceStore, PairingError

logger = logging.getLogger("cockpit.remote")

PROTOCOL_VERSION = 1

# The only session fields a phone is given. Nothing else -- no jsonl_path, no
# cost, no tokens, no claude_session_id. A remote surface should not carry the
# desktop's whole record just because the desktop's own list route does.
SESSION_FIELDS = (
    "id",
    "name",
    "harness",
    "model",
    "working_dir",
    "alive",
    "activity_state",
    "created_at",
)

# The ONLY per-row fields a phone gets from a folder listing. `entry_count`,
# `dirty` and `skipped` exist in the desktop's own /api/browse rows and are
# deliberately dropped: they are the desktop picker's affordances, and a remote
# surface should not carry the desktop's whole record just because it is there.
BROWSE_ENTRY_FIELDS = ("path", "name", "git", "branch", "session_count")

# (device_id, request_id) pairs already applied. Bounded, because it is a
# convenience against a retried tap on a flaky cellular link, not a durable log.
_IDEMPOTENCY_MAX = 256

# The four permission modes `_create_terminal_from_body` understands, with the
# words a phone shows for them. Ids are the WIRE values and must match
# `permissionMode` exactly; the labels are ours.
PERMISSION_MODES = (
    ("default", "Ask before edits"),
    ("acceptEdits", "Accept edits"),
    ("plan", "Plan only"),
    ("bypassPermissions", "Bypass permissions"),
)
_PERMISSION_MODE_IDS = frozenset(mode_id for mode_id, _label in PERMISSION_MODES)

EFFORTS = ("low", "medium", "high", "xhigh")

# Codex publishes no live `/v1/models` equivalent, so its catalog is a static
# list on BOTH sides of the app -- here, and in
# `web/frontend/src/modelCatalog.js`'s CODEX_MODEL_GROUPS. Two static lists is
# exactly the drift hazard `modelCatalog.js` exists to prevent for Anthropic,
# so `tests/test_remote_codex_catalog_sync.py` reads that file and asserts set
# equality with these ids. Change one, change the other, or the suite reddens.
CODEX_MODELS = (
    ("gpt-6-astra", "GPT-6 Astra"),
    ("gpt-5.6-sol", "GPT-5.6 Sol"),
    ("gpt-5.6-terra", "GPT-5.6 Terra"),
    ("gpt-5.6-luna", "GPT-5.6 Luna"),
    ("gpt-5.5", "GPT-5.5"),
    ("gpt-5.3-codex-spark", "Codex Spark"),
)
CODEX_DEFAULT_MODEL = "gpt-6-astra"

# Saved folders the desktop publishes for the phone's "Saved" tab.
LOCATIONS_FILENAME = "remote_locations.json"
MAX_SAVED_LOCATIONS = 200


@dataclass
class RemoteBackend:
    """The slice of the running server the gateway is allowed to touch.

    The four fields added for Stage 1c default to ``None`` so an older caller
    (or a narrower test fake) still constructs a valid backend; the routes that
    need them answer 503 rather than 500 when they are absent.

    Two of them are annotated as returning either a value or an awaitable, and
    that is deliberate rather than sloppy. ``browse`` is wired to
    ``server.browse_directories`` -- the SAME callable ``GET /api/browse`` uses,
    which is a FastAPI route and therefore hands back a ``JSONResponse``; and
    ``delete_session`` is wired to ``pty_manager.kill_terminal``, the SAME
    synchronous call ``DELETE /api/terminals/{id}`` makes. Wrapping either one
    in server.py to make the annotation prettier would mean the phone no longer
    travels the identical code path, which is the property that matters.
    """

    settings: Callable[[], dict]
    app_version: Callable[[], str]
    list_sessions: Callable[[], list[dict]]
    get_session: Callable[[str], Any]
    create_session: Callable[[dict], Awaitable[dict]]
    submit: Callable[[str, str], Awaitable[bool]]
    write_raw: Callable[[str, str], Awaitable[bool]]
    interrupt: Callable[[str], Awaitable[bool]]
    browse: Callable[[str], Awaitable[dict] | Any] | None = None
    delete_session: Callable[[str], Awaitable[bool] | bool] | None = None
    recent_workdirs: Callable[[int], list[dict]] | None = None
    anthropic_models: Callable[[], Awaitable[dict]] | None = None


class StreamRegistry:
    """Open remote sockets, keyed by device, so a revoke can hang them up."""

    def __init__(self) -> None:
        self._sockets: dict[str, set] = {}

    def register(self, device_id: str, websocket) -> None:
        self._sockets.setdefault(device_id, set()).add(websocket)

    def unregister(self, device_id: str, websocket) -> None:
        sockets = self._sockets.get(device_id)
        if not sockets:
            return
        sockets.discard(websocket)
        if not sockets:
            self._sockets.pop(device_id, None)

    def count(self, device_id: str) -> int:
        return len(self._sockets.get(device_id, ()))

    async def close_device(self, device_id: str) -> None:
        """Close every socket held by *device_id*.

        Best effort per socket: one already-dead socket must not strand the
        others, which is exactly the state revocation is meant to end.
        """
        for websocket in list(self._sockets.get(device_id, ())):
            try:
                await websocket.close(code=4401)
            except Exception:  # noqa: BLE001 - a dead socket is the normal case
                logger.debug("Failed closing remote socket for %s", device_id, exc_info=True)
        self._sockets.pop(device_id, None)


registry = StreamRegistry()

_backend: RemoteBackend | None = None
_store: DeviceStore | None = None
_seen_requests: "OrderedDict[tuple[str, str], bool]" = OrderedDict()


def configure(backend: RemoteBackend, store: DeviceStore) -> None:
    """Wire the gateway to the running server. Called once from server.py."""
    global _backend, _store
    _backend = backend
    _store = store
    _seen_requests.clear()


def _require_configured() -> tuple[RemoteBackend, DeviceStore]:
    if _backend is None or _store is None:
        raise HTTPException(status_code=503, detail="remote not configured")
    return _backend, _store


def remote_enabled() -> bool:
    """True when settings say remote access is on. False on any read failure."""
    if _backend is None:
        return False
    try:
        settings = _backend.settings() or {}
    except Exception:  # noqa: BLE001 - a settings read must never 500 the gateway
        logger.warning("Failed to read settings for remote gate", exc_info=True)
        return False
    remote = settings.get("remote")
    return bool(isinstance(remote, dict) and remote.get("enabled"))


def _remote_hostname() -> str:
    if _backend is None:
        return ""
    try:
        settings = _backend.settings() or {}
    except Exception:  # noqa: BLE001
        logger.warning("Failed to read settings for remote hostname", exc_info=True)
        return ""
    remote = settings.get("remote")
    if not isinstance(remote, dict):
        return ""
    hostname = remote.get("hostname")
    return hostname.rstrip("/") if isinstance(hostname, str) else ""


def _bearer_token(headers) -> str | None:
    raw = headers.get("authorization") or headers.get("Authorization")
    if not raw or not isinstance(raw, str):
        return None
    scheme, _, token = raw.partition(" ")
    if scheme.lower() != "bearer":
        return None
    token = token.strip()
    return token or None


def require_device(request: Request) -> Device:
    """FastAPI dependency: the authenticated device, or an HTTPException.

    Order matters and is load-bearing: when remote is disabled EVERY route
    answers 404 before any credential is examined, so a probe cannot learn
    whether a token is valid on a desktop that has remote turned off.
    """
    _require_configured()
    if not remote_enabled():
        raise HTTPException(status_code=404, detail="remote disabled")
    token = _bearer_token(request.headers)
    device = _store.authenticate(token) if token else None
    if device is None:
        raise HTTPException(status_code=401, detail="unauthorized")
    return device


def authenticate_websocket(websocket: WebSocket) -> Device | None:
    """The same rules as ``require_device``, but as a value rather than a raise.

    A WebSocket handshake has no useful place to put an HTTPException, and the
    caller has to distinguish "disabled" from "unauthorized" only in so far as
    both refuse pre-accept. Returns None for either.
    """
    if _backend is None or _store is None:
        return None
    if not remote_enabled():
        return None
    token = _bearer_token(websocket.headers)
    if not token:
        return None
    return _store.authenticate(token)


def _lan_ipv4() -> str:
    """This machine's primary IPv4, or 127.0.0.1.

    The UDP connect trick: connecting a datagram socket sends NOTHING on the
    wire, it only makes the kernel pick the source address it would route
    8.8.8.8 through -- which is the interface a phone on the same LAN can
    actually reach.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        addr = sock.getsockname()[0]
        return addr or "127.0.0.1"
    except OSError:
        logger.debug("Could not determine LAN IPv4 -- falling back to loopback", exc_info=True)
        return "127.0.0.1"
    finally:
        sock.close()


def _pairing_url() -> str:
    hostname = _remote_hostname()
    if hostname:
        return hostname
    port = os.getenv("PORT", "8420")
    return f"http://{_lan_ipv4()}:{port}"


def _session_view(entry: dict) -> dict:
    return {key: entry.get(key) for key in SESSION_FIELDS}


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


async def _read_json(request: Request) -> dict:
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 - a malformed body is a client error
        return {}
    return body if isinstance(body, dict) else {}


async def _maybe_await(value: Any) -> Any:
    """Await *value* when it is awaitable, otherwise hand it straight back.

    Lets one route body drive both an ``async def`` server route and a plain
    synchronous manager call without the wiring in server.py having to lie
    about which it is.
    """
    if inspect.isawaitable(value):
        return await value
    return value


def _as_dict(result: Any) -> dict:
    """Normalize a backend reply to a plain dict.

    ``browse_directories`` returns a ``JSONResponse`` (it is a route); test
    fakes return a dict. Reading both here is what allows the gateway to call
    the real route function rather than a parallel copy of it.
    """
    if isinstance(result, dict):
        return result
    body = getattr(result, "body", None)
    if isinstance(body, (bytes, bytearray)):
        try:
            data = json.loads(bytes(body).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            logger.warning("Backend reply was not decodable JSON", exc_info=True)
            return {}
        return data if isinstance(data, dict) else {}
    return {}


# A Windows absolute path, checked EXPLICITLY rather than left to
# ``os.path.isabs``: that function answers for the platform the server runs on,
# so "C:\\Code" is relative to a Linux CI runner. The phone's paths come from
# the desktop, not from this process's filesystem.
_WINDOWS_ABS_RE = re.compile(r"^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+)")


def _is_absolute_path(value: Any) -> bool:
    """True for a POSIX root path, a Windows drive path, or a UNC path."""
    if not isinstance(value, str):
        return False
    text = value.strip()
    if not text:
        return False
    if text.startswith("/") or _WINDOWS_ABS_RE.match(text):
        return True
    return os.path.isabs(text)


def _is_browsable_path(value: str) -> bool:
    """``_is_absolute_path`` plus a refusal of anything with a ``..`` segment.

    The walk itself is the desktop's own listing code and is not sandboxed --
    it never was, because on the desktop the whole filesystem is already the
    user's. Refusing traversal-looking input here is not a sandbox either; it
    keeps a phone from asking for a path the desktop UI could not have produced,
    so a malformed request fails loudly instead of listing something surprising.
    """
    if not isinstance(value, str):
        return False
    if ".." in [part for part in re.split(r"[\\/]+", value.strip()) if part]:
        return False
    return _is_absolute_path(value)


def _dedupe_key(path: str) -> str:
    """The key two spellings of one folder must share.

    Trailing separators are stripped everywhere; case is folded on Windows
    ONLY. Folding on Linux would merge ``/srv/App`` and ``/srv/app``, which are
    two different directories there.
    """
    text = str(path or "").strip().rstrip("\\/")
    return text.casefold() if os.name == "nt" else text


def _locations_file() -> Path:
    """Where the desktop's published folder list lives. Patched in tests."""
    return app_paths.data_path(LOCATIONS_FILENAME)


def _read_locations() -> list[dict]:
    """The saved folders, or [] for any missing/unreadable/corrupt file.

    A phone that cannot see its Saved tab is an inconvenience; a 500 on the
    workdirs route would take the Recent and Browse tabs down with it.
    """
    path = _locations_file()
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return []
    except OSError:
        logger.warning("Failed to read saved locations %s -- treating as empty", path, exc_info=True)
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("Saved locations %s contain invalid JSON -- treating as empty", path, exc_info=True)
        return []
    items = data.get("locations") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict)]


def _write_locations(locations: list[dict]) -> None:
    """Atomically replace the saved-folder file. Same shape as DeviceStore._write."""
    path = _locations_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix="remote_locations_", suffix=".json.tmp", dir=str(path.parent))
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump({"locations": locations}, handle, indent=2)
        os.replace(tmp_path, path)
    except OSError:
        logger.warning("Failed to write saved locations %s", path, exc_info=True)
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            logger.debug("Failed to clean up temp locations file %s", tmp_path, exc_info=True)
        raise


def _remember_request(device_id: str, request_id: str) -> bool:
    """Record (device, request) as applied. False if it was already there.

    With no request_id the caller does not opt in and every call writes -- an
    absent id means "I have no way to tell you these are the same tap", and
    inventing one would silently swallow a deliberate repeat.
    """
    key = (device_id, request_id)
    if key in _seen_requests:
        _seen_requests.move_to_end(key)
        return False
    _seen_requests[key] = True
    while len(_seen_requests) > _IDEMPOTENCY_MAX:
        _seen_requests.popitem(last=False)
    return True


def _access_required() -> bool:
    if _backend is None:
        return False
    try:
        settings = _backend.settings() or {}
    except Exception:  # noqa: BLE001 - a settings read must never 500 the gateway
        logger.warning("Failed to read settings for remote access_required", exc_info=True)
        return False
    remote = settings.get("remote")
    return bool(isinstance(remote, dict) and remote.get("access_required"))


def qr_payload(url: str, code: str) -> str:
    """Build the pairing QR payload string, verbatim what the phone scans.

    Carries ``"access": true`` only when the operator has told Studio a
    Cloudflare Access gate sits in front of the tunnel (``remote.access_required``).
    """
    payload: dict[str, Any] = {"v": 1, "url": url, "code": code}
    if _access_required():
        payload["access"] = True
    return json.dumps(payload)


# ---------------------------------------------------------------------------
# admin_router -- desktop only, origin-guarded like every other /api route
# ---------------------------------------------------------------------------

admin_router = APIRouter(prefix="/api/remote")


@admin_router.post("/pairings")
async def create_pairing():
    """Mint a pairing code plus everything a phone needs to reach this host."""
    _backend_, store = _require_configured()
    if not remote_enabled():
        return _error(409, "remote disabled")
    pairing = store.create_pairing()
    url = _pairing_url()
    return {
        "code": pairing["code"],
        "expires_at": pairing["expires_at"],
        "url": url,
        "qr_payload": qr_payload(url, pairing["code"]),
    }


@admin_router.get("/status")
async def remote_status():
    _backend_, store = _require_configured()
    return {
        "enabled": remote_enabled(),
        "hostname": _remote_hostname(),
        "protocol": PROTOCOL_VERSION,
        "devices": [d.to_dict() for d in store.list_devices()],
    }


@admin_router.delete("/devices/{device_id}")
async def revoke_device(device_id: str):
    _backend_, store = _require_configured()
    if not store.revoke(device_id):
        return _error(404, "unknown device")
    await registry.close_device(device_id)
    return {"revoked": True}


@admin_router.put("/locations")
async def put_locations(request: Request):
    """Publish the desktop's saved folders for the phone's "Saved" tab.

    Validated all-or-nothing, like PUT /api/settings: one bad entry means the
    stored list is left exactly as it was rather than half-replaced. This is a
    REPLACE, not a merge -- the desktop's saved list is the whole truth, and a
    merge would make deleting a location impossible.
    """
    body = await _read_json(request)
    raw = body.get("locations")
    if not isinstance(raw, list):
        return _error(400, "locations must be a list")
    if len(raw) > MAX_SAVED_LOCATIONS:
        return _error(400, f"at most {MAX_SAVED_LOCATIONS} locations")
    cleaned: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            return _error(400, "each location must be an object")
        path = item.get("path")
        if not _is_absolute_path(path):
            return _error(400, "each location needs an absolute path")
        name = item.get("name")
        cleaned.append(
            {
                "path": path.strip(),
                "name": name.strip() if isinstance(name, str) and name.strip() else None,
            }
        )
    try:
        _write_locations(cleaned)
    except OSError:
        return _error(500, "could not save locations")
    return {"count": len(cleaned)}


# -- self-hosted Cloudflare deployment tools (Settings > Remote) -----------

# Lowercase DNS label characters and dots only. No scheme, no path, no port --
# this string is later interpolated into an https:// URL and nowhere else.
_HOSTNAME_RE = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$")

_CLOUDFLARED_WIN_PATH = r"C:\Program Files (x86)\cloudflared\cloudflared.exe"

_TUNNEL_NAME = "plexar-studio"


def _valid_hostname(hostname: str) -> bool:
    if not isinstance(hostname, str):
        return False
    if not (3 <= len(hostname) <= 253):
        return False
    if "://" in hostname:
        return False
    return bool(_HOSTNAME_RE.match(hostname))


def _hostname_from(raw: str) -> str:
    """Reduce what the Public URL field holds to a bare hostname.

    The field is a URL ("https://studio.example.com") because that is what the
    phone needs, and the desktop tools take the same value. Measured
    2026-09-08: passing the URL straight to the validator produced "invalid
    hostname" on a correctly configured desktop. Scheme, port and path are
    dropped; what remains is validated exactly as before.
    """
    raw = (raw or "").strip()
    if "://" in raw:
        raw = urllib.parse.urlsplit(raw).hostname or ""
    else:
        raw = raw.split("/", 1)[0].rsplit("@", 1)[-1]
        if raw.count(":") == 1:
            raw = raw.split(":", 1)[0]
    return raw.lower().rstrip(".")


@admin_router.get("/cloudflared-config")
async def cloudflared_config(hostname: str = ""):
    hostname = _hostname_from(hostname)
    if not _valid_hostname(hostname):
        return _error(400, "invalid hostname")
    port = os.getenv("PORT", "8420")
    config_yml = (
        "tunnel: <tunnel-id>\n"
        "credentials-file: %USERPROFILE%\\.cloudflared\\<tunnel-id>.json\n"
        "\n"
        "ingress:\n"
        f"  - hostname: {hostname}\n"
        "    path: ^/remote/v1/\n"
        f"    service: http://127.0.0.1:{port}\n"
        "\n"
        "  - service: http_status:404\n"
    )
    commands = [
        "cloudflared tunnel login",
        f"cloudflared tunnel create {_TUNNEL_NAME}",
        f"cloudflared tunnel route dns {_TUNNEL_NAME} {hostname}",
        "Write the config above to %USERPROFILE%\\.cloudflared\\config.yml",
        "cloudflared service install",
    ]
    return {"hostname": hostname, "config_yml": config_yml, "commands": commands}


def _cloudflared_path() -> str | None:
    found = shutil.which("cloudflared")
    if found:
        return found
    if os.path.isfile(_CLOUDFLARED_WIN_PATH):
        return _CLOUDFLARED_WIN_PATH
    return None


def _cloudflared_running() -> bool:
    try:
        import psutil
    except Exception:  # noqa: BLE001 - psutil absence must not 500 this route
        logger.debug("psutil unavailable for cloudflared running check", exc_info=True)
        return False
    try:
        for proc in psutil.process_iter(["name"]):
            try:
                name = (proc.info.get("name") or "").lower()
            except Exception:  # noqa: BLE001 - a vanished process is not our error
                continue
            if name in ("cloudflared", "cloudflared.exe"):
                return True
    except Exception:  # noqa: BLE001 - enumeration must never 500 this route
        logger.debug("Failed to enumerate processes for cloudflared", exc_info=True)
        return False
    return False


@admin_router.get("/cloudflared")
async def cloudflared_status():
    path = _cloudflared_path()
    return {
        "installed": bool(path),
        "path": path,
        "version": None,
        "running": _cloudflared_running(),
    }


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        return None


# Cloudflare's default bot rules answer urllib's own "Python-urllib/3.x" agent
# with a bare 403 (measured 2026-09-08 on studio.boord-its.com: curl, Dart and a
# browser all got the Access 302; Python-urllib alone got 403). A probe that
# announces itself honestly gets the same answer a phone would.
_PROBE_USER_AGENT = "PlexarStudio-remote-probe/1"


def _fetch_probe(hostname: str) -> tuple[int | None, dict, str]:
    """GET https://<hostname>/remote/v1/hello, redirects NOT followed, no creds.

    Returns (status, headers, body); status is None only on a genuine
    connect/DNS/timeout failure. Overridden in tests via ``_fetch_probe``.
    """
    url = f"https://{hostname}/remote/v1/hello"
    opener = urllib.request.build_opener(_NoRedirectHandler)
    request = urllib.request.Request(url, method="GET", headers={"User-Agent": _PROBE_USER_AGENT})
    try:
        with opener.open(request, timeout=5) as resp:
            body = resp.read(65536).decode("utf-8", errors="replace")
            return resp.status, dict(resp.headers.items()), body
    except urllib.error.HTTPError as exc:
        headers = dict(exc.headers.items()) if exc.headers else {}
        try:
            body = exc.read(65536).decode("utf-8", errors="replace")
        except Exception:  # noqa: BLE001 - a body-less error response is fine
            body = ""
        return exc.code, headers, body
    except (urllib.error.URLError, OSError):
        logger.debug("Probe of %s was unreachable", hostname, exc_info=True)
        return None, {}, ""


def _header(headers: dict, name: str) -> str:
    for key, value in (headers or {}).items():
        if key.lower() == name.lower():
            return value
    return ""


def _classify_probe(status: int | None, headers: dict, body: str) -> str:
    if status is None:
        return "unreachable"
    if 300 <= status < 400 and "cloudflareaccess.com" in _header(headers, "Location"):
        return "access"
    content_type = _header(headers, "Content-Type").lower()
    stripped = (body or "").strip().lower()
    if "html" in content_type or stripped.startswith("<!doctype html") or stripped.startswith("<html"):
        return "access"
    if status == 401:
        try:
            data = json.loads(body)
        except (ValueError, TypeError):
            data = None
        if isinstance(data, dict):
            return "guarded"
    if status == 404:
        try:
            data = json.loads(body)
        except (ValueError, TypeError):
            data = None
        if isinstance(data, dict) and data.get("error") == "remote disabled":
            return "disabled"
    return "unexpected"


@admin_router.post("/probe")
def probe_public_url(payload: dict = Body(default={})):
    """Server-side probe of the operator's own public hostname.

    A plain ``def`` route: FastAPI runs it in its threadpool, so the blocking
    urllib call never stalls the event loop the way an unguarded call in an
    ``async def`` route would.
    """
    hostname = _hostname_from(str((payload or {}).get("hostname") or ""))
    if not _valid_hostname(hostname):
        return _error(400, "invalid hostname")
    status, headers, body = _fetch_probe(hostname)
    classification = _classify_probe(status, headers, body)
    return {"hostname": hostname, "classification": classification, "status": status}


# ---------------------------------------------------------------------------
# router -- the phone's surface, device-authenticated
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/remote/v1")


@router.post("/pair")
async def pair(request: Request):
    """Redeem a pairing code. The ONE route with no bearer token."""
    _backend_, store = _require_configured()
    if not remote_enabled():
        return _error(404, "remote disabled")
    body = await _read_json(request)
    try:
        device_id, token = store.redeem_pairing(
            str(body.get("code") or ""), str(body.get("device_name") or "")
        )
    except PairingError as exc:
        return _error(400, str(exc))
    return {
        "device_id": device_id,
        "token": token,
        "protocol": PROTOCOL_VERSION,
        "app_version": _backend_.app_version(),
    }


@router.get("/hello")
async def hello(device: Device = Depends(require_device)):
    backend, _store_ = _require_configured()
    return {
        "protocol": PROTOCOL_VERSION,
        "app_version": backend.app_version(),
        "device": {"id": device.id, "name": device.name},
        "session_count": len(backend.list_sessions()),
    }


@router.get("/sessions")
async def list_sessions(device: Device = Depends(require_device)):
    backend, _store_ = _require_configured()
    return {"sessions": [_session_view(s) for s in backend.list_sessions()]}


@router.post("/sessions", status_code=201)
async def create_session(request: Request, device: Device = Depends(require_device)):
    """Spawn a session. The three optional knobs are validated HERE, not there.

    `permission_mode`, `effort` and `bypass` are the phone's wire names; they
    are renamed to the local create body's `permissionMode` / `effort` /
    `bypassPermissions` and are OMITTED entirely when the caller did not send
    them, so an absent field keeps `_create_terminal_from_body`'s own default
    rather than this route inventing one.
    """
    backend, _store_ = _require_configured()
    body = await _read_json(request)
    payload = {
        "name": body.get("name"),
        "workdir": body.get("workdir"),
        "harness": body.get("harness"),
        "model": body.get("model"),
    }
    mode = body.get("permission_mode")
    if mode is not None:
        if not isinstance(mode, str) or mode not in _PERMISSION_MODE_IDS:
            return _error(400, "unknown permission_mode")
        payload["permissionMode"] = mode
    effort = body.get("effort")
    if effort is not None:
        if not isinstance(effort, str) or effort not in EFFORTS:
            return _error(400, "unknown effort")
        payload["effort"] = effort
    bypass = body.get("bypass")
    if bypass is not None:
        if not isinstance(bypass, bool):
            return _error(400, "bypass must be a boolean")
        payload["bypassPermissions"] = bypass
    try:
        session = await backend.create_session(payload)
    except ValueError as exc:
        return _error(400, str(exc))
    return {"session": _session_view(session or {})}


@router.delete("/sessions/{terminal_id}")
async def close_session(terminal_id: str, device: Device = Depends(require_device)):
    """Close a session from the phone, via the same kill DELETE /api/terminals does."""
    backend, _store_ = _require_configured()
    if backend.delete_session is None:
        return _error(503, "closing sessions is not available")
    if backend.get_session(terminal_id) is None:
        return _error(404, "unknown session")
    closed = await _maybe_await(backend.delete_session(terminal_id))
    return {"closed": bool(closed)}


@router.post("/sessions/{terminal_id}/input")
async def send_input(
    terminal_id: str, request: Request, device: Device = Depends(require_device)
):
    backend, _store_ = _require_configured()
    if backend.get_session(terminal_id) is None:
        return _error(404, "unknown session")
    body = await _read_json(request)
    text = body.get("text")
    if not isinstance(text, str):
        return _error(400, "text must be a string")
    request_id = body.get("request_id")
    if isinstance(request_id, str) and request_id:
        if not _remember_request(device.id, request_id):
            return {"accepted": True, "duplicate": True}
    submit = body.get("submit")
    submit = True if submit is None else bool(submit)
    if submit:
        accepted = await backend.submit(terminal_id, text)
    else:
        accepted = await backend.write_raw(terminal_id, text)
    return {"accepted": bool(accepted), "duplicate": False}


@router.post("/sessions/{terminal_id}/interrupt")
async def interrupt(terminal_id: str, device: Device = Depends(require_device)):
    backend, _store_ = _require_configured()
    if backend.get_session(terminal_id) is None:
        return _error(404, "unknown session")
    accepted = await backend.interrupt(terminal_id)
    return {"accepted": bool(accepted)}


# ---------------------------------------------------------------------------
# Where a new session should run: saved folders, live sessions, history, and
# the filesystem the desktop can already see.
# ---------------------------------------------------------------------------


def _sessions_newest_first(backend: RemoteBackend) -> list[dict]:
    """Live sessions, newest first. Never raises -- an empty list is an answer."""
    try:
        sessions = list(backend.list_sessions() or [])
    except Exception:  # noqa: BLE001 - one bad session list must not 500 /workdirs
        logger.warning("Failed listing sessions for /workdirs", exc_info=True)
        return []
    rows = [s for s in sessions if isinstance(s, dict)]
    # sorted() is stable and stays stable under reverse=True, so sessions that
    # carry no created_at keep the order the manager listed them in.
    return sorted(rows, key=lambda s: str(s.get("created_at") or ""), reverse=True)


async def _drive_roots(backend: RemoteBackend) -> list[str]:
    """The same roots ``browse_directories("")`` returns; ["/"] if it cannot say."""
    if backend.browse is None:
        return ["/"]
    try:
        data = _as_dict(await _maybe_await(backend.browse("")))
    except OSError:
        logger.warning("Failed listing drive roots for /workdirs", exc_info=True)
        return ["/"]
    dirs = data.get("dirs")
    roots = [d for d in dirs if isinstance(d, str) and d] if isinstance(dirs, list) else []
    return roots or ["/"]


@router.get("/workdirs")
async def list_workdirs(device: Device = Depends(require_device)):
    """Every folder the phone could sensibly start a session in, best first.

    Three sources in one list, each row saying which one it came from, because
    they mean different things: `saved` is a folder the user deliberately kept,
    `session` is one something is running in RIGHT NOW, and `history` is one
    that has usage on record. De-duplication keeps the FIRST occurrence, so a
    saved folder that also has a live session stays labelled `saved` -- the
    stronger statement of the two.
    """
    backend, _store_ = _require_configured()
    workdirs: list[dict] = []
    seen: set[str] = set()

    def add(path: Any, name: Any, source: str, last_used: Any) -> None:
        if not isinstance(path, str):
            return
        path = path.strip()
        if not path:
            return
        key = _dedupe_key(path)
        if key in seen:
            return
        seen.add(key)
        workdirs.append(
            {
                "path": path,
                "name": name if isinstance(name, str) and name else None,
                "source": source,
                "last_used": last_used if isinstance(last_used, str) and last_used else None,
            }
        )

    for entry in _read_locations():
        add(entry.get("path"), entry.get("name"), "saved", None)

    for session in _sessions_newest_first(backend):
        # `last_used` for a LIVE session is when it started: the only timestamp
        # this record actually carries. Claiming "now" would be an invention.
        add(session.get("working_dir"), None, "session", session.get("created_at"))

    if backend.recent_workdirs is not None:
        try:
            history = backend.recent_workdirs(30) or []
        except Exception:  # noqa: BLE001 - a usage DB error must not lose the other two sources
            logger.warning("Failed reading recent workdirs from usage history", exc_info=True)
            history = []
        for row in history:
            if isinstance(row, dict):
                add(row.get("path"), None, "history", row.get("last_used"))

    return {"workdirs": workdirs, "roots": await _drive_roots(backend)}


@router.get("/browse")
async def browse(path: str = "", device: Device = Depends(require_device)):
    """Subdirectories of *path*, through the desktop's own listing code.

    An unreadable folder answers 200 with an empty `entries` and an `error`
    string, NOT a 5xx: the phone is mid-navigation and needs to be told this
    one folder cannot be walked while the breadcrumb it came from still works.
    """
    backend, _store_ = _require_configured()
    if backend.browse is None:
        return _error(503, "browsing is not available")
    requested = (path or "").strip()
    if requested and not _is_browsable_path(requested):
        return _error(400, "path must be absolute")
    try:
        data = _as_dict(await _maybe_await(backend.browse(requested)))
    except OSError as exc:
        logger.debug("Remote browse failed for %r", requested, exc_info=True)
        return {"path": requested, "parent": None, "entries": [], "error": str(exc)}
    parent = data.get("parent")
    raw_entries = data.get("entries")
    entries = []
    if isinstance(raw_entries, list):
        for entry in raw_entries:
            if not isinstance(entry, dict):
                continue
            row = {key: entry.get(key) for key in BROWSE_ENTRY_FIELDS}
            row["git"] = bool(row["git"])
            row["session_count"] = row["session_count"] if isinstance(row["session_count"], int) else 0
            entries.append(row)
    return {
        "path": requested,
        "parent": parent if isinstance(parent, str) and parent else None,
        "entries": entries,
    }


def _configured_session_model() -> str:
    """`sessions.model` from settings, or "" when unset/unreadable."""
    if _backend is None:
        return ""
    try:
        settings = _backend.settings() or {}
    except Exception:  # noqa: BLE001 - a settings read must never 500 the gateway
        logger.warning("Failed to read settings for the remote catalog", exc_info=True)
        return ""
    sessions = settings.get("sessions")
    model = sessions.get("model") if isinstance(sessions, dict) else None
    return model.strip() if isinstance(model, str) else ""


@router.get("/catalog")
async def catalog(device: Device = Depends(require_device)):
    """What a new session can be: harnesses, their models, modes and efforts.

    The Claude list is the LIVE one the desktop picker reads; there is no
    static fallback written here, because a second hardcoded Anthropic catalog
    is exactly what `modelCatalog.js` exists to prevent. If the catalog cannot
    be read the list is empty and `default_model` is null -- the phone renders
    "no models" rather than a plausible id that may not exist.
    """
    backend, _store_ = _require_configured()
    claude_models: list[dict] = []
    if backend.anthropic_models is not None:
        try:
            data = _as_dict(await _maybe_await(backend.anthropic_models()))
        except OSError:
            logger.warning("Failed reading the Anthropic model catalog for /catalog", exc_info=True)
            data = {}
        raw_models = data.get("models")
        for model in raw_models if isinstance(raw_models, list) else []:
            if not isinstance(model, dict):
                continue
            model_id = model.get("id")
            if not isinstance(model_id, str) or not model_id:
                continue
            label = model.get("display_name") or model.get("label") or model_id
            claude_models.append({"id": model_id, "label": str(label)})
    configured = _configured_session_model()
    claude_default = configured or (claude_models[0]["id"] if claude_models else None)
    return {
        "harnesses": [
            {
                "id": "claude-code",
                "label": "Claude Code",
                "models": claude_models,
                "default_model": claude_default,
            },
            {
                "id": "codex",
                "label": "Codex",
                "models": [{"id": mid, "label": label} for mid, label in CODEX_MODELS],
                "default_model": CODEX_DEFAULT_MODEL,
            },
        ],
        "permission_modes": [{"id": mode_id, "label": label} for mode_id, label in PERMISSION_MODES],
        "efforts": list(EFFORTS),
    }
