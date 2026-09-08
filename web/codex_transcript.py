"""Read-only, bounded-memory pages of native Codex conversation messages."""
import json
import os
import threading
from collections import OrderedDict, deque
from pathlib import Path


def _uncached_page(path, before=None, limit=50):
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


# Store offsets, never conversation text. Deep pages outside this bounded index
# use the original bounded-memory reader rather than losing old history.
_MAX_FILES = 8
_MAX_OFFSETS = 50000
_CACHE = OrderedDict()
_LOCK = threading.Lock()


def _boundary_guard(stream, position):
    """Detect truncate-and-regrow at the same inode without hashing tool bodies."""
    size = min(position, 128)
    stream.seek(0)
    head = stream.read(size)
    stream.seek(position - size)
    return head, stream.read(size)


def _index_append(stream, index, end):
    stream.seek(index["position"])
    while stream.tell() < end:
        offset = stream.tell()
        line = stream.readline(min(16 * 1024 * 1024, end - offset))
        if not line.endswith(b"\n"):
            while line and not line.endswith(b"\n") and stream.tell() < end:
                line = stream.readline(min(16 * 1024 * 1024, end - stream.tell()))
            if not line.endswith(b"\n"):
                break  # Retry this partial record when the writer finishes it.
            index["position"] = stream.tell()
            continue
        index["position"] = stream.tell()
        try:
            row = json.loads(line)
            payload = row.get("payload", {})
            kind = payload.get("type")
            native = (row.get("type") == "response_item" and kind == "message"
                      and payload.get("role") in ("user", "assistant"))
            if native:
                if not index["native"]:
                    index["native"] = True
                    index["offsets"].clear()
                    index["dropped"] = False
                content = payload.get("content", [])
                valid = isinstance(content, list) and any(
                    isinstance(part, dict) and part.get("type") in ("input_text", "output_text", "text")
                    and isinstance(part.get("text"), str) for part in content)
            else:
                valid = (not index["native"] and row.get("type") == "event_msg"
                         and kind in ("user_message", "agent_message") and isinstance(payload.get("message"), str))
            if valid:
                if len(index["offsets"]) == _MAX_OFFSETS:
                    index["dropped"] = True
                index["offsets"].append(offset)
        except (ValueError, TypeError, AttributeError):
            continue


def transcript_page(path, before=None, limit=50):
    limit = max(1, min(200, limit))
    key = str(Path(path).resolve())
    # The global lock protects only cache membership. A cold file must not hold
    # up an already indexed conversation belonging to another terminal.
    with _LOCK:
        entry = _CACHE.get(key)
        if entry is None:
            entry = {"lock": threading.Lock()}
            _CACHE[key] = entry
        _CACHE.move_to_end(key)
        while len(_CACHE) > _MAX_FILES:
            _CACHE.popitem(last=False)
    with entry["lock"]:
        try:
            with Path(path).open("rb") as stream:
                stat = os.fstat(stream.fileno())
                identity = (stat.st_dev, stat.st_ino)
                index = entry if "identity" in entry else None
                if (index is None or index["identity"] != identity or stat.st_size < index["size"]
                        or (stat.st_size == index["size"] and stat.st_mtime_ns != index["mtime"])
                        or _boundary_guard(stream, index["position"]) != index["guard"]):
                    entry.update({"identity": identity, "size": 0, "mtime": None, "position": 0,
                             "native": False, "offsets": deque(maxlen=_MAX_OFFSETS), "dropped": False}
                    )
                    index = entry
                _index_append(stream, index, stat.st_size)
                index.update(size=stat.st_size, mtime=stat.st_mtime_ns)
                index["guard"] = _boundary_guard(stream, index["position"])
                offsets = [n for n in index["offsets"] if before is None or n < before]
                if index["dropped"] and len(offsets) <= limit:
                    return _uncached_page(path, before, limit)
                selected = offsets[-(limit + 1):]
                messages = []
                for offset in selected:
                    stream.seek(offset)
                    row = json.loads(stream.readline(16 * 1024 * 1024))
                    payload = row["payload"]
                    if index["native"]:
                        text = "\n".join(part["text"] for part in payload["content"] if isinstance(part, dict)
                                         and part.get("type") in ("input_text", "output_text", "text")
                                         and isinstance(part.get("text"), str))
                        role = payload["role"]
                    else:
                        text = payload["message"]
                        role = "user" if payload["type"] == "user_message" else "assistant"
                    messages.append({"index": offset, "role": role, "text": text, "timestamp": row.get("timestamp")})
        except (OSError, ValueError, KeyError, TypeError):
            # The file may have been replaced/truncated while we read it.
            with _LOCK:
                if _CACHE.get(key) is entry:
                    _CACHE.pop(key, None)
            return {"messages": [], "before": None, "has_more": False, "available": False}
    has_more = len(messages) > limit
    if has_more:
        messages.pop(0)
    return {"messages": messages, "before": messages[0]["index"] if has_more else None,
            "has_more": has_more, "available": True}
