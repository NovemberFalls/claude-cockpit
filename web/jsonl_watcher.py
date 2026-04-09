"""JSONL session file watcher — tails Claude Code conversation files and yields structured messages.

Claude Code writes conversation turns as JSONL lines to:
  ~/.claude/projects/<project-id>/<session-id>.jsonl

This module provides an async generator that watches a JSONL file for new lines,
parses them, and yields only the message types relevant for the chat UI.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import AsyncGenerator

logger = logging.getLogger("cockpit.jsonl")

# JSONL types to skip (internal bookkeeping, not displayable)
SKIP_TYPES = {"queue-operation", "last-prompt"}


def parse_jsonl_entry(line: str) -> dict | None:
    """Parse a single JSONL line into a chat-renderable message.

    Returns a dict with:
      - id: unique message UUID
      - type: 'user' | 'assistant' | 'system' | 'tool_result'
      - role: 'user' | 'assistant' | 'system'
      - content: list of content blocks
      - timestamp: ISO timestamp
      - parentId: parent message UUID (for threading)

    Returns None for entries that should be skipped.
    """
    try:
        obj = json.loads(line)
    except json.JSONDecodeError:
        return None

    entry_type = obj.get("type")
    if entry_type in SKIP_TYPES:
        return None

    msg = obj.get("message", {})
    uuid = obj.get("uuid")
    if not uuid:
        return None

    timestamp = obj.get("timestamp")
    parent_id = obj.get("parentUuid")

    if entry_type == "user":
        content = msg.get("content", "")
        # User messages can be a string (regular text) or an array (tool results)
        if isinstance(content, str):
            return {
                "id": uuid,
                "type": "user",
                "role": "user",
                "content": [{"type": "text", "text": content}],
                "timestamp": timestamp,
                "parentId": parent_id,
            }
        elif isinstance(content, list):
            # Check if this is a tool_result response
            has_tool_result = any(
                block.get("type") == "tool_result" for block in content if isinstance(block, dict)
            )
            if has_tool_result:
                blocks = []
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") == "tool_result":
                        # Extract tool result content
                        result_content = block.get("content", "")
                        if isinstance(result_content, list):
                            # Content can be [{type: "text", text: "..."}]
                            texts = [b.get("text", "") for b in result_content if isinstance(b, dict)]
                            result_content = "\n".join(texts)
                        blocks.append({
                            "type": "tool_result",
                            "tool_use_id": block.get("tool_use_id"),
                            "content": str(result_content)[:2000],  # Truncate large results
                            "is_error": block.get("is_error", False),
                        })
                return {
                    "id": uuid,
                    "type": "tool_result",
                    "role": "user",
                    "content": blocks,
                    "timestamp": timestamp,
                    "parentId": parent_id,
                }
            return None  # Unknown user content format

    elif entry_type == "assistant":
        content = msg.get("content", [])
        if not isinstance(content, list):
            return None

        blocks = []
        for block in content:
            if not isinstance(block, dict):
                continue
            block_type = block.get("type")
            if block_type == "text":
                text = block.get("text", "")
                if text:
                    blocks.append({"type": "text", "text": text})
            elif block_type == "tool_use":
                blocks.append({
                    "type": "tool_use",
                    "tool_name": block.get("name", "unknown"),
                    "tool_id": block.get("id", ""),
                    "input": _summarize_tool_input(block.get("input", {})),
                })
            elif block_type == "thinking":
                # Include thinking but mark it as collapsed by default
                thinking_text = block.get("thinking", "")
                if thinking_text:
                    blocks.append({
                        "type": "thinking",
                        "text": thinking_text[:1000],  # Truncate long thinking
                    })

        if not blocks:
            return None

        return {
            "id": uuid,
            "type": "assistant",
            "role": "assistant",
            "content": blocks,
            "timestamp": timestamp,
            "parentId": parent_id,
            "model": msg.get("model"),
            "stop_reason": msg.get("stop_reason"),
        }

    elif entry_type == "system":
        content = msg.get("content", "")
        if isinstance(content, list):
            texts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
            content = "\n".join(texts)
        return {
            "id": uuid,
            "type": "system",
            "role": "system",
            "content": [{"type": "text", "text": str(content)[:500]}],
            "timestamp": timestamp,
            "parentId": parent_id,
        }

    return None


def _summarize_tool_input(input_data: dict) -> dict:
    """Produce a compact summary of tool input for display."""
    summary = {}
    for key, value in input_data.items():
        if isinstance(value, str) and len(value) > 200:
            summary[key] = value[:200] + "..."
        else:
            summary[key] = value
    return summary


async def tail_jsonl(
    filepath: str,
    from_beginning: bool = True,
    poll_interval: float = 0.3,
) -> AsyncGenerator[dict, None]:
    """Async generator that tails a JSONL file and yields parsed messages.

    Args:
        filepath: Path to the JSONL file to watch.
        from_beginning: If True, read all existing entries first. If False, start from end.
        poll_interval: Seconds between file polls.

    Yields:
        Parsed message dicts (see parse_jsonl_entry).
    """
    path = Path(filepath)

    # Wait for file to exist (Claude Code may not have written it yet)
    wait_count = 0
    while not path.exists():
        wait_count += 1
        if wait_count > 100:  # ~30s at 0.3s interval
            logger.warning("JSONL file never appeared: %s", filepath)
            return
        await asyncio.sleep(poll_interval)

    offset = 0

    if from_beginning:
        # Read all existing entries
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        entry = parse_jsonl_entry(line)
                        if entry:
                            yield entry
                offset = f.tell()
        except Exception:
            logger.debug("Error reading JSONL: %s", filepath, exc_info=True)
    else:
        try:
            offset = path.stat().st_size
        except OSError:
            offset = 0

    # Tail for new entries
    while True:
        try:
            current_size = path.stat().st_size
        except OSError:
            await asyncio.sleep(poll_interval)
            continue

        if current_size > offset:
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as f:
                    f.seek(offset)
                    new_data = f.read()
                    offset = f.tell()
                for line in new_data.split("\n"):
                    line = line.strip()
                    if line:
                        entry = parse_jsonl_entry(line)
                        if entry:
                            yield entry
            except Exception:
                logger.debug("Error tailing JSONL: %s", filepath, exc_info=True)

        await asyncio.sleep(poll_interval)


def read_all_messages(filepath: str) -> list[dict]:
    """Synchronously read all messages from a JSONL file. Returns a list of parsed messages."""
    path = Path(filepath)
    if not path.exists():
        return []

    messages = []
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if line:
                    entry = parse_jsonl_entry(line)
                    if entry:
                        messages.append(entry)
    except Exception:
        logger.debug("Error reading JSONL: %s", filepath, exc_info=True)

    return messages
