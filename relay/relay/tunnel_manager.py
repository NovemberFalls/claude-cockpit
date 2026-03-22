"""Core tunnel manager — routes messages between local cockpits and browser clients.

Privacy boundary: The relay NEVER stores or logs terminal content.
It forwards binary PTY frames between tunnel WS (local cockpit) and
browser WS (remote viewer) in real time, and only tracks metadata.
"""

from __future__ import annotations

import asyncio
import logging
import struct
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket

from .config import HEARTBEAT_INTERVAL, HEARTBEAT_MISSES_ALLOWED

logger = logging.getLogger("relay.tunnel")

# Binary frame prefix for terminal I/O
TERMINAL_DATA_PREFIX = 0x01
# Terminal ID is 8 bytes (left-padded/truncated UTF-8 of the terminal_id string)
TERMINAL_ID_LEN = 8


def encode_terminal_id(terminal_id: str) -> bytes:
    """Encode a terminal ID string to a fixed 8-byte identifier."""
    raw = terminal_id.encode("utf-8")[:TERMINAL_ID_LEN]
    return raw.ljust(TERMINAL_ID_LEN, b"\x00")


def decode_terminal_id(data: bytes) -> str:
    """Decode an 8-byte terminal ID back to a string."""
    return data.rstrip(b"\x00").decode("utf-8", errors="replace")


def make_terminal_frame(terminal_id: str, payload: bytes) -> bytes:
    """Build a binary frame: 0x01 + 8-byte tid + payload."""
    return bytes([TERMINAL_DATA_PREFIX]) + encode_terminal_id(terminal_id) + payload


def parse_terminal_frame(data: bytes) -> tuple[str, bytes] | None:
    """Parse a binary frame. Returns (terminal_id, payload) or None."""
    if len(data) < 1 + TERMINAL_ID_LEN:
        return None
    if data[0] != TERMINAL_DATA_PREFIX:
        return None
    tid = decode_terminal_id(data[1 : 1 + TERMINAL_ID_LEN])
    payload = data[1 + TERMINAL_ID_LEN :]
    return tid, payload


@dataclass
class TerminalMeta:
    """Metadata about a single terminal session — NEVER content."""
    id: str
    name: str = ""
    model: str = ""
    activity_state: str = "idle"
    tokens: int = 0
    cost: float = 0.0
    workdir: str = ""


@dataclass
class ConnectedInstance:
    """Represents one local cockpit connected via tunnel WebSocket."""
    instance_id: str
    user_email: str
    api_key_id: str
    hostname: str = ""
    version: str = ""
    websocket: WebSocket | None = None
    connected_at: float = field(default_factory=time.time)
    last_heartbeat: float = field(default_factory=time.time)
    missed_heartbeats: int = 0
    terminals: dict[str, TerminalMeta] = field(default_factory=dict)
    browser_clients: dict[str, list[WebSocket]] = field(default_factory=dict)
    output_buffers: dict[str, bytearray] = field(default_factory=dict)  # terminal_id -> recent output
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)

    @property
    def session_count(self) -> int:
        return len(self.terminals)

    @property
    def total_tokens(self) -> int:
        return sum(t.tokens for t in self.terminals.values())

    @property
    def total_cost(self) -> float:
        return sum(t.cost for t in self.terminals.values())

    def to_metadata(self) -> dict:
        """Return admin-safe metadata (no terminal content, no workdirs)."""
        return {
            "instance_id": self.instance_id,
            "user_email": self.user_email,
            "hostname": self.hostname,
            "connected_since": self.connected_at,
            "session_count": self.session_count,
            "total_tokens": self.total_tokens,
            "total_cost": self.total_cost,
            "last_heartbeat": self.last_heartbeat,
            "status": "connected",
        }

    def to_user_view(self) -> dict:
        """Return user-facing view with terminal list (includes full metadata)."""
        return {
            "instance_id": self.instance_id,
            "hostname": self.hostname,
            "connected_since": self.connected_at,
            "session_count": self.session_count,
            "total_tokens": self.total_tokens,
            "total_cost": self.total_cost,
            "terminals": [
                {
                    "id": t.id,
                    "name": t.name,
                    "model": t.model,
                    "activity_state": t.activity_state,
                    "tokens": t.tokens,
                    "cost": t.cost,
                    "workdir": t.workdir,
                }
                for t in self.terminals.values()
            ],
        }


_SCROLLBACK_BYTES = 50 * 1024  # 50 KB per terminal


class TunnelManager:
    """Singleton managing all connected cockpit instances and message routing."""

    def __init__(self):
        self._instances: dict[str, ConnectedInstance] = {}  # instance_id -> ConnectedInstance
        self._heartbeat_tasks: dict[str, asyncio.Task] = {}
        self._pending_rpcs: dict[str, asyncio.Future] = {}  # request_id -> Future
        self._lock = asyncio.Lock()

    @property
    def instances(self) -> dict[str, ConnectedInstance]:
        return self._instances

    async def register_instance(
        self,
        instance_id: str,
        user_email: str,
        api_key_id: str,
        websocket: WebSocket,
    ) -> ConnectedInstance:
        """Register a new tunnel connection."""
        instance = ConnectedInstance(
            instance_id=instance_id,
            user_email=user_email,
            api_key_id=api_key_id,
            websocket=websocket,
        )
        async with self._lock:
            # Close existing instance with same ID if any
            if instance_id in self._instances:
                await self._disconnect_instance(instance_id, reason="replaced")
            self._instances[instance_id] = instance

        # Start heartbeat monitor
        task = asyncio.create_task(self._heartbeat_loop(instance_id))
        self._heartbeat_tasks[instance_id] = task

        logger.info("Instance %s registered (user=%s)", instance_id, user_email)
        return instance

    async def unregister_instance(self, instance_id: str):
        """Remove an instance when its tunnel disconnects."""
        async with self._lock:
            await self._disconnect_instance(instance_id, reason="disconnected")

    async def _disconnect_instance(self, instance_id: str, reason: str = "unknown"):
        """Internal: clean up an instance (must hold _lock)."""
        instance = self._instances.pop(instance_id, None)
        if not instance:
            return

        # Cancel heartbeat
        task = self._heartbeat_tasks.pop(instance_id, None)
        if task:
            task.cancel()

        # Close all browser clients for this instance
        for tid, clients in instance.browser_clients.items():
            for ws in clients:
                try:
                    await ws.close(code=1001, reason=f"Instance {reason}")
                except Exception:
                    pass

        logger.info("Instance %s removed (reason=%s)", instance_id, reason)

    async def _heartbeat_loop(self, instance_id: str):
        """Send periodic pings to the tunnel and track responses."""
        try:
            while True:
                await asyncio.sleep(HEARTBEAT_INTERVAL)
                instance = self._instances.get(instance_id)
                if not instance or not instance.websocket:
                    break

                try:
                    await instance.websocket.send_json({"type": "ping", "ts": time.time()})
                    instance.missed_heartbeats += 1

                    if instance.missed_heartbeats > HEARTBEAT_MISSES_ALLOWED:
                        logger.warning("Instance %s missed %d heartbeats — disconnecting", instance_id, instance.missed_heartbeats)
                        async with self._lock:
                            await self._disconnect_instance(instance_id, reason="heartbeat_timeout")
                        break
                except Exception:
                    async with self._lock:
                        await self._disconnect_instance(instance_id, reason="heartbeat_error")
                    break
        except asyncio.CancelledError:
            pass

    def handle_pong(self, instance_id: str):
        """Handle a pong response from a tunnel."""
        instance = self._instances.get(instance_id)
        if instance:
            instance.missed_heartbeats = 0
            instance.last_heartbeat = time.time()

    def update_terminal_list(self, instance_id: str, terminals: list[dict]):
        """Update the terminal metadata for an instance."""
        instance = self._instances.get(instance_id)
        if not instance:
            return

        new_terminals = {}
        for t in terminals:
            tid = t.get("id", "")
            if not tid:
                continue
            new_terminals[tid] = TerminalMeta(
                id=tid,
                name=t.get("name", ""),
                model=t.get("model", ""),
                activity_state=t.get("activityState", t.get("activity_state", "idle")),
                tokens=t.get("tokens", 0),
                cost=t.get("cost", 0.0),
                workdir=t.get("workdir", t.get("working_dir", "")),
            )
        instance.terminals = new_terminals

    # ── Browser client management ────────────────────────

    async def add_browser_client(self, instance_id: str, terminal_id: str, ws: WebSocket) -> bool:
        """Register a browser WebSocket for a specific terminal."""
        instance = self._instances.get(instance_id)
        if not instance:
            return False
        if terminal_id not in instance.terminals:
            return False

        async with instance._lock:
            if terminal_id not in instance.browser_clients:
                instance.browser_clients[terminal_id] = []
            instance.browser_clients[terminal_id].append(ws)

        count = len(instance.browser_clients.get(terminal_id, []))
        await self._send_viewer_update(instance, terminal_id, count)
        logger.info("Browser client added for %s/%s (viewers=%d)", instance_id, terminal_id, count)

        # Replay scrollback buffer so new viewers see existing terminal content
        buf = instance.output_buffers.get(terminal_id)
        if buf:
            try:
                await ws.send_text(buf.decode("utf-8", errors="replace"))
            except Exception:
                pass

        return True

    async def remove_browser_client(self, instance_id: str, terminal_id: str, ws: WebSocket):
        """Remove a browser WebSocket."""
        instance = self._instances.get(instance_id)
        if not instance:
            return

        async with instance._lock:
            clients = instance.browser_clients.get(terminal_id, [])
            if ws in clients:
                clients.remove(ws)
                if not clients:
                    instance.browser_clients.pop(terminal_id, None)

        count = len(instance.browser_clients.get(terminal_id, []))
        await self._send_viewer_update(instance, terminal_id, count)

    async def _send_viewer_update(self, instance: ConnectedInstance, terminal_id: str, count: int):
        """Notify the tunnel how many browsers are watching a terminal."""
        if not instance.websocket:
            return
        try:
            await instance.websocket.send_json({
                "type": "viewer_update",
                "terminal_id": terminal_id,
                "count": count,
            })
        except Exception:
            pass

    # ── Message routing ──────────────────────────────────

    async def forward_to_browsers(self, instance_id: str, terminal_id: str, data: bytes):
        """Forward terminal output (binary) from tunnel to all browser clients."""
        instance = self._instances.get(instance_id)
        if not instance:
            return

        # Append to scrollback buffer (capped at 50KB)
        buf = instance.output_buffers.get(terminal_id)
        if buf is None:
            buf = bytearray()
            instance.output_buffers[terminal_id] = buf
        buf.extend(data)
        if len(buf) > _SCROLLBACK_BYTES:
            del buf[: len(buf) - _SCROLLBACK_BYTES]

        clients = instance.browser_clients.get(terminal_id, [])
        dead = []
        decoded = data.decode("utf-8", errors="replace")
        if "\ufffd" in decoded:
            logger.debug(
                "Relay decode replacement chars for %s/%s: %r",
                instance_id, terminal_id,
                data[max(0, data.index(b"\xef") - 10) : data.index(b"\xef") + 15]
                if b"\xef" in data else data[:30],
            )
        for ws in clients:
            try:
                await ws.send_text(decoded)
            except Exception:
                dead.append(ws)

        # Clean up dead connections and notify tunnel if count changed
        if dead:
            async with instance._lock:
                for ws in dead:
                    try:
                        instance.browser_clients.get(terminal_id, []).remove(ws)
                    except ValueError:
                        pass
            count = len(instance.browser_clients.get(terminal_id, []))
            await self._send_viewer_update(instance, terminal_id, count)

    async def forward_to_tunnel(self, instance_id: str, terminal_id: str, data: bytes):
        """Forward browser input (binary) to the tunnel."""
        instance = self._instances.get(instance_id)
        if not instance or not instance.websocket:
            return

        frame = make_terminal_frame(terminal_id, data)
        try:
            await instance.websocket.send_bytes(frame)
        except Exception:
            logger.error("Failed to forward input to tunnel %s", instance_id)

    async def send_to_tunnel(self, instance_id: str, message: dict):
        """Send a JSON control message to a tunnel."""
        instance = self._instances.get(instance_id)
        if not instance or not instance.websocket:
            return False
        try:
            await instance.websocket.send_json(message)
            return True
        except Exception:
            return False

    async def admin_kill_instance(self, instance_id: str, disable_key: bool = False) -> bool:
        """Admin kill switch: disconnect an instance, optionally disable its API key."""
        instance = self._instances.get(instance_id)
        if not instance:
            return False

        # Send kill message to tunnel
        try:
            if instance.websocket:
                await instance.websocket.send_json({"type": "admin_kill", "reason": "Disconnected by admin"})
                await instance.websocket.close(code=1000, reason="Admin kill")
        except Exception:
            pass

        async with self._lock:
            await self._disconnect_instance(instance_id, reason="admin_kill")

        return True

    def get_instances_for_user(self, user_email: str) -> list[ConnectedInstance]:
        """Get all instances belonging to a user."""
        return [i for i in self._instances.values() if i.user_email == user_email]

    def get_all_instances(self) -> list[ConnectedInstance]:
        """Get all connected instances (admin view)."""
        return list(self._instances.values())

    # ── RPC (relay → desktop commands) ─────────────────

    async def send_rpc(self, instance_id: str, method: str, params: dict, timeout: float = 30.0) -> dict:
        """Send an RPC request to a desktop instance and await the response."""
        instance = self._instances.get(instance_id)
        if not instance or not instance.websocket:
            raise ConnectionError(f"Instance {instance_id} not connected")

        request_id = uuid.uuid4().hex
        loop = asyncio.get_event_loop()
        future = loop.create_future()
        self._pending_rpcs[request_id] = future

        try:
            await instance.websocket.send_json({
                "type": "rpc_request",
                "id": request_id,
                "method": method,
                "params": params,
            })
            result = await asyncio.wait_for(future, timeout=timeout)
            return result
        except asyncio.TimeoutError:
            self._pending_rpcs.pop(request_id, None)
            raise TimeoutError(f"RPC {method} timed out after {timeout}s")
        except Exception:
            self._pending_rpcs.pop(request_id, None)
            raise

    def handle_rpc_response(self, instance_id: str, msg: dict):
        """Handle an RPC response from a desktop instance."""
        request_id = msg.get("id", "")
        future = self._pending_rpcs.pop(request_id, None)
        if not future or future.done():
            return

        if "error" in msg:
            future.set_exception(RuntimeError(msg["error"]))
        else:
            future.set_result(msg.get("result", {}))

    async def shutdown(self):
        """Gracefully shut down all connections."""
        async with self._lock:
            for instance_id in list(self._instances.keys()):
                await self._disconnect_instance(instance_id, reason="server_shutdown")


# Singleton
tunnel_manager = TunnelManager()
