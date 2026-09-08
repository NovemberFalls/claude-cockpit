"""Tests for web/instance_guard.py — the pre-bind decision about port 8420.

THE FAILURE THIS GUARDS (measured 2026-09-08): Tauri kills only the PyInstaller
bootloader, so the Python sidecar outlives the app and keeps the port. That is
wanted — the owner's sessions survive an app close. What was not wanted is the
relaunch: uvicorn could not bind, said "[Errno 10048]" to stderr alone, exited 1,
and after three retries the window attached to a process that might be hung.

The one rule with teeth is that a kill is only ever aimed at a known sidecar
name, so the negative arm here uses a REAL foreign process (a python child
holding an ephemeral port) and asserts it is still alive afterwards. Every
injected-fixture test has that real-process arm behind it; a fake process that
"was not killed" proves nothing about a code path that calls psutil.
"""

from __future__ import annotations

import http.server
import itertools
import json
import logging
import os
import socket
import subprocess
import sys
import threading
from collections import namedtuple

import psutil
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import instance_guard


Addr = namedtuple("Addr", "ip port")
Conn = namedtuple("Conn", "status laddr pid")

SIDECAR = "plexar-studio-server.exe"


def _listen_entry(port, *, ip="127.0.0.1", pid=4242, status="LISTEN"):
    return Conn(status, Addr(ip, port), pid)


def _no_factory(pid):
    raise AssertionError(
        f"process_factory must not be called (asked for PID {pid})"
    )


class FakeProc:
    """Records what resolve_port did to it, and can refuse to die."""

    def __init__(self, pid, *, terminate_times_out=False, missing=False):
        self.pid = pid
        self.calls = []
        self._terminate_times_out = terminate_times_out
        self._missing = missing

    def terminate(self):
        self.calls.append("terminate")
        if self._missing:
            raise psutil.NoSuchProcess(self.pid)

    def kill(self):
        self.calls.append("kill")

    def wait(self, timeout=None):
        self.calls.append(f"wait({timeout})")
        if self._terminate_times_out and self.calls.count("kill") == 0:
            raise psutil.TimeoutExpired(timeout or 0)
        return 0


@pytest.fixture()
def quiet_logger():
    """A logger whose records are collected instead of printed."""
    log = logging.getLogger("cockpit.test.instance_guard")
    log.handlers = []
    log.propagate = False
    log.setLevel(logging.DEBUG)
    records = []

    class Collect(logging.Handler):
        def emit(self, record):
            records.append(record)

    log.addHandler(Collect())
    log.records = records
    yield log
    log.handlers = []


# ---------------------------------------------------------------------------
# The pinned constants — server.py's wiring imports these names
# ---------------------------------------------------------------------------


def test_pinned_api_surface():
    assert instance_guard.ATTACH_EXIT_CODE == 3
    assert instance_guard.PROBE_TIMEOUT_S == 1.5
    assert instance_guard.HUNG_AFTER_S == 10.0
    assert instance_guard.SIDECAR_NAMES == {
        "plexar-studio-server.exe",
        "cockpit-server.exe",
        "cockpit-server-x86_64-pc-windows-msvc.exe",
        "claude-cockpit.exe",
    }
    verdict = instance_guard.PortVerdict("free", None, None, "detail")
    assert (verdict.state, verdict.pid, verdict.name, verdict.detail) == (
        "free", None, None, "detail",
    )


# ---------------------------------------------------------------------------
# free
# ---------------------------------------------------------------------------


def test_empty_connection_table_is_free():
    verdict = instance_guard.inspect_port(
        "127.0.0.1", 8420, connections=lambda: [],
        probe=lambda port: pytest.fail("must not probe a free port"),
    )
    assert verdict.state == "free"
    assert verdict.pid is None
    assert verdict.name is None
    assert "8420" in verdict.detail


def test_established_connection_on_the_port_is_not_a_holder():
    """Only a LISTEN entry holds a port. An outbound socket to :8420 does not."""
    verdict = instance_guard.inspect_port(
        "127.0.0.1", 8420,
        connections=lambda: [_listen_entry(8420, status="ESTABLISHED")],
    )
    assert verdict.state == "free"


def test_a_listener_on_another_port_is_ignored():
    verdict = instance_guard.inspect_port(
        "127.0.0.1", 8420, connections=lambda: [_listen_entry(8421)],
    )
    assert verdict.state == "free"


def test_resolve_port_returns_free_without_touching_anything(quiet_logger):
    verdict = instance_guard.resolve_port(
        "127.0.0.1", 8420, logger=quiet_logger, process_factory=_no_factory,
        connections=lambda: [],
    )
    assert verdict.state == "free"
    assert quiet_logger.records == []


# ---------------------------------------------------------------------------
# healthy
# ---------------------------------------------------------------------------


def test_answering_sidecar_is_healthy():
    verdict = instance_guard.inspect_port(
        "127.0.0.1", 8420,
        connections=lambda: [_listen_entry(8420)],
        process_name=lambda pid: SIDECAR,
        probe=lambda port: True,
    )
    assert verdict.state == "healthy"
    assert verdict.pid == 4242
    assert verdict.name == SIDECAR
    assert "/api/version" in verdict.detail


def test_resolve_port_attaches_to_a_healthy_holder_and_never_kills(quiet_logger):
    verdict = instance_guard.resolve_port(
        "127.0.0.1", 8420, logger=quiet_logger,
        process_factory=_no_factory,          # raises if resolve_port kills
        connections=lambda: [_listen_entry(8420)],
        process_name=lambda pid: SIDECAR,
        probe=lambda port: True,
    )
    assert verdict.state == "healthy"
    messages = [r.getMessage() for r in quiet_logger.records]
    assert any("attaching to it" in m for m in messages), messages
    assert all(r.levelno <= logging.INFO for r in quiet_logger.records)


@pytest.mark.parametrize("listen_ip", ["127.0.0.1", "0.0.0.0", "::", "::1", "localhost"])
def test_loopback_and_wildcard_spellings_all_match_the_bind_host(listen_ip):
    verdict = instance_guard.inspect_port(
        "127.0.0.1", 8420,
        connections=lambda: [_listen_entry(8420, ip=listen_ip)],
        process_name=lambda pid: SIDECAR,
        probe=lambda port: True,
    )
    assert verdict.state == "healthy"


# ---------------------------------------------------------------------------
# hung
# ---------------------------------------------------------------------------


def _counter_clock():
    """A monotonic clock that advances exactly 1.0s per reading."""
    return itertools.count(0.0, 1.0)


def test_silent_sidecar_is_hung_only_after_the_full_window():
    clock = _counter_clock()
    probes = []

    def probe(port):
        probes.append(port)
        return False

    verdict = instance_guard.inspect_port(
        "127.0.0.1", 8420,
        connections=lambda: [_listen_entry(8420)],
        process_name=lambda pid: SIDECAR,
        probe=probe,
        now=lambda: next(clock),
        sleep=lambda seconds: None,
    )
    assert verdict.state == "hung"
    assert verdict.pid == 4242
    assert verdict.name == SIDECAR
    # HUNG_AFTER_S / 1.0s per reading — a single failed probe must never be
    # enough, or a sidecar still unpacking itself would be killed mid-boot.
    assert len(probes) >= 10
    assert probes == [8420] * len(probes)


def test_a_slow_starter_that_answers_is_healthy_not_hung():
    """The one mistake worse than the bug: killing a sidecar that was booting."""
    clock = _counter_clock()
    answers = iter([False, False, True])

    verdict = instance_guard.inspect_port(
        "127.0.0.1", 8420,
        connections=lambda: [_listen_entry(8420)],
        process_name=lambda pid: SIDECAR,
        probe=lambda port: next(answers),
        now=lambda: next(clock),
        sleep=lambda seconds: None,
    )
    assert verdict.state == "healthy"


def test_resolve_port_terminates_a_hung_sidecar_and_returns_the_second_verdict(quiet_logger):
    fake = FakeProc(4242)
    clock = _counter_clock()
    seen = {"inspections": 0}

    def connections():
        seen["inspections"] += 1
        # The terminate() above cleared the port before the re-inspect.
        return [_listen_entry(8420)] if seen["inspections"] == 1 else []

    verdict = instance_guard.resolve_port(
        "127.0.0.1", 8420, logger=quiet_logger,
        process_factory=lambda pid: fake,
        connections=connections,
        process_name=lambda pid: SIDECAR,
        probe=lambda port: False,
        now=lambda: next(clock),
        sleep=lambda seconds: None,
    )

    assert fake.calls[0] == "terminate"
    assert any(call.startswith("wait(") for call in fake.calls)
    assert "kill" not in fake.calls
    assert seen["inspections"] == 2
    # The caller must be told the port is now free, NOT the stale "hung".
    assert verdict.state == "free"
    messages = [r.getMessage() for r in quiet_logger.records]
    assert any("hung" in m.lower() for m in messages), messages


def test_a_sidecar_that_ignores_terminate_is_killed(quiet_logger):
    fake = FakeProc(4242, terminate_times_out=True)
    clock = itertools.count(0.0, 1.0)
    seen = {"n": 0}

    def connections():
        seen["n"] += 1
        return [_listen_entry(8420)] if seen["n"] == 1 else []

    verdict = instance_guard.resolve_port(
        "127.0.0.1", 8420, logger=quiet_logger,
        process_factory=lambda pid: fake,
        connections=connections,
        process_name=lambda pid: SIDECAR,
        probe=lambda port: False,
        now=lambda: next(clock),
        sleep=lambda seconds: None,
    )
    assert "terminate" in fake.calls
    assert "kill" in fake.calls
    assert verdict.state == "free"


def test_a_sidecar_that_already_exited_is_not_an_error(quiet_logger):
    fake = FakeProc(4242, missing=True)
    clock = itertools.count(0.0, 1.0)
    seen = {"n": 0}

    def connections():
        seen["n"] += 1
        return [_listen_entry(8420)] if seen["n"] == 1 else []

    verdict = instance_guard.resolve_port(
        "127.0.0.1", 8420, logger=quiet_logger,
        process_factory=lambda pid: fake,
        connections=connections,
        process_name=lambda pid: SIDECAR,
        probe=lambda port: False,
        now=lambda: next(clock),
        sleep=lambda seconds: None,
    )
    assert fake.calls == ["terminate"]
    assert verdict.state == "free"
    assert any(
        "already exited" in r.getMessage() and r.levelno == logging.INFO
        for r in quiet_logger.records
    )


# ---------------------------------------------------------------------------
# foreign — the arm that must never kill
# ---------------------------------------------------------------------------


def test_a_foreign_name_is_never_probed_away(quiet_logger):
    """Even a process that answers /api/version is foreign if it is not ours."""
    verdict = instance_guard.inspect_port(
        "127.0.0.1", 8420,
        connections=lambda: [_listen_entry(8420)],
        process_name=lambda pid: "python.exe",
        probe=lambda port: True,
    )
    assert verdict.state == "foreign"
    assert verdict.name == "python.exe"

    resolved = instance_guard.resolve_port(
        "127.0.0.1", 8420, logger=quiet_logger,
        process_factory=_no_factory,
        connections=lambda: [_listen_entry(8420)],
        process_name=lambda pid: "python.exe",
        probe=lambda port: True,
    )
    assert resolved.state == "foreign"
    assert any(
        "refusing to touch it" in r.getMessage() and r.levelno == logging.ERROR
        for r in quiet_logger.records
    )


def test_unidentifiable_holder_is_foreign():
    """No pid (another user's process) means we cannot prove it is ours."""
    verdict = instance_guard.inspect_port(
        "127.0.0.1", 8420,
        connections=lambda: [_listen_entry(8420, pid=None)],
        process_name=lambda pid: SIDECAR,
    )
    assert verdict.state == "foreign"
    assert verdict.name is None
    assert "could not be identified" in verdict.detail


def test_unreadable_name_is_foreign():
    def denied(pid):
        raise psutil.AccessDenied(pid)

    verdict = instance_guard.inspect_port(
        "127.0.0.1", 8420,
        connections=lambda: [_listen_entry(8420)],
        process_name=denied,
    )
    assert verdict.state == "foreign"
    assert "could not be identified" in verdict.detail


def test_unreadable_connection_table_is_foreign_not_free():
    """Refusing to answer is not the same as answering "nothing is there"."""
    def denied():
        raise psutil.AccessDenied()

    verdict = instance_guard.inspect_port("127.0.0.1", 8420, connections=denied)
    assert verdict.state == "foreign"
    assert verdict.pid is None


def test_real_foreign_process_survives_resolve_port(quiet_logger):
    """THE NEGATIVE ARM, with a real process and the real psutil lookups.

    A python child binds an EPHEMERAL loopback port and just sits on it. It
    never answers HTTP, so the only thing standing between it and a kill is the
    SIDECAR_NAMES gate. No probe is injected: if the gate were removed the
    probe would fail, the verdict would be "hung", and this process would die.
    """
    child = subprocess.Popen(
        [sys.executable, "-c",
         "import socket,sys,time\n"
         "s=socket.socket()\n"
         "s.bind(('127.0.0.1',0))\n"
         "s.listen(5)\n"
         "print(s.getsockname()[1],flush=True)\n"
         "time.sleep(30)\n"],
        stdout=subprocess.PIPE, text=True,
    )
    try:
        port = int(child.stdout.readline().strip())
        verdict = instance_guard.resolve_port(
            "127.0.0.1", port, logger=quiet_logger, process_factory=_no_factory,
        )
        assert verdict.state == "foreign", verdict
        assert verdict.pid == child.pid
        assert verdict.name is not None and verdict.name not in instance_guard.SIDECAR_NAMES
        # The whole point: it is still running.
        assert child.poll() is None
    finally:
        child.kill()
        child.wait(timeout=10)


# ---------------------------------------------------------------------------
# The real probe (no injection)
# ---------------------------------------------------------------------------


class _VersionHandler(http.server.BaseHTTPRequestHandler):
    payload = {"app": "2.1.7", "cli": None}

    def do_GET(self):
        body = json.dumps(self.payload).encode()
        self.send_response(200 if self.path == "/api/version" else 404)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


@pytest.fixture()
def version_server():
    """A real HTTP server on an EPHEMERAL loopback port."""
    server = http.server.HTTPServer(("127.0.0.1", 0), _VersionHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_probe_accepts_a_real_version_response(version_server):
    assert instance_guard._default_probe(version_server.server_address[1]) is True


def test_probe_rejects_a_wrong_shaped_200(version_server, monkeypatch):
    """LM Studio taught this repo that a 200 is not a contract; same rule here."""
    monkeypatch.setattr(_VersionHandler, "payload", {"hello": "world"})
    assert instance_guard._default_probe(version_server.server_address[1]) is False


def test_probe_of_a_closed_port_is_false():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    assert instance_guard._default_probe(port) is False


def test_real_connection_table_finds_a_live_loopback_listener(version_server):
    """Exercises the psutil objects themselves, not just the namedtuple fakes."""
    port = version_server.server_address[1]
    verdict = instance_guard.inspect_port(
        "127.0.0.1", port, process_name=lambda pid: SIDECAR,
    )
    assert verdict.state == "healthy"
    assert verdict.pid == os.getpid()
