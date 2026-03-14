"""Tunnel client — connects local cockpit to cockpit relay server.

Establishes an outbound WebSocket to the relay, multiplexing all
terminal I/O over a single connection with binary framing.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import platform
import socket
import struct
import time
from pathlib import Path

import httpx

logger = logging.getLogger("cockpit.tunnel")

# Binary frame format: 0x01 + 8-byte terminal_id + payload
TERMINAL_DATA_PREFIX = 0x01
TERMINAL_ID_LEN = 8

# Settings file
SETTINGS_PATH = Path.home() / ".cockpit-relay.json"


def encode_terminal_id(terminal_id: str) -> bytes:
    """Encode a terminal ID to fixed 8 bytes."""
    raw = terminal_id.encode("utf-8")[:TERMINAL_ID_LEN]
    return raw.ljust(TERMINAL_ID_LEN, b"\x00")


def decode_terminal_id(data: bytes) -> str:
    """Decode 8-byte terminal ID to string."""
    return data.rstrip(b"\x00").decode("utf-8", errors="replace")


def make_terminal_frame(terminal_id: str, payload: bytes) -> bytes:
    """Build binary frame: 0x01 + 8-byte tid + payload."""
    return bytes([TERMINAL_DATA_PREFIX]) + encode_terminal_id(terminal_id) + payload


def parse_terminal_frame(data: bytes) -> tuple[str, bytes] | None:
    """Parse binary frame. Returns (terminal_id, payload) or None."""
    if len(data) < 1 + TERMINAL_ID_LEN:
        return None
    if data[0] != TERMINAL_DATA_PREFIX:
        return None
    tid = decode_terminal_id(data[1 : 1 + TERMINAL_ID_LEN])
    payload = data[1 + TERMINAL_ID_LEN :]
    return tid, payload


class TunnelClient:
    """Manages outbound WebSocket connection to cockpit relay server."""

    def __init__(self, pty_manager):
        self._pty_manager = pty_manager
        self._ws = None
        self._relay_url: str = ""
        self._api_key: str = ""
        self._instance_id: str = ""
        self._connected = False
        self._running = False
        self._tasks: list[asyncio.Task] = []
        self._reconnect_delay = 1.0
        self._max_reconnect_delay = 60.0

    @property
    def connected(self) -> bool:
        return self._connected

    @property
    def instance_id(self) -> str:
        return self._instance_id

    @property
    def relay_url(self) -> str:
        return self._relay_url

    def status(self) -> dict:
        """Return current tunnel status."""
        return {
            "connected": self._connected,
            "relay_url": self._relay_url,
            "instance_id": self._instance_id,
        }

    async def connect(self, relay_url: str, api_key: str):
        """Start the tunnel connection."""
        if self._running:
            await self.disconnect()

        self._relay_url = relay_url
        self._api_key = api_key
        self._running = True
        self._reconnect_delay = 1.0

        # Save settings
        self._save_settings()

        # Start connection loop
        task = asyncio.create_task(self._connection_loop())
        self._tasks.append(task)

    async def disconnect(self):
        """Tear down the tunnel."""
        self._running = False
        self._connected = False

        # Cancel all tasks
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            try:
                await task
            except asyncio.CancelledError:
                pass
        self._tasks.clear()

        # Close WebSocket
        if self._ws:
            try:
                await self._ws.close()
            except Exception:
                pass
            self._ws = None

        self._instance_id = ""
        logger.info("Tunnel disconnected")

    def forward_pty_output(self, terminal_id: str, data: str):
        """Queue terminal output to be sent to relay. Called from WS bridge."""
        if not self._connected or not self._ws:
            return
        frame = make_terminal_frame(terminal_id, data.encode("utf-8"))
        asyncio.create_task(self._send_bytes(frame))

    async def _send_bytes(self, data: bytes):
        """Send binary data to relay WebSocket."""
        if self._ws:
            try:
                await self._ws.send(data)
            except Exception:
                pass

    async def _connection_loop(self):
        """Connect with auto-reconnect on failure."""
        try:
            import websockets
        except ImportError:
            logger.error("websockets package not installed — tunnel disabled")
            return

        while self._running:
            try:
                url = self._relay_url
                if "?" in url:
                    url += f"&key={self._api_key}"
                else:
                    url += f"?key={self._api_key}"

                logger.info("Connecting to relay: %s", self._relay_url)

                async with websockets.connect(
                    url,
                    additional_headers={"X-Api-Key": self._api_key},
                    ping_interval=None,  # We handle our own heartbeat
                    max_size=10 * 1024 * 1024,  # 10MB max frame
                ) as ws:
                    self._ws = ws
                    self._reconnect_delay = 1.0  # Reset backoff on success

                    # Wait for welcome
                    welcome_raw = await asyncio.wait_for(ws.recv(), timeout=10)
                    welcome = json.loads(welcome_raw)
                    if welcome.get("type") != "welcome":
                        logger.error("Unexpected welcome: %s", welcome)
                        continue

                    self._instance_id = welcome.get("instance_id", "")
                    self._connected = True
                    logger.info("Tunnel connected, instance_id=%s", self._instance_id)

                    # Send hello
                    await ws.send(json.dumps({
                        "type": "hello",
                        "hostname": socket.gethostname(),
                        "version": "1.0.0",
                        "platform": platform.system(),
                    }))

                    # Start metadata sync task
                    meta_task = asyncio.create_task(self._metadata_loop())
                    self._tasks.append(meta_task)

                    try:
                        # Message receive loop
                        async for msg in ws:
                            if isinstance(msg, bytes):
                                # Binary: terminal input from browser
                                parsed = parse_terminal_frame(msg)
                                if parsed:
                                    terminal_id, payload = parsed
                                    text = payload.decode("utf-8", errors="replace")
                                    self._pty_manager.write_pty(terminal_id, text)
                            elif isinstance(msg, str):
                                await self._handle_control_message(msg)
                    finally:
                        meta_task.cancel()
                        try:
                            await meta_task
                        except asyncio.CancelledError:
                            pass
                        if meta_task in self._tasks:
                            self._tasks.remove(meta_task)

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning("Tunnel connection failed: %s", e)

            self._connected = False
            self._ws = None
            self._instance_id = ""

            if not self._running:
                break

            # Exponential backoff
            logger.info("Reconnecting in %.1fs...", self._reconnect_delay)
            await asyncio.sleep(self._reconnect_delay)
            self._reconnect_delay = min(self._reconnect_delay * 2, self._max_reconnect_delay)

    async def _handle_control_message(self, raw: str):
        """Handle JSON control messages from the relay."""
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return

        msg_type = data.get("type", "")

        if msg_type == "ping":
            if self._ws:
                await self._ws.send(json.dumps({"type": "pong", "ts": time.time()}))

        elif msg_type == "terminal_resize":
            terminal_id = data.get("terminal_id", "")
            cols = data.get("cols", 120)
            rows = data.get("rows", 30)
            if terminal_id:
                self._pty_manager.resize_terminal(terminal_id, cols, rows)

        elif msg_type == "rpc_request":
            request_id = data.get("id", "")
            method = data.get("method", "")
            params = data.get("params", {})
            asyncio.create_task(self._handle_rpc(request_id, method, params))

        elif msg_type == "admin_kill":
            reason = data.get("reason", "Disconnected by admin")
            logger.warning("Admin kill received: %s", reason)
            self._running = False

        else:
            logger.debug("Unknown relay message: %s", msg_type)

    async def _handle_rpc(self, request_id: str, method: str, params: dict):
        """Handle an RPC request from the relay by calling the local server."""
        port = int(os.getenv("PORT", "8420"))
        base = f"http://127.0.0.1:{port}"
        try:
            async with httpx.AsyncClient() as client:
                if method == "create_terminal":
                    resp = await client.post(f"{base}/api/terminals", json=params, timeout=30)
                    result = resp.json()
                elif method == "kill_terminal":
                    terminal_id = params.get("terminal_id", "")
                    resp = await client.delete(f"{base}/api/terminals/{terminal_id}", timeout=10)
                    result = resp.json()
                elif method == "browse":
                    path = params.get("path", "")
                    resp = await client.get(f"{base}/api/browse", params={"path": path}, timeout=10)
                    result = resp.json()
                elif method == "git_status":
                    path = params.get("path", "")
                    resp = await client.get(f"{base}/api/git/status", params={"path": path}, timeout=10)
                    result = resp.json()
                else:
                    raise ValueError(f"Unknown RPC method: {method}")

            if self._ws:
                await self._ws.send(json.dumps({
                    "type": "rpc_response",
                    "id": request_id,
                    "result": result,
                }))
        except Exception as e:
            logger.error("RPC %s failed: %s", method, e)
            if self._ws:
                await self._ws.send(json.dumps({
                    "type": "rpc_response",
                    "id": request_id,
                    "error": str(e),
                }))

    async def _metadata_loop(self):
        """Send terminal metadata to relay every 10 seconds."""
        try:
            while self._running and self._connected:
                terminals = self._pty_manager.list_terminals()
                if self._ws:
                    await self._ws.send(json.dumps({
                        "type": "terminal_list",
                        "terminals": terminals,
                    }))
                await asyncio.sleep(10)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error("Metadata loop error: %s", e)

    def _save_settings(self):
        """Persist relay settings to disk."""
        try:
            SETTINGS_PATH.write_text(json.dumps({
                "relay_url": self._relay_url,
                "api_key": self._api_key,
                "auto_connect": True,
            }, indent=2))
        except Exception as e:
            logger.error("Failed to save settings: %s", e)

    @classmethod
    def load_settings(cls) -> dict | None:
        """Load saved relay settings."""
        try:
            if SETTINGS_PATH.exists():
                return json.loads(SETTINGS_PATH.read_text())
        except Exception:
            pass
        return None

    @classmethod
    def clear_settings(cls):
        """Remove saved relay settings."""
        try:
            if SETTINGS_PATH.exists():
                SETTINGS_PATH.unlink()
        except Exception:
            pass
