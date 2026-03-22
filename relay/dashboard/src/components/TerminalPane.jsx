import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const isMobile = () =>
  navigator.maxTouchPoints > 0 || window.innerWidth < 768;

// Scale the xterm canvas so it renders at ~100 cols on a 360px phone,
// matching typical desktop PTY widths. The outer wrapper clips to the
// natural layout size; the inner (containerRef) div is enlarged then
// scaled back, giving fitAddon more pixels to work with.
const MOBILE_SCALE = 0.6; // inner div is 1/0.6 = 167% of wrapper

export default function TerminalPane({ instanceId, terminalId }) {
  const wrapperRef = useRef(null);  // outer clip div (mobile only)
  const containerRef = useRef(null); // xterm mount point
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
      // On mobile: use 10px font — after MOBILE_SCALE the visual size is
      // 6px, but fitAddon sees the full 167%-wide container → ~100 cols.
      fontSize: mobile ? 10 : 13,
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

    // Watch the outer wrapper (mobile) or container (desktop) for size changes.
    // When the wrapper resizes, the inner containerRef scales with it (167%),
    // so fitAddon will remeasure and update col count correctly.
    const observeTarget = (mobile && wrapperRef.current) ? wrapperRef.current : containerRef.current;
    const observer = new ResizeObserver(() => {
      try { fitAddon.fit(); } catch {}
    });
    if (observeTarget) observer.observe(observeTarget);

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

  const pct = `${(1 / MOBILE_SCALE) * 100}%`; // "167%"

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* Terminal */}
      {mobile ? (
        // Outer: participates in flex layout at normal size, clips overflow
        <div
          ref={wrapperRef}
          style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden", backgroundColor: "#0f1117" }}
        >
          {/* Inner: enlarged then scaled back — gives fitAddon ~100 cols */}
          <div
            ref={containerRef}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: pct,
              height: pct,
              transform: `scale(${MOBILE_SCALE})`,
              transformOrigin: "top left",
              backgroundColor: "#0f1117",
            }}
          />
        </div>
      ) : (
        <div
          ref={containerRef}
          style={{ flex: 1, minHeight: 0, backgroundColor: "#0f1117", overflow: "hidden" }}
        />
      )}

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
