import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { X, GripVertical, Pencil, Brain, CircleHelp, CircleCheck, CircleX, Loader } from "lucide-react";
import { useTheme } from "../hooks/useTheme";
import "@xterm/xterm/css/xterm.css";

const stateIconMap = {
  busy: { icon: Pencil, color: "var(--accent)", className: "state-icon-busy" },
  thinking: { icon: Brain, color: "var(--accent)", className: "state-icon-busy" },
  waiting: { icon: CircleHelp, color: "var(--yellow)", className: "" },
  idle: { icon: CircleCheck, color: "var(--green)", className: "" },
  error: { icon: CircleX, color: "var(--red)", className: "" },
  starting: { icon: Loader, color: "var(--text-muted)", className: "state-icon-spin" },
};

function StateIcon({ state }) {
  const entry = stateIconMap[state] || stateIconMap.idle;
  const Icon = entry.icon;
  return <Icon size={12} style={{ color: entry.color, flexShrink: 0 }} className={entry.className} />;
}

/**
 * Build an xterm.js theme from our cockpit theme palette.
 */
function buildXtermTheme(theme) {
  return {
    background: theme.bg,
    foreground: theme.fg,
    cursor: theme.accent,
    cursorAccent: theme.bg,
    selectionBackground: `${theme.accent}40`,
    selectionForeground: theme.fg,
    black: theme.bgSurface,
    red: theme.red,
    green: theme.green,
    yellow: theme.yellow,
    blue: theme.accent,
    magenta: theme.purple,
    cyan: theme.cyan,
    white: theme.fg,
    brightBlack: theme.fgMuted,
    brightRed: theme.red,
    brightGreen: theme.green,
    brightYellow: theme.yellow,
    brightBlue: theme.accent,
    brightMagenta: theme.purple,
    brightCyan: theme.cyan,
    brightWhite: "#ffffff",
  };
}

const TerminalPane = forwardRef(function TerminalPane({
  session,       // { id, name, terminalId, model, status, activityState }
  onClose,       // () => void
  onNameChange,  // (name) => void
  paneIndex,     // number — position in the grid
  onSwap,        // (fromIndex, toIndex) => void
  isRelay = false, // true when running in relay mode (disables file drop)
  terminalZoom = 13, // terminal font size (zoom level)
}, ref) {
  const termRef = useRef(null);       // DOM ref
  const xtermRef = useRef(null);      // Terminal instance
  const fitRef = useRef(null);        // FitAddon instance
  const wsRef = useRef(null);         // WebSocket
  const resizeObserver = useRef(null);
  const resizeTimer = useRef(null);
  const reconnectTimer = useRef(null);
  const reconnectAttempts = useRef(0);
  const { theme } = useTheme();

  // Expose focus() to parent via ref
  useImperativeHandle(ref, () => ({
    focus: () => xtermRef.current?.focus(),
  }));

  // Safe fit: guard against zero-dimension containers and send resize to PTY
  const safeFit = useCallback(() => {
    const el = termRef.current;
    const fit = fitRef.current;
    const term = xtermRef.current;
    if (!el || !fit || !term) return;
    // Skip if container has no size (hidden, transitioning, or not laid out yet)
    if (el.clientWidth < 10 || el.clientHeight < 10) return;
    try {
      fit.fit();
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "resize",
          cols: term.cols,
          rows: term.rows,
        }));
      }
    } catch {
      // fit() can throw if terminal is disposed during resize
    }
  }, []);

  // Connect terminal to PTY via WebSocket
  const connectWs = useCallback((terminalId) => {
    if (!xtermRef.current) return;

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws/terminal/${terminalId}`);
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectAttempts.current = 0;
      // Fit on connect to send initial dimensions
      safeFit();
    };

    ws.onmessage = (evt) => {
      if (xtermRef.current) {
        xtermRef.current.write(evt.data);
      }
    };

    ws.onclose = (evt) => {
      // Don't reconnect if intentionally closed or terminal not found on server
      if (evt.code === 1000 || evt.code === 4004) {
        if (evt.code === 4004 && xtermRef.current) {
          xtermRef.current.write(
            "\r\n\x1b[31m[Terminal no longer exists on server]\x1b[0m\r\n"
          );
        }
        return;
      }

      // Auto-reconnect with backoff (max 3 attempts, 1s/2s/4s)
      if (reconnectAttempts.current < 3) {
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 4000);
        reconnectAttempts.current++;
        if (xtermRef.current) {
          xtermRef.current.write(
            `\r\n\x1b[33m[Reconnecting in ${delay / 1000}s...]\x1b[0m\r\n`
          );
        }
        reconnectTimer.current = setTimeout(() => connectWs(terminalId), delay);
      } else if (xtermRef.current) {
        xtermRef.current.write("\r\n\x1b[31m[Connection lost — close and open a new session]\x1b[0m\r\n");
      }
    };

    ws.onerror = () => {
      // onclose will handle reconnection
    };
  }, []);

  // Initialize xterm.js
  useEffect(() => {
    if (!termRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontSize: terminalZoom,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', monospace",
      lineHeight: 1.3,
      theme: buildXtermTheme(theme),
      allowTransparency: false,
      scrollback: 10000,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(termRef.current);

    xtermRef.current = term;
    fitRef.current = fitAddon;

    // Fit once mounted (double-rAF to ensure layout is settled)
    requestAnimationFrame(() => requestAnimationFrame(() => safeFit()));

    // Terminal input -> WebSocket
    term.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(data);
      }
    });

    // Resize observer with debounce
    resizeObserver.current = new ResizeObserver(() => {
      clearTimeout(resizeTimer.current);
      resizeTimer.current = setTimeout(safeFit, 150);
    });
    resizeObserver.current.observe(termRef.current);

    // Connect to PTY if we have a terminalId
    if (session.terminalId) {
      connectWs(session.terminalId);
    }

    return () => {
      clearTimeout(resizeTimer.current);
      clearTimeout(reconnectTimer.current);
      resizeObserver.current?.disconnect();
      wsRef.current?.close();
      term.dispose();
      xtermRef.current = null;
      fitRef.current = null;
    };
  }, []); // Only run once on mount

  // Update theme when it changes
  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.theme = buildXtermTheme(theme);
    }
  }, [theme]);

  // Update font size when zoom changes
  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.fontSize = terminalZoom;
      requestAnimationFrame(() => safeFit());
    }
  }, [terminalZoom, safeFit]);

  // Connect/reconnect when terminalId changes
  useEffect(() => {
    if (session.terminalId && xtermRef.current) {
      // Close old connection and cancel pending reconnects
      clearTimeout(reconnectTimer.current);
      reconnectAttempts.current = 0;
      wsRef.current?.close();
      // Reset terminal
      xtermRef.current.clear();
      connectWs(session.terminalId);
    }
  }, [session.terminalId, connectWs]);

  // Refit when pane position changes (layout switch causes external size change)
  useEffect(() => {
    // Double-delayed fit: first wait for CSS grid to settle, then fit
    const timer1 = setTimeout(safeFit, 50);
    const timer2 = setTimeout(safeFit, 200);
    return () => { clearTimeout(timer1); clearTimeout(timer2); };
  }, [paneIndex, safeFit]);

  // File drop handler
  const handleDrop = useCallback(async (e) => {
    e.preventDefault();
    e.stopPropagation();

    const files = Array.from(e.dataTransfer?.files || []);
    if (!files.length) return;

    const formData = new FormData();
    files.forEach((f) => formData.append("files", f));

    try {
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      const data = await res.json();
      if (data.paths?.length && wsRef.current?.readyState === WebSocket.OPEN) {
        // Paste file paths into the terminal
        const pathStr = data.paths.join(" ");
        wsRef.current.send(pathStr);
      }
    } catch {
      // Silently fail
    }
  }, []);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const activityState = session.activityState || (session.status === "running" ? "idle" : session.status);
  const isWaiting = activityState === "waiting";

  return (
    <div
      className="flex flex-col h-full min-w-0"
      style={{
        boxShadow: isWaiting
          ? "inset 0 0 0 1px var(--yellow), 0 0 15px rgba(234, 179, 8, 0.3)"
          : "none",
        animation: isWaiting ? "attention-glow 2s ease-in-out infinite" : "none",
        transition: "box-shadow 0.3s ease",
      }}
    >
      {/* Pane header */}
      <div
        className="flex items-center justify-between px-3 h-9 flex-shrink-0"
        style={{ borderBottom: "1px solid var(--border-color)" }}
        draggable={onSwap != null}
        onDragStart={(e) => {
          if (paneIndex == null) return;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", String(paneIndex));
        }}
        onDragOver={(e) => {
          if (!onSwap) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }}
        onDrop={(e) => {
          if (!onSwap || paneIndex == null) return;
          e.preventDefault();
          const from = parseInt(e.dataTransfer.getData("text/plain"), 10);
          if (!isNaN(from) && from !== paneIndex) onSwap(from, paneIndex);
        }}
      >
        <div className="flex items-center gap-2 min-w-0">
          {onSwap && (
            <GripVertical
              size={12}
              className="flex-shrink-0 cursor-grab"
              style={{ color: "var(--text-muted)" }}
            />
          )}
          <StateIcon state={activityState} />
          <span
            className="text-xs font-medium truncate"
            style={{ color: "var(--text-primary)" }}
          >
            {session.name}
          </span>
          <span
            className="text-[10px] px-1.5 py-0.5 rounded-full"
            style={{
              color: "var(--text-muted)",
              backgroundColor: "var(--bg-surface)",
            }}
          >
            {session.model}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onClose}
            className="p-0.5 rounded transition-colors hover-color-red"
            style={{ color: "var(--text-muted)" }}
            title="Close session"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Terminal area */}
      <div
        ref={termRef}
        className="flex-1 min-h-0"
        style={{
          padding: "4px 8px",
          backgroundColor: theme.bg,
        }}
        onDrop={isRelay ? undefined : handleDrop}
        onDragOver={isRelay ? undefined : handleDragOver}
      />
    </div>
  );
});

export default TerminalPane;
