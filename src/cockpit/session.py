"""Claude session management — spawning and communicating with claude CLI."""

from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path

from .tracking import SessionUsage, UsageSnapshot, parse_usage_from_result


class SessionState(Enum):
    IDLE = "idle"
    RUNNING = "running"
    ERROR = "error"


@dataclass
class Message:
    """A single message in the conversation."""

    role: str  # "user" or "assistant"
    content: str
    timestamp: datetime = field(default_factory=datetime.now)
    tool_calls: list[dict] = field(default_factory=list)


@dataclass
class Container:
    """A group of related sessions."""

    name: str
    id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    sessions: list[str] = field(default_factory=list)  # session IDs
    working_dir: str = ""
    color: str = "#88c0d0"


class Session:
    """Manages a single claude CLI conversation."""

    def __init__(
        self,
        name: str = "New Session",
        working_dir: str | None = None,
        model: str = "sonnet",
        container_id: str | None = None,
    ):
        self.id = str(uuid.uuid4())[:8]
        self.claude_session_id: str | None = None
        self.name = name
        self.working_dir = working_dir or str(Path.cwd())
        self.model = model
        self.container_id = container_id
        self.state = SessionState.IDLE
        self.messages: list[Message] = []
        self.usage = SessionUsage()
        self.created_at = datetime.now()
        self._process: asyncio.subprocess.Process | None = None
        self._cancel_event = asyncio.Event()

    @property
    def display_name(self) -> str:
        return f"{self.name} ({self.id})"

    async def send_message(
        self,
        prompt: str,
        on_text: callable = None,
        on_tool: callable = None,
        on_done: callable = None,
    ) -> str:
        """Send a message to claude and stream the response."""
        self.state = SessionState.RUNNING
        self.messages.append(Message(role="user", content=prompt))
        self._cancel_event.clear()

        cmd = [
            "claude",
            "-p", prompt,
            "--output-format", "stream-json",
            "--model", self.model,
            "--verbose",
        ]

        if self.claude_session_id:
            cmd.extend(["--session-id", self.claude_session_id])

        try:
            self._process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self.working_dir,
            )

            full_response = []
            tool_calls = []

            async for line in self._process.stdout:
                if self._cancel_event.is_set():
                    self._process.terminate()
                    break

                line = line.decode("utf-8", errors="replace").strip()
                if not line:
                    continue

                try:
                    data = json.loads(line)
                except json.JSONDecodeError:
                    continue

                msg_type = data.get("type", "")

                # Capture session ID from init
                if msg_type == "system" and data.get("subtype") == "init":
                    self.claude_session_id = data.get("session_id", self.claude_session_id)

                # Handle assistant messages
                elif msg_type == "assistant":
                    message = data.get("message", {})
                    for block in message.get("content", []):
                        if block.get("type") == "text":
                            text = block.get("text", "")
                            full_response.append(text)
                            if on_text:
                                on_text(text)
                        elif block.get("type") == "tool_use":
                            tool_info = {
                                "name": block.get("name", "unknown"),
                                "input": block.get("input", {}),
                            }
                            tool_calls.append(tool_info)
                            if on_tool:
                                on_tool(tool_info)

                # Handle result with usage stats
                elif msg_type == "result":
                    snapshot = parse_usage_from_result(data)
                    if snapshot:
                        self.usage.add(snapshot)

                    # Also capture session_id from result
                    sid = data.get("session_id")
                    if sid:
                        self.claude_session_id = sid

                    # Get final text from result content
                    result_text = data.get("result", "")
                    if result_text and not full_response:
                        full_response.append(result_text)
                        if on_text:
                            on_text(result_text)

            await self._process.wait()

            response_text = "\n".join(full_response) if full_response else "(no response)"
            self.messages.append(
                Message(role="assistant", content=response_text, tool_calls=tool_calls)
            )
            self.state = SessionState.IDLE

            if on_done:
                on_done()

            return response_text

        except FileNotFoundError:
            self.state = SessionState.ERROR
            error_msg = "Error: 'claude' CLI not found. Make sure Claude Code is installed and in PATH."
            self.messages.append(Message(role="assistant", content=error_msg))
            if on_text:
                on_text(error_msg)
            if on_done:
                on_done()
            return error_msg

        except Exception as e:
            self.state = SessionState.ERROR
            error_msg = f"Error: {e}"
            self.messages.append(Message(role="assistant", content=error_msg))
            if on_text:
                on_text(error_msg)
            if on_done:
                on_done()
            return error_msg

    def cancel(self) -> None:
        """Cancel the current running request."""
        self._cancel_event.set()
        if self._process:
            try:
                self._process.terminate()
            except ProcessLookupError:
                pass

    def to_dict(self) -> dict:
        """Serialize session state."""
        return {
            "id": self.id,
            "name": self.name,
            "claude_session_id": self.claude_session_id,
            "working_dir": self.working_dir,
            "model": self.model,
            "container_id": self.container_id,
            "message_count": len(self.messages),
            "total_tokens": self.usage.total_tokens,
            "total_cost": self.usage.total_cost,
            "created_at": self.created_at.isoformat(),
        }
