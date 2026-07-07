"""Tests for jsonl_watcher.py — specifically the `start_offset` race-fix parameter.

Covers:
  - tail_jsonl(start_offset=N) delivers an entry written between the caller's
    snapshot and the watcher's first stat/read (the V2/V3 bridge kickoff race).
  - Backward compatibility: start_offset=None (default) preserves the original
    stat-at-discovery behavior for from_beginning=False.
  - from_beginning=True ignores start_offset entirely (reads everything).

These tests exercise the REAL tail_jsonl against a real temp JSONL file — no
monkeypatching of tail_jsonl itself. This is deliberate: bridge_manager's test
suite monkeypatches tail_jsonl everywhere, which is why the watcher-start race
had zero coverage before this fix.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

import pytest

# Make the web/ directory importable without a package install
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import logging_config
logging_config.setup("WARNING")

from jsonl_watcher import tail_jsonl


def _write_entry(path, uuid_suffix: str, text: str) -> None:
    """Append one assistant-type JSONL line to *path*."""
    entry = {
        "type": "assistant",
        "uuid": f"entry-{uuid_suffix}",
        "message": {"content": [{"type": "text", "text": text}]},
    }
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


# ---------------------------------------------------------------------------
# Test 1 — start_offset closes the watcher-start race
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_tail_jsonl_start_offset_delivers_entry_written_before_watcher_starts(tmp_path):
    """An entry written AFTER the snapshot but BEFORE the watcher iterates is
    still delivered when start_offset is passed.

    This reproduces the real bridge_manager sequence:
      1. Snapshot the JSONL file size (0 — file doesn't exist yet, a brand-new
         session).
      2. Inject the kickoff prompt (out of scope here — represented by the
         assistant reply landing in the file).
      3. The reply is appended to the JSONL BEFORE the relay task's watcher
         coroutine actually gets scheduled and starts iterating (async
         generators are lazy; the old code called `path.stat().st_size` only
         at this point, which would already include the new reply and skip
         it forever).
      4. The watcher starts with start_offset=<step 1 snapshot> and must still
         yield the reply from step 3.
    """
    jsonl_path = tmp_path / "session.jsonl"

    # Step 1: snapshot BEFORE the file exists (mirrors a brand-new session).
    snapshot_offset = jsonl_path.stat().st_size if jsonl_path.exists() else 0
    assert snapshot_offset == 0

    # Step 3: the reply lands in the file BEFORE tail_jsonl's generator is
    # ever iterated — this is the exact race window the fix closes.
    _write_entry(jsonl_path, "race", "Reply that arrived before the watcher started")

    # Step 4: start the watcher with the pre-write snapshot as start_offset.
    gen = tail_jsonl(str(jsonl_path), from_beginning=False, start_offset=snapshot_offset)
    try:
        received = await asyncio.wait_for(gen.__anext__(), timeout=2.0)
    finally:
        await gen.aclose()

    assert received["id"] == "entry-race"
    assert received["type"] == "assistant"
    assert received["content"][0]["text"] == "Reply that arrived before the watcher started"


@pytest.mark.asyncio
async def test_tail_jsonl_start_offset_on_preexisting_file_skips_only_prior_history(tmp_path):
    """When the JSONL already has history at snapshot time, start_offset skips
    that history but still picks up content appended after the snapshot —
    even if that append happens before the watcher iterates.
    """
    jsonl_path = tmp_path / "session.jsonl"

    # Pre-existing conversation history (e.g. a resumed session).
    _write_entry(jsonl_path, "old-1", "Old turn 1")
    _write_entry(jsonl_path, "old-2", "Old turn 2")

    # Snapshot AFTER the existing history, BEFORE the kickoff-triggered reply.
    snapshot_offset = jsonl_path.stat().st_size

    # The new reply lands before the watcher ever iterates.
    _write_entry(jsonl_path, "new-1", "New reply after kickoff")

    gen = tail_jsonl(str(jsonl_path), from_beginning=False, start_offset=snapshot_offset)
    try:
        received = await asyncio.wait_for(gen.__anext__(), timeout=2.0)
    finally:
        await gen.aclose()

    # Only the NEW entry is delivered — old history is skipped, as intended
    # for from_beginning=False.
    assert received["id"] == "entry-new-1"


# ---------------------------------------------------------------------------
# Test 2 — backward compatibility: start_offset=None preserves old behavior
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_tail_jsonl_start_offset_none_preserves_stat_at_discovery_behavior(tmp_path):
    """With start_offset=None (the default), from_beginning=False still stats
    the file at watcher-start time and skips pre-existing content — i.e. the
    original contract is unchanged for callers that don't pass start_offset.
    """
    jsonl_path = tmp_path / "session.jsonl"
    _write_entry(jsonl_path, "pre-existing", "Content written before the watcher starts")

    gen = tail_jsonl(str(jsonl_path), from_beginning=False)
    try:
        # No start_offset passed — the pre-existing entry must NOT be yielded.
        # Give the generator a moment to (not) produce anything, then assert
        # nothing arrived within a short window.
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(gen.__anext__(), timeout=0.5)
    finally:
        await gen.aclose()


@pytest.mark.asyncio
async def test_tail_jsonl_from_beginning_ignores_start_offset(tmp_path):
    """from_beginning=True reads all existing content regardless of start_offset."""
    jsonl_path = tmp_path / "session.jsonl"
    _write_entry(jsonl_path, "a", "First")
    _write_entry(jsonl_path, "b", "Second")

    received = []
    gen = tail_jsonl(str(jsonl_path), from_beginning=True, start_offset=999999)
    try:
        received.append(await asyncio.wait_for(gen.__anext__(), timeout=2.0))
        received.append(await asyncio.wait_for(gen.__anext__(), timeout=2.0))
    finally:
        await gen.aclose()

    ids = {r["id"] for r in received}
    assert ids == {"entry-a", "entry-b"}
