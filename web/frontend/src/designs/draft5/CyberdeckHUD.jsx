import React, { useState } from 'react';
import {
  Send, Paperclip, Plus, PanelLeft, LogOut, Shield, Cpu, Zap,
  Bot, User, X, LayoutGrid, Square, Activity, Wifi, Database
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Constants & demo data
// ---------------------------------------------------------------------------

const CLIP_CORNER = 'polygon(0 0, calc(100% - 12px) 0, 100% 12px, 100% 100%, 12px 100%, 0 calc(100% - 12px))';
const CLIP_CORNER_SM = 'polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px))';
const CLIP_CORNER_LG = 'polygon(0 0, calc(100% - 16px) 0, 100% 16px, 100% 100%, 16px 100%, 0 calc(100% - 16px))';

const MODELS = ['Opus', 'Sonnet', 'Haiku'];

const SESSIONS = [
  {
    id: 'ND-7741',
    codename: 'PHANTOM GATE',
    status: 'active',
    throughput: 82,
    messages: [
      { role: 'user', text: 'Initialize the authentication module with RSA-4096 key rotation.', ts: '14:32:07' },
      { role: 'ai', text: 'Auth module initialized. Key rotation interval set to 3600s. Generating initial keypair...', ts: '14:32:09' },
      { role: 'ai', text: 'Keypair generated. RSA-4096 fingerprint: `a4:c1:9f:2b:e8:71:d3:06`. Module is hot.', ts: '14:32:11' },
      { role: 'user', text: 'Run integration tests against the staging endpoint.', ts: '14:33:42' },
      { role: 'ai', text: 'Executing 47 integration tests against `staging.internal:8443`...\n\nResults: 46 passed, 1 skipped (rate-limit mock unavailable). Coverage: 94.2%.', ts: '14:34:18' },
    ],
  },
  {
    id: 'ND-3092',
    codename: 'IRON LATTICE',
    status: 'idle',
    throughput: 34,
    messages: [
      { role: 'user', text: 'Analyze memory allocation patterns in the render pipeline.', ts: '13:18:55' },
      { role: 'ai', text: 'Profiling complete. Peak allocation: 248MB at frame 1,024. Detected 3 potential leak sites in the texture cache layer.', ts: '13:19:22' },
    ],
  },
  {
    id: 'ND-5518',
    codename: 'DELTA SPARK',
    status: 'error',
    throughput: 0,
    messages: [
      { role: 'user', text: 'Deploy canary build to edge nodes.', ts: '12:05:30' },
      { role: 'ai', text: 'Canary deployment failed on node eu-west-2. Error: health check timeout after 30s. Rolling back.', ts: '12:06:14' },
    ],
  },
];

const STATUS_COLOR = { active: 'var(--green)', idle: 'var(--yellow)', error: 'var(--red)' };

// ---------------------------------------------------------------------------
// CSS keyframe styles (injected once)
// ---------------------------------------------------------------------------

const STYLE_ID = 'cyberdeck-hud-styles';

const injectStyles = () => {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    @keyframes hud-scan {
      0%   { top: 0; opacity: 0; }
      10%  { opacity: 1; }
      90%  { opacity: 1; }
      100% { top: 100%; opacity: 0; }
    }
    @keyframes hud-rotate {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }
    @keyframes hud-pulse {
      0%, 100% { opacity: 0.4; }
      50%      { opacity: 1; }
    }
    @keyframes hud-blink {
      0%, 100% { opacity: 1; }
      50%      { opacity: 0.3; }
    }
    .hud-scan-line {
      position: absolute;
      left: 0; right: 0;
      height: 1px;
      background: linear-gradient(90deg, transparent, var(--accent), transparent);
      animation: hud-scan 8s linear infinite;
      pointer-events: none;
      z-index: 50;
    }
    .hud-rotate {
      animation: hud-rotate 12s linear infinite;
    }
    .hud-pulse {
      animation: hud-pulse 2s ease-in-out infinite;
    }
    .hud-blink {
      animation: hud-blink 1s step-end infinite;
    }
    .hud-grid-bg {
      background-image:
        linear-gradient(var(--border-color) 1px, transparent 1px),
        linear-gradient(90deg, var(--border-color) 1px, transparent 1px);
      background-size: 40px 40px;
    }
  `;
  document.head.appendChild(style);
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Small accent corner decorations for panels */
function CornerDeco({ size = 16, positions = ['tl', 'tr', 'bl', 'br'] }) {
  const lines = [];
  const s = size;
  const clr = 'var(--accent)';
  positions.forEach((p) => {
    const base = { position: 'absolute', background: clr };
    if (p === 'tl') {
      lines.push(
        <span key="tl-h" style={{ ...base, top: 0, left: 0, width: s, height: 1 }} />,
        <span key="tl-v" style={{ ...base, top: 0, left: 0, width: 1, height: s }} />
      );
    }
    if (p === 'tr') {
      lines.push(
        <span key="tr-h" style={{ ...base, top: 0, right: 0, width: s, height: 1 }} />,
        <span key="tr-v" style={{ ...base, top: 0, right: 0, width: 1, height: s }} />
      );
    }
    if (p === 'bl') {
      lines.push(
        <span key="bl-h" style={{ ...base, bottom: 0, left: 0, width: s, height: 1 }} />,
        <span key="bl-v" style={{ ...base, bottom: 0, left: 0, width: 1, height: s }} />
      );
    }
    if (p === 'br') {
      lines.push(
        <span key="br-h" style={{ ...base, bottom: 0, right: 0, width: s, height: 1 }} />,
        <span key="br-v" style={{ ...base, bottom: 0, right: 0, width: 1, height: s }} />
      );
    }
  });
  return <>{lines}</>;
}

/** Rotating arc SVG near logo */
function RotatingArc() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" className="hud-rotate" style={{ flexShrink: 0 }}>
      <circle cx="14" cy="14" r="12" fill="none" stroke="var(--accent)" strokeWidth="1" strokeDasharray="8 16" opacity="0.5" />
      <circle cx="14" cy="14" r="8" fill="none" stroke="var(--accent)" strokeWidth="1" strokeDasharray="4 12" opacity="0.3" />
      <circle cx="14" cy="14" r="2" fill="var(--accent)" opacity="0.7" />
    </svg>
  );
}

/** Status pip */
function StatusPip({ color, blink = false }) {
  return (
    <span
      className={blink ? 'hud-blink' : ''}
      style={{
        display: 'inline-block',
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: color,
        boxShadow: `0 0 6px ${color}`,
        flexShrink: 0,
      }}
    />
  );
}

/** Throughput bar */
function ThroughputBar({ value }) {
  return (
    <div style={{ height: 3, background: 'var(--bg)', borderRadius: 1, overflow: 'hidden', flex: 1 }}>
      <div
        style={{
          height: '100%',
          width: `${value}%`,
          background: value > 60 ? 'var(--green)' : value > 20 ? 'var(--yellow)' : 'var(--red)',
          transition: 'width 0.3s',
        }}
      />
    </div>
  );
}

/** Angular button */
function HudButton({ children, onClick, variant = 'default', className = '', style: extraStyle = {} }) {
  const base = {
    clipPath: CLIP_CORNER_SM,
    border: '1px solid',
    borderColor: variant === 'accent' ? 'var(--accent)' : 'var(--border-color)',
    background: variant === 'accent' ? 'color-mix(in srgb, var(--accent) 15%, transparent)' : 'var(--bg-surface)',
    color: variant === 'accent' ? 'var(--accent)' : 'var(--text-primary)',
    cursor: 'pointer',
    ...extraStyle,
  };
  return (
    <button onClick={onClick} className={`px-3 py-1.5 text-xs font-mono tracking-wide ${className}`} style={base}>
      {children}
    </button>
  );
}

/** Data tag */
function DataTag({ label, value, color = 'var(--text-secondary)' }) {
  return (
    <span className="text-[10px] font-mono tracking-wider" style={{ color }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}:</span> {value}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Panel (single chat pane)
// ---------------------------------------------------------------------------

function ChatPane({ session, onClose }) {
  const [input, setInput] = useState('');

  return (
    <div
      className="flex flex-col h-full relative"
      style={{
        clipPath: CLIP_CORNER,
        border: '1px solid var(--border-color)',
        background: 'var(--bg-surface)',
        overflow: 'hidden',
      }}
    >
      <CornerDeco size={14} />

      {/* Pane header */}
      <div
        className="flex items-center justify-between px-3 py-2 gap-2"
        style={{
          clipPath: 'polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 0 100%)',
          background: 'var(--bg-elevated)',
          borderBottom: '1px solid var(--border-color)',
        }}
      >
        <div className="flex items-center gap-2">
          <StatusPip color={STATUS_COLOR[session.status]} blink={session.status === 'error'} />
          <span className="text-xs font-mono font-bold tracking-widest" style={{ color: 'var(--accent)' }}>
            {session.codename}
          </span>
          <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
            [{session.id}]
          </span>
        </div>
        <div className="flex items-center gap-3">
          <DataTag label="TK/S" value={session.throughput > 0 ? session.throughput : '--'} />
          <button onClick={onClose} className="opacity-50 hover:opacity-100" style={{ color: 'var(--text-muted)', cursor: 'pointer', background: 'none', border: 'none' }}>
            <X size={12} />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3" style={{ scrollbarWidth: 'thin' }}>
        {session.messages.map((m, i) => (
          <div key={i} className="flex gap-2">
            <div
              style={{
                width: 2,
                flexShrink: 0,
                background: m.role === 'user' ? 'var(--accent)' : 'var(--border-color)',
                borderRadius: 1,
              }}
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                {m.role === 'user' ? (
                  <User size={10} style={{ color: 'var(--accent)' }} />
                ) : (
                  <Bot size={10} style={{ color: 'var(--cyan)' }} />
                )}
                <span className="text-[10px] font-mono font-bold tracking-wider" style={{ color: m.role === 'user' ? 'var(--accent)' : 'var(--cyan)' }}>
                  {m.role === 'user' ? 'OPERATOR' : 'CLAUDE'}
                </span>
                <span
                  className="text-[9px] font-mono px-1.5 py-0.5"
                  style={{
                    background: 'var(--bg)',
                    border: '1px solid var(--border-color)',
                    color: 'var(--text-muted)',
                    clipPath: CLIP_CORNER_SM,
                  }}
                >
                  {m.ts}
                </span>
              </div>
              <p className="text-xs leading-relaxed font-mono whitespace-pre-wrap" style={{ color: 'var(--text-primary)' }}>
                {m.text}
              </p>
            </div>
          </div>
        ))}
      </div>

      {/* Input */}
      <div className="p-2" style={{ borderTop: '1px solid var(--border-color)' }}>
        <div
          className="flex items-center gap-2 px-3 py-2"
          style={{
            clipPath: CLIP_CORNER_SM,
            border: '1px solid var(--border-color)',
            background: 'var(--bg)',
          }}
        >
          <Paperclip size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Enter command..."
            className="flex-1 bg-transparent text-xs font-mono outline-none"
            style={{ color: 'var(--text-primary)', border: 'none' }}
          />
          <button
            style={{
              background: 'var(--accent)',
              border: 'none',
              cursor: 'pointer',
              clipPath: CLIP_CORNER_SM,
              padding: '4px 8px',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <Send size={12} style={{ color: 'var(--bg)' }} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function CyberdeckHUD() {
  React.useEffect(() => { injectStyles(); }, []);

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [selectedModel, setSelectedModel] = useState('Opus');
  const [layout, setLayout] = useState(2); // 1, 2, or 4
  const [activeSessions, setActiveSessions] = useState([SESSIONS[0], SESSIONS[1]]);

  const visiblePanes = activeSessions.slice(0, layout);

  const gridClass =
    layout === 1 ? 'grid-cols-1 grid-rows-1' :
    layout === 2 ? 'grid-cols-2 grid-rows-1' :
    'grid-cols-2 grid-rows-2';

  return (
    <div
      className="h-screen w-screen flex flex-col overflow-hidden relative"
      style={{ background: 'var(--bg)', color: 'var(--text-primary)', fontFamily: "'JetBrains Mono', 'Fira Code', monospace" }}
    >
      {/* Scanning line */}
      <div className="hud-scan-line" />

      {/* ====== TOP BAR ====== */}
      <header
        className="flex items-center justify-between px-4 h-11 relative z-10 shrink-0"
        style={{
          background: 'var(--bg-elevated)',
          borderBottom: '1px solid var(--border-color)',
        }}
      >
        {/* Left: Logo + arc */}
        <div className="flex items-center gap-3">
          <RotatingArc />
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold tracking-[0.3em]" style={{ color: 'var(--accent)' }}>
                COCKPIT
              </span>
              <span
                className="text-[9px] font-mono px-1.5 py-0.5"
                style={{
                  border: '1px solid var(--accent)',
                  color: 'var(--accent)',
                  clipPath: CLIP_CORNER_SM,
                  opacity: 0.7,
                }}
              >
                v2.0
              </span>
            </div>
            <div style={{ height: 1, background: 'var(--accent)', opacity: 0.5, marginTop: 1 }} />
          </div>

          {/* Animated status indicators */}
          <div className="flex items-center gap-3 ml-4">
            <div className="flex items-center gap-1.5">
              <Shield size={10} className="hud-pulse" style={{ color: 'var(--green)' }} />
              <span className="text-[9px] font-mono" style={{ color: 'var(--green)' }}>SEC:OK</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Wifi size={10} style={{ color: 'var(--green)' }} />
              <span className="text-[9px] font-mono" style={{ color: 'var(--text-muted)' }}>NET:STABLE</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Database size={10} style={{ color: 'var(--cyan)' }} />
              <span className="text-[9px] font-mono" style={{ color: 'var(--text-muted)' }}>MEM:4.2G</span>
            </div>
          </div>
        </div>

        {/* Center: Model selector */}
        <div className="flex items-center gap-0" style={{ border: '1px solid var(--border-color)', clipPath: CLIP_CORNER_SM }}>
          {MODELS.map((m) => (
            <button
              key={m}
              onClick={() => setSelectedModel(m)}
              className="px-3 py-1 text-[10px] font-mono tracking-wider"
              style={{
                background: selectedModel === m ? 'color-mix(in srgb, var(--accent) 20%, transparent)' : 'transparent',
                color: selectedModel === m ? 'var(--accent)' : 'var(--text-muted)',
                border: 'none',
                borderRight: '1px solid var(--border-color)',
                cursor: 'pointer',
                fontWeight: selectedModel === m ? 700 : 400,
              }}
            >
              {m.toUpperCase()}
            </button>
          ))}
        </div>

        {/* Right: Plan badge, callsign, status */}
        <div className="flex items-center gap-4">
          {/* PLAN hexagonal-ish tag */}
          <span
            className="text-[9px] font-mono font-bold tracking-widest px-3 py-1"
            style={{
              clipPath: 'polygon(8px 0, calc(100% - 8px) 0, 100% 50%, calc(100% - 8px) 100%, 8px 100%, 0 50%)',
              background: 'color-mix(in srgb, var(--purple) 25%, transparent)',
              border: '1px solid var(--purple)',
              color: 'var(--purple)',
            }}
          >
            PLAN: MAX
          </span>

          {/* User callsign */}
          <div className="flex items-center gap-2">
            <div
              className="w-6 h-6 flex items-center justify-center"
              style={{
                clipPath: CLIP_CORNER_SM,
                background: 'color-mix(in srgb, var(--accent) 15%, transparent)',
                border: '1px solid var(--accent)',
              }}
            >
              <User size={12} style={{ color: 'var(--accent)' }} />
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] font-mono font-bold tracking-wider" style={{ color: 'var(--text-primary)' }}>
                OPERATOR-1
              </span>
              <span className="text-[8px] font-mono" style={{ color: 'var(--text-muted)' }}>CLEARANCE: ALPHA</span>
            </div>
          </div>

          {/* System online indicator */}
          <div className="flex items-center gap-1.5">
            <Activity size={12} className="hud-pulse" style={{ color: 'var(--green)' }} />
            <span className="text-[9px] font-mono" style={{ color: 'var(--green)' }}>ONLINE</span>
          </div>

          <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>
            <LogOut size={14} />
          </button>
        </div>
      </header>

      {/* ====== BODY (sidebar + main) ====== */}
      <div className="flex flex-1 overflow-hidden relative">

        {/* Sidebar */}
        {sidebarOpen && (
          <aside
            className="flex flex-col shrink-0 relative overflow-hidden"
            style={{
              width: 240,
              background: 'var(--bg-elevated)',
              borderRight: '1px solid var(--border-color)',
            }}
          >
            <CornerDeco size={20} positions={['tr', 'br']} />

            {/* Sidebar header */}
            <div className="px-3 py-2.5 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border-color)' }}>
              <div className="flex items-center gap-2">
                <Cpu size={11} style={{ color: 'var(--accent)' }} />
                <span className="text-[10px] font-mono font-bold tracking-[0.2em]" style={{ color: 'var(--accent)' }}>
                  ACTIVE NODES
                </span>
              </div>
              <span className="text-[9px] font-mono" style={{ color: 'var(--text-muted)' }}>
                {SESSIONS.length}/8
              </span>
            </div>

            {/* Session list */}
            <div className="flex-1 overflow-y-auto p-2 space-y-1.5" style={{ scrollbarWidth: 'thin' }}>
              {SESSIONS.map((s) => {
                const isActive = activeSessions.some((a) => a.id === s.id);
                return (
                  <button
                    key={s.id}
                    onClick={() => {
                      if (!isActive) {
                        setActiveSessions((prev) => [...prev, s]);
                      }
                    }}
                    className="w-full text-left p-2 relative"
                    style={{
                      clipPath: CLIP_CORNER_SM,
                      background: isActive ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : 'transparent',
                      border: isActive ? '1px solid var(--accent)' : '1px solid var(--border-color)',
                      cursor: 'pointer',
                      display: 'block',
                    }}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[10px] font-mono font-bold tracking-wider" style={{ color: isActive ? 'var(--accent)' : 'var(--text-primary)' }}>
                        {s.codename}
                      </span>
                      <StatusPip color={STATUS_COLOR[s.status]} blink={s.status === 'error'} />
                    </div>
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-[9px] font-mono" style={{ color: 'var(--text-muted)' }}>{s.id}</span>
                      <span className="text-[8px] font-mono uppercase" style={{ color: STATUS_COLOR[s.status] }}>{s.status}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[8px] font-mono" style={{ color: 'var(--text-muted)' }}>THRU</span>
                      <ThroughputBar value={s.throughput} />
                      <span className="text-[8px] font-mono" style={{ color: 'var(--text-muted)' }}>{s.throughput}%</span>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Deploy node button */}
            <div className="p-2" style={{ borderTop: '1px solid var(--border-color)' }}>
              <HudButton variant="accent" className="w-full flex items-center justify-center gap-1.5">
                <Plus size={11} />
                <span>DEPLOY NODE</span>
              </HudButton>
            </div>
          </aside>
        )}

        {/* Main area */}
        <main className="flex-1 flex flex-col overflow-hidden relative">
          {/* Grid background */}
          <div className="absolute inset-0 hud-grid-bg opacity-30 pointer-events-none" />

          {/* Toolbar */}
          <div className="flex items-center justify-between px-3 py-1.5 relative z-10 shrink-0" style={{ borderBottom: '1px solid var(--border-color)' }}>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setSidebarOpen(!sidebarOpen)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}
              >
                <PanelLeft size={14} />
              </button>
              <div style={{ width: 1, height: 14, background: 'var(--border-color)' }} />
              <span className="text-[9px] font-mono" style={{ color: 'var(--text-muted)' }}>
                WORKSPACE // {layout === 1 ? 'SINGLE' : layout === 2 ? 'DUAL' : 'QUAD'}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[9px] font-mono mr-2" style={{ color: 'var(--text-muted)' }}>LAYOUT:</span>
              {[
                { n: 1, icon: <Square size={12} />, label: '1x1' },
                { n: 2, icon: <LayoutGrid size={12} />, label: '1x2' },
                { n: 4, icon: <LayoutGrid size={12} />, label: '2x2' },
              ].map(({ n, icon, label }) => (
                <HudButton
                  key={n}
                  onClick={() => setLayout(n)}
                  variant={layout === n ? 'accent' : 'default'}
                  className="flex items-center gap-1"
                >
                  {icon}
                  <span>{label}</span>
                </HudButton>
              ))}
            </div>
          </div>

          {/* Panes grid */}
          <div className={`flex-1 grid ${gridClass} gap-2 p-2 overflow-hidden relative z-10`}>
            {visiblePanes.map((session) => (
              <ChatPane
                key={session.id}
                session={session}
                onClose={() => setActiveSessions((prev) => prev.filter((s) => s.id !== session.id))}
              />
            ))}
            {/* Empty slots */}
            {Array.from({ length: Math.max(0, layout - visiblePanes.length) }).map((_, i) => (
              <div
                key={`empty-${i}`}
                className="flex items-center justify-center relative"
                style={{
                  clipPath: CLIP_CORNER,
                  border: '1px dashed var(--border-color)',
                  background: 'color-mix(in srgb, var(--bg-surface) 50%, transparent)',
                }}
              >
                <CornerDeco size={14} positions={['tl', 'br']} />
                <div className="text-center">
                  <Zap size={20} style={{ color: 'var(--text-muted)', opacity: 0.3, margin: '0 auto 8px' }} />
                  <span className="text-[10px] font-mono block" style={{ color: 'var(--text-muted)', opacity: 0.5 }}>
                    NO NODE ASSIGNED
                  </span>
                  <span className="text-[8px] font-mono block mt-1" style={{ color: 'var(--text-muted)', opacity: 0.3 }}>
                    Select from sidebar to deploy
                  </span>
                </div>
              </div>
            ))}
          </div>
        </main>
      </div>

      {/* ====== STATUS BAR ====== */}
      <footer
        className="flex items-center justify-between px-4 h-7 shrink-0 relative z-10"
        style={{
          background: 'var(--bg-elevated)',
          borderTop: '1px solid var(--border-color)',
        }}
      >
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <StatusPip color="var(--green)" />
            <span className="text-[9px] font-mono tracking-wider" style={{ color: 'var(--text-muted)' }}>
              SYS: <span style={{ color: 'var(--green)' }}>ONLINE</span>
            </span>
          </div>
          <span className="text-[9px] font-mono" style={{ color: 'var(--border-color)' }}>|</span>
          <DataTag label="NODES" value="3" color="var(--text-secondary)" />
          <span className="text-[9px] font-mono" style={{ color: 'var(--border-color)' }}>|</span>
          <div className="flex items-center gap-1">
            <Zap size={9} style={{ color: 'var(--yellow)' }} />
            <DataTag label="THROUGHPUT" value="1,234 tk/s" color="var(--yellow)" />
          </div>
          <span className="text-[9px] font-mono" style={{ color: 'var(--border-color)' }}>|</span>
          <DataTag label="COST" value="$0.42" color="var(--cyan)" />
          <span className="text-[9px] font-mono" style={{ color: 'var(--border-color)' }}>|</span>
          <DataTag label="LATENCY" value="45ms" color="var(--green)" />
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[8px] font-mono tracking-widest" style={{ color: 'var(--text-muted)' }}>
            CLAUDE COCKPIT // CYBERDECK HUD // DRAFT 5
          </span>
          <div className="flex items-center gap-1">
            <span className="hud-blink" style={{ display: 'inline-block', width: 4, height: 4, background: 'var(--accent)', clipPath: 'polygon(50% 0, 100% 50%, 50% 100%, 0 50%)' }} />
            <span className="text-[8px] font-mono" style={{ color: 'var(--accent)' }}>REC</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
