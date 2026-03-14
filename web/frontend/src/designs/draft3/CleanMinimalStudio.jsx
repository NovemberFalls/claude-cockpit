import React, { useState } from "react";
import {
  Send,
  Paperclip,
  Plus,
  PanelLeft,
  LogOut,
  Bot,
  User,
  MoreHorizontal,
  Square,
  Columns,
  Grid2x2,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Demo data
// ---------------------------------------------------------------------------

const SESSIONS = [
  {
    id: 1,
    name: "API refactor plan",
    status: "active",
    messages: [
      { role: "user", text: "Can you outline a plan to refactor the REST API to GraphQL?" },
      {
        role: "assistant",
        text: "Sure. I'd suggest a phased migration: first, add a GraphQL gateway that proxies existing REST endpoints. Then migrate resolvers one domain at a time — users, then projects, then billing. Each phase ships independently so nothing breaks.",
      },
      { role: "user", text: "What about authentication?" },
      {
        role: "assistant",
        text: "Keep auth at the gateway level. Your existing JWT middleware stays the same — just verify tokens before the request hits any resolver. You can reuse your current middleware almost verbatim.",
      },
    ],
  },
  {
    id: 2,
    name: "Database migration notes",
    status: "active",
    messages: [
      { role: "user", text: "Walk me through a zero-downtime Postgres migration." },
      {
        role: "assistant",
        text: "The key is expand-then-contract. Add the new column as nullable, backfill data in batches, update app code to write to both columns, then drop the old one once reads are migrated.",
      },
    ],
  },
  {
    id: 3,
    name: "Component library review",
    status: "idle",
    messages: [
      { role: "user", text: "Compare Radix UI and Headless UI for our design system." },
      {
        role: "assistant",
        text: "Radix gives you more primitives and better composition. Headless UI is simpler but narrower in scope. For a custom design system with specific interaction patterns, Radix is the stronger choice.",
      },
      { role: "user", text: "Does Radix play well with Tailwind?" },
      {
        role: "assistant",
        text: "Yes. Radix exposes data attributes for every state — open, closed, highlighted, checked — so you can style entirely with Tailwind using data-attribute selectors. No CSS-in-JS required.",
      },
    ],
  },
  {
    id: 4,
    name: "Deploy checklist",
    status: "done",
    messages: [
      { role: "user", text: "Generate a pre-deploy checklist for our production release." },
      {
        role: "assistant",
        text: "Here's a concise checklist:\n1. Run full test suite\n2. Check migration status\n3. Verify environment variables\n4. Tag the release\n5. Deploy to staging first\n6. Smoke test critical paths\n7. Deploy to production\n8. Monitor error rates for 30 minutes",
      },
    ],
  },
];

const MODELS = ["Opus 4", "Sonnet 4", "Haiku 4"];

const STATUS_COLORS = {
  active: "var(--green)",
  idle: "var(--text-muted)",
  done: "var(--text-muted)",
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusDot({ status }) {
  return (
    <span
      className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
      style={{ backgroundColor: STATUS_COLORS[status] || "var(--text-muted)" }}
    />
  );
}

function TopBar({ model, setModel, sidebarOpen, setSidebarOpen }) {
  const [modelOpen, setModelOpen] = useState(false);

  return (
    <header
      className="flex items-center justify-between px-5 h-12 flex-shrink-0"
      style={{ borderBottom: "1px solid var(--border-color)" }}
    >
      {/* Left cluster */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="p-1 rounded-md transition-colors"
          style={{ color: "var(--text-secondary)" }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--bg-surface)")}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
        >
          <PanelLeft size={18} />
        </button>

        <span
          className="text-sm font-semibold tracking-tight"
          style={{ color: "var(--text-primary)" }}
        >
          Cockpit
        </span>

        <span
          className="inline-block w-2 h-2 rounded-full"
          style={{ backgroundColor: "var(--accent)" }}
        />
      </div>

      {/* Right cluster */}
      <div className="flex items-center gap-3">
        {/* Model pill */}
        <div className="relative">
          <button
            onClick={() => setModelOpen(!modelOpen)}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full transition-colors"
            style={{
              color: "var(--text-secondary)",
              border: "1px solid var(--border-color)",
              backgroundColor: "var(--bg-surface)",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--bg-elevated)")}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "var(--bg-surface)")}
          >
            {model}
          </button>
          {modelOpen && (
            <div
              className="absolute right-0 mt-1 rounded-lg py-1 z-50 min-w-[120px]"
              style={{
                backgroundColor: "var(--bg-elevated)",
                border: "1px solid var(--border-color)",
                boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
              }}
            >
              {MODELS.map((m) => (
                <button
                  key={m}
                  onClick={() => { setModel(m); setModelOpen(false); }}
                  className="block w-full text-left text-xs px-3 py-1.5 transition-colors"
                  style={{
                    color: m === model ? "var(--accent)" : "var(--text-secondary)",
                    fontWeight: m === model ? 600 : 400,
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--bg-surface)")}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                >
                  {m}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Avatar */}
        <div
          className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium"
          style={{
            backgroundColor: "var(--bg-surface)",
            color: "var(--text-secondary)",
            border: "1px solid var(--border-color)",
          }}
        >
          L
        </div>

        {/* Logout */}
        <button
          className="p-1 rounded-md transition-colors"
          style={{ color: "var(--text-muted)" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--red)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
        >
          <LogOut size={15} />
        </button>
      </div>
    </header>
  );
}

function Sidebar({ sessions, activeIds, onToggle, open }) {
  if (!open) return null;

  const active = sessions.filter((s) => s.status === "active");
  const recent = sessions.filter((s) => s.status !== "active");

  const renderSession = (s) => {
    const isActive = activeIds.includes(s.id);
    return (
      <button
        key={s.id}
        onClick={() => onToggle(s.id)}
        className="flex items-center gap-2 w-full text-left px-3 py-1.5 rounded-md text-sm transition-colors"
        style={{
          color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
          fontWeight: isActive ? 600 : 400,
          backgroundColor: isActive ? "var(--bg-surface)" : "transparent",
        }}
        onMouseEnter={(e) => {
          if (!isActive) e.currentTarget.style.backgroundColor = "var(--bg-surface)";
        }}
        onMouseLeave={(e) => {
          if (!isActive) e.currentTarget.style.backgroundColor = "transparent";
        }}
      >
        <StatusDot status={s.status} />
        <span className="truncate">{s.name}</span>
      </button>
    );
  };

  return (
    <aside
      className="flex flex-col w-56 flex-shrink-0 py-4 px-2 overflow-y-auto"
      style={{ borderRight: "1px solid var(--border-color)" }}
    >
      {/* New button */}
      <button
        className="flex items-center gap-2 text-sm font-medium px-3 py-1.5 rounded-md mb-4 transition-colors"
        style={{ color: "var(--text-secondary)" }}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--bg-surface)")}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
      >
        <Plus size={15} />
        <span>New</span>
      </button>

      {/* Active section */}
      <p
        className="text-[10px] uppercase tracking-widest font-semibold px-3 mb-1"
        style={{ color: "var(--text-muted)" }}
      >
        Active
      </p>
      <div className="flex flex-col gap-0.5 mb-4">{active.map(renderSession)}</div>

      {/* Recent section */}
      <p
        className="text-[10px] uppercase tracking-widest font-semibold px-3 mb-1"
        style={{ color: "var(--text-muted)" }}
      >
        Recent
      </p>
      <div className="flex flex-col gap-0.5">{recent.map(renderSession)}</div>
    </aside>
  );
}

function MessageBubble({ msg }) {
  const isUser = msg.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-3`}>
      <div
        className="max-w-[80%] text-sm leading-relaxed rounded-lg px-4 py-2.5 whitespace-pre-wrap"
        style={
          isUser
            ? {
                backgroundColor: "var(--bg-surface)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-color)",
              }
            : {
                color: "var(--text-primary)",
              }
        }
      >
        {msg.text}
      </div>
    </div>
  );
}

function Pane({ session }) {
  const [input, setInput] = useState("");

  return (
    <div className="flex flex-col h-full min-w-0">
      {/* Pane header */}
      <div
        className="flex items-center justify-between px-4 h-10 flex-shrink-0"
        style={{ borderBottom: "1px solid var(--border-color)" }}
      >
        <span
          className="text-sm font-medium truncate"
          style={{ color: "var(--text-primary)" }}
        >
          {session.name}
        </span>
        <button
          className="p-0.5 rounded transition-colors"
          style={{ color: "var(--text-muted)" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-secondary)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
        >
          <MoreHorizontal size={15} />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {session.messages.map((msg, i) => (
          <MessageBubble key={i} msg={msg} />
        ))}
      </div>

      {/* Input area */}
      <div
        className="flex items-center gap-2 px-4 py-3 flex-shrink-0"
        style={{ borderTop: "1px solid var(--border-color)" }}
      >
        <button
          className="p-1 rounded transition-colors flex-shrink-0"
          style={{ color: "var(--text-muted)" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-secondary)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
        >
          <Paperclip size={15} />
        </button>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Send a message..."
          className="flex-1 text-sm bg-transparent outline-none placeholder-current"
          style={{
            color: "var(--text-primary)",
            "::placeholder": { color: "var(--text-muted)" },
          }}
        />
        <button
          className="p-1 rounded transition-colors flex-shrink-0"
          style={{ color: input ? "var(--accent)" : "var(--text-muted)" }}
          onMouseEnter={(e) => {
            if (input) e.currentTarget.style.opacity = "0.8";
          }}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
        >
          <Send size={15} />
        </button>
      </div>
    </div>
  );
}

function LayoutSwitcher({ layout, setLayout }) {
  const options = [
    { value: 1, icon: Square, label: "Single" },
    { value: 2, icon: Columns, label: "Split" },
    { value: 4, icon: Grid2x2, label: "Quad" },
  ];

  return (
    <div className="flex items-center gap-1">
      {options.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          onClick={() => setLayout(value)}
          title={label}
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
  );
}

function StatusBar({ layout, setLayout, paneCount }) {
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
        <span>{paneCount} pane{paneCount !== 1 ? "s" : ""}</span>
        <span>4 sessions</span>
        <span>Opus 4</span>
      </div>

      <LayoutSwitcher layout={layout} setLayout={setLayout} />
    </footer>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function CleanMinimalStudio() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [model, setModel] = useState("Opus 4");
  const [layout, setLayout] = useState(2);
  const [activeIds, setActiveIds] = useState([1, 2]);

  const toggleSession = (id) => {
    setActiveIds((prev) => {
      if (prev.includes(id)) {
        return prev.length > 1 ? prev.filter((x) => x !== id) : prev;
      }
      if (prev.length >= layout) {
        return [...prev.slice(1), id];
      }
      return [...prev, id];
    });
  };

  // Ensure activeIds length matches layout
  const visibleIds = activeIds.slice(0, layout);
  const visibleSessions = visibleIds
    .map((id) => SESSIONS.find((s) => s.id === id))
    .filter(Boolean);

  // Fill remaining panes if layout > visible
  while (visibleSessions.length < layout && visibleSessions.length < SESSIONS.length) {
    const next = SESSIONS.find((s) => !visibleSessions.includes(s));
    if (next) visibleSessions.push(next);
    else break;
  }

  const gridTemplate =
    layout === 1
      ? "1fr"
      : layout === 2
        ? "1fr 1fr"
        : "1fr 1fr";
  const gridRows = layout === 4 ? "1fr 1fr" : "1fr";

  return (
    <div
      className="flex flex-col h-screen w-screen overflow-hidden"
      style={{
        "--bg": "#0f0f10",
        "--accent": "#6366f1",
        "--text-primary": "#e4e4e7",
        "--text-secondary": "#a1a1aa",
        "--text-muted": "#52525b",
        "--border-color": "rgba(255,255,255,0.08)",
        "--bg-surface": "rgba(255,255,255,0.04)",
        "--bg-elevated": "rgba(255,255,255,0.07)",
        "--green": "#22c55e",
        "--red": "#ef4444",
        backgroundColor: "var(--bg)",
        color: "var(--text-primary)",
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
      }}
    >
      <TopBar
        model={model}
        setModel={setModel}
        sidebarOpen={sidebarOpen}
        setSidebarOpen={setSidebarOpen}
      />

      <div className="flex flex-1 min-h-0">
        <Sidebar
          sessions={SESSIONS}
          activeIds={visibleSessions.map((s) => s.id)}
          onToggle={toggleSession}
          open={sidebarOpen}
        />

        {/* Pane grid */}
        <main
          className="flex-1 min-w-0"
          style={{
            display: "grid",
            gridTemplateColumns: gridTemplate,
            gridTemplateRows: gridRows,
            gap: 0,
          }}
        >
          {visibleSessions.map((session, idx) => (
            <div
              key={session.id}
              style={{
                borderRight:
                  idx < visibleSessions.length - 1 &&
                  (layout === 2 || (layout === 4 && idx % 2 === 0))
                    ? "1px solid var(--border-color)"
                    : "none",
                borderBottom:
                  layout === 4 && idx < 2
                    ? "1px solid var(--border-color)"
                    : "none",
              }}
            >
              <Pane session={session} />
            </div>
          ))}
        </main>
      </div>

      <StatusBar
        layout={layout}
        setLayout={setLayout}
        paneCount={visibleSessions.length}
      />
    </div>
  );
}
