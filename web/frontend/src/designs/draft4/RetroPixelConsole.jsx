import { useState } from 'react';
import {
  Send,
  Paperclip,
  Plus,
  PanelLeft,
  LogOut,
  Gamepad2,
  Sword,
  Bot,
  User,
  X,
  LayoutGrid,
  Square,
} from 'lucide-react';

/* ── Google Font ── */
const fontImport = document.createElement('style');
fontImport.textContent = `@import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap');`;
if (!document.head.querySelector('[data-retro-font]')) {
  fontImport.setAttribute('data-retro-font', '');
  document.head.appendChild(fontImport);
}

/* ── Pixel helpers ── */
const px = {
  font: "'Press Start 2P', monospace",
  border: '2px solid var(--border-color)',
  borderThick: '3px solid var(--border-color)',
  shadow: '2px 2px 0 rgba(0,0,0,0.5)',
  shadowInset: 'inset 1px 1px 0 rgba(255,255,255,0.15)',
  radius: '0px',
  scanlines:
    'repeating-linear-gradient(0deg, rgba(0,0,0,0.1) 0px, rgba(0,0,0,0.1) 1px, transparent 1px, transparent 3px)',
};

const btnStyle = (active = false) => ({
  fontFamily: px.font,
  fontSize: '9px',
  padding: '6px 10px',
  border: '2px outset var(--border-color)',
  borderRadius: px.radius,
  background: active ? 'var(--accent)' : 'var(--bg-elevated)',
  color: active ? 'var(--bg)' : 'var(--text-primary)',
  cursor: 'pointer',
  boxShadow: px.shadow,
  textTransform: 'uppercase',
  letterSpacing: '1px',
  whiteSpace: 'nowrap',
});

/* ── Demo data ── */
const SESSIONS = [
  {
    id: 1,
    name: 'DRAGON_SLAYER_API',
    model: 'OPUS',
    status: 'active',
    tokens: 1234,
    messages: [
      { role: 'user', text: 'Create a REST endpoint that breathes fire.', ts: '14:23' },
      { role: 'ai', text: 'You enter the /api/dragons route.\nA wild endpoint appears!\n\nI have forged the following:\n> POST /api/dragons/breathe\n> Returns: { flame: true, damage: 9001 }\n\nThe dragon is pleased.', ts: '14:24' },
      { role: 'user', text: 'Add authentication so only knights can access it.', ts: '14:25' },
      { role: 'ai', text: 'A guard blocks the path.\n\n"Halt! Show me your JWT token, brave knight."\n\nMiddleware added:\n> verifyKnight(req, res, next)\n> Checks for Bearer token in Authorization header\n> Returns 403: "You shall not pass" on failure', ts: '14:26' },
    ],
  },
  {
    id: 2,
    name: 'DUNGEON_DEBUGGER',
    model: 'SONNET',
    status: 'idle',
    tokens: 567,
    messages: [
      { role: 'user', text: 'There is a null pointer lurking in the shadows of line 42.', ts: '09:11' },
      { role: 'ai', text: 'I cast DETECT BUG...\n\n*rolls d20* ... Natural 20!\n\nFound it! The variable `treasure` was never initialized.\nIt wanders the heap as an undefined ghost.\n\nFix: `let treasure = [];` on line 40.', ts: '09:12' },
    ],
  },
  {
    id: 3,
    name: 'POTION_CRAFTER',
    model: 'HAIKU',
    status: 'error',
    tokens: 89,
    messages: [
      { role: 'user', text: 'Mix a CSS potion for responsive grid layout.', ts: '16:00' },
      { role: 'ai', text: 'Brewing...\n\nIngredients:\n- 2 cups of display: grid\n- A pinch of grid-template-columns: repeat(auto-fit, minmax(300px, 1fr))\n- Garnish with gap: 1rem\n\n*POOF*\n\nYour layout is now responsive. +5 to mobile friendliness.', ts: '16:01' },
    ],
  },
];

const STATUS_COLORS = { active: 'var(--green)', idle: 'var(--yellow)', error: 'var(--red)' };
const MODELS = ['SONNET', 'OPUS', 'HAIKU'];
const LAYOUTS = [
  { key: '1', icon: <Square size={12} />, label: '1', count: 1 },
  { key: '2', icon: null, label: '||', count: 2 },
  { key: '4', icon: <LayoutGrid size={12} />, label: '+', count: 4 },
];

/* ── Blinking cursor keyframes ── */
const cursorKeyframes = `
@keyframes blink-cursor {
  0%, 49% { opacity: 1; }
  50%, 100% { opacity: 0; }
}
`;

/* ────────────────────────────────────────── */
/*  COMPONENT                                 */
/* ────────────────────────────────────────── */
export default function RetroPixelConsole() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeModel, setActiveModel] = useState('OPUS');
  const [layout, setLayout] = useState(2);
  const [activePanes, setActivePanes] = useState([SESSIONS[0], SESSIONS[1]]);
  const [inputs, setInputs] = useState({});

  const visiblePanes = activePanes.slice(0, layout);

  const gridTemplate =
    layout === 1
      ? '1fr'
      : layout === 2
        ? '1fr 1fr'
        : '1fr 1fr';
  const gridRows = layout === 4 ? '1fr 1fr' : '1fr';

  return (
    <div
      style={{
        fontFamily: px.font,
        fontSize: '10px',
        color: 'var(--text-primary)',
        background: 'var(--bg)',
        height: '100vh',
        width: '100vw',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        imageRendering: 'pixelated',
        position: 'relative',
      }}
    >
      <style>{cursorKeyframes}</style>

      {/* ── Scanline Overlay ── */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: px.scanlines,
          pointerEvents: 'none',
          zIndex: 9999,
        }}
      />

      {/* ══════════ TOP BAR ══════════ */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          padding: '8px 12px',
          background: 'var(--bg-surface)',
          borderBottom: px.borderThick,
          boxShadow: '0 2px 0 rgba(0,0,0,0.3)',
          zIndex: 10,
          flexShrink: 0,
        }}
      >
        {/* Sidebar toggle */}
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          style={{ ...btnStyle(), padding: '6px 8px' }}
          title="Toggle sidebar"
        >
          <PanelLeft size={14} />
        </button>

        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Gamepad2 size={18} style={{ color: 'var(--accent)' }} />
          <span
            style={{
              fontSize: '12px',
              fontWeight: 'bold',
              letterSpacing: '2px',
              color: 'var(--accent)',
              textShadow: '2px 2px 0 rgba(0,0,0,0.5)',
            }}
          >
            CLAUDE COCKPIT
          </span>
        </div>

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Model selector */}
        <div style={{ display: 'flex', gap: '4px' }}>
          {MODELS.map((m) => (
            <button key={m} onClick={() => setActiveModel(m)} style={btnStyle(activeModel === m)}>
              [{m}]
            </button>
          ))}
        </div>

        {/* Layout controls */}
        <div
          style={{
            display: 'flex',
            gap: '4px',
            marginLeft: '8px',
            borderLeft: px.border,
            paddingLeft: '12px',
          }}
        >
          {LAYOUTS.map((l) => (
            <button
              key={l.key}
              onClick={() => setLayout(l.count)}
              style={{
                ...btnStyle(layout === l.count),
                padding: '6px 10px',
                minWidth: '32px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              [{l.label}]
            </button>
          ))}
        </div>

        {/* User / Logout */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            marginLeft: '8px',
            borderLeft: px.border,
            paddingLeft: '12px',
          }}
        >
          <User size={14} style={{ color: 'var(--text-secondary)' }} />
          <span style={{ fontSize: '9px', color: 'var(--text-secondary)' }}>PLAYER_1</span>
          <button style={{ ...btnStyle(), padding: '5px 8px' }} title="Logout">
            <LogOut size={12} />
          </button>
        </div>
      </header>

      {/* ══════════ BODY ══════════ */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* ── Sidebar ── */}
        {sidebarOpen && (
          <aside
            style={{
              width: '220px',
              flexShrink: 0,
              background: 'var(--bg-surface)',
              borderRight: px.borderThick,
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '2px 0 0 rgba(0,0,0,0.2)',
            }}
          >
            <div
              style={{
                padding: '8px',
                borderBottom: px.border,
                fontSize: '9px',
                color: 'var(--text-muted)',
                letterSpacing: '2px',
              }}
            >
              <Sword size={10} style={{ marginRight: '6px', verticalAlign: 'middle' }} />
              SESSIONS
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '4px' }}>
              {SESSIONS.map((s) => {
                const isActive = activePanes.some((p) => p.id === s.id);
                return (
                  <button
                    key={s.id}
                    onClick={() => {
                      if (!isActive && activePanes.length < layout) {
                        setActivePanes([...activePanes, s]);
                      } else if (!isActive) {
                        setActivePanes([...activePanes.slice(0, -1), s]);
                      }
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      width: '100%',
                      padding: '8px 6px',
                      marginBottom: '2px',
                      border: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                      borderRadius: px.radius,
                      background: isActive ? 'var(--bg-elevated)' : 'transparent',
                      color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                      cursor: 'pointer',
                      fontFamily: px.font,
                      fontSize: '8px',
                      textAlign: 'left',
                      boxShadow: isActive ? px.shadow : 'none',
                    }}
                  >
                    {/* Status block */}
                    <span
                      style={{
                        display: 'inline-block',
                        width: '8px',
                        height: '8px',
                        background: STATUS_COLORS[s.status],
                        border: '1px solid rgba(0,0,0,0.3)',
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ color: 'var(--accent)', flexShrink: 0 }}>&gt;&gt;</span>
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {s.name}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* New Game button */}
            <div style={{ padding: '8px' }}>
              <button
                style={{
                  ...btnStyle(),
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px',
                  padding: '10px',
                  background: 'var(--accent)',
                  color: 'var(--bg)',
                  border: '2px outset var(--accent)',
                }}
              >
                <Plus size={12} />
                [NEW GAME]
              </button>
            </div>
          </aside>
        )}

        {/* ── Main Pane Area ── */}
        <main
          style={{
            flex: 1,
            display: 'grid',
            gridTemplateColumns: gridTemplate,
            gridTemplateRows: gridRows,
            gap: '0px',
            overflow: 'hidden',
          }}
        >
          {visiblePanes.map((session, idx) => (
            <Pane
              key={session.id}
              session={session}
              input={inputs[session.id] || ''}
              onInputChange={(v) => setInputs({ ...inputs, [session.id]: v })}
              showBorderLeft={idx > 0 && (layout === 2 || (layout === 4 && idx % 2 !== 0))}
              showBorderTop={layout === 4 && idx >= 2}
            />
          ))}

          {/* Empty pane slots */}
          {visiblePanes.length < layout &&
            Array.from({ length: layout - visiblePanes.length }).map((_, i) => (
              <div
                key={`empty-${i}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'var(--bg)',
                  borderLeft:
                    (visiblePanes.length + i) % 2 !== 0 || layout === 1
                      ? 'none'
                      : `3px solid var(--border-color)`,
                  borderTop:
                    layout === 4 && visiblePanes.length + i >= 2
                      ? `3px solid var(--border-color)`
                      : 'none',
                  color: 'var(--text-muted)',
                  fontSize: '9px',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                <Gamepad2 size={24} style={{ opacity: 0.3 }} />
                <span>SELECT A SESSION</span>
                <span style={{ fontSize: '8px' }}>FROM THE SIDEBAR</span>
              </div>
            ))}
        </main>
      </div>

      {/* ══════════ STATUS BAR ══════════ */}
      <footer
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 12px',
          background: 'var(--bg-surface)',
          borderTop: px.borderThick,
          fontSize: '9px',
          color: 'var(--text-secondary)',
          flexShrink: 0,
          boxShadow: '0 -2px 0 rgba(0,0,0,0.2)',
        }}
      >
        <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
          <span>
            <span style={{ color: 'var(--red)' }}>HP:</span>{' '}
            <span style={{ color: 'var(--text-primary)' }}>1,234</span>
          </span>
          <span style={{ color: 'var(--text-muted)' }}>|</span>
          <span>
            <span style={{ color: 'var(--yellow)' }}>GOLD:</span>{' '}
            <span style={{ color: 'var(--text-primary)' }}>$0.42</span>
          </span>
          <span style={{ color: 'var(--text-muted)' }}>|</span>
          <span>
            <span style={{ color: 'var(--green)' }}>LVL:</span>{' '}
            <span style={{ color: 'var(--text-primary)' }}>3</span>
          </span>
          <span style={{ color: 'var(--text-muted)' }}>|</span>
          <span>
            <span style={{ color: 'var(--accent)' }}>XP:</span>{' '}
            <span style={{ color: 'var(--text-primary)' }}>2,847/5,000</span>
          </span>
        </div>

        <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
          <span>
            PANES: <span style={{ color: 'var(--text-primary)' }}>{visiblePanes.length}/{layout}</span>
          </span>
          <span style={{ color: 'var(--text-muted)' }}>|</span>
          <span>
            MODEL: <span style={{ color: 'var(--accent)' }}>{activeModel}</span>
          </span>
          <span style={{ color: 'var(--text-muted)' }}>|</span>
          <span>
            STATUS: <span style={{ color: 'var(--green)' }}>ONLINE</span>
          </span>
        </div>
      </footer>
    </div>
  );
}

/* ────────────────────────────────────────── */
/*  PANE SUB-COMPONENT                       */
/* ────────────────────────────────────────── */
function Pane({ session, input, onInputChange, showBorderLeft, showBorderTop }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg)',
        borderLeft: showBorderLeft ? `3px solid var(--border-color)` : 'none',
        borderTop: showBorderTop ? `3px solid var(--border-color)` : 'none',
        overflow: 'hidden',
      }}
    >
      {/* Pane header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '6px 10px',
          background: 'var(--bg-elevated)',
          borderBottom: px.border,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            width: '8px',
            height: '8px',
            background: STATUS_COLORS[session.status],
            border: '1px solid rgba(0,0,0,0.3)',
            display: 'inline-block',
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontSize: '9px',
            fontFamily: px.font,
            letterSpacing: '1px',
            color: 'var(--text-primary)',
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {session.name}
        </span>
        <span
          style={{
            fontSize: '8px',
            color: 'var(--text-muted)',
            border: '1px solid var(--border-color)',
            padding: '2px 6px',
          }}
        >
          [{session.model}]
        </span>
        <span style={{ fontSize: '8px', color: 'var(--text-muted)' }}>
          TKN:{session.tokens}
        </span>
        <button
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-muted)',
            cursor: 'pointer',
            padding: '2px',
          }}
        >
          <X size={12} />
        </button>
      </div>

      {/* Messages */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '8px 10px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        }}
      >
        {session.messages.map((msg, i) => (
          <div key={i} style={{ lineHeight: '1.8' }}>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '2px' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: '8px' }}>[{msg.ts}]</span>
              {msg.role === 'user' ? (
                <span style={{ color: 'var(--yellow)', fontSize: '9px' }}>
                  <User size={10} style={{ verticalAlign: 'middle', marginRight: '4px' }} />
                  [YOU]:
                </span>
              ) : (
                <span style={{ color: 'var(--green)', fontSize: '9px' }}>
                  <Bot size={10} style={{ verticalAlign: 'middle', marginRight: '4px' }} />
                  [AI]:
                </span>
              )}
            </div>
            <div
              style={{
                paddingLeft: '16px',
                fontSize: '10px',
                color: msg.role === 'ai' ? 'var(--green)' : 'var(--text-primary)',
                whiteSpace: 'pre-wrap',
                borderLeft: `2px solid ${msg.role === 'ai' ? 'var(--green)' : 'var(--accent)'}`,
                marginLeft: '4px',
                paddingTop: '2px',
                paddingBottom: '2px',
              }}
            >
              {msg.text}
            </div>
          </div>
        ))}
      </div>

      {/* Input area */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '8px 10px',
          borderTop: px.border,
          background: 'var(--bg-surface)',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            color: 'var(--accent)',
            fontSize: '11px',
            fontFamily: px.font,
            flexShrink: 0,
          }}
        >
          &gt;
          <span style={{ animation: 'blink-cursor 1s step-end infinite' }}>_</span>
        </span>
        <input
          type="text"
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          placeholder="ENTER COMMAND..."
          style={{
            flex: 1,
            background: 'var(--bg)',
            border: '2px inset var(--border-color)',
            borderRadius: px.radius,
            padding: '6px 8px',
            fontFamily: px.font,
            fontSize: '9px',
            color: 'var(--text-primary)',
            outline: 'none',
          }}
        />
        <button style={{ ...btnStyle(), padding: '6px 8px' }} title="Attach file">
          <Paperclip size={12} />
        </button>
        <button
          style={{
            ...btnStyle(),
            padding: '6px 10px',
            background: 'var(--accent)',
            color: 'var(--bg)',
            border: '2px outset var(--accent)',
          }}
          title="Send"
        >
          <Send size={12} />
        </button>
      </div>
    </div>
  );
}
