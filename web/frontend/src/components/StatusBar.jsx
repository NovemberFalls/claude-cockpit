import { useState } from "react";
import { Square, Columns, Grid2x2, Wifi, WifiOff, Radio, Info, Pencil, CircleHelp, CircleCheck, CircleX, Loader, Cloud } from "lucide-react";

const layoutOptions = [
  { value: 1, icon: Square, label: "Single" },
  { value: 2, icon: Columns, label: "Split" },
  { value: 4, icon: Grid2x2, label: "Quad" },
];

const legendItems = [
  { icon: Pencil, color: "var(--accent)", label: "Working", desc: "Claude is writing or thinking" },
  { icon: CircleHelp, color: "var(--yellow)", label: "Waiting", desc: "Needs your approval (pane glows)" },
  { icon: CircleCheck, color: "var(--green)", label: "Idle", desc: "Ready for input" },
  { icon: CircleX, color: "var(--red)", label: "Error", desc: "Session has an error" },
  { icon: Loader, color: "var(--text-muted)", label: "Starting", desc: "Session is launching" },
];

export default function StatusBar({
  layout,
  setLayout,
  sessions,
  connected,
  totalTokens,
  totalCost,
  broadcastMode,
  setBroadcastMode,
  cloudConnected,
  isRelay = false,
}) {
  const runningCount = sessions.filter((s) => s.status === "running").length;
  const [showLegend, setShowLegend] = useState(false);

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
        {/* Connection / Mode indicator */}
        {isRelay ? (
          <span className="flex items-center gap-1" style={{ color: "var(--green)" }}>
            <Cloud size={10} />
            Cloud
          </span>
        ) : (
          <span className="flex items-center gap-1">
            {connected ? (
              <Wifi size={10} style={{ color: "var(--green)" }} />
            ) : (
              <WifiOff size={10} style={{ color: "var(--red)" }} />
            )}
            {connected ? "Connected" : "Disconnected"}
          </span>
        )}

        <span>{sessions.length} session{sessions.length !== 1 ? "s" : ""}</span>
        {runningCount > 0 && (
          <span style={{ color: "var(--green)" }}>{runningCount} running</span>
        )}
        <span>Tokens: {totalTokens.toLocaleString()}</span>
        <span>Cost: ${totalCost.toFixed(2)}</span>

        {/* Cloud indicator (local mode only, when connected) */}
        {!isRelay && cloudConnected && (
          <span className="flex items-center gap-1" style={{ color: "var(--green)" }}>
            <Cloud size={10} />
            Cloud
          </span>
        )}
      </div>

      <div className="flex items-center gap-2" style={{ position: "relative" }}>
        {/* Icon legend popup */}
        {showLegend && (
          <div
            style={{
              position: "absolute",
              bottom: "100%",
              right: 0,
              marginBottom: "8px",
              backgroundColor: "var(--bg-surface)",
              border: "1px solid var(--border-color)",
              borderRadius: "8px",
              padding: "12px 16px",
              boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
              minWidth: "240px",
              zIndex: 100,
            }}
          >
            <p className="text-xs font-semibold mb-2" style={{ color: "var(--text-primary)" }}>
              Status Icons
            </p>
            {legendItems.map(({ icon: Icon, color, label, desc }) => (
              <div key={label} className="flex items-center gap-2 py-1">
                <Icon size={12} style={{ color, flexShrink: 0 }} />
                <span className="text-xs font-medium" style={{ color: "var(--text-primary)", minWidth: "52px" }}>
                  {label}
                </span>
                <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                  {desc}
                </span>
              </div>
            ))}
            <div style={{ height: "1px", backgroundColor: "var(--border-color)", margin: "8px 0" }} />
            <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>
              Ctrl+1-4 focus panes &middot; Ctrl+Shift+Enter broadcast
            </p>
          </div>
        )}

        {/* Info button */}
        <button
          onClick={() => setShowLegend((p) => !p)}
          onBlur={() => setTimeout(() => setShowLegend(false), 150)}
          title="Status icon legend & shortcuts"
          className={`p-1 rounded transition-colors ${!showLegend ? "hover-color-secondary" : ""}`}
          style={{ color: showLegend ? "var(--accent)" : "var(--text-muted)" }}
        >
          <Info size={14} />
        </button>

        {/* Broadcast toggle */}
        <button
          onClick={() => setBroadcastMode?.(!broadcastMode)}
          title="Broadcast mode (Ctrl+Shift+Enter)"
          className={`p-1 rounded transition-colors ${!broadcastMode ? "hover-color-secondary" : ""}`}
          style={{
            color: broadcastMode ? "var(--yellow)" : "var(--text-muted)",
          }}
        >
          <Radio size={14} />
        </button>

        {/* Layout switcher */}
        <div className="flex items-center gap-1">
          {layoutOptions.map(({ value, icon: Icon, label }) => (
            <button
              key={value}
              onClick={() => setLayout(value)}
              title={`${label} (Ctrl+${value === 4 ? 4 : value})`}
              className={`p-1 rounded transition-colors ${layout !== value ? "hover-color-secondary" : ""}`}
              style={{
                color: layout === value ? "var(--accent)" : "var(--text-muted)",
              }}
            >
              <Icon size={14} />
            </button>
          ))}
        </div>
      </div>
    </footer>
  );
}
