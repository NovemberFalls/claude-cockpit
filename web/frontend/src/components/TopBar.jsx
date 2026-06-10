import { useState } from "react";
import { PanelLeft, ChevronDown } from "lucide-react";
import { useTheme } from "../hooks/useTheme";

const MODEL_GROUPS = [
  {
    label: "Claude 4.8",
    models: [
      { id: "claude-opus-4-8", label: "Opus 4.8" },
      { id: "claude-opus-4-8[1m]", label: "Opus 4.8 (1M)" },
    ],
  },
  {
    label: "Claude 4.7",
    models: [
      { id: "claude-opus-4-7", label: "Opus 4.7" },
      { id: "claude-opus-4-7[1m]", label: "Opus 4.7 (1M)" },
    ],
  },
  {
    label: "Claude 4.6",
    models: [
      { id: "sonnet", label: "Sonnet 4.6" },
      { id: "claude-sonnet-4-6[1m]", label: "Sonnet 4.6 (1M)" },
      { id: "opus", label: "Opus 4.6" },
      { id: "claude-opus-4-6[1m]", label: "Opus 4.6 (1M)" },
    ],
  },
  {
    label: "Claude 4.5",
    models: [
      { id: "haiku", label: "Haiku 4.5" },
    ],
  },
  {
    label: "Fable",
    models: [{ id: "claude-fable-5", label: "Fable 5" }],
  },
];
const MODELS = MODEL_GROUPS.flatMap((g) => g.models);

const PERMISSION_MODES = [
  { id: "default", label: "Ask" },
  { id: "plan", label: "Plan" },
  { id: "acceptEdits", label: "Accept Edits" },
  { id: "bypassPermissions", label: "Bypass" },
];

const EFFORT_OPTIONS = [
  { id: "", label: "Auto" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "XHigh" },
  { id: "max", label: "Max" },
];

/** Returns true when the given model id is an Opus model (fast toggle eligible). */
function isOpusModel(modelId) {
  return (
    modelId === "opus" ||
    modelId === "claude-opus-4-6[1m]" ||
    modelId === "claude-opus-4-7" ||
    modelId === "claude-opus-4-7[1m]" ||
    modelId === "claude-opus-4-8" ||
    modelId === "claude-opus-4-8[1m]"
  );
}

export default function TopBar({
  model,
  setModel,
  permissionMode,
  setPermissionMode,
  effort,
  setEffort,
  fast,
  setFast,
  sidebarOpen,
  setSidebarOpen,
  user,
}) {
  const [modelOpen, setModelOpen] = useState(false);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const { themeId, switchTheme, themes } = useTheme();
  const [themeOpen, setThemeOpen] = useState(false);

  const currentModel = MODELS.find((m) => m.id === model) || MODELS[0];
  const currentPermission = PERMISSION_MODES.find((p) => p.id === permissionMode) || PERMISSION_MODES[0];
  const currentEffort = EFFORT_OPTIONS.find((e) => e.id === effort) || EFFORT_OPTIONS[0];
  const fastEligible = isOpusModel(model);

  function closeAll() {
    setModelOpen(false);
    setPermissionOpen(false);
    setEffortOpen(false);
    setThemeOpen(false);
  }

  return (
    <header
      className="flex items-center justify-between px-5 h-12 flex-shrink-0 relative z-30"
      style={{ borderBottom: "1px solid var(--border-color)" }}
    >
      {/* Left */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="p-1.5 rounded-md transition-colors hover-bg-surface"
          style={{ color: "var(--text-secondary)" }}
          title="Toggle sidebar (Ctrl+B)"
          aria-label="Toggle sidebar"
        >
          <PanelLeft size={18} />
        </button>
        <img src="/app-icon.png" alt="Claude Cockpit" width={22} height={22} style={{ borderRadius: 4 }} />
        <span className="text-sm font-semibold tracking-tight" style={{ color: "var(--text-primary)" }}>
          Cockpit
        </span>
      </div>

      {/* Right */}
      <div className="flex items-center gap-2">
        {/* Theme picker (works in both modes) */}
        <div className="relative">
          <button
            onClick={() => { closeAll(); setThemeOpen((v) => !v); }}
            className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-full transition-colors hover-bg-surface"
            style={{
              color: "var(--text-muted)",
              border: "1px solid var(--border-color)",
            }}
            aria-label="Choose theme"
            aria-expanded={themeOpen}
            aria-haspopup="listbox"
          >
            <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: "var(--accent)" }} />
            <ChevronDown size={10} />
          </button>
          {themeOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setThemeOpen(false)} aria-hidden="true" />
              <div
                role="listbox"
                aria-label="Theme"
                className="absolute right-0 mt-1 rounded-lg py-1 z-50 max-h-72 overflow-y-auto min-w-[180px]"
                style={{
                  backgroundColor: "var(--bg-elevated)",
                  border: "1px solid var(--border-color)",
                  boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                }}
              >
                {themes.map((t) => (
                  <button
                    key={t.id}
                    role="option"
                    aria-selected={t.id === themeId}
                    onClick={() => { switchTheme(t.id); setThemeOpen(false); }}
                    className="block w-full text-left text-xs px-3 py-1.5 transition-colors hover-bg-surface"
                    style={{
                      color: t.id === themeId ? "var(--accent)" : "var(--text-secondary)",
                      fontWeight: t.id === themeId ? 600 : 400,
                    }}
                  >
                    {t.label} ({t.group})
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Model picker */}
        <div className="relative">
          <button
            onClick={() => { closeAll(); setModelOpen((v) => !v); }}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full transition-colors hover-bg-elevated"
            style={{
              color: "var(--text-secondary)",
              border: "1px solid var(--border-color)",
              backgroundColor: "var(--bg-surface)",
            }}
            aria-label={`Model: ${currentModel.label}`}
            aria-expanded={modelOpen}
            aria-haspopup="listbox"
          >
            {currentModel.label}
            <ChevronDown size={10} />
          </button>
          {modelOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setModelOpen(false)} aria-hidden="true" />
              <div
                role="listbox"
                aria-label="Model"
                className="absolute right-0 mt-1 rounded-lg py-1 z-50 min-w-[170px]"
                style={{
                  backgroundColor: "var(--bg-elevated)",
                  border: "1px solid var(--border-color)",
                  boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                }}
              >
                {MODEL_GROUPS.map((group, gi) => (
                  <div key={group.label}>
                    {gi > 0 && (
                      <div style={{ height: 1, backgroundColor: "var(--border-color)", margin: "2px 0" }} />
                    )}
                    <div
                      className="text-[10px] uppercase tracking-wider px-3 pt-1.5 pb-0.5"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {group.label}
                    </div>
                    {group.models.map((m) => (
                      <button
                        key={m.id}
                        role="option"
                        aria-selected={m.id === model}
                        onClick={() => { setModel(m.id); setModelOpen(false); }}
                        className="block w-full text-left text-xs px-3 py-1.5 transition-colors hover-bg-surface"
                        style={{
                          color: m.id === model ? "var(--accent)" : "var(--text-secondary)",
                          fontWeight: m.id === model ? 600 : 400,
                        }}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Permission mode picker */}
        <div className="relative">
          <button
            onClick={() => { closeAll(); setPermissionOpen((v) => !v); }}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full transition-colors hover-bg-elevated"
            style={{
              color: "var(--accent)",
              border: "1px solid var(--border-color)",
              backgroundColor: "var(--bg-surface)",
            }}
            aria-label={`Permission mode: ${currentPermission.label}`}
            aria-expanded={permissionOpen}
            aria-haspopup="listbox"
            title="Default permission mode for new sessions"
          >
            {currentPermission.label.toUpperCase()}
            <ChevronDown size={10} />
          </button>
          {permissionOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setPermissionOpen(false)} aria-hidden="true" />
              <div
                role="listbox"
                aria-label="Permission mode"
                className="absolute right-0 mt-1 rounded-lg py-1 z-50 min-w-[140px]"
                style={{
                  backgroundColor: "var(--bg-elevated)",
                  border: "1px solid var(--border-color)",
                  boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                }}
              >
                {PERMISSION_MODES.map((p) => (
                  <button
                    key={p.id}
                    role="option"
                    aria-selected={p.id === permissionMode}
                    onClick={() => { setPermissionMode(p.id); setPermissionOpen(false); }}
                    className="block w-full text-left text-xs px-3 py-1.5 transition-colors hover-bg-surface"
                    style={{
                      color: p.id === permissionMode ? "var(--accent)" : "var(--text-secondary)",
                      fontWeight: p.id === permissionMode ? 600 : 400,
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Effort picker */}
        <div className="relative">
          <button
            onClick={() => { closeAll(); setEffortOpen((v) => !v); }}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full transition-colors hover-bg-elevated"
            style={{
              color: "var(--text-secondary)",
              border: "1px solid var(--border-color)",
              backgroundColor: "var(--bg-surface)",
            }}
            aria-label={`Effort: ${currentEffort.label}`}
            aria-expanded={effortOpen}
            aria-haspopup="listbox"
            title="Default thinking effort for new sessions"
          >
            {currentEffort.label}
            <ChevronDown size={10} />
          </button>
          {effortOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setEffortOpen(false)} aria-hidden="true" />
              <div
                role="listbox"
                aria-label="Effort"
                className="absolute right-0 mt-1 rounded-lg py-1 z-50 min-w-[110px]"
                style={{
                  backgroundColor: "var(--bg-elevated)",
                  border: "1px solid var(--border-color)",
                  boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                }}
              >
                {EFFORT_OPTIONS.map((e) => (
                  <button
                    key={e.id}
                    role="option"
                    aria-selected={e.id === effort}
                    onClick={() => { setEffort(e.id); setEffortOpen(false); }}
                    className="block w-full text-left text-xs px-3 py-1.5 transition-colors hover-bg-surface"
                    style={{
                      color: e.id === effort ? "var(--accent)" : "var(--text-secondary)",
                      fontWeight: e.id === effort ? 600 : 400,
                    }}
                  >
                    {e.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Fast toggle — Opus models only */}
        <button
          onClick={() => { if (fastEligible) setFast((v) => !v); }}
          className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full transition-colors"
          style={{
            color: fastEligible && fast ? "var(--accent)" : "var(--text-muted)",
            backgroundColor: "var(--bg-surface)",
            border: `1px solid ${fastEligible && fast ? "var(--accent)" : "var(--border-color)"}`,
            opacity: fastEligible ? 1 : 0.4,
            cursor: fastEligible ? "pointer" : "not-allowed",
          }}
          aria-label={fastEligible ? (fast ? "Fast mode on" : "Fast mode off") : "Fast mode (Opus models only)"}
          aria-pressed={fastEligible && fast}
          disabled={!fastEligible}
          title={fastEligible ? "Toggle fast mode for new sessions" : "Fast mode is only available for Opus models"}
        >
          Fast
        </button>

        {/* Avatar */}
        {user?.picture ? (
          <img
            src={user.picture}
            alt=""
            className="w-7 h-7 rounded-full"
            style={{ border: "1px solid var(--border-color)" }}
          />
        ) : (
          <div
            className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium"
            style={{
              backgroundColor: "var(--bg-surface)",
              color: "var(--text-secondary)",
              border: "1px solid var(--border-color)",
            }}
          >
            {(user?.name || "?")[0].toUpperCase()}
          </div>
        )}

      </div>
    </header>
  );
}
