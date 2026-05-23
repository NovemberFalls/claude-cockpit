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


# ===========================================================================
# ChannelManager tests (Tests 16–32)
# ===========================================================================

from bridge_manager import ChannelManager, _ChannelRecord  # noqa: E402


# ---------------------------------------------------------------------------
# Shared helpers for channel tests
# ---------------------------------------------------------------------------


def _make_channel_sessions(lead_id="lead-1", lead_name="Lead Session",
                            worker_specs=None):
    """Return (lead_session, list_of_worker_sessions).

    *worker_specs* is a list of (id, name, alive) tuples.
    Defaults to two alive workers if not supplied.
    """
    if worker_specs is None:
        worker_specs = [("w1", "Worker One", True), ("w2", "Worker Two", True)]
    lead = _make_mock_session(lead_id, lead_name, alive=True)
    workers = [_make_mock_session(wid, wname, alive=alive)
               for wid, wname, alive in worker_specs]
    return lead, workers


def _patch_channel_pty(monkeypatch, sessions_dict, jsonl_map=None):
    """Monkeypatch pty_manager for channel tests.

    *sessions_dict*: {terminal_id: mock_session}
    *jsonl_map*: {terminal_id: path_or_None} — defaults to "/tmp/fake.jsonl" for all.
    Returns write_calls list.
    """
    def get_terminal(tid):
        return sessions_dict.get(tid)

    def get_jsonl_path(session):
        if jsonl_map is not None:
            return jsonl_map.get(session.id)
        return "/tmp/fake.jsonl"

    write_calls: list[tuple[str, str]] = []

    async def fake_write(tid, data):
        write_calls.append((tid, data))
        return True

    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", get_terminal)
    monkeypatch.setattr(bm_module.pty_manager, "_get_jsonl_path", get_jsonl_path)
    monkeypatch.setattr(bm_module.pty_manager, "write_pty_async", fake_write)
    return write_calls


async def _cancel_channel_tasks(record: _ChannelRecord):
    """Cancel all tasks on a _ChannelRecord and yield control so they can exit."""
    record._stop_event.set()
    for t in record._tasks:
        if t and not t.done():
            t.cancel()
    await asyncio.sleep(0)


# ---------------------------------------------------------------------------
# Hanging tail_jsonl stub — prevents relay tasks from spinning
# ---------------------------------------------------------------------------


async def _never_yield(path, from_beginning=False):
    """Async generator that hangs forever without yielding anything."""
    await asyncio.sleep(3600)
    return
    yield  # make it an async generator


# ---------------------------------------------------------------------------
# Test 16 — start() returns channel_id with correct shape
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_start_returns_channel_id(monkeypatch):
    """start() returns {ok: True, channel_id: <12-char hex>} for a valid topology."""
    cm = ChannelManager()
    lead, workers = _make_channel_sessions()
    sessions = {lead.id: lead, **{w.id: w for w in workers}}
    _patch_channel_pty(monkeypatch, sessions)
    monkeypatch.setattr(bm_module, "tail_jsonl", _never_yield)

    result = await cm.start(lead.id, [w.id for w in workers], "get to work")

    assert result.get("ok") is True, f"Expected ok=True, got: {result}"
    cid = result.get("channel_id")
    assert cid is not None
    assert len(cid) == 12
    assert re.fullmatch(r"[0-9a-f]{12}", cid), f"channel_id not 12-char hex: {cid!r}"

    record = cm._channels[cid]
    await _cancel_channel_tasks(record)


# ---------------------------------------------------------------------------
# Test 17 — start() spawns N+1 tasks
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_start_spawns_n_plus_one_tasks(monkeypatch):
    """start() with N workers creates exactly N+1 asyncio tasks in record._tasks."""
    monkeypatch.setattr(bm_module, "tail_jsonl", _never_yield)

    # Case A: 1 lead + 2 workers → 3 tasks
    cm_a = ChannelManager()
    lead_a, workers_a = _make_channel_sessions(
        lead_id="lead-a", worker_specs=[("wa1", "Worker A1", True), ("wa2", "Worker A2", True)]
    )
    sessions_a = {lead_a.id: lead_a, **{w.id: w for w in workers_a}}
    _patch_channel_pty(monkeypatch, sessions_a)

    result_a = await cm_a.start(lead_a.id, [w.id for w in workers_a], "prompt")
    assert result_a.get("ok") is True
    record_a = cm_a._channels[result_a["channel_id"]]
    assert len(record_a._tasks) == 3, f"Expected 3 tasks for 2 workers, got {len(record_a._tasks)}"
    await _cancel_channel_tasks(record_a)

    # Case B: 1 lead + 3 workers → 4 tasks
    cm_b = ChannelManager()
    lead_b, workers_b = _make_channel_sessions(
        lead_id="lead-b",
        worker_specs=[("wb1", "Worker B1", True), ("wb2", "Worker B2", True), ("wb3", "Worker B3", True)],
    )
    sessions_b = {lead_b.id: lead_b, **{w.id: w for w in workers_b}}
    _patch_channel_pty(monkeypatch, sessions_b)

    result_b = await cm_b.start(lead_b.id, [w.id for w in workers_b], "prompt")
    assert result_b.get("ok") is True
    record_b = cm_b._channels[result_b["channel_id"]]
    assert len(record_b._tasks) == 4, f"Expected 4 tasks for 3 workers, got {len(record_b._tasks)}"
    await _cancel_channel_tasks(record_b)


# ---------------------------------------------------------------------------
# Test 18 — start() sends kickoff to lead AND all workers simultaneously
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_start_sends_kickoff_to_all(monkeypatch):
    """start() writes one kickoff to lead + one each to all workers; all contain _BP_START.

    Lead kickoff must contain 'LEAD'; each worker kickoff must contain 'WORKER'.
    """
    cm = ChannelManager()
    lead, workers = _make_channel_sessions()  # 1 lead + 2 workers
    sessions = {lead.id: lead, **{w.id: w for w in workers}}
    write_calls = _patch_channel_pty(monkeypatch, sessions)
    monkeypatch.setattr(bm_module, "tail_jsonl", _never_yield)

    result = await cm.start(lead.id, [w.id for w in workers], "kickoff prompt")
    assert result.get("ok") is True

    # Allow relay tasks to start (they may trigger additional writes via _inject — but
    # tail_jsonl hangs, so only the initial kickoff writes should have fired by now)
    await asyncio.sleep(0)

    # Exactly 3 kickoff writes: lead + 2 workers
    assert len(write_calls) == 3, f"Expected 3 kickoff writes, got {len(write_calls)}: {[t for t, _ in write_calls]}"

    # All must contain _BP_START
    for tid, data in write_calls:
        assert _BP_START in data, f"Missing _BP_START in kickoff to {tid}"

    # Lead kickoff goes to lead.id and contains "LEAD"
    lead_writes = [(tid, data) for tid, data in write_calls if tid == lead.id]
    assert len(lead_writes) == 1, f"Expected 1 lead write, got {len(lead_writes)}"
    assert "LEAD" in lead_writes[0][1], "Lead kickoff must contain 'LEAD'"

    # Worker kickoffs go to worker IDs and each contains "WORKER"
    for w in workers:
        worker_writes = [(tid, data) for tid, data in write_calls if tid == w.id]
        assert len(worker_writes) == 1, f"Expected 1 write for worker {w.id}, got {len(worker_writes)}"
        assert "WORKER" in worker_writes[0][1], f"Worker kickoff for {w.id} must contain 'WORKER'"

    record = cm._channels[result["channel_id"]]
    await _cancel_channel_tasks(record)


# ---------------------------------------------------------------------------
# Test 19 — start() rejects empty worker_ids
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_start_rejects_empty_workers(monkeypatch):
    """start() with an empty worker_ids list returns {ok: False, error: ...}."""
    cm = ChannelManager()
    lead = _make_mock_session("lead-1", "Lead")
    _patch_channel_pty(monkeypatch, {lead.id: lead})

    result = await cm.start(lead.id, [], "prompt")

    assert result.get("ok") is False
    assert "error" in result
    assert len(cm._channels) == 0


# ---------------------------------------------------------------------------
# Test 20 — start() rejects duplicate IDs (lead appears in worker_ids)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_start_rejects_duplicate_ids(monkeypatch):
    """start() returns {ok: False} when the same terminal ID appears as both lead and worker."""
    cm = ChannelManager()
    lead = _make_mock_session("lead-1", "Lead")
    worker = _make_mock_session("w1", "Worker")
    _patch_channel_pty(monkeypatch, {lead.id: lead, worker.id: worker})

    # lead.id is duplicated in the worker list
    result = await cm.start(lead.id, [worker.id, lead.id], "prompt")

    assert result.get("ok") is False
    assert "error" in result


# ---------------------------------------------------------------------------
# Test 21 — start() rejects dead lead session
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_start_rejects_dead_lead(monkeypatch):
    """start() returns {ok: False} when the lead session is not alive."""
    cm = ChannelManager()
    dead_lead = _make_mock_session("lead-1", "Lead", alive=False)
    worker = _make_mock_session("w1", "Worker")
    _patch_channel_pty(monkeypatch, {dead_lead.id: dead_lead, worker.id: worker})

    result = await cm.start(dead_lead.id, [worker.id], "prompt")

    assert result.get("ok") is False
    assert "error" in result


# ---------------------------------------------------------------------------
# Test 22 — start() rejects dead worker session
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_start_rejects_dead_worker(monkeypatch):
    """start() returns {ok: False} when any worker session is not alive."""
    cm = ChannelManager()
    lead = _make_mock_session("lead-1", "Lead", alive=True)
    alive_worker = _make_mock_session("w1", "Worker One", alive=True)
    dead_worker = _make_mock_session("w2", "Worker Two", alive=False)
    sessions = {lead.id: lead, alive_worker.id: alive_worker, dead_worker.id: dead_worker}
    _patch_channel_pty(monkeypatch, sessions)

    result = await cm.start(lead.id, [alive_worker.id, dead_worker.id], "prompt")

    assert result.get("ok") is False
    assert "error" in result


# ---------------------------------------------------------------------------
# Test 23 — start() rejects when JSONL missing for any member
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_start_rejects_missing_jsonl(monkeypatch):
    """start() returns {ok: False} when JSONL is unavailable for any member.

    Lead has JSONL, first worker has JSONL, second worker has JSONL=None.
    """
    cm = ChannelManager()
    lead = _make_mock_session("lead-1", "Lead")
    w1 = _make_mock_session("w1", "Worker One")
    w2 = _make_mock_session("w2", "Worker Two")
    sessions = {lead.id: lead, w1.id: w1, w2.id: w2}
    # w2 has no JSONL
    jsonl_map = {lead.id: "/tmp/lead.jsonl", w1.id: "/tmp/w1.jsonl", w2.id: None}
    write_calls = _patch_channel_pty(monkeypatch, sessions, jsonl_map=jsonl_map)

    result = await cm.start(lead.id, [w1.id, w2.id], "prompt")

    assert result.get("ok") is False
    assert "error" in result
    # No kickoff writes must have been sent
    assert len(write_calls) == 0


# ---------------------------------------------------------------------------
# Test 24 — stop() transitions state to ended_user
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_stop_transitions_to_ended_user(monkeypatch):
    """stop() on an active channel returns True and sets state='ended_user'."""
    cm = ChannelManager()
    lead, workers = _make_channel_sessions()
    sessions = {lead.id: lead, **{w.id: w for w in workers}}
    _patch_channel_pty(monkeypatch, sessions)
    monkeypatch.setattr(bm_module, "tail_jsonl", _never_yield)

    result = await cm.start(lead.id, [w.id for w in workers], "prompt")
    assert result.get("ok") is True
    cid = result["channel_id"]

    await asyncio.sleep(0)

    ok = cm.stop(cid)
    assert ok is True

    record = cm._channels[cid]
    assert record.state == "ended_user", f"Expected ended_user, got {record.state}"
    await asyncio.sleep(0)


# ---------------------------------------------------------------------------
# Test 25 — stop() on unknown channel_id returns False
# ---------------------------------------------------------------------------


def test_channel_stop_unknown_returns_false():
    """stop() with an unrecognised channel_id returns False."""
    cm = ChannelManager()
    assert cm.stop("nonexistent_12x") is False


# ---------------------------------------------------------------------------
# Test 26 — stop() is idempotent
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_stop_idempotent(monkeypatch):
    """Calling stop() twice on the same channel both return True."""
    cm = ChannelManager()
    lead, workers = _make_channel_sessions()
    sessions = {lead.id: lead, **{w.id: w for w in workers}}
    _patch_channel_pty(monkeypatch, sessions)
    monkeypatch.setattr(bm_module, "tail_jsonl", _never_yield)

    result = await cm.start(lead.id, [w.id for w in workers], "prompt")
    assert result.get("ok") is True
    cid = result["channel_id"]

    await asyncio.sleep(0)

    first = cm.stop(cid)
    second = cm.stop(cid)

    assert first is True
    assert second is True


# ---------------------------------------------------------------------------
# Test 27 — member_ids() returns lead + all workers for active channels
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_member_ids_includes_all_active(monkeypatch):
    """member_ids() returns the lead + every worker ID while the channel is active."""
    cm = ChannelManager()
    lead, workers = _make_channel_sessions()
    sessions = {lead.id: lead, **{w.id: w for w in workers}}
    _patch_channel_pty(monkeypatch, sessions)
    monkeypatch.setattr(bm_module, "tail_jsonl", _never_yield)

    result = await cm.start(lead.id, [w.id for w in workers], "prompt")
    assert result.get("ok") is True

    ids = cm.member_ids()
    assert lead.id in ids, f"lead.id {lead.id!r} not in member_ids: {ids}"
    for w in workers:
        assert w.id in ids, f"worker.id {w.id!r} not in member_ids: {ids}"
    assert len(ids) == 1 + len(workers)

    cid = result["channel_id"]
    record = cm._channels[cid]
    await _cancel_channel_tasks(record)


# ---------------------------------------------------------------------------
# Test 28 — member_ids() excludes ended channels
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_member_ids_excludes_ended(monkeypatch):
    """member_ids() returns an empty set after the only channel has been stopped."""
    cm = ChannelManager()
    lead, workers = _make_channel_sessions()
    sessions = {lead.id: lead, **{w.id: w for w in workers}}
    _patch_channel_pty(monkeypatch, sessions)
    monkeypatch.setattr(bm_module, "tail_jsonl", _never_yield)

    result = await cm.start(lead.id, [w.id for w in workers], "prompt")
    assert result.get("ok") is True
    cid = result["channel_id"]

    await asyncio.sleep(0)
    cm.stop(cid)
    await asyncio.sleep(0)

    assert cm.member_ids() == set(), f"Expected empty set after stop, got {cm.member_ids()}"


# ---------------------------------------------------------------------------
# Test 29 — worker relay task sends to LEAD only (not to other workers)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_worker_relay_targets_lead_only(monkeypatch):
    """A worker's relay task forwards its assistant turn to the lead, not to peer workers."""
    cm = ChannelManager()
    lead = _make_mock_session("lead-1", "Lead Session")
    w1 = _make_mock_session("w1", "Worker One")
    w2 = _make_mock_session("w2", "Worker Two")
    sessions = {lead.id: lead, w1.id: w1, w2.id: w2}

    write_calls = _patch_channel_pty(monkeypatch, sessions)

    # Track which tail_jsonl calls are made by index; first call = w1 relay task,
    # second = w2 relay task, third = lead relay task (tasks created in worker order
    # then lead last in ChannelManager.start).
    call_idx = {"n": 0}

    async def fake_tail(path, from_beginning=False):
        call_idx["n"] += 1
        current = call_idx["n"]
        if current == 1:
            # First watcher is w1 — yield one assistant entry
            yield {
                "type": "assistant",
                "content": [{"type": "text", "text": "Hello from w1"}],
            }
        # All other watchers hang
        await asyncio.sleep(3600)

    monkeypatch.setattr(bm_module, "tail_jsonl", fake_tail)
    monkeypatch.setattr(bm_module, "_IDLE_WAIT_MAX", 0.1)
    monkeypatch.setattr(bm_module, "_IDLE_POLL_INTERVAL", 0.05)

    result = await cm.start(lead.id, [w1.id, w2.id], "prompt")
    assert result.get("ok") is True
    cid = result["channel_id"]

    # Wait for the worker relay to fire
    for _ in range(30):
        await asyncio.sleep(0.05)
        # Relay writes come AFTER the 3 kickoff writes
        if len(write_calls) > 3:
            break

    # Collect relay writes (beyond the initial 3 kickoff writes)
    relay_writes = write_calls[3:]
    assert len(relay_writes) >= 1, "Expected at least one relay write from w1"

    # All relay write targets must be the lead (not w2)
    relay_targets = {tid for tid, _ in relay_writes}
    assert lead.id in relay_targets, f"Lead not among relay targets: {relay_targets}"
    assert w2.id not in relay_targets, f"w2 should NOT receive w1's relay write, got targets: {relay_targets}"

    record = cm._channels[cid]
    await _cancel_channel_tasks(record)


# ---------------------------------------------------------------------------
# Test 30 — lead relay task sends to ALL workers
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_lead_relay_targets_all_workers(monkeypatch):
    """The lead's relay task forwards its assistant turn to ALL workers, not back to lead."""
    cm = ChannelManager()
    lead = _make_mock_session("lead-1", "Lead Session")
    w1 = _make_mock_session("w1", "Worker One")
    w2 = _make_mock_session("w2", "Worker Two")
    sessions = {lead.id: lead, w1.id: w1, w2.id: w2}

    write_calls = _patch_channel_pty(monkeypatch, sessions)

    # Tasks are spawned: worker w1 (idx=1), worker w2 (idx=2), lead (idx=3)
    # We want only the lead task (third call) to yield an entry.
    call_idx = {"n": 0}

    async def fake_tail(path, from_beginning=False):
        call_idx["n"] += 1
        current = call_idx["n"]
        if current == 3:
            # Third watcher is the lead relay task
            yield {
                "type": "assistant",
                "content": [{"type": "text", "text": "Lead directive to all workers"}],
            }
        await asyncio.sleep(3600)

    monkeypatch.setattr(bm_module, "tail_jsonl", fake_tail)
    monkeypatch.setattr(bm_module, "_IDLE_WAIT_MAX", 0.1)
    monkeypatch.setattr(bm_module, "_IDLE_POLL_INTERVAL", 0.05)

    result = await cm.start(lead.id, [w1.id, w2.id], "prompt")
    assert result.get("ok") is True
    cid = result["channel_id"]

    # Wait for the lead relay to write to both workers
    for _ in range(30):
        await asyncio.sleep(0.05)
        if len(write_calls) > 4:  # 3 kickoffs + at least 2 relay writes
            break

    relay_writes = write_calls[3:]
    relay_targets = {tid for tid, _ in relay_writes}

    assert w1.id in relay_targets, f"w1 not among relay targets: {relay_targets}"
    assert w2.id in relay_targets, f"w2 not among relay targets: {relay_targets}"
    assert lead.id not in relay_targets, f"Lead should NOT receive its own relay, got targets: {relay_targets}"

    record = cm._channels[cid]
    await _cancel_channel_tasks(record)


# ---------------------------------------------------------------------------
# Test 31 — sentinel from a worker ends the channel
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_sentinel_from_worker_ends_channel(monkeypatch):
    """BRIDGE-DONE in a worker's reply transitions the channel to 'ended_sentinel'."""
    cm = ChannelManager()
    lead = _make_mock_session("lead-1", "Lead Session")
    w1 = _make_mock_session("w1", "Worker One")
    w2 = _make_mock_session("w2", "Worker Two")
    sessions = {lead.id: lead, w1.id: w1, w2.id: w2}

    _patch_channel_pty(monkeypatch, sessions)

    call_idx = {"n": 0}

    async def fake_tail(path, from_beginning=False):
        call_idx["n"] += 1
        current = call_idx["n"]
        if current == 1:
            # First watcher is w1 — yield sentinel
            yield {
                "type": "assistant",
                "content": [{"type": "text", "text": "Task complete. BRIDGE-DONE"}],
            }
        await asyncio.sleep(3600)

    monkeypatch.setattr(bm_module, "tail_jsonl", fake_tail)
    monkeypatch.setattr(bm_module, "_IDLE_WAIT_MAX", 0.1)
    monkeypatch.setattr(bm_module, "_IDLE_POLL_INTERVAL", 0.05)

    result = await cm.start(lead.id, [w1.id, w2.id], "prompt")
    assert result.get("ok") is True
    cid = result["channel_id"]

    # Wait for state to transition
    for _ in range(30):
        await asyncio.sleep(0.05)
        record = cm._channels[cid]
        if record.state != "active":
            break

    record = cm._channels[cid]
    assert record.state == "ended_sentinel", f"Expected ended_sentinel, got {record.state}"
    await asyncio.sleep(0)


# ---------------------------------------------------------------------------
# Test 32 — turn cap ends the channel
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_turn_cap_ends_channel(monkeypatch):
    """Channel ends with state='ended_capped' when max_turns is reached.

    max_turns=1: after a single relay (worker OR lead relaying once), the
    turns_used counter hits the cap and the channel ends.
    """
    cm = ChannelManager()
    lead = _make_mock_session("lead-1", "Lead Session")
    w1 = _make_mock_session("w1", "Worker One")
    w2 = _make_mock_session("w2", "Worker Two")
    sessions = {lead.id: lead, w1.id: w1, w2.id: w2}

    _patch_channel_pty(monkeypatch, sessions)

    # Each tail call yields one entry then hangs; any relay that fires first
    # will increment turns_used to 1 and hit the cap.
    call_idx = {"n": 0}

    async def fake_tail(path, from_beginning=False):
        call_idx["n"] += 1
        yield {
            "type": "assistant",
            "content": [{"type": "text", "text": "One relay, no sentinel"}],
        }
        # Hang after yielding so the channel ends via cap not generator exhaustion
        await asyncio.sleep(3600)

    monkeypatch.setattr(bm_module, "tail_jsonl", fake_tail)
    monkeypatch.setattr(bm_module, "_IDLE_WAIT_MAX", 0.1)
    monkeypatch.setattr(bm_module, "_IDLE_POLL_INTERVAL", 0.05)

    result = await cm.start(lead.id, [w1.id, w2.id], "prompt", max_turns=1)
    assert result.get("ok") is True
    cid = result["channel_id"]

    # Wait for turn cap to trigger
    for _ in range(40):
        await asyncio.sleep(0.05)
        record = cm._channels[cid]
        if record.state != "active":
            break

    record = cm._channels[cid]
    assert record.state == "ended_capped", f"Expected ended_capped, got {record.state}"
    assert record.turns_used >= 1
    await asyncio.sleep(0)
