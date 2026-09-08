"""A slow PTY read must be waited out, never abandoned.

REGRESSION (owner-reported, 2.1.3-2.1.6): the desktop app lost terminal output.
``read_pty`` wrapped its executor call in ``asyncio.wait_for(..., timeout=10.0)``
and returned "" on the timeout. Cancelling that wait does NOT stop the worker
thread — it has already taken those bytes off the ConPTY pipe, so the bytes were
silently dropped on the floor. The owner's log shows every session logging "PTY
read timed out" within the SAME second, which is the signature of an event-loop
stall rather than of five simultaneously-hung pseudoconsoles: the reads were fine
and the loop was not, and the code threw away real output for it.

The rule these tests pin: a read that is slow is still a read. The old timeout
survives only as a warning threshold.
"""

import logging
import time
from unittest.mock import MagicMock

import pty_manager
from pty_manager import PtyManager, TerminalSession


def _register(manager, read_fn, terminal_id="slow-read"):
    pty = MagicMock()
    pty.isalive.return_value = True
    pty.read = read_fn
    session = TerminalSession(id=terminal_id, name="slow", pty=pty, created_at="")
    manager.sessions[terminal_id] = session
    return session


async def test_a_read_slower_than_the_warn_threshold_still_delivers_its_bytes(caplog, monkeypatch):
    monkeypatch.setattr(pty_manager, "_PTY_READ_WARN_AFTER", 0.05)
    manager = PtyManager()

    def late_read(size):
        time.sleep(0.2)
        return "LATE-DATA"

    session = _register(manager, late_read)

    # logging_config sets propagate=False on the cockpit logger, so attach
    # caplog's handler directly rather than relying on root capture.
    logger = logging.getLogger("cockpit.pty")
    monkeypatch.setattr(logger, "propagate", False)
    logger.addHandler(caplog.handler)
    try:
        with caplog.at_level(logging.WARNING, logger="cockpit.pty"):
            data = await manager.read_pty(session.id)
    finally:
        logger.removeHandler(caplog.handler)
        manager._pty_executor.shutdown(wait=True)

    assert data == "LATE-DATA", "bytes the worker thread already read were discarded"
    warnings = [r.getMessage() for r in caplog.records if r.levelno >= logging.WARNING]
    assert any("no output is discarded" in message for message in warnings), (
        f"a read past the threshold must say so, and say it is still waiting: {warnings}"
    )
    assert session.alive is True, "a slow read is not a death"


async def test_read_eof_still_ends_the_session_and_returns_empty():
    manager = PtyManager()

    def eof_read(size):
        raise EOFError("pipe closed")

    session = _register(manager, eof_read, terminal_id="eof-read")
    try:
        assert await manager.read_pty(session.id) == ""
    finally:
        manager._pty_executor.shutdown(wait=True)

    assert session.alive is False, "EOF is the genuine end-of-stream and must still be honoured"


async def test_a_read_error_is_swallowed_without_killing_a_live_session():
    manager = PtyManager()

    def broken_read(size):
        raise OSError("transient handle error")

    session = _register(manager, broken_read, terminal_id="broken-read")
    try:
        assert await manager.read_pty(session.id) == ""
    finally:
        manager._pty_executor.shutdown(wait=True)

    assert session.alive is True, "the process is the source of truth, not one failed read"
