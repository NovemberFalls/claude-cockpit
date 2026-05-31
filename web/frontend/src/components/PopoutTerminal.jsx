import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
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
  const canvasAddonRef = useRef(null); // CanvasAddon instance (for explicit pre-dispose)
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);
  const reconnectAttempts = useRef(0);
  const pendingDataRef = useRef("");
  const writeRafRef = useRef(null);
  const connectWsRef = useRef(null);
  const { theme } = useTheme();

  useEffect(() => {
    document.title = `${name} — Claude Cockpit`;
  }, [name]);

  // BroadcastChannel: fire CLOSED on unload, listen for RECLAIM
  useEffect(() => {
    const bc = new BroadcastChannel("cockpit-popout");

    const handleMessage = async (event) => {
      if (event.data?.type === "RECLAIM" && event.data.terminalId === terminalId) {
        if (window.__TAURI_INTERNALS__ || window.__TAURI__) {
          try {
            const { getCurrentWindow } = await import("@tauri-apps/api/window");
            await getCurrentWindow().close();
            return;
          } catch {
            // fall through to web close
          }
        }
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

  // Theme sync — update xterm theme when theme changes; Canvas re-rasterizes automatically.
  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.theme = buildXtermTheme(theme);
    }
  }, [theme]);

  // Terminal init + WebSocket + paste stack — runs once on mount
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

    // Canvas renderer — no GPU texture atlas, so it is immune to the
    // multi-context glyph-atlas desync that corrupted WebGL output across
    // many panes. DOM renderer is the implicit final fallback.
    //
    // Guard: CanvasAddon.activate() reads core.linkifier to build LinkRenderLayer.
    // linkifier is undefined until late in open() AND becomes undefined again on
    // dispose (MutableDisposable clears its value). Meanwhile term.element is set
    // earlier (line ~417) and is NOT cleared the same way — so there is a window
    // where element is truthy but linkifier is undefined. CanvasAddon does not
    // guard for that, producing the "Cannot read properties of undefined (reading
    // 'onShowLinkUnderline')" crash that surfaces on popout re-mount timing.
    // Checking linkifier here (right after open()) is safe: open() sets it before
    // returning, so Canvas still loads in the normal case.
    try {
      const core = term._core; // private but stable; same accessor CanvasAddon uses internally
      if (core && core.linkifier) {
        const canvas = new CanvasAddon();
        term.loadAddon(canvas);
        canvasAddonRef.current = canvas;
      }
      // else: xterm's default DOM renderer (created during open()) stays active — correct, safe fallback.
    } catch {
      // DOM renderer remains active.
    }

    xtermRef.current = term;
    fitRef.current = fitAddon;

    // -------------------------------------------------------------------------
    // Paste stack — ported faithfully from TerminalPane.jsx.
    // PopoutTerminal has no `toast` prop; paste failures are silent.
    // -------------------------------------------------------------------------

    // Alt+V handler — uses navigator.clipboard.read() because there is no DOM
    // paste event for Alt+V. Matches Claude Code's native image-paste shortcut.
    const handleAltVPaste = async () => {
      try {
        const clipboardItems = await navigator.clipboard.read();
        let handledImage = false;

        for (const item of clipboardItems) {
          const imageType = item.types.find((t) => t.startsWith("image/"));
          if (imageType) {
            const blob = await item.getType(imageType);
            const ext = imageType.split("/")[1]?.split("+")[0] || "png";
            const file = new File([blob], `paste.${ext}`, { type: imageType });
            const formData = new FormData();
            formData.append("files", file);
            try {
              const res = await fetch("/api/upload", { method: "POST", body: formData });
              const data = await res.json();
              if (data.paths?.length && wsRef.current?.readyState === WebSocket.OPEN) {
                const p = data.paths[0];
                xtermRef.current.paste(p.includes(" ") ? `"${p}"` : p);
              }
            } catch {
              // upload failed — silent in popout (no toast system)
            }
            handledImage = true;
            break;
          }
        }

        if (!handledImage) {
          // No image — fall back to text
          const text = await navigator.clipboard.readText();
          if (text && xtermRef.current) {
            xtermRef.current.paste(text);
          }
        }
      } catch {
        // Clipboard API unavailable or permission denied — silent in popout
      }
    };

    // Capture-phase paste listener — runs BEFORE xterm's own paste listener on
    // the textarea. stopPropagation() prevents xterm from also handling it,
    // eliminating the double-paste race. terminal.paste(text) uses xterm's own
    // bracketed-paste-mode-aware path, so onData fires exactly once with
    // correctly framed data.
    const pasteHandler = async (e) => {
      e.preventDefault();
      e.stopPropagation();

      // Image: synchronous detection from clipboardData.items
      const items = Array.from(e.clipboardData?.items || []);
      const imageItem = items.find(
        (it) => it.kind === "file" && it.type?.startsWith("image/")
      );

      if (imageItem) {
        const blob = imageItem.getAsFile();
        if (!blob) {
          return;
        }
        const ext = imageItem.type.split("/")[1]?.split("+")[0] || "png";
        const file = new File([blob], `paste.${ext}`, { type: imageItem.type });
        const formData = new FormData();
        formData.append("files", file);
        try {
          const res = await fetch("/api/upload", { method: "POST", body: formData });
          const data = await res.json();
          if (data.paths?.length && wsRef.current?.readyState === WebSocket.OPEN) {
            const p = data.paths[0];
            xtermRef.current.paste(p.includes(" ") ? `"${p}"` : p);
          }
        } catch {
          // upload failed — silent in popout (no toast system)
        }
        return;
      }

      // Text: defer to xterm's paste() which respects bracketed-paste mode.
      const text = e.clipboardData?.getData("text/plain");
      if (text && xtermRef.current) {
        xtermRef.current.paste(text);
      }
    };

    const termEl = termRef.current;
    termEl.addEventListener("paste", pasteHandler, { capture: true });

    // customKeyEventHandler — mirrors TerminalPane exactly:
    //   Ctrl+V / Ctrl+Shift+V: suppress xterm's raw \x16; the capture-phase
    //     paste listener above owns paste.
    //   Ctrl+C: copy selection if present, else send \x03 interrupt.
    //   Ctrl+Shift+C: always copy.
    //   Alt+V: intercept Claude Code's native image-paste shortcut.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;

      // Ctrl+C: copy if selection exists, otherwise let terminal send \x03
      if ((ev.ctrlKey || ev.metaKey) && ev.key === "c" && !ev.shiftKey) {
        if (term.hasSelection()) {
          navigator.clipboard.writeText(term.getSelection()).catch(() => {});
          return false; // Don't send \x03
        }
        return true; // No selection — send interrupt
      }

      // Ctrl+Shift+C: always copy (terminal convention)
      if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.key === "C") {
        if (term.hasSelection()) {
          navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        }
        return false;
      }

      // Ctrl+V / Ctrl+Shift+V: prevent xterm from sending raw \x16.
      // The actual paste is handled by the capture-phase 'paste' DOM listener.
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === "v" || ev.key === "V")) {
        return false;
      }

      // Alt+V: intercept Claude Code's native image-paste shortcut.
      if (ev.altKey && (ev.key === "v" || ev.key === "V") && !ev.ctrlKey && !ev.metaKey) {
        handleAltVPaste(); // async — fire-and-forget from sync handler
        return false;
      }

      return true; // All other keys handled normally
    });

    // -------------------------------------------------------------------------
    // Layout helpers
    // -------------------------------------------------------------------------
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
      } catch {
        // fit() can throw if terminal is disposed during resize
      }
    };

    requestAnimationFrame(() => requestAnimationFrame(() => safeFit()));

    const resizeObserver = new ResizeObserver(() => safeFit());
    resizeObserver.observe(termRef.current);

    // Terminal input -> WebSocket
    term.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(data);
      }
    });

    // -------------------------------------------------------------------------
    // WebSocket connection
    // -------------------------------------------------------------------------
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
      termEl.removeEventListener("paste", pasteHandler, { capture: true });
      clearTimeout(reconnectTimer.current);
      cancelAnimationFrame(writeRafRef.current);
      resizeObserver.disconnect();
      wsRef.current?.close();
      // Dispose CanvasAddon explicitly BEFORE term.dispose() so its internal
      // renderer-recreation runs while the linkifier is still alive. If we let
      // term.dispose() drive it, xterm tears down the linkifier MutableDisposable
      // first, leaving it undefined when CanvasAddon's dispose handler calls
      // _createRenderer() → DomRenderer constructor → linkifier.onShowLinkUnderline
      // → TypeError. Disposing here prevents that path.
      try { canvasAddonRef.current?.dispose(); } catch { /* renderer-recreation race on teardown */ }
      canvasAddonRef.current = null;
      // Safety net: even if some other xterm teardown path throws (e.g. a future
      // xterm release changes dispose order), it must NOT escape to the React
      // ErrorBoundary and blank the popout window. The terminal and WS are already
      // being torn down — swallowing teardown errors is safe here.
      try {
        term.dispose();
      } catch { /* teardown race; safe to ignore */ }
      xtermRef.current = null;
      fitRef.current = null;
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
