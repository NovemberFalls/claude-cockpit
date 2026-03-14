import { Square, Columns, Grid2x2, Wifi, WifiOff } from "lucide-react";

const layoutOptions = [
  { value: 1, icon: Square, label: "Single" },
  { value: 2, icon: Columns, label: "Split" },
  { value: 4, icon: Grid2x2, label: "Quad" },
];

export default function StatusBar({
  layout,
  setLayout,
  sessions,
  connected,
  totalTokens,
  totalCost,
}) {
  const runningCount = sessions.filter((s) => s.status === "running").length;

  return (
    <footer
      className="flex items-center justify-between px-5 h-8 flex-shrink-0"
      style={{
        borderTop: "1px solid var(--border-color)",
        color: "var(--text-muted)",
        fontSize: "11px",
      }}
    >
      <div className="flex items-center gap-4">
        {/* Connection */}
        <span className="flex items-center gap-1">
          {connected ? (
            <Wifi size={10} style={{ color: "var(--green)" }} />
          ) : (
            <WifiOff size={10} style={{ color: "var(--red)" }} />
          )}
          {connected ? "Connected" : "Disconnected"}
        </span>

        <span>{sessions.length} session{sessions.length !== 1 ? "s" : ""}</span>
        {runningCount > 0 && (
          <span style={{ color: "var(--green)" }}>{runningCount} running</span>
        )}
        <span>Tokens: {totalTokens.toLocaleString()}</span>
        <span>Cost: ${totalCost.toFixed(2)}</span>
      </div>

      {/* Layout switcher */}
      <div className="flex items-center gap-1">
        {layoutOptions.map(({ value, icon: Icon, label }) => (
          <button
            key={value}
            onClick={() => setLayout(value)}
            title={`${label} (Ctrl+${value === 4 ? 4 : value})`}
            className="p-1 rounded transition-colors"
            style={{
              color: layout === value ? "var(--accent)" : "var(--text-muted)",
            }}
            onMouseEnter={(e) => {
              if (layout !== value) e.currentTarget.style.color = "var(--text-secondary)";
            }}
            onMouseLeave={(e) => {
              if (layout !== value) e.currentTarget.style.color = "var(--text-muted)";
            }}
          >
            <Icon size={14} />
          </button>
        ))}
      </div>
    </footer>
  );
}
