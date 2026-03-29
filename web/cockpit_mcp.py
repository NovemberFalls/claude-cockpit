#!/usr/bin/env python3
"""
Cockpit MCP server — stdio transport.

Implements the Model Context Protocol so an orchestrator Claude session
can see and control all other worker sessions running in Claude Cockpit.

Run by the cockpit backend as a subprocess when an orchestrator session
is created. Communicates with Claude via stdin/stdout JSON-RPC.
"""

import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request


def _log(msg: str) -> None:
    """Write a diagnostic line to stderr (visible in process logs, not stdout MCP pipe)."""
    sys.stderr.write(f"[cockpit-mcp] {msg}\n")
    sys.stderr.flush()


API_URL = os.environ.get("COCKPIT_API_URL", "http://localhost:8420")
ORCHESTRATOR_ID = os.environ.get("COCKPIT_ORCHESTRATOR_ID", "")

# Thread safety for stdout writes and pending wait tracking
_send_lock = threading.Lock()
_pending_waits: dict = {}  # msg_id -> threading.Event for cancellation

TOOLS = [
    {
        "name": "list_sessions",
        "description": (
            "List all active worker sessions in Claude Cockpit. "
            "Returns each session's terminal_id (use this to target it), "
            "name, model, status, and working directory."
        ),
        "inputSchema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "get_output",
        "description": (
            "Get recent terminal output from a worker session. "
            "Returns the last N lines of ANSI-stripped text so you can see "
            "what Claude is doing or what it last said."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "terminal_id": {
                    "type": "string",
                    "description": "The 8-char hex terminal ID from list_sessions",
                },
                "lines": {
                    "type": "integer",
                    "description": "Number of recent lines to return (default 50, max 500)",
                    "default": 50,
                },
                "since": {
                    "type": "integer",
                    "description": "Return only lines at index >= since. Use the total_lines from the previous get_output call as the cursor. Default 0 = all lines.",
                    "default": 0,
                },
            },
            "required": ["terminal_id"],
        },
    },
    {
        "name": "send_input",
        "description": (
            "Send text input to a worker session's terminal — as if you typed it. "
            "Include \\n at the end to press Enter and submit the message. "
            "Use this to give instructions or tasks to a worker."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "terminal_id": {
                    "type": "string",
                    "description": "The 8-char hex terminal ID from list_sessions",
                },
                "text": {
                    "type": "string",
                    "description": "Text to send. Include \\n to press Enter.",
                },
                "wait_for_response": {
                    "type": "boolean",
                    "description": (
                        "If true, after sending the input, wait up to 120 seconds "
                        "for the session to go idle, then return the new output lines. "
                        "Default false."
                    ),
                    "default": False,
                },
            },
            "required": ["terminal_id", "text"],
        },
    },
    {
        "name": "get_state",
        "description": (
            "Get the current activity state of a worker session. "
            "Returns one of: idle, busy, waiting, starting, unknown. "
            "Use this to check if a worker has finished before reading output."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "terminal_id": {
                    "type": "string",
                    "description": "The 8-char hex terminal ID from list_sessions",
                },
            },
            "required": ["terminal_id"],
        },
    },
    {
        "name": "create_session",
        "description": (
            "Spawn a new worker Claude session in Cockpit. "
            "The new session will appear as a pane in the UI. "
            "Returns the terminal_id you can use to send it tasks. "
            "Pass character_file to load a persona (e.g. Nadia or a specialist). "
            "Pass as_orchestrator=true to give the session its own MCP tools so it "
            "can spawn and coordinate further sub-workers."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Display name for the session"},
                "workdir": {"type": "string", "description": "Working directory path"},
                "model": {
                    "type": "string",
                    "description": "Claude model (sonnet, opus, haiku)",
                    "default": "sonnet",
                },
                "character_file": {
                    "type": "string",
                    "description": (
                        "Absolute path to a persona/character .md file to load as "
                        "the session's system prompt. Use this to spawn a Nadia worker "
                        "or a specialist (Ash, Finn, Zara, Sam, Dev, Sage)."
                    ),
                },
                "as_orchestrator": {
                    "type": "boolean",
                    "description": (
                        "If true, the new session gets its own Cockpit MCP tools, "
                        "making it a sub-orchestrator that can spawn and coordinate "
                        "its own workers. Default false."
                    ),
                    "default": False,
                },
            },
            "required": [],
        },
    },
]


def api(method: str, path: str, body=None, retries: int = 2):
    """Make an HTTP request to the Cockpit backend with retry on transient errors."""
    url = API_URL + path
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    last_err = None
    for attempt in range(1 + retries):
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            # HTTP errors (4xx/5xx) are not transient — don't retry
            err = f"HTTP {e.code}: {e.read().decode()}"
            _log(f"API error {method} {path}: {err}")
            return {"error": err}
        except Exception as e:
            last_err = e
            if attempt < retries:
                _log(f"API retry {attempt + 1}/{retries} {method} {path}: {e}")
                time.sleep(0.5 * (attempt + 1))
            else:
                _log(f"API failed {method} {path} after {1 + retries} attempts: {e}")
    return {"error": str(last_err)}


def send(msg: dict):
    """Thread-safe JSON-RPC message over stdout."""
    with _send_lock:
        line = json.dumps(msg)
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def _wait_worker(msg_id, tid: str, since: int, cancel: threading.Event):
    """Background thread: poll until worker goes idle, then send MCP response.

    Runs outside the main stdin loop so pings and cancellations are still handled.
    """
    time.sleep(1.5)
    deadline = time.time() + 120
    final_state = "unknown"

    while time.time() < deadline:
        if cancel.is_set():
            _log(f"Wait cancelled for request {msg_id}")
            _pending_waits.pop(msg_id, None)
            return

        state_result = api("GET", "/api/terminals", retries=1)
        if "error" not in state_result:
            for t in state_result.get("terminals", []):
                if t["id"] == tid:
                    final_state = t.get("activity_state", "unknown")
                    break

        # Only break on confirmed idle — never treat "unknown" as complete
        if final_state == "idle":
            break

        time.sleep(2.0)

    _pending_waits.pop(msg_id, None)

    if cancel.is_set():
        return

    out = api("GET", f"/api/terminals/{tid}/output?since={since}")
    if "error" in out:
        result = {"status": "sent", "warning": "Could not read response", "activity_state": final_state}
    else:
        result = {
            "status": "sent",
            "response_lines": out.get("lines", []),
            "total_lines": out.get("total_lines", 0),
            "next_since": out.get("total_lines", 0),
            "activity_state": out.get("activity_state", final_state),
        }

    _log(f"Wait complete for {msg_id}: state={final_state}")
    send({
        "jsonrpc": "2.0", "id": msg_id,
        "result": {
            "content": [{"type": "text", "text": json.dumps(result, indent=2)}],
        },
    })


def call_tool(name: str, args: dict, msg_id=None):
    """Execute an MCP tool.

    Returns (result_dict, deferred_bool).
    If deferred is True, the response will be sent by a background thread
    and the caller must NOT send a response for this msg_id.
    """
    if name == "list_sessions":
        result = api("GET", "/api/terminals")
        terminals = result.get("terminals", [])
        # Exclude the orchestrator itself from the worker list
        workers = [
            {
                "terminal_id": t["id"],
                "name": t["name"],
                "model": t.get("model", "?"),
                "status": t.get("activity_state", t.get("status", "?")),
                "workdir": t.get("working_dir", ""),
            }
            for t in terminals
            if t["id"] != ORCHESTRATOR_ID
        ]
        return {"sessions": workers, "count": len(workers)}, False

    elif name == "get_output":
        tid = args["terminal_id"]
        max_lines = min(int(args.get("lines", 50)), 500)
        since = int(args.get("since", 0))
        url = f"/api/terminals/{tid}/output?since={since}"
        result = api("GET", url)
        if "error" in result:
            return result, False
        lines = result.get("lines", [])
        total_lines = result.get("total_lines", len(lines) + since)
        activity_state = result.get("activity_state", "unknown")
        return {
            "terminal_id": tid,
            "lines": lines[-max_lines:] if len(lines) > max_lines else lines,
            "total_lines": total_lines,
            "next_since": total_lines,
            "activity_state": activity_state,
        }, False

    elif name == "send_input":
        tid = args["terminal_id"]
        text = args["text"]
        wait = args.get("wait_for_response", False)

        # MCP frameworks pass escape sequences as literal two-char strings (e.g. backslash-n
        # instead of 0x0A). Translate the common ones so a trailing \n submits the message.
        # Claude Code's PTY uses CR (0x0D) to submit — map \n → \r so callers can use \n
        # as the conventional "press Enter" signal without needing a separate \r send.
        text = (
            text
            .replace("\\n", "\r")
            .replace("\\r", "\r")
            .replace("\\t", "\t")
            .replace("\\u0003", "\x03")
            .replace("\\x03", "\x03")
        )

        # Get the current output cursor before sending
        pre_result = api("GET", f"/api/terminals/{tid}/output")
        since = pre_result.get("total_lines", 0) if "error" not in pre_result else 0

        # Send the input
        result = api("POST", f"/api/terminals/{tid}/input", {"text": text})
        if "error" in result:
            return result, False

        if not wait:
            return result, False

        # Spawn background thread so the stdin loop stays responsive to
        # pings and cancellation notifications during the wait.
        cancel = threading.Event()
        _pending_waits[msg_id] = cancel
        t = threading.Thread(
            target=_wait_worker,
            args=(msg_id, tid, since, cancel),
            daemon=True,
        )
        t.start()
        return None, True  # Response sent by background thread

    elif name == "get_state":
        tid = args["terminal_id"]
        result = api("GET", "/api/terminals")
        if "error" in result:
            return result, False
        for t in result.get("terminals", []):
            if t["id"] == tid:
                return {
                    "terminal_id": tid,
                    "activity_state": t.get("activity_state", "unknown"),
                    "alive": t.get("alive", False),
                }, False
        return {"error": f"Terminal {tid} not found"}, False

    elif name == "create_session":
        body = {
            "name": args.get("name", "Worker"),
            "workdir": args.get("workdir", ""),
            "model": args.get("model", "sonnet"),
            "cols": 120,
            "rows": 30,
            "isOrchestrator": bool(args.get("as_orchestrator", False)),
            "systemPromptFile": args.get("character_file", ""),
            "bypassPermissions": True,
        }
        result = api("POST", "/api/terminals", body)
        if "error" in result:
            return result, False
        return {
            "terminal_id": result.get("id"),
            "name": result.get("name"),
            "model": result.get("model"),
            "is_orchestrator": result.get("is_orchestrator", False),
        }, False

    else:
        return {"error": f"Unknown tool: {name}"}, False


def main():
    _log(f"Starting — API={API_URL}  orchestrator={ORCHESTRATOR_ID}")
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            continue

        method = msg.get("method", "")
        msg_id = msg.get("id")

        # ── Lifecycle ────────────────────────────────────

        if method == "initialize":
            # Negotiate protocol version — echo the client's requested version
            # so we stay compatible as the MCP spec evolves.
            params = msg.get("params", {})
            client_version = params.get("protocolVersion", "2024-11-05")
            send({
                "jsonrpc": "2.0", "id": msg_id,
                "result": {
                    "protocolVersion": client_version,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "cockpit-mcp", "version": "1.0.0"},
                },
            })

        elif method == "ping":
            send({"jsonrpc": "2.0", "id": msg_id, "result": {}})

        # ── Discovery ────────────────────────────────────

        elif method == "tools/list":
            send({"jsonrpc": "2.0", "id": msg_id, "result": {"tools": TOOLS}})

        elif method == "resources/list":
            send({"jsonrpc": "2.0", "id": msg_id, "result": {"resources": []}})

        elif method == "prompts/list":
            send({"jsonrpc": "2.0", "id": msg_id, "result": {"prompts": []}})

        # ── Tool execution ───────────────────────────────

        elif method == "tools/call":
            params = msg.get("params", {})
            tool_name = params.get("name", "")
            tool_args = params.get("arguments", {})
            _log(f"Tool call: {tool_name}({tool_args})")
            try:
                result, deferred = call_tool(tool_name, tool_args, msg_id=msg_id)
                if deferred:
                    _log(f"Tool deferred: {tool_name} (waiting in background)")
                    continue  # Background thread will send response
                _log(f"Tool result: {tool_name} → ok")
                send({
                    "jsonrpc": "2.0", "id": msg_id,
                    "result": {
                        "content": [{"type": "text", "text": json.dumps(result, indent=2)}],
                    },
                })
            except Exception as e:
                _log(f"Tool error: {tool_name} → {e}")
                send({
                    "jsonrpc": "2.0", "id": msg_id,
                    "error": {"code": -32603, "message": str(e)},
                })

        # ── Notifications (no response required) ─────────

        elif method == "notifications/initialized":
            pass

        elif method == "notifications/cancelled":
            params = msg.get("params", {})
            cancelled_id = params.get("requestId")
            if cancelled_id is not None:
                cancel_event = _pending_waits.get(cancelled_id)
                if cancel_event:
                    _log(f"Cancelling pending wait for request {cancelled_id}")
                    cancel_event.set()

        # ── Unknown method ───────────────────────────────

        else:
            if msg_id is not None:
                send({
                    "jsonrpc": "2.0", "id": msg_id,
                    "error": {"code": -32601, "message": f"Method not found: {method}"},
                })


if __name__ == "__main__":
    main()
