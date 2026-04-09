import { useState, useMemo } from "react";
import { User, Bot, ChevronDown, ChevronRight, Info } from "lucide-react";
import { marked } from "marked";
import ToolCallBlock from "./ToolCallBlock";

// Configure marked for safe, minimal output
marked.setOptions({
  breaks: true,
  gfm: true,
});

/**
 * Strip Claude Code command XML tags from user messages.
 * <command-message>nadia</command-message>
 * <command-name>/nadia</command-name>
 * <command-args>actual text</command-args>
 * → returns just the content of <command-args>, or the original text if no tags found.
 * Also strips <system-reminder>...</system-reminder> blocks entirely.
 */
function cleanMessageText(text) {
  if (!text || typeof text !== "string") return text;
  // Strip block-level tags with content (may be truncated)
  let cleaned = text.replace(/<(?:system-reminder|local-command-caveat)[^>]*>[\s\S]*?(?:<\/(?:system-reminder|local-command-caveat)>|$)/g, "");
  // If command-args present, extract just its content
  const argsMatch = cleaned.match(/<command-args>([\s\S]*?)<\/command-args>/);
  if (argsMatch) return argsMatch[1].trim();
  // Strip any remaining XML-like tags from command protocol
  cleaned = cleaned.replace(/<\/?(?:command-message|command-name|command-args|scheduled-task)[^>]*>/g, "").trim();
  // Return null if the entire message was system tags — caller skips rendering
  return cleaned || null;
}

/**
 * Render markdown to sanitized HTML. Memoize to avoid re-parsing on every render.
 */
function useMarkdown(text) {
  return useMemo(() => {
    if (!text) return "";
    try {
      return marked.parse(text);
    } catch {
      return text;
    }
  }, [text]);
}

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

  // Tool results: handled by ToolCallGroup in ChatPane — skip standalone rendering
  if (isToolResult) {
    return null;
  }

  // User and assistant messages
  // Separate text/thinking blocks from tool_use blocks
  const textBlocks = message.content?.filter((b) => b.type === "text" || b.type === "thinking") || [];
  const toolBlocks = message.content?.filter((b) => b.type === "tool_use") || [];

  // For user messages, check if all text blocks are system tags that get stripped
  // If so, skip rendering the entire message (no empty avatar bubble)
  if (isUser && toolBlocks.length === 0) {
    const hasVisibleText = textBlocks.some((b) => {
      if (b.type !== "text") return true;
      return cleanMessageText(b.text) !== null;
    });
    if (!hasVisibleText) return null;
  }

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
        {textBlocks.map((block, i) => {
          if (block.type === "text") {
            if (isUser) {
              const displayText = cleanMessageText(block.text);
              if (!displayText) return null;
              return (
                <div
                  key={`${message.id}-text-${i}`}
                  className="rounded-lg px-3 py-2 text-sm leading-relaxed"
                  style={{
                    backgroundColor: "var(--accent)",
                    color: "var(--bg)",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    fontFamily: "inherit",
                  }}
                >
                  {displayText}
                </div>
              );
            }
            // Assistant: render markdown
            return (
              <MarkdownBlock key={`${message.id}-text-${i}`} text={block.text} />
            );
          }

          if (block.type === "thinking") {
            return <ThinkingBlock key={`${message.id}-think-${i}`} text={block.text} />;
          }

          return null;
        })}

        {/* Tool uses rendered as a collapsed group — only if there are any */}
        {toolBlocks.length > 0 && (
          <ToolCallGroup
            key={`${message.id}-tools`}
            blocks={toolBlocks}
            results={message._pairedResults || []}
            messageId={message.id}
            theme={theme}
          />
        )}

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

/**
 * MarkdownBlock — renders assistant text as rendered markdown.
 */
function MarkdownBlock({ text }) {
  const html = useMarkdown(text);

  return (
    <div
      className="markdown-content rounded-lg px-3 py-2 text-sm leading-relaxed w-full"
      style={{
        backgroundColor: "var(--bg-elevated)",
        color: "var(--text-primary)",
        border: "1px solid var(--border-color)",
        wordBreak: "break-word",
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/**
 * ToolCallGroup — renders tool_use blocks + paired tool_result blocks
 * as a single collapsible section. Collapsed by default.
 */
function ToolCallGroup({ blocks, results, messageId, theme }) {
  const [expanded, setExpanded] = useState(false);
  const count = blocks.length;

  // Build summary: tool names used
  const toolNames = [...new Set(blocks.map((b) => b.tool_name))];
  const summary = toolNames.join(", ");

  return (
    <div
      className="w-full rounded my-1"
      style={{
        backgroundColor: "var(--bg-elevated)",
        border: "1px solid var(--border-color)",
      }}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 w-full text-left px-2 py-1.5 rounded transition-colors hover-bg-surface"
        style={{ color: "var(--text-secondary)", fontSize: 12 }}
      >
        {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <span className="font-medium" style={{ color: "var(--text-primary)" }}>
          {count} tool {count === 1 ? "call" : "calls"}
        </span>
        {!expanded && (
          <span className="truncate ml-1" style={{ color: "var(--text-muted)", flex: 1 }}>
            {summary}
          </span>
        )}
      </button>
      {expanded && (
        <div
          className="px-2 pb-2"
          style={{ borderTop: "1px solid var(--border-color)", paddingTop: 4 }}
        >
          {blocks.map((block, i) => (
            <ToolCallBlock key={`${messageId}-tool-${i}`} block={block} theme={theme} />
          ))}
          {results.map((block, i) => (
            <ToolCallBlock key={`${messageId}-result-${i}`} block={block} theme={theme} />
          ))}
        </div>
      )}
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
