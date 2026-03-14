import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { X, MoreHorizontal } from "lucide-react";
import { useTheme } from "../hooks/useTheme";
import "@xterm/xterm/css/xterm.css";

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

export default function TerminalPane({
  session,       // { id, name, terminalId, model, status }
  onClose,       // () => void
  onNameChange,  // (name) => void
}) {
  const termRef = useRef(null);       // DOM ref
  const xtermRef = useRef(null);      // Terminal instance
  const fitRef = useRef(null);        // FitAddon instance
  const wsRef = useRef(null);         // WebSocket
  const resizeObserver = useRef(null);
  const resizeTimer = useRef(null);
  const reconnectTimer = useRef(null);
  const reconnectAttempts = useRef(0);
  const { theme } = useTheme();

  // Connect terminal to PTY via WebSocket
  const connectWs = useCallback((terminalId) => {
    if (!xtermRef.current) return;

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws/terminal/${terminalId}`);
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectAttempts.current = 0;
      // Fit on connect to send initial dimensions
      if (fitRef.current) {
        fitRef.current.fit();
        const term = xtermRef.current;
        ws.send(JSON.stringify({
          type: "resize",
          cols: term.cols,
          rows: term.rows,
        }));
      }
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
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', monospace",
      lineHeight: 1.3,
      theme: buildXtermTheme(theme),
      allowTransparency: true,
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

    // Fit once mounted
    requestAnimationFrame(() => fitAddon.fit());

    // Terminal input -> WebSocket
    term.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(data);
      }
    });

    // Resize observer with debounce
    resizeObserver.current = new ResizeObserver(() => {
      clearTimeout(resizeTimer.current);
      resizeTimer.current = setTimeout(() => {
        if (fitRef.current && xtermRef.current) {
          fitRef.current.fit();
          const ws = wsRef.current;
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: "resize",
              cols: xtermRef.current.cols,
              rows: xtermRef.current.rows,
            }));
          }
        }
      }, 150);
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

  // Refit when layout changes (external size change)
  useEffect(() => {
    const timer = setTimeout(() => {
      if (fitRef.current) fitRef.current.fit();
    }, 100);
    return () => clearTimeout(timer);
  });

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

  return (
    <div className="flex flex-col h-full min-w-0">
      {/* Pane header */}
      <div
        className="flex items-center justify-between px-3 h-9 flex-shrink-0"
        style={{ borderBottom: "1px solid var(--border-color)" }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
            style={{
              backgroundColor:
                session.status === "running"
                  ? "var(--green)"
                  : session.status === "error"
                    ? "var(--red)"
                    : "var(--text-muted)",
            }}
          />
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
            className="p-0.5 rounded transition-colors"
            style={{ color: "var(--text-muted)" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--red)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
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
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      />
    </div>
  );
}
