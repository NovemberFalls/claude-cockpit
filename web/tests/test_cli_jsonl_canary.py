"""Opt-in producer check: COCKPIT_RUN_CLAUDE_CANARY=1 plus ANTHROPIC_API_KEY.

This makes one billable request (CLI budget $0.05) with tools/customizations
disabled. Never run automatically. The config, workdir, JSONL and database are
temporary; no subscription credentials or real project configuration are copied.
"""
import json
import os
import shutil
import subprocess
import uuid

import pytest

from usage_tracker import UsageTracker


def assert_transcript_usage(path, tracker):
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        row, _ = tracker._parse_line("canary", str(path), line)
        if row is not None:
            rows.append(row)
    assert rows, "CLI JSONL produced no usage rows with Studio's parser"
    assert all(row[2] and row[3] and row[4] for row in rows), "Missing event identity/time/model"
    assert sum(sum(row[5:9]) for row in rows) > 0, "CLI JSONL reported no tokens"


@pytest.mark.parametrize("broken", ["{}", '{"type":"assistant","uuid":"x","message":{}}',
    json.dumps({"type": "assistant", "uuid": "x", "timestamp": "2026-09-07T00:00:00Z",
                "message": {"model": "sonnet", "usage": {"renamed_input_tokens": 3}}})])
def test_canary_rejects_broken_producer_contract(tmp_path, broken):
    transcript = tmp_path / "broken.jsonl"
    transcript.write_text(broken, encoding="utf-8")
    tracker = UsageTracker(db_path=tmp_path / "usage.db")
    try:
        with pytest.raises(AssertionError):
            assert_transcript_usage(transcript, tracker)
    finally:
        tracker.close()


@pytest.mark.skipif(os.environ.get("COCKPIT_RUN_CLAUDE_CANARY") != "1",
                    reason="Explicit opt-in required for a billable Claude request")
def test_installed_claude_jsonl_contract(tmp_path):
    cli = shutil.which("claude")
    if not cli:
        pytest.skip("Claude CLI is not installed")
    if not os.environ.get("ANTHROPIC_API_KEY"):
        pytest.skip("Isolated canary requires an explicit ANTHROPIC_API_KEY")
    config = tmp_path / "config"
    workdir = tmp_path / "workspace"
    config.mkdir()
    workdir.mkdir()
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("CLAUDE", "ANTHROPIC"))}
    env.update(CLAUDE_CONFIG_DIR=str(config), ANTHROPIC_API_KEY=os.environ["ANTHROPIC_API_KEY"],
               DISABLE_AUTOUPDATER="1")
    session_id = str(uuid.uuid4())
    result = subprocess.run(
        [cli, "-p", "Reply with OK only.", "--model", "haiku", "--safe-mode",
         "--tools", "", "--strict-mcp-config", "--setting-sources", "",
         "--max-budget-usd", "0.05", "--session-id", session_id],
        cwd=workdir, env=env, capture_output=True, text=True, timeout=90,
    )
    assert result.returncode == 0, f"Canary CLI exited {result.returncode}; inspect isolated run"
    transcripts = list(config.rglob(f"{session_id}.jsonl"))
    assert len(transcripts) == 1, "Expected exactly one isolated CLI session transcript"
    tracker = UsageTracker(db_path=tmp_path / "usage.db")
    try:
        assert_transcript_usage(transcripts[0], tracker)
    finally:
        tracker.close()
