"""Tests for the Studio Remote gateway routers.

The app here includes BOTH routers and nothing else -- no origin guard, no
server.py. That is the point: the gateway is wired through ``configure()`` with
fake callables, so its contract is exercised without the application it will
eventually live inside.
"""

from __future__ import annotations

import json
import os
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import remote_gateway  # noqa: E402
from remote_devices import DeviceStore  # noqa: E402
from remote_gateway import PROTOCOL_VERSION, RemoteBackend  # noqa: E402

BASE = "http://127.0.0.1:8420"

FULL_SESSION = {
    "id": "t1",
    "name": "work",
    "harness": "claude-code",
    "model": "claude-opus-5",
    "working_dir": "C:/tmp",
    "alive": True,
    "activity_state": "idle",
    "created_at": "2026-09-08T00:00:00+00:00",
    # Fields that must NEVER reach a phone:
    "jsonl_path": "C:/secret.jsonl",
    "cost": 1.23,
    "tokens": 4567,
    "claude_session_id": "abc-def",
}


class Backend:
    """A recording fake of everything the gateway is allowed to reach."""

    def __init__(self):
        self.settings_dict = {"remote": {"enabled": True, "hostname": ""}}
        self.sessions = [dict(FULL_SESSION)]
        self.submitted = []
        self.raw = []
        self.interrupts = []
        self.created = []
        self.create_error = None

    def as_remote_backend(self) -> RemoteBackend:
        return RemoteBackend(
            settings=lambda: self.settings_dict,
            app_version=lambda: "2.1.7",
            list_sessions=lambda: self.sessions,
            get_session=self._get_session,
            create_session=self._create,
            submit=self._submit,
            write_raw=self._write_raw,
            interrupt=self._interrupt,
        )

    def _get_session(self, terminal_id):
        return next((s for s in self.sessions if s["id"] == terminal_id), None)

    async def _create(self, body):
        if self.create_error:
            raise ValueError(self.create_error)
        self.created.append(body)
        made = dict(FULL_SESSION)
        made["id"] = "t2"
        made["name"] = body.get("name") or "new"
        self.sessions.append(made)
        return made

    async def _submit(self, terminal_id, text):
        self.submitted.append((terminal_id, text))
        return True

    async def _write_raw(self, terminal_id, data):
        self.raw.append((terminal_id, data))
        return True

    async def _interrupt(self, terminal_id):
        self.interrupts.append(terminal_id)
        return True


@pytest.fixture
def rig(tmp_path):
    backend = Backend()
    store = DeviceStore(tmp_path / "remote_devices.json")
    remote_gateway.configure(backend.as_remote_backend(), store)
    app = FastAPI()
    app.include_router(remote_gateway.admin_router)
    app.include_router(remote_gateway.router)
    with TestClient(app, base_url=BASE) as client:
        yield backend, store, client


def pair(client, store, name="Pixel"):
    code = store.create_pairing()["code"]
    resp = client.post("/remote/v1/pair", json={"code": code, "device_name": name})
    assert resp.status_code == 200, resp.text
    return resp.json()


def auth(token):
    return {"Authorization": f"Bearer {token}"}


# -- pairing ---------------------------------------------------------------


def test_pairing_round_trip_over_http(rig):
    _backend, store, client = rig
    body = pair(client, store)
    assert body["protocol"] == PROTOCOL_VERSION
    assert body["app_version"] == "2.1.7"
    assert body["device_id"].startswith("dv_")
    assert store.authenticate(body["token"]) is not None


def test_bad_code_is_400_with_the_one_message(rig):
    _backend, _store, client = rig
    resp = client.post("/remote/v1/pair", json={"code": "ZZZZ-ZZZZ", "device_name": "P"})
    assert resp.status_code == 400
    assert resp.json() == {"error": "invalid or expired code"}


# -- admin routes ----------------------------------------------------------


def test_admin_pairings_payload_shape(rig):
    backend, _store, client = rig
    backend.settings_dict["remote"]["hostname"] = "https://studio.example.com/"
    resp = client.post("/api/remote/pairings")
    assert resp.status_code == 200
    body = resp.json()
    assert body["url"] == "https://studio.example.com"
    assert json.loads(body["qr_payload"]) == {
        "v": 1,
        "url": "https://studio.example.com",
        "code": body["code"],
    }
    assert body["expires_at"] > 0


def test_admin_pairings_falls_back_to_a_lan_url(rig, monkeypatch):
    _backend, _store, client = rig
    monkeypatch.setenv("PORT", "8420")
    body = client.post("/api/remote/pairings").json()
    assert body["url"].startswith("http://")
    assert body["url"].endswith(":8420")


def test_admin_pairings_409_when_disabled(rig):
    backend, _store, client = rig
    backend.settings_dict["remote"]["enabled"] = False
    resp = client.post("/api/remote/pairings")
    assert resp.status_code == 409
    assert resp.json() == {"error": "remote disabled"}


def test_admin_status(rig):
    _backend, store, client = rig
    pair(client, store, "Pixel")
    body = client.get("/api/remote/status").json()
    assert body["enabled"] is True
    assert body["protocol"] == PROTOCOL_VERSION
    assert body["hostname"] == ""
    assert len(body["devices"]) == 1
    assert set(body["devices"][0]) == {
        "id",
        "name",
        "created_at",
        "last_seen",
        "revoked_at",
    }


def test_admin_revoke_then_401(rig):
    _backend, store, client = rig
    paired = pair(client, store)
    resp = client.delete(f"/api/remote/devices/{paired['device_id']}")
    assert resp.status_code == 200 and resp.json() == {"revoked": True}
    assert client.get("/remote/v1/hello", headers=auth(paired["token"])).status_code == 401
    assert client.delete("/api/remote/devices/dv_nope").status_code == 404


# -- the remote gate -------------------------------------------------------


def test_disabled_404s_every_remote_route_including_pair(rig):
    backend, store, client = rig
    paired = pair(client, store)
    backend.settings_dict["remote"]["enabled"] = False
    headers = auth(paired["token"])
    checks = [
        client.post("/remote/v1/pair", json={"code": "A", "device_name": "P"}),
        client.get("/remote/v1/hello", headers=headers),
        client.get("/remote/v1/sessions", headers=headers),
        client.post("/remote/v1/sessions", json={}, headers=headers),
        client.post("/remote/v1/sessions/t1/input", json={"text": "hi"}, headers=headers),
        client.post("/remote/v1/sessions/t1/interrupt", headers=headers),
    ]
    for resp in checks:
        assert resp.status_code == 404, resp.request.url


def test_missing_and_bad_tokens_are_401(rig):
    _backend, _store, client = rig
    assert client.get("/remote/v1/hello").status_code == 401
    assert client.get("/remote/v1/hello", headers=auth("nope")).status_code == 401
    assert client.get(
        "/remote/v1/hello", headers={"Authorization": "Basic xyz"}
    ).status_code == 401


def test_disabled_wins_over_a_bad_token(rig):
    backend, _store, client = rig
    backend.settings_dict["remote"]["enabled"] = False
    assert client.get("/remote/v1/hello", headers=auth("nope")).status_code == 404


def test_authenticate_websocket_mirrors_the_rules(rig):
    backend, store, client = rig
    paired = pair(client, store)

    class FakeWs:
        def __init__(self, headers):
            self.headers = headers

    good = FakeWs({"authorization": f"Bearer {paired['token']}"})
    assert remote_gateway.authenticate_websocket(good).id == paired["device_id"]
    assert remote_gateway.authenticate_websocket(FakeWs({})) is None
    backend.settings_dict["remote"]["enabled"] = False
    assert remote_gateway.authenticate_websocket(good) is None
    assert remote_gateway.remote_enabled() is False


# -- sessions --------------------------------------------------------------


def test_sessions_list_carries_only_the_eight_fields(rig):
    _backend, store, client = rig
    paired = pair(client, store)
    body = client.get("/remote/v1/sessions", headers=auth(paired["token"])).json()
    assert list(body["sessions"][0]) == list(remote_gateway.SESSION_FIELDS)
    assert len(remote_gateway.SESSION_FIELDS) == 8


def test_hello(rig):
    _backend, store, client = rig
    paired = pair(client, store, "Pixel")
    body = client.get("/remote/v1/hello", headers=auth(paired["token"])).json()
    assert body == {
        "protocol": PROTOCOL_VERSION,
        "app_version": "2.1.7",
        "device": {"id": paired["device_id"], "name": "Pixel"},
        "session_count": 1,
    }


def test_create_session(rig):
    backend, store, client = rig
    paired = pair(client, store)
    resp = client.post(
        "/remote/v1/sessions",
        json={"name": "phone", "workdir": "C:/x", "harness": "codex", "model": "gpt-5.5"},
        headers=auth(paired["token"]),
    )
    assert resp.status_code == 201
    assert list(resp.json()["session"]) == list(remote_gateway.SESSION_FIELDS)
    assert backend.created == [
        {"name": "phone", "workdir": "C:/x", "harness": "codex", "model": "gpt-5.5"}
    ]


def test_create_session_surfaces_valueerror_as_400(rig):
    backend, store, client = rig
    paired = pair(client, store)
    backend.create_error = "unsupported harness"
    resp = client.post("/remote/v1/sessions", json={}, headers=auth(paired["token"]))
    assert resp.status_code == 400
    assert resp.json() == {"error": "unsupported harness"}


# -- input -----------------------------------------------------------------


def test_input_submit_vs_raw_routing(rig):
    backend, store, client = rig
    paired = pair(client, store)
    headers = auth(paired["token"])
    client.post("/remote/v1/sessions/t1/input", json={"text": "hello"}, headers=headers)
    client.post(
        "/remote/v1/sessions/t1/input",
        json={"text": "\x03", "submit": False},
        headers=headers,
    )
    assert backend.submitted == [("t1", "hello")]
    assert backend.raw == [("t1", "\x03")]


def test_input_is_idempotent_per_request_id(rig):
    backend, store, client = rig
    paired = pair(client, store)
    headers = auth(paired["token"])
    payload = {"text": "once", "request_id": "req-1"}
    first = client.post("/remote/v1/sessions/t1/input", json=payload, headers=headers)
    second = client.post("/remote/v1/sessions/t1/input", json=payload, headers=headers)
    assert first.json() == {"accepted": True, "duplicate": False}
    assert second.json() == {"accepted": True, "duplicate": True}
    assert backend.submitted == [("t1", "once")]


def test_without_a_request_id_every_call_writes(rig):
    backend, store, client = rig
    paired = pair(client, store)
    headers = auth(paired["token"])
    for _ in range(3):
        client.post("/remote/v1/sessions/t1/input", json={"text": "x"}, headers=headers)
    assert backend.submitted == [("t1", "x")] * 3


def test_idempotency_is_scoped_per_device(rig):
    backend, store, client = rig
    one = pair(client, store, "One")
    two = pair(client, store, "Two")
    payload = {"text": "x", "request_id": "shared"}
    client.post("/remote/v1/sessions/t1/input", json=payload, headers=auth(one["token"]))
    resp = client.post(
        "/remote/v1/sessions/t1/input", json=payload, headers=auth(two["token"])
    )
    assert resp.json()["duplicate"] is False
    assert len(backend.submitted) == 2


def test_input_and_interrupt_404_on_unknown_session(rig):
    _backend, store, client = rig
    headers = auth(pair(client, store)["token"])
    assert (
        client.post("/remote/v1/sessions/nope/input", json={"text": "x"}, headers=headers).status_code
        == 404
    )
    assert client.post("/remote/v1/sessions/nope/interrupt", headers=headers).status_code == 404


def test_interrupt(rig):
    backend, store, client = rig
    headers = auth(pair(client, store)["token"])
    resp = client.post("/remote/v1/sessions/t1/interrupt", headers=headers)
    assert resp.status_code == 200 and resp.json() == {"accepted": True}
    assert backend.interrupts == ["t1"]


# -- registry --------------------------------------------------------------


# -- access_required in qr_payload ------------------------------------------


def test_qr_payload_carries_access_only_when_required(rig):
    backend, _store, client = rig
    resp = client.post("/api/remote/pairings")
    assert "access" not in json.loads(resp.json()["qr_payload"])

    backend.settings_dict["remote"]["access_required"] = True
    resp = client.post("/api/remote/pairings")
    assert json.loads(resp.json()["qr_payload"])["access"] is True


# -- cloudflared config -------------------------------------------------------


def test_cloudflared_config_shape(rig, monkeypatch):
    monkeypatch.setenv("PORT", "8420")
    _backend, _store, client = rig
    resp = client.get("/api/remote/cloudflared-config", params={"hostname": "studio.example.com"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["hostname"] == "studio.example.com"
    assert body["config_yml"] == (
        "tunnel: <tunnel-id>\n"
        "credentials-file: %USERPROFILE%\\.cloudflared\\<tunnel-id>.json\n"
        "\n"
        "ingress:\n"
        "  - hostname: studio.example.com\n"
        "    path: ^/remote/v1/\n"
        "    service: http://127.0.0.1:8420\n"
        "\n"
        "  - service: http_status:404\n"
    )
    assert body["commands"] == [
        "cloudflared tunnel login",
        "cloudflared tunnel create plexar-studio",
        "cloudflared tunnel route dns plexar-studio studio.example.com",
        "Write the config above to %USERPROFILE%\\.cloudflared\\config.yml",
        "cloudflared service install",
    ]


@pytest.mark.parametrize(
    "hostname",
    ["", "a", "ab", "bad host.com", "-lead.com", "https://", "https://bad host.com/"],
)
def test_cloudflared_config_rejects_bad_hostnames(rig, hostname):
    _backend, _store, client = rig
    resp = client.get("/api/remote/cloudflared-config", params={"hostname": hostname})
    assert resp.status_code == 400
    assert "error" in resp.json()


@pytest.mark.parametrize(
    "given",
    ["UPPER.example.com", "https://studio.example.com", "https://Studio.Example.com/remote/v1/", "studio.example.com:8443"],
)
def test_cloudflared_config_accepts_the_public_url_as_entered(rig, given):
    # The Public URL field holds a URL; the tools reduce it to the hostname
    # rather than telling a correctly configured desktop "invalid hostname".
    _backend, _store, client = rig
    resp = client.get("/api/remote/cloudflared-config", params={"hostname": given})
    assert resp.status_code == 200
    assert resp.json()["hostname"] in {"upper.example.com", "studio.example.com"}
    assert "hostname: studio.example.com" in resp.json()["config_yml"] or "hostname: upper.example.com" in resp.json()["config_yml"]


def test_cloudflared_config_accepts_long_and_short_valid_hostnames(rig):
    _backend, _store, client = rig
    assert client.get("/api/remote/cloudflared-config", params={"hostname": "a.co"}).status_code == 200


# -- cloudflared status --------------------------------------------------------


def test_cloudflared_status_installed_and_running(rig, monkeypatch):
    _backend, _store, client = rig
    monkeypatch.setattr(remote_gateway.shutil, "which", lambda name: r"C:\tools\cloudflared.exe")

    class FakeProc:
        info = {"name": "cloudflared.exe"}

    monkeypatch.setitem(
        sys.modules, "psutil", type("M", (), {"process_iter": staticmethod(lambda attrs: [FakeProc()])})
    )
    resp = client.get("/api/remote/cloudflared")
    assert resp.status_code == 200
    body = resp.json()
    assert body == {
        "installed": True,
        "path": r"C:\tools\cloudflared.exe",
        "version": None,
        "running": True,
    }


def test_cloudflared_status_not_installed_not_running(rig, monkeypatch):
    _backend, _store, client = rig
    monkeypatch.setattr(remote_gateway.shutil, "which", lambda name: None)
    monkeypatch.setattr(remote_gateway.os.path, "isfile", lambda p: False)
    monkeypatch.setitem(
        sys.modules, "psutil", type("M", (), {"process_iter": staticmethod(lambda attrs: [])})
    )
    resp = client.get("/api/remote/cloudflared")
    assert resp.status_code == 200
    body = resp.json()
    assert body["installed"] is False
    assert body["path"] is None
    assert body["running"] is False


# -- probe classification ------------------------------------------------------


def test_probe_rejects_bad_hostname(rig):
    _backend, _store, client = rig
    resp = client.post("/api/remote/probe", json={"hostname": "not a host"})
    assert resp.status_code == 400


def test_probe_classifies_access_via_redirect(rig, monkeypatch):
    _backend, _store, client = rig
    monkeypatch.setattr(
        remote_gateway,
        "_fetch_probe",
        lambda hostname: (302, {"Location": "https://plexar.cloudflareaccess.com/login"}, ""),
    )
    resp = client.post("/api/remote/probe", json={"hostname": "studio.example.com"})
    assert resp.json()["classification"] == "access"


def test_probe_classifies_access_via_html_body(rig, monkeypatch):
    _backend, _store, client = rig
    monkeypatch.setattr(
        remote_gateway,
        "_fetch_probe",
        lambda hostname: (200, {"Content-Type": "text/html"}, "<!doctype html><html></html>"),
    )
    resp = client.post("/api/remote/probe", json={"hostname": "studio.example.com"})
    assert resp.json()["classification"] == "access"


def test_probe_classifies_guarded(rig, monkeypatch):
    _backend, _store, client = rig
    monkeypatch.setattr(
        remote_gateway,
        "_fetch_probe",
        lambda hostname: (401, {"Content-Type": "application/json"}, json.dumps({"detail": "unauthorized"})),
    )
    resp = client.post("/api/remote/probe", json={"hostname": "studio.example.com"})
    assert resp.json()["classification"] == "guarded"


def test_probe_classifies_disabled(rig, monkeypatch):
    _backend, _store, client = rig
    monkeypatch.setattr(
        remote_gateway,
        "_fetch_probe",
        lambda hostname: (404, {"Content-Type": "application/json"}, json.dumps({"error": "remote disabled"})),
    )
    resp = client.post("/api/remote/probe", json={"hostname": "studio.example.com"})
    assert resp.json()["classification"] == "disabled"


def test_probe_classifies_unreachable(rig, monkeypatch):
    _backend, _store, client = rig
    monkeypatch.setattr(remote_gateway, "_fetch_probe", lambda hostname: (None, {}, ""))
    resp = client.post("/api/remote/probe", json={"hostname": "studio.example.com"})
    assert resp.json()["classification"] == "unreachable"


def test_probe_classifies_unexpected(rig, monkeypatch):
    _backend, _store, client = rig
    monkeypatch.setattr(remote_gateway, "_fetch_probe", lambda hostname: (500, {}, "server error"))
    resp = client.post("/api/remote/probe", json={"hostname": "studio.example.com"})
    body = resp.json()
    assert body["classification"] == "unexpected"
    assert body["status"] == 500


@pytest.mark.asyncio
async def test_registry_closes_a_devices_sockets():
    class FakeSocket:
        def __init__(self):
            self.closed = None

        async def close(self, code=1000):
            self.closed = code

    reg = remote_gateway.StreamRegistry()
    sock = FakeSocket()
    reg.register("dv_1", sock)
    assert reg.count("dv_1") == 1
    await reg.close_device("dv_1")
    assert sock.closed == 4401
    assert reg.count("dv_1") == 0
    reg.unregister("dv_1", sock)  # idempotent
