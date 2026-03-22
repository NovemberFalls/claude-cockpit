import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const isMobile = () =>
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  window.innerWidth < 768;

export default function TerminalPane({ instanceId, terminalId }) {
  const containerRef = useRef(null);
  const terminalRef = useRef(null);
  const wsRef = useRef(null);
  const fitAddonRef = useRef(null);
  const [mobile] = useState(isMobile);
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef(null);

  const sendSpecial = useCallback((seq) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(seq);
    }
    inputRef.current?.focus();
  }, []);

  const sendText = useCallback(() => {
    if (!inputValue || wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(inputValue + "\r");
    setInputValue("");
    inputRef.current?.focus();
  }, [inputValue]);

  useEffect(() => {
    if (!containerRef.current || !instanceId || !terminalId) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: mobile ? 9 : 13,
      fontFamily: "'Cascadia Code', 'JetBrains Mono', 'Fira Code', monospace",
      disableStdin: mobile,  // on mobile, input bar handles it
      scrollback: 5000,
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
      term.writeln("\x1b[32mConnected\x1b[0m\r\n");
      // Do NOT send resize — PTY keeps desktop dimensions
    };

    ws.onmessage = (event) => {
      term.write(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data));
      // Scroll to bottom on new output
      term.scrollToBottom();
    };

    ws.onclose = () => term.writeln("\r\n\x1b[33m[Disconnected]\x1b[0m");
    ws.onerror = () => term.writeln("\r\n\x1b[31m[Connection error]\x1b[0m");

    // Desktop: forward keystrokes directly
    if (!mobile) {
      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      });
    }

    // Resize observer (desktop only — don't send resize to server)
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

  const pillStyle = {
    padding: "4px 10px",
    fontSize: "12px",
    fontFamily: "monospace",
    borderRadius: "9999px",
    border: "1px solid #334155",
    backgroundColor: "#1e293b",
    color: "#94a3b8",
    cursor: "pointer",
    flexShrink: 0,
    WebkitTapHighlightColor: "transparent",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* Terminal — on mobile, wider than viewport so more cols fit; scrollable */}
      <div style={{ flex: 1, minHeight: 0, overflow: mobile ? "auto" : "hidden" }}>
        <div
          ref={containerRef}
          style={{
            height: "100%",
            width: mobile ? "200vw" : "100%",
            backgroundColor: "#0f1117",
          }}
        />
      </div>

      {/* Mobile input bar */}
      {mobile && (
        <div style={{
          display: "flex",
          flexDirection: "column",
          gap: "6px",
          padding: "8px",
          borderTop: "1px solid #1e293b",
          backgroundColor: "#0f1117",
          flexShrink: 0,
        }}>
          {/* Special keys */}
          <div style={{ display: "flex", gap: "6px", overflowX: "auto" }}>
            <button style={pillStyle} onClick={() => sendSpecial("\x1b")}>Esc</button>
            <button style={pillStyle} onClick={() => sendSpecial("\x03")}>Ctrl+C</button>
            <button style={pillStyle} onClick={() => sendSpecial("\x1b[A")}>▲</button>
            <button style={pillStyle} onClick={() => sendSpecial("\x1b[B")}>▼</button>
            <button style={pillStyle} onClick={() => sendSpecial("\t")}>Tab</button>
            <button style={pillStyle} onClick={() => sendSpecial("\x1b[D")}>◀</button>
            <button style={pillStyle} onClick={() => sendSpecial("\x1b[C")}>▶</button>
          </div>
          {/* Text input + send */}
          <div style={{ display: "flex", gap: "6px" }}>
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); sendText(); } }}
              placeholder="Type here..."
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              style={{
                flex: 1,
                padding: "8px 12px",
                borderRadius: "8px",
                border: "1px solid #334155",
                backgroundColor: "#1e293b",
                color: "#e2e8f0",
                fontSize: "14px",
                outline: "none",
              }}
            />
            <button
              onClick={sendText}
              style={{
                padding: "8px 16px",
                borderRadius: "8px",
                border: "none",
                backgroundColor: "#6366f1",
                color: "#fff",
                fontWeight: "600",
                cursor: "pointer",
                flexShrink: 0,
                WebkitTapHighlightColor: "transparent",
              }}
            >
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
