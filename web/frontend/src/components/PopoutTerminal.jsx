import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { CanvasAddon } from "@xterm/addon-canvas";
import { useTheme } from "../hooks/useTheme";
import "@xterm/xterm/css/xterm.css";

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

export default function PopoutTerminal({ terminalId, name, model }) {
  const termRef = useRef(null);
  const xtermRef = useRef(null);
  const fitRef = useRef(null);
  const wsRef = useRef(null);
  const webglRef = useRef(null);
  const reconnectTimer = useRef(null);
  const reconnectAttempts = useRef(0);
  const pendingDataRef = useRef("");
  const writeRafRef = useRef(null);
  const atlasSeededRef = useRef(false);
  const connectWsRef = useRef(null);
  const { theme } = useTheme();

  useEffect(() => {
    document.title = `${name} — Claude Cockpit`;
  }, [name]);

  // BroadcastChannel: fire CLOSED on unload, listen for RECLAIM
  useEffect(() => {
    const bc = new BroadcastChannel("cockpit-popout");

    const handleMessage = (event) => {
      if (event.data?.type === "RECLAIM" && event.data.terminalId === terminalId) {
        window.close();
      }
    };
    bc.addEventListener("message", handleMessage);

    const handleUnload = () => {
      bc.postMessage({ type: "CLOSED", terminalId });
    };
    window.addEventListener("beforeunload", handleUnload);

    return () => {
      bc.removeEventListener("message", handleMessage);
      window.removeEventListener("beforeunload", handleUnload);
      bc.close();
    };
  }, [terminalId]);

  // Theme sync — update xterm theme when theme changes
  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.theme = buildXtermTheme(theme);
      webglRef.current?.clearTextureAtlas?.();
    }
  }, [theme]);

  // Terminal init + WebSocket — runs once on mount
  useEffect(() => {
    if (!termRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontSize: 13,
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

    const loadCanvasFallback = () => {
      try { term.loadAddon(new CanvasAddon()); } catch {}
    };
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        webglRef.current = null;
        loadCanvasFallback();
      });
      term.loadAddon(webgl);
      webglRef.current = webgl;
      webgl.clearTextureAtlas?.();
    } catch {
      loadCanvasFallback();
    }

    xtermRef.current = term;
    fitRef.current = fitAddon;

    const safeFit = () => {
      const el = termRef.current;
      const fit = fitRef.current;
      const t = xtermRef.current;
      if (!el || !fit || !t) return;
      if (el.clientWidth < 10 || el.clientHeight < 10) return;
      try {
        fit.fit();
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols: t.cols, rows: t.rows }));
        }
      } catch {}
    };

    requestAnimationFrame(() => requestAnimationFrame(() => safeFit()));

    const resizeObserver = new ResizeObserver(() => safeFit());
    resizeObserver.observe(termRef.current);

    const onVisibilityChange = () => {
      if (!document.hidden && webglRef.current) {
        webglRef.current.clearTextureAtlas?.();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    term.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(data);
      }
    });

    const connectWs = (tid) => {
      if (!xtermRef.current) return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const wsBase = location.hostname === "localhost"
        ? `ws://localhost:8420`
        : `${proto}//${location.host}`;
      const ws = new WebSocket(`${wsBase}/ws/terminal/${tid}`);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttempts.current = 0;
        safeFit();
      };

      ws.onmessage = (evt) => {
        if (evt.data && evt.data.startsWith('{"type":"ping"}')) {
          try { ws.send('{"type":"pong"}'); } catch {}
          return;
        }
        pendingDataRef.current += evt.data;
        if (!writeRafRef.current) {
          writeRafRef.current = requestAnimationFrame(() => {
            if (xtermRef.current && pendingDataRef.current) {
              xtermRef.current.write(pendingDataRef.current);
              if (!atlasSeededRef.current && webglRef.current) {
                atlasSeededRef.current = true;
                setTimeout(() => webglRef.current?.clearTextureAtlas?.(), 150);
              }
            }
            pendingDataRef.current = "";
            writeRafRef.current = null;
          });
        }
      };

      ws.onclose = (evt) => {
        if (evt.code === 1000 || evt.code === 4004) {
          if (evt.code === 4004 && xtermRef.current) {
            xtermRef.current.write("\r\n\x1b[31m[Terminal no longer exists on server]\x1b[0m\r\n");
          }
          return;
        }
        const attempt = reconnectAttempts.current;
        const delay = attempt < 3 ? Math.min(1000 * Math.pow(2, attempt), 4000) : 10000;
        reconnectAttempts.current++;
        if (xtermRef.current && attempt < 3) {
          xtermRef.current.write(`\r\n\x1b[33m[Reconnecting in ${delay / 1000}s...]\x1b[0m\r\n`);
        }
        reconnectTimer.current = setTimeout(() => connectWsRef.current?.(tid), delay);
      };

      ws.onerror = () => {};
    };

    connectWsRef.current = connectWs;
    connectWs(terminalId);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearTimeout(reconnectTimer.current);
      cancelAnimationFrame(writeRafRef.current);
      resizeObserver.disconnect();
      wsRef.current?.close();
      term.dispose();
      xtermRef.current = null;
      fitRef.current = null;
      webglRef.current = null;
      atlasSeededRef.current = false;
      pendingDataRef.current = "";
      writeRafRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: runs once on mount
  }, []);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        width: "100vw",
        backgroundColor: "var(--bg-base)",
        overflow: "hidden",
      }}
    >
      {/* Minimal header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 12px",
          height: 36,
          flexShrink: 0,
          borderBottom: "1px solid var(--border-color)",
        }}
      >
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--text-primary)",
          }}
        >
          {name}
        </span>
        <span
          style={{
            fontSize: 10,
            padding: "2px 6px",
            borderRadius: 999,
            color: "var(--text-muted)",
            backgroundColor: "var(--bg-surface)",
          }}
        >
          {model}
        </span>
      </div>

      {/* Terminal area */}
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        <div
          ref={termRef}
          style={{
            width: "100%",
            height: "100%",
            padding: "4px 8px",
            backgroundColor: theme.bg,
          }}
        />
      </div>
    </div>
  );
}
