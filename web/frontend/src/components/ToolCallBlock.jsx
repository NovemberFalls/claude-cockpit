import { useState } from "react";
import { ChevronRight, ChevronDown, FileText, Terminal, Edit3, Search, Globe, Wrench } from "lucide-react";

const TOOL_ICONS = {
  Read: FileText,
  Bash: Terminal,
  Edit: Edit3,
  Write: Edit3,
  Grep: Search,
  Glob: Search,
  WebFetch: Globe,
  WebSearch: Globe,
};

/**
 * ToolCallBlock — renders a collapsible tool use or tool result.
 *
 * Props:
 *   block    — { type: 'tool_use'|'tool_result', tool_name, tool_id, input, content, is_error }
 *   theme    — cockpit theme
 */
export default function ToolCallBlock({ block, theme }) {
  const [expanded, setExpanded] = useState(false);
  const isResult = block.type === "tool_result";
  const Icon = TOOL_ICONS[block.tool_name] || Wrench;

  // Format tool input for display
  const formatInput = (input) => {
    if (!input) return "";
    if (typeof input === "string") return input;
    // Show key fields compactly
    const parts = [];
    for (const [key, val] of Object.entries(input)) {
      if (typeof val === "string" && val.length > 100) {
        parts.push(`${key}: "${val.slice(0, 80)}..."`);
      } else if (typeof val === "string") {
        parts.push(`${key}: "${val}"`);
      } else {
        parts.push(`${key}: ${JSON.stringify(val)}`);
      }
    }
    return parts.join("\n");
  };

  const label = isResult
    ? `Result${block.is_error ? " (error)" : ""}`
    : block.tool_name || "Tool";

  const summary = isResult
    ? (block.content || "").slice(0, 80)
    : formatInput(block.input).split("\n")[0]?.slice(0, 80) || "";

  return (
    <div
      className="rounded my-1"
      style={{
        backgroundColor: "var(--bg-elevated)",
        border: `1px solid ${block.is_error ? "var(--red)" : "var(--border-color)"}`,
        fontSize: 12,
      }}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 w-full text-left px-2 py-1 rounded transition-colors hover-bg-surface"
        style={{ color: "var(--text-secondary)" }}
      >
        {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        {!isResult && <Icon size={11} style={{ color: "var(--accent)", flexShrink: 0 }} />}
        <span className="font-medium" style={{ color: block.is_error ? "var(--red)" : "var(--text-primary)" }}>
          {label}
        </span>
        {!expanded && summary && (
          <span className="truncate ml-1" style={{ color: "var(--text-muted)", flex: 1 }}>
            {summary}
          </span>
        )}
      </button>
      {expanded && (
        <div
          className="px-2 pb-2"
          style={{
            borderTop: "1px solid var(--border-color)",
            marginTop: 2,
            paddingTop: 6,
          }}
        >
          <pre
            className="whitespace-pre-wrap break-all"
            style={{
              color: "var(--text-secondary)",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              lineHeight: 1.5,
              maxHeight: 200,
              overflowY: "auto",
            }}
          >
            {isResult ? (block.content || "(empty)") : formatInput(block.input)}
          </pre>
        </div>
      )}
    </div>
  );
}
