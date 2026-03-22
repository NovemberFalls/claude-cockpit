import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export default function TerminalPane({ instanceId, terminalId }) {
  const containerRef = useRef(null);
  const terminalRef = useRef(null);
  const wsRef = useRef(null);
  const fitAddonRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current || !instanceId || !terminalId) return;

    // Create xterm instance
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'Cascadia Code', 'JetBrains Mono', 'Fira Code', monospace",
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
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    // Delay fit to ensure container is rendered
    requestAnimationFrame(() => {
      try {
        fitAddon.fit();
      } catch {}
    });

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // WebSocket connection to relay
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${window.location.host}/ws/terminal/${instanceId}/${terminalId}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      term.writeln("\x1b[32mConnected to remote terminal\x1b[0m\r\n");

      // Send resize
      const dims = fitAddon.proposeDimensions();
      if (dims) {
        ws.send(JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows }));
      }
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(event.data);
        const text = new TextDecoder().decode(bytes);
        term.write(text);
      } else {
        term.write(event.data);
      }
    };

    ws.onclose = () => {
      term.writeln("\r\n\x1b[33m[Connection closed]\x1b[0m");
    };

    ws.onerror = () => {
      term.writeln("\r\n\x1b[31m[Connection error]\x1b[0m");
    };

    // Forward keystrokes to relay
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    // Handle resize
    const handleResize = () => {
      try {
        fitAddon.fit();
        const dims = fitAddon.proposeDimensions();
        if (dims && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows }));
        }
      } catch {}
    };

    const observer = new ResizeObserver(handleResize);
    observer.observe(containerRef.current);
    window.addEventListener("resize", handleResize);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", handleResize);
      ws.close();
      term.dispose();
    };
  }, [instanceId, terminalId]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{ backgroundColor: "#0f1117" }}
    />
  );
}
