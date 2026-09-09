"""Tests for the startup sweep of stale scratch directories.

THIS CODE DELETES USER FILES, so every arm here is about the boundary between
"provably dead" and "not proven alive". Nothing in this module touches the real
system temp folder: each test builds its own fake root and passes it in.
"""

from __future__ import annotations

import contextlib
import logging
import os
import time
from pathlib import Path

import pytest

import instance_guard
import temp_sweep


A_SIDECAR = sorted(instance_guard.SIDECAR_NAMES)[0]


def _mkdir(root: Path, name: str, *, files=("a.png",)) -> Path:
    d = root / name
    d.mkdir()
    for f in files:
        (d / f).write_bytes(b"x" * 1024)
    return d


def _age(path: Path, hours: float) -> None:
    """Backdate a directory and everything directly inside it."""
    when = time.time() - hours * 3600.0
    for entry in list(path.iterdir()):
        os.utime(entry, (when, when))
    os.utime(path, (when, when))


# ---------------------------------------------------------------------------
# mark_owner / read_owner round-trip
# ---------------------------------------------------------------------------

def test_mark_owner_writes_two_lines_and_round_trips(tmp_path):
    d = _mkdir(tmp_path, "cockpit_uploads_x")
    temp_sweep.mark_owner(d)
    text = (d / temp_sweep.OWNER_MARKER).read_text(encoding="utf-8")
    assert text.splitlines()[0] == str(os.getpid())
    assert len(text.splitlines()) == 2
    assert temp_sweep.read_owner(d) == (os.getpid(), Path(os.sys.executable).name)


def test_mark_owner_accepts_an_explicit_pid_and_exe(tmp_path):
    d = _mkdir(tmp_path, "cockpit_relays_x")
    temp_sweep.mark_owner(d, pid=4242, exe=A_SIDECAR)
    assert temp_sweep.read_owner(d) == (4242, A_SIDECAR)


# ---------------------------------------------------------------------------
# Ours is never swept -- by resolved path identity
# ---------------------------------------------------------------------------

def test_our_own_directory_is_never_swept_even_marked_dead(tmp_path):
    mine = _mkdir(tmp_path, "cockpit_uploads_mine")
    # Deliberately the worst case: a marker naming a PID that cannot be alive,
    # which every other rule in the module would sweep on.
    temp_sweep.mark_owner(mine, pid=_dead_pid(), exe=A_SIDECAR)
    stats = temp_sweep.sweep_stale(temp_root=tmp_path, ours=[mine])
    assert mine.exists()
    assert stats["removed"] == 0


def test_our_own_unmarked_ancient_directory_is_never_swept(tmp_path):
    mine = _mkdir(tmp_path, "cockpit_mailbox_mine")
    _age(mine, 400)
    stats = temp_sweep.sweep_stale(temp_root=tmp_path, ours=[mine])
    assert mine.exists()
    assert stats["removed"] == 0


# ---------------------------------------------------------------------------
# Marked directories -- liveness is PROVEN, and needs BOTH halves
# ---------------------------------------------------------------------------

def test_marked_live_sidecar_is_kept(tmp_path, monkeypatch):
    d = _mkdir(tmp_path, "cockpit_uploads_live")
    temp_sweep.mark_owner(d, pid=os.getpid(), exe=A_SIDECAR)
    # This process is alive; make it *look* like a sidecar by name.
    monkeypatch.setattr(temp_sweep.psutil.Process, "name", lambda self: A_SIDECAR)
    stats = temp_sweep.sweep_stale(temp_root=tmp_path)
    assert d.exists()
    assert stats["kept_live"] == 1
    assert stats["removed"] == 0


def test_marked_live_but_recycled_pid_is_swept(tmp_path):
    """Alive is not enough. The running process must BE a sidecar.

    This is the arm that reddens if the check degrades to ``pid_exists``: the
    PID here is genuinely alive (it is the test runner) but the executable is
    ``python.exe``, not a Studio sidecar -- exactly what Windows recycling a PID
    onto an unrelated process looks like.
    """
    d = _mkdir(tmp_path, "cockpit_uploads_recycled")
    temp_sweep.mark_owner(d, pid=os.getpid(), exe=A_SIDECAR)
    assert temp_sweep.psutil.Process(os.getpid()).name() not in instance_guard.SIDECAR_NAMES
    stats = temp_sweep.sweep_stale(temp_root=tmp_path)
    assert not d.exists()
    assert stats["removed"] == 1


def test_marked_dead_pid_is_swept(tmp_path):
    d = _mkdir(tmp_path, "cockpit_relays_dead")
    temp_sweep.mark_owner(d, pid=_dead_pid(), exe=A_SIDECAR)
    stats = temp_sweep.sweep_stale(temp_root=tmp_path)
    assert not d.exists()
    assert stats["removed"] == 1
    assert stats["bytes"] > 0


def test_a_marked_directory_is_never_judged_by_age(tmp_path, monkeypatch):
    """The legacy age heuristic must NOT reach a marked directory.

    A live session can sit idle for days; its uploads are still the user's.
    """
    d = _mkdir(tmp_path, "cockpit_uploads_old_but_owned")
    temp_sweep.mark_owner(d, pid=os.getpid(), exe=A_SIDECAR)
    _age(d, 400)  # far past LEGACY_MAX_AGE_H
    monkeypatch.setattr(temp_sweep.psutil.Process, "name", lambda self: A_SIDECAR)
    stats = temp_sweep.sweep_stale(temp_root=tmp_path)
    assert d.exists()
    assert stats["removed"] == 0


# ---------------------------------------------------------------------------
# Unmarked (legacy) directories -- age is the ONLY available signal
# ---------------------------------------------------------------------------

def test_unmarked_recent_directory_is_kept(tmp_path):
    d = _mkdir(tmp_path, "cockpit_uploads_recent")
    _age(d, 1)
    stats = temp_sweep.sweep_stale(temp_root=tmp_path)
    assert d.exists()
    assert stats["removed"] == 0
    assert stats["kept_live"] == 1


def test_unmarked_stale_directory_is_swept(tmp_path):
    d = _mkdir(tmp_path, "cockpit_uploads_stale")
    _age(d, 25)
    stats = temp_sweep.sweep_stale(temp_root=tmp_path)
    assert not d.exists()
    assert stats["removed"] == 1


def test_unmarked_directory_with_one_fresh_file_is_kept(tmp_path):
    """Age is the NEWEST entry, not the directory's own stamp: a directory in
    active use gains files."""
    d = _mkdir(tmp_path, "cockpit_uploads_mixed")
    _age(d, 40)
    (d / "just-pasted.png").write_bytes(b"y" * 10)
    stats = temp_sweep.sweep_stale(temp_root=tmp_path)
    assert d.exists()
    assert stats["removed"] == 0


# ---------------------------------------------------------------------------
# Blast radius
# ---------------------------------------------------------------------------

def test_foreign_directories_are_never_touched(tmp_path):
    other = _mkdir(tmp_path, "tmpabcd1234")
    pipwork = _mkdir(tmp_path, "pip-install-xyz")
    _age(other, 900)
    _age(pipwork, 900)
    loose = tmp_path / "some-file.txt"
    loose.write_text("hi")
    stats = temp_sweep.sweep_stale(temp_root=tmp_path)
    assert other.exists() and pipwork.exists() and loose.exists()
    assert stats["scanned"] == 0
    assert stats["removed"] == 0


def test_a_symlinked_entry_is_not_followed_or_removed(tmp_path):
    outside = tmp_path.parent / f"outside_{tmp_path.name}"
    outside.mkdir()
    (outside / "precious.txt").write_text("do not delete")
    link = tmp_path / "cockpit_uploads_link"
    try:
        link.symlink_to(outside, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation not permitted on this machine")
    stats = temp_sweep.sweep_stale(temp_root=tmp_path)
    assert (outside / "precious.txt").exists()
    assert link.exists()
    assert stats["removed"] == 0


def test_a_directory_resolving_outside_the_root_is_skipped(tmp_path):
    """Belt and braces on the resolved-parent check."""
    d = _mkdir(tmp_path, "cockpit_uploads_ok")
    _age(d, 30)
    stats = temp_sweep.sweep_stale(temp_root=tmp_path)
    assert stats["removed"] == 1
    assert not d.exists()
    assert tmp_path.exists()  # the root itself is never a candidate


# ---------------------------------------------------------------------------
# Failure containment and budget
# ---------------------------------------------------------------------------

def test_an_undeletable_directory_counts_an_error_and_the_scan_continues(tmp_path, monkeypatch):
    bad = _mkdir(tmp_path, "cockpit_uploads_aaa_locked")
    good = _mkdir(tmp_path, "cockpit_uploads_zzz_ok")
    _age(bad, 30)
    _age(good, 30)

    real_rmtree = temp_sweep.shutil.rmtree

    def flaky(path, *a, **kw):
        if Path(path).name.endswith("locked"):
            raise PermissionError("file in use by another process")
        return real_rmtree(path, *a, **kw)

    monkeypatch.setattr(temp_sweep.shutil, "rmtree", flaky)
    stats = temp_sweep.sweep_stale(temp_root=tmp_path)
    assert bad.exists()
    assert not good.exists()
    assert stats["errors"] == 1
    assert stats["removed"] == 1


def test_the_budget_stops_the_scan(tmp_path):
    for i in range(6):
        d = _mkdir(tmp_path, f"cockpit_uploads_{i:02d}")
        _age(d, 30)
    stats = temp_sweep.sweep_stale(temp_root=tmp_path, budget_s=-1.0)
    assert stats["budget_hit"] is True
    assert stats["removed"] == 0
    # Nothing was lost -- the remainder is swept on the next launch.
    assert len(list(tmp_path.iterdir())) == 6


def test_sweep_never_raises_on_a_missing_root(tmp_path):
    stats = temp_sweep.sweep_stale(temp_root=tmp_path / "nope")
    assert stats["removed"] == 0
    assert stats["scanned"] == 0


# ---------------------------------------------------------------------------
# Logging: one line only when something was actually removed
# ---------------------------------------------------------------------------

class _Capture(logging.Handler):
    def __init__(self):
        super().__init__(level=logging.INFO)
        self.records = []

    def emit(self, record):
        self.records.append(record)


@contextlib.contextmanager
def _captured_info():
    """Capture cockpit.server INFO directly.

    ``caplog`` cannot see it: ``logging_config.setup()`` turns propagation off
    for the cockpit loggers, so the root handler pytest installs never runs.
    The global ``logging.disable`` level is cleared too -- another test module
    in the same session may have raised it, which would suppress the very line
    this asserts on and turn a real regression into a silent pass.
    """
    handler = _Capture()
    log = logging.getLogger("cockpit.server")
    old_level, log.level = log.level, logging.INFO
    old_disable = logging.root.manager.disable
    logging.disable(logging.NOTSET)
    log.addHandler(handler)
    try:
        yield handler
    finally:
        log.removeHandler(handler)
        log.level = old_level
        logging.disable(old_disable)


def test_no_log_line_when_nothing_was_removed(tmp_path):
    _mkdir(tmp_path, "cockpit_uploads_recent")
    with _captured_info() as cap:
        temp_sweep.sweep_stale(temp_root=tmp_path)
    assert cap.records == []


def test_one_log_line_when_something_was_removed(tmp_path):
    d = _mkdir(tmp_path, "cockpit_uploads_stale")
    _age(d, 30)
    with _captured_info() as cap:
        temp_sweep.sweep_stale(temp_root=tmp_path)
    assert len(cap.records) == 1
    assert "Temp sweep" in cap.records[0].getMessage()


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _dead_pid() -> int:
    """A PID that is not running. Searches upward from a high value."""
    for candidate in range(4_000_000, 4_000_200):
        if not temp_sweep.psutil.pid_exists(candidate):
            return candidate
    pytest.skip("could not find a free PID")
