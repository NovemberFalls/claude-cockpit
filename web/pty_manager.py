"""PTY session manager for Claude Cockpit.

Spawns interactive Claude CLI processes via Windows ConPTY (pywinpty)
and bridges them to WebSocket connections.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

logger = logging.getLogger("cockpit.pty")

# Regex to strip ANSI escape sequences
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b\].*?\x1b\\")
# Patterns for state detection
_IDLE_PATTERNS = ["❯", "$ "]
_WAITING_PATTERNS = ["Allow", "Yes/No", "y/n", "Do you want", "(y)es", "(n)o"]
# Patterns for token/cost parsing
_TOKEN_RE = re.compile(r"(\d[\d,]*)\s*tokens?")
_COST_RE = re.compile(r"\$(\d+\.?\d*)")


class SessionStateTracker:
    """Tracks activity state, tokens, and cost from PTY output."""

    def __init__(self):
        self.state: str = "starting"  # idle | busy | waiting | starting
        self.last_output_time: float = time.time()
        self.buffer: str = ""  # rolling ~2000 chars of ANSI-stripped text
        self.total_tokens: int = 0
        self.total_cost: float = 0.0
        self._last_token_val: int = 0
        self._last_cost_val: float = 0.0

    def feed(self, raw_data: str) -> None:
        """Process new PTY output data."""
        self.last_output_time = time.time()
        self.state = "busy"

        # Strip ANSI and append to rolling buffer
        clean = _ANSI_RE.sub("", raw_data)
        self.buffer += clean
        if len(self.buffer) > 2000:
            self.buffer = self.buffer[-2000:]

        # Parse tokens/cost from the clean data
        for m in _TOKEN_RE.finditer(clean):
            val = int(m.group(1).replace(",", ""))
            if val > self._last_token_val:
                self.total_tokens = val
                self._last_token_val = val

        for m in _COST_RE.finditer(clean):
            val = float(m.group(1))
            if val > self._last_cost_val:
                self.total_cost = val
                self._last_cost_val = val

    def tick(self) -> str:
        """Check for idle/waiting state based on buffer tail and timing."""
        elapsed = time.time() - self.last_output_time

        if elapsed < 1.0:
            return self.state  # Still receiving output, stay busy

        # Check the tail of the buffer for patterns
        tail = self.buffer[-200:] if self.buffer else ""

        # Check waiting patterns first (higher priority)
        for pattern in _WAITING_PATTERNS:
            if pattern.lower() in tail.lower():
                self.state = "waiting"
                return self.state

        # Check idle patterns
        for pattern in _IDLE_PATTERNS:
            if pattern in tail:
                self.state = "idle"
                return self.state

        # If no output for 1.5s+ but no recognized pattern, stay in current state
        if elapsed > 3.0 and self.state == "busy":
            self.state = "idle"

        return self.state


@dataclass
class TerminalSession:
    """Represents a single interactive Claude CLI terminal."""

    id: str
    name: str
    pty: Any  # winpty.PtyProcess or conpty.PtyProcess
    created_at: str
    model: str = "sonnet"
    working_dir: str = ""
    claude_session_id: Optional[str] = None  # for --resume
    bypass_permissions: bool = False
    cols: int = 120
    rows: int = 30
    alive: bool = True
    tracker: SessionStateTracker = field(default_factory=SessionStateTracker)


MAX_SESSIONS = int(os.getenv("MAX_SESSIONS", "8"))
IDLE_TIMEOUT = int(os.getenv("IDLE_TIMEOUT", str(2 * 3600)))  # 2 hours default

# Allowed model names — prevents command injection via the model parameter.
_ALLOWED_MODELS = {
    "sonnet", "opus", "haiku",
    "claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5-20251001",
    "claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022",
}
# Claude session ID format: hex or UUID-style
_SESSION_ID_RE = re.compile(r"^[a-f0-9\-]{8,64}$", re.IGNORECASE)


class PtyManager:
    """Manages PTY-backed terminal sessions."""

    # File that tracks PIDs of claude processes spawned by this cockpit instance.
    # Only these PIDs are killed during orphan cleanup — never random Claude sessions.
    _PID_TRACK_FILE = os.path.join(os.path.dirname(__file__), ".cockpit-child-pids")

    def __init__(self):
        self.sessions: dict[str, TerminalSession] = {}
        self._lock = threading.Lock()  # Protects sessions dict and PID file
        self._pty_executor = ThreadPoolExecutor(max_workers=64)

    def _save_child_pid(self, pid: int) -> None:
        """Record a spawned child PID for crash-recovery cleanup."""
        with self._lock:
            pids = self._load_child_pids()
            pids.add(pid)
            try:
                with open(self._PID_TRACK_FILE, "w") as f:
                    f.write("\n".join(str(p) for p in pids))
            except Exception:
                logger.debug("Failed to save child PID %d", pid, exc_info=True)

    def _remove_child_pid(self, pid: int) -> None:
        """Remove a child PID after graceful termination."""
        with self._lock:
            pids = self._load_child_pids()
            pids.discard(pid)
            try:
                with open(self._PID_TRACK_FILE, "w") as f:
                    f.write("\n".join(str(p) for p in pids))
            except Exception:
                logger.debug("Failed to remove child PID %d", pid, exc_info=True)

    def _load_child_pids(self) -> set[int]:
        """Load previously tracked child PIDs."""
        try:
            with open(self._PID_TRACK_FILE) as f:
                return {int(line.strip()) for line in f if line.strip().isdigit()}
        except FileNotFoundError:
            return set()
        except Exception:
            logger.debug("Failed to load child PIDs", exc_info=True)
            return set()

    def _clear_child_pids(self) -> None:
        """Clear the PID tracking file."""
        try:
            with open(self._PID_TRACK_FILE, "w") as f:
                f.write("")
        except Exception:
            pass

    def cleanup_orphans(self):
        """Kill cockpit-spawned claude processes left over from a previous crash.

        Only kills processes whose PIDs were tracked in the child-PID file.
        Never touches Claude sessions running in other terminals or editors.
        """
        tracked_pids = self._load_child_pids()
        if not tracked_pids:
            logger.debug("No tracked child PIDs — skipping orphan cleanup")
            return

        try:
            import psutil
        except ImportError:
            logger.warning("psutil not installed — skipping orphan cleanup")
            return

        killed = 0
        for pid in tracked_pids:
            try:
                proc = psutil.Process(pid)
                name = proc.name().lower()
                # Only kill if it's actually a claude/node process (PID could have been reused)
                if "claude" in name or "node" in name:
                    logger.info("Killing orphaned cockpit child: %s (PID %d)", proc.name(), pid)
                    proc.kill()
                    killed += 1
                else:
                    logger.debug("PID %d reused by '%s' — skipping", pid, proc.name())
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue

        self._clear_child_pids()

        if killed:
            logger.info("Cleaned up %d orphaned cockpit process(es)", killed)
        else:
            logger.debug("No orphaned cockpit processes found")

    def cleanup_idle_sessions(self):
        """Kill sessions that have been idle longer than IDLE_TIMEOUT.

        Only kills sessions whose underlying process is still alive but has
        produced no output. Sessions whose process is actively consuming CPU
        (e.g. long-running Claude tasks) are spared even if they haven't
        produced terminal output recently.
        """
        if IDLE_TIMEOUT <= 0:
            return
        now = time.time()
        to_kill = []
        for tid, session in self.sessions.items():
            elapsed = now - session.tracker.last_output_time
            if elapsed <= IDLE_TIMEOUT:
                continue
            # tick() to refresh state from buffer
            session.tracker.tick()
            if session.tracker.state != "idle":
                continue
            # Double-check the process isn't busy (e.g. CPU-bound Claude task
            # that simply hasn't written to the terminal in a while)
            try:
                import psutil
                child_pid = getattr(session.pty, "pid", None)
                if child_pid is None:
                    pi = getattr(session.pty, "_pi", None)
                    if pi:
                        child_pid = getattr(pi, "dwProcessId", None)
                if child_pid:
                    proc = psutil.Process(child_pid)
                    cpu = proc.cpu_percent(interval=0.1)
                    if cpu > 5.0:
                        logger.debug("Session %s idle %.0fs but CPU %.1f%% — sparing", tid, elapsed, cpu)
                        continue
            except Exception:
                pass  # If we can't check CPU, proceed with kill
            to_kill.append(tid)
        for tid in to_kill:
            logger.info("Killing idle session %s (idle %.0fs)", tid, now - self.sessions[tid].tracker.last_output_time)
            self.kill_terminal(tid)

    def create_terminal(
        self,
        name: str = "",
        workdir: str = "",
        model: str = "sonnet",
        resume_session_id: str = "",
        continue_last: bool = False,
        bypass_permissions: bool = False,
        cols: int = 120,
        rows: int = 30,
    ) -> TerminalSession:
        """Spawn a new interactive Claude CLI session in a PTY."""
        if len(self.sessions) >= MAX_SESSIONS:
            raise RuntimeError(f"Maximum session limit ({MAX_SESSIONS}) reached")

        # Validate model to prevent command injection (e.g. "sonnet --dangerously-skip-permissions")
        if model not in _ALLOWED_MODELS:
            raise ValueError(f"Invalid model: {model!r}")

        # Validate resume_session_id if provided (must be hex/UUID, no shell metacharacters)
        if resume_session_id and not _SESSION_ID_RE.match(resume_session_id):
            raise ValueError(f"Invalid session ID format: {resume_session_id!r}")

        terminal_id = uuid.uuid4().hex[:8]
        if not name:
            name = f"Session {len(self.sessions) + 1}"
        if not workdir:
            workdir = os.getcwd()

        # Build a clean environment for child processes:
        # 1. Remove Claude Code markers (avoids "inside another session" error)
        # 2. Remove PyInstaller artifacts (avoids DLL conflicts)
        blocked_keys = {"CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"}
        pyi_prefixes = ("_PYI", "_MEI")
        env = {}
        for k, v in os.environ.items():
            if k in blocked_keys:
                continue
            if k.startswith(pyi_prefixes):
                continue
            env[k] = v

        import sys as _sys
        meipass = getattr(_sys, "_MEIPASS", None)
        current_path = env.get("PATH", env.get("Path", ""))

        # Strip PyInstaller's temp extraction directory from PATH
        if meipass:
            meipass_lower = meipass.lower().rstrip(os.sep)
            cleaned_parts = []
            for p in current_path.split(";"):
                p_stripped = p.strip()
                if not p_stripped:
                    continue
                p_lower = p_stripped.lower().rstrip(os.sep)
                if p_lower == meipass_lower or p_lower.startswith(meipass_lower + os.sep):
                    continue
                cleaned_parts.append(p_stripped)
            current_path = ";".join(cleaned_parts)

        # Ensure critical system directories and npm globals are in PATH
        sys_root = os.environ.get("SystemRoot", r"C:\Windows")
        user_profile = os.environ.get("USERPROFILE", os.path.expanduser("~"))
        npm_dir = os.path.join(user_profile, "AppData", "Roaming", "npm")
        essential_dirs = [
            os.path.join(sys_root, "System32"),
            sys_root,
            os.path.join(sys_root, "System32", "Wbem"),
            npm_dir,
        ]
        path_lower = current_path.lower()
        for d in essential_dirs:
            if os.path.isdir(d) and d.lower() not in path_lower:
                current_path = d + ";" + current_path
        env["PATH"] = current_path
        env.setdefault("SystemRoot", sys_root)

        # Build the command
        import shutil
        cmd = f"claude --model {model}"
        if resume_session_id:
            cmd += f" --resume {resume_session_id}"
        elif continue_last:
            cmd += " --continue"
        if bypass_permissions:
            cmd += " --dangerously-skip-permissions"

        claude_path = shutil.which("claude", path=current_path)
        logger.info("Spawning: %s", cmd)
        logger.info("Claude found at: %s", claude_path)
        logger.info("CWD: %s", workdir)
        logger.debug("Bundled: %s", bool(meipass))
        if bypass_permissions:
            logger.warning("Permissions: BYPASSED")

        # Inside PyInstaller bundles, pywinpty's C extension causes child
        # processes to fail with 0xC0000142. Use our pure-ctypes ConPTY
        # wrapper instead, which calls the Windows API directly.
        if meipass:
            from conpty import PtyProcess as ConPtyProcess
            logger.info("Using ctypes ConPTY (PyInstaller mode)")
            pty_process = ConPtyProcess.spawn(
                cmd,
                dimensions=(rows, cols),
                cwd=workdir,
                env=env,
            )
        else:
            import winpty
            pty_process = winpty.PtyProcess.spawn(
                cmd,
                dimensions=(rows, cols),
                cwd=workdir,
                env=env,
            )

        # Post-spawn health check (Claude CLI needs time to initialize Node.js)
        time.sleep(1.5)
        logger.info("Post-spawn alive: %s", pty_process.isalive())
        if not pty_process.isalive():
            try:
                out = pty_process.read(4096)
                logger.error("Dying output: %s", repr(out[:500]))
            except Exception as e:
                logger.error("Read error on dying process: %s", e)
            logger.error("Exit status: %s", pty_process.exitstatus)

        session = TerminalSession(
            id=terminal_id,
            name=name,
            pty=pty_process,
            created_at=datetime.now(timezone.utc).isoformat(),
            model=model,
            working_dir=workdir,
            claude_session_id=resume_session_id or None,
            bypass_permissions=bypass_permissions,
            cols=cols,
            rows=rows,
        )
        self.sessions[terminal_id] = session

        # Track child PID for crash-recovery cleanup
        child_pid = getattr(pty_process, "pid", None)
        if child_pid is None:
            # conpty.PtyProcess stores PID in _pi.dwProcessId
            pi = getattr(pty_process, "_pi", None)
            if pi:
                child_pid = getattr(pi, "dwProcessId", None)
        if child_pid:
            self._save_child_pid(child_pid)

        return session

    def kill_terminal(self, terminal_id: str) -> bool:
        """Kill a terminal session."""
        session = self.sessions.pop(terminal_id, None)
        if not session:
            return False

        # Untrack child PID
        child_pid = getattr(session.pty, "pid", None)
        if child_pid is None:
            pi = getattr(session.pty, "_pi", None)
            if pi:
                child_pid = getattr(pi, "dwProcessId", None)
        if child_pid:
            self._remove_child_pid(child_pid)

        try:
            if session.pty.isalive():
                session.pty.terminate(force=True)
        except Exception:
            logger.warning("Failed to terminate PTY %s", terminal_id, exc_info=True)
        session.alive = False
        return True

    def resize_terminal(self, terminal_id: str, cols: int, rows: int) -> bool:
        """Resize a terminal's PTY dimensions."""
        session = self.sessions.get(terminal_id)
        if not session or not session.pty.isalive():
            return False
        try:
            session.pty.setwinsize(rows, cols)
            session.cols = cols
            session.rows = rows
            return True
        except Exception:
            logger.debug("Resize failed for %s", terminal_id, exc_info=True)
            return False

    def list_terminals(self) -> list[dict]:
        """List all active terminals."""
        result = []
        dead_ids = []
        for tid, session in self.sessions.items():
            if not session.pty.isalive():
                session.alive = False
                dead_ids.append(tid)
                continue
            session.tracker.tick()
            result.append({
                "id": session.id,
                "name": session.name,
                "model": session.model,
                "created_at": session.created_at,
                "working_dir": session.working_dir,
                "claude_session_id": session.claude_session_id,
                "bypass_permissions": session.bypass_permissions,
                "cols": session.cols,
                "rows": session.rows,
                "alive": True,
                "activity_state": session.tracker.state,
                "tokens": session.tracker.total_tokens,
                "cost": session.tracker.total_cost,
            })
        # Clean up dead sessions
        for tid in dead_ids:
            self.sessions.pop(tid, None)
        return result

    def get_terminal(self, terminal_id: str) -> Optional[TerminalSession]:
        """Get a terminal session by ID."""
        session = self.sessions.get(terminal_id)
        if session and not session.pty.isalive():
            session.alive = False
        return session

    async def read_pty(self, terminal_id: str, size: int = 65536) -> str:
        """Read from PTY (runs in dedicated executor to avoid blocking)."""
        session = self.sessions.get(terminal_id)
        if not session or not session.pty.isalive():
            return ""
        loop = asyncio.get_event_loop()
        try:
            data = await loop.run_in_executor(self._pty_executor, session.pty.read, size)
            return data
        except EOFError:
            session.alive = False
            return ""
        except Exception:
            logger.debug("PTY read error for %s", terminal_id)
            return ""

    def write_pty(self, terminal_id: str, data: str) -> bool:
        """Write to PTY stdin (synchronous)."""
        session = self.sessions.get(terminal_id)
        if not session or not session.pty.isalive():
            return False
        try:
            session.pty.write(data)
            return True
        except Exception:
            logger.debug("PTY write error for %s", terminal_id)
            return False

    async def write_pty_async(self, terminal_id: str, data: str) -> bool:
        """Write to PTY stdin (non-blocking, runs in executor)."""
        session = self.sessions.get(terminal_id)
        if not session or not session.alive:
            return False
        loop = asyncio.get_event_loop()
        try:
            return await loop.run_in_executor(
                self._pty_executor, self._write_pty_sync, terminal_id, data
            )
        except Exception:
            logger.debug("PTY async write error for %s", terminal_id)
            return False

    def _write_pty_sync(self, terminal_id: str, data: str) -> bool:
        """Executor-safe PTY write (avoids isalive() kernel call on event loop)."""
        session = self.sessions.get(terminal_id)
        if not session or not session.pty.isalive():
            return False
        try:
            session.pty.write(data)
            return True
        except Exception:
            logger.debug("PTY write error for %s", terminal_id)
            return False

    def shutdown(self):
        """Kill all sessions and clean up resources."""
        count = len(self.sessions)
        if count:
            logger.info("Shutting down %d session(s)...", count)
        for tid in list(self.sessions.keys()):
            self.kill_terminal(tid)
        self._pty_executor.shutdown(wait=True, cancel_futures=True)
        logger.info("PTY manager shutdown complete")


# Singleton
pty_manager = PtyManager()
