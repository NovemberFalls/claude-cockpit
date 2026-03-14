import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import HexGrid from "./components/HexGrid";
import TopBar from "./components/TopBar";
import Sidebar from "./components/Sidebar";
import TerminalPane from "./components/TerminalPane";
import StatusBar from "./components/StatusBar";
import NewSessionDialog from "./components/NewSessionDialog";

const LOCATIONS_KEY = "cockpit-locations";
const RECENTS_KEY = "cockpit-recent-locations";

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
  const createSession = useCallback(async (name, workdir) => {
    const localId = nextLocalId++;
    const sessionName = name || `Session ${localId}`;
    const dir = workdir || "C:\\Code";

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
      model,
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
          model,
          workdir: dir,
          cols: 120,
          rows: 30,
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

  // Signal backend is ready (no auto-create — user picks from locations or "+ New")
  // eslint-disable-next-line no-unused-vars
  const _ = backendReady;

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
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [createSession]);

  // Visible sessions for panes
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
                  session={session}
                  onClose={() => removeSession(session.id)}
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
          totalTokens={0}
          totalCost={0}
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
