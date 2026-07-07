"""Tests for the typing-quiet gate in bridge_manager._wait_for_idle_simple
and bridge_manager._wait_for_idle.

The gate prevents bridge injection while the user is actively typing:
  if (time.monotonic() - session.last_user_input_time) < _TYPING_QUIET_WINDOW:
      wait and retry

Tests:
  1. _wait_for_idle_simple returns False if last_user_input_time is recent
     (even when tracker state is idle — the typing gate is the only blocker).
  2. _wait_for_idle_simple returns True quickly when the typing window has
     already elapsed (last_user_input_time = now - 2.0).
  3. _wait_for_idle (bridge-record variant) honors the same gate — returns
     False when typing is recent, True when it has elapsed.
"""

from __future__ import annotations

import sys
import os
import time
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import logging_config
logging_config.setup("WARNING")

import bridge_manager as bm_module
from bridge_manager import _wait_for_idle_simple, _wait_for_idle, _BridgeRecord


# ---------------------------------------------------------------------------
# Helper — build a mock session
# ---------------------------------------------------------------------------

def _make_session(tracker_state="idle", last_input_offset=0.0) -> MagicMock:
    """Return a MagicMock session with last_user_input_time set.

    last_input_offset > 0 means the last input happened |offset| seconds AGO
    (i.e. last_user_input_time = now - offset).
    last_input_offset <= 0 means the last input was just NOW (recent typing).
    """
    s = MagicMock()
    s.alive = True
    s.tracker = MagicMock()
    s.tracker.state = tracker_state
    # Positive offset = in the past (quiet); negative/zero = right now (typing)
    s.last_user_input_time = time.monotonic() - last_input_offset
    return s


def _make_bridge_record(bridge_id="bridge-test") -> _BridgeRecord:
    """Minimal _BridgeRecord with an active (unset) stop event."""
    return _BridgeRecord(
        bridge_id=bridge_id,
        from_id="from-001",
        to_id="to-002",
        from_name="Lead",
        to_name="Worker",
        max_turns=4,
    )


# ---------------------------------------------------------------------------
# Test 1 — _wait_for_idle_simple: recent typing blocks idle even when idle
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_wait_for_idle_simple_blocks_when_typing(monkeypatch):
    """_wait_for_idle_simple returns False when last_user_input_time is recent.

    Tracker state is 'idle' so the ONLY blocker is the typing-quiet gate.
    With a short timeout (0.6s < TYPING_QUIET_WINDOW=1.0s), the gate will
    never clear and the function must return False.
    """
    # Session whose last input was 0.05s ago — well inside the 1.0s quiet window
    session = _make_session(tracker_state="idle", last_input_offset=0.05)

    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda _tid: session)

    result = await _wait_for_idle_simple("term-x", timeout=0.6)

    assert result is False, (
        "Expected False — typing gate should block injection even when tracker is idle"
    )


# ---------------------------------------------------------------------------
# Test 2 — _wait_for_idle_simple: elapsed typing window → True quickly
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_wait_for_idle_simple_passes_when_quiet(monkeypatch):
    """_wait_for_idle_simple returns True quickly when the quiet window has elapsed.

    last_user_input_time is 2.0s ago (well past the 1.0s window), and tracker
    state is 'idle' — the function should return True on the first poll loop.
    """
    # Session whose last input was 2.0s ago — past the quiet window
    session = _make_session(tracker_state="idle", last_input_offset=2.0)

    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda _tid: session)

    t0 = time.monotonic()
    result = await _wait_for_idle_simple("term-x", timeout=3.0)
    elapsed = time.monotonic() - t0

    assert result is True, "Expected True — typing window elapsed and session is idle"
    # Should resolve on the first poll iteration, not wait a full second
    assert elapsed < 1.0, f"Expected fast resolution; took {elapsed:.3f}s"


# ---------------------------------------------------------------------------
# Test 3a — _wait_for_idle (bridge record): recent typing blocks
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_wait_for_idle_record_blocks_when_typing(monkeypatch):
    """_wait_for_idle returns 'timeout' when last_user_input_time is recent.

    Same logic as _wait_for_idle_simple but also checks the bridge record's
    stop_event.  Stop event is NOT set — the typing gate is the sole blocker.

    _wait_for_idle now returns a string sentinel ('idle' | 'dead' | 'stopped' |
    'timeout') instead of a bool.  When the session is alive but the typing gate
    never clears within _BUSY_WAIT_MAX, the result is 'timeout' (non-fatal).
    """
    session = _make_session(tracker_state="idle", last_input_offset=0.05)
    record = _make_bridge_record()

    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda _tid: session)

    # Patch _BUSY_WAIT_MAX to keep the test fast (typing gate holds for >0.05s
    # but we only wait 0.4s total; within that window typing never clears).
    monkeypatch.setattr(bm_module, "_BUSY_WAIT_MAX", 0.4)

    result = await _wait_for_idle("term-x", record)

    assert result == "timeout", (
        f"Expected 'timeout' — typing gate blocks injection but peer is alive; got {result!r}"
    )


# ---------------------------------------------------------------------------
# Test 3b — _wait_for_idle (bridge record): elapsed window → "idle" quickly
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_wait_for_idle_record_passes_when_quiet(monkeypatch):
    """_wait_for_idle returns 'idle' quickly when the quiet window has elapsed."""
    session = _make_session(tracker_state="idle", last_input_offset=2.0)
    record = _make_bridge_record()

    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda _tid: session)

    t0 = time.monotonic()
    result = await _wait_for_idle("term-x", record)
    elapsed = time.monotonic() - t0

    assert result == "idle", f"Expected 'idle' — typing window elapsed and session is idle; got {result!r}"
    assert elapsed < 1.0, f"Expected fast resolution; took {elapsed:.3f}s"
