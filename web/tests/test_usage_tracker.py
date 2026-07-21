"""Tests for web/usage_tracker.py — pricing, cost math, ingest, and summaries."""

import json
import tempfile
from pathlib import Path

import pytest

from usage_tracker import UsageTracker, _pricing_for, _row_cost, PRICING, DEFAULT_PRICING


@pytest.fixture()
def tracker(tmp_path):
    db_path = tmp_path / "usage.sqlite3"
    t = UsageTracker(db_path=db_path)
    yield t
    t.close()


def _assistant_line(uuid, model="claude-opus-4", input_tokens=100, output_tokens=50,
                     cache_creation=0, cache_read=0, ts="2026-07-19T10:00:00Z"):
    return json.dumps({
        "type": "assistant",
        "uuid": uuid,
        "timestamp": ts,
        "message": {
            "model": model,
            "usage": {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cache_creation_input_tokens": cache_creation,
                "cache_read_input_tokens": cache_read,
            },
        },
    })


# --- pricing lookup ---------------------------------------------------------

def test_pricing_prefix_lookup():
    assert _pricing_for("claude-opus-4-20260101") == PRICING["claude-opus"]
    assert _pricing_for("claude-sonnet-5") == PRICING["claude-sonnet"]
    assert _pricing_for("claude-haiku-3") == PRICING["claude-haiku"]


def test_pricing_fallback_for_unknown_model():
    assert _pricing_for("some-unknown-model") == DEFAULT_PRICING
    assert _pricing_for("") == DEFAULT_PRICING
    assert _pricing_for(None) == DEFAULT_PRICING


def test_pricing_longest_prefix_wins():
    # "claude-fable-5" and other keys don't overlap here, but verify exact match wins.
    assert _pricing_for("claude-fable-5-preview") == PRICING["claude-fable-5"]


# --- cost math ---------------------------------------------------------------

def test_cost_math_opus_1m_in_1m_out():
    # claude-opus: input=5.0, output=25.0 per 1M tokens => 5 + 25 = 30.0
    cost = _row_cost("claude-opus-4", 1_000_000, 1_000_000, 0, 0)
    assert cost == 30.0


def test_cost_math_cache_creation_and_read():
    # claude-sonnet: input=3.0, output=15.0
    # cache_creation = 1.25x input price, cache_read = 0.1x input price
    cost = _row_cost("claude-sonnet-5", 0, 0, 1_000_000, 1_000_000)
    expected = (3.0 * 1.25) + (3.0 * 0.1)
    assert cost == pytest.approx(expected)


def test_cost_math_default_pricing():
    cost = _row_cost("totally-unknown", 1_000_000, 1_000_000, 0, 0)
    assert cost == pytest.approx(DEFAULT_PRICING["input"] + DEFAULT_PRICING["output"])


# --- ingest --------------------------------------------------------------------

def test_ingest_skips_malformed_and_duplicate(tracker, tmp_path):
    jsonl_path = tmp_path / "session.jsonl"
    lines = [
        _assistant_line("uuid-1"),
        _assistant_line("uuid-2"),
        "{not valid json!!",
        _assistant_line("uuid-3"),
        _assistant_line("uuid-1"),  # duplicate uuid
    ]
    jsonl_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    inserted = tracker.ingest_jsonl("term-1", str(jsonl_path))
    assert inserted == 3

    summary = tracker.session_summary("term-1")
    assert summary["input_tokens"] == 300
    assert summary["output_tokens"] == 150


def test_ingest_idempotent_reingest(tracker, tmp_path):
    jsonl_path = tmp_path / "session2.jsonl"
    lines = [_assistant_line("uuid-a"), _assistant_line("uuid-b")]
    jsonl_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    first = tracker.ingest_jsonl("term-2", str(jsonl_path))
    assert first == 2

    # No new content -> no new rows.
    second = tracker.ingest_jsonl("term-2", str(jsonl_path))
    assert second == 0

    summary = tracker.session_summary("term-2")
    assert summary["input_tokens"] == 200
    assert summary["output_tokens"] == 100


def test_ingest_appends_new_lines_incrementally(tracker, tmp_path):
    jsonl_path = tmp_path / "session3.jsonl"
    jsonl_path.write_text(_assistant_line("uuid-x") + "\n", encoding="utf-8")

    first = tracker.ingest_jsonl("term-3", str(jsonl_path))
    assert first == 1

    with open(jsonl_path, "a", encoding="utf-8") as f:
        f.write(_assistant_line("uuid-y") + "\n")

    second = tracker.ingest_jsonl("term-3", str(jsonl_path))
    assert second == 1

    summary = tracker.session_summary("term-3")
    assert summary["input_tokens"] == 200


# --- session_summary -----------------------------------------------------------

def test_session_summary_totals(tracker, tmp_path):
    jsonl_path = tmp_path / "session4.jsonl"
    lines = [
        _assistant_line("u1", model="claude-opus-4", input_tokens=1000, output_tokens=500),
        _assistant_line("u2", model="claude-sonnet-5", input_tokens=2000, output_tokens=1000),
    ]
    jsonl_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    tracker.ingest_jsonl("term-4", str(jsonl_path))

    summary = tracker.session_summary("term-4")
    assert summary["terminal_id"] == "term-4"
    assert summary["input_tokens"] == 3000
    assert summary["output_tokens"] == 1500
    assert summary["total_tokens"] == 4500
    assert set(summary["models"]) == {"claude-opus-4", "claude-sonnet-5"}
    assert summary["last_event_ts"] is not None
    assert summary["est_cost_usd"] > 0


def test_session_summary_empty_terminal(tracker):
    summary = tracker.session_summary("nonexistent")
    assert summary["input_tokens"] == 0
    assert summary["output_tokens"] == 0
    assert summary["total_tokens"] == 0
    assert summary["models"] == []
    assert summary["last_event_ts"] is None
    assert summary["est_cost_usd"] == 0.0


# --- daily_summary --------------------------------------------------------------

def test_daily_summary_by_model(tracker, tmp_path):
    jsonl_path = tmp_path / "session5.jsonl"
    day = "2026-07-19"
    lines = [
        _assistant_line("d1", model="claude-opus-4", input_tokens=1_000_000,
                         output_tokens=1_000_000, ts=f"{day}T09:00:00Z"),
        _assistant_line("d2", model="claude-opus-4", input_tokens=500_000,
                         output_tokens=0, ts=f"{day}T10:00:00Z"),
        _assistant_line("d3", model="claude-sonnet-5", input_tokens=1_000_000,
                         output_tokens=0, ts=f"{day}T11:00:00Z"),
        # different day, should be excluded
        _assistant_line("d4", model="claude-opus-4", input_tokens=1_000_000,
                         output_tokens=1_000_000, ts="2026-07-18T09:00:00Z"),
    ]
    jsonl_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    tracker.ingest_jsonl("term-5", str(jsonl_path))

    summary = tracker.daily_summary(day)
    assert summary["day"] == day
    assert "claude-opus-4" in summary["by_model"]
    assert "claude-sonnet-5" in summary["by_model"]
    # opus: 1.5M input, 1M output
    opus_cost = summary["by_model"]["claude-opus-4"]["est_cost_usd"]
    expected_opus_cost = round((1_500_000 * 5.0 + 1_000_000 * 25.0) / 1_000_000, 4)
    assert opus_cost == pytest.approx(expected_opus_cost)
    assert "term-5" in summary["by_terminal"]
    # the excluded (different-day) row should not contribute
    assert summary["input_tokens"] == 2_500_000


def test_daily_summary_defaults_to_today(tracker):
    summary = tracker.daily_summary()
    assert "day" in summary
    assert summary["est_cost_usd"] == 0.0


# --- persistence after JSONL deletion --------------------------------------------

def test_persistence_after_jsonl_deletion(tracker, tmp_path):
    jsonl_path = tmp_path / "session6.jsonl"
    lines = [_assistant_line("p1", input_tokens=100, output_tokens=200)]
    jsonl_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    tracker.ingest_jsonl("term-6", str(jsonl_path))

    before = tracker.session_summary("term-6")
    assert before["input_tokens"] == 100

    jsonl_path.unlink()

    # Re-ingesting a missing file should be a no-op, not raise, and not lose data.
    inserted = tracker.ingest_jsonl("term-6", str(jsonl_path))
    assert inserted == 0

    after = tracker.session_summary("term-6")
    assert after == before
