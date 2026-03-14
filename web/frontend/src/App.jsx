import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import HexGrid from "./components/HexGrid";
import TopBar from "./components/TopBar";
import Sidebar from "./components/Sidebar";
import TerminalPane from "./components/TerminalPane";
import StatusBar from "./components/StatusBar";
import NewSessionDialog from "./components/NewSessionDialog";

const LOCATIONS_KEY = "cockpit-locations";
const RECENTS_KEY = "cockpit-recent-locations";
const SESSIONS_KEY = "cockpit-sessions";

function loadSavedLocations() {
  try {
    return JSON.parse(localStorage.getItem(LOCATIONS_KEY) || "[]");
  } catch { return []; }
}

function saveSavedLocations(locs) {
  try { localStorage.setItem(LOCATIONS_KEY, JSON.stringify(locs)); } catch {}
}

function loadRecentLocations() {
  try {
    return JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]");
  } catch { return []; }
}

function saveRecentLocations(locs) {
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(locs)); } catch {}
}

function loadSavedSessions() {
  try {
    return JSON.parse(localStorage.getItem(SESSIONS_KEY) || "[]");
  } catch { return []; }
}

function saveSessions(sessions) {
  try {
    // Only persist recoverable sessions (not errors)
    const toSave = sessions
      .filter((s) => s.status !== "error")
      .map(({ name, model, workdir }) => ({ name, model, workdir }));
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(toSave));
  } catch {}
}

let nextLocalId = 1;

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(224);
  const [model, setModel] = useState("sonnet");
  const [layout, setLayout] = useState(1);
  const [user, setUser] = useState(null);
  const [backendReady, setBackendReady] = useState(false);
  const [backendError, setBackendError] = useState(false);

  // Sessions: { id (local), name, terminalId (backend), model, status, workdir }
  const [sessions, setSessions] = useState([]);
  const [activeIds, setActiveIds] = useState([]);
  const [savedLocations, setSavedLocations] = useState(loadSavedLocations);
  const [recentLocations, setRecentLocations] = useState(loadRecentLocations);
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [gitStatuses, setGitStatuses] = useState({});
  const [broadcastMode, setBroadcastMode] = useState(false);
  const [broadcastText, setBroadcastText] = useState("");
  const paneRefs = useRef([]);
  const prevStatesRef = useRef({});

  // Health-check polling: wait for backend to be ready
  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    const maxAttempts = 30; // 15s at 500ms intervals

    const check = async () => {
      while (!cancelled && attempts < maxAttempts) {
        try {
          const res = await fetch("/api/me");
          if (res.ok) {
            const data = await res.json();
            if (!cancelled) {
              setBackendReady(true);
              if (data.authenticated) setUser(data);
            }
            return;
          }
        } catch {
          // Backend not up yet
        }
        attempts++;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!cancelled) setBackendError(true);
    };

    check();
    return () => { cancelled = true; };
  }, []);

  // Add locations to the curated list (deduped, no cap)
  const addLocations = useCallback((dirs) => {
    setSavedLocations((prev) => {
      const set = new Set(prev);
      dirs.forEach((d) => { if (d) set.add(d); });
      const next = [...set];
      saveSavedLocations(next);
      return next;
    });
  }, []);

  // Remove a single location from the curated list
  const removeLocation = useCallback((dir) => {
    setSavedLocations((prev) => {
      const next = prev.filter((l) => l !== dir);
      saveSavedLocations(next);
      return next;
    });
  }, []);

  // Create a new terminal session
  // options: { continueSession?: boolean }
  const createSession = useCallback(async (name, workdir, sessionModel, options = {}) => {
    const localId = nextLocalId++;
    const sessionName = name || `Session ${localId}`;
    const dir = workdir || "C:\\Code";
    const useModel = sessionModel || model;

    // Ensure the workdir is in the curated locations list
    addLocations([dir]);

    // Track as recent location (most recent first, capped at 5)
    setRecentLocations((prev) => {
      const next = [dir, ...prev.filter((l) => l !== dir)].slice(0, 5);
      saveRecentLocations(next);
      return next;
    });

    // Optimistic local state
    const newSession = {
      id: localId,
      name: sessionName,
      terminalId: null,
      model: useModel,
      status: "starting",
      workdir: dir,
    };
    setSessions((prev) => [...prev, newSession]);
    setActiveIds((prev) => {
      const next = [...prev];
      if (next.length >= layout) {
        next[next.length - 1] = localId;
      } else {
        next.push(localId);
      }
      return next;
    });

    // Spawn PTY on backend
    try {
      const res = await fetch("/api/terminals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: sessionName,
          model: useModel,
          workdir: dir,
          cols: 120,
          rows: 30,
          ...(options.continueSession ? { continue: true } : {}),
        }),
      });
      const data = await res.json();

      if (data.error) {
        setSessions((prev) =>
          prev.map((s) =>
            s.id === localId ? { ...s, status: "error" } : s
          )
        );
        return;
      }

      // Update with real terminal ID
      setSessions((prev) =>
        prev.map((s) =>
          s.id === localId
            ? { ...s, terminalId: data.id, status: "running" }
            : s
        )
      );
    } catch (err) {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === localId ? { ...s, status: "error" } : s
        )
      );
    }
  }, [model, layout, addLocations]);

  // Remove a session
  const removeSession = useCallback(async (localId) => {
    const session = sessions.find((s) => s.id === localId);
    if (session?.terminalId) {
      // Kill on backend
      fetch(`/api/terminals/${session.terminalId}`, { method: "DELETE" }).catch(() => {});
    }

    setSessions((prev) => prev.filter((s) => s.id !== localId));
    setActiveIds((prev) => prev.filter((id) => id !== localId));
  }, [sessions]);

  // Select a session into the first pane
  const selectSession = useCallback((id) => {
    setActiveIds((prev) => {
      if (prev.includes(id)) return prev;
      const next = [...prev];
      next[0] = id;
      return next;
    });
  }, []);

  // Persist sessions to localStorage whenever they change
  useEffect(() => {
    if (sessions.length > 0) saveSessions(sessions);
  }, [sessions]);

  // Restore saved sessions once backend is ready (one-time)
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!backendReady || restoredRef.current) return;
    restoredRef.current = true;
    const saved = loadSavedSessions();
    for (const s of saved) {
      createSession(s.name, s.workdir, s.model, { continueSession: true });
    }
  }, [backendReady, createSession]);

  // Request notification permission once first session is created
  const notifRequested = useRef(false);
  useEffect(() => {
    if (sessions.length > 0 && !notifRequested.current && "Notification" in window) {
      notifRequested.current = true;
      if (Notification.permission === "default") {
        Notification.requestPermission();
      }
    }
  }, [sessions.length]);

  // Poll /api/terminals every 2s for activity state, tokens, cost
  useEffect(() => {
    if (!backendReady) return;
    const poll = async () => {
      try {
        const res = await fetch("/api/terminals");
        if (!res.ok) return;
        const data = await res.json();
        const termMap = {};
        for (const t of data.terminals) {
          termMap[t.id] = t;
        }

        setSessions((prev) => {
          const updated = prev.map((s) => {
            if (!s.terminalId || !termMap[s.terminalId]) return s;
            const t = termMap[s.terminalId];
            return {
              ...s,
              activityState: t.activity_state,
              tokens: t.tokens || 0,
              cost: t.cost || 0,
            };
          });

          // Desktop notifications on state transitions
          if ("Notification" in window && Notification.permission === "granted" && !document.hasFocus()) {
            for (const s of updated) {
              if (!s.terminalId) continue;
              const prevState = prevStatesRef.current[s.terminalId];
              const curr = s.activityState;
              if (prevState && curr) {
                if (curr === "waiting" && prevState !== "waiting") {
                  new Notification("Action Required", {
                    body: `${s.name} is waiting for approval`,
                    tag: `cockpit-${s.terminalId}`,
                  });
                } else if (curr === "idle" && prevState === "busy") {
                  new Notification("Task Complete", {
                    body: `${s.name} has finished`,
                    tag: `cockpit-${s.terminalId}`,
                  });
                }
              }
              prevStatesRef.current[s.terminalId] = curr;
            }
          }

          return updated;
        });
      } catch {
        // ignore poll errors
      }
    };
    const id = setInterval(poll, 2000);
    poll();
    return () => clearInterval(id);
  }, [backendReady]);

  // Poll git status every 30s for all unique workdirs
  useEffect(() => {
    if (!backendReady) return;
    const fetchGit = async () => {
      const dirs = new Set([
        ...sessions.map((s) => s.workdir).filter(Boolean),
        ...savedLocations,
      ]);
      const results = {};
      for (const dir of dirs) {
        try {
          const res = await fetch(`/api/git/status?path=${encodeURIComponent(dir)}`);
          if (res.ok) {
            const data = await res.json();
            const normPath = dir.replace(/\//g, "\\").replace(/\\$/, "");
            results[normPath] = data;
          }
        } catch { /* skip */ }
      }
      setGitStatuses(results);
    };
    fetchGit();
    const id = setInterval(fetchGit, 30000);
    return () => clearInterval(id);
  }, [backendReady, sessions, savedLocations]);

  // Aggregate tokens/cost across all sessions
  const totalTokens = useMemo(
    () => sessions.reduce((sum, s) => sum + (s.tokens || 0), 0),
    [sessions]
  );
  const totalCost = useMemo(
    () => sessions.reduce((sum, s) => sum + (s.cost || 0), 0),
    [sessions]
  );

  // Visible sessions for panes (must be above hooks that reference it)
  const visibleSessions = useMemo(() => {
    const visible = activeIds
      .slice(0, layout)
      .map((id) => sessions.find((s) => s.id === id))
      .filter(Boolean);

    while (visible.length < layout && visible.length < sessions.length) {
      const next = sessions.find((s) => !visible.includes(s));
      if (next) visible.push(next);
      else break;
    }
    return visible;
  }, [activeIds, layout, sessions]);

  // Broadcast: send text to all visible running terminals
  const sendBroadcast = useCallback(async (text) => {
    const targets = visibleSessions.filter((s) => s.status === "running" && s.terminalId);
    await Promise.all(
      targets.map((s) =>
        fetch(`/api/terminals/${s.terminalId}/input`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: text + "\n" }),
        }).catch(() => {})
      )
    );
  }, [visibleSessions]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      // Only intercept if not focused in terminal (let terminal handle most keys)
      if (e.ctrlKey && e.shiftKey && e.key === "N") {
        e.preventDefault();
        setShowNewDialog(true);
      }
      if (e.ctrlKey && e.shiftKey && e.key === "B") {
        e.preventDefault();
        setSidebarOpen((p) => !p);
      }
      if (e.ctrlKey && e.shiftKey && e.key === "!") {
        e.preventDefault();
        setLayout(1);
      }
      if (e.ctrlKey && e.shiftKey && e.key === "@") {
        e.preventDefault();
        setLayout(2);
      }
      if (e.ctrlKey && e.shiftKey && e.key === "$") {
        e.preventDefault();
        setLayout(4);
      }
      // Quick-switch: Ctrl+1 through Ctrl+4 to focus panes
      if (e.ctrlKey && !e.shiftKey && e.key >= "1" && e.key <= "4") {
        const i = parseInt(e.key) - 1;
        if (i < visibleSessions.length) {
          e.preventDefault();
          paneRefs.current[i]?.focus();
        }
      }
      // Broadcast mode toggle: Ctrl+Shift+Enter
      if (e.ctrlKey && e.shiftKey && e.key === "Enter") {
        e.preventDefault();
        setBroadcastMode((p) => !p);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [createSession, visibleSessions]);

  // Swap two panes by index
  const swapPanes = useCallback((fromIdx, toIdx) => {
    setActiveIds((prev) => {
      const next = [...prev];
      const tmp = next[fromIdx];
      next[fromIdx] = next[toIdx];
      next[toIdx] = tmp;
      return next;
    });
  }, []);

  // Sidebar resize
  const startSidebarResize = useCallback((e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    const onMove = (ev) => {
      const newW = Math.min(Math.max(startW + ev.clientX - startX, 140), 500);
      setSidebarWidth(newW);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [sidebarWidth]);

  // Grid layout
  const gridTemplate = layout === 1 ? "1fr" : "1fr 1fr";
  const gridRows = layout === 4 ? "1fr 1fr" : "1fr";

  // Splash screen while waiting for backend
  if (!backendReady) {
    return (
      <div className="flex flex-col h-screen w-screen overflow-hidden relative">
        <HexGrid />
        <div className="relative z-10 flex items-center justify-center h-full">
          <div className="text-center" style={{ color: "var(--text-secondary)" }}>
            {backendError ? (
              <>
                <p className="text-lg mb-4" style={{ color: "var(--text-primary)" }}>
                  Failed to connect to backend server
                </p>
                <button
                  onClick={() => {
                    setBackendError(false);
                    setBackendReady(false);
                    // Re-trigger the health check by forcing remount
                    window.location.reload();
                  }}
                  className="px-4 py-2 rounded-md text-sm"
                  style={{
                    border: "1px solid var(--border-color)",
                    color: "var(--text-primary)",
                  }}
                >
                  Retry
                </button>
              </>
            ) : (
              <>
                <p className="text-lg mb-2" style={{ color: "var(--text-primary)" }}>
                  Starting backend server...
                </p>
                <p className="text-sm">Waiting for connection</p>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden relative">
      <HexGrid />

      <div className="relative z-10 flex flex-col h-full">
        <TopBar
          model={model}
          setModel={setModel}
          sidebarOpen={sidebarOpen}
          setSidebarOpen={setSidebarOpen}
          user={user}
          onLogout={() => (window.location.href = "/logout")}
        />

        <div className="flex flex-1 min-h-0">
          {sidebarOpen && (
            <div
              className="flex flex-shrink-0"
              style={{
                width: sidebarWidth,
                borderRight: "1px solid var(--border-color)",
                position: "relative",
              }}
            >
              <Sidebar
                sessions={sessions}
                activeIds={visibleSessions.map((s) => s.id)}
                onSelect={selectSession}
                onNew={() => setShowNewDialog(true)}
                onNewAt={(dir) => createSession("", dir)}
                onDelete={removeSession}
                open={sidebarOpen}
                savedLocations={savedLocations}
                onAddLocations={addLocations}
                onRemoveLocation={removeLocation}
                gitStatuses={gitStatuses}
              />
              {/* Resize handle */}
              <div
                onMouseDown={startSidebarResize}
                style={{
                  position: "absolute",
                  top: 0,
                  right: -2,
                  width: 5,
                  height: "100%",
                  cursor: "col-resize",
                  zIndex: 20,
                }}
              />
            </div>
          )}

          {/* Broadcast input bar */}
          {broadcastMode && (
            <div
              className="flex items-center gap-2 px-4 h-10 flex-shrink-0"
              style={{
                borderBottom: "1px solid var(--border-color)",
                backgroundColor: "rgba(234, 179, 8, 0.05)",
              }}
            >
              <span className="text-xs font-medium" style={{ color: "var(--yellow)" }}>
                BROADCAST
              </span>
              <input
                autoFocus
                className="flex-1 text-sm px-2 py-1 rounded"
                style={{
                  backgroundColor: "var(--bg-surface)",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border-color)",
                  outline: "none",
                }}
                placeholder="Type command and press Enter to send to all visible sessions..."
                value={broadcastText}
                onChange={(e) => setBroadcastText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && broadcastText.trim()) {
                    sendBroadcast(broadcastText.trim());
                    setBroadcastText("");
                  }
                  if (e.key === "Escape") {
                    setBroadcastMode(false);
                    setBroadcastText("");
                  }
                }}
              />
              <button
                onClick={() => { setBroadcastMode(false); setBroadcastText(""); }}
                className="text-xs px-2 py-1 rounded"
                style={{ color: "var(--text-muted)" }}
              >
                Esc
              </button>
            </div>
          )}

          {/* Pane grid */}
          <main
            className="flex-1 min-w-0"
            style={{
              display: "grid",
              gridTemplateColumns: gridTemplate,
              gridTemplateRows: gridRows,
              gap: 0,
            }}
          >
            {visibleSessions.map((session, idx) => (
              <div
                key={session.id}
                style={{
                  overflow: "hidden",
                  minHeight: 0,
                  minWidth: 0,
                  borderRight:
                    idx < visibleSessions.length - 1 &&
                    (layout === 2 || (layout === 4 && idx % 2 === 0))
                      ? "1px solid var(--border-color)"
                      : "none",
                  borderBottom:
                    layout === 4 && idx < 2
                      ? "1px solid var(--border-color)"
                      : "none",
                }}
              >
                <TerminalPane
                  ref={(el) => { paneRefs.current[idx] = el; }}
                  session={session}
                  onClose={() => removeSession(session.id)}
                  paneIndex={idx}
                  onSwap={layout > 1 ? swapPanes : undefined}
                />
              </div>
            ))}

            {/* Empty pane placeholders */}
            {visibleSessions.length < layout &&
              Array.from({ length: layout - visibleSessions.length }).map((_, i) => (
                <div
                  key={`empty-${i}`}
                  className="flex items-center justify-center"
                  style={{ color: "var(--text-muted)" }}
                >
                  <button
                    onClick={() => createSession()}
                    className="text-sm px-4 py-2 rounded-md transition-colors"
                    style={{ border: "1px solid var(--border-color)" }}
                    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--bg-surface)")}
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                  >
                    + New Session
                  </button>
                </div>
              ))}
          </main>
        </div>

        <StatusBar
          layout={layout}
          setLayout={setLayout}
          sessions={sessions}
          connected={sessions.some((s) => s.status === "running")}
          totalTokens={totalTokens}
          totalCost={totalCost}
          broadcastMode={broadcastMode}
          setBroadcastMode={setBroadcastMode}
        />
      </div>

      {showNewDialog && (
        <NewSessionDialog
          recentLocations={recentLocations}
          onConfirm={(name, workdir) => {
            setShowNewDialog(false);
            createSession(name, workdir);
          }}
          onCancel={() => setShowNewDialog(false)}
        />
      )}
    </div>
  );
}
