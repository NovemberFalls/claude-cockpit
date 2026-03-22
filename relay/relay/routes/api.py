"""REST API routes for the relay dashboard.

- /api/me — current user info
- /api/instances — user's connected instances
- /api/keys — CRUD for API keys
- /api/terminals — cockpit-compatible terminal CRUD (relay mode, via RPC to desktop)
- /api/browse, /api/git/status — proxied to desktop via RPC
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..auth import get_session_user, is_admin
from ..models import Database
from ..tunnel_manager import TerminalMeta, tunnel_manager

router = APIRouter(prefix="/api")


# ── User info ────────────────────────────────────────────

@router.get("/me")
async def me(request: Request):
    user = get_session_user(request)
    if not user:
        return JSONResponse({"authenticated": False}, status_code=401)
    return {
        "authenticated": True,
        "mode": "relay",
        "email": user.get("email", ""),
        "name": user.get("name", ""),
        "picture": user.get("picture", ""),
        "is_admin": user.get("is_admin", False),
    }


# ── Instances ────────────────────────────────────────────

@router.get("/instances")
async def list_instances(request: Request):
    """List connected instances for the current user."""
    user = get_session_user(request)
    if not user:
        return JSONResponse({"error": "Not authenticated"}, status_code=401)

    email = user["email"]
    instances = tunnel_manager.get_instances_for_user(email)
    return {
        "instances": [i.to_user_view() for i in instances],
    }


@router.get("/instances/{instance_id}")
async def get_instance(request: Request, instance_id: str):
    """Get details about a specific instance."""
    user = get_session_user(request)
    if not user:
        return JSONResponse({"error": "Not authenticated"}, status_code=401)

    instance = tunnel_manager.instances.get(instance_id)
    if not instance:
        return JSONResponse({"error": "Instance not found"}, status_code=404)

    # Users can only see their own instances (admins can see all via /admin)
    if instance.user_email != user["email"] and not user.get("is_admin"):
        return JSONResponse({"error": "Not authorized"}, status_code=403)

    return instance.to_user_view()


# ── API Keys ─────────────────────────────────────────────

@router.get("/keys")
async def list_keys(request: Request):
    """List API keys for the current user."""
    user = get_session_user(request)
    if not user:
        return JSONResponse({"error": "Not authenticated"}, status_code=401)

    db: Database = request.app.state.db
    keys = await db.list_api_keys(user["email"])
    return {
        "keys": [
            {
                "id": k.id,
                "name": k.name,
                "created_at": k.created_at,
                "last_used": k.last_used,
                "enabled": k.enabled,
                "max_sessions": k.max_sessions,
            }
            for k in keys
        ],
    }


@router.post("/keys")
async def create_key(request: Request):
    """Create a new API key. Returns the raw key (shown only once)."""
    user = get_session_user(request)
    if not user:
        return JSONResponse({"error": "Not authenticated"}, status_code=401)

    body = await request.json()
    name = body.get("name", "")
    max_sessions = body.get("max_sessions", 10)

    db: Database = request.app.state.db
    raw_key, api_key = await db.create_api_key(
        user_email=user["email"],
        name=name,
        max_sessions=max_sessions,
    )

    await db.log_action("api_key_created", user["email"], details={"key_id": api_key.id, "name": name})

    return {
        "key": raw_key,  # Shown only once!
        "id": api_key.id,
        "name": api_key.name,
        "created_at": api_key.created_at,
        "max_sessions": api_key.max_sessions,
    }


@router.put("/keys/{key_id}")
async def update_key(request: Request, key_id: str):
    """Update an API key's properties."""
    user = get_session_user(request)
    if not user:
        return JSONResponse({"error": "Not authenticated"}, status_code=401)

    db: Database = request.app.state.db

    # Verify ownership
    keys = await db.list_api_keys(user["email"])
    if not any(k.id == key_id for k in keys):
        return JSONResponse({"error": "Key not found"}, status_code=404)

    body = await request.json()
    updated = await db.update_api_key(
        key_id,
        enabled=body.get("enabled"),
        name=body.get("name"),
        max_sessions=body.get("max_sessions"),
    )

    if not updated:
        return JSONResponse({"error": "No changes"}, status_code=400)

    await db.log_action("api_key_updated", user["email"], details={"key_id": key_id})
    return {"status": "updated"}


@router.delete("/keys/{key_id}")
async def delete_key(request: Request, key_id: str):
    """Delete an API key."""
    user = get_session_user(request)
    if not user:
        return JSONResponse({"error": "Not authenticated"}, status_code=401)

    db: Database = request.app.state.db

    # Verify ownership (or admin)
    keys = await db.list_api_keys(user["email"])
    if not any(k.id == key_id for k in keys) and not user.get("is_admin"):
        return JSONResponse({"error": "Key not found"}, status_code=404)

    deleted = await db.delete_api_key(key_id)
    if not deleted:
        return JSONResponse({"error": "Key not found"}, status_code=404)

    await db.log_action("api_key_deleted", user["email"], details={"key_id": key_id})
    return {"status": "deleted"}


# ── Cockpit-compatible terminal routes (relay mode) ──────

@router.get("/terminals")
async def list_terminals(request: Request):
    """Cockpit-compatible terminal list — aggregates terminals from all user instances."""
    user = get_session_user(request)
    if not user:
        return JSONResponse({"error": "Not authenticated"}, status_code=401)

    email = user["email"]
    instances = tunnel_manager.get_instances_for_user(email)

    terminals = []
    for inst in instances:
        for t in inst.terminals.values():
            terminals.append({
                "id": f"{inst.instance_id}:{t.id}",
                "name": t.name,
                "model": t.model,
                "activity_state": t.activity_state,
                "tokens": t.tokens,
                "cost": t.cost,
                "workdir": t.workdir,
                "instance_id": inst.instance_id,
                "hostname": inst.hostname,
            })

    return JSONResponse({"terminals": terminals})


@router.post("/terminals")
async def create_terminal(request: Request):
    """Create a terminal on a connected desktop via RPC."""
    user = get_session_user(request)
    if not user:
        return JSONResponse({"error": "Not authenticated"}, status_code=401)

    body = await request.json()
    instance_id = body.pop("instance_id", None)

    instances = tunnel_manager.get_instances_for_user(user["email"])
    if not instances:
        return JSONResponse({"error": "No instances connected"}, status_code=400)

    if instance_id:
        instance = tunnel_manager.instances.get(instance_id)
        if not instance or instance.user_email != user["email"]:
            return JSONResponse({"error": "Instance not found"}, status_code=404)
    else:
        instance = instances[0]
        instance_id = instance.instance_id

    try:
        result = await tunnel_manager.send_rpc(instance_id, "create_terminal", body)
        if "error" in result:
            return JSONResponse({"error": result["error"]}, status_code=500)
        # Register terminal metadata immediately so browser WS can connect
        raw_id = result.get("id", "")
        if raw_id:
            instance.terminals[raw_id] = TerminalMeta(
                id=raw_id,
                name=result.get("name", body.get("name", "")),
                model=result.get("model", body.get("model", "")),
                workdir=result.get("working_dir", body.get("workdir", "")),
            )
        # Return compound ID
        result["id"] = f"{instance_id}:{raw_id}"
        return JSONResponse(result)
    except TimeoutError:
        return JSONResponse({"error": "Desktop did not respond in time"}, status_code=504)
    except ConnectionError as e:
        return JSONResponse({"error": str(e)}, status_code=502)
    except Exception as e:
        return JSONResponse({"error": f"RPC failed: {e}"}, status_code=500)


@router.delete("/terminals/{compound_id}")
async def delete_terminal(request: Request, compound_id: str):
    """Kill a terminal on a connected desktop via RPC."""
    user = get_session_user(request)
    if not user:
        return JSONResponse({"error": "Not authenticated"}, status_code=401)

    if ":" not in compound_id:
        return JSONResponse({"error": "Invalid terminal ID format"}, status_code=400)

    instance_id, terminal_id = compound_id.split(":", 1)
    instance = tunnel_manager.instances.get(instance_id)
    if not instance or instance.user_email != user["email"]:
        return JSONResponse({"error": "Instance not found"}, status_code=404)

    try:
        result = await tunnel_manager.send_rpc(instance_id, "kill_terminal", {"terminal_id": terminal_id})
        # Remove from local metadata immediately
        instance.terminals.pop(terminal_id, None)
        return JSONResponse(result)
    except TimeoutError:
        return JSONResponse({"error": "Desktop did not respond in time"}, status_code=504)
    except ConnectionError as e:
        return JSONResponse({"error": str(e)}, status_code=502)
    except Exception as e:
        return JSONResponse({"error": f"RPC failed: {e}"}, status_code=500)


@router.post("/terminals/{compound_id}/input")
async def terminal_input(request: Request, compound_id: str):
    """Send input to a terminal (used for broadcast mode)."""
    user = get_session_user(request)
    if not user:
        return JSONResponse({"error": "Not authenticated"}, status_code=401)

    if ":" not in compound_id:
        return JSONResponse({"error": "Invalid terminal ID format"}, status_code=400)

    instance_id, terminal_id = compound_id.split(":", 1)
    instance = tunnel_manager.instances.get(instance_id)
    if not instance or instance.user_email != user["email"]:
        return JSONResponse({"error": "Instance not found"}, status_code=404)

    body = await request.json()
    text = body.get("text", "")
    if not text:
        return JSONResponse({"error": "No text provided"}, status_code=400)

    await tunnel_manager.forward_to_tunnel(instance_id, terminal_id, text.encode("utf-8"))
    return JSONResponse({"status": "sent"})


# ── Proxied to desktop via RPC ───────────────────────────

@router.get("/browse")
async def browse_directories(request: Request):
    """Browse directories on a connected desktop via RPC."""
    user = get_session_user(request)
    if not user:
        return JSONResponse({"error": "Not authenticated"}, status_code=401)

    path = request.query_params.get("path", "")
    instance_id = request.query_params.get("instance_id", "")

    instances = tunnel_manager.get_instances_for_user(user["email"])
    if not instances:
        return JSONResponse({"dirs": []})

    if instance_id:
        instance = tunnel_manager.instances.get(instance_id)
        if not instance or instance.user_email != user["email"]:
            return JSONResponse({"dirs": []})
    else:
        instance = instances[0]
        instance_id = instance.instance_id

    try:
        result = await tunnel_manager.send_rpc(instance_id, "browse", {"path": path}, timeout=10)
        return JSONResponse(result)
    except Exception:
        return JSONResponse({"dirs": []})


@router.get("/git/status")
async def git_status(request: Request):
    """Get git status from a connected desktop via RPC."""
    user = get_session_user(request)
    if not user:
        return JSONResponse({"error": "Not authenticated"}, status_code=401)

    path = request.query_params.get("path", "")
    instance_id = request.query_params.get("instance_id", "")

    instances = tunnel_manager.get_instances_for_user(user["email"])
    if not instances:
        return JSONResponse({"git": False})

    if instance_id:
        instance = tunnel_manager.instances.get(instance_id)
        if not instance or instance.user_email != user["email"]:
            return JSONResponse({"git": False})
    else:
        instance = instances[0]
        instance_id = instance.instance_id

    try:
        result = await tunnel_manager.send_rpc(instance_id, "git_status", {"path": path}, timeout=10)
        return JSONResponse(result)
    except Exception:
        return JSONResponse({"git": False})


@router.get("/tunnel/status")
async def tunnel_status(request: Request):
    """Tunnel status not meaningful when already on relay."""
    return JSONResponse({"connected": False})
