import { useState } from "react";
import { User, Bot, ChevronDown, ChevronRight, Info } from "lucide-react";
import ToolCallBlock from "./ToolCallBlock";

/**
 * MessageBubble — renders a single conversation message.
 *
 * Props:
 *   message  — parsed JSONL entry: { id, type, role, content[], timestamp, model }
 *   theme    — cockpit theme
 */
export default function MessageBubble({ message, theme }) {
  const isUser = message.role === "user";
  const isSystem = message.type === "system";
  const isToolResult = message.type === "tool_result";

  // System messages: compact bar
  if (isSystem) {
    return (
      <div className="flex justify-center py-1 px-4">
        <div
          className="flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px]"
          style={{
            backgroundColor: "var(--bg-elevated)",
            color: "var(--text-muted)",
            border: "1px solid var(--border-color)",
          }}
        >
          <Info size={10} />
          <span>{message.content?.[0]?.text || "System"}</span>
        </div>
      </div>
    );
  }

  // Tool results: render as collapsed blocks
  if (isToolResult) {
    return (
      <div className="px-4 py-0.5">
        {message.content?.map((block, i) => (
          <ToolCallBlock key={`${message.id}-${i}`} block={block} theme={theme} />
        ))}
      </div>
    );
  }

  // User and assistant messages
  return (
    <div
      className={`flex gap-2 px-4 py-2 ${isUser ? "flex-row-reverse" : ""}`}
    >
      {/* Avatar */}
      <div
        className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center mt-0.5"
        style={{
          backgroundColor: isUser
            ? "var(--accent)"
            : "var(--bg-elevated)",
          border: isUser ? "none" : "1px solid var(--border-color)",
        }}
      >
        {isUser ? (
          <User size={13} style={{ color: "var(--bg)" }} />
        ) : (
          <Bot size={13} style={{ color: "var(--accent)" }} />
        )}
      </div>

      {/* Content */}
      <div
        className={`flex flex-col min-w-0 ${isUser ? "items-end" : "items-start"}`}
        style={{ maxWidth: "85%" }}
      >
        {message.content?.map((block, i) => {
          if (block.type === "text") {
            return (
              <div
                key={`${message.id}-${i}`}
                className="rounded-lg px-3 py-2 text-sm leading-relaxed"
                style={{
                  backgroundColor: isUser
                    ? "var(--accent)"
                    : "var(--bg-elevated)",
                  color: isUser
                    ? "var(--bg)"
                    : "var(--text-primary)",
                  border: isUser ? "none" : "1px solid var(--border-color)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  fontFamily: "inherit",
                }}
              >
                {block.text}
              </div>
            );
          }

          if (block.type === "tool_use") {
            return (
              <div key={`${message.id}-${i}`} className="w-full">
                <ToolCallBlock block={block} theme={theme} />
              </div>
            );
          }

          if (block.type === "thinking") {
            return <ThinkingBlock key={`${message.id}-${i}`} text={block.text} />;
          }

          return null;
        })}

        {/* Timestamp */}
        {message.timestamp && (
          <span
            className="text-[9px] mt-0.5 px-1"
            style={{ color: "var(--text-muted)", opacity: 0.6 }}
          >
            {new Date(message.timestamp).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        )}
      </div>
    </div>
  );
}

function ThinkingBlock({ text }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <button
      onClick={() => setExpanded(!expanded)}
      className="flex items-start gap-1 text-left rounded px-2 py-1 my-0.5 transition-colors hover-bg-surface w-full"
      style={{
        backgroundColor: "var(--bg-elevated)",
        border: "1px solid var(--border-color)",
      }}
    >
      <span className="flex items-center gap-1 flex-shrink-0 mt-0.5">
        {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <span className="text-[10px] font-medium" style={{ color: "var(--text-muted)" }}>
          Thinking
        </span>
      </span>
      {expanded && (
        <pre
          className="text-[11px] whitespace-pre-wrap break-words mt-1"
          style={{
            color: "var(--text-muted)",
            fontFamily: "'JetBrains Mono', monospace",
            lineHeight: 1.4,
            maxHeight: 150,
            overflowY: "auto",
          }}
        >
          {text}
        </pre>
      )}
    </button>
  );
}
