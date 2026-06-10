import { useEffect, useRef, useCallback, useState, forwardRef, useImperativeHandle } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { CanvasAddon } from "@xterm/addon-canvas";
import { SearchAddon } from "@xterm/addon-search";
import { X, GripVertical, GitFork, Search, Link2, ExternalLink, Workflow } from "lucide-react";
import { useTheme } from "../hooks/useTheme";
import StateIcon from "./StateIcon";
import WorkflowsPanel from "./WorkflowsPanel";
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

const TerminalPane = forwardRef(function TerminalPane({
  session,       // { id, name, terminalId, model, status, activityState }
  onClose,       // () => void
  paneIndex,     // number — position in the grid
  onSwap,        // (fromIndex, toIndex) => void
  onDragSourceChange, // (paneIndex | null) => void — notify parent of drag start/end
  terminalZoom = 13, // terminal font size (zoom level)
  toast,           // (msg, type) => void — optional toast notification
  onFork,          // () => void — fork session (new session, same workdir)
  onOpenBridge,    // () => void — open the bridge modal pre-selected to this pane
  activeBridge,    // null | { bridge_id, from_name, to_name, turns_used, max_turns } — active bridge involving this pane
  onEndBridge,     // (bridgeId: string) => void — terminate an active bridge
  onPopout,        // (session) => void — open terminal in separate window
  workflowSummary, // { count: number, inProgressCount: number, items: array } | null — recent workflows
}, ref) {
  const termRef = useRef(null);       // DOM ref
  const xtermRef = useRef(null);      // Terminal instance
  const fitRef = useRef(null);        // FitAddon instance
  const canvasAddonRef = useRef(null); // CanvasAddon instance (for explicit pre-dispose)
  const wsRef = useRef(null);         // WebSocket
  const resizeObserver = useRef(null);
  const resizeTimer = useRef(null);
  const reconnectTimer = useRef(null);
  const reconnectAttempts = useRef(0);
  const pendingDataRef = useRef("");  // Batched WS data for xterm
  const writeRafRef = useRef(null);   // rAF handle for batched writes
  const searchRef = useRef(null);       // SearchAddon instance
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [workflowsOpen, setWorkflowsOpen] = useState(false);
  const searchInputRef = useRef(null);
  const { theme } = useTheme();

  // Expose focus() to parent via ref
  useImperativeHandle(ref, () => ({
    focus: () => xtermRef.current?.focus(),
  }));

  const searchNext = useCallback(() => {
    if (searchRef.current && searchQuery) {
      searchRef.current.findNext(searchQuery, { regex: false, caseSensitive: false });
    }
  }, [searchQuery]);

  const searchPrev = useCallback(() => {
    if (searchRef.current && searchQuery) {
      searchRef.current.findPrevious(searchQuery, { regex: false, caseSensitive: false });
    }
  }, [searchQuery]);

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

  // Ref so connectWs can schedule itself recursively without a stale closure.
  // The ref is assigned immediately after the useCallback declaration below.
  const connectWsRef = useRef(null);

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
      // Use the ref to avoid a stale closure on connectWs itself
      reconnectTimer.current = setTimeout(() => connectWsRef.current?.(terminalId), delay);
    };

    ws.onerror = () => {
      // onclose will handle reconnection
    };
  }, [safeFit]);

  // Keep ref in sync so the recursive setTimeout always calls the latest version
  connectWsRef.current = connectWs;

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
    const webLinksAddon = new WebLinksAddon((_event, uri) => {
      fetch("/api/open-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: uri }),
      }).catch(() => window.open(uri, "_blank"));
    });

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

    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    searchRef.current = searchAddon;

    xtermRef.current = term;
    fitRef.current = fitAddon;

    // Capture-phase paste handler — runs BEFORE xterm's own paste listener on
    // the textarea. stopPropagation() prevents xterm from also handling it,
    // eliminating the double-paste race. terminal.paste(text) uses xterm's
    // own bracketed-paste-mode-aware path, so onData fires exactly once with
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
          toast?.("Image paste failed: empty blob", "error");
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
            toast?.("Image pasted", "success");
          } else if (data.errors?.length) {
            toast?.(`Image paste failed: ${data.errors[0]}`, "error");
          }
        } catch (err) {
          toast?.(`Image paste failed: ${err.message}`, "error");
        }
        return;
      }

      // Text: defer to xterm's paste() which respects bracketed-paste mode.
      // This fires onData exactly once with the wrapped text, which then
      // gets sent through the existing wsRef.current.send path.
      const text = e.clipboardData?.getData("text/plain");
      if (text && xtermRef.current) {
        xtermRef.current.paste(text);
      }
    };
    const termEl = termRef.current;
    termEl.addEventListener("paste", pasteHandler, { capture: true });

    // Alt+V paste handler — mirrors the Ctrl+V paste handler above but reads from
    // navigator.clipboard.read() since there is no DOM paste event for Alt+V.
    // Claude Code uses Alt+V as its native image-paste shortcut; ConPTY cannot
    // access the system clipboard, so we must intercept here and upload the image
    // before injecting the path into the PTY.
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
                toast?.("Image pasted", "success");
              } else if (data.errors?.length) {
                toast?.(`Image paste failed: ${data.errors[0]}`, "error");
              }
            } catch (err) {
              toast?.(`Image paste failed: ${err.message}`, "error");
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
      } catch (err) {
        // Clipboard API unavailable or permission denied — log silently
        toast?.(`Paste failed: ${err.message}`, "error");
      }
    };

    // Fit once mounted (double-rAF to ensure layout is settled)
    requestAnimationFrame(() => requestAnimationFrame(() => safeFit()));

    // Ctrl+C / Ctrl+V handling: copy when text is selected, interrupt only when not.
    // Prevents accidental SIGINT when the user just wants to copy, and avoids
    // session lockups caused by sending \x03 to an unresponsive process.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;

      // Ctrl+Shift+F: toggle terminal search
      if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.key === "F") {
        setSearchVisible((v) => {
          if (!v) setTimeout(() => searchInputRef.current?.focus(), 0);
          else searchRef.current?.clearDecorations();
          return !v;
        });
        return false;
      }

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

      // Ctrl+V / Ctrl+Shift+V: prevent xterm from sending raw \x16. The actual
      // paste is handled by a capture-phase 'paste' DOM listener on termRef
      // (registered earlier in this effect) — that gives us synchronous access
      // to clipboardData, blocks xterm's own paste listener via stopPropagation,
      // and uses xterm.paste() for correct bracketed-paste-mode handling.
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === "v" || ev.key === "V")) {
        return false;
      }

      // Alt+V: intercept Claude Code's native image-paste shortcut. The PTY
      // process cannot access the system clipboard, so we read it here via the
      // Clipboard API and upload any image to the backend before injecting the
      // path — matching exactly what the Ctrl+V capture-phase handler does.
      if (ev.altKey && (ev.key === "v" || ev.key === "V") && !ev.ctrlKey && !ev.metaKey) {
        handleAltVPaste(); // async — fire-and-forget from sync handler
        return false;
      }

      return true; // All other keys handled normally
    });

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
      termEl.removeEventListener("paste", pasteHandler, { capture: true });
      clearTimeout(resizeTimer.current);
      clearTimeout(reconnectTimer.current);
      cancelAnimationFrame(writeRafRef.current);
      resizeObserver.current?.disconnect();
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
      // ErrorBoundary and blank the main window. The terminal and WS are already
      // being torn down — swallowing teardown errors is safe here.
      try {
        term.dispose();
      } catch { /* teardown race; safe to ignore */ }
      xtermRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
      pendingDataRef.current = "";
      writeRafRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: this effect runs once on mount only; theme/zoom/session changes are handled by dedicated effects below
  }, []); // Only run once on mount

  // Update theme when it changes — Canvas re-rasterizes automatically.
  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.theme = buildXtermTheme(theme);
    }
  }, [theme]);

  // Update font size when zoom changes — Canvas re-rasterizes automatically.
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

  // File drop handler — only intercept actual file drops; let pane-swap drags bubble
  const handleDrop = useCallback(async (e) => {
    const files = Array.from(e.dataTransfer?.files || []);
    if (!files.length) return; // Not a file drop — let it propagate for pane reordering

    e.preventDefault();
    e.stopPropagation();

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
        xtermRef.current.paste(pathStr);
        toast?.(`Dropped ${data.paths.length} file${data.paths.length > 1 ? "s" : ""}`, "success");
      } else if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        toast?.("Session not connected — cannot drop files", "error");
      }
    } catch (err) {
      toast?.(`Upload failed: ${err.message}`, "error");
    }
  }, [toast]);

  const handleDragOver = useCallback((e) => {
    // Only intercept file drags — pane-swap drags must bubble to the parent wrapper
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const activityState = session.activityState || (session.status === "running" ? "idle" : session.status);
  const isBridged = !!activeBridge;
  const isWaiting = activityState === "waiting";
  const wrapperStyle = {
    boxShadow: isBridged
      ? "inset 0 0 0 2px #ff0033, 0 0 18px rgba(255, 0, 51, 0.55)"
      : isWaiting
        ? "inset 0 0 0 1px var(--yellow), 0 0 15px rgba(234, 179, 8, 0.3)"
        : "none",
    animation: isBridged
      ? "bridge-active-glow 2s ease-in-out infinite"
      : isWaiting
        ? "attention-glow 2s ease-in-out infinite"
        : "none",
    transition: "box-shadow 0.3s ease",
  };

  return (
    <div
      className="flex flex-col h-full min-w-0"
      style={wrapperStyle}
    >
      {/* Pane header */}
      <div
        className="flex items-center justify-between px-3 h-9 flex-shrink-0"
        style={{
          borderBottom: "1px solid var(--border-color)",
          cursor: onSwap ? "grab" : "default",
        }}
        draggable={onSwap != null}
        onDragStart={(e) => {
          if (paneIndex == null) return;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", `pane:${paneIndex}`);
          // Use a minimal drag image so the browser ghost doesn't obscure the drop overlay
          const ghost = document.createElement("div");
          ghost.textContent = session.name;
          ghost.style.cssText = `
            position: fixed; top: -100px;
            padding: 4px 12px; border-radius: 6px; font-size: 11px; font-weight: 600;
            background: var(--bg-elevated); color: var(--accent);
            border: 1px solid var(--accent); white-space: nowrap;
          `;
          document.body.appendChild(ghost);
          e.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, ghost.offsetHeight / 2);
          requestAnimationFrame(() => document.body.removeChild(ghost));
          onDragSourceChange?.(paneIndex);
        }}
        onDragEnd={() => {
          onDragSourceChange?.(null);
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
          {onPopout && (
            <button
              type="button"
              onClick={() => onPopout(session)}
              className="icon-tooltip p-0.5 rounded transition-colors hover-bg-elevated hover-color-secondary"
              style={{ color: "var(--text-muted)" }}
              data-tooltip="Pop out"
              aria-label="Open terminal in separate window"
            >
              <ExternalLink size={13} />
            </button>
          )}
          {onFork && (
            <button
              type="button"
              onClick={onFork}
              className="icon-tooltip p-0.5 rounded transition-colors hover-bg-elevated hover-color-secondary"
              style={{ color: "var(--text-muted)" }}
              data-tooltip="Fork"
              aria-label="Fork session (new session, same workdir)"
            >
              <GitFork size={13} />
            </button>
          )}
          {workflowSummary && workflowSummary.count > 0 && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setWorkflowsOpen((o) => !o)}
                className="icon-tooltip p-0.5 rounded transition-colors hover-bg-elevated hover-color-secondary"
                style={{ color: "var(--text-muted)", position: "relative" }}
                data-tooltip="Workflows"
                aria-label={
                  workflowSummary.inProgressCount > 0
                    ? `${workflowSummary.inProgressCount} workflow(s) in progress`
                    : `${workflowSummary.count} recent workflow(s)`
                }
                title={
                  workflowSummary.inProgressCount > 0
                    ? `${workflowSummary.inProgressCount} workflow(s) in progress`
                    : `${workflowSummary.count} recent workflow(s)`
                }
              >
                <Workflow size={13} />
                {workflowSummary.inProgressCount > 0 && (
                  <span
                    style={{
                      position: "absolute",
                      top: -2,
                      right: -2,
                      minWidth: 10,
                      height: 10,
                      borderRadius: "50%",
                      backgroundColor: "var(--accent)",
                      fontSize: 8,
                      fontWeight: 700,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "var(--bg-base)",
                      lineHeight: 1,
                      pointerEvents: "none",
                    }}
                    aria-hidden="true"
                  >
                    {workflowSummary.inProgressCount}
                  </span>
                )}
              </button>
              {workflowsOpen && (
                <WorkflowsPanel
                  workflows={workflowSummary?.items || []}
                  onClose={() => setWorkflowsOpen(false)}
                />
              )}
            </div>
          )}
          {onOpenBridge && (
            <button
              type="button"
              onClick={onOpenBridge}
              className="icon-tooltip p-0.5 rounded transition-colors hover-bg-elevated hover-color-secondary"
              style={{ color: "var(--text-muted)" }}
              data-tooltip="Bridge"
              aria-label="Bridge to another session"
            >
              <Link2 size={13} />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="icon-tooltip p-0.5 rounded transition-colors hover-bg-elevated hover-color-red"
            style={{ color: "var(--text-muted)" }}
            data-tooltip="Close"
            aria-label="Close session"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Context gauge — shown only when context_percent is known */}
      {session.context_percent != null && (
        <div style={{ height: 2, backgroundColor: "var(--bg-elevated)", flexShrink: 0 }}>
          <div style={{
            height: "100%",
            width: `${session.context_percent}%`,
            backgroundColor: session.context_percent > 75
              ? "var(--red)"
              : session.context_percent > 50
                ? "var(--yellow)"
                : "var(--green)",
            transition: "width 0.5s ease, background-color 0.3s ease",
          }} />
        </div>
      )}

      {/* Search bar */}
      {searchVisible && (
        <div
          className="flex items-center gap-1 px-2 h-8 flex-shrink-0"
          style={{
            borderBottom: "1px solid var(--border-color)",
            backgroundColor: "var(--bg-surface)",
          }}
        >
          <Search size={12} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
          <input
            ref={searchInputRef}
            className="flex-1 text-xs px-1.5 py-0.5 rounded"
            style={{
              backgroundColor: "var(--bg-elevated)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-color)",
              outline: "none",
              minWidth: 0,
            }}
            placeholder="Search terminal..."
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              if (e.target.value) {
                searchRef.current?.findNext(e.target.value, { regex: false, caseSensitive: false });
              } else {
                searchRef.current?.clearDecorations();
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (e.shiftKey) searchPrev();
                else searchNext();
              }
              if (e.key === "Escape") {
                setSearchVisible(false);
                setSearchQuery("");
                searchRef.current?.clearDecorations();
                xtermRef.current?.focus();
              }
            }}
          />
          <button
            onClick={searchPrev}
            className="text-[10px] px-1.5 py-0.5 rounded hover-bg-elevated"
            style={{ color: "var(--text-muted)" }}
            title="Previous (Shift+Enter)"
          >
            ↑
          </button>
          <button
            onClick={searchNext}
            className="text-[10px] px-1.5 py-0.5 rounded hover-bg-elevated"
            style={{ color: "var(--text-muted)" }}
            title="Next (Enter)"
          >
            ↓
          </button>
          <button
            onClick={() => {
              setSearchVisible(false);
              setSearchQuery("");
              searchRef.current?.clearDecorations();
              xtermRef.current?.focus();
            }}
            className="text-[10px] px-1 py-0.5 rounded hover-bg-elevated"
            style={{ color: "var(--text-muted)" }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Terminal area */}
      <div
        className="flex-1 min-h-0"
        style={{ position: "relative" }}
      >
        <div
          ref={termRef}
          className="w-full h-full"
          style={{
            padding: "4px 8px",
            backgroundColor: theme.bg,
          }}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
        />
        {activeBridge && (
          <div
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              zIndex: 30,
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 10px",
              borderRadius: 6,
              backgroundColor: "rgba(255, 0, 51, 0.15)",
              border: "1px solid #ff5577",
              backdropFilter: "blur(4px)",
              fontSize: 11,
              fontWeight: 600,
              color: "#ff5577",
              pointerEvents: "auto",
            }}
          >
            <span>BRIDGE · turn {activeBridge.turns_used}/{activeBridge.max_turns}</span>
            <button
              type="button"
              onClick={() => onEndBridge?.(activeBridge.bridge_id)}
              className="px-2 py-0.5 rounded"
              style={{
                background: "#ff0033",
                color: "#fff",
                border: "none",
                fontSize: 10,
                fontWeight: 700,
                cursor: "pointer",
              }}
              title="End the bridge immediately"
              aria-label="End bridge"
            >
              Stop
            </button>
          </div>
        )}
      </div>
    </div>
  );
});

export default TerminalPane;
