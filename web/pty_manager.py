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
from collections import deque
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
        self.output_lines: deque = deque(maxlen=500)  # ring buffer: last 500 ANSI-stripped lines
        self._line_fragment: str = ""  # incomplete line accumulator

    def feed(self, raw_data: str) -> None:
        """Process new PTY output data."""
        self.last_output_time = time.time()
        self.state = "busy"

        # Strip ANSI and append to rolling buffer
        clean = _ANSI_RE.sub("", raw_data)
        self.buffer += clean
        if len(self.buffer) > 2000:
            self.buffer = self.buffer[-2000:]

        # Accumulate into per-line ring buffer for MCP get_output
        combined = self._line_fragment + clean
        lines = combined.split("\n")
        self._line_fragment = lines[-1]
        complete = [l for l in lines[:-1] if l.strip()]
        if complete:
            self.output_lines.extend(complete)

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

        # If no output for 10s+ but no recognized pattern, assume idle.
        # Previous 3s threshold was too aggressive — Claude thinking pauses
        # were misclassified as idle, causing orchestrator to read incomplete output.
        if elapsed > 10.0 and self.state == "busy":
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
    output_queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=200))
    # Workspace fields — populated when the session has a workspace folder
    compound_id: str = ""       # full ancestry chain, e.g. "abc12345+def67890"
    workspace_path: str = ""    # absolute path to the workspace folder
    workspace_events: list = field(default_factory=list)  # pending [WORKSPACE_UPDATE] notifications


MAX_SESSIONS = int(os.getenv("MAX_SESSIONS", "8"))
IDLE_TIMEOUT = int(os.getenv("IDLE_TIMEOUT", "0"))  # 0 = disabled (no auto-close)

# Allowed model names — prevents command injection via the model parameter.
_ALLOWED_MODELS = {
    "sonnet", "opus", "haiku",
    "claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5-20251001",
    "claude-sonnet-4-6[1m]", "claude-opus-4-6[1m]",
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

    def _write_child_pids(self, pids: set[int]) -> None:
        """Persist child PID set to disk."""
        try:
            with open(self._PID_TRACK_FILE, "w") as f:
                f.write("\n".join(str(p) for p in pids))
        except Exception:
            logger.debug("Failed to write child PIDs", exc_info=True)

    def _save_child_pid(self, pid: int) -> None:
        """Record a spawned child PID for crash-recovery cleanup."""
        with self._lock:
            pids = self._load_child_pids()
            pids.add(pid)
            self._write_child_pids(pids)

    def _remove_child_pid(self, pid: int) -> None:
        """Remove a child PID after graceful termination."""
        with self._lock:
            pids = self._load_child_pids()
            pids.discard(pid)
            self._write_child_pids(pids)

    def _clear_child_pids(self) -> None:
        """Clear the PID tracking file."""
        self._write_child_pids(set())

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

        Also purges sessions whose process has already exited (dead for >30s)
        so they don't accumulate indefinitely in the sessions dict.

        Only kills sessions whose underlying process is still alive but has
        produced no output. Sessions whose process is actively consuming CPU
        (e.g. long-running Claude tasks) are spared even if they haven't
        produced terminal output recently.

        Uses a two-pass CPU check: first pass primes psutil's internal
        counters (interval=None returns 0.0 on first call), second pass
        after a single short sleep gets the actual reading — avoiding the
        blocking cpu_percent(interval=0.1) per session.
        """
        # First pass: purge sessions whose process is already dead.
        # Grace period of 30s avoids racing with post-spawn health checks.
        now = time.time()
        dead_ids = []
        for tid, session in self.sessions.items():
            if not session.alive and not session.pty.isalive():
                elapsed = now - session.tracker.last_output_time
                if elapsed > 30:
                    dead_ids.append(tid)
        for tid in dead_ids:
            logger.info("Purging dead session %s", tid)
            self.kill_terminal(tid)

        if IDLE_TIMEOUT <= 0:
            return
        candidates = []
        for tid, session in self.sessions.items():
            elapsed = now - session.tracker.last_output_time
            if elapsed <= IDLE_TIMEOUT:
                continue
            session.tracker.tick()
            if session.tracker.state != "idle":
                continue
            candidates.append((tid, elapsed))

        if not candidates:
            return

        # Two-pass CPU check: prime all processes, sleep once, then read
        pid_procs = {}
        try:
            import psutil
            for tid, _ in candidates:
                session = self.sessions.get(tid)
                if not session:
                    continue
                child_pid = self._get_child_pid(session)
                if child_pid:
                    try:
                        proc = psutil.Process(child_pid)
                        proc.cpu_percent(interval=None)  # Prime (non-blocking)
                        pid_procs[tid] = proc
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        pass
            if pid_procs:
                time.sleep(0.1)  # Single sleep for all sessions
        except ImportError:
            pass

        to_kill = []
        for tid, elapsed in candidates:
            proc = pid_procs.get(tid)
            if proc:
                try:
                    cpu = proc.cpu_percent(interval=None)
                    if cpu > 5.0:
                        logger.debug("Session %s idle %.0fs but CPU %.1f%% — sparing", tid, elapsed, cpu)
                        continue
                except Exception:
                    pass
            to_kill.append(tid)

        for tid in to_kill:
            session = self.sessions.get(tid)
            if session:
                logger.info("Killing idle session %s (idle %.0fs)", tid, now - session.tracker.last_output_time)
                self.kill_terminal(tid)

    def get_output_buffer(self, terminal_id: str) -> list:
        """Return last 200 ANSI-stripped lines of output for a session (for MCP)."""
        session = self.sessions.get(terminal_id)
        if not session:
            return []
        return list(session.tracker.output_lines)

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
        mcp_config_path: str = "",
        terminal_id_override: str = "",
        system_prompt_file: str = "",
        compound_id: str = "",
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

        terminal_id = terminal_id_override or uuid.uuid4().hex[:8]
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
            for p in current_path.split(os.pathsep):
                p_stripped = p.strip()
                if not p_stripped:
                    continue
                p_lower = p_stripped.lower().rstrip(os.sep)
                if p_lower == meipass_lower or p_lower.startswith(meipass_lower + os.sep):
                    continue
                cleaned_parts.append(p_stripped)
            current_path = os.pathsep.join(cleaned_parts)

        # Ensure critical system directories and tool globals are in PATH
        if _sys.platform == "win32":
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
                    current_path = d + os.pathsep + current_path
            env.setdefault("SystemRoot", sys_root)
        else:
            home = os.path.expanduser("~")
            extra_dirs = [f"{home}/.local/bin", "/usr/local/bin"]
            path_set = set(current_path.split(os.pathsep))
            prepend = [d for d in extra_dirs if os.path.isdir(d) and d not in path_set]
            if prepend:
                current_path = os.pathsep.join(prepend) + os.pathsep + current_path
        env["PATH"] = current_path

        # Build the command
        import shutil
        cmd = f"claude --model {model}"
        if resume_session_id:
            cmd += f" --resume {resume_session_id}"
        elif continue_last:
            cmd += " --continue"
        if bypass_permissions:
            cmd += " --dangerously-skip-permissions"
        if mcp_config_path:
            if _sys.platform == "win32":
                # Path is passed WITHOUT quotes — winpty's shlex→list2cmdline round-trip
                # corrupts quoted arguments (turns "path" into \"path\"), so the regex
                # guarantees the path is safe to use unquoted.
                if not re.match(r'^[A-Za-z]:\\[\w\\\.\-\~\(\)\+]+\.json$', mcp_config_path):
                    raise ValueError(f"Invalid MCP config path: {mcp_config_path!r}")
                cmd += f' --mcp-config {mcp_config_path}'
            else:
                # Unix: absolute path, safe characters only.
                if not re.match(r'^/[\w/\.\-\~\(\)\+]+\.json$', mcp_config_path):
                    raise ValueError(f"Invalid MCP config path: {mcp_config_path!r}")
                import shlex as _shlex
                cmd += f' --mcp-config {_shlex.quote(mcp_config_path)}'

        if system_prompt_file:
            if _sys.platform == "win32":
                if not re.match(r'^[A-Za-z]:\\[\w\\\.\-\~\(\)\+]+(\.md|\.txt|\.json)$', system_prompt_file):
                    raise ValueError(f"Invalid system prompt file path: {system_prompt_file!r}")
                cmd += f' --append-system-prompt-file {system_prompt_file}'
            else:
                if not re.match(r'^/[\w/\.\-\~\(\)\+]+(\.md|\.txt|\.json)$', system_prompt_file):
                    raise ValueError(f"Invalid system prompt file path: {system_prompt_file!r}")
                import shlex as _shlex
                cmd += f' --append-system-prompt-file {_shlex.quote(system_prompt_file)}'

        claude_path = shutil.which("claude", path=current_path)
        logger.info("Spawning: %s", cmd)
        logger.info("Claude found at: %s", claude_path)
        logger.info("CWD: %s", workdir)
        logger.debug("Bundled: %s", bool(meipass))
        if bypass_permissions:
            logger.warning("Permissions: BYPASSED")

        # Select the appropriate PTY backend for this environment.
        # The backend abstraction (pty_backend.py) makes cross-platform support
        # a matter of adding a new class — no changes needed here.
        from pty_backend import get_backend
        backend = get_backend()
        logger.info("PTY backend: %s", backend.__name__)
        pty_process = backend.spawn(
            cmd,
            dimensions=(rows, cols),
            cwd=workdir,
            env=env,
        )
        # Post-spawn health check is deferred to the async caller (server.py)
        # so it can use asyncio.sleep() without blocking the event loop.

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
            compound_id=compound_id,
        )
        self.sessions[terminal_id] = session

        # Track child PID for crash-recovery cleanup
        child_pid = self._get_child_pid(session)
        if child_pid:
            self._save_child_pid(child_pid)

        return session

    def _get_child_pid(self, session: TerminalSession) -> int | None:
        """Extract the child PID from a PTY session."""
        pid = getattr(session.pty, "pid", None)
        if pid is None:
            pi = getattr(session.pty, "_pi", None)
            if pi:
                pid = getattr(pi, "dwProcessId", None)
        return pid

    def kill_terminal(self, terminal_id: str) -> bool:
        """Kill a terminal session and its entire process tree."""
        session = self.sessions.pop(terminal_id, None)
        if not session:
            return False

        child_pid = self._get_child_pid(session)
        if child_pid:
            self._remove_child_pid(child_pid)

        # conpty.PtyProcess uses Job Objects internally for tree killing.
        # For pywinpty, kill the process tree via psutil before terminating.
        has_job = getattr(session.pty, "_job", None) is not None
        if not has_job and child_pid:
            self._kill_process_tree(child_pid)

        try:
            if session.pty.isalive():
                session.pty.terminate(force=True)
        except Exception:
            logger.warning("Failed to terminate PTY %s", terminal_id, exc_info=True)
        session.alive = False
        return True

    @staticmethod
    def _kill_process_tree(pid: int) -> None:
        """Kill a process and all its descendants (for pywinpty mode)."""
        try:
            import psutil
            parent = psutil.Process(pid)
            children = parent.children(recursive=True)
            for child in children:
                try:
                    child.kill()
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
        except (ImportError, psutil.NoSuchProcess):
            pass

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
        """List all terminals, marking dead ones but NOT removing them.

        Dead sessions are left in the dict so that concurrent code paths
        (e.g. the post-spawn health check) can still find them.  They are
        cleaned up by explicit ``kill_terminal`` or ``cleanup_idle_sessions``.
        """
        result = []
        for tid, session in self.sessions.items():
            alive = session.pty.isalive()
            if not alive:
                session.alive = False
            else:
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
                "alive": alive,
                "activity_state": session.tracker.state,
                "tokens": session.tracker.total_tokens,
                "cost": session.tracker.total_cost,
            })
        return result

    def get_terminal(self, terminal_id: str) -> Optional[TerminalSession]:
        """Get a terminal session by ID."""
        session = self.sessions.get(terminal_id)
        if session and not session.pty.isalive():
            session.alive = False
        return session

    async def read_pty(self, terminal_id: str, size: int = 65536) -> str:
        """Read from PTY (runs in dedicated executor with timeout to avoid blocking)."""
        session = self.sessions.get(terminal_id)
        if not session or not session.alive:
            return ""
        loop = asyncio.get_event_loop()
        try:
            data = await asyncio.wait_for(
                loop.run_in_executor(self._pty_executor, session.pty.read, size),
                timeout=10.0,
            )
            return data
        except asyncio.TimeoutError:
            # Read hung — process may be in a zombie state
            logger.warning("PTY read timed out for %s", terminal_id)
            return ""
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
        """Write to PTY stdin (non-blocking, runs in executor with timeout).

        For large payloads (>8KB), writes in chunks with async yields between
        them so the ConPTY pipe buffer can drain.  Timeout scales with data
        size to support multi-thousand-line pastes.
        """
        session = self.sessions.get(terminal_id)
        if not session or not session.alive:
            return False
        loop = asyncio.get_event_loop()

        # Scale timeout: 5s base + 1s per 32KB of data
        data_len = len(data.encode("utf-8")) if isinstance(data, str) else len(data)
        timeout = max(5.0, 5.0 + (data_len / 32768))

        # Small payloads: single write (fast path)
        if data_len <= 8192:
            try:
                return await asyncio.wait_for(
                    loop.run_in_executor(
                        self._pty_executor, self._write_pty_sync, terminal_id, data
                    ),
                    timeout=timeout,
                )
            except asyncio.TimeoutError:
                logger.warning("PTY write timed out for %s — marking session dead", terminal_id)
                session.alive = False
                return False
            except Exception:
                logger.debug("PTY async write error for %s", terminal_id)
                return False

        # Large payloads: chunk with async yields to let the pipe drain
        chunk_size = 8192
        offset = 0
        while offset < len(data):
            chunk = data[offset:offset + chunk_size]
            try:
                ok = await asyncio.wait_for(
                    loop.run_in_executor(
                        self._pty_executor, self._write_pty_sync, terminal_id, chunk
                    ),
                    timeout=10.0,
                )
                if not ok:
                    return False
            except asyncio.TimeoutError:
                logger.warning(
                    "PTY write timed out for %s at offset %d/%d",
                    terminal_id, offset, len(data),
                )
                session.alive = False
                return False
            except Exception:
                logger.debug("PTY async write error for %s", terminal_id)
                return False
            offset += chunk_size
            # Yield to event loop between chunks — lets the pipe drain
            # and keeps WebSocket heartbeats responsive
            if offset < len(data):
                await asyncio.sleep(0.01)
        return True

    def _write_pty_sync(self, terminal_id: str, data: str) -> bool:
        """Executor-safe PTY write (avoids isalive() kernel call on event loop)."""
        session = self.sessions.get(terminal_id)
        if not session:
            return False
        try:
            if not session.pty.isalive():
                session.alive = False
                return False
            session.pty.write(data)
            return True
        except Exception:
            logger.debug("PTY write error for %s", terminal_id)
            session.alive = False
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
