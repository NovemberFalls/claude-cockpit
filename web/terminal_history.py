"""Bounded raw PTY replay owned by a session, independent of socket consumers."""
from collections import deque


def coalesce_chunks(chunks, max_bytes):
    """Merge CONSECUTIVE ``(seq, data)`` chunks into frames of at most ``max_bytes``.

    Merging only, never splitting. A chunk boundary may already sit inside an
    escape sequence and xterm tolerates that only while the bytes still arrive in
    order, so a chunk that is already larger than ``max_bytes`` is emitted alone
    rather than cut. Each merged frame carries the sequence number of its LAST
    member, which is what the client records as "accepted through seq".
    """
    frames = []
    buffer = []
    buffered = 0
    last_seq = None
    for seq, data in chunks:
        size = len(data.encode("utf-8"))
        if buffer and buffered + size > max_bytes:
            frames.append((last_seq, "".join(buffer)))
            buffer = []
            buffered = 0
        buffer.append(data)
        buffered += size
        last_seq = seq
    if buffer:
        frames.append((last_seq, "".join(buffer)))
    return frames


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
        if reset:
            chunks = [(seq, data) for seq, data, _ in self.chunks]
        else:
            # Replay wakes on an append and re-checks liveness twice a second.
            # Walking retained output on a no-op poll delays input for every
            # session, so an up-to-date cursor must not touch the deque at all.
            chunks = []
            if after < self.sequence:
                for seq, data, _ in reversed(self.chunks):
                    if seq <= after:
                        break
                    chunks.append((seq, data))
                chunks.reverse()
        return {
            "reset": reset,
            "truncated": self.dropped if reset else False,
            "sequence": self.sequence,
            "chunks": chunks,
        }
