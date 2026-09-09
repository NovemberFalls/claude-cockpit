"""Sweep stale Plexar Studio scratch directories out of the system temp folder.

WHY THIS EXISTS (measured 2026-09-09). Three module-level ``mkdtemp`` calls give
each Studio process its own scratch directories -- ``cockpit_uploads_*``
(``server.py``), ``cockpit_relays_*`` (``bridge_manager.py``) and
``cockpit_mailbox_*`` (``mailbox_bridge.py``). All three are removed on the
GRACEFUL shutdown path only, and on a desktop app whose sidecar is deliberately
designed to outlive its window (see CLAUDE.md, "The sidecar OUTLIVES the
window") the graceful path is the exception rather than the rule. The owner's
machine held 280 upload directories totalling 226 MB, and that day's log showed
seven "Startup complete" lines against zero "Shutdown complete" ones.

STARTUP is the only moment reached however the previous process died, so the
sweep runs there. The shutdown cleanup stays exactly as it is; this is a second,
more reliable path, not a replacement.

THE RULE THAT SHAPES EVERYTHING: **"not mine" does NOT mean "dead".** A live
orphaned sidecar may own one of these directories right now, holding images the
user pasted and has not submitted yet. Deleting it destroys user data. So
liveness is PROVEN, never inferred:

  * a MARKED directory (one carrying ``.plexar-owner``, written by this build)
    is kept only when its recorded PID is alive AND that process's executable
    basename is in ``instance_guard.SIDECAR_NAMES``. Both halves are required:
    a bare "is the PID alive" test keeps a directory forever the moment the OS
    recycles that PID onto an unrelated process -- the same reasoning
    ``instance_guard`` already applies before it terminates anything.
  * an UNMARKED directory (written by any build before this change, which is all
    280 of them) has no owner to ask, so the only available signal is age: it is
    swept only when its newest entry is older than ``LEGACY_MAX_AGE_H``. A
    directory in active use gains files. **This heuristic is for legacy
    directories ONLY and is never applied to a marked one** -- a marked
    directory's owner answers for it, and a long-idle live session would
    otherwise have its uploads deleted out from under it.

There is no third way to decide.
"""

from __future__ import annotations

import logging
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

import psutil

import instance_guard

logger = logging.getLogger("cockpit.server")

#: The ``mkdtemp`` prefixes this module owns. Anything else in the temp folder
#: is somebody else's and is never looked at, let alone removed.
SWEEP_PREFIXES = ("cockpit_uploads_", "cockpit_relays_", "cockpit_mailbox_")

#: Name of the ownership marker written inside each directory we create.
OWNER_MARKER = ".plexar-owner"

#: How old an UNMARKED directory's newest entry must be before it is assumed to
#: belong to a dead process. Generous: the cost of waiting another day is a few
#: megabytes; the cost of being wrong is a user's unsaved paste.
LEGACY_MAX_AGE_H = 24.0

#: Wall-clock ceiling for the whole scan, so a pathological temp folder cannot
#: stall launch. Whatever is left is swept on the next launch.
DEFAULT_BUDGET_S = 2.0


def mark_owner(path: Path, pid: int | None = None, exe: str | None = None) -> None:
    """Write the ownership marker into ``path``.

    Two lines: the owning process's PID, and its executable basename. The
    basename is what lets the sweep distinguish "that PID is our sidecar" from
    "the OS recycled that PID onto something else entirely".

    ``pid``/``exe`` default to THIS process. They are explicit parameters so a
    test can mark a directory as owned by an arbitrary PID without having to
    spawn a process to own it.

    Best-effort: a scratch directory that could not be marked is still perfectly
    usable, it merely falls back to the legacy age heuristic later.
    """
    if pid is None:
        pid = os.getpid()
    if exe is None:
        exe = Path(sys.executable).name
    try:
        (Path(path) / OWNER_MARKER).write_text(
            f"{pid}\n{exe}\n", encoding="utf-8"
        )
    except Exception:
        logger.debug("Could not write %s in %s", OWNER_MARKER, path, exc_info=True)


def read_owner(path: Path) -> tuple[int, str] | None:
    """Return ``(pid, exe_basename)`` from the marker, or None if unreadable."""
    try:
        lines = (Path(path) / OWNER_MARKER).read_text(encoding="utf-8").splitlines()
        return int(lines[0].strip()), lines[1].strip()
    except Exception:
        return None


def _owner_is_live(pid: int, exe_name: str) -> bool:
    """True only when that PID is running AND it is a Studio sidecar.

    Both conditions, deliberately -- see the module docstring. ``exe_name`` is
    the basename recorded in the marker; it is reported when the two disagree
    but the LIVE name is what decides, because it is the only one that
    describes the process actually holding that PID now.
    """
    try:
        proc = psutil.Process(pid)
        if not proc.is_running():
            return False
        live_name = proc.name()
    except Exception:
        return False
    if live_name not in instance_guard.SIDECAR_NAMES:
        if live_name != exe_name:
            logger.debug(
                "Temp sweep: PID %d now runs %s (marker said %s) — not a sidecar",
                pid, live_name, exe_name,
            )
        return False
    return True


def _newest_mtime(directory: Path) -> float:
    """Newest mtime among the directory and its immediate entries.

    Only one level deep, and ``lstat`` throughout: a symlink's own timestamp is
    read, never its target's, and no traversal ever leaves the temp root.
    """
    newest = directory.lstat().st_mtime
    try:
        for entry in os.scandir(directory):
            try:
                newest = max(newest, entry.stat(follow_symlinks=False).st_mtime)
            except OSError:
                continue
    except OSError:
        pass
    return newest


def _dir_size(directory: Path) -> int:
    """Best-effort byte total, symlinks never followed."""
    total = 0
    for root, dirs, files in os.walk(directory, followlinks=False):
        for name in files:
            try:
                total += os.lstat(os.path.join(root, name)).st_size
            except OSError:
                continue
        # Never descend through a reparse point / junction / symlinked dir.
        dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(root, d))]
    return total


def sweep_stale(
    temp_root: str | os.PathLike[str] | None = None,
    ours: object = (),
    now: float | None = None,
    budget_s: float = DEFAULT_BUDGET_S,
) -> dict:
    """Remove stale Studio scratch directories. NEVER raises.

    ``ours`` are this process's live directories, excluded by RESOLVED PATH
    IDENTITY rather than by name pattern or by luck of ordering -- the caller
    passes ``UPLOAD_DIR`` / ``_RELAY_DIR`` / ``_MAILBOX_ROOT`` and they are
    compared after ``resolve()``, so a symlinked or 8.3-shortened temp path
    still matches.
    """
    stats = {
        "scanned": 0, "removed": 0, "kept_live": 0,
        "bytes": 0, "errors": 0, "budget_hit": False,
    }
    try:
        root = Path(temp_root) if temp_root is not None else Path(tempfile.gettempdir())
        root = root.resolve()
        started = time.monotonic()
        now_ts = time.time() if now is None else now

        mine = set()
        for d in ours or ():
            try:
                mine.add(Path(d).resolve())
            except Exception:
                continue

        try:
            entries = sorted(os.scandir(root), key=lambda e: e.name)
        except OSError:
            logger.debug("Temp sweep could not list %s", root, exc_info=True)
            return stats

        for entry in entries:
            if time.monotonic() - started > budget_s:
                stats["budget_hit"] = True
                break
            if not entry.name.startswith(SWEEP_PREFIXES):
                continue
            path = Path(entry.path)
            try:
                # A symlink or junction is never followed and never removed:
                # its target may be anywhere, including outside the temp root.
                if entry.is_symlink() or not entry.is_dir(follow_symlinks=False):
                    continue
                resolved = path.resolve()
                if resolved in mine:
                    stats["kept_live"] += 1
                    continue
                # Belt and braces: after resolution it must still be directly
                # under the temp root, so nothing above it can ever be touched.
                if resolved.parent != root:
                    continue

                stats["scanned"] += 1
                owner = read_owner(path)
                if owner is not None:
                    # MARKED: the owner answers for it. No age check, ever.
                    if _owner_is_live(*owner):
                        stats["kept_live"] += 1
                        continue
                else:
                    # UNMARKED (legacy): age is the only signal available.
                    age_h = (now_ts - _newest_mtime(path)) / 3600.0
                    if age_h < LEGACY_MAX_AGE_H:
                        stats["kept_live"] += 1
                        continue

                size = _dir_size(path)
                shutil.rmtree(path)
                stats["removed"] += 1
                stats["bytes"] += size
            except Exception:
                stats["errors"] += 1
                logger.debug("Temp sweep could not remove %s", path, exc_info=True)

        # One line, and only when something actually went away. A sweep that
        # deletes user files silently is the shape this repo refuses; a line
        # every launch saying "removed 0" is noise.
        if stats["removed"]:
            logger.info(
                "Temp sweep: removed %d stale scratch dir(s), %.1f MB reclaimed "
                "(%d kept live, %d errors%s)",
                stats["removed"], stats["bytes"] / (1024 * 1024),
                stats["kept_live"], stats["errors"],
                ", budget hit" if stats["budget_hit"] else "",
            )
    except Exception:
        logger.warning("Temp sweep failed", exc_info=True)
    return stats
