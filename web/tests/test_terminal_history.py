from terminal_history import TerminalHistory


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
