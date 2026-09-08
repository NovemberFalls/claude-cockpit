import { createPortal } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { attachUpwardHistoryScroll } from "../utils/codexHistoryScroll";

import { historyCache, remember } from "../utils/codexTranscriptCache";

export default function CodexTranscript(props) {
  // A terminal rebind must not render another terminal's cached state for a frame.
  return <TranscriptReader key={props.terminalId} {...props} />;
}
function TranscriptReader({ terminalId, onClose, presentation = "dialog", statusHost }) {
  const [page, setPage] = useState(() => historyCache.get(terminalId)?.page || null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [verified, setVerified] = useState(false);
  const [deferred, setDeferred] = useState(false);
  const section = useRef(null);
  const body = useRef(null);
  const close = useRef(null);
  const request = useRef(null);
  const restore = useRef(historyCache.has(terminalId) ? { top: historyCache.get(terminalId).top } : null);
  const focused = useRef(false);
  const scrollTop = useRef(historyCache.get(terminalId)?.top || 0);
  const loadState = useRef({ page: null, busy: false });
  loadState.current = { page, busy };

  const load = useCallback(async (before = null) => {
    if (loadState.current.busy) return;
    const controller = new AbortController();
    request.current = controller;
    loadState.current.busy = true;
    setBusy(true);
    setError(null);
    setVerified(false);
    const timeout = setTimeout(() => {
      if (request.current !== controller || controller.signal.aborted) return;
      controller.abort();
      loadState.current.busy = false;
      setBusy(false);
      setError("Conversation history timed out. Try Refresh.");
    }, 10000);
    controller.signal.addEventListener("abort", () => clearTimeout(timeout), { once: true });
    try {
      const response = await fetch(`/api/terminals/${encodeURIComponent(terminalId)}/transcript?limit=50${before === null ? "" : `&before=${before}`}`, { signal: controller.signal });
      if (!response.ok) throw new Error("Conversation history could not be loaded. Try Refresh.");
      let result = await response.json();
      if (controller.signal.aborted) return;
      if (before !== null && loadState.current.page?.session_id && result.session_id !== loadState.current.page.session_id) {
        // The CLI switched conversations while an older page was requested.
        // Its old offset has no meaning in the new conversation; read latest.
        const latest = await fetch(`/api/terminals/${encodeURIComponent(terminalId)}/transcript?limit=50`, { signal: controller.signal });
        if (!latest.ok) throw new Error("Conversation history could not be loaded. Try Refresh.");
        result = await latest.json();
        before = null;
      }
      if (controller.signal.aborted) return;
      if (!Array.isArray(result.messages) || typeof result.available !== "boolean") throw new Error("Conversation history returned an unreadable response. Try Refresh.");
      const messages = result.messages.filter((message) =>
        Number.isInteger(message.index) && ["user", "assistant"].includes(message.role) && typeof message.text === "string");
      restore.current = before === null ? (loadState.current.page?.session_id === result.session_id && loadState.current.page ? { top: body.current?.scrollTop || 0 } : { bottom: true }) : { height: body.current?.scrollHeight || 0, top: body.current?.scrollTop || 0 };
      setVerified(true);
      setPage((previous) => {
        const same = previous && previous.session_id === result.session_id;
        if (!same || !result.available) return { ...result, messages };
        const combined = before === null
          ? [...previous.messages.filter((old) => !messages.some((message) => message.index === old.index)), ...messages].sort((a, b) => a.index - b.index)
          : [...messages.filter((message) => !previous.messages.some((old) => old.index === message.index)), ...previous.messages];
        return { ...result, messages: combined,
          ...(before === null && previous.messages[0]?.index < messages[0]?.index ? { before: previous.before, has_more: previous.has_more } : {}),
        };
      });
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure.message || "Conversation history could not be loaded. Try Refresh.");
    } finally {
      clearTimeout(timeout);
      if (!controller.signal.aborted) { loadState.current.busy = false; setBusy(false); }
    }
  }, [terminalId]);

  useEffect(() => {
    load();

    // The owning pane restores its own terminal focus on close. Restoring the
    // previously focused element here can redirect typing into another pane.
    return () => { request.current?.abort(); loadState.current.busy = false; remember(terminalId, loadState.current.page, scrollTop.current); };
  }, [load, presentation, terminalId]);

  useEffect(() => {
    const continuedElsewhere = (event) => {
      if (!focused.current && !section.current?.contains(event.target) && !statusHost?.contains(event.target)) setDeferred(true);
    };
    for (const name of ["keydown", "pointerdown", "focusin"]) document.addEventListener(name, continuedElsewhere, true);
    return () => {
      for (const name of ["keydown", "pointerdown", "focusin"]) document.removeEventListener(name, continuedElsewhere, true);
    };
  }, [statusHost]);

  const readable = !!page?.messages.length && !deferred;
  useEffect(() => {
    if (readable && !focused.current) {
      focused.current = true;
      (presentation === "scroll" ? body.current : close.current)?.focus({ preventScroll: true });
    }
  }, [readable, presentation]);

  useEffect(() => {
    if (presentation !== "scroll" || !body.current) return;
    const listener = attachUpwardHistoryScroll(body.current, {
      enabled: () => !loadState.current.busy && loadState.current.page?.has_more && Number.isInteger(loadState.current.page.before),
      atTop: () => body.current.scrollTop <= 1,
      onHistory: () => load(loadState.current.page.before),
    });
    return () => listener.dispose();
  }, [load, presentation, readable]);

  useLayoutEffect(() => {
    if (!body.current || !restore.current) return;
    const saved = restore.current;
    body.current.scrollTop = saved.bottom ? body.current.scrollHeight : saved.top + (saved.height === undefined ? 0 : body.current.scrollHeight - saved.height);
    scrollTop.current = body.current.scrollTop;
    restore.current = null;
  }, [page]);

  const statusPanel = (
<div data-testid="history-status-panel" style={{ pointerEvents: "auto", flexShrink: 0, background: "var(--cc-bg)", borderBottom: "1px solid var(--cc-border)" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 8, padding: readable ? 10 : 6, fontSize: readable ? undefined : 11, flexWrap: "wrap", flexShrink: 0 }}>
        <strong style={{ flex: 1 }}>Conversation history</strong>
        <button type="button" disabled={busy} onClick={() => load()}>Refresh</button>
        <button ref={close} type="button" onClick={onClose} aria-label={presentation === "scroll" ? "Back to live terminal" : "Close conversation history"}>{presentation === "scroll" ? "Back to live terminal" : "Close"}</button>
      </header>
      {readable && <p style={{ margin: "0 10px 8px", fontSize: 11, color: "var(--cc-dim)" }}>Saved user and assistant messages. Terminal redraws do not remove these messages.</p>}
      <div data-testid="history-load-status" style={{ height: readable ? 64 : "auto", maxHeight: readable ? undefined : 80, overflowY: "auto", padding: "0 10px", fontSize: 12 }}>
      {error && <div role="alert" style={{ padding: 10 }}>{error}</div>}
      {page?.binding_status === "last_known" && <p role="status" style={{ margin: "0 10px 8px", fontSize: 11 }}>Showing the last identified conversation. The current CLI conversation could not be verified yet. Try Refresh.</p>}
      {!readable && busy && <p role="status">Loading saved history; live terminal remains available.</p>}
      {!readable && page?.available === false && <p>Saved conversation history is not available for this session yet. Refresh after Codex records a message.</p>}
      {!page?.messages.length && page?.available === true && <p>No saved user or assistant messages yet.</p>}
      {!deferred && page?.messages.length > 0 && !verified && <p role="status">Showing previously saved messages; the current conversation has not been verified.</p>}
      {deferred && page?.messages.length > 0 && <button type="button" onClick={() => setDeferred(false)}>Show saved messages</button>}
      </div>
      </div>
  );

  return (
    <section ref={section} role={presentation === "scroll" ? "region" : "dialog"} aria-label="Conversation history" onKeyDown={(event) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
      if (presentation === "scroll" && ["PageDown", "End"].includes(event.key) && event.target === body.current && body.current.scrollTop + body.current.clientHeight >= body.current.scrollHeight - 1) {
        event.preventDefault(); event.stopPropagation(); onClose();
      }
    }} style={{ position: "absolute", inset: 0, zIndex: 30, display: "flex", flexDirection: "column", background: readable ? "var(--cc-bg)" : "transparent", pointerEvents: readable ? "auto" : "none", color: "var(--cc-fg)", border: readable ? "1px solid var(--cc-border)" : "none" }}>
      {!readable && statusHost ? createPortal(statusPanel, statusHost) : statusPanel}
      <div ref={body} tabIndex={0} aria-label="Saved conversation messages" data-testid="transcript-scroll" onScroll={(event) => { scrollTop.current = event.currentTarget.scrollTop; }} onWheel={(event) => {
        if (presentation === "scroll" && event.deltaY > 0 && !event.ctrlKey && !event.metaKey && event.currentTarget.scrollTop + event.currentTarget.clientHeight >= event.currentTarget.scrollHeight - 1) {
          event.preventDefault(); event.stopPropagation(); onClose();
        }
      }} style={{ display: readable ? "block" : "none", flex: 1, minHeight: 0, overflowY: "auto", padding: 12 }}>
        {page?.has_more && Number.isInteger(page.before) && <button type="button" disabled={busy} onClick={() => load(page.before)}>Load older</button>}


        {page?.messages.map((message) => <article key={message.index} style={{ margin: "12px 0 20px" }}>
          <div style={{ fontSize: 11, color: "var(--cc-dim)", marginBottom: 5 }}>
            <strong>{message.role === "user" ? "You" : "Codex"}</strong>{message.timestamp && <span> · {message.timestamp}</span>}
          </div>
          <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 13, lineHeight: 1.6 }}>{message.text}</div>
        </article>)}
      </div>
    </section>
  );
}
