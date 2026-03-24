import { useState } from "react";
import { PanelLeft, ChevronDown } from "lucide-react";
import { useTheme } from "../hooks/useTheme";

const MODELS = [
  { id: "sonnet", label: "Sonnet 4.6" },
  { id: "opus", label: "Opus 4.6" },
  { id: "haiku", label: "Haiku 4.5" },
];

export default function TopBar({
  model,
  setModel,
  sidebarOpen,
  setSidebarOpen,
  user,
}) {
  const [modelOpen, setModelOpen] = useState(false);
  const { themeId, switchTheme, themes } = useTheme();
  const [themeOpen, setThemeOpen] = useState(false);
  const currentModel = MODELS.find((m) => m.id === model) || MODELS[0];

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
        >
          <PanelLeft size={18} />
        </button>
        <span className="text-sm font-semibold tracking-tight" style={{ color: "var(--text-primary)" }}>
          Cockpit
        </span>
        <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: "var(--accent)" }} />
      </div>

      {/* Right */}
      <div className="flex items-center gap-2">
        {/* Theme picker (works in both modes) */}
        <div className="relative">
          <button
            onClick={() => { setThemeOpen(!themeOpen); setModelOpen(false); }}
            className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-full transition-colors hover-bg-surface"
            style={{
              color: "var(--text-muted)",
              border: "1px solid var(--border-color)",
            }}
          >
            <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: "var(--accent)" }} />
            <ChevronDown size={10} />
          </button>
          {themeOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setThemeOpen(false)} />
              <div
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
              onClick={() => { setModelOpen(!modelOpen); setThemeOpen(false); }}
              className="flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full transition-colors hover-bg-elevated"
              style={{
                color: "var(--text-secondary)",
                border: "1px solid var(--border-color)",
                backgroundColor: "var(--bg-surface)",
              }}
            >
              {currentModel.label}
              <ChevronDown size={10} />
            </button>
            {modelOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setModelOpen(false)} />
                <div
                  className="absolute right-0 mt-1 rounded-lg py-1 z-50 min-w-[130px]"
                  style={{
                    backgroundColor: "var(--bg-elevated)",
                    border: "1px solid var(--border-color)",
                    boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                  }}
                >
                  {MODELS.map((m) => (
                    <button
                      key={m.id}
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
              </>
            )}
          </div>

        {/* Plan badge */}
        <span
            className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full"
            style={{
              color: "var(--accent)",
              backgroundColor: "var(--bg-surface)",
              border: "1px solid var(--border-color)",
            }}
          >
            Plan
          </span>

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
