import json

from codex_transcript import transcript_page


def test_native_messages_paginate_without_response_or_tool_duplicates(tmp_path):
    path = tmp_path / "rollout.jsonl"
    rows = [
        {"type": "event_msg", "payload": {"type": "user_message", "message": "first question"}},
        {"type": "response_item", "payload": {"type": "message", "message": "duplicate question"}},
        {"type": "event_msg", "payload": {"type": "agent_message", "message": "first answer"}},
        {"type": "event_msg", "payload": {"type": "user_message", "message": "follow-up"}},
    ]
    path.write_text("\n".join(map(json.dumps, rows)) + "\n", encoding="utf-8")
    page = transcript_page(path, limit=2)
    assert [m["text"] for m in page["messages"]] == ["first answer", "follow-up"]
    assert page["has_more"] is True
    older = transcript_page(path, before=page["before"], limit=2)
    assert [m["text"] for m in older["messages"]] == ["first question"]
    assert older["has_more"] is False


def test_missing_is_unavailable_and_partial_append_is_not_corrupt_message(tmp_path):
    path = tmp_path / "rollout.jsonl"
    assert transcript_page(path)["available"] is False
    path.write_text('{"type":"event_msg","payload":', encoding="utf-8")
    assert transcript_page(path)["messages"] == []


def test_actual_cli_response_message_schema_excludes_developer_and_duplicate_events(tmp_path):
    path = tmp_path / "native.jsonl"
    rows = [
        {"type": "response_item", "payload": {"type": "message", "role": "developer",
            "content": [{"type": "input_text", "text": "internal setup"}]}},
        {"type": "response_item", "payload": {"type": "message", "role": "user",
            "content": [{"type": "input_text", "text": "question"}]}},
        {"type": "event_msg", "payload": {"type": "user_message", "message": "question"}},
        {"type": "response_item", "payload": {"type": "message", "role": "assistant",
            "content": [{"type": "output_text", "text": "answer"}]}},
    ]
    path.write_text("\n".join(map(json.dumps, rows)) + "\n", encoding="utf-8")
    page = transcript_page(path, limit=1)
    assert [m["text"] for m in page["messages"]] == ["answer"]
    older = transcript_page(path, before=page["before"], limit=1)
    assert [m["text"] for m in older["messages"]] == ["question"]
    assert older["has_more"] is False
