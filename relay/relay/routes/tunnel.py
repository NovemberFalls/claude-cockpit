"""WebSocket endpoint for local cockpit tunnel connections.

Protocol:
1. Client connects to /tunnel with API key in query param or header
2. Server validates key, sends `welcome` message
3. Client sends `hello` with hostname, version
4. Bidirectional message flow:
   - JSON text frames for control (terminal_list, pong, hello)
   - Binary frames for terminal I/O (0x01 + 8-byte tid + payload)
"""

from __future__ import annotations

import json
import logging
import uuid

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..auth import rate_limiter
from ..models import Database
from ..tunnel_manager import parse_terminal_frame, tunnel_manager

logger = logging.getLogger("relay.tunnel")

router = APIRouter()


@router.websocket("/tunnel")
async def tunnel_endpoint(websocket: WebSocket, key: str = ""):
    """Main tunnel WebSocket — one per local cockpit instance."""
    # Get database from app state
    db: Database = websocket.app.state.db

    # Extract API key from query param or header
    api_key_raw = key or websocket.headers.get("x-api-key", "")
    if not api_key_raw:
        await websocket.close(code=4001, reason="Missing API key")
        return

    # Validate API key
    api_key = await db.validate_api_key(api_key_raw)
    if not api_key:
        await websocket.close(code=4003, reason="Invalid API key")
        return

    # Rate limit check
    if not rate_limiter.check(api_key.id):
        await websocket.close(code=4029, reason="Rate limited")
        return

    await websocket.accept()

    # Generate instance ID and register
    instance_id = uuid.uuid4().hex[:12]
    instance = await tunnel_manager.register_instance(
        instance_id=instance_id,
        user_email=api_key.user_email,
        api_key_id=api_key.id,
        websocket=websocket,
    )

    # Send welcome
    await websocket.send_json({
        "type": "welcome",
        "instance_id": instance_id,
        "heartbeat_interval": 30,
    })

    await db.log_action("tunnel_connect", api_key.user_email, instance_id)

    try:
        while True:
            msg = await websocket.receive()

            if msg.get("type") == "websocket.disconnect":
                break

            # Handle binary frames (terminal output)
            raw_bytes = msg.get("bytes")
            if raw_bytes:
                parsed = parse_terminal_frame(raw_bytes)
                if parsed:
                    terminal_id, payload = parsed
                    # Forward to all browser clients watching this terminal
                    await tunnel_manager.forward_to_browsers(instance_id, terminal_id, payload)
                continue

            # Handle text frames (JSON control messages)
            text = msg.get("text")
            if not text:
                continue

            try:
                data = json.loads(text)
            except json.JSONDecodeError:
                continue

            msg_type = data.get("type", "")

            if msg_type == "hello":
                instance.hostname = data.get("hostname", "")
                instance.version = data.get("version", "")
                logger.info("Instance %s hello: hostname=%s version=%s", instance_id, instance.hostname, instance.version)

            elif msg_type == "terminal_list":
                terminals = data.get("terminals", [])
                tunnel_manager.update_terminal_list(instance_id, terminals)

            elif msg_type == "pong":
                tunnel_manager.handle_pong(instance_id)

            elif msg_type == "rpc_response":
                tunnel_manager.handle_rpc_response(instance_id, data)

            else:
                logger.debug("Unknown message type from tunnel %s: %s", instance_id, msg_type)

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.error("Tunnel %s error: %s", instance_id, e)
    finally:
        await tunnel_manager.unregister_instance(instance_id)
        await db.log_action("tunnel_disconnect", api_key.user_email, instance_id)
