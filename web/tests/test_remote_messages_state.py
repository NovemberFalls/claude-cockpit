"""The messages route must report a REAL session's activity state.

TerminalSession keeps its state on ``tracker.state``; only the dict doubles the
gateway tests use carry an ``activity_state`` key. The route read the attribute
and returned null for every production session, so the phone never showed a
typing indicator. Pinned with a real TerminalSession, not a dict.
"""
from unittest.mock import MagicMock

from fastapi import FastAPI
from starlette.testclient import TestClient

import remote_gateway
from pty_manager import TerminalSession
from remote_devices import DeviceStore


def test_messages_route_reports_tracker_state_for_a_real_session(tmp_path):
    session = TerminalSession(id="real-1", name="real", pty=MagicMock(), created_at="")
    session.harness = "claude-code"
    session.tracker.state = "busy"
    backend = remote_gateway.RemoteBackend(
        settings=lambda: {"remote": {"enabled": True, "hostname": ""}},
        app_version=lambda: "t",
        list_sessions=lambda: [],
        get_session=lambda tid: session if tid == "real-1" else None,
        create_session=None, submit=None, write_raw=None, interrupt=None,
        messages_claude=lambda s: [],
    )
    store = DeviceStore(tmp_path / "devices.json")
    remote_gateway.configure(backend, store)
    app = FastAPI()
    app.include_router(remote_gateway.router)
    app.include_router(remote_gateway.admin_router)
    client = TestClient(app, base_url="http://127.0.0.1:8420")
    code = client.post("/api/remote/pairings").json()["code"]
    token = client.post("/remote/v1/pair", json={"code": code, "device_name": "t"}).json()["token"]
    r = client.get("/remote/v1/sessions/real-1/messages", headers={"authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.json()["activity_state"] == "busy"
