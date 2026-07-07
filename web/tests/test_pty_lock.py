"""Tests for per-session write serialization via write_lock in pty_manager.

Verifies that:
  1. Two concurrent write_pty_async calls on the SAME session are serialized
     (no interleaving — the lock enforces ordering).
  2. Two concurrent writes on DIFFERENT sessions are NOT serialized
     (independent locks → parallel execution, wall-clock < 2x sleep).
  3. The lock is released after a failed write so a subsequent call succeeds.

All tests use real asyncio.Lock instances (not mocked) — that IS what we're
testing. The PTY itself is a MagicMock so no real PTY process is needed.
"""

from __future__ import annotations

import asyncio
import sys
import os
import time
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import logging_config
logging_config.setup("WARNING")

from pty_manager import PtyManager, TerminalSession


# ---------------------------------------------------------------------------
# Helper — build a real TerminalSession with a mocked PTY
# ---------------------------------------------------------------------------

def _make_real_session(terminal_id: str, write_fn=None) -> TerminalSession:
    """Return a TerminalSession with a real write_lock and a mock PTY.

    write_fn: callable(data) that replaces session.pty.write.  If None, the
    mock returns None (ConPTY-style complete write).
    """
    pty = MagicMock()
    pty.isalive.return_value = True
    if write_fn is not None:
        pty.write.side_effect = write_fn
    else:
        pty.write.return_value = None  # ConPTY treats None as success

    session = TerminalSession(
        id=terminal_id,
        name=f"Test {terminal_id}",
        pty=pty,
        created_at="2026-01-01T00:00:00Z",
        model="sonnet",
        working_dir="/tmp",
    )
    return session


# ---------------------------------------------------------------------------
# Test 1 — same session: writes are serialized
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_concurrent_writes_same_session_are_serialized():
    """Two concurrent write_pty_async calls on one session run one-after-the-other.

    We use a small time.sleep inside the PTY write so that the second coroutine,
    if it bypassed the lock, would finish before the first — making order
    observable. With the lock, they run strictly sequentially.
    """
    mgr = PtyManager()
    call_order: list[str] = []

    SLEEP_S = 0.05

    def slow_write(data: str):
        call_order.append(f"start:{data}")
        time.sleep(SLEEP_S)
        call_order.append(f"end:{data}")
        return None  # ConPTY-style success

    session = _make_real_session("lock-t1", write_fn=slow_write)
    mgr.sessions["lock-t1"] = session

    try:
        await asyncio.gather(
            mgr.write_pty_async("lock-t1", "A"),
            mgr.write_pty_async("lock-t1", "B"),
        )
    finally:
        del mgr.sessions["lock-t1"]

    # With serialization: start:A → end:A → start:B → end:B
    # Without: start:A + start:B would both appear before either end.
    assert call_order.index("end:A") < call_order.index("start:B"), (
        f"Writes interleaved — lock not working. order={call_order}"
    )


# ---------------------------------------------------------------------------
# Test 2 — different sessions: writes run concurrently
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_concurrent_writes_different_sessions_are_parallel():
    """Two write_pty_async calls on DIFFERENT sessions run concurrently.

    Wall-clock must be substantially less than SLEEP * 2 (sequential would be
    ~0.10 s; parallel should be ~0.05 s + overhead).
    """
    mgr = PtyManager()
    SLEEP_S = 0.06

    def slow_write(_data: str):
        time.sleep(SLEEP_S)
        return None

    s1 = _make_real_session("para-t1", write_fn=slow_write)
    s2 = _make_real_session("para-t2", write_fn=slow_write)
    mgr.sessions["para-t1"] = s1
    mgr.sessions["para-t2"] = s2

    try:
        t0 = time.monotonic()
        await asyncio.gather(
            mgr.write_pty_async("para-t1", "msg1"),
            mgr.write_pty_async("para-t2", "msg2"),
        )
        elapsed = time.monotonic() - t0
    finally:
        del mgr.sessions["para-t1"]
        del mgr.sessions["para-t2"]

    # Sequential would take ≥ 2 * SLEEP_S.  Parallel takes ≈ SLEEP_S.
    # Allow generous headroom for CI scheduler jitter.
    assert elapsed < SLEEP_S * 1.8, (
        f"Expected parallel execution (elapsed {elapsed:.3f}s < {SLEEP_S * 1.8:.3f}s). "
        "Locks may be shared instead of per-session."
    )


# ---------------------------------------------------------------------------
# Test 3 — lock released after failed write
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_lock_released_after_failed_write():
    """A failed write (exception in pty.write) still releases the lock.

    If the lock were not released, the second write_pty_async call would hang
    until timeout.  We use asyncio.wait_for with a tight timeout to detect
    deadlock quickly.
    """
    mgr = PtyManager()
    call_count = [0]

    def fail_then_succeed(data: str):
        call_count[0] += 1
        if call_count[0] == 1:
            raise OSError("pipe broken")
        return None  # success on second call

    session = _make_real_session("fail-t1", write_fn=fail_then_succeed)
    mgr.sessions["fail-t1"] = session

    try:
        # First write — should return False (exception marks session dead)
        result1 = await mgr.write_pty_async("fail-t1", "first")
        assert result1 is False

        # Revive the session so the second write attempt is allowed through
        session.alive = True
        session.pty.isalive.return_value = True

        # Second write — must not deadlock; lock must have been released
        result2 = await asyncio.wait_for(
            mgr.write_pty_async("fail-t1", "second"),
            timeout=2.0,
        )
        assert result2 is True
    finally:
        mgr.sessions.pop("fail-t1", None)
