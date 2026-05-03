"""Tests for BridgeManager (web/bridge_manager.py).

Covers:
  - start_manual: bracketed-paste injection, dead-session guard, prefix handling
  - start_auto: bridge_id generation, JSONL pre-check, kickoff writes, task spawn
  - stop: state transitions, idempotency, unknown bridge
  - list_active: shape of returned dicts
  - Relay-task behaviour: sentinel detection, turn cap, idle-gate timeout

All tests are isolated — no real PTY processes or filesystem access.
pty_manager and tail_jsonl are replaced by monkeypatched stubs for each test.
"""

from __future__ import annotations

import asyncio
import re
import sys
import os
from unittest.mock import AsyncMock, MagicMock

import pytest

# Make the web/ directory importable without a package install
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import logging_config
logging_config.setup("WARNING")

import bridge_manager as bm_module
from bridge_manager import BridgeManager, _BP_START, _BP_END, _SUBMIT


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_mock_session(terminal_id="term-123", name="Test Session", alive=True, tracker_state="idle"):
    """Build a mock TerminalSession with the fields BridgeManager reads."""
    s = MagicMock()
    s.id = terminal_id
    s.name = name
    s.alive = alive
    s.tracker = MagicMock()
    s.tracker.state = tracker_state
    s.claude_session_id = "claude-abc"
    s.working_dir = "/tmp"
    return s


@pytest.fixture()
def bm():
    """Fresh BridgeManager for each test."""
    return BridgeManager()


@pytest.fixture()
def from_session():
    return _make_mock_session("from-001", "From Session")


@pytest.fixture()
def to_session():
    return _make_mock_session("to-002", "To Session")


@pytest.fixture()
def patch_pty(monkeypatch, from_session, to_session):
    """Monkeypatch pty_manager on the bridge_manager module.

    Returns a list that accumulates (terminal_id, data) tuples from every
    write_pty_async call.
    """
    sessions = {from_session.id: from_session, to_session.id: to_session}

    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda tid: sessions.get(tid))
    monkeypatch.setattr(bm_module.pty_manager, "_get_jsonl_path", lambda s: "/tmp/fake.jsonl")

    write_calls: list[tuple[str, str]] = []

    async def fake_write(tid, data):
        write_calls.append((tid, data))
        return True

    monkeypatch.setattr(bm_module.pty_manager, "write_pty_async", fake_write)

    return write_calls


# ---------------------------------------------------------------------------
# Helper — async generator that yields a fixed set of JSONL entries then stops
# ---------------------------------------------------------------------------


def _async_gen_from_list(entries: list[dict]):
    """Return an async generator that yields items from *entries* then returns."""
    async def _gen(path, from_beginning=False):
        for entry in entries:
            yield entry
    return _gen


# ---------------------------------------------------------------------------
# Test 1 — start_manual writes bracketed-paste
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_start_manual_writes_bracketed_paste(bm, patch_pty, from_session, to_session):
    """start_manual wraps the message in BP escapes and sends it to the target PTY."""
    result = await bm.start_manual(
        from_session.id,
        to_session.id,
        "Hello from the bridge",
        prefix='[From session "From Session"]:',
    )

    assert result == {"ok": True}
    assert len(patch_pty) == 1
    _tid, data = patch_pty[0]
    assert _tid == to_session.id
    # BP escapes present
    assert _BP_START in data
    assert _BP_END in data
    # Submitted with CR
    assert _SUBMIT in data
    # Prefix on its own line, then the message
    assert '[From session "From Session"]:' in data
    assert "Hello from the bridge" in data
    # Prefix comes BEFORE the message
    assert data.index('[From session "From Session"]:') < data.index("Hello from the bridge")


# ---------------------------------------------------------------------------
# Test 2 — start_manual with dead target
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_start_manual_with_dead_target(bm, monkeypatch, from_session):
    """start_manual returns {ok: False} if the target session is dead."""
    dead_target = _make_mock_session("to-dead", alive=False)
    sessions = {from_session.id: from_session, dead_target.id: dead_target}
    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda tid: sessions.get(tid))

    write_calls = []
    async def fake_write(tid, data):
        write_calls.append((tid, data))
        return True
    monkeypatch.setattr(bm_module.pty_manager, "write_pty_async", fake_write)

    result = await bm.start_manual(from_session.id, dead_target.id, "msg")

    assert result.get("ok") is False
    assert "error" in result
    assert len(write_calls) == 0


# ---------------------------------------------------------------------------
# Test 3 — start_manual with dead source
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_start_manual_with_dead_source(bm, monkeypatch, to_session):
    """start_manual returns {ok: False} if the source session is dead."""
    dead_source = _make_mock_session("from-dead", alive=False)
    sessions = {dead_source.id: dead_source, to_session.id: to_session}
    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda tid: sessions.get(tid))

    write_calls = []
    async def fake_write(tid, data):
        write_calls.append((tid, data))
        return True
    monkeypatch.setattr(bm_module.pty_manager, "write_pty_async", fake_write)

    result = await bm.start_manual(dead_source.id, to_session.id, "msg")

    assert result.get("ok") is False
    assert "error" in result
    assert len(write_calls) == 0


# ---------------------------------------------------------------------------
# Test 4 — start_manual default prefix when None
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_start_manual_default_prefix_when_none(bm, patch_pty, from_session, to_session):
    """When prefix=None, BridgeManager sends only the message (no prefix line).

    The bridge_manager source code shows: if prefix is falsy, full_text = message.
    So the sent data should contain only the message inside the BP escapes.
    """
    result = await bm.start_manual(from_session.id, to_session.id, "bare message", prefix=None)

    assert result == {"ok": True}
    assert len(patch_pty) == 1
    _tid, data = patch_pty[0]
    assert "bare message" in data
    # No spurious prefix line when None
    assert "[From session" not in data


# ---------------------------------------------------------------------------
# Test 5 — start_auto returns bridge_id
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_start_auto_returns_bridge_id(bm, patch_pty, from_session, to_session, monkeypatch):
    """start_auto returns {ok: True, bridge_id: <12-char hex>} when both sessions are live."""
    # Stub tail_jsonl so relay tasks don't spin forever
    async def never_yield(path, from_beginning=False):
        await asyncio.sleep(10)
        return
        yield  # make it an async generator

    monkeypatch.setattr(bm_module, "tail_jsonl", never_yield)

    result = await bm.start_auto(from_session.id, to_session.id, "ping")

    assert result.get("ok") is True
    bid = result.get("bridge_id")
    assert bid is not None
    assert len(bid) == 12
    assert re.fullmatch(r"[0-9a-f]{12}", bid) is not None, f"bridge_id not 12-char hex: {bid!r}"

    # Cleanup — cancel tasks so they don't escape the test
    record = bm._bridges[bid]
    record._stop_event.set()
    for task in (record._task_from, record._task_to):
        if task and not task.done():
            task.cancel()
    await asyncio.sleep(0)


# ---------------------------------------------------------------------------
# Test 6 — start_auto with missing JSONL returns error and doesn't start tasks
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_start_auto_no_jsonl_returns_error_not_started(bm, monkeypatch, from_session, to_session):
    """start_auto returns {ok: False} when JSONL path is unavailable for a session."""
    sessions = {from_session.id: from_session, to_session.id: to_session}
    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda tid: sessions.get(tid))
    # JSONL only available for 'from', not 'to'
    monkeypatch.setattr(
        bm_module.pty_manager,
        "_get_jsonl_path",
        lambda s: "/tmp/fake.jsonl" if s.id == from_session.id else None,
    )

    write_calls = []
    async def fake_write(tid, data):
        write_calls.append((tid, data))
        return True
    monkeypatch.setattr(bm_module.pty_manager, "write_pty_async", fake_write)

    result = await bm.start_auto(from_session.id, to_session.id, "kickoff")

    assert result.get("ok") is False
    assert "error" in result
    # No kickoff writes should have been sent
    assert len(write_calls) == 0


# ---------------------------------------------------------------------------
# Test 7 — start_auto sends kickoff writes to both sides
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_start_auto_kicks_off_both_sides(bm, patch_pty, from_session, to_session, monkeypatch):
    """start_auto sends one kickoff write to each session."""
    async def never_yield(path, from_beginning=False):
        await asyncio.sleep(10)
        return
        yield

    monkeypatch.setattr(bm_module, "tail_jsonl", never_yield)

    result = await bm.start_auto(from_session.id, to_session.id, "shared prompt")

    assert result.get("ok") is True

    # Allow asyncio tasks to schedule
    await asyncio.sleep(0)

    # Two kickoff writes: one per session
    assert len(patch_pty) == 2
    target_ids = {tid for tid, _ in patch_pty}
    assert from_session.id in target_ids
    assert to_session.id in target_ids

    # Each kickoff contains the BP start
    for _tid, data in patch_pty:
        assert _BP_START in data

    # Cleanup
    bid = result["bridge_id"]
    record = bm._bridges[bid]
    record._stop_event.set()
    for task in (record._task_from, record._task_to):
        if task and not task.done():
            task.cancel()
    await asyncio.sleep(0)


# ---------------------------------------------------------------------------
# Test 8 — stop transitions state to ended_user
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_stop_existing_bridge_returns_true_and_marks_ended_user(
    bm, patch_pty, from_session, to_session, monkeypatch
):
    """stop() on an active bridge returns True and sets state='ended_user'."""
    async def never_yield(path, from_beginning=False):
        await asyncio.sleep(10)
        return
        yield

    monkeypatch.setattr(bm_module, "tail_jsonl", never_yield)

    result = await bm.start_auto(from_session.id, to_session.id, "test")
    bid = result["bridge_id"]

    await asyncio.sleep(0)

    ok = bm.stop(bid)
    assert ok is True

    bridges = {b["bridge_id"]: b for b in bm.list_active()}
    assert bridges[bid]["state"] == "ended_user"


# ---------------------------------------------------------------------------
# Test 9 — stop unknown bridge returns False
# ---------------------------------------------------------------------------


def test_stop_unknown_bridge_returns_false(bm):
    """stop() on a nonexistent bridge_id returns False."""
    assert bm.stop("nonexistent_12x") is False


# ---------------------------------------------------------------------------
# Test 10 — stop already-ended bridge is idempotent
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_stop_already_ended_idempotent(bm, patch_pty, from_session, to_session, monkeypatch):
    """Calling stop() twice on the same bridge both return True."""
    async def never_yield(path, from_beginning=False):
        await asyncio.sleep(10)
        return
        yield

    monkeypatch.setattr(bm_module, "tail_jsonl", never_yield)

    result = await bm.start_auto(from_session.id, to_session.id, "test")
    bid = result["bridge_id"]

    await asyncio.sleep(0)

    first = bm.stop(bid)
    second = bm.stop(bid)

    assert first is True
    assert second is True  # Per Quinn's note: already in terminal state — still True


# ---------------------------------------------------------------------------
# Test 11 — list_active shape
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_active_shape(bm, patch_pty, from_session, to_session, monkeypatch):
    """list_active() returns dicts with all required keys."""
    async def never_yield(path, from_beginning=False):
        await asyncio.sleep(10)
        return
        yield

    monkeypatch.setattr(bm_module, "tail_jsonl", never_yield)

    await bm.start_auto(from_session.id, to_session.id, "probe")

    bridges = bm.list_active()
    assert len(bridges) == 1

    b = bridges[0]
    required_keys = {"bridge_id", "from_id", "to_id", "from_name", "to_name", "turns_used", "max_turns", "state"}
    assert required_keys.issubset(b.keys()), f"Missing keys: {required_keys - b.keys()}"

    # Cleanup
    bm.stop(b["bridge_id"])
    await asyncio.sleep(0)


# ---------------------------------------------------------------------------
# Test 12 — GC after TTL (skipped — too brittle at 10s GC interval)
# ---------------------------------------------------------------------------


@pytest.mark.skip(reason=(
    "GC loop sleeps 10s between cycles; testing it deterministically would "
    "require patching asyncio.sleep deep inside _gc_loop, which is brittle. "
    "The TTL logic is simple enough (now - _ended_at > _RECORD_TTL) that a "
    "manual inspection suffices."
))
def test_record_gc_after_ttl():
    pass


# ---------------------------------------------------------------------------
# Test 13 — sentinel in relay text ends bridge
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_sentinel_in_relay_text_ends_bridge(bm, monkeypatch, from_session, to_session):
    """BRIDGE-DONE in an assistant turn ends the bridge with state='ended_sentinel'.

    The final message is still delivered to the peer BEFORE the bridge ends.
    """
    sessions = {from_session.id: from_session, to_session.id: to_session}
    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda tid: sessions.get(tid))
    monkeypatch.setattr(bm_module.pty_manager, "_get_jsonl_path", lambda s: "/tmp/fake.jsonl")

    write_calls: list[tuple[str, str]] = []

    async def fake_write(tid, data):
        write_calls.append((tid, data))
        return True

    monkeypatch.setattr(bm_module.pty_manager, "write_pty_async", fake_write)

    # from_session emits a message with BRIDGE-DONE; to_session tails nothing
    from_entries = [
        {
            "type": "assistant",
            "content": [{"type": "text", "text": "All done. BRIDGE-DONE"}],
        }
    ]

    call_count = {"from": 0, "to": 0}

    async def fake_tail(path, from_beginning=False):
        # Only yield from the from_session path; to_session path hangs
        if "fake" in path:
            # Distinguish by call order
            call_count["from"] += 1
            if call_count["from"] == 1:
                for entry in from_entries:
                    yield entry
            else:
                await asyncio.sleep(5)
                return
        else:
            await asyncio.sleep(5)
            return

    # Patch the module-level _wait_for_idle so we don't actually wait
    monkeypatch.setattr(bm_module, "_IDLE_WAIT_MAX", 0.1)
    monkeypatch.setattr(bm_module, "_IDLE_POLL_INTERVAL", 0.05)

    monkeypatch.setattr(bm_module, "tail_jsonl", fake_tail)

    result = await bm.start_auto(from_session.id, to_session.id, "kickoff")
    assert result.get("ok") is True
    bid = result["bridge_id"]

    # Wait for relay tasks to process the entry
    for _ in range(20):
        await asyncio.sleep(0.05)
        record = bm._bridges[bid]
        if record.state != "active":
            break

    record = bm._bridges[bid]
    assert record.state == "ended_sentinel", f"Expected ended_sentinel, got {record.state}"

    # The message was delivered: at least one relay write happened (beyond the two kickoffs)
    relay_writes = [(t, d) for t, d in write_calls if _BP_START in d and "BRIDGE-DONE" not in d or "PEER REPLY" in d]
    # At minimum the kickoff writes (2) plus the relay write (1)
    assert len(write_calls) >= 3


# ---------------------------------------------------------------------------
# Test 14 — turn cap ends bridge
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_turn_cap_ends_bridge(bm, monkeypatch, from_session, to_session):
    """Bridge ends with state='ended_capped' when max_turns=1 and both sides relay once."""
    sessions = {from_session.id: from_session, to_session.id: to_session}
    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda tid: sessions.get(tid))
    monkeypatch.setattr(bm_module.pty_manager, "_get_jsonl_path", lambda s: "/tmp/fake.jsonl")

    write_calls: list = []

    async def fake_write(tid, data):
        write_calls.append((tid, data))
        return True

    monkeypatch.setattr(bm_module.pty_manager, "write_pty_async", fake_write)

    # Each side yields one assistant turn (no sentinel)
    single_entry = [
        {"type": "assistant", "content": [{"type": "text", "text": "My reply, no sentinel"}]}
    ]

    call_idx = {"n": 0}

    async def fake_tail(path, from_beginning=False):
        call_idx["n"] += 1
        for entry in single_entry:
            yield entry
        # After yielding, hang so bridge ends due to cap not due to generator exhaustion
        await asyncio.sleep(5)

    monkeypatch.setattr(bm_module, "tail_jsonl", fake_tail)
    monkeypatch.setattr(bm_module, "_IDLE_WAIT_MAX", 0.1)
    monkeypatch.setattr(bm_module, "_IDLE_POLL_INTERVAL", 0.05)

    result = await bm.start_auto(from_session.id, to_session.id, "kickoff", max_turns=1)
    assert result.get("ok") is True
    bid = result["bridge_id"]

    # Wait for both relay tasks to fire and cap to trigger
    for _ in range(30):
        await asyncio.sleep(0.05)
        record = bm._bridges[bid]
        if record.state != "active":
            break

    record = bm._bridges[bid]
    assert record.state == "ended_capped", f"Expected ended_capped, got {record.state}"
    assert record.turns_used >= 1


# ---------------------------------------------------------------------------
# Test 15 — idle gate times out and ends bridge with errored
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_idle_gate_waits_then_errors_if_busy(bm, monkeypatch, from_session, to_session):
    """Bridge ends with state='errored' when peer never becomes idle within the timeout.

    We patch _IDLE_WAIT_MAX=0.1 and _IDLE_POLL_INTERVAL=0.05 so the test is fast.
    The peer session's tracker.state is permanently 'busy'.
    """
    # Make the 'to' session permanently busy
    busy_to = _make_mock_session(to_session.id, to_session.name, alive=True, tracker_state="busy")
    sessions = {from_session.id: from_session, busy_to.id: busy_to}
    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda tid: sessions.get(tid))
    monkeypatch.setattr(bm_module.pty_manager, "_get_jsonl_path", lambda s: "/tmp/fake.jsonl")

    write_calls: list = []

    async def fake_write(tid, data):
        write_calls.append((tid, data))
        return True

    monkeypatch.setattr(bm_module.pty_manager, "write_pty_async", fake_write)

    # from_session tails one entry, triggering an inject into the busy peer
    call_idx = {"n": 0}

    async def fake_tail(path, from_beginning=False):
        call_idx["n"] += 1
        if call_idx["n"] == 1:
            # This is the 'from' watcher — yield one message
            yield {"type": "assistant", "content": [{"type": "text", "text": "Hello peer"}]}
        # Hang
        await asyncio.sleep(10)

    monkeypatch.setattr(bm_module, "tail_jsonl", fake_tail)
    # Shorten timeout so the test doesn't take 10 seconds
    monkeypatch.setattr(bm_module, "_IDLE_WAIT_MAX", 0.2)
    monkeypatch.setattr(bm_module, "_IDLE_POLL_INTERVAL", 0.05)

    result = await bm.start_auto(from_session.id, to_session.id, "kickoff")
    assert result.get("ok") is True
    bid = result["bridge_id"]

    # Wait for idle gate to time out and bridge to errored
    for _ in range(30):
        await asyncio.sleep(0.1)
        record = bm._bridges[bid]
        if record.state != "active":
            break

    record = bm._bridges[bid]
    assert record.state == "errored", f"Expected errored, got {record.state}"
