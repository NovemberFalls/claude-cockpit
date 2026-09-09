"""Tests for the Studio-managed Cloudflare connector (`remote_tunnel`).

No real cloudflared is ever launched. A tiny Python script stands in for it:
it prints two "Registered tunnel connection" lines PLUS the token it was
handed (a real connector can echo its arguments on a usage error, which is
exactly the case the scrubber exists for) and then sleeps or exits.

Token storage and the log file are redirected into tmp_path, so no test can
read or write the operator's real config.json or data directory.
"""

from __future__ import annotations

import json
import os
import sys
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import remote_tunnel  # noqa: E402
import settings_store  # noqa: E402

BASE = "http://127.0.0.1:8420"

FAKE_TOKEN = "fake-connector-token-abc123"

# Prints the token (so the scrubber has something to catch), two connection
# registrations, then either sleeps forever or exits with a code.
FAKE_CONNECTOR = """
import sys, time
token = sys.argv[1]
mode = sys.argv[2]
print("starting with token " + token, flush=True)
print("INF Registered tunnel connection connIndex=0", flush=True)
print("INF Registered tunnel connection connIndex=1", flush=True)
if mode == "crash":
    sys.exit(7)
time.sleep(30)
"""


@pytest.fixture
def fake_binary(tmp_path):
    path = tmp_path / "fake_connector.py"
    path.write_text(FAKE_CONNECTOR, encoding="utf-8")
    return path


@pytest.fixture
def tunnel_env(tmp_path, monkeypatch, fake_binary):
    """A manager wired to the fake connector, with isolated token + log storage."""
    config_file = tmp_path / "config.json"
    log_file = tmp_path / "logs" / "cloudflared.log"
    monkeypatch.setattr(settings_store, "CONFIG_FILE", config_file)
    monkeypatch.setattr(remote_tunnel, "_log_path", lambda: log_file)
    monkeypatch.setattr(remote_tunnel, "_resolve_binary", lambda: sys.executable)
    monkeypatch.setattr(
        remote_tunnel,
        "_tunnel_settings",
        lambda: {"enabled": True, "autostart": True, "cloudflared_path": ""},
    )
    monkeypatch.setattr(remote_tunnel, "_foreign_running", lambda pid: False)

    mode = {"value": "run"}

    def build(binary, token):
        return [binary, str(fake_binary), token, mode["value"]]

    monkeypatch.setattr(remote_tunnel, "_build_argv", build)

    manager = remote_tunnel.TunnelManager()
    yield manager, mode, log_file
    manager.stop()


def _wait_for(predicate, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


# ---------------------------------------------------------------------------
# Manager
# ---------------------------------------------------------------------------


def test_start_reports_running_with_two_connections_then_stops(tunnel_env):
    manager, _mode, _log = tunnel_env
    remote_tunnel.set_token(FAKE_TOKEN)

    manager.start()
    assert _wait_for(lambda: manager.status()["connections"] == 2)

    status = manager.status()
    assert status["state"] == "running"
    assert status["pid"] is not None
    assert status["started_at"]
    assert status["token_set"] is True
    assert status["installed"] is True

    stopped = manager.stop()
    assert stopped["state"] == "stopped"
    assert stopped["pid"] is None


def test_crash_restarts_with_backoff(tunnel_env, monkeypatch):
    manager, mode, _log = tunnel_env
    remote_tunnel.set_token(FAKE_TOKEN)
    mode["value"] = "crash"

    slept: list[float] = []
    monkeypatch.setattr(remote_tunnel, "_sleep", lambda s: slept.append(s))

    manager.start()
    assert _wait_for(lambda: manager.status()["restarts"] >= 3)
    manager.stop()

    # 1, 2, 4, ... — doubling, capped. The first attempt never sleeps.
    assert slept[:3] == [1.0, 2.0, 4.0]
    assert all(s <= remote_tunnel._BACKOFF_CAP for s in slept)
    assert manager.status()["last_error"]


def test_token_never_appears_in_log_tail_or_log_file(tunnel_env):
    manager, _mode, log_file = tunnel_env
    remote_tunnel.set_token(FAKE_TOKEN)

    manager.start()
    assert _wait_for(lambda: manager.status()["connections"] == 2)
    tail = manager.status()["log_tail"]
    manager.stop()

    assert any("starting with token" in line for line in tail)
    assert all(FAKE_TOKEN not in line for line in tail)
    assert any("***" in line for line in tail)
    assert log_file.exists()
    assert FAKE_TOKEN not in log_file.read_text(encoding="utf-8")


def test_clear_token_stops_a_running_connector(tunnel_env):
    manager, _mode, _log = tunnel_env
    remote_tunnel.set_token(FAKE_TOKEN)
    manager.start()
    assert _wait_for(lambda: manager.status()["state"] == "running")

    assert manager.clear_token() is True
    status = manager.status()
    assert status["state"] == "stopped"
    assert status["token_set"] is False


def test_supervisor_stops_itself_when_there_is_no_token(tunnel_env):
    manager, _mode, _log = tunnel_env
    manager.start()
    assert _wait_for(lambda: manager.status()["state"] == "crashed")
    assert manager.status()["last_error"] == "no token"


def test_reconcile_starts_immediately_when_enabled_autostart_and_token_set(tunnel_env):
    """'Run when Studio starts' must also mean 'run right now'."""
    manager, _mode, _log = tunnel_env
    remote_tunnel.set_token(FAKE_TOKEN)
    assert manager.status()["state"] == "stopped"

    manager.reconcile()
    assert _wait_for(lambda: manager.status()["state"] == "running")
    manager.stop()


def test_reconcile_stops_a_running_tunnel_when_disabled(tunnel_env, monkeypatch):
    manager, _mode, _log = tunnel_env
    remote_tunnel.set_token(FAKE_TOKEN)
    manager.start()
    assert _wait_for(lambda: manager.status()["state"] == "running")

    monkeypatch.setattr(
        remote_tunnel,
        "_tunnel_settings",
        lambda: {"enabled": False, "autostart": True, "cloudflared_path": ""},
    )
    manager.reconcile()
    assert manager.status()["state"] == "stopped"


def test_reconcile_is_a_noop_without_a_token(tunnel_env):
    manager, _mode, _log = tunnel_env
    manager.reconcile()
    assert manager.status()["state"] == "stopped"


def test_token_is_stored_in_config_json_not_settings_json(tunnel_env, tmp_path):
    remote_tunnel.set_token(FAKE_TOKEN)
    data = json.loads((tmp_path / "config.json").read_text(encoding="utf-8"))
    assert data["cloudflare_tunnel_token"] == FAKE_TOKEN
    assert "cloudflare_tunnel_token" not in json.dumps(settings_store.DEFAULT_SETTINGS)


# ---------------------------------------------------------------------------
# Settings keys
# ---------------------------------------------------------------------------


def test_default_settings_carry_the_tunnel_block():
    tunnel = settings_store.DEFAULT_SETTINGS["remote"]["tunnel"]
    assert tunnel == {"enabled": False, "autostart": True, "cloudflared_path": ""}


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@pytest.fixture
def client(tmp_path, monkeypatch):
    """The tunnel router alone, with a manager that never spawns anything."""
    monkeypatch.setattr(settings_store, "CONFIG_FILE", tmp_path / "config.json")
    monkeypatch.setattr(remote_tunnel, "_log_path", lambda: tmp_path / "logs" / "c.log")
    monkeypatch.setattr(
        remote_tunnel,
        "_tunnel_settings",
        lambda: {"enabled": True, "autostart": True, "cloudflared_path": ""},
    )
    monkeypatch.setattr(remote_tunnel, "_foreign_running", lambda pid: False)

    calls = {"start": 0, "stop": 0}

    def fake_start(self):
        calls["start"] += 1
        return self.status()

    def fake_stop(self):
        calls["stop"] += 1
        return self.status()

    monkeypatch.setattr(remote_tunnel.TunnelManager, "start", fake_start)
    monkeypatch.setattr(remote_tunnel.TunnelManager, "stop", fake_stop)
    monkeypatch.setattr(remote_tunnel, "manager", remote_tunnel.TunnelManager())

    app = FastAPI()
    app.include_router(remote_tunnel.router)
    with TestClient(app, base_url=BASE) as c:
        yield c, calls


def test_start_without_a_token_is_409(client):
    c, calls = client
    monkeypatched = c.post("/api/remote/tunnel/start")
    assert monkeypatched.status_code == 409
    assert monkeypatched.json() == {"error": "no token"}
    assert calls["start"] == 0


def test_start_without_the_binary_is_409(client, monkeypatch):
    c, _calls = client
    remote_tunnel.set_token(FAKE_TOKEN)
    monkeypatch.setattr(remote_tunnel, "_resolve_binary", lambda: None)
    res = c.post("/api/remote/tunnel/start")
    assert res.status_code == 409
    assert res.json() == {"error": "cloudflared not installed"}


def test_put_token_is_204_and_the_token_is_never_echoed(client, monkeypatch):
    c, _calls = client
    monkeypatch.setattr(remote_tunnel, "_resolve_binary", lambda: "cloudflared")

    res = c.put("/api/remote/tunnel/token", json={"token": FAKE_TOKEN})
    assert res.status_code == 204
    assert res.content == b""

    status = c.get("/api/remote/tunnel")
    assert status.status_code == 200
    body = status.json()
    assert body["token_set"] is True
    assert FAKE_TOKEN not in json.dumps(body)

    log = c.get("/api/remote/tunnel/log")
    assert FAKE_TOKEN not in json.dumps(log.json())


def test_put_token_reconciles_and_starts_when_enabled_and_autostart(client, monkeypatch):
    c, calls = client
    monkeypatch.setattr(remote_tunnel, "_resolve_binary", lambda: "cloudflared")

    res = c.put("/api/remote/tunnel/token", json={"token": FAKE_TOKEN})
    assert res.status_code == 204
    assert calls["start"] == 1


def test_put_empty_token_is_400(client):
    c, _calls = client
    assert c.put("/api/remote/tunnel/token", json={"token": "   "}).status_code == 400
    assert c.put("/api/remote/tunnel/token", json={}).status_code == 400


def test_delete_token_is_204_and_stops_the_tunnel(client):
    c, calls = client
    c.put("/api/remote/tunnel/token", json={"token": FAKE_TOKEN})
    remote_tunnel.manager._desired = "running"

    res = c.delete("/api/remote/tunnel/token")
    assert res.status_code == 204
    assert remote_tunnel.get_token() is None
    assert calls["stop"] == 1


def test_stop_route_returns_status(client):
    c, calls = client
    res = c.post("/api/remote/tunnel/stop")
    assert res.status_code == 200
    assert res.json()["state"] == "stopped"
    assert calls["stop"] == 1


def test_status_shape(client, monkeypatch):
    c, _calls = client
    monkeypatch.setattr(remote_tunnel, "_resolve_binary", lambda: "cloudflared")
    body = c.get("/api/remote/tunnel").json()
    assert set(body) == {
        "installed", "binary", "token_set", "enabled", "autostart", "state",
        "pid", "started_at", "restarts", "connections", "last_error",
        "foreign_running", "log_tail",
    }


# ---------------------------------------------------------------------------
# Ownership record + orphan sweep
#
# NO REAL cloudflared IS EVER SPAWNED OR KILLED HERE. The "connector" is a
# python child this test started, and `CONNECTOR_NAMES` is widened to the python
# basename for the one test that terminates. R-185: identity is proven before
# anything is terminated, and these tests exist to pin the negative half.
# ---------------------------------------------------------------------------


@pytest.fixture
def record_env(tmp_path, monkeypatch):
    """Redirect the ownership record into tmp_path."""
    path = tmp_path / "connector-owner.json"
    monkeypatch.setattr(remote_tunnel, "_owner_record_path", lambda: path)
    return path


def _spawn_sleeper():
    """A python child that sleeps. Stands in for a connector process."""
    import subprocess

    return subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(30)"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _dead_pid():
    """A pid that is definitively not a live Studio sidecar."""
    import subprocess

    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()
    return proc.pid


def test_no_record_is_a_no_op(record_env):
    assert remote_tunnel.sweep_orphan() == {"verdict": "no_record"}


def test_spawning_writes_a_record_and_the_token_is_not_in_it(
    tunnel_env, record_env, monkeypatch
):
    manager, _mode, _log = tunnel_env
    remote_tunnel.set_token(FAKE_TOKEN)
    manager.start()
    for _ in range(50):
        if remote_tunnel.read_owner_record() is not None:
            break
        time.sleep(0.05)
    record = remote_tunnel.read_owner_record()
    assert record is not None
    assert record["connector_pid"] == manager.status()["pid"]
    assert record["owner_pid"] == os.getpid()
    assert FAKE_TOKEN not in record_env.read_text(encoding="utf-8")


def test_stop_clears_the_record(tunnel_env, record_env):
    manager, _mode, _log = tunnel_env
    remote_tunnel.set_token(FAKE_TOKEN)
    manager.start()
    for _ in range(50):
        if remote_tunnel.read_owner_record() is not None:
            break
        time.sleep(0.05)
    manager.stop()
    assert remote_tunnel.read_owner_record() is None


def test_a_live_owning_studio_is_left_alone(record_env):
    """Our own pid owns it, so the connector belongs to a running Studio."""
    remote_tunnel.write_owner_record(999999, ["cloudflared", "tunnel", "run"])
    assert remote_tunnel.sweep_orphan()["verdict"] == "owner_alive"
    assert remote_tunnel.read_owner_record() is not None


def test_a_vanished_connector_is_just_forgotten(record_env, monkeypatch):
    pid = _dead_pid()
    remote_tunnel.write_owner_record(pid, ["cloudflared", "tunnel", "run"])
    monkeypatch.setattr(remote_tunnel, "_owning_studio_is_live", lambda rec: False)
    verdict = remote_tunnel.sweep_orphan()
    assert verdict["verdict"] in ("gone", "not_ours")
    assert remote_tunnel.read_owner_record() is None


def test_a_recorded_pid_with_a_different_command_line_is_NEVER_touched(
    record_env, monkeypatch
):
    """R-185, pinned. Another product's connector must survive our sweep."""
    proc = _spawn_sleeper()
    try:
        # Recorded as ours, but the fingerprint is of a DIFFERENT command line.
        remote_tunnel.write_owner_record(proc.pid, ["cloudflared", "tunnel", "run", "x"])
        monkeypatch.setattr(remote_tunnel, "_owning_studio_is_live", lambda rec: False)
        # Widen the name gate so the ONLY thing that can save this process is
        # the command-line check — otherwise the test would pass for the wrong
        # reason (the name check refusing a python exe).
        monkeypatch.setattr(
            remote_tunnel, "CONNECTOR_NAMES",
            {os.path.basename(sys.executable).lower()},
        )
        verdict = remote_tunnel.sweep_orphan()
        assert verdict["verdict"] == "not_ours"
        assert verdict["reason"] == "cmdline"
        assert proc.poll() is None, "a non-matching process was terminated"
    finally:
        proc.kill()
        proc.wait(timeout=10)


def test_a_cloudflared_by_name_only_is_never_touched(record_env, monkeypatch):
    """Name matching is necessary, never sufficient — and here it fails first."""
    proc = _spawn_sleeper()
    try:
        remote_tunnel.write_owner_record(proc.pid, ["cloudflared", "tunnel", "run"])
        monkeypatch.setattr(remote_tunnel, "_owning_studio_is_live", lambda rec: False)
        verdict = remote_tunnel.sweep_orphan()
        assert verdict["verdict"] == "not_ours"
        assert verdict["reason"] == "name"
        assert proc.poll() is None
    finally:
        proc.kill()
        proc.wait(timeout=10)


def test_a_proven_orphan_is_terminated(record_env, monkeypatch):
    import psutil

    proc = _spawn_sleeper()
    try:
        cmdline = psutil.Process(proc.pid).cmdline()
        remote_tunnel.write_owner_record(proc.pid, cmdline)
        monkeypatch.setattr(remote_tunnel, "_owning_studio_is_live", lambda rec: False)
        monkeypatch.setattr(
            remote_tunnel, "CONNECTOR_NAMES",
            {os.path.basename(sys.executable).lower()},
        )
        verdict = remote_tunnel.sweep_orphan()
        assert verdict == {"verdict": "terminated", "pid": proc.pid}
        proc.wait(timeout=10)
        assert proc.poll() is not None
        assert remote_tunnel.read_owner_record() is None
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=10)


def test_the_sweep_never_raises(record_env, monkeypatch):
    remote_tunnel.write_owner_record(1234, ["cloudflared"])
    monkeypatch.setattr(
        remote_tunnel, "_owning_studio_is_live",
        lambda rec: (_ for _ in ()).throw(RuntimeError("boom")),
    )
    assert remote_tunnel.sweep_orphan() == {"verdict": "error"}
