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


class TestWritePtySync:
    """Unit tests for _write_pty_sync partial-write handling."""

    def setup_method(self):
        self.mgr = PtyManager()

    def _add_session(self, terminal_id="t1", alive=True):
        session = make_mock_session(terminal_id, alive=alive)
        self.mgr.sessions[terminal_id] = session
        return session

    def test_full_write_succeeds(self):
        """write() returns full byte count — no retry, returns True."""
        session = self._add_session("t1")
        data = "hello"
        session.pty.write.return_value = len(data.encode("utf-8"))
        assert self.mgr._write_pty_sync("t1", data) is True
        session.pty.write.assert_called_once_with(data)

    def test_partial_write_retries_and_succeeds(self):
        """write() returns partial on first call, remainder on second — retries and returns True."""
        session = self._add_session("t1")
        data = "hello"
        data_bytes = data.encode("utf-8")
        # First call: write 3 bytes, second call: write remaining 2
        session.pty.write.side_effect = [3, len(data_bytes) - 3]
        assert self.mgr._write_pty_sync("t1", data) is True
        assert session.pty.write.call_count == 2
        # Second call must receive only the remaining substring "lo"
        assert session.pty.write.call_args_list[1][0][0] == "lo"

    def test_zero_byte_write_returns_false(self):
        """write() returns 0 — bail immediately, return False."""
        session = self._add_session("t1")
        session.pty.write.return_value = 0
        assert self.mgr._write_pty_sync("t1", "hello") is False

    def test_none_return_conpty_compat_succeeds(self):
        """write() returns None (ConPTY style) — treat as complete, return True."""
        session = self._add_session("t1")
        session.pty.write.return_value = None
        assert self.mgr._write_pty_sync("t1", "hello") is True
        session.pty.write.assert_called_once()

    def test_safety_valve_trips_on_persistent_partial(self):
        """write() consistently returns 1 byte — safety valve fires at 50 retries, returns False."""
        session = self._add_session("t1")
        # Each call writes only 1 byte — triggers safety valve before completing
        session.pty.write.return_value = 1
        # Use a string long enough that 50 single-byte writes won't finish it
        data = "a" * 100
        assert self.mgr._write_pty_sync("t1", data) is False
        assert session.pty.write.call_count == 50

    def test_session_not_found_returns_false(self):
        """No session registered — returns False without error."""
        assert self.mgr._write_pty_sync("nonexistent", "hi") is False

    def test_dead_session_returns_false(self):
        """isalive() returns False — marks alive=False, returns False."""
        session = self._add_session("t1", alive=False)
        assert self.mgr._write_pty_sync("t1", "hi") is False
        assert session.alive is False

    def test_exception_marks_session_dead(self):
        """write() raises OSError — marks session dead and returns False."""
        session = self._add_session("t1")
        session.pty.write.side_effect = OSError("pipe broken")
        result = self.mgr._write_pty_sync("t1", "hello")
        assert result is False
        assert session.alive is False

    def test_multibyte_partial_write_at_clean_boundary(self):
        """Partial write that stops at a clean UTF-8 boundary retries and succeeds.

        "café" encodes to 5 bytes: b'c'=1, b'a'=1, b'f'=1, b'\\xc3\\xa9'=2.
        First write returns 3 (all of "caf"), second returns 2 (all of "é").
        """
        session = self._add_session("t1")
        data = "café"
        # First call: 3 bytes (b"caf"), second call: 2 bytes (b"\xc3\xa9")
        session.pty.write.side_effect = [3, 2]
        assert self.mgr._write_pty_sync("t1", data) is True
        assert session.pty.write.call_count == 2
        # Second call must receive the remaining string "é"
        assert session.pty.write.call_args_list[1][0][0] == "é"

    def test_multibyte_partial_write_splits_character(self):
        """Partial write that splits a multi-byte UTF-8 character returns False.

        "café" encodes to 5 bytes. If write() returns 4, the remaining byte
        b'\\xa9' is the second byte of the two-byte sequence for 'é' — it cannot
        be decoded as valid UTF-8 on its own, so the method must log a warning
        and return False rather than silently dropping the byte.
        """
        session = self._add_session("t1")
        data = "café"
        # First call: 4 bytes — splits 'é' (b"\xc3\xa9") mid-character
        session.pty.write.side_effect = [4]
        assert self.mgr._write_pty_sync("t1", data) is False
