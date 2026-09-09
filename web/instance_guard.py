"""Decide, BEFORE uvicorn binds, what to do about whoever already holds the port.

WHY THIS EXISTS (measured 2026-09-08). The desktop sidecar is a PyInstaller
onefile exe: Tauri terminates the *bootloader* on app exit, and the Python child
it unpacked keeps running -- after TerminateProcess on the bootloader the child
still answered ``GET /api/version``. That is deliberate and must be preserved:
it is why the owner's sessions survive closing the window.

The failure was in the RELAUNCH. The new sidecar's uvicorn could not bind, wrote
``[Errno 10048]`` to stderr only (cockpit.log showed "Startup complete" then
"Shutdown complete" in the same second, twelve times in one morning), exited 1,
and Tauri retried three times before attaching the window to whichever process
held the port. When that process was HUNG, the app was bricked until the user
found it in Task Manager.

So the pre-bind decision is made explicitly here, logged, and self-healing:

  * ``free``    -- nobody is listening; bind normally.
  * ``healthy`` -- a Plexar Studio sidecar is serving the port and answering.
    The new process should exit ``ATTACH_EXIT_CODE`` and let the window attach.
  * ``hung``    -- a Plexar Studio sidecar holds the port and has stopped
    answering for ``HUNG_AFTER_S``. Terminate it, then re-inspect.
  * ``foreign`` -- somebody ELSE holds the port (or we could not identify the
    holder). Never touched, under any circumstance.

THE ONE INVARIANT: a process is killed only when its executable basename is in
``SIDECAR_NAMES``. It is enforced twice -- ``inspect_port`` cannot return
``hung`` for a name outside that set, and ``resolve_port`` re-checks the verdict
before it calls ``terminate()``.

Children of a hung holder are NOT killed by us: the CLI processes live in ConPTY
job objects that close with their holder.
"""

from __future__ import annotations

import http.client
import json
import logging
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass

import psutil

# Sidecar exit status meaning "a healthy Studio already serves this port; attach
# to it". Distinct from 0 (clean shutdown) and 1 (crashed) so the launcher can
# tell "there is already one running" from "this one died".
ATTACH_EXIT_CODE = 3

# One probe of GET /api/version. Short: the holder is either answering promptly
# or it is the hung case this module exists to clear.
PROBE_TIMEOUT_S = 1.5

# How long the holder must stay silent before it counts as hung. Generous on
# purpose -- a healthy sidecar mid-startup (PyInstaller unpack + imports) can
# hold the socket for several seconds before FastAPI answers, and killing THAT
# is the one mistake that would be worse than the bug being fixed.
HUNG_AFTER_S = 10.0

# Gap between probes while waiting out HUNG_AFTER_S.
PROBE_INTERVAL_S = 1.0

# Every executable name Plexar Studio has ever shipped its server under. The
# kill path is gated on this set; a name outside it is `foreign` and untouchable.
SIDECAR_NAMES = {
    "plexar-studio-server.exe",
    "plexar-studio-server-x86_64-pc-windows-msvc.exe",
    "cockpit-server.exe",
    "cockpit-server-x86_64-pc-windows-msvc.exe",
    "claude-cockpit.exe",
}

# A wildcard listener holds every local address, so it matches whatever host we
# were about to bind; the loopback spellings all name the same interface.
_WILDCARD_ADDRS = {"0.0.0.0", "::", ""}
_LOOPBACK_ADDRS = {"127.0.0.1", "::1", "localhost"}

logger = logging.getLogger("cockpit.server")


@dataclass
class PortVerdict:
    """What is on the port, who owns it, and one line a human can act on."""

    state: str        # "free" | "healthy" | "hung" | "foreign"
    pid: int | None
    name: str | None
    detail: str


# ---------------------------------------------------------------------------
# Injection points (defaults are the real thing; tests replace them)
# ---------------------------------------------------------------------------


def _default_connections():
    return psutil.net_connections(kind="tcp")


def _default_process_name(pid: int) -> str | None:
    try:
        return psutil.Process(pid).name()
    except (psutil.Error, OSError):
        logger.debug("Could not read the name of PID %s holding the port", pid, exc_info=True)
        return None


def _default_probe(port: int) -> bool:
    """True when http://127.0.0.1:{port}/api/version answers 200 with an "app" key.

    No Origin header is sent, which is exactly what the browser-origin guard
    treats as same-origin on HTTP -- so a healthy Studio answers this probe.
    """
    url = f"http://127.0.0.1:{port}/api/version"
    request = urllib.request.Request(url, headers={"Host": f"127.0.0.1:{port}"})
    try:
        with urllib.request.urlopen(request, timeout=PROBE_TIMEOUT_S) as response:
            if response.status != 200:
                return False
            raw = response.read(65536)
        payload = json.loads(raw.decode("utf-8", "replace"))
    except (urllib.error.URLError, OSError, http.client.HTTPException, ValueError):
        # Every failure shape means the same thing to the caller: no answer yet.
        # Logged at debug because a silent holder is the EXPECTED input here.
        logger.debug("Version probe of port %d did not answer", port, exc_info=True)
        return False
    return isinstance(payload, dict) and "app" in payload


# ---------------------------------------------------------------------------
# Connection-table reading
# ---------------------------------------------------------------------------


def _local_address(entry) -> tuple[str | None, int | None]:
    laddr = getattr(entry, "laddr", None)
    if laddr is None:
        return None, None
    ip = getattr(laddr, "ip", None)
    port = getattr(laddr, "port", None)
    if ip is None or port is None:
        try:
            ip, port = laddr[0], laddr[1]
        except (TypeError, IndexError, ValueError, KeyError):
            return None, None
    return ip, port


def _address_matches(host: str, listen_ip: str | None) -> bool:
    ip = (listen_ip or "").strip().lower()
    wanted = (host or "").strip().lower()
    if ip in _WILDCARD_ADDRS:
        return True
    if wanted in _LOOPBACK_ADDRS and ip in _LOOPBACK_ADDRS:
        return True
    return ip == wanted


def _basename(name: str | None) -> str | None:
    if not name:
        return None
    return os.path.basename(name.strip()).lower() or None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def inspect_port(
    host: str,
    port: int,
    *,
    probe=None,
    now=None,
    sleep=None,
    connections=None,
    process_name=None,
) -> PortVerdict:
    """Classify the port WITHOUT changing anything. Never kills, never binds."""
    probe = probe or _default_probe
    now = now or time.monotonic
    sleep = sleep or time.sleep
    connections = connections or _default_connections
    process_name = process_name or _default_process_name

    try:
        entries = list(connections())
    except (psutil.Error, OSError):
        logger.debug("Could not enumerate TCP connections", exc_info=True)
        return PortVerdict(
            "foreign", None, None,
            f"Port {port} could not be inspected (the connection table is unreadable), "
            f"so its holder could not be identified; refusing to touch it.",
        )

    holder = None
    for entry in entries:
        if str(getattr(entry, "status", "") or "").upper() != "LISTEN":
            continue
        listen_ip, listen_port = _local_address(entry)
        if listen_port != port or not _address_matches(host, listen_ip):
            continue
        holder = entry
        break

    if holder is None:
        return PortVerdict("free", None, None, f"Nothing is listening on port {port}.")

    pid = getattr(holder, "pid", None)
    name = None
    if pid is not None:
        try:
            name = _basename(process_name(pid))
        except (psutil.Error, OSError):
            logger.debug("Name lookup failed for PID %s", pid, exc_info=True)
            name = None

    if pid is None or name is None:
        # No pid (another user's process) or no readable name: we cannot prove
        # it is ours, and "cannot prove" is the same as "not ours" here.
        return PortVerdict(
            "foreign", pid, None,
            f"Port {port} is held by a process that could not be identified "
            f"(PID {pid}); refusing to touch it.",
        )

    if name not in SIDECAR_NAMES:
        return PortVerdict(
            "foreign", pid, name,
            f"Port {port} is held by {name} (PID {pid}), which is not a Plexar Studio sidecar.",
        )

    started = now()
    attempts = 0
    while True:
        attempts += 1
        if probe(port):
            return PortVerdict(
                "healthy", pid, name,
                f"{name} (PID {pid}) is serving port {port} and answered GET /api/version.",
            )
        if now() - started >= HUNG_AFTER_S:
            return PortVerdict(
                "hung", pid, name,
                f"{name} (PID {pid}) holds port {port} but did not answer GET /api/version "
                f"in {HUNG_AFTER_S:.0f}s ({attempts} probes).",
            )
        sleep(PROBE_INTERVAL_S)


def resolve_port(
    host: str,
    port: int,
    *,
    logger=None,
    process_factory=None,
    **inspect_kwargs,
) -> PortVerdict:
    """Inspect the port and clear it if a HUNG sidecar of ours is holding it.

    Returns the verdict the caller should act on: after a hung holder is
    terminated, that is the SECOND inspection (expected ``free``), never the
    stale one -- reporting "hung" after successfully clearing it would send the
    caller to the wrong branch.
    """
    log = logger or logging.getLogger("cockpit.server")
    process_factory = process_factory or psutil.Process

    verdict = inspect_port(host, port, **inspect_kwargs)

    if verdict.state == "free":
        return verdict

    if verdict.state == "healthy":
        log.info(
            "Plexar Studio already running on port %d (PID %s, %s); attaching to it",
            port, verdict.pid, verdict.name,
        )
        return verdict

    if verdict.state == "foreign":
        log.error(
            "Port %d is held by %s (PID %s), which is not a Plexar Studio sidecar; "
            "refusing to touch it",
            port, verdict.name, verdict.pid,
        )
        return verdict

    log.error(
        "Port %d is held by a hung Plexar Studio sidecar (PID %s, %s): %s",
        port, verdict.pid, verdict.name, verdict.detail,
    )

    # THE KILL GATE. inspect_port cannot produce `hung` for a name outside
    # SIDECAR_NAMES, so this can only fire if that function is broken -- which is
    # precisely when it matters. Written as a real branch rather than an
    # `assert` because assertions vanish under `python -O`, and a stripped guard
    # on a kill path is not a guard.
    if verdict.name not in SIDECAR_NAMES:
        log.error(
            "Refusing to terminate PID %s: %s is not a Plexar Studio sidecar",
            verdict.pid, verdict.name,
        )
        return verdict

    proc = None
    try:
        proc = process_factory(verdict.pid)
        proc.terminate()
        proc.wait(timeout=5)
        log.info("Terminated hung Plexar Studio sidecar %s (PID %s)", verdict.name, verdict.pid)
    except psutil.NoSuchProcess:
        log.info("Hung sidecar (PID %s) had already exited", verdict.pid)
    except psutil.TimeoutExpired:
        log.warning(
            "Hung sidecar (PID %s) ignored terminate(); killing it", verdict.pid,
        )
        try:
            proc.kill()
            proc.wait(timeout=5)
            log.info("Killed hung Plexar Studio sidecar %s (PID %s)", verdict.name, verdict.pid)
        except psutil.NoSuchProcess:
            log.info("Hung sidecar (PID %s) exited before kill()", verdict.pid)
        except (psutil.Error, OSError):
            log.error("Could not kill hung sidecar PID %s", verdict.pid, exc_info=True)
    except (psutil.Error, OSError):
        log.error("Could not terminate hung sidecar PID %s", verdict.pid, exc_info=True)

    final = inspect_port(host, port, **inspect_kwargs)
    log.info("Port %d after clearing the hung sidecar: %s", port, final.detail)
    return final
