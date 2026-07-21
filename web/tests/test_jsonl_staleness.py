"""JSONL staleness re-resolution after in-terminal /resume (bug #15 family).

When a session's locked JSONL stops growing while the session is still
producing PTY output, _get_jsonl_path must re-lock onto the live file —
without stealing a file claimed by another session.
"""
import os
import time
import types

import pytest

from pty_manager import PtyManager as PTYManager


def _manager_with_sessions(sessions):
    mgr = PTYManager.__new__(PTYManager)  # skip __init__ (spawns cleanup work)
    mgr.sessions = sessions
    return mgr


def _fake_session(sid, claude_id, last_output_offset=1.0):
    return types.SimpleNamespace(
        id=sid,
        claude_session_id=claude_id,
        last_output_time=time.monotonic() - last_output_offset,
    )


def _touch(path, age_seconds):
    path.write_text("{}\n")
    ts = time.time() - age_seconds
    os.utime(path, (ts, ts))


def test_fresh_file_not_stale(tmp_path):
    mgr = _manager_with_sessions({})
    s = _fake_session("t1", "aaa")
    f = tmp_path / "aaa.jsonl"
    _touch(f, age_seconds=5)
    assert mgr._jsonl_is_stale(s, str(f)) is False


def test_stale_file_with_recent_output_detected(tmp_path):
    mgr = _manager_with_sessions({})
    s = _fake_session("t1", "aaa", last_output_offset=2.0)
    f = tmp_path / "aaa.jsonl"
    _touch(f, age_seconds=600)
    assert mgr._jsonl_is_stale(s, str(f)) is True


def test_no_output_activity_never_stale(tmp_path):
    mgr = _manager_with_sessions({})
    s = _fake_session("t1", "aaa")
    s.last_output_time = 0.0
    f = tmp_path / "aaa.jsonl"
    _touch(f, age_seconds=600)
    assert mgr._jsonl_is_stale(s, str(f)) is False


def test_rediscover_picks_live_unclaimed_file(tmp_path):
    s = _fake_session("t1", "aaa")
    other = _fake_session("t2", "ccc")
    mgr = _manager_with_sessions({"t1": s, "t2": other})
    _touch(tmp_path / "aaa.jsonl", age_seconds=600)   # own stale file
    _touch(tmp_path / "bbb.jsonl", age_seconds=3)     # live resumed file
    _touch(tmp_path / "ccc.jsonl", age_seconds=2)     # claimed by other session
    _touch(tmp_path / "ddd.jsonl", age_seconds=9999)  # old junk
    got = mgr._rediscover_jsonl(s, str(tmp_path))
    assert got == str(tmp_path / "bbb.jsonl")
    assert s.claude_session_id == "bbb"


def test_rediscover_returns_none_when_only_claimed_or_old(tmp_path):
    s = _fake_session("t1", "aaa")
    other = _fake_session("t2", "ccc")
    mgr = _manager_with_sessions({"t1": s, "t2": other})
    _touch(tmp_path / "aaa.jsonl", age_seconds=600)
    _touch(tmp_path / "ccc.jsonl", age_seconds=2)
    _touch(tmp_path / "ddd.jsonl", age_seconds=9999)
    assert mgr._rediscover_jsonl(s, str(tmp_path)) is None
    assert s.claude_session_id == "aaa"
