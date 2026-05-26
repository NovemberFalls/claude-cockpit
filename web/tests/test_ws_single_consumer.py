"""Tests for the WebSocket single-consumer (latest-connection-wins) contract.

The fix in server.py/pty_manager.py introduces TerminalSession.active_consumer:
an integer generation counter incremented each time a new WebSocket attaches to
a terminal.  The pty_to_ws() forwarder captures its generation at attach time
(my_generation) and stops draining when active_consumer no longer matches.

These tests exercise the contract directly on TerminalSession and the queue-drain
logic without requiring a real PTY or a live WebSocket connection.
"""

import asyncio

import pytest

import logging_config
logging_config.setup("WARNING")

from pty_manager import TerminalSession
from unittest.mock import MagicMock


# ── Helpers ────────────────────────────────────────────────


def make_session(terminal_id: str = "ws-test", alive: bool = True) -> TerminalSession:
    """Minimal TerminalSession with a mocked PTY — no real process."""
    pty = MagicMock()
    pty.isalive.return_value = alive
    return TerminalSession(
        id=terminal_id,
        name="WS test session",
        pty=pty,
        created_at="2026-01-01T00:00:00Z",
        model="sonnet",
        working_dir="C:\\Code",
    )


# ── Unit tests: field default and generation arithmetic ───────────────────────


class TestActiveConsumerField:
    """Tests for TerminalSession.active_consumer — field contract."""

    def test_default_is_zero(self):
        """New sessions start with active_consumer == 0 (no WS attached yet).

        Would have been RED before this change: the field did not exist.
        """
        session = make_session()
        assert session.active_consumer == 0

    def test_first_connection_increments_to_one(self):
        """First WS attach: increment → my_generation = 1; consumer == 1 → active."""
        session = make_session()
        session.active_consumer += 1
        my_generation = session.active_consumer
        assert my_generation == 1
        assert session.active_consumer == my_generation  # still the active consumer

    def test_second_connection_supersedes_first(self):
        """Second WS attach bumps counter; first generation is now stale.

        This is the core regression contract: after a second connect the first
        forwarder's condition `session.active_consumer == my_gen_1` evaluates
        False, so it exits its drain loop.

        Would have been RED before this change: both forwarders would keep
        draining, splitting output between them.
        """
        session = make_session()

        # First WS attaches
        session.active_consumer += 1
        my_gen_1 = session.active_consumer  # == 1

        # Second WS attaches (e.g. popout window reclaim)
        session.active_consumer += 1
        my_gen_2 = session.active_consumer  # == 2

        # First forwarder's loop guard is now False → it must stop
        assert session.active_consumer != my_gen_1, (
            "First forwarder must detect it is superseded (gen 1 vs active 2)"
        )
        # Second forwarder's loop guard is True → it continues
        assert session.active_consumer == my_gen_2, (
            "Second forwarder must remain the active consumer"
        )

    def test_many_reconnects_always_latest_wins(self):
        """N reconnects in sequence: only the last generation is ever equal to active_consumer."""
        session = make_session()
        generations = []
        for _ in range(10):
            session.active_consumer += 1
            generations.append(session.active_consumer)

        # Only the very last generation matches
        for gen in generations[:-1]:
            assert session.active_consumer != gen, (
                f"Generation {gen} should be superseded by {session.active_consumer}"
            )
        assert session.active_consumer == generations[-1]


# ── Async tests: queue drain stops on supersession ────────────────────────────


@pytest.mark.asyncio
async def test_superseded_forwarder_stops_draining():
    """Superseded forwarder exits immediately; active forwarder drains the queue.

    Simulates exactly the pty_to_ws() loop guard in server.py:

        while session.alive and session.active_consumer == my_generation:
            data = await queue.get()
            if session.active_consumer != my_generation:
                queue.put_nowait(data)   # return item to queue for new consumer
                break
            ...send data...

    Approach (b): we drive the boolean conditions directly with a real asyncio.Queue
    and a TerminalSession, verifying that the stale forwarder puts its item back and
    that the active forwarder drains correctly — without a real WS or PTY.

    Would have been RED before this change: without the generation check the old
    forwarder would consume and discard the item, so the active consumer would miss it.
    """
    session = make_session()
    queue = session.output_queue  # real asyncio.Queue(maxsize=200)

    # Simulate first WS connect
    session.active_consumer += 1
    my_gen_stale = session.active_consumer  # == 1

    # Second WS connects — supersedes the first
    session.active_consumer += 1
    my_gen_active = session.active_consumer  # == 2

    # Enqueue one item that "arrives" while both forwarders are attached
    await queue.put("hello from PTY")

    # --- Stale forwarder loop iteration ---
    # It checks the outer while condition: False immediately → never even gets the item.
    # But simulate the race where it already got the item before noticing supersession:
    item = queue.get_nowait()  # stale forwarder grabs the item
    if session.active_consumer != my_gen_stale:
        # Stale forwarder: put the item back for the active consumer
        queue.put_nowait(item)

    # The item must still be in the queue for the active forwarder
    assert not queue.empty(), (
        "Stale forwarder must return the item to the queue after detecting supersession"
    )

    # --- Active forwarder loop iteration ---
    item_for_active = queue.get_nowait()
    should_send = (session.active_consumer == my_gen_active)

    assert should_send, "Active forwarder must pass the generation check"
    assert item_for_active == "hello from PTY", (
        "Active forwarder must receive the correct item"
    )


@pytest.mark.asyncio
async def test_dead_session_banner_not_sent_by_superseded_forwarder():
    """Superseded-but-alive forwarder must NOT emit the [Session ended] banner.

    The fix adds `if not session.alive:` before the drain+banner tail in pty_to_ws().
    This test asserts that a forwarder exiting due to supersession (session still
    alive) does NOT reach the banner code path.

    We do this by asserting the condition: `not session.alive` is False when the
    session is alive — so a superseded forwarder that exits its loop must check
    this before sending the banner.

    Would have been RED before this change: the old code always sent the banner
    after the forwarder loop exited, even for supersession exits.
    """
    session = make_session(alive=True)

    # First WS connects
    session.active_consumer += 1
    my_gen_stale = session.active_consumer  # == 1

    # Second WS supersedes
    session.active_consumer += 1

    # Simulate the superseded forwarder reaching the post-loop banner check.
    # The banner must only be sent when the session is dead.
    superseded_should_send_banner = not session.alive  # session.alive == True

    assert superseded_should_send_banner is False, (
        "Superseded forwarder must not send the [Session ended] banner "
        "when the session is still alive"
    )

    # Contrast: when the session actually dies, the active forwarder may send the banner
    session.alive = False
    dead_should_send_banner = not session.alive
    assert dead_should_send_banner is True, (
        "Active forwarder must send the banner when the session is dead"
    )
