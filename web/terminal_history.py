"""Bounded raw PTY replay owned by a session, independent of socket consumers."""
from collections import deque


class TerminalHistory:
    def __init__(self, max_bytes=8 * 1024 * 1024):
        self.max_bytes = max_bytes
        self.chunks = deque()
        self.size = 0
        self.sequence = 0
        self.dropped = False

    def append(self, data):
        raw = data.encode("utf-8")
        self.sequence += 1
        if len(raw) > self.max_bytes:
            raw = raw[-self.max_bytes:]
            data = raw.decode("utf-8", errors="ignore")
            raw = data.encode("utf-8")
            self.dropped = True
        self.chunks.append((self.sequence, data, len(raw)))
        self.size += len(raw)
        while self.size > self.max_bytes and self.chunks:
            _, _, size = self.chunks.popleft()
            self.size -= size
            self.dropped = True

    def snapshot(self, after=None):
        first = self.chunks[0][0] if self.chunks else self.sequence + 1
        gap = after is not None and (after < first - 1 or after > self.sequence)
        reset = after is None or gap
        start = 0 if reset else after
        return {
            "reset": reset,
            "truncated": self.dropped if reset else False,
            "sequence": self.sequence,
            "chunks": [(seq, data) for seq, data, _ in self.chunks if seq > start],
        }
