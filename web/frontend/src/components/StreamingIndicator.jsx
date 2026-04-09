/**
 * StreamingIndicator — shows when Claude is actively generating.
 */
export default function StreamingIndicator({ state }) {
  if (state !== "busy") return null;

  return (
    <div className="flex items-center gap-2 px-4 py-2">
      <div className="flex gap-1">
        <span className="streaming-dot" style={{ animationDelay: "0s" }} />
        <span className="streaming-dot" style={{ animationDelay: "0.15s" }} />
        <span className="streaming-dot" style={{ animationDelay: "0.3s" }} />
      </div>
      <span className="text-xs" style={{ color: "var(--text-muted)" }}>
        Claude is thinking...
      </span>
    </div>
  );
}
