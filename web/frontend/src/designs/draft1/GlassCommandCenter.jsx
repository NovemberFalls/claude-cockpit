import React, { useState } from 'react';
import {
  Send, Paperclip, Plus, PanelLeft, Settings, LogOut,
  Cpu, Zap, Bot, User, X, Layout, Grid2x2, Square,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Demo data
// ---------------------------------------------------------------------------
const SESSIONS = [
  { id: 1, name: 'Order API Refactor',   model: 'Opus',   status: 'running' },
  { id: 2, name: 'Reporting Dashboard',   model: 'Sonnet', status: 'running' },
  { id: 3, name: 'Pipeline Debug',        model: 'Haiku',  status: 'idle'    },
];

const SAMPLE_MESSAGES = [
  { role: 'user',      text: 'Can you refactor the auth middleware to use the new token validation?', ts: '10:24 AM' },
  { role: 'assistant', text: 'Sure — I\'ll update the middleware to call `validate_token_v2()` and propagate the new claims struct through the request extensions. Here\'s my plan:\n\n1. Replace the old `decode_jwt` call\n2. Map the new claims to `AuthContext`\n3. Update the error variants for expired / malformed tokens\n\nLet me make those changes now.', ts: '10:24 AM' },
  { role: 'user',      text: 'Looks good. Also add a unit test for the expired-token path.', ts: '10:26 AM' },
  { role: 'assistant', text: 'Done. I\'ve added `test_expired_token_returns_401` in `auth_tests.rs`. It mints a token with `exp` set 60 s in the past and asserts the middleware responds with 401 and the correct error body.', ts: '10:27 AM' },
];

const MODELS = ['Sonnet', 'Opus', 'Haiku'];
const THEMES = ['Glass Dark', 'Midnight', 'Aurora', 'Ember'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const glass = {
  background: 'rgba(var(--bg-surface-rgb, 30,30,46), 0.55)',
  backdropFilter: 'blur(20px)',
  WebkitBackdropFilter: 'blur(20px)',
  border: '1px solid rgba(var(--accent-rgb, 139,92,246), 0.15)',
  boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
};

const glassElevated = {
  ...glass,
  background: 'rgba(var(--bg-elevated-rgb, 40,40,60), 0.6)',
};

const modelColor = (m) => {
  if (m === 'Opus')   return 'var(--purple, #a78bfa)';
  if (m === 'Haiku')  return 'var(--cyan, #22d3ee)';
  return 'var(--accent, #8b5cf6)';
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TopBar({ sidebarOpen, setSidebarOpen, selectedModel, setSelectedModel }) {
  const [themeOpen, setThemeOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);

  return (
    <header
      className="flex items-center justify-between px-4 h-12 shrink-0 relative z-30 select-none"
      style={{ ...glass, borderRadius: 0, borderTop: 'none', borderLeft: 'none', borderRight: 'none' }}
    >
      {/* Left cluster */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => setSidebarOpen((o) => !o)}
          className="p-1.5 rounded-lg transition-colors hover:bg-white/10"
          style={{ color: 'var(--text-secondary)' }}
        >
          <PanelLeft size={18} />
        </button>

        <div className="flex items-center gap-2">
          <div
            className="w-7 h-7 rounded-lg flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, var(--accent, #8b5cf6), var(--purple, #a78bfa))' }}
          >
            <Zap size={14} className="text-white" />
          </div>
          <span className="text-sm font-semibold tracking-wide" style={{ color: 'var(--text-primary)' }}>
            Claude Cockpit
          </span>
        </div>
      </div>

      {/* Center cluster */}
      <div className="flex items-center gap-3">
        {/* Theme picker */}
        <div className="relative">
          <button
            onClick={() => { setThemeOpen((o) => !o); setModelOpen(false); }}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors hover:bg-white/10"
            style={{ color: 'var(--text-secondary)', ...glassElevated, boxShadow: 'none' }}
          >
            <Settings size={13} /> Theme
          </button>
          {themeOpen && (
            <div
              className="absolute top-full mt-1 left-0 rounded-xl py-1 min-w-[140px] z-50"
              style={glassElevated}
            >
              {THEMES.map((t) => (
                <button
                  key={t}
                  className="block w-full text-left text-xs px-3 py-1.5 hover:bg-white/10 transition-colors"
                  style={{ color: 'var(--text-primary)' }}
                  onClick={() => setThemeOpen(false)}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Model selector */}
        <div className="relative">
          <button
            onClick={() => { setModelOpen((o) => !o); setThemeOpen(false); }}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors hover:bg-white/10"
            style={{ color: modelColor(selectedModel), ...glassElevated, boxShadow: 'none', borderColor: modelColor(selectedModel) + '33' }}
          >
            <Cpu size={13} /> {selectedModel}
          </button>
          {modelOpen && (
            <div
              className="absolute top-full mt-1 left-0 rounded-xl py-1 min-w-[120px] z-50"
              style={glassElevated}
            >
              {MODELS.map((m) => (
                <button
                  key={m}
                  className="block w-full text-left text-xs px-3 py-1.5 hover:bg-white/10 transition-colors"
                  style={{ color: modelColor(m) }}
                  onClick={() => { setSelectedModel(m); setModelOpen(false); }}
                >
                  {m}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Plan badge */}
        <span
          className="text-[10px] font-bold uppercase tracking-widest px-2.5 py-0.5 rounded-full"
          style={{
            background: 'linear-gradient(135deg, var(--accent-warm, #f59e0b) 0%, var(--accent, #8b5cf6) 100%)',
            color: '#fff',
          }}
        >
          Pro
        </span>
      </div>

      {/* Right cluster */}
      <div className="flex items-center gap-2">
        <div
          className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold"
          style={{ background: 'var(--accent, #8b5cf6)', color: '#fff' }}
        >
          L
        </div>
        <button
          className="p-1.5 rounded-lg transition-colors hover:bg-white/10"
          style={{ color: 'var(--text-muted)' }}
        >
          <LogOut size={16} />
        </button>
      </div>
    </header>
  );
}

function Sidebar({ open, sessions, activeId, setActiveId }) {
  if (!open) return null;
  return (
    <aside
      className="w-60 shrink-0 flex flex-col rounded-br-2xl overflow-hidden z-20"
      style={{ ...glass, borderTop: 'none', borderLeft: 'none', borderRadius: '0 0 16px 0' }}
    >
      <div className="px-3 pt-3 pb-2">
        <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>
          Sessions
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-2 space-y-0.5">
        {sessions.map((s) => {
          const active = s.id === activeId;
          return (
            <button
              key={s.id}
              onClick={() => setActiveId(s.id)}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left transition-all group"
              style={{
                background: active ? 'rgba(var(--accent-rgb, 139,92,246), 0.15)' : 'transparent',
                color: 'var(--text-primary)',
                boxShadow: active ? '0 0 20px rgba(var(--accent-rgb, 139,92,246), 0.08)' : 'none',
              }}
            >
              {/* Status dot */}
              <span className="relative flex h-2.5 w-2.5 shrink-0">
                {s.status === 'running' && (
                  <span
                    className="absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping"
                    style={{ background: 'var(--green, #4ade80)' }}
                  />
                )}
                <span
                  className="relative inline-flex rounded-full h-2.5 w-2.5"
                  style={{ background: s.status === 'running' ? 'var(--green, #4ade80)' : 'var(--text-muted, #64748b)' }}
                />
              </span>

              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium truncate">{s.name}</div>
                <div className="text-[10px] mt-0.5" style={{ color: modelColor(s.model) }}>
                  {s.model}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="p-2">
        <button
          className="w-full flex items-center justify-center gap-1.5 text-xs font-medium py-2 rounded-xl transition-colors hover:bg-white/10"
          style={{ color: 'var(--accent, #8b5cf6)', ...glassElevated, boxShadow: 'none' }}
        >
          <Plus size={14} /> New Session
        </button>
      </div>
    </aside>
  );
}

function ChatMessage({ msg }) {
  const isUser = msg.role === 'user';
  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>
      {/* Avatar */}
      <div
        className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center"
        style={{
          background: isUser
            ? 'var(--accent, #8b5cf6)'
            : 'linear-gradient(135deg, var(--purple, #a78bfa), var(--cyan, #22d3ee))',
        }}
      >
        {isUser ? <User size={14} className="text-white" /> : <Bot size={14} className="text-white" />}
      </div>

      {/* Bubble */}
      <div className={`max-w-[75%] ${isUser ? 'text-right' : ''}`}>
        <div
          className="text-sm leading-relaxed px-4 py-2.5 whitespace-pre-wrap"
          style={{
            ...glassElevated,
            borderRadius: isUser ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
            color: 'var(--text-primary)',
            boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
          }}
        >
          {msg.text}
        </div>
        <span className="text-[10px] mt-1 inline-block px-1" style={{ color: 'var(--text-muted)' }}>
          {msg.ts}
        </span>
      </div>
    </div>
  );
}

function Pane({ session }) {
  const [focused, setFocused] = useState(false);
  return (
    <div
      className="flex flex-col rounded-2xl overflow-hidden min-h-0"
      style={glass}
    >
      {/* Pane header */}
      <div
        className="flex items-center justify-between px-4 py-2.5 shrink-0"
        style={{
          background: 'linear-gradient(180deg, rgba(var(--bg-elevated-rgb,40,40,60),0.5) 0%, transparent 100%)',
          borderBottom: '1px solid rgba(var(--accent-rgb,139,92,246),0.1)',
        }}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            {session.name}
          </span>
          <span
            className="text-[10px] font-bold px-2 py-0.5 rounded-full"
            style={{ background: modelColor(session.model) + '22', color: modelColor(session.model) }}
          >
            {session.model}
          </span>
        </div>
        <button className="p-1 rounded-lg hover:bg-white/10 transition-colors" style={{ color: 'var(--text-muted)' }}>
          <X size={14} />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 min-h-0">
        {SAMPLE_MESSAGES.map((m, i) => (
          <ChatMessage key={i} msg={m} />
        ))}
      </div>

      {/* Input */}
      <div className="p-3 shrink-0" style={{ borderTop: '1px solid rgba(var(--accent-rgb,139,92,246),0.1)' }}>
        <div
          className="flex items-end gap-2 rounded-xl px-3 py-2 transition-shadow"
          style={{
            ...glassElevated,
            boxShadow: focused
              ? '0 0 0 2px rgba(var(--accent-rgb,139,92,246),0.4), 0 4px 20px rgba(var(--accent-rgb,139,92,246),0.1)'
              : '0 2px 8px rgba(0,0,0,0.15)',
          }}
        >
          <button className="p-1.5 rounded-lg hover:bg-white/10 transition-colors shrink-0" style={{ color: 'var(--text-muted)' }}>
            <Paperclip size={16} />
          </button>
          <textarea
            rows={1}
            placeholder="Send a message..."
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            className="flex-1 bg-transparent resize-none text-sm outline-none placeholder:opacity-40 py-1"
            style={{ color: 'var(--text-primary)' }}
          />
          <button
            className="p-2 rounded-xl shrink-0 transition-transform hover:scale-105 active:scale-95"
            style={{ background: 'var(--accent, #8b5cf6)', color: '#fff' }}
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

function LayoutControls({ layout, setLayout }) {
  const options = [
    { value: 1, icon: Square,  label: 'Single' },
    { value: 2, icon: Layout,  label: 'Split' },
    { value: 4, icon: Grid2x2, label: 'Quad' },
  ];
  return (
    <div
      className="absolute bottom-16 right-4 flex rounded-xl overflow-hidden z-30"
      style={glassElevated}
    >
      {options.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          onClick={() => setLayout(value)}
          title={label}
          className="p-2.5 transition-colors hover:bg-white/10"
          style={{
            color: layout === value ? 'var(--accent, #8b5cf6)' : 'var(--text-muted)',
            background: layout === value ? 'rgba(var(--accent-rgb,139,92,246),0.12)' : 'transparent',
          }}
        >
          <Icon size={16} />
        </button>
      ))}
    </div>
  );
}

function StatusBar() {
  return (
    <footer
      className="flex items-center justify-between px-4 h-8 text-[11px] shrink-0 select-none z-20"
      style={{ ...glass, borderRadius: 0, borderBottom: 'none', borderLeft: 'none', borderRight: 'none' }}
    >
      <div className="flex items-center gap-4" style={{ color: 'var(--text-muted)' }}>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block w-1.5 h-1.5 rounded-full"
            style={{ background: 'var(--green, #4ade80)' }}
          />
          Connected
        </span>
        <span>3 sessions</span>
      </div>
      <div className="flex items-center gap-4" style={{ color: 'var(--text-muted)' }}>
        <span>Tokens: <span style={{ color: 'var(--text-secondary)' }}>12,847</span></span>
        <span>Cost: <span style={{ color: 'var(--accent-warm, #f59e0b)' }}>$0.42</span></span>
      </div>
    </footer>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function GlassCommandCenter() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeSession, setActiveSession] = useState(1);
  const [layout, setLayout] = useState(2);
  const [selectedModel, setSelectedModel] = useState('Sonnet');

  const gridClass =
    layout === 1
      ? 'grid-cols-1 grid-rows-1'
      : layout === 2
        ? 'grid-cols-2 grid-rows-1'
        : 'grid-cols-2 grid-rows-2';

  // For multi-pane, cycle through sessions
  const paneCount = layout;
  const panes = Array.from({ length: paneCount }, (_, i) => SESSIONS[i % SESSIONS.length]);

  return (
    <div
      className="flex flex-col h-screen w-screen overflow-hidden"
      style={{ background: 'var(--bg, #0f0f1a)', color: 'var(--text-primary, #e2e8f0)' }}
    >
      <TopBar
        sidebarOpen={sidebarOpen}
        setSidebarOpen={setSidebarOpen}
        selectedModel={selectedModel}
        setSelectedModel={setSelectedModel}
      />

      <div className="flex flex-1 min-h-0 relative">
        <Sidebar open={sidebarOpen} sessions={SESSIONS} activeId={activeSession} setActiveId={setActiveSession} />

        {/* Main pane area */}
        <main className={`flex-1 grid ${gridClass} gap-3 p-3 min-h-0`}>
          {panes.map((s, i) => (
            <Pane key={`${s.id}-${i}`} session={s} />
          ))}
        </main>

        <LayoutControls layout={layout} setLayout={setLayout} />
      </div>

      <StatusBar />
    </div>
  );
}
