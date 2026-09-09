"""Tests for the `updated_at` / `preview` fields on `GET /remote/v1/sessions`.

Two layers, both covered here: the tail reader itself (`jsonl_watcher.latest_preview`)
and the gateway's derivation (`remote_gateway._session_view` / `_session_updated_at` /
`_session_preview`), which decides what a Codex session (no jsonl_path) and a missing
transcript get instead of guessing.
"""

from __future__ import annotations

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import jsonl_watcher  # noqa: E402
import remote_gateway  # noqa: E402


def _write_jsonl(path, lines):
    with open(path, "w", encoding="utf-8") as f:
        for line in lines:
            f.write(json.dumps(line) + "\n")


def user_line(text, ts="2026-09-08T00:00:00+00:00"):
    return {
        "type": "user",
        "uuid": "u1",
        "timestamp": ts,
        "message": {"role": "user", "content": text},
    }


def user_tool_result_line(ts="2026-09-08T00:00:01+00:00"):
    return {
        "type": "user",
        "uuid": "u2",
        "timestamp": ts,
        "message": {
            "role": "user",
            "content": [
                {"type": "tool_result", "tool_use_id": "x", "content": "ok"},
            ],
        },
    }


def assistant_text_line(text, ts="2026-09-08T00:00:02+00:00"):
    return {
        "type": "assistant",
        "uuid": "a1",
        "timestamp": ts,
        "message": {"role": "assistant", "content": [{"type": "text", "text": text}]},
    }


def assistant_tool_use_line(ts="2026-09-08T00:00:03+00:00"):
    return {
        "type": "assistant",
        "uuid": "a2",
        "timestamp": ts,
        "message": {
            "role": "assistant",
            "content": [{"type": "tool_use", "name": "Bash", "id": "t1", "input": {}}],
        },
    }


# -- jsonl_watcher.latest_preview -------------------------------------------


def test_latest_preview_last_qualifying_record_wins(tmp_path):
    path = tmp_path / "s.jsonl"
    _write_jsonl(path, [
        user_line("first message"),
        assistant_text_line("second message"),
    ])
    result = jsonl_watcher.latest_preview(str(path))
    assert result == {
        "role": "assistant",
        "text": "second message",
        "timestamp": "2026-09-08T00:00:02+00:00",
    }


def test_latest_preview_skips_tool_result_only_user_record(tmp_path):
    path = tmp_path / "s.jsonl"
    _write_jsonl(path, [
        user_line("first message"),
        user_tool_result_line(),
    ])
    result = jsonl_watcher.latest_preview(str(path))
    assert result["role"] == "user"
    assert result["text"] == "first message"


def test_latest_preview_skips_tool_use_only_assistant_record(tmp_path):
    path = tmp_path / "s.jsonl"
    _write_jsonl(path, [
        user_line("hello"),
        assistant_tool_use_line(),
    ])
    result = jsonl_watcher.latest_preview(str(path))
    assert result["role"] == "user"
    assert result["text"] == "hello"


def test_latest_preview_skips_meta_and_system(tmp_path):
    path = tmp_path / "s.jsonl"
    _write_jsonl(path, [
        {"type": "user", "uuid": "m1", "timestamp": "t", "isMeta": True,
         "message": {"role": "user", "content": "system prompt junk"}},
        {"type": "system", "uuid": "s1", "timestamp": "t",
         "message": {"role": "system", "content": "boot"}},
        user_line("real message"),
    ])
    result = jsonl_watcher.latest_preview(str(path))
    assert result["text"] == "real message"


def test_latest_preview_collapses_whitespace_and_truncates(tmp_path):
    path = tmp_path / "s.jsonl"
    long_text = ("word " * 60).strip()
    _write_jsonl(path, [user_line("  line one\n\tline   two  ")])
    result = jsonl_watcher.latest_preview(str(path))
    assert result["text"] == "line one line two"

    _write_jsonl(path, [user_line(long_text)])
    # Force the cache to recompute -- new content, same path, mtime/size differ.
    result2 = jsonl_watcher.latest_preview(str(path))
    assert len(result2["text"]) <= jsonl_watcher.MAX_PREVIEW_TEXT_LEN
    assert result2["text"].endswith("…")


def test_latest_preview_missing_file_is_none(tmp_path):
    assert jsonl_watcher.latest_preview(str(tmp_path / "nope.jsonl")) is None


def test_latest_preview_no_qualifying_record_is_none(tmp_path):
    path = tmp_path / "s.jsonl"
    _write_jsonl(path, [user_tool_result_line(), assistant_tool_use_line()])
    assert jsonl_watcher.latest_preview(str(path)) is None


def test_latest_preview_walks_backward_past_tool_only_tail(tmp_path):
    path = tmp_path / "s.jsonl"
    lines = [user_line("the real question")]
    # Pad with enough tool_result-only records to push well past a single
    # 64 KB tail window of tool-only records.
    for i in range(2000):
        lines.append(user_tool_result_line(ts=f"pad-{i}"))
    _write_jsonl(path, lines)
    result = jsonl_watcher.latest_preview(str(path), tail_bytes=65536)
    assert result["text"] == "the real question"


def test_latest_preview_respects_max_bytes_ceiling(tmp_path):
    path = tmp_path / "s.jsonl"
    lines = [user_line("only text, way back at the start")]
    # Pad past 5 MB so the text sits far outside a small max_bytes budget.
    padding_line = json.dumps(user_tool_result_line())
    pad_count = (5 * 1024 * 1024) // (len(padding_line) + 1)
    lines.extend(user_tool_result_line(ts=f"pad-{i}") for i in range(pad_count))
    _write_jsonl(path, lines)
    result = jsonl_watcher.latest_preview(
        str(path), tail_bytes=65536, max_bytes=65536
    )
    assert result is None


def test_latest_preview_skips_task_notification_user_record(tmp_path):
    path = tmp_path / "s.jsonl"
    _write_jsonl(path, [
        assistant_text_line("prior assistant reply"),
        user_line("<task-notification>background task finished</task-notification>"),
    ])
    result = jsonl_watcher.latest_preview(str(path))
    assert result["role"] == "assistant"
    assert result["text"] == "prior assistant reply"


def test_latest_preview_skips_command_args_only_record(tmp_path):
    """A slash-command's empty <command-args></command-args> is not a preview (SPEC §2)."""
    path = tmp_path / "s.jsonl"
    _write_jsonl(path, [
        assistant_text_line("prior assistant reply"),
        user_line("<command-args></command-args>"),
    ])
    result = jsonl_watcher.latest_preview(str(path))
    assert result["role"] == "assistant"
    assert result["text"] == "prior assistant reply"


def test_latest_preview_skips_self_closing_tag_only_residue(tmp_path):
    """Belt to the blocklist's braces: any leftover self-closing tag markup, not just
    the known blocklist, fails to qualify as a preview."""
    path = tmp_path / "s.jsonl"
    _write_jsonl(path, [
        assistant_text_line("prior assistant reply"),
        user_line("<some-future-tag/>"),
    ])
    result = jsonl_watcher.latest_preview(str(path))
    assert result["role"] == "assistant"
    assert result["text"] == "prior assistant reply"


def test_latest_preview_strips_leading_system_reminder(tmp_path):
    path = tmp_path / "s.jsonl"
    _write_jsonl(path, [
        user_line("<system-reminder>x</system-reminder>real words"),
    ])
    result = jsonl_watcher.latest_preview(str(path))
    assert result["role"] == "user"
    assert result["text"] == "real words"


def test_latest_preview_cache_reflects_mtime_and_size_change(tmp_path):
    path = tmp_path / "s.jsonl"
    _write_jsonl(path, [user_line("one")])
    first = jsonl_watcher.latest_preview(str(path))
    assert first["text"] == "one"

    time.sleep(0.01)
    _write_jsonl(path, [user_line("one"), assistant_text_line("two")])
    second = jsonl_watcher.latest_preview(str(path))
    assert second["text"] == "two"


# -- remote_gateway derivation -----------------------------------------------


def test_session_updated_at_uses_jsonl_mtime(tmp_path):
    path = tmp_path / "s.jsonl"
    _write_jsonl(path, [user_line("hi")])
    entry = {"jsonl_path": str(path), "created_at": "2020-01-01T00:00:00+00:00"}
    updated = remote_gateway._session_updated_at(entry)
    assert updated is not None
    assert updated != entry["created_at"]


def test_session_updated_at_falls_back_to_created_at_when_no_jsonl(tmp_path):
    entry = {"jsonl_path": None, "created_at": "2020-01-01T00:00:00+00:00"}
    assert remote_gateway._session_updated_at(entry) == "2020-01-01T00:00:00+00:00"


def test_session_updated_at_falls_back_when_jsonl_missing_on_disk():
    entry = {"jsonl_path": "C:/does/not/exist.jsonl", "created_at": "2020-01-01T00:00:00+00:00"}
    assert remote_gateway._session_updated_at(entry) == "2020-01-01T00:00:00+00:00"


def test_session_preview_none_without_jsonl_path():
    entry = {"jsonl_path": None}
    assert remote_gateway._session_preview(entry) is None


def test_session_preview_reads_the_file(tmp_path):
    path = tmp_path / "s.jsonl"
    _write_jsonl(path, [user_line("preview me")])
    entry = {"jsonl_path": str(path)}
    preview = remote_gateway._session_preview(entry)
    assert preview == {
        "role": "user",
        "text": "preview me",
        "timestamp": "2026-09-08T00:00:00+00:00",
    }


def test_session_view_derives_and_still_hides_jsonl_path(tmp_path):
    path = tmp_path / "s.jsonl"
    _write_jsonl(path, [assistant_text_line("done")])
    entry = {
        "id": "t1",
        "name": "work",
        "harness": "claude-code",
        "model": "claude-opus-5",
        "working_dir": "C:/tmp",
        "alive": True,
        "activity_state": "idle",
        "created_at": "2020-01-01T00:00:00+00:00",
        "jsonl_path": str(path),
        "cost": 9.99,
        "tokens": 123,
        "claude_session_id": "abc",
    }
    view = remote_gateway._session_view(entry)
    assert list(view) == list(remote_gateway.SESSION_FIELDS)
    assert "jsonl_path" not in view
    assert "cost" not in view
    assert view["preview"] == {
        "role": "assistant",
        "text": "done",
        "timestamp": "2026-09-08T00:00:02+00:00",
    }
    assert view["updated_at"] is not None


def test_session_view_codex_gets_null_preview_and_created_at_fallback():
    entry = {
        "id": "t2",
        "name": "codex work",
        "harness": "codex",
        "model": "gpt-6-astra",
        "working_dir": "C:/tmp",
        "alive": True,
        "activity_state": "idle",
        "created_at": "2020-01-01T00:00:00+00:00",
        "jsonl_path": None,
    }
    view = remote_gateway._session_view(entry)
    assert view["preview"] is None
    assert view["updated_at"] == "2020-01-01T00:00:00+00:00"


# -- preview markdown stripping ---------------------------------------------


def test_latest_preview_strips_bold_and_italic_markers(tmp_path):
    path = tmp_path / "s.jsonl"
    _write_jsonl(path, [assistant_text_line("**Install these two** then _restart_.")])
    result = jsonl_watcher.latest_preview(str(path))
    assert result["text"] == "Install these two then restart."


def test_latest_preview_strips_inline_backticks(tmp_path):
    path = tmp_path / "s.jsonl"
    _write_jsonl(path, [assistant_text_line("run `npm install` first")])
    result = jsonl_watcher.latest_preview(str(path))
    assert result["text"] == "run npm install first"


def test_latest_preview_strips_leading_heading_and_list_markers(tmp_path):
    path = tmp_path / "s.jsonl"
    _write_jsonl(path, [assistant_text_line("# Heading\n- item one\n> quoted")])
    result = jsonl_watcher.latest_preview(str(path))
    assert "#" not in result["text"]
    assert result["text"] == "Heading item one quoted"


def test_latest_preview_underscore_in_identifier_not_treated_as_emphasis(tmp_path):
    path = tmp_path / "s.jsonl"
    _write_jsonl(path, [assistant_text_line("edit my_file_name.py please")])
    result = jsonl_watcher.latest_preview(str(path))
    assert result["text"] == "edit my_file_name.py please"
