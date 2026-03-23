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
import urllib.error
import urllib.request

API_URL = os.environ.get("COCKPIT_API_URL", "http://localhost:8420")
ORCHESTRATOR_ID = os.environ.get("COCKPIT_ORCHESTRATOR_ID", "")

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
                    "description": "Number of recent lines to return (default 50, max 200)",
                    "default": 50,
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
            },
            "required": ["terminal_id", "text"],
        },
    },
    {
        "name": "create_session",
        "description": (
            "Spawn a new worker Claude session in Cockpit. "
            "The new session will appear as a pane in the UI. "
            "Returns the terminal_id you can use to send it tasks."
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
            },
            "required": [],
        },
    },
]


def api(method: str, path: str, body=None):
    """Make an HTTP request to the Cockpit backend."""
    url = API_URL + path
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"error": f"HTTP {e.code}: {e.read().decode()}"}
    except Exception as e:
        return {"error": str(e)}


def call_tool(name: str, args: dict):
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
        return {"sessions": workers, "count": len(workers)}

    elif name == "get_output":
        tid = args["terminal_id"]
        max_lines = min(int(args.get("lines", 50)), 200)
        result = api("GET", f"/api/terminals/{tid}/output")
        if "error" in result:
            return result
        lines = result.get("lines", [])
        return {
            "terminal_id": tid,
            "lines": lines[-max_lines:],
            "total_buffered": len(lines),
        }

    elif name == "send_input":
        tid = args["terminal_id"]
        text = args["text"]
        result = api("POST", f"/api/terminals/{tid}/input", {"text": text})
        return result

    elif name == "create_session":
        body = {
            "name": args.get("name", "Worker"),
            "workdir": args.get("workdir", ""),
            "model": args.get("model", "sonnet"),
            "cols": 120,
            "rows": 30,
        }
        result = api("POST", "/api/terminals", body)
        if "error" in result:
            return result
        return {
            "terminal_id": result.get("id"),
            "name": result.get("name"),
            "model": result.get("model"),
        }

    else:
        return {"error": f"Unknown tool: {name}"}


def send(msg: dict):
    line = json.dumps(msg)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def main():
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

        if method == "initialize":
            send({
                "jsonrpc": "2.0", "id": msg_id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "cockpit-mcp", "version": "1.0.0"},
                },
            })

        elif method == "tools/list":
            send({"jsonrpc": "2.0", "id": msg_id, "result": {"tools": TOOLS}})

        elif method == "tools/call":
            params = msg.get("params", {})
            tool_name = params.get("name", "")
            tool_args = params.get("arguments", {})
            try:
                result = call_tool(tool_name, tool_args)
                send({
                    "jsonrpc": "2.0", "id": msg_id,
                    "result": {
                        "content": [{"type": "text", "text": json.dumps(result, indent=2)}],
                    },
                })
            except Exception as e:
                send({
                    "jsonrpc": "2.0", "id": msg_id,
                    "error": {"code": -32603, "message": str(e)},
                })

        elif method in ("notifications/initialized", "notifications/cancelled"):
            pass  # No response for notifications

        else:
            if msg_id is not None:
                send({
                    "jsonrpc": "2.0", "id": msg_id,
                    "error": {"code": -32601, "message": f"Method not found: {method}"},
                })


if __name__ == "__main__":
    main()
