import React, { useState } from 'react';
import {
  Send, Paperclip, Plus, PanelLeft, Terminal, LogOut,
  Cpu, Zap, Bot, User, X, LayoutGrid, Square, ChevronRight,
} from 'lucide-react';

/* ──────────────────────────────────────────────
   CSS Variables & Global Styles (injected once)
   ────────────────────────────────────────────── */
const cssVars = `
  :root {
    --bg:            #0a0a0f;
    --accent:        #00ffaa;
    --text-primary:  #e0e0e0;
    --text-secondary:#9090a0;
    --text-muted:    #505068;
    --border-color:  rgba(0, 255, 170, 0.3);
    --bg-surface:    #0f0f18;
    --bg-elevated:   #14141f;
    --green:         #00ff88;
    --red:           #ff3366;
    --purple:        #aa66ff;
    --cyan:          #00ccff;
  }

  @keyframes blink {
    0%, 49% { opacity: 1; }
    50%, 100% { opacity: 0; }
  }

  @keyframes scanline {
    0%   { transform: translateY(-100%); }
    100% { transform: translateY(100%); }
  }

  .neon-terminal * {
    scrollbar-width: thin;
    scrollbar-color: var(--accent) var(--bg-surface);
  }
  .neon-terminal *::-webkit-scrollbar { width: 4px; }
  .neon-terminal *::-webkit-scrollbar-track { background: var(--bg-surface); }
  .neon-terminal *::-webkit-scrollbar-thumb { background: var(--accent); border-radius: 1px; }
`;

/* ──────────────────────────────────────────────
   Demo Data
   ────────────────────────────────────────────── */
const DEMO_SESSIONS = [
  {
    id: 's1',
    name: 'deploy-pipeline',
    model: 'opus',
    status: 'active',
    messages: [
      { role: 'user',      text: '$ describe the current deployment pipeline' },
      { role: 'assistant',  text: 'The pipeline consists of 3 stages: build, test, deploy. Build compiles the Rust backend and bundles the SolidJS frontend. Tests run in parallel across 4 workers. Deploy pushes to the staging container first, then promotes to prod after health checks pass.' },
      { role: 'user',      text: '$ add a canary stage before prod promotion' },
      { role: 'assistant',  text: 'I\'ll add a canary deployment stage between staging and production.\n\nChanges:\n  stages/canary.yml  — new stage definition\n  pipeline.yml       — insert canary after staging\n  monitors/canary.rs — health check poller\n\nThe canary will receive 5% of traffic for 10 minutes. If error rate stays below 0.1%, auto-promote to full prod.' },
    ],
  },
  {
    id: 's2',
    name: 'refactor-auth',
    model: 'sonnet',
    status: 'idle',
    messages: [
      { role: 'user',      text: '$ review the OAuth token refresh logic' },
      { role: 'assistant',  text: 'Found a race condition in token_refresh.rs:48. Two concurrent requests can both detect an expired token and attempt refresh simultaneously. Recommend adding a mutex guard around the refresh block.' },
      { role: 'user',      text: '$ fix it with a tokio RwLock' },
      { role: 'assistant',  text: 'Done. Wrapped the refresh call in a tokio::sync::RwLock. The write lock is held only during the actual refresh HTTP call (~200ms). Read path remains uncontended for valid tokens.' },
    ],
  },
  {
    id: 's3',
    name: 'schema-migration',
    model: 'haiku',
    status: 'error',
    messages: [
      { role: 'user',      text: '$ generate migration for new user_preferences table' },
      { role: 'assistant',  text: 'ERR: Migration generation failed — column type `jsonb` is not supported on the current ScyllaDB driver. Consider using `text` with manual serialization, or switch this table to PostgreSQL.' },
    ],
  },
];

const MODEL_COLORS = {
  opus:   'var(--purple)',
  sonnet: 'var(--cyan)',
  haiku:  'var(--green)',
};

const STATUS_COLORS = {
  active: 'var(--green)',
  idle:   'var(--text-muted)',
  error:  'var(--red)',
};

/* ──────────────────────────────────────────────
   Utility Components
   ────────────────────────────────────────────── */
const Cursor = () => (
  <span
    className="inline-block w-2 h-4 ml-1 align-middle"
    style={{
      background: 'var(--accent)',
      animation: 'blink 1s step-end infinite',
    }}
  />
);

const NeonGlow = {
  box: '0 0 10px var(--accent), 0 0 30px color-mix(in srgb, var(--accent) 20%, transparent)',
  text: '0 0 8px var(--accent), 0 0 20px color-mix(in srgb, var(--accent) 15%, transparent)',
};

const ScanlineOverlay = () => (
  <div
    className="pointer-events-none absolute inset-0 z-50"
    style={{
      background:
        'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,255,170,0.015) 2px, rgba(0,255,170,0.015) 4px)',
      mixBlendMode: 'overlay',
    }}
  />
);

/* ──────────────────────────────────────────────
   Main Component
   ────────────────────────────────────────────── */
export default function NeonTerminal() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sessions] = useState(DEMO_SESSIONS);
  const [activeSessionIds, setActiveSessionIds] = useState(['s1']);
  const [layoutMode, setLayoutMode] = useState(1); // 1, 2, or 4 panes
  const [selectedModel, setSelectedModel] = useState('opus');
  const [inputValues, setInputValues] = useState({});

  // Determine which sessions fill the panes
  const paneSessions = (() => {
    const count = layoutMode;
    const ids = [...activeSessionIds];
    // Fill remaining pane slots with other sessions
    for (const s of sessions) {
      if (ids.length >= count) break;
      if (!ids.includes(s.id)) ids.push(s.id);
    }
    return ids.slice(0, count).map(id => sessions.find(s => s.id === id));
  })();

  const gridTemplate = {
    1: '1fr',
    2: '1fr 1fr',
    4: 'repeat(2, 1fr)',
  };

  const handleSessionClick = (id) => {
    setActiveSessionIds(prev => {
      if (prev.includes(id)) return prev;
      const next = [id, ...prev];
      return next.slice(0, layoutMode);
    });
  };

  return (
    <>
      <style>{cssVars}</style>
      <div
        className="neon-terminal relative flex flex-col h-screen w-screen overflow-hidden"
        style={{
          fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", "Consolas", monospace',
          background: 'var(--bg)',
          color: 'var(--text-primary)',
        }}
      >
        <ScanlineOverlay />

        {/* ═══ TOP BAR ═══ */}
        <header
          className="relative z-10 flex items-center justify-between px-4 h-10 shrink-0"
          style={{
            background: 'var(--bg-elevated)',
            borderBottom: '1px solid var(--border-color)',
          }}
        >
          {/* Left cluster */}
          <div className="flex items-center gap-4">
            <button
              onClick={() => setSidebarOpen(o => !o)}
              className="p-1 hover:opacity-80 transition-opacity"
              style={{ color: 'var(--accent)' }}
            >
              <PanelLeft size={16} />
            </button>

            <div className="flex items-center gap-1 text-sm font-bold tracking-wider" style={{ color: 'var(--accent)', textShadow: NeonGlow.text }}>
              <Terminal size={14} />
              <span>Claude // Cockpit</span>
              <Cursor />
            </div>
          </div>

          {/* Right cluster */}
          <div className="flex items-center gap-3 text-xs">
            {/* Theme picker placeholder */}
            <div className="flex items-center gap-1.5">
              {['#00ffaa', '#00ccff', '#aa66ff', '#ff3366'].map(c => (
                <button
                  key={c}
                  className="w-3 h-3 rounded-none border"
                  style={{
                    background: c,
                    borderColor: 'var(--border-color)',
                    borderRadius: '1px',
                    boxShadow: c === '#00ffaa' ? `0 0 6px ${c}` : 'none',
                  }}
                />
              ))}
            </div>

            {/* Model selector */}
            <select
              value={selectedModel}
              onChange={e => setSelectedModel(e.target.value)}
              className="text-xs px-2 py-0.5 outline-none cursor-pointer"
              style={{
                background: 'var(--bg-surface)',
                color: MODEL_COLORS[selectedModel],
                border: '1px solid var(--border-color)',
                borderRadius: '2px',
                fontFamily: 'inherit',
              }}
            >
              <option value="opus">OPUS</option>
              <option value="sonnet">SONNET</option>
              <option value="haiku">HAIKU</option>
            </select>

            {/* PLAN badge */}
            <span
              className="px-1.5 py-0.5 text-xs font-bold tracking-widest"
              style={{
                background: 'rgba(0,255,170,0.1)',
                border: '1px solid var(--border-color)',
                color: 'var(--accent)',
                borderRadius: '2px',
              }}
            >
              PLAN
            </span>

            {/* User */}
            <div className="flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}>
              <User size={12} />
              <span>len@cockpit</span>
            </div>

            <button className="p-1 hover:opacity-80" style={{ color: 'var(--red)' }}>
              <LogOut size={14} />
            </button>
          </div>
        </header>

        {/* ═══ BODY ═══ */}
        <div className="relative z-10 flex flex-1 min-h-0">

          {/* ─── SIDEBAR ─── */}
          {sidebarOpen && (
            <aside
              className="flex flex-col shrink-0 w-56"
              style={{
                background: 'var(--bg-surface)',
                borderRight: '1px solid var(--border-color)',
              }}
            >
              {/* New session */}
              <button
                className="flex items-center gap-2 m-2 px-3 py-1.5 text-xs font-bold tracking-wider transition-all hover:brightness-125"
                style={{
                  background: 'rgba(0,255,170,0.08)',
                  border: '1px solid var(--border-color)',
                  color: 'var(--accent)',
                  borderRadius: '2px',
                }}
              >
                <Plus size={12} />
                <span>$ new</span>
              </button>

              {/* ASCII divider */}
              <div className="px-2 text-xs select-none" style={{ color: 'var(--text-muted)' }}>
                ├──────────────────────┤
              </div>

              {/* Session list */}
              <div className="flex-1 overflow-y-auto py-1">
                {sessions.map(s => {
                  const isActive = activeSessionIds.includes(s.id);
                  return (
                    <button
                      key={s.id}
                      onClick={() => handleSessionClick(s.id)}
                      className="w-full text-left px-2 py-1.5 text-xs flex items-center gap-2 transition-all group"
                      style={{
                        background: isActive ? 'rgba(0,255,170,0.06)' : 'transparent',
                        borderLeft: isActive
                          ? '2px solid var(--accent)'
                          : '2px solid transparent',
                        boxShadow: isActive
                          ? 'inset 4px 0 12px rgba(0,255,170,0.05)'
                          : 'none',
                      }}
                    >
                      {/* Status block */}
                      <span
                        className="inline-block w-1.5 h-3 shrink-0"
                        style={{
                          background: STATUS_COLORS[s.status],
                          borderRadius: '1px',
                          boxShadow: s.status === 'active' ? `0 0 4px ${STATUS_COLORS[s.status]}` : 'none',
                        }}
                      />

                      <ChevronRight
                        size={10}
                        style={{ color: isActive ? 'var(--accent)' : 'var(--text-muted)' }}
                      />

                      <span
                        className="truncate"
                        style={{ color: isActive ? 'var(--accent)' : 'var(--text-secondary)' }}
                      >
                        {s.name}
                      </span>

                      <span
                        className="ml-auto text-[9px] font-bold tracking-wider px-1"
                        style={{
                          color: MODEL_COLORS[s.model],
                          background: 'rgba(0,0,0,0.3)',
                          borderRadius: '1px',
                        }}
                      >
                        {s.model.toUpperCase()}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* ASCII divider */}
              <div className="px-2 text-xs select-none" style={{ color: 'var(--text-muted)' }}>
                └──────────────────────┘
              </div>
            </aside>
          )}

          {/* ─── MAIN PANE AREA ─── */}
          <main className="flex-1 min-w-0 flex flex-col">
            {/* Layout controls — floating */}
            <div
              className="absolute top-2 right-3 z-20 flex gap-1"
            >
              {[1, 2, 4].map(n => (
                <button
                  key={n}
                  onClick={() => setLayoutMode(n)}
                  className="w-7 h-6 text-[10px] font-bold transition-all"
                  style={{
                    background: layoutMode === n ? 'rgba(0,255,170,0.15)' : 'var(--bg-elevated)',
                    border: '1px solid var(--border-color)',
                    color: layoutMode === n ? 'var(--accent)' : 'var(--text-muted)',
                    borderRadius: '2px',
                    boxShadow: layoutMode === n ? NeonGlow.box : 'none',
                    fontFamily: 'inherit',
                  }}
                >
                  [{n}]
                </button>
              ))}
            </div>

            {/* Pane grid */}
            <div
              className="flex-1 min-h-0"
              style={{
                display: 'grid',
                gridTemplateColumns: layoutMode === 4 ? 'repeat(2, 1fr)' : gridTemplate[layoutMode],
                gridTemplateRows: layoutMode === 4 ? 'repeat(2, 1fr)' : '1fr',
                gap: '1px',
                background: 'var(--border-color)',
              }}
            >
              {paneSessions.map((session, idx) => (
                <SessionPane
                  key={session?.id ?? idx}
                  session={session}
                  inputValue={inputValues[session?.id] ?? ''}
                  onInputChange={(val) =>
                    setInputValues(prev => ({ ...prev, [session?.id]: val }))
                  }
                />
              ))}
            </div>
          </main>
        </div>

        {/* ═══ STATUS BAR ═══ */}
        <footer
          className="relative z-10 flex items-center justify-between px-4 h-6 text-[10px] shrink-0"
          style={{
            background: 'var(--bg-elevated)',
            borderTop: '1px solid var(--border-color)',
            color: 'var(--text-muted)',
            fontFamily: 'inherit',
          }}
        >
          <div className="flex items-center gap-0">
            <span style={{ color: 'var(--green)' }}>●</span>
            <span className="ml-1">CONNECTED</span>
            <span className="mx-2">│</span>
            <Cpu size={10} className="mr-1" />
            <span>3 sessions</span>
            <span className="mx-2">│</span>
            <Zap size={10} className="mr-1" style={{ color: 'var(--accent)' }} />
            <span>1 active</span>
            <span className="mx-2">│</span>
            <span>tokens: 12,847 in / 8,234 out</span>
            <span className="mx-2">│</span>
            <span>latency: 142ms</span>
          </div>
          <div className="flex items-center gap-0">
            <span>api: v2.1.0</span>
            <span className="mx-2">│</span>
            <span>uptime: 02:47:13</span>
            <span className="mx-2">│</span>
            <span style={{ color: 'var(--accent)' }}>claude-cockpit v0.1.0</span>
          </div>
        </footer>
      </div>
    </>
  );
}

/* ──────────────────────────────────────────────
   Session Pane Component
   ────────────────────────────────────────────── */
function SessionPane({ session, inputValue, onInputChange }) {
  if (!session) {
    return (
      <div
        className="flex items-center justify-center"
        style={{ background: 'var(--bg)', color: 'var(--text-muted)' }}
      >
        <span className="text-xs">[ empty ]</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-0" style={{ background: 'var(--bg)' }}>
      {/* Pane top bar */}
      <div
        className="flex items-center justify-between px-3 h-7 shrink-0"
        style={{
          background: 'var(--bg-elevated)',
          borderBottom: '1px solid var(--border-color)',
        }}
      >
        <div className="flex items-center gap-2 text-xs">
          <Bot size={12} style={{ color: MODEL_COLORS[session.model] }} />
          <span style={{ color: 'var(--text-primary)' }}>
            [{session.name}]
          </span>
          <span
            className="text-[9px] font-bold tracking-wider px-1 py-px"
            style={{
              color: MODEL_COLORS[session.model],
              background: 'rgba(0,0,0,0.4)',
              border: `1px solid ${MODEL_COLORS[session.model]}33`,
              borderRadius: '2px',
            }}
          >
            {session.model.toUpperCase()}
          </span>
        </div>
        <button className="opacity-40 hover:opacity-100 transition-opacity" style={{ color: 'var(--text-muted)' }}>
          <X size={12} />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-2 min-h-0">
        {session.messages.map((msg, i) => (
          <div
            key={i}
            className="py-1.5 px-2 text-xs leading-relaxed"
            style={{
              background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)',
              borderRadius: '1px',
            }}
          >
            {/* Role prefix */}
            <span
              className="font-bold mr-2 select-none"
              style={{
                color: msg.role === 'user' ? 'var(--accent)' : 'var(--cyan)',
              }}
            >
              {msg.role === 'user' ? '>' : '<'}
            </span>

            {/* Message text */}
            <span style={{ color: msg.role === 'user' ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
              {msg.text.split('\n').map((line, li) => (
                <React.Fragment key={li}>
                  {li > 0 && <br />}
                  {li > 0 && <span className="inline-block w-4" />}
                  {line}
                </React.Fragment>
              ))}
            </span>
          </div>
        ))}
      </div>

      {/* ASCII divider */}
      <div
        className="px-3 text-[10px] select-none overflow-hidden whitespace-nowrap"
        style={{ color: 'var(--text-muted)', opacity: 0.4 }}
      >
        ─────────────────────────────────────────────────────────────
      </div>

      {/* Input */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 shrink-0"
        style={{
          background: 'var(--bg-surface)',
          borderTop: '1px solid var(--border-color)',
        }}
      >
        <span
          className="text-xs font-bold select-none shrink-0"
          style={{ color: 'var(--accent)', textShadow: NeonGlow.text }}
        >
          $
        </span>

        <input
          type="text"
          value={inputValue}
          onChange={e => onInputChange(e.target.value)}
          placeholder="enter command..."
          className="flex-1 bg-transparent outline-none text-xs placeholder:opacity-30"
          style={{
            color: 'var(--text-primary)',
            fontFamily: 'inherit',
            caretColor: 'var(--accent)',
          }}
        />

        <button
          className="p-1 opacity-40 hover:opacity-100 transition-opacity"
          style={{ color: 'var(--text-muted)' }}
        >
          <Paperclip size={12} />
        </button>

        <button
          className="p-1 transition-all hover:brightness-125"
          style={{
            color: 'var(--accent)',
            filter: 'drop-shadow(0 0 4px var(--accent))',
          }}
        >
          <Send size={12} />
        </button>
      </div>
    </div>
  );
}
