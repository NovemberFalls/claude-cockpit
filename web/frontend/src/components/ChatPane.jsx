import { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from "react";
import { X, GripVertical, MessageSquare, Terminal as TerminalIcon, Smartphone } from "lucide-react";
import { useTheme } from "../hooks/useTheme";
import StateIcon from "./StateIcon";
import MessageBubble from "./MessageBubble";
import StreamingIndicator from "./StreamingIndicator";
import ChatInput from "./ChatInput";

/**
 * Check if an assistant message contains ONLY tool_use blocks (no text).
 */
function isToolOnlyAssistant(msg) {
  if (msg.type !== "assistant") return false;
  const blocks = msg.content || [];
  return blocks.length > 0 && blocks.every((b) => b.type === "tool_use" || b.type === "thinking");
}

/**
 * Group messages:
 * 1. Merge consecutive tool-only assistant messages into one
 * 2. Pair tool_result messages with their preceding assistant message
 * This collapses sequences like [assistant(Read), tool_result, assistant(Read), tool_result]
 * into a single "3 tool calls" collapsed section.
 */
function groupMessages(messages) {
  const result = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];

    // Skip tool_results — they get paired with the preceding assistant message
    if (msg.type === "tool_result") {
      result.push(msg);
      i++;
      continue;
    }

    // For tool-only assistant messages, merge consecutive ones
    if (isToolOnlyAssistant(msg)) {
      const mergedToolBlocks = [];
      const mergedResults = [];
      const mergedThinking = [];
      let j = i;

      // Consume consecutive [tool-only-assistant, tool_result*] sequences
      while (j < messages.length) {
        const current = messages[j];
        if (isToolOnlyAssistant(current)) {
          for (const block of current.content || []) {
            if (block.type === "tool_use") mergedToolBlocks.push(block);
            else if (block.type === "thinking") mergedThinking.push(block);
          }
          j++;
          // Consume following tool_results
          while (j < messages.length && messages[j].type === "tool_result") {
            for (const block of messages[j].content || []) {
              mergedResults.push(block);
            }
            j++;
          }
        } else {
          break;
        }
      }

      // Build merged message using the first message as base
      result.push({
        ...msg,
        content: [...mergedThinking, ...mergedToolBlocks],
        _pairedResults: mergedResults,
      });
      i = j;
      continue;
    }

    // Assistant message with text + tool_use: pair with following tool_results
    if (msg.type === "assistant" && msg.content?.some((b) => b.type === "tool_use")) {
      const pairedResults = [];
      let j = i + 1;
      while (j < messages.length && messages[j].type === "tool_result") {
        for (const block of messages[j].content || []) {
          pairedResults.push(block);
        }
        j++;
      }
      result.push({ ...msg, _pairedResults: pairedResults });
      i = j;
      continue;
    }

    result.push(msg);
    i++;
  }
  return result;
}

/**
 * ChatPane — renders a conversation as a chat UI with messages from JSONL.
 *
 * Replaces TerminalPane as the default view. The PTY still runs underneath;
 * input is sent to the PTY via WebSocket, and conversation data is read from
 * Claude Code's JSONL session files via the /api/terminals/{id}/messages endpoint.
 *
 * Props:
 *   session            — { id, name, terminalId, model, status, activityState, tokens, cost, context_percent }
 *   onClose            — () => void
 *   paneIndex          — number
 *   onSwap             — (from, to) => void
 *   onPlace            — (sessionId, slot) => void
 *   onDragSourceChange — (paneIndex|null) => void
 *   toast              — (msg, type) => void
 *   skills             — [{name, description}]
 *   isFocused          — boolean
 *   onViewToggle       — () => void — switch to terminal view
 *   historySessionId   — string|null — when set, enables read-only history viewing mode
 *   onResume           — function|null — callback to resume a history session; shows Resume button when provided
 */
const ChatPane = forwardRef(function ChatPane({
  session,
  onClose,
  paneIndex,
  onSwap,
  onPlace,
  onDragSourceChange,
  toast,
  skills = [],
  isFocused = false,
  onViewToggle,
  historySessionId = null,
  onResume = null,
}, ref) {
  const { theme } = useTheme();
  const [messages, setMessages] = useState([]);
  const messagesEndRef = useRef(null);
  const messageListRef = useRef(null);
  const inputRef = useRef(null);
  const pollTimerRef = useRef(null);
  const lastMessageCountRef = useRef(0);
  const autoScrollRef = useRef(true);

  const isHistoryView = !!historySessionId;

  // ChatPane does NOT open a WebSocket — that would drain the PTY output
  // queue and break TerminalPane when the user toggles views.
  // Input is sent via REST API instead.
  const connected = !isHistoryView && session.status === "running" && !!session.terminalId;

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus?.(),
  }));

  // One-time fetch for history view
  useEffect(() => {
    if (!isHistoryView) return;

    const fetchHistory = async () => {
      try {
        const res = await fetch(
          `/api/history/${historySessionId}/messages?workdir=${encodeURIComponent(session.workdir)}`
        );
        if (!res.ok) return;
        const data = await res.json();
        if (data.messages) {
          const seen = new Map();
          for (const msg of data.messages) {
            seen.set(msg.id, msg);
          }
          setMessages([...seen.values()]);
        }
      } catch {
        // Network error — history load failed silently
      }
    };

    fetchHistory();
  }, [isHistoryView, historySessionId, session.workdir]);

  // Poll for messages from the JSONL file (live sessions only)
  useEffect(() => {
    if (isHistoryView || !session.terminalId) return;

    const fetchMessages = async () => {
      try {
        const res = await fetch(`/api/terminals/${session.terminalId}/messages`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.messages && data.messages.length !== lastMessageCountRef.current) {
          lastMessageCountRef.current = data.messages.length;

          // Deduplicate assistant messages — JSONL writes partial then complete
          // Keep only the LAST entry per uuid
          const seen = new Map();
          for (const msg of data.messages) {
            seen.set(msg.id, msg);
          }
          setMessages([...seen.values()]);
        }
      } catch {
        // Network error — retry next poll
      }
    };

    fetchMessages();
    pollTimerRef.current = setInterval(fetchMessages, 1000);
    return () => clearInterval(pollTimerRef.current);
  }, [isHistoryView, session.terminalId]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (autoScrollRef.current && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages.length]);

  // Detect if user scrolled up (disable auto-scroll)
  const handleScroll = useCallback(() => {
    const el = messageListRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    autoScrollRef.current = atBottom;
  }, []);

  // Send message to PTY via REST API (not WebSocket — WS would drain the output queue)
  const handleSend = useCallback((text) => {
    if (isHistoryView || !session.terminalId) return;
    fetch(`/api/terminals/${session.terminalId}/input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text + "\r" }),
    }).catch(() => {});
  }, [isHistoryView, session.terminalId]);

  // Handle file drop — upload then send path to PTY
  const handleFileDrop = useCallback(async (files) => {
    if (isHistoryView) return;
    const formData = new FormData();
    files.forEach((f) => formData.append("files", f));
    try {
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      const data = await res.json();
      if (data.error) {
        toast?.(`Upload failed: ${data.error}`, "error");
        return;
      }
      if (data.paths?.length && session.terminalId) {
        const pathStr = data.paths.map((p) => (p.includes(" ") ? `"${p}"` : p)).join(" ");
        fetch(`/api/terminals/${session.terminalId}/input`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: pathStr }),
        }).catch(() => {});
        toast?.(`Attached ${data.paths.length} file${data.paths.length > 1 ? "s" : ""}`, "success");
      }
    } catch (err) {
      toast?.(`Upload failed: ${err.message}`, "error");
    }
  }, [isHistoryView, toast]);

  const activityState = session.activityState || (session.status === "running" ? "idle" : session.status);
  const isWaiting = activityState === "waiting";

  const formatTokens = (n) => {
    if (!n) return null;
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
    return `${n}`;
  };

  return (
    <div
      className="flex flex-col h-full min-w-0"
      style={{
        boxShadow: isFocused
          ? `inset 0 0 0 1px ${theme.accent}40`
          : isWaiting
          ? "inset 0 0 0 1px var(--yellow), 0 0 15px rgba(234, 179, 8, 0.3)"
          : "none",
        animation: isWaiting ? "attention-glow 2s ease-in-out infinite" : "none",
        transition: "box-shadow 0.3s ease",
      }}
    >
      {/* Pane header */}
      <div
        className="flex items-center justify-between px-3 h-9 flex-shrink-0"
        style={{
          borderBottom: "1px solid var(--border-color)",
          cursor: onSwap ? "grab" : "default",
        }}
        draggable={onSwap != null}
        onDragStart={(e) => {
          if (paneIndex == null) return;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", `pane:${paneIndex}`);
          const ghost = document.createElement("div");
          ghost.textContent = session.name;
          ghost.style.cssText = `
            position: fixed; top: -100px;
            padding: 4px 12px; border-radius: 6px; font-size: 11px; font-weight: 600;
            background: var(--bg-elevated); color: var(--accent);
            border: 1px solid var(--accent); white-space: nowrap;
          `;
          document.body.appendChild(ghost);
          e.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, ghost.offsetHeight / 2);
          requestAnimationFrame(() => document.body.removeChild(ghost));
          onDragSourceChange?.(paneIndex);
        }}
        onDragEnd={() => onDragSourceChange?.(null)}
      >
        <div className="flex items-center gap-2 min-w-0">
          {onSwap && (
            <GripVertical size={12} className="flex-shrink-0 cursor-grab" style={{ color: "var(--text-muted)" }} />
          )}
          <StateIcon state={activityState} />
          <span className="text-xs font-medium truncate" style={{ color: "var(--text-primary)" }}>
            {session.name}
          </span>
          <span
            className="text-[10px] px-1.5 py-0.5 rounded-full"
            style={{ color: "var(--text-muted)", backgroundColor: "var(--bg-surface)" }}
          >
            {session.model}
          </span>
          {isHistoryView && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded-full"
              style={{ color: "var(--text-muted)", backgroundColor: "var(--bg-surface)" }}
            >
              HISTORY
            </span>
          )}
          {(session.tokens > 0 || session.cost > 0) && (
            <div className="flex items-center gap-1.5 ml-1">
              {session.tokens > 0 && (
                <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                  {formatTokens(session.tokens)}t
                </span>
              )}
              {session.cost > 0 && (
                <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                  ${session.cost.toFixed(2)}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          {/* Remote control — send /remote-control to PTY */}
          {connected && (
            <button
              onClick={() => handleSend("/remote-control")}
              className="p-0.5 rounded transition-colors hover-color-secondary"
              style={{ color: "var(--text-muted)" }}
              title="Enable remote control from phone"
            >
              <Smartphone size={13} />
            </button>
          )}
          {/* View toggle — hidden in history mode */}
          {!isHistoryView && (
            <button
              onClick={onViewToggle}
              className="p-0.5 rounded transition-colors hover-color-secondary"
              style={{ color: "var(--text-muted)" }}
              title="Switch to terminal view"
            >
              <TerminalIcon size={13} />
            </button>
          )}
          <button
            onClick={onClose}
            className="p-0.5 rounded transition-colors hover-color-red"
            style={{ color: "var(--text-muted)" }}
            title={isHistoryView ? "Close history view" : "Close session"}
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Context gauge */}
      {session.context_percent != null && (
        <div style={{ height: 2, backgroundColor: "var(--bg-elevated)", flexShrink: 0 }}>
          <div style={{
            height: "100%",
            width: `${session.context_percent}%`,
            backgroundColor: session.context_percent > 75 ? "var(--red)"
              : session.context_percent > 50 ? "var(--yellow)" : "var(--green)",
            transition: "width 0.5s ease, background-color 0.3s ease",
          }} />
        </div>
      )}

      {/* Message list */}
      <div
        ref={messageListRef}
        className="flex-1 min-h-0 overflow-y-auto"
        style={{ backgroundColor: theme.bg }}
        onScroll={handleScroll}
      >
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center" style={{ color: "var(--text-muted)" }}>
              <MessageSquare size={24} className="mx-auto mb-2" style={{ opacity: 0.3 }} />
              <p className="text-xs">
                {isHistoryView
                  ? "No messages in this conversation"
                  : session.status === "starting"
                  ? "Starting session..."
                  : "Send a message to begin"}
              </p>
            </div>
          </div>
        )}
        {groupMessages(messages).map((msg) => (
          <MessageBubble key={msg.id} message={msg} theme={theme} />
        ))}
        {!isHistoryView && <StreamingIndicator state={activityState} />}
        <div ref={messagesEndRef} />
      </div>

      {/* Input — read-only bar in history mode, ChatInput in live mode */}
      {isHistoryView ? (
        <div
          className="flex items-center justify-between px-4 py-2"
          style={{
            borderTop: "1px solid var(--border-color)",
            backgroundColor: "var(--bg-surface)",
          }}
        >
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            Read-only — this is a past conversation
          </span>
          {onResume && (
            <button
              onClick={onResume}
              className="text-xs font-medium px-3 py-1 rounded-md transition-colors"
              style={{
                backgroundColor: "var(--accent)",
                color: "var(--bg)",
              }}
            >
              Resume
            </button>
          )}
        </div>
      ) : (
        <ChatInput
          onSend={handleSend}
          disabled={!connected}
          skills={skills}
          onFileDrop={handleFileDrop}
          theme={theme}
        />
      )}
    </div>
  );
});

export default ChatPane;
