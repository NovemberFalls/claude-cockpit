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
