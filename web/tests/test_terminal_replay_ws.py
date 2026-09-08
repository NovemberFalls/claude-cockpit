from unittest.mock import MagicMock

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import server
from pty_manager import TerminalSession
from terminal_history import TerminalHistory


@pytest.fixture
def session(monkeypatch):
    value = TerminalSession(id="replay-test", name="test", pty=MagicMock(), created_at="")
    monkeypatch.setattr(server.pty_manager, "get_terminal", lambda _: value)
    monkeypatch.setattr(server.pty_manager, "resync_alive", lambda _: True)
    return value


def connect(query="", origin="http://localhost:8420"):
    client = TestClient(server.app)
    return client.websocket_connect("/ws/terminal/replay-test?replay=1" + query,
        headers={"host": "localhost:8420", "origin": origin})


def test_fresh_view_replays_and_reconnect_only_sends_missing_chunks(session):
    session.history.append("OLD CONTEXT\r\n")
    with connect() as socket:
        assert socket.receive_json() == {"type": "replay_start", "reset": True, "truncated": False}
        assert socket.receive_json() == {"type": "output", "seq": 1, "data": "OLD CONTEXT\r\n"}
        assert socket.receive_json() == {"type": "replay_end", "seq": 1}
    session.history.append("NEW CONTEXT\r\n")
    with connect("&after=1") as socket:
        assert socket.receive_json() == {"type": "replay_start", "reset": False, "truncated": False}
        assert socket.receive_json() == {"type": "output", "seq": 2, "data": "NEW CONTEXT\r\n"}
        assert socket.receive_json()["type"] == "replay_end"
    with connect() as socket:
        socket.receive_json()
        assert socket.receive_json()["seq"] == 1  # popout still has the complete retained stream


def test_cursor_gap_is_visible_and_foreign_origin_cannot_replay(session):
    session.history = TerminalHistory(max_bytes=4)
    session.history.append("OLD!")
    session.history.append("NEW!")
    with connect("&after=0") as socket:
        assert socket.receive_json() == {"type": "replay_start", "reset": True, "truncated": True}
        assert socket.receive_json()["data"] == "NEW!"
    with pytest.raises(WebSocketDisconnect):
        with connect(origin="https://foreign.example"):
            pytest.fail("Foreign origin received a replay socket")
