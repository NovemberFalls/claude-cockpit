import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { attachUpwardHistoryScroll } from "../utils/codexHistoryScroll";

export default function CodexTranscript({ terminalId, onClose, presentation = "dialog" }) {
  const [page, setPage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const body = useRef(null);
  const close = useRef(null);
  const request = useRef(null);
  const restore = useRef(null);
  const loadState = useRef({ page: null, busy: false });
  loadState.current = { page, busy };

  const load = useCallback(async (before = null) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    loadState.current.busy = true;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/terminals/${encodeURIComponent(terminalId)}/transcript?limit=50${before === null ? "" : `&before=${before}`}`, { signal: controller.signal });
      if (!response.ok) throw new Error("Conversation history could not be loaded. Try Refresh.");
      let result = await response.json();
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
      restore.current = before === null ? { bottom: true } : { height: body.current.scrollHeight, top: body.current.scrollTop };
      setPage((previous) => ({ ...result, messages: before === null || previous?.session_id !== result.session_id ? messages : [
        ...messages.filter((message) => !previous?.messages.some((old) => old.index === message.index)),
        ...(previous?.messages || []),
      ] }));
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure.message || "Conversation history could not be loaded. Try Refresh.");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }, [terminalId]);

  useEffect(() => {
    load();
    (presentation === "scroll" ? body.current : close.current)?.focus();
    // The owning pane restores its own terminal focus on close. Restoring the
    // previously focused element here can redirect typing into another pane.
    return () => { request.current?.abort(); };
  }, [load, presentation]);

  useEffect(() => {
    if (presentation !== "scroll" || !body.current) return;
    const listener = attachUpwardHistoryScroll(body.current, {
      enabled: () => !loadState.current.busy && loadState.current.page?.has_more && Number.isInteger(loadState.current.page.before),
      atTop: () => body.current.scrollTop <= 1,
      onHistory: () => load(loadState.current.page.before),
    });
    return () => listener.dispose();
  }, [load, presentation]);

  useLayoutEffect(() => {
    if (!body.current || !restore.current) return;
    const saved = restore.current;
    body.current.scrollTop = saved.bottom ? body.current.scrollHeight : saved.top + body.current.scrollHeight - saved.height;
    restore.current = null;
  }, [page]);

  return (
    <section role={presentation === "scroll" ? "region" : "dialog"} aria-label="Conversation history" onKeyDown={(event) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
      if (presentation === "scroll" && ["PageDown", "End"].includes(event.key) && event.target === body.current && body.current.scrollTop + body.current.clientHeight >= body.current.scrollHeight - 1) {
        event.preventDefault(); event.stopPropagation(); onClose();
      }
    }} style={{ position: "absolute", inset: 0, zIndex: 30, display: "flex", flexDirection: "column", background: "var(--cc-bg)", color: "var(--cc-fg)", border: "1px solid var(--cc-border)" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12, padding: 10, flexShrink: 0 }}>
        <strong style={{ flex: 1 }}>Conversation history</strong>
        <button type="button" disabled={busy} onClick={() => load()}>Refresh</button>
        <button ref={close} type="button" onClick={onClose} aria-label={presentation === "scroll" ? "Back to live terminal" : "Close conversation history"}>{presentation === "scroll" ? "Back to live terminal" : "Close"}</button>
      </header>
      <p style={{ margin: "0 10px 8px", fontSize: 11, color: "var(--cc-dim)" }}>Saved user and assistant messages. Terminal redraws do not remove these messages.</p>
      {error && <div role="alert" style={{ padding: 10 }}>{error}</div>}
      {page?.binding_status === "last_known" && <p role="status" style={{ margin: "0 10px 8px", fontSize: 11 }}>Showing the last identified conversation. The current CLI conversation could not be verified yet. Try Refresh.</p>}
      <div ref={body} tabIndex={0} aria-label="Saved conversation messages" data-testid="transcript-scroll" onWheel={(event) => {
        if (presentation === "scroll" && event.deltaY > 0 && !event.ctrlKey && !event.metaKey && event.currentTarget.scrollTop + event.currentTarget.clientHeight >= event.currentTarget.scrollHeight - 1) {
          event.preventDefault(); event.stopPropagation(); onClose();
        }
      }} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 12 }}>
        {page?.has_more && Number.isInteger(page.before) && <button type="button" disabled={busy} onClick={() => load(page.before)}>Load older</button>}
        {busy && <p role="status">Loading conversation history…</p>}
        {page?.available === false && <p>Saved conversation history is not available for this session yet. Refresh after Codex records a message.</p>}
        {page?.available === true && !page.messages.length && <p>No saved user or assistant messages yet.</p>}
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
