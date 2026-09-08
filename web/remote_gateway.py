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

import json
import logging
import os
import re
import shutil
import socket
import urllib.error
import urllib.request
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from fastapi import APIRouter, Body, Depends, HTTPException, Request, WebSocket
from fastapi.responses import JSONResponse

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

# (device_id, request_id) pairs already applied. Bounded, because it is a
# convenience against a retried tap on a flaky cellular link, not a durable log.
_IDEMPOTENCY_MAX = 256


@dataclass
class RemoteBackend:
    """The slice of the running server the gateway is allowed to touch."""

    settings: Callable[[], dict]
    app_version: Callable[[], str]
    list_sessions: Callable[[], list[dict]]
    get_session: Callable[[str], Any]
    create_session: Callable[[dict], Awaitable[dict]]
    submit: Callable[[str, str], Awaitable[bool]]
    write_raw: Callable[[str, str], Awaitable[bool]]
    interrupt: Callable[[str], Awaitable[bool]]


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


@admin_router.get("/cloudflared-config")
async def cloudflared_config(hostname: str = ""):
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


def _fetch_probe(hostname: str) -> tuple[int | None, dict, str]:
    """GET https://<hostname>/remote/v1/hello, redirects NOT followed, no creds.

    Returns (status, headers, body); status is None only on a genuine
    connect/DNS/timeout failure. Overridden in tests via ``_fetch_probe``.
    """
    url = f"https://{hostname}/remote/v1/hello"
    opener = urllib.request.build_opener(_NoRedirectHandler)
    request = urllib.request.Request(url, method="GET")
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
    hostname = str((payload or {}).get("hostname") or "")
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
    backend, _store_ = _require_configured()
    body = await _read_json(request)
    payload = {
        "name": body.get("name"),
        "workdir": body.get("workdir"),
        "harness": body.get("harness"),
        "model": body.get("model"),
    }
    try:
        session = await backend.create_session(payload)
    except ValueError as exc:
        return _error(400, str(exc))
    return {"session": _session_view(session or {})}


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
