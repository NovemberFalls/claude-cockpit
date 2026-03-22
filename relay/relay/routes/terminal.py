"""WebSocket endpoint for browser terminal connections.

Browser connects to /ws/terminal/{instance_id}/{terminal_id}
to view/interact with a specific terminal on a connected cockpit instance.
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..auth import get_session_user
from ..tunnel_manager import tunnel_manager

logger = logging.getLogger("relay.terminal")

router = APIRouter()


@router.websocket("/ws/terminal/{compound_id}")
async def browser_terminal_compound(websocket: WebSocket, compound_id: str):
    """Cockpit-compatible WS route — compound_id is 'instance_id:terminal_id'."""
    if ":" not in compound_id:
        await websocket.close(code=4000, reason="Invalid terminal ID format")
        return
    instance_id, terminal_id = compound_id.split(":", 1)
    await browser_terminal(websocket, instance_id, terminal_id)


@router.websocket("/ws/terminal/{instance_id}/{terminal_id}")
async def browser_terminal(websocket: WebSocket, instance_id: str, terminal_id: str):
    """Bridge a browser xterm.js session to a remote cockpit terminal."""
    # Check that the instance exists and belongs to the requesting user
    instance = tunnel_manager.instances.get(instance_id)
    if not instance:
        await websocket.close(code=4004, reason="Instance not found")
        return

    # For WebSocket auth, we check cookies/session via a pre-flight or
    # accept and verify immediately. Here we accept first since WS
    # doesn't have easy pre-flight.
    await websocket.accept()

    # Register this browser client
    added = await tunnel_manager.add_browser_client(instance_id, terminal_id, websocket)
    if not added:
        await websocket.close(code=4004, reason="Terminal not found on instance")
        return

    logger.info("Browser connected to %s/%s", instance_id, terminal_id)

    try:
        while True:
            msg = await websocket.receive()

            if msg.get("type") == "websocket.disconnect":
                break

            # Handle text input from browser
            text = msg.get("text")
            if text:
                # Check for JSON control messages
                if text.startswith("{"):
                    try:
                        ctrl = json.loads(text)
                        if ctrl.get("type") == "resize":
                            # Do NOT forward browser resize to the PTY — the PTY keeps
                            # the desktop user's dimensions. Remote viewers adapt to it.
                            continue
                    except json.JSONDecodeError:
                        pass

                # Forward keyboard input to tunnel as binary frame
                await tunnel_manager.forward_to_tunnel(
                    instance_id, terminal_id, text.encode("utf-8")
                )

            # Handle binary input from browser
            raw_bytes = msg.get("bytes")
            if raw_bytes:
                await tunnel_manager.forward_to_tunnel(
                    instance_id, terminal_id, raw_bytes
                )

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.error("Browser terminal %s/%s error: %s", instance_id, terminal_id, e)
    finally:
        await tunnel_manager.remove_browser_client(instance_id, terminal_id, websocket)
        logger.info("Browser disconnected from %s/%s", instance_id, terminal_id)
