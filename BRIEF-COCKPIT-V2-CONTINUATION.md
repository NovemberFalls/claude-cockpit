# Cockpit v2 Continuation Brief

## Current State

Branch: `feature/cockpit-v2-chat` (commit `00b4ff3`)
Build: Compiles clean. Vite build passes. Backend imports clean.

### What Works
- **Chat UI renders** — JSONL-powered message bubbles (user, assistant, tool calls, thinking blocks)
- **Native input** — ChatInput with Ctrl+V paste, Shift+Enter newline, Enter to send, file drag-drop, `/` skill autocomplete
- **Chat/terminal toggle** — per-session toggle button in pane header
- **JSONL discovery** — pre-spawn directory snapshot, detects new files created by Claude Code
- **Awareness API** — `GET /api/awareness` returns MCP servers, skills, memory, CLAUDE.md
- **No WebSocket conflict** — ChatPane uses REST API for input, only TerminalPane opens WS

### What Doesn't Work
- **`/resume` in chat mode** — Claude Code's `/resume` changes the session ID. Chat mode can only discover JSONL files for NEW sessions (Strategy 2: pre-spawn diff). Resumed sessions require terminal mode.
- **History panel** — not built yet. This is the key missing feature.
- **Typing lag** — JSONL polling at 1s intervals means responses appear with a delay. SSE endpoint exists but ChatPane uses polling.
- **Tauri sidecar conflict** — Tauri dev mode's `concurrently` script tries to start `cockpit-server.exe` alongside `python server.py`, causing port conflicts and sidecar crash warnings.

## Next Session: History Panel + Resume Fix

### The Plan

Build a History panel in the sidebar that lists all previous Claude Code sessions. This replaces the terminal-mode `/resume` picker entirely.

#### Backend: `GET /api/history`

```
GET /api/history?workdir=C:\Code\Personal
```

Response:
```json
{
  "sessions": [
    {
      "session_id": "8d954ce1-5094-4f03-91d4-42f63510b987",
      "first_message": "Fix the auth bug in login.py",
      "last_modified": "2026-04-09T11:43:00Z",
      "message_count": 47,
      "model": "sonnet",
      "file_size_kb": 46
    },
    ...
  ]
}
```

Implementation: scan `~/.claude/projects/<project-id>/` for `*.jsonl` files. For each file, read the first few lines to extract:
- `sessionId` (from first entry)
- First user message text (preview)
- Model (from first assistant entry)
- Timestamp of first and last entry
- Line count or message count

Cache the scan results (invalidate when directory mtime changes).

#### Frontend: HistoryPanel Component

- New tab in Sidebar: "Sessions" | "History" toggle
- Each history entry shows: first message preview (truncated), relative time ("2 hours ago"), model badge, message count
- **Click** → loads conversation READ-ONLY into focused ChatPane (renders JSONL without a PTY)
- **"Resume" button** → spawns new PTY with `claude --resume <session-id>`, sets `claude_session_id` on the session, ChatPane loads from the known JSONL path
- **Drag** → drag entry to a specific pane slot

#### ChatPane Changes for Read-Only Mode

ChatPane currently requires a `terminalId` (PTY session). For read-only history viewing:
- Add a `jsonlPath` prop that, when set, loads messages from that file directly via `GET /api/history/<session-id>/messages`
- Input bar shows "Resume to continue this conversation" instead of the textarea
- "Resume" button in the input area spawns a PTY and transitions to full chat mode

#### Resume Flow (Replaces Terminal `/resume`)

1. User clicks "Resume" on a history entry (or clicks the button in read-only chat view)
2. Frontend calls `POST /api/terminals` with `resume_session_id: <session-id>`
3. Backend spawns `claude --resume <session-id>` — the `--resume` flag IS respected by Claude Code
4. Backend sets `claude_session_id = session-id` — this IS the correct JSONL file since we're resuming it
5. ChatPane loads messages from the known JSONL path
6. Full chat mode with input enabled

This makes the JSONL discovery problem irrelevant for resumed sessions — the session ID is known because the user explicitly selected it.

### Key Files to Touch

| File | Changes |
|------|---------|
| `web/server.py` | Add `GET /api/history` endpoint |
| `web/frontend/src/components/HistoryPanel.jsx` | NEW — history list with search, resume buttons |
| `web/frontend/src/components/ChatPane.jsx` | Add read-only mode via `jsonlPath` prop |
| `web/frontend/src/components/Sidebar.jsx` | Add Sessions/History tab toggle, render HistoryPanel |
| `web/frontend/src/App.jsx` | Wire history resume to `createSession` with `resume_session_id` |

### Stretch Goals (Same Session if Context Allows)

1. **SSE streaming** — replace 1s polling with EventSource connection to `GET /api/terminals/{id}/messages/stream` for instant message rendering
2. **Markdown rendering** — render assistant text as markdown (need `marked` or `react-markdown` dep)
3. **Search across history** — full-text search in the history panel
4. **AwarenessPanel** — wire the existing awareness data into the sidebar (component already exists from earlier work, just needs to be rebuilt)

### Dev Environment Notes

- Tauri dev: `cd web/frontend && npm run tauri:dev` (runs backend + vite + tauri via concurrently)
- Browser dev: start `python web/server.py` + `cd web/frontend && npm run dev` separately, open `http://localhost:5174`
- The Tauri sidecar crash warning is cosmetic — the Python backend wins the port race
- Backend changes require restart (no hot-reload for Python)
- Frontend changes hot-reload via Vite

### JSONL Format Reference

Each line is a JSON object. Key types:
- `type: "user"` — `message.content` is string (user text) or array (tool_result blocks)
- `type: "assistant"` — `message.content` is array of `{type: "text"|"tool_use"|"thinking", ...}`
- `type: "system"` — system messages
- `type: "queue-operation"` — skip (internal)
- `type: "last-prompt"` — skip (internal)

Fields: `uuid`, `parentUuid`, `timestamp`, `sessionId`, `message.model`

Project ID derivation: `C:\Code\Personal` → replace `\` with `-`, replace `:` with `-`, strip leading `-` → `C--Code-Personal`

JSONL path: `~/.claude/projects/C--Code-Personal/<session-uuid>.jsonl`
