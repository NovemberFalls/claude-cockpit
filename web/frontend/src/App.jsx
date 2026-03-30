import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Loader } from "lucide-react";
import HexGrid from "./components/HexGrid";
import TopBar from "./components/TopBar";
import Sidebar from "./components/Sidebar";
import TerminalPane from "./components/TerminalPane";
import StatusBar from "./components/StatusBar";
import NewSessionDialog from "./components/NewSessionDialog";
import { useToast, ToastContainer } from "./components/Toast";
import OnboardingModal from "./components/OnboardingModal";

const LOCATIONS_KEY = "cockpit-locations";
const RECENTS_KEY = "cockpit-recent-locations";
const SESSIONS_KEY = "cockpit-sessions";
const ONBOARDING_KEY = "cockpit-onboarding-suppressed";

/** Safe localStorage helpers — silently swallow quota/security errors */
function lsLoad(key, fallback = []) {
  try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
  catch (_) { return fallback; }
}
function lsSave(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
}

function loadSavedLocations() {
  const raw = lsLoad(LOCATIONS_KEY);
  return raw.map((item) =>
    typeof item === "string" ? { path: item, bypassPermissions: false } : item
  );
}

function loadSavedSessions() { return lsLoad(SESSIONS_KEY); }

function saveSessions(sessions) {
  const toSave = sessions
    .filter((s) => s.status !== "error")
    .map(({ name, model, workdir }) => ({ name, model, workdir }));
  lsSave(SESSIONS_KEY, toSave);
}

/** Send a desktop notification if the window is not focused */
function notifyActivityChange(name, terminalId, prevState, currState) {
  if (!("Notification" in window) || Notification.permission !== "granted" || document.hasFocus()) return;
  if (!prevState || !currState) return;
  if (currState === "waiting" && prevState !== "waiting") {
    new Notification("Action Required", { body: `${name} is waiting for approval`, tag: `cockpit-${terminalId}` });
  } else if (currState === "idle" && prevState === "busy") {
    new Notification("Task Complete", { body: `${name} has finished`, tag: `cockpit-${terminalId}` });
  }
}

const SIDEBAR_WIDTH_KEY = "cockpit-sidebar-width";
const ZOOM_KEY = "cockpit-terminal-zoom";
const DEFAULT_ZOOM = 13;
const MIN_ZOOM = 8;
const MAX_ZOOM = 28;

let nextLocalId = 1;

// Find the first empty (null/undefined) slot within the visible layout range
function findEmptySlot(ids, maxSlots) {
  for (let i = 0; i < maxSlots; i++) {
    if (i >= ids.length || ids[i] == null) return i;
  }
  return -1;
}

export default function App() {
  const { toasts, toast, dismiss: dismissToast } = useToast();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(() => lsLoad(SIDEBAR_WIDTH_KEY, 224));
  const [terminalZoom, setTerminalZoom] = useState(() => {
    const saved = lsLoad(ZOOM_KEY, DEFAULT_ZOOM);
    return (saved >= MIN_ZOOM && saved <= MAX_ZOOM) ? saved : DEFAULT_ZOOM;
  });
  const [zoomToast, setZoomToast] = useState(null);
  const zoomToastTimer = useRef(null);
  const [model, setModel] = useState("sonnet");
  const [layout, setLayout] = useState(4);
  const [user, setUser] = useState(null);
  const [backendReady, setBackendReady] = useState(false);
  const [backendError, setBackendError] = useState(false);

  // Sessions: { id (local), name, terminalId (backend), model, status, workdir }
  const [sessions, setSessions] = useState([]);
  const [activeIds, setActiveIds] = useState([]);
  const [savedLocations, setSavedLocations] = useState(loadSavedLocations);
  const [recentLocations, setRecentLocations] = useState(() => lsLoad(RECENTS_KEY));
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [gitStatuses, setGitStatuses] = useState({});
  const [broadcastMode, setBroadcastMode] = useState(false);
  const [broadcastText, setBroadcastText] = useState("");
  // Drag-and-drop state for pane reordering
  const [dragSource, setDragSource] = useState(null);   // pane index being dragged
  const [dragOverSlot, setDragOverSlot] = useState(null); // slot index being hovered
  const [showOnboarding, setShowOnboarding] = useState(() => {
    try { return localStorage.getItem(ONBOARDING_KEY) !== "true"; } catch (_) { return true; }
  });
  const paneRefs = useRef([]);
  const prevStatesRef = useRef({});

  // System stats (polled from /api/system every 5s)
  const [systemStats, setSystemStats] = useState(null);

  // Auto-update check (Tauri desktop only)
  useEffect(() => {
    let cancelled = false;

    // Poll for Tauri IPC bridge (may not be injected immediately on remote URLs)
    const waitForTauri = () => new Promise((resolve) => {
      const isTauri = () => !!(window.__TAURI_INTERNALS__ || window.__TAURI__);
      if (isTauri()) return resolve(true);
      let attempts = 0;
      const interval = setInterval(() => {
        attempts++;
        if (isTauri()) { clearInterval(interval); resolve(true); }
        else if (attempts >= 20) { clearInterval(interval); resolve(false); } // 2s max
      }, 100);
    });

    (async () => {
      const hasTauri = await waitForTauri();
      console.log("[updater] IPC bridge:", hasTauri ? "available" : "not found (browser mode)");
      if (!hasTauri || cancelled) return;
      try {
        console.log("[updater] Checking for updates...");
        const { check } = await import("@tauri-apps/plugin-updater");
        const update = await check();
        console.log("[updater] Result:", update ? `v${update.version} available` : "up to date");
        if (cancelled || !update) return;
        toast(
          `Update available: v${update.version}`,
          "info",
          0, // persistent until dismissed
          {
            label: "Install & Restart",
            onClick: async () => {
              try {
                toast("Downloading update...", "info", 0);
                // Shut down the backend sidecar before the NSIS installer runs.
                // Without this, Windows locks the sidecar exe and the installer
                // cannot replace it, leaving the old version running after restart.
                try { await fetch("/api/shutdown", { method: "POST" }); } catch (_) {}
                await new Promise((r) => setTimeout(r, 800)); // wait for process exit
                await update.downloadAndInstall();
                const { relaunch } = await import("@tauri-apps/plugin-process");
                await relaunch();
              } catch (err) {
                toast(`Update failed: ${err.message}`, "error");
              }
            },
          }
        );
      } catch (err) {
        console.error("[updater] check failed:", err);
      }
    })();
    return () => { cancelled = true; };
  }, []);


  // Health-check polling: wait for backend to be ready (re-runs on crash recovery)
  useEffect(() => {
    if (backendReady) return; // Already connected, nothing to do
    let cancelled = false;
    let attempts = 0;
    const maxAttempts = 60; // 30s at 500ms intervals (longer for crash recovery)

    const check = async () => {
      while (!cancelled && attempts < maxAttempts) {
        try {
          const res = await fetch("/api/me");
          if (res.ok) {
            const data = await res.json();
            if (!cancelled) {
              setBackendReady(true);
              setBackendError(false);
              setUser(data);
            }
            return;
          }
        } catch (_) {
          // Backend not up yet
        }
        attempts++;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!cancelled) setBackendError(true);
    };

    check();
    return () => { cancelled = true; };
  }, [backendReady]);

  // Add locations to the curated list (deduped by path, no cap)
  /** Update savedLocations with a transform and persist */
  const updateLocations = useCallback((fn) => {
    setSavedLocations((prev) => {
      const next = fn(prev);
      lsSave(LOCATIONS_KEY, next);
      return next;
    });
  }, []);

  const addLocations = useCallback((dirs) => {
    updateLocations((prev) => {
      const byPath = new Map(prev.map((loc) => [loc.path, loc]));
      dirs.forEach((d) => {
        if (d && !byPath.has(d)) byPath.set(d, { path: d, bypassPermissions: false });
      });
      return [...byPath.values()];
    });
  }, [updateLocations]);

  const removeLocation = useCallback((dir) => {
    updateLocations((prev) => prev.filter((l) => l.path !== dir));
  }, [updateLocations]);

  const toggleLocationBypass = useCallback((dir) => {
    updateLocations((prev) =>
      prev.map((l) => l.path === dir ? { ...l, bypassPermissions: !l.bypassPermissions } : l)
    );
  }, [updateLocations]);

  // Check if a location has bypass enabled
  const getLocationBypass = useCallback((dir) => {
    return savedLocations.find((l) => l.path === dir)?.bypassPermissions || false;
  }, [savedLocations]);

  // Create a new terminal session
  const createSession = useCallback(async (name, workdir, sessionModel, options = {}) => {
    const localId = nextLocalId++;
    const sessionName = name || `Session ${localId}`;
    const dir = workdir || "C:\\Code";
    const useModel = sessionModel || model;

    addLocations([dir]);

    setRecentLocations((prev) => {
      const next = [dir, ...prev.filter((l) => l !== dir)].slice(0, 5);
      lsSave(RECENTS_KEY, next);
      return next;
    });

    const newSession = {
      id: localId,
      name: sessionName,
      terminalId: null,
      model: useModel,
      status: "starting",
      workdir: dir,
      bypassPermissions: !!options.bypassPermissions,
    };
    setSessions((prev) => [...prev, newSession]);
    setActiveIds((prev) => {
      const slot = findEmptySlot(prev, layout);
      if (slot === -1) return prev; // all panes full — user drags from sidebar to place
      const next = [...prev];
      while (next.length <= slot) next.push(null);
      next[slot] = localId;
      return next;
    });

    try {
      const body = {
        name: sessionName,
        model: useModel,
        workdir: dir,
        cols: 120,
        rows: 30,
        ...(options.continueSession ? { continue: true } : {}),
        ...(options.bypassPermissions ? { bypassPermissions: true } : {}),
      };

      const res = await fetch("/api/terminals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (data.error) {
        toast(data.error, "error");
        setSessions((prev) =>
          prev.map((s) => s.id === localId ? { ...s, status: "error" } : s)
        );
        return;
      }

      setSessions((prev) =>
        prev.map((s) =>
          s.id === localId ? { ...s, terminalId: data.id, status: "running" } : s
        )
      );
    } catch (err) {
      toast("Failed to create session", "error");
      setSessions((prev) =>
        prev.map((s) => s.id === localId ? { ...s, status: "error" } : s)
      );
    }
  }, [model, layout, addLocations, toast]);

  // Remove a session (kills terminal on server)
  const removeSession = useCallback(async (localId) => {
    const session = sessions.find((s) => s.id === localId);
    if (session?.terminalId) {
      fetch(`/api/terminals/${session.terminalId}`, { method: "DELETE" }).catch(() => toast("Failed to kill session on server", "error"));
    }
    setSessions((prev) => prev.filter((s) => s.id !== localId));
    setActiveIds((prev) => prev.map((id) => id === localId ? null : id));
  }, [sessions]);

  // Select a session: fill an empty pane slot if available, never auto-rearrange
  const selectSession = useCallback((id) => {
    setActiveIds((prev) => {
      // Check if already in a visible slot
      for (let i = 0; i < layout && i < prev.length; i++) {
        if (prev[i] === id) return prev;
      }
      const slot = findEmptySlot(prev, layout);
      if (slot === -1) return prev; // all panes full — user drags to place
      const next = [...prev];
      while (next.length <= slot) next.push(null);
      next[slot] = id;
      return next;
    });
  }, [layout]);

  // Explicitly place a session into a specific pane slot index
  const placeSession = useCallback((sessionId, slotIndex) => {
    setActiveIds((prev) => {
      const from = prev.indexOf(sessionId);
      if (from === slotIndex) return prev;
      const next = [...prev];
      while (next.length <= slotIndex) next.push(null);
      if (from !== -1) {
        // Already in activeIds: swap positions (target may be null = empty slot)
        const tmp = next[slotIndex];
        next[slotIndex] = sessionId;
        next[from] = tmp;
      } else {
        // Not in activeIds: place directly into target slot
        next[slotIndex] = sessionId;
      }
      return next;
    });
  }, []);

  // Persist sessions to localStorage
  const sessionCountRef = useRef(0);
  useEffect(() => {
    if (sessions.length !== sessionCountRef.current) {
      sessionCountRef.current = sessions.length;
      if (sessions.length > 0) saveSessions(sessions);
      else { try { localStorage.removeItem(SESSIONS_KEY); } catch (_) {} }
    }
  }, [sessions]);

  // Restore saved sessions once backend is ready.
  // Reattaches to surviving backend terminals by name match instead of spawning
  // new processes (which caused duplicate "ghost" sessions).
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!backendReady || restoredRef.current) return;
    restoredRef.current = true;

    (async () => {
      const saved = loadSavedSessions();
      if (!saved.length) return;

      try {
        const res = await fetch("/api/terminals");
        const data = await res.json();
        const backendTerminals = data.terminals || [];

        if (backendTerminals.length === 0) {
          // Backend restarted — old sessions are gone. Clear stale data.
          console.log("[cockpit] Backend has no terminals — clearing stale saved sessions");
          localStorage.removeItem(SESSIONS_KEY);
          return;
        }

        // Match saved sessions to surviving backend terminals by name.
        // Reattach instead of creating new processes to avoid duplicates.
        // Unmatched backend terminals will be picked up by the polling loop.
        const claimed = new Set();
        const reattached = [];
        for (const s of saved) {
          const match = backendTerminals.find(
            (t) => t.alive && !claimed.has(t.id) && t.name === s.name
          );
          if (match) {
            claimed.add(match.id);
            reattached.push({
              id: nextLocalId++,
              name: s.name,
              terminalId: match.id,
              model: s.model || match.model || "sonnet",
              status: "running",
              workdir: s.workdir || match.working_dir || "",
              bypassPermissions: match.bypass_permissions || false,
              activityState: match.activity_state,
              tokens: match.tokens || 0,
              cost: match.cost || 0,
              context_percent: match.context_percent ?? null,
            });
          }
        }

        if (reattached.length > 0) {
          console.log(`[cockpit] Reattached ${reattached.length} session(s) to surviving backend terminals`);
          setSessions(reattached);
          setActiveIds(reattached.map((s) => s.id).slice(0, layout));
          addLocations(reattached.map((s) => s.workdir).filter(Boolean));
        } else {
          // No saved sessions matched surviving terminals — stale data
          console.log("[cockpit] No saved sessions matched surviving terminals — clearing");
          localStorage.removeItem(SESSIONS_KEY);
        }
      } catch (_) {
        // Backend unreachable — don't restore, don't clear
        return;
      }
    })();
  }, [backendReady, layout, addLocations]);

  // Request notification permission
  const notifRequested = useRef(false);
  useEffect(() => {
    if (sessions.length > 0 && !notifRequested.current && "Notification" in window) {
      notifRequested.current = true;
      if (Notification.permission === "default") {
        Notification.requestPermission();
      }
    }
  }, [sessions.length]);

  // Poll /api/terminals every 3s — detect backend death and trigger recovery
  const pollFailCount = useRef(0);
  useEffect(() => {
    if (!backendReady) return;
    pollFailCount.current = 0;
    const poll = async () => {
      try {
        const res = await fetch("/api/terminals");
        if (!res.ok) throw new Error("not ok");
        pollFailCount.current = 0; // Reset on success
        const data = await res.json();
        const termMap = {};
        for (const t of data.terminals) {
          termMap[t.id] = t;
        }

        setSessions((prev) => {
            let changed = false;

            const updated = prev.map((s) => {
              if (!s.terminalId || !termMap[s.terminalId]) return s;
              const t = termMap[s.terminalId];
              const newState = t.activity_state;
              const newTokens = t.tokens || 0;
              const newCost = t.cost || 0;
              const newContextPercent = t.context_percent ?? null;
              if (s.activityState === newState && s.tokens === newTokens && s.cost === newCost && s.context_percent === newContextPercent) {
                return s;
              }
              changed = true;
              return { ...s, activityState: newState, tokens: newTokens, cost: newCost, context_percent: newContextPercent };
            });

            const result = changed ? updated : prev;

            for (const s of result) {
              if (!s.terminalId) continue;
              notifyActivityChange(s.name, s.terminalId, prevStatesRef.current[s.terminalId], s.activityState);
              prevStatesRef.current[s.terminalId] = s.activityState;
            }

            return result;
          });
      } catch (_) {
        pollFailCount.current++;
        // After 3 consecutive failures (~9s), backend is dead — trigger recovery
        if (pollFailCount.current >= 3) {
          console.warn("[cockpit] Backend unreachable — entering recovery mode");
          setBackendReady(false);
          restoredRef.current = false; // Allow session restore on reconnect
        }
      }
    };
    const id = setInterval(poll, 3000);
    poll();
    return () => clearInterval(id);
  }, [backendReady]);

  // Poll git status (local mode only)
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const savedLocationsRef = useRef(savedLocations);
  savedLocationsRef.current = savedLocations;

  useEffect(() => {
    if (!backendReady) return;
    const fetchGit = async () => {
      const dirs = new Set([
        ...sessionsRef.current.map((s) => s.workdir).filter(Boolean),
        ...savedLocationsRef.current.map((l) => l.path),
      ]);
      if (dirs.size === 0) return;
      const results = {};
      const entries = [...dirs];
      const fetches = entries.map(async (dir) => {
        try {
          const url = `/api/git/status?path=${encodeURIComponent(dir)}`;
          const res = await fetch(url);
          if (res.ok) {
            const data = await res.json();
            const normPath = dir.replace(/\//g, "\\").replace(/\\$/, "");
            results[normPath] = data;
          }
        } catch (_) { /* skip */ }
      });
      await Promise.all(fetches);
      setGitStatuses(results);
    };
    fetchGit();
    const id = setInterval(fetchGit, 30000);
    return () => clearInterval(id);
  }, [backendReady]);

  // Poll /api/system every 5s for CPU/RAM/GPU stats
  useEffect(() => {
    if (!backendReady) return;
    const fetchStats = async () => {
      try {
        const res = await fetch("/api/system");
        if (!res.ok) return;
        const data = await res.json();
        setSystemStats(data);
      } catch (_) {
        // leave systemStats unchanged on error
      }
    };
    fetchStats();
    const id = setInterval(fetchStats, 5000);
    return () => clearInterval(id);
  }, [backendReady]);

  // Sessions currently occupying visible slots (used for broadcast, etc.)
  const visibleSessions = useMemo(() => {
    return activeIds
      .slice(0, layout)
      .filter((id) => id != null)
      .map((id) => sessions.find((s) => s.id === id))
      .filter(Boolean);
  }, [activeIds, layout, sessions]);

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

  /** Apply a zoom level: persist, show toast, update state */
  const applyZoom = useCallback((value) => {
    setTerminalZoom(value);
    lsSave(ZOOM_KEY, value);
    clearTimeout(zoomToastTimer.current);
    setZoomToast(value);
    zoomToastTimer.current = setTimeout(() => setZoomToast(null), 1200);
  }, []);

  const zoomIn = useCallback(() => {
    setTerminalZoom((prev) => { const next = Math.min(prev + 1, MAX_ZOOM); applyZoom(next); return next; });
  }, [applyZoom]);

  const zoomOut = useCallback(() => {
    setTerminalZoom((prev) => { const next = Math.max(prev - 1, MIN_ZOOM); applyZoom(next); return next; });
  }, [applyZoom]);

  const zoomReset = useCallback(() => applyZoom(DEFAULT_ZOOM), [applyZoom]);

  useEffect(() => {
    const handler = (e) => {
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
      if (e.ctrlKey && !e.shiftKey && e.key >= "1" && e.key <= "4") {
        const i = parseInt(e.key) - 1;
        if (i < layout && activeIds[i] != null) {
          e.preventDefault();
          paneRefs.current[i]?.focus();
        }
      }
      if (e.ctrlKey && e.shiftKey && e.key === "Enter") {
        e.preventDefault();
        setBroadcastMode((p) => !p);
      }
      // Zoom: Ctrl+= / Ctrl+- / Ctrl+0
      if (e.ctrlKey && !e.shiftKey && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        zoomIn();
      }
      if (e.ctrlKey && !e.shiftKey && e.key === "-") {
        e.preventDefault();
        zoomOut();
      }
      if (e.ctrlKey && !e.shiftKey && e.key === "0") {
        e.preventDefault();
        zoomReset();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [createSession, activeIds, layout, zoomIn, zoomOut, zoomReset]);

  // Ctrl+MouseWheel zoom
  useEffect(() => {
    const handler = (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (e.deltaY < 0) zoomIn();
      else if (e.deltaY > 0) zoomOut();
    };
    window.addEventListener("wheel", handler, { passive: false });
    return () => window.removeEventListener("wheel", handler);
  }, [zoomIn, zoomOut]);

  const swapPanes = useCallback((fromIdx, toIdx) => {
    setActiveIds((prev) => {
      const next = [...prev];
      while (next.length <= Math.max(fromIdx, toIdx)) next.push(null);
      const tmp = next[fromIdx];
      next[fromIdx] = next[toIdx];
      next[toIdx] = tmp;
      return next;
    });
  }, []);

  const startSidebarResize = useCallback((e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    let rafId = 0;
    let latestX = startX;
    const onMove = (ev) => {
      latestX = ev.clientX;
      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          const newW = Math.min(Math.max(startW + latestX - startX, 140), 500);
          setSidebarWidth(newW);
        });
      }
    };
    const onUp = () => {
      cancelAnimationFrame(rafId);
      const finalW = Math.min(Math.max(startW + latestX - startX, 140), 500);
      setSidebarWidth(finalW);
      lsSave(SIDEBAR_WIDTH_KEY, finalW);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [sidebarWidth]);

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
                <Loader size={24} className="state-icon-spin" style={{ color: "var(--accent)", margin: "0 auto 12px" }} />
                <p className="text-lg mb-2" style={{ color: "var(--text-primary)" }}>
                  Connecting...
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
                  activeIds={activeIds.slice(0, layout).filter((id) => id != null)}
                  onSelect={selectSession}
                  onNew={() => setShowNewDialog(true)}
                  onNewAt={(dir) => createSession("", dir, undefined, { bypassPermissions: getLocationBypass(dir) })}
                  onToggleLocationBypass={toggleLocationBypass}
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

            {/* Broadcast input bar (local mode only) */}
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

            {/* Pane grid — always mounted, terminals never unmount */}
            <main
              className="flex-1 min-w-0"
              style={{
                display: "grid",
                gridTemplateColumns: gridTemplate,
                gridTemplateRows: gridRows,
                gap: 0,
              }}
              onDragEnd={() => { setDragSource(null); setDragOverSlot(null); }}
            >
              {/* Slot-based rendering: each slot is either a session pane or an empty placeholder */}
              {Array.from({ length: layout }).map((_, idx) => {
                const sessionId = idx < activeIds.length ? activeIds[idx] : null;
                const session = sessionId != null ? sessions.find((s) => s.id === sessionId) : null;
                const slotBorders = {
                  borderRight:
                    layout >= 2 && idx % 2 === 0
                      ? "1px solid var(--border-color)"
                      : "none",
                  borderBottom:
                    layout === 4 && idx < 2
                      ? "1px solid var(--border-color)"
                      : "none",
                };

                // Shared drop handlers for all slots
                const dndHandlers = {
                  onDragOver: (e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (dragOverSlot !== idx) setDragOverSlot(idx);
                  },
                  onDragLeave: (e) => {
                    if (!e.currentTarget.contains(e.relatedTarget)) {
                      setDragOverSlot(null);
                    }
                  },
                  onDrop: (e) => {
                    e.preventDefault();
                    setDragOverSlot(null);
                    setDragSource(null);
                    const data = e.dataTransfer.getData("text/plain");
                    if (data.startsWith("session:")) {
                      placeSession(data.slice(8), idx);
                    } else if (data.startsWith("pane:")) {
                      const from = parseInt(data.slice(5), 10);
                      if (!isNaN(from) && from !== idx) swapPanes(from, idx);
                    }
                  },
                };

                // Drop target overlay (shared between filled and empty slots)
                const dropOverlay = dragOverSlot === idx && dragSource !== idx && (
                  <div
                    style={{
                      position: "absolute",
                      inset: 4,
                      border: "2px dashed var(--accent)",
                      borderRadius: 8,
                      backgroundColor: "rgba(122, 162, 247, 0.08)",
                      animation: "drop-target-pulse 1.5s ease-in-out infinite",
                      zIndex: 10,
                      pointerEvents: "none",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <span
                      className="text-xs font-semibold px-3 py-1.5 rounded-full"
                      style={{
                        backgroundColor: "var(--bg-elevated)",
                        color: "var(--accent)",
                        border: "1px solid var(--accent)",
                        boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
                      }}
                    >
                      {dragSource != null ? "Drop to swap" : "Drop here"}
                    </span>
                  </div>
                );

                if (session) {
                  return (
                    <div
                      key={session.id}
                      style={{
                        overflow: "hidden",
                        minHeight: 0,
                        minWidth: 0,
                        position: "relative",
                        ...slotBorders,
                        opacity: dragSource === idx ? 0.4 : 1,
                        transition: "opacity 0.2s ease",
                      }}
                      {...dndHandlers}
                    >
                      {dropOverlay}
                      <TerminalPane
                        ref={(el) => { paneRefs.current[idx] = el; }}
                        session={session}
                        onClose={() => removeSession(session.id)}
                        paneIndex={idx}
                        onSwap={layout > 1 ? swapPanes : undefined}
                        onPlace={placeSession}
                        onDragSourceChange={layout > 1 ? setDragSource : undefined}
                        terminalZoom={terminalZoom}
                        toast={toast}
                      />
                    </div>
                  );
                }

                return (
                  <div
                    key={`empty-${idx}`}
                    className="flex items-center justify-center"
                    style={{
                      color: "var(--text-muted)",
                      position: "relative",
                      ...slotBorders,
                    }}
                    {...dndHandlers}
                  >
                    {dropOverlay}
                    <button
                      onClick={() => setShowNewDialog(true)}
                      className="text-sm px-4 py-2 rounded-md transition-colors hover-bg-surface"
                      style={{ border: "1px solid var(--border-color)" }}
                    >
                      + New Session
                    </button>
                  </div>
                );
              })}
            </main>


          </div>

          <StatusBar
            layout={layout}
            setLayout={setLayout}
            sessions={sessions}
            connected={sessions.some((s) => s.status === "running")}
            broadcastMode={broadcastMode}
            setBroadcastMode={setBroadcastMode}
            terminalZoom={terminalZoom}
            onZoomIn={zoomIn}
            onZoomOut={zoomOut}
            onZoomReset={zoomReset}
            systemStats={systemStats}
          />

          {/* Zoom toast */}
          {zoomToast !== null && (
            <div
              style={{
                position: "fixed",
                bottom: 48,
                left: "50%",
                transform: "translateX(-50%)",
                backgroundColor: "var(--bg-elevated)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-color)",
                borderRadius: 6,
                padding: "4px 14px",
                fontSize: 13,
                fontWeight: 600,
                zIndex: 200,
                pointerEvents: "none",
                opacity: 0.95,
                boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
              }}
            >
              {zoomToast}px
            </div>
          )}
        </div>

        {showNewDialog && (
          <NewSessionDialog
            recentLocations={recentLocations}
            savedLocations={savedLocations}
            onConfirm={(name, workdir, bypassPermissions) => {
              setShowNewDialog(false);
              createSession(name, workdir, undefined, { bypassPermissions });
            }}
            onCancel={() => setShowNewDialog(false)}
          />
        )}

        {showOnboarding && <OnboardingModal onDismiss={() => setShowOnboarding(false)} />}
        <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      </div>
  );
}
