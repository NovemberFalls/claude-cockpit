"""PTY session manager for Claude Cockpit.

Spawns interactive Claude CLI processes via Windows ConPTY (pywinpty)
and bridges them to WebSocket connections.
"""

from __future__ import annotations

import asyncio
import os
import re
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

import winpty

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
    pty: winpty.PtyProcess
    created_at: str
    model: str = "sonnet"
    working_dir: str = ""
    claude_session_id: Optional[str] = None  # for --resume
    cols: int = 120
    rows: int = 30
    alive: bool = True
    tracker: SessionStateTracker = field(default_factory=SessionStateTracker)


class PtyManager:
    """Manages PTY-backed terminal sessions."""

    def __init__(self):
        self.sessions: dict[str, TerminalSession] = {}

    def create_terminal(
        self,
        name: str = "",
        workdir: str = "",
        model: str = "sonnet",
        resume_session_id: str = "",
        continue_last: bool = False,
        cols: int = 120,
        rows: int = 30,
    ) -> TerminalSession:
        """Spawn a new interactive Claude CLI session in a PTY."""
        terminal_id = uuid.uuid4().hex[:8]
        if not name:
            name = f"Session {len(self.sessions) + 1}"
        if not workdir:
            workdir = os.getcwd()

        # Build the command - spawn claude interactively
        cmd = f"claude --model {model}"
        if resume_session_id:
            cmd += f" --resume {resume_session_id}"
        elif continue_last:
            cmd += " --continue"

        # Build a clean environment without Claude Code markers to avoid
        # "cannot be launched inside another Claude Code session" error
        blocked = {"CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"}
        env = {k: v for k, v in os.environ.items() if k not in blocked}

        # Spawn via ConPTY
        pty_process = winpty.PtyProcess.spawn(
            cmd,
            dimensions=(rows, cols),
            cwd=workdir,
            env=env,
        )

        session = TerminalSession(
            id=terminal_id,
            name=name,
            pty=pty_process,
            created_at=datetime.now(timezone.utc).isoformat(),
            model=model,
            working_dir=workdir,
            claude_session_id=resume_session_id or None,
            cols=cols,
            rows=rows,
        )
        self.sessions[terminal_id] = session
        return session

    def kill_terminal(self, terminal_id: str) -> bool:
        """Kill a terminal session."""
        session = self.sessions.pop(terminal_id, None)
        if not session:
            return False
        try:
            if session.pty.isalive():
                session.pty.terminate(force=True)
        except Exception:
            pass
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

    async def read_pty(self, terminal_id: str, size: int = 4096) -> str:
        """Read from PTY (runs in executor to avoid blocking)."""
        session = self.sessions.get(terminal_id)
        if not session or not session.pty.isalive():
            return ""
        loop = asyncio.get_event_loop()
        try:
            data = await loop.run_in_executor(None, session.pty.read, size)
            return data
        except EOFError:
            session.alive = False
            return ""
        except Exception:
            return ""

    def write_pty(self, terminal_id: str, data: str) -> bool:
        """Write to PTY stdin."""
        session = self.sessions.get(terminal_id)
        if not session or not session.pty.isalive():
            return False
        try:
            session.pty.write(data)
            return True
        except Exception:
            return False

    def shutdown(self):
        """Kill all sessions."""
        for tid in list(self.sessions.keys()):
            self.kill_terminal(tid)


# Singleton
pty_manager = PtyManager()
