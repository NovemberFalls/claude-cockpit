"""Admin API routes — metadata only, NEVER terminal content.

Privacy boundary enforced: admin endpoints return only
instance metadata (user, hostname, session count, tokens, cost, status).
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..auth import get_session_user
from ..models import Database
from ..tunnel_manager import tunnel_manager

router = APIRouter(prefix="/api/admin")


def _require_admin(request: Request) -> dict | None:
    """Return user dict if admin, else None."""
    user = get_session_user(request)
    if not user:
        return None
    if not user.get("is_admin"):
        return None
    return user


@router.get("/instances")
async def admin_list_instances(request: Request):
    """List ALL connected instances with metadata (no content)."""
    user = _require_admin(request)
    if not user:
        return JSONResponse({"error": "Admin access required"}, status_code=403)

    instances = tunnel_manager.get_all_instances()
    return {
        "instances": [i.to_metadata() for i in instances],
    }


@router.get("/instances/{instance_id}")
async def admin_get_instance(request: Request, instance_id: str):
    """Get metadata for a specific instance."""
    user = _require_admin(request)
    if not user:
        return JSONResponse({"error": "Admin access required"}, status_code=403)

    instance = tunnel_manager.instances.get(instance_id)
    if not instance:
        return JSONResponse({"error": "Instance not found"}, status_code=404)

    return instance.to_metadata()


@router.post("/instances/{instance_id}/kill")
async def admin_kill_instance(request: Request, instance_id: str):
    """Kill switch: disconnect an instance, optionally disable its API key."""
    user = _require_admin(request)
    if not user:
        return JSONResponse({"error": "Admin access required"}, status_code=403)

    body = await request.json() if request.headers.get("content-type") == "application/json" else {}
    disable_key = body.get("disable_key", False)

    instance = tunnel_manager.instances.get(instance_id)
    if not instance:
        return JSONResponse({"error": "Instance not found"}, status_code=404)

    # Log before killing
    db: Database = request.app.state.db
    await db.log_action(
        "admin_kill",
        user["email"],
        instance_id,
        {"disable_key": disable_key, "target_user": instance.user_email},
    )

    # If disable_key requested, disable the API key
    if disable_key:
        await db.update_api_key(instance.api_key_id, enabled=False)

    killed = await tunnel_manager.admin_kill_instance(instance_id)
    if not killed:
        return JSONResponse({"error": "Failed to kill instance"}, status_code=500)

    return {"status": "killed", "key_disabled": disable_key}


@router.get("/keys")
async def admin_list_all_keys(request: Request):
    """List ALL API keys across all users."""
    user = _require_admin(request)
    if not user:
        return JSONResponse({"error": "Admin access required"}, status_code=403)

    db: Database = request.app.state.db
    keys = await db.list_api_keys()
    return {
        "keys": [
            {
                "id": k.id,
                "user_email": k.user_email,
                "name": k.name,
                "created_at": k.created_at,
                "last_used": k.last_used,
                "enabled": k.enabled,
                "max_sessions": k.max_sessions,
            }
            for k in keys
        ],
    }


@router.get("/audit")
async def admin_audit_log(request: Request):
    """Get recent audit log entries."""
    user = _require_admin(request)
    if not user:
        return JSONResponse({"error": "Admin access required"}, status_code=403)

    db: Database = request.app.state.db
    limit = int(request.query_params.get("limit", "100"))
    entries = await db.get_audit_log(limit=min(limit, 500))
    return {"entries": entries}
