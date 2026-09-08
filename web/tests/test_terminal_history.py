from collections import deque

from terminal_history import TerminalHistory, coalesce_chunks


def test_reconnect_returns_only_missed_output_without_consuming_history():
    history = TerminalHistory()
    history.append("earlier\r\n")
    history.append("later\r\n")
    assert history.snapshot()["chunks"] == [(1, "earlier\r\n"), (2, "later\r\n")]
    assert history.snapshot(1)["chunks"] == [(2, "later\r\n")]
    assert history.snapshot(1)["reset"] is False
    assert len(history.snapshot()["chunks"]) == 2


def test_retention_gap_requires_explicit_reset_and_truncation():
    history = TerminalHistory(max_bytes=8)
    history.append("aaaa")
    history.append("bbbb")
    history.append("cccc")
    assert history.size == 8
    assert history.snapshot(0)["reset"] is True
    assert history.snapshot(0)["truncated"] is True
    assert history.snapshot(1)["reset"] is False
    assert history.snapshot(3)["chunks"] == []


def test_oversized_unicode_chunk_is_bounded_and_reported():
    history = TerminalHistory(max_bytes=7)
    history.append("é" * 20)
    assert history.size <= 7
    assert history.snapshot()["truncated"] is True
    assert "�" not in history.snapshot()["chunks"][0][1]


def test_idle_and_incremental_polls_do_not_walk_retained_output():
    class CountedDeque(deque):
        visits = 0

        def __iter__(self):
            for item in super().__iter__():
                self.visits += 1
                yield item

        def __reversed__(self):
            for item in super().__reversed__():
                self.visits += 1
                yield item

    history = TerminalHistory()
    history.chunks = CountedDeque()
    for _ in range(10000):
        history.append("retained output")
    cursor = history.sequence
    for _ in range(100):
        assert history.snapshot(cursor)["chunks"] == []
    assert history.chunks.visits == 0

    history.append("first new output")
    history.append("second new output")
    result = history.snapshot(cursor)
    assert result["chunks"] == [
        (cursor + 1, "first new output"),
        (cursor + 2, "second new output"),
    ]
    assert result["reset"] is False
    assert history.chunks.visits <= 3


def test_future_cursor_resets_and_retention_boundary_stays_incremental():
    history = TerminalHistory(max_bytes=6)
    for chunk in ("aaa", "bbb", "ccc"):
        history.append(chunk)
    assert history.snapshot(99) == {
        "reset": True, "truncated": True, "sequence": 3,
        "chunks": [(2, "bbb"), (3, "ccc")],
    }
    assert history.snapshot(1) == {
        "reset": False, "truncated": False, "sequence": 3,
        "chunks": [(2, "bbb"), (3, "ccc")],
    }


def test_consecutive_chunks_merge_under_the_cap_and_carry_the_last_sequence():
    chunks = [(1, "aa"), (2, "bb"), (3, "cc")]
    assert coalesce_chunks(chunks, 6) == [(3, "aabbcc")]
    # The cap is a byte cap, so the frame breaks where the bytes run out and the
    # seq of each frame is the last chunk it carries — never the first.
    assert coalesce_chunks(chunks, 4) == [(2, "aabb"), (3, "cc")]


def test_a_chunk_larger_than_the_cap_is_emitted_alone_and_never_split():
    # Splitting could cut an escape sequence that the retained stream already
    # contains intact; a single oversized frame is the safe outcome.
    big = "x" * 50
    assert coalesce_chunks([(1, big)], 10) == [(1, big)]
    assert coalesce_chunks([(1, "a"), (2, big), (3, "b")], 10) == [
        (1, "a"), (2, big), (3, "b"),
    ]


def test_multibyte_chunks_are_measured_in_bytes_not_characters():
    # "é" is two bytes, so three of them do not fit a five-byte frame.
    assert coalesce_chunks([(1, "é"), (2, "é"), (3, "é")], 5) == [(2, "éé"), (3, "é")]


def test_coalescing_preserves_order_and_returns_nothing_for_no_chunks():
    chunks = [(n, f"{n};") for n in range(1, 21)]
    frames = coalesce_chunks(chunks, 8)
    assert "".join(data for _, data in frames) == "".join(data for _, data in chunks)
    assert [seq for seq, _ in frames] == sorted(seq for seq, _ in frames)
    assert frames[-1][0] == 20
    assert coalesce_chunks([], 64 * 1024) == []
