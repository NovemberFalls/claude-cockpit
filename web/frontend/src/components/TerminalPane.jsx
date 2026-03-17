import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { X, GripVertical, Pencil, Brain, CircleHelp, CircleCheck, CircleX, Loader, Send } from "lucide-react";
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

/**
 * Chat-style input bar for relay mode (phone sessions).
 * Bypasses xterm.js's hidden textarea to avoid IME/composition duplication
 * on mobile keyboards. Sends raw text + special key sequences over WebSocket.
 */
function RelayInputBar({ wsRef, theme }) {
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef(null);

  const sendText = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(inputValue + "\n");
    }
    setInputValue("");
    inputRef.current?.focus();
  }, [inputValue, wsRef]);

  const sendSpecial = useCallback((seq) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(seq);
    }
    inputRef.current?.focus();
  }, [wsRef]);

  const pillStyle = {
    padding: "4px 10px",
    fontSize: "12px",
    fontFamily: "monospace",
    borderRadius: "9999px",
    border: "1px solid var(--border-color)",
    backgroundColor: "var(--bg-surface)",
    color: "var(--text-secondary)",
    cursor: "pointer",
    flexShrink: 0,
    WebkitTapHighlightColor: "transparent",
  };

  return (
    <div
      className="flex items-center gap-2 px-3 py-2 flex-shrink-0"
      style={{
        borderTop: "1px solid var(--border-color)",
        backgroundColor: theme.bgSurface || "var(--bg-surface)",
      }}
    >
      <div className="flex items-center gap-1 flex-shrink-0">
        <button style={pillStyle} onClick={() => sendSpecial("\x1b")}>Esc</button>
        <button style={pillStyle} onClick={() => sendSpecial("\x03")}>Ctrl+C</button>
        <button style={pillStyle} onClick={() => sendSpecial("\x1b[A")}>&uarr;</button>
        <button style={pillStyle} onClick={() => sendSpecial("\x1b[B")}>&darr;</button>
        <button style={pillStyle} onClick={() => sendSpecial("\t")}>Tab</button>
      </div>
      <input
        ref={inputRef}
        type="text"
        className="relay-input flex-1 text-sm px-3 py-1.5 rounded-lg min-w-0"
        style={{
          backgroundColor: "var(--bg)",
          color: "var(--text-primary)",
          border: "1px solid var(--border-color)",
          outline: "none",
          fontFamily: "inherit",
        }}
        placeholder="Type here..."
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            sendText();
          }
        }}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
      />
      <button
        onClick={sendText}
        className="flex-shrink-0 p-1.5 rounded-lg"
        style={{
          backgroundColor: "var(--accent)",
          color: "var(--bg)",
          border: "none",
          cursor: "pointer",
          WebkitTapHighlightColor: "transparent",
        }}
        title="Send"
      >
        <Send size={16} />
      </button>
    </div>
  );
}

const TerminalPane = forwardRef(function TerminalPane({
  session,       // { id, name, terminalId, model, status, activityState }
  onClose,       // () => void
  onNameChange,  // (name) => void
  paneIndex,     // number — position in the grid
  onSwap,        // (fromIndex, toIndex) => void
  isRelay = false, // true when running in relay mode (disables file drop)
  terminalZoom = 13, // terminal font size (zoom level)
  toast,           // (msg, type) => void — optional toast notification
}, ref) {
  const termRef = useRef(null);       // DOM ref
  const xtermRef = useRef(null);      // Terminal instance
  const fitRef = useRef(null);        // FitAddon instance
  const wsRef = useRef(null);         // WebSocket
  const resizeObserver = useRef(null);
  const resizeTimer = useRef(null);
  const reconnectTimer = useRef(null);
  const reconnectAttempts = useRef(0);
  const pendingDataRef = useRef("");  // Batched WS data for xterm
  const writeRafRef = useRef(null);   // rAF handle for batched writes
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
      // Handle heartbeat pings from server
      if (evt.data && evt.data.startsWith('{"type":"ping"}')) {
        try { ws.send('{"type":"pong"}'); } catch {}
        return;
      }
      // Batch writes: accumulate data and flush once per animation frame.
      // During heavy output, this reduces hundreds of xterm.write() calls
      // per second down to ~60 (one per frame), preventing UI freezes.
      pendingDataRef.current += evt.data;
      if (!writeRafRef.current) {
        writeRafRef.current = requestAnimationFrame(() => {
          if (xtermRef.current && pendingDataRef.current) {
            xtermRef.current.write(pendingDataRef.current);
          }
          pendingDataRef.current = "";
          writeRafRef.current = null;
        });
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

      // Auto-reconnect: fast backoff (1s/2s/4s), then slow poll (10s) indefinitely
      const attempt = reconnectAttempts.current;
      const delay = attempt < 3
        ? Math.min(1000 * Math.pow(2, attempt), 4000)  // 1s, 2s, 4s
        : 10000;  // Then every 10s while waiting for backend recovery
      reconnectAttempts.current++;
      if (xtermRef.current) {
        if (attempt < 3) {
          xtermRef.current.write(
            `\r\n\x1b[33m[Reconnecting in ${delay / 1000}s...]\x1b[0m\r\n`
          );
        } else if (attempt === 3) {
          xtermRef.current.write(
            "\r\n\x1b[33m[Backend down — waiting for recovery...]\x1b[0m\r\n"
          );
        }
        // After attempt 3, reconnect silently every 10s
      }
      reconnectTimer.current = setTimeout(() => connectWs(terminalId), delay);
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
      disableStdin: isRelay,
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

    // Terminal input -> WebSocket (disabled in relay mode — RelayInputBar handles input)
    if (!isRelay) {
      term.onData((data) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(data);
        }
      });
    }

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
      cancelAnimationFrame(writeRafRef.current);
      resizeObserver.current?.disconnect();
      wsRef.current?.close();
      term.dispose();
      xtermRef.current = null;
      fitRef.current = null;
      pendingDataRef.current = "";
      writeRafRef.current = null;
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
      if (data.error) {
        toast?.(`Upload failed: ${data.error}`, "error");
        return;
      }
      if (data.paths?.length && wsRef.current?.readyState === WebSocket.OPEN) {
        // Paste file paths into the terminal (quote paths with spaces)
        const pathStr = data.paths
          .map((p) => (p.includes(" ") ? `"${p}"` : p))
          .join(" ");
        wsRef.current.send(pathStr);
        toast?.(`Dropped ${data.paths.length} file${data.paths.length > 1 ? "s" : ""}`, "success");
      } else if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        toast?.("Session not connected — cannot drop files", "error");
      }
    } catch (err) {
      toast?.(`Upload failed: ${err.message}`, "error");
    }
  }, [toast]);

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

      {/* Relay input bar (phone sessions) */}
      {isRelay && <RelayInputBar wsRef={wsRef} theme={theme} />}
    </div>
  );
});

export default TerminalPane;
