import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const isMobile = () =>
  navigator.maxTouchPoints > 0 || window.innerWidth < 768;

export default function TerminalPane({ instanceId, terminalId }) {
  const containerRef = useRef(null);
  const terminalRef = useRef(null);
  const wsRef = useRef(null);
  const fitAddonRef = useRef(null);
  const [mobile] = useState(isMobile);

  const sendSpecial = useCallback((seq) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(seq);
    }
    // Refocus xterm so keyboard stays open on mobile
    terminalRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!containerRef.current || !instanceId || !terminalId) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: mobile ? 7 : 13,
      fontFamily: "'Cascadia Code', 'JetBrains Mono', 'Fira Code', monospace",
      disableStdin: false,  // allow direct typing on mobile too
      scrollback: 1000,
      convertEol: true,
      theme: {
        background: "#0f1117",
        foreground: "#e2e8f0",
        cursor: "#6366f1",
        selectionBackground: "rgba(99, 102, 241, 0.3)",
        black: "#1e293b",
        red: "#ef4444",
        green: "#22c55e",
        yellow: "#eab308",
        blue: "#3b82f6",
        magenta: "#a855f7",
        cyan: "#06b6d4",
        white: "#e2e8f0",
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    requestAnimationFrame(() => {
      try { fitAddon.fit(); } catch {}
    });

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${window.location.host}/ws/terminal/${instanceId}/${terminalId}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      term.clear();
      term.writeln("\x1b[32mConnected\x1b[0m");
    };

    ws.onmessage = (event) => {
      term.write(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data));
      term.scrollToBottom();
    };

    ws.onclose = () => term.writeln("\r\n\x1b[33m[Disconnected]\x1b[0m");
    ws.onerror = () => term.writeln("\r\n\x1b[31m[Connection error]\x1b[0m");

    if (!mobile) {
      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      });
    }

    const observer = new ResizeObserver(() => {
      try { fitAddon.fit(); } catch {}
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      ws.close();
      term.dispose();
    };
  }, [instanceId, terminalId, mobile]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* Terminal canvas */}
      <div
        ref={containerRef}
        style={{ flex: 1, minHeight: 0, backgroundColor: "#0f1117", overflow: "hidden" }}
      />

      {/* Mobile input bar */}
      {mobile && (
        <div style={{
          borderTop: "2px solid #6366f1",
          backgroundColor: "#0d1117",
          flexShrink: 0,
        }}>
          {/* Special keys — horizontally scrollable */}
          <div style={{
            display: "flex",
            gap: "4px",
            padding: "6px 8px 4px",
            overflowX: "auto",
            WebkitOverflowScrolling: "touch",
          }}>
            {[["Esc","\x1b"],["^C","\x03"],["▲","\x1b[A"],["▼","\x1b[B"],["◀","\x1b[D"],["▶","\x1b[C"],["Tab","\t"]].map(([label, seq]) => (
              <button key={label} onClick={() => sendSpecial(seq)} style={{
                padding: "4px 10px",
                fontSize: "12px",
                fontFamily: "monospace",
                borderRadius: "6px",
                border: "1px solid #334155",
                backgroundColor: "#1e293b",
                color: "#94a3b8",
                cursor: "pointer",
                flexShrink: 0,
                WebkitTapHighlightColor: "transparent",
              }}>{label}</button>
            ))}
          </div>
          {/* Tap hint */}
          <p style={{ margin: "2px 8px 6px", fontSize: "11px", color: "#475569" }}>
            Tap the terminal above to type directly
          </p>
        </div>
      )}
    </div>
  );
}
