import { useState, useCallback, useRef } from "react";

let nextId = 1;

function createSession(name) {
  return {
    id: nextId++,
    name: name || `Session ${nextId - 1}`,
    status: "idle", // idle | running | error
    model: "sonnet",
    messages: [],
    claudeSessionId: null,
    tokens: 0,
    cost: 0,
    createdAt: Date.now(),
  };
}

/**
 * Session state management hook.
 * Handles creating, deleting, switching, and updating sessions.
 */
export function useSessions() {
  const [sessions, setSessions] = useState(() => [createSession("New session")]);
  const [activeIds, setActiveIds] = useState(() => [1]);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const addSession = useCallback((name) => {
    const session = createSession(name);
    setSessions((prev) => [...prev, session]);
    setActiveIds((prev) => {
      // Replace last pane with new session
      const next = [...prev];
      next[next.length - 1] = session.id;
      return next;
    });
    return session;
  }, []);

  const removeSession = useCallback((id) => {
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setActiveIds((prev) => {
      const next = prev.filter((x) => x !== id);
      if (next.length === 0) {
        // Must have at least one — create new
        const session = createSession("New session");
        setSessions((p) => [...p, session]);
        return [session.id];
      }
      return next;
    });
  }, []);

  const renameSession = useCallback((id, name) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, name } : s))
    );
  }, []);

  const updateSession = useCallback((id, updates) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, ...updates } : s))
    );
  }, []);

  const addMessage = useCallback((sessionId, message) => {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId
          ? { ...s, messages: [...s.messages, { ...message, ts: Date.now() }] }
          : s
      )
    );
  }, []);

  const appendToLastMessage = useCallback((sessionId, text) => {
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== sessionId) return s;
        const msgs = [...s.messages];
        if (msgs.length === 0) return s;
        const last = { ...msgs[msgs.length - 1] };
        last.text = (last.text || "") + text;
        msgs[msgs.length - 1] = last;
        return { ...s, messages: msgs };
      })
    );
  }, []);

  const selectSession = useCallback((id, paneIndex = 0) => {
    setActiveIds((prev) => {
      const next = [...prev];
      if (paneIndex < next.length) {
        next[paneIndex] = id;
      } else {
        next.push(id);
      }
      return next;
    });
  }, []);

  const getSession = useCallback((id) => {
    return sessionsRef.current.find((s) => s.id === id) || null;
  }, []);

  return {
    sessions,
    activeIds,
    setActiveIds,
    addSession,
    removeSession,
    renameSession,
    updateSession,
    addMessage,
    appendToLastMessage,
    selectSession,
    getSession,
  };
}
