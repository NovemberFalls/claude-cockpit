import { useState } from "react";
import { Square, Columns, Grid2x2, Wifi, WifiOff, Radio, Info, Pencil, CircleHelp, CircleCheck, CircleX, Loader, Plus, Minus, Network, FolderTree } from "lucide-react";
import { version } from "../../package.json";

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
  broadcastMode,
  setBroadcastMode,
  orchestratorMode,
  setOrchestratorMode,
  hasOrchestrator,
  terminalZoom = 13,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  workspacePanelOpen,
  onToggleWorkspacePanel,
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
        {/* Connection indicator */}
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
        <span style={{ opacity: 0.5 }}>v{version}</span>
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
              minWidth: "300px",
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
              Ctrl+1-4 focus panes &middot; Ctrl+Shift+Enter broadcast &middot; Ctrl+=/- zoom
            </p>

            <div style={{ height: "1px", backgroundColor: "var(--border-color)", margin: "10px 0 8px" }} />
            <div className="flex items-center gap-1.5 mb-2">
              <Network size={11} style={{ color: "var(--accent)", flexShrink: 0 }} />
              <p className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
                Orchestrator Mode
              </p>
            </div>
            <ol style={{ paddingLeft: "14px", margin: 0 }}>
              {[
                ["Enable", <>Click the <Network size={10} style={{ display: "inline", verticalAlign: "middle" }} /> icon in the status bar to turn on Orchestrator Mode.</>],
                ["Create the Orchestrator", "Open a New Session and check \"Start as Orchestrator\". This session gets MCP tools injected automatically. Look for the ORCH badge."],
                ["Open worker sessions", "Create more sessions normally (no special options). Each shows a #id badge — that's its terminal address."],
                ["Give it a task in plain English", "In the orchestrator pane, describe what you want delegated. Claude uses its MCP tools automatically — you don't type commands."],
              ].map(([step, desc], i) => (
                <li key={i} className="text-[11px] mb-1.5" style={{ color: "var(--text-muted)", lineHeight: 1.4 }}>
                  <span className="font-semibold" style={{ color: "var(--text-primary)" }}>{step}: </span>
                  {desc}
                </li>
              ))}
            </ol>
            <div style={{ marginTop: "8px", padding: "6px 8px", borderRadius: "4px", backgroundColor: "var(--bg-elevated)", border: "1px solid var(--border-color)" }}>
              <p className="text-[10px] font-semibold mb-1" style={{ color: "var(--text-secondary)" }}>MCP tools available to the orchestrator:</p>
              {[
                ["create_session", "spawn a new worker (name, workdir, model)"],
                ["list_sessions", "see all running workers and their IDs"],
                ["send_input", "type into a worker's terminal"],
                ["get_output", "read a worker's terminal output"],
                ["get_state", "check if a worker is idle / busy / waiting"],
              ].map(([tool, desc]) => (
                <div key={tool} className="flex gap-1.5 text-[10px]" style={{ lineHeight: 1.5 }}>
                  <code style={{ color: "var(--accent)", flexShrink: 0 }}>{tool}</code>
                  <span style={{ color: "var(--text-muted)" }}>— {desc}</span>
                </div>
              ))}
            </div>
            <p className="text-[10px] mt-2" style={{ color: "var(--text-muted)", opacity: 0.7 }}>
              Example: "Create a worker in C:\Code\Personal and have it run the tests, then report back."
            </p>
            <p className="text-[10px] mt-0.5" style={{ color: "var(--text-muted)", opacity: 0.7 }}>
              Tip: use Quad layout so you can watch orchestrator + 3 workers at once.
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
          data-tour="broadcast-btn"
          onClick={() => setBroadcastMode?.(!broadcastMode)}
          title="Broadcast mode (Ctrl+Shift+Enter)"
          className={`p-1 rounded transition-colors ${!broadcastMode ? "hover-color-secondary" : ""}`}
          style={{
            color: broadcastMode ? "var(--yellow)" : "var(--text-muted)",
          }}
        >
          <Radio size={14} />
        </button>

        {/* Workspace panel toggle */}
        <button
          onClick={onToggleWorkspacePanel}
          title={workspacePanelOpen ? "Hide workspace panel" : "Show workspace panel"}
          className={`p-1 rounded transition-colors ${!workspacePanelOpen ? "hover-color-secondary" : ""}`}
          style={{ color: workspacePanelOpen ? "var(--accent)" : "var(--text-muted)" }}
        >
          <FolderTree size={14} />
        </button>

        {/* Orchestrator mode toggle */}
        <button
          data-tour="orchestrator-btn"
          onClick={() => setOrchestratorMode?.(!orchestratorMode)}
          title={orchestratorMode ? "Orchestrator mode active — click to disable" : "Enable Orchestrator mode"}
          className={`p-1 rounded transition-colors ${!orchestratorMode ? "hover-color-secondary" : ""}`}
          style={{ color: orchestratorMode ? "var(--accent)" : "var(--text-muted)", position: "relative" }}
        >
          <Network size={14} />
          {hasOrchestrator && (
            <span style={{
              position: "absolute", top: 1, right: 1,
              width: 5, height: 5, borderRadius: "50%",
              backgroundColor: "var(--green)",
            }} />
          )}
        </button>

        {/* Zoom controls */}
        <div className="flex items-center gap-0.5">
          <button
            onClick={onZoomOut}
            title="Zoom out (Ctrl+-)"
            className="p-1 rounded transition-colors hover-color-secondary"
            style={{ color: "var(--text-muted)" }}
          >
            <Minus size={12} />
          </button>
          <button
            onClick={onZoomReset}
            title="Reset zoom (Ctrl+0)"
            className="px-1 rounded transition-colors hover-color-secondary"
            style={{
              color: terminalZoom !== 13 ? "var(--accent)" : "var(--text-muted)",
              fontSize: "10px",
              fontWeight: 600,
              minWidth: "28px",
              textAlign: "center",
            }}
          >
            {terminalZoom}px
          </button>
          <button
            onClick={onZoomIn}
            title="Zoom in (Ctrl+=)"
            className="p-1 rounded transition-colors hover-color-secondary"
            style={{ color: "var(--text-muted)" }}
          >
            <Plus size={12} />
          </button>
        </div>

        <span style={{ width: 1, height: 14, backgroundColor: "var(--border-color)", opacity: 0.5 }} />

        {/* Layout switcher */}
        <div data-tour="layout-switcher" className="flex items-center gap-1">
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
