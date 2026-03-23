"""Tests for PtyManager — session management logic with mocked PTY processes."""

import os
from unittest.mock import MagicMock, patch

import pytest

# Set MAX_SESSIONS before import
os.environ.setdefault("MAX_SESSIONS", "3")

from pty_manager import PtyManager, TerminalSession, SessionStateTracker


def make_mock_session(terminal_id="test1", alive=True):
    """Create a mock TerminalSession."""
    pty = MagicMock()
    pty.isalive.return_value = alive
    return TerminalSession(
        id=terminal_id,
        name=f"Test {terminal_id}",
        pty=pty,
        created_at="2026-01-01T00:00:00Z",
        model="sonnet",
        working_dir="C:\\Code",
    )


class TestPtyManager:
    def setup_method(self):
        self.mgr = PtyManager()

    def test_kill_terminal_removes_session(self):
        session = make_mock_session("abc")
        self.mgr.sessions["abc"] = session
        assert self.mgr.kill_terminal("abc") is True
        assert "abc" not in self.mgr.sessions

    def test_kill_nonexistent_returns_false(self):
        assert self.mgr.kill_terminal("nonexistent") is False

    def test_list_terminals_marks_dead_but_keeps_them(self):
        alive = make_mock_session("alive1", alive=True)
        dead = make_mock_session("dead1", alive=False)
        self.mgr.sessions["alive1"] = alive
        self.mgr.sessions["dead1"] = dead
        result = self.mgr.list_terminals()
        # list_terminals no longer purges dead sessions (avoids race conditions).
        # It returns all sessions with their alive flag set correctly.
        assert len(result) == 2
        by_id = {r["id"]: r for r in result}
        assert by_id["alive1"]["alive"] is True
        assert by_id["dead1"]["alive"] is False
        # Dead session is still in the dict (cleaned up by kill_terminal)
        assert "dead1" in self.mgr.sessions

    def test_get_terminal_marks_dead(self):
        session = make_mock_session("test1", alive=False)
        self.mgr.sessions["test1"] = session
        result = self.mgr.get_terminal("test1")
        assert result is not None
        assert result.alive is False

    def test_get_nonexistent_returns_none(self):
        assert self.mgr.get_terminal("nope") is None

    def test_max_sessions_limit(self):
        # Fill up to limit
        for i in range(3):
            self.mgr.sessions[f"s{i}"] = make_mock_session(f"s{i}")

        with pytest.raises(RuntimeError, match="Maximum session limit"):
            self.mgr.create_terminal(name="overflow", workdir="C:\\Code")

    def test_write_pty_dead_session(self):
        session = make_mock_session("dead", alive=False)
        self.mgr.sessions["dead"] = session
        assert self.mgr.write_pty("dead", "hello") is False

    def test_write_pty_nonexistent(self):
        assert self.mgr.write_pty("nope", "hello") is False

    def test_shutdown_kills_all(self):
        for i in range(3):
            self.mgr.sessions[f"s{i}"] = make_mock_session(f"s{i}")
        self.mgr.shutdown()
        assert len(self.mgr.sessions) == 0
