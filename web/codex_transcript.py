"""Read-only, bounded-memory pages of native Codex conversation messages."""
import json
from collections import deque
from pathlib import Path


def transcript_page(path, before=None, limit=50):
    messages = deque(maxlen=max(1, min(200, limit)) + 1)
    legacy_messages = deque(maxlen=messages.maxlen)
    has_native_messages = False
    try:
        with Path(path).open("rb") as stream:
            while True:
                offset = stream.tell()
                line = stream.readline(16 * 1024 * 1024)
                if not line:
                    break
                if not line.endswith(b"\n"):
                    # An incomplete append is retried on the next page request.
                    # Skip oversized records without parsing their fragments.
                    while line and not line.endswith(b"\n"):
                        line = stream.readline(16 * 1024 * 1024)
                    continue
                try:
                    row = json.loads(line)
                    payload = row.get("payload", {})
                    kind = payload.get("type")
                    if row.get("type") == "response_item" and kind == "message" and payload.get("role") in ("user", "assistant"):
                        has_native_messages = True
                        content = payload.get("content", [])
                        parts = [part.get("text", "") for part in content if isinstance(part, dict)
                                 and part.get("type") in ("input_text", "output_text", "text")
                                 and isinstance(part.get("text"), str)] if isinstance(content, list) else []
                        if not parts:
                            continue
                        target, role, text = messages, payload["role"], "\n".join(parts)
                    elif (row.get("type") == "event_msg" and kind in ("user_message", "agent_message")
                          and isinstance(payload.get("message"), str)):
                        target = legacy_messages
                        role, text = "user" if kind == "user_message" else "assistant", payload["message"]
                    else:
                        continue
                    if before is None or offset < before:
                        target.append({"index": offset, "role": role, "text": text, "timestamp": row.get("timestamp")})
                except (ValueError, TypeError, AttributeError):
                    continue
    except OSError:
        return {"messages": [], "before": None, "has_more": False, "available": False}
    if not has_native_messages:
        messages = legacy_messages
    has_more = len(messages) > max(1, min(200, limit))
    if has_more:
        messages.popleft()
    result = list(messages)
    return {"messages": result, "before": result[0]["index"] if has_more else None,
            "has_more": has_more, "available": True}
