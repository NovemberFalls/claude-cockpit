"""File watcher daemon for Claude Cockpit agent workspaces.

Watches WORKSPACE_ROOT recursively using the watchdog library. When a file
changes inside a child workspace, identifies the parent session (by parsing
the compound folder name) and appends a notification string to that session's
workspace_events list.

This module does NOT:
  - Write files to workspaces (see workspace_manager.py)
  - Send PTY input or inject text into sessions
  - Start itself — call WorkspaceWatcher.start() from server.py on startup
  - Make network calls or touch the REST API
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import TYPE_CHECKING

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from workspace_manager import WORKSPACE_ROOT, parent_session_id

if TYPE_CHECKING:
    # Avoid a circular import at runtime; only used for type hints.
    from pty_manager import TerminalSession

logger = logging.getLogger("cockpit.workspace_watcher")


class _WorkspaceEventHandler(FileSystemEventHandler):
    """Handles filesystem events and routes notifications to parent session queues.

    Thread safety: workspace_events is a plain list on TerminalSession.
    We protect it with _events_lock so the watcher thread and the API thread
    that drains events don't race.

    on_event: optional callable(compound_id: str, filename: str) called after
    each qualifying event — used by server.py to broadcast to WebSocket clients.
    """

    def __init__(
        self,
        sessions_ref: dict,
        events_lock: threading.Lock,
        on_event=None,
    ) -> None:
        # sessions_ref is PtyManager.sessions — the live dict, not a snapshot.
        # The watcher reads it on each event; new sessions become visible immediately.
        self._sessions = sessions_ref
        self._lock = events_lock
        self._on_event = on_event  # optional callable(compound_id, filename)

    # watchdog calls on_created for new files and on_modified for updates.
    # Both are relevant (agents write new files and update progress files).
    def on_created(self, event) -> None:
        if not event.is_directory:
            self._handle(event.src_path)

    def on_modified(self, event) -> None:
        if not event.is_directory:
            self._handle(event.src_path)

    def _handle(self, file_path: str) -> None:
        path = Path(file_path)

        # Path must be: WORKSPACE_ROOT / <compound_id> / <filename>
        try:
            rel = path.relative_to(WORKSPACE_ROOT)
        except ValueError:
            return  # File is not under the workspace root — ignore

        parts = rel.parts
        if len(parts) < 2:
            return  # Missing compound_id or filename segment

        compound_id: str = parts[0]
        filename: str = parts[1]

        # _meta.json is updated on every status change — skip to avoid noise
        if filename == "_meta.json":
            return

        pid = parent_session_id(compound_id)
        if pid is None:
            return  # Top-level workspace (e.g. Vera) — no parent to notify

        notification = f"[WORKSPACE_UPDATE] {compound_id} wrote {filename}"

        with self._lock:
            session = self._sessions.get(pid)
            if session is None:
                logger.debug(
                    "Workspace event for unknown parent session %s (child: %s, file: %s)",
                    pid, compound_id, filename,
                )
                return
            session.workspace_events.append(notification)

        logger.debug(
            "Workspace event: %s wrote %s → queued for parent session %s",
            compound_id, filename, pid,
        )

        # Notify external listener (e.g. WebSocket broadcaster) outside the lock
        if self._on_event is not None:
            try:
                self._on_event(compound_id, filename)
            except Exception:
                logger.debug("on_event callback error", exc_info=True)


class WorkspaceWatcher:
    """Background file watcher for the agent workspace tree.

    Lifecycle (call from server.py):
        watcher = WorkspaceWatcher(pty_manager.sessions, events_lock)
        watcher.start()   # once at server startup
        ...
        watcher.stop()    # at shutdown, blocks until observer thread exits

    The events_lock must be the same lock used when draining workspace_events
    lists in the REST API, so reads and writes don't race.
    """

    def __init__(
        self,
        sessions_ref: dict,
        events_lock: threading.Lock,
        on_event=None,
    ) -> None:
        self._handler = _WorkspaceEventHandler(sessions_ref, events_lock, on_event)
        self._observer: Observer | None = None

    def start(self) -> None:
        """Start the recursive file watcher. Creates WORKSPACE_ROOT if absent."""
        WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)
        self._observer = Observer()
        self._observer.schedule(
            self._handler,
            str(WORKSPACE_ROOT),
            recursive=True,
        )
        self._observer.start()
        logger.info("WorkspaceWatcher started — watching %s", WORKSPACE_ROOT)

    def stop(self) -> None:
        """Stop the file watcher and block until the observer thread exits."""
        if self._observer is not None:
            self._observer.stop()
            self._observer.join()
            self._observer = None
            logger.info("WorkspaceWatcher stopped")

    @property
    def is_running(self) -> bool:
        return self._observer is not None and self._observer.is_alive()
