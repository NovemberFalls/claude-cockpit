"""Gate for the Studio Remote stream socket and the origin-guard exemption.

Two things are being pinned here, and they pull in opposite directions:

1. A paired phone, reaching Studio through a tunnel, presents a public `Host`
   and no `Origin`. It MUST get through on `/remote/v1/*` — and only there.
2. A phone attaching MUST NOT disturb the desktop. The remote stream keeps its
   own `asyncio.Event` in `session.remote_listeners` and never reads or writes
   `session.active_consumer`, which is the desktop pane's
   latest-connection-wins generation.

Every negative arm has a positive twin: a refuse-everything build would sail
through the 403/401 cases and is caught by the 200s beside them.
"""

from __future__ import annotations

import asyncio
import time
from contextlib import asynccontextmanager
from unittest.mock import MagicMock

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import remote_gateway
import server
from pty_manager import TerminalSession
from remote_devices import DeviceStore

# The tunnel's public name: NOT loopback, so both origin-guard clauses would
# refuse it. That is the whole point of the exemption under test.
PUBLIC_HOST = "studio.example.com"

_LIVE_SESSION = None


@pytest.fixture
def remote(tmp_path, monkeypatch):
    """A configured gateway on a throwaway store, with remote.enabled True."""
    global _LIVE_SESSION
    session = TerminalSession(id="rmt-1", name="test", pty=MagicMock(), created_at="")
    session.working_dir = "/tmp"
    monkeypatch.setattr(server.pty_manager, "get_terminal", lambda _id: session)
    monkeypatch.setattr(server.pty_manager, "resync_alive", lambda _id: True)
    monkeypatch.setattr(
        server.pty_manager, "list_terminals",
        lambda: [{"id": session.id, "name": session.name, "harness": "claude-code",
                  "model": "sonnet", "working_dir": "/tmp", "alive": True,
                  "activity_state": "idle", "created_at": ""}],
    )

    # These tests enter TestClient as a context manager — the only way to get ONE
    # portal (and therefore one event loop) shared by a websocket and the HTTP
    # POST that wakes it. Entering also runs the real lifespan, whose SHUTDOWN
    # deletes the uploads directory and kills tracked processes; that leaked into
    # test_server.py's upload tests when the two ran in one session. Stand the
    # lifespan down: nothing here needs the background loops.
    @asynccontextmanager
    async def _no_lifespan(_app):
        yield

    monkeypatch.setattr(server.app.router, "lifespan_context", _no_lifespan)

    store = DeviceStore(tmp_path / "remote_devices.json")
    enabled = {"value": True}

    async def _submit(_terminal_id, _text):
        return True

    backend = remote_gateway.RemoteBackend(
        settings=lambda: {"remote": {"enabled": enabled["value"], "hostname": ""}},
        app_version=lambda: "test",
        list_sessions=server.pty_manager.list_terminals,
        get_session=server.pty_manager.get_terminal,
        create_session=server._create_terminal_from_body,
        submit=_submit,
        write_raw=server.pty_manager.write_pty_async,
        interrupt=lambda tid: server.pty_manager.write_pty_async(tid, "\x1b"),
    )
    previous_backend = remote_gateway._backend
    previous_store = remote_gateway._store
    remote_gateway.configure(backend, store)

    code = store.create_pairing()["code"]
    device_id, token = store.redeem_pairing(code, "phone")

    _LIVE_SESSION = session
    yield {"session": session, "store": store, "token": token,
           "device_id": device_id, "enabled": enabled}
    _LIVE_SESSION = None
    # Restore whatever server.py wired at import, so no later module in the
    # suite inherits this test's throwaway store.
    remote_gateway._backend = previous_backend
    remote_gateway._store = previous_store


def _headers(token=None, host=PUBLIC_HOST):
    # No Origin at all, exactly like a native app through a tunnel.
    headers = {"host": host}
    if token:
        headers["authorization"] = f"Bearer {token}"
    return headers


def _fresh_events(session):
    """Rebind the session's events to whichever loop is about to run the app.

    Each TestClient owns its own event loop while the shipped server has one for
    the life of the process; an asyncio.Event binds to the first loop that waits
    on it. Handing out fresh events is a test-harness concession, never a
    weakening of the server.
    """
    session.history_changed = asyncio.Event()
    session.remote_listeners = set()


def _drain_to_replay_end(socket):
    frames = []
    while True:
        frame = socket.receive_json()
        if frame["type"] == "replay_end":
            return frames
        if frame["type"] == "output":
            frames.append(frame)


# ── The stream ───────────────────────────────────────────────────────────


def test_stream_replays_coalesced_then_delivers_a_live_append(remote, monkeypatch):
    session = remote["session"]
    for _ in range(500):
        session.history.append("x\r\n")
    _fresh_events(session)

    async def echo(_terminal_id, text):
        # Runs ON the app's event loop, via the POST below on the same portal —
        # the only thread-safe place a TestClient test can set the events the
        # stream task is waiting on. This is exactly what _session_reader does.
        session.history.append("ECHO:" + text)
        session.history_changed.set()
        for listener in list(session.remote_listeners):
            listener.set()
        return True

    monkeypatch.setattr(remote_gateway._backend, "submit", echo)

    with TestClient(server.app) as client:
        with client.websocket_connect(
            "/remote/v1/sessions/rmt-1/stream", headers=_headers(remote["token"])
        ) as socket:
            assert socket.receive_json() == {
                "type": "replay_start", "reset": True, "truncated": False}
            frames = _drain_to_replay_end(socket)
            assert len(frames) < 5, f"500 retained chunks replayed as {len(frames)} frames"
            assert frames[-1]["seq"] == 500
            assert "".join(f["data"] for f in frames) == "x\r\n" * 500

            response = client.post(
                "/remote/v1/sessions/rmt-1/input",
                json={"text": "hi"},
                headers=_headers(remote["token"]),
            )
            assert response.status_code == 200
            started = time.monotonic()
            live = socket.receive_json()
            elapsed = time.monotonic() - started

    assert live == {"type": "output", "seq": 501, "data": "ECHO:hi"}
    # receive_json blocks, so the wall clock is the proof: a 0.5 s liveness tick
    # would land well outside this window.
    assert elapsed < 0.25, f"live output waited {elapsed:.3f}s — it was not event-driven"


def test_two_devices_share_a_session_and_the_desktop_generation_is_untouched(remote, monkeypatch):
    session = remote["session"]
    _fresh_events(session)
    before = session.active_consumer

    async def echo(_terminal_id, text):
        session.history.append(text)
        session.history_changed.set()
        for listener in list(session.remote_listeners):
            listener.set()
        return True

    monkeypatch.setattr(remote_gateway._backend, "submit", echo)

    with TestClient(server.app) as client:
        with client.websocket_connect(
            "/remote/v1/sessions/rmt-1/stream", headers=_headers(remote["token"])
        ) as first, client.websocket_connect(
            "/remote/v1/sessions/rmt-1/stream", headers=_headers(remote["token"])
        ) as second:
            _drain_to_replay_end(first)
            _drain_to_replay_end(second)
            assert len(session.remote_listeners) == 2
            client.post(
                "/remote/v1/sessions/rmt-1/input",
                json={"text": "BOTH"},
                headers=_headers(remote["token"]),
            )
            assert first.receive_json() == {"type": "output", "seq": 1, "data": "BOTH"}
            assert second.receive_json() == {"type": "output", "seq": 1, "data": "BOTH"}

    assert session.active_consumer == before, (
        "a remote stream moved the desktop's active_consumer generation"
    )
    assert session.remote_listeners == set(), "a stream leaked its listener"


def test_ping_is_answered_with_pong(remote):
    _fresh_events(remote["session"])
    with TestClient(server.app) as client:
        with client.websocket_connect(
            "/remote/v1/sessions/rmt-1/stream", headers=_headers(remote["token"])
        ) as socket:
            _drain_to_replay_end(socket)
            socket.send_json({"type": "ping"})
            assert socket.receive_json() == {"type": "pong"}


def test_a_dead_session_gets_an_ended_frame(remote):
    session = remote["session"]
    session.alive = False
    _fresh_events(session)
    with TestClient(server.app) as client:
        with client.websocket_connect(
            "/remote/v1/sessions/rmt-1/stream", headers=_headers(remote["token"])
        ) as socket:
            _drain_to_replay_end(socket)
            assert socket.receive_json() == {"type": "ended"}
    session.alive = True


# ── Handshake refusals, all pre-accept ───────────────────────────────────


def test_an_unauthenticated_handshake_is_refused(remote):
    _fresh_events(remote["session"])
    with TestClient(server.app) as client:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(
                "/remote/v1/sessions/rmt-1/stream", headers=_headers()
            ):
                pytest.fail("an unpaired caller received a remote stream")


def test_a_revoked_device_is_refused(remote):
    _fresh_events(remote["session"])
    assert remote["store"].revoke(remote["device_id"]) is True
    with TestClient(server.app) as client:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(
                "/remote/v1/sessions/rmt-1/stream", headers=_headers(remote["token"])
            ):
                pytest.fail("a revoked device received a remote stream")


def test_remote_disabled_refuses_even_a_valid_token(remote):
    _fresh_events(remote["session"])
    remote["enabled"]["value"] = False
    with TestClient(server.app) as client:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(
                "/remote/v1/sessions/rmt-1/stream", headers=_headers(remote["token"])
            ):
                pytest.fail("a disabled remote surface served a stream")


def test_an_unknown_session_is_refused_before_accept(remote, monkeypatch):
    monkeypatch.setattr(server.pty_manager, "get_terminal", lambda _id: None)
    with TestClient(server.app) as client:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(
                "/remote/v1/sessions/nope/stream", headers=_headers(remote["token"])
            ):
                pytest.fail("an unknown terminal id got a live socket")


# ── The origin-guard exemption, and its exact boundary ───────────────────


def test_a_tunnelled_host_reaches_remote_v1_but_nothing_else(remote):
    client = TestClient(server.app)

    ok = client.get("/remote/v1/hello", headers=_headers(remote["token"]))
    assert ok.status_code == 200
    assert ok.json()["protocol"] == remote_gateway.PROTOCOL_VERSION

    unauthorized = client.get("/remote/v1/hello", headers=_headers())
    assert unauthorized.status_code == 401

    # The exemption is the prefix, not the Host: every other route still refuses.
    assert client.get("/api/terminals", headers=_headers(remote["token"])).status_code == 403

    _fresh_events(remote["session"])
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/terminal/rmt-1", headers=_headers(remote["token"])):
            pytest.fail("the desktop terminal socket accepted a tunnelled Host")


def test_the_admin_routes_are_still_origin_guarded(remote):
    client = TestClient(server.app)
    assert client.get("/api/remote/status", headers=_headers(remote["token"])).status_code == 403
    # Positive twin: from the real desktop origin it answers.
    allowed = client.get(
        "/api/remote/status",
        headers={"host": "localhost:8420", "origin": "http://localhost:8420"},
    )
    assert allowed.status_code == 200
    assert allowed.json()["enabled"] is True
