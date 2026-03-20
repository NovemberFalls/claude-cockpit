import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Loader } from "lucide-react";
import HexGrid from "./components/HexGrid";
import TopBar from "./components/TopBar";
import Sidebar from "./components/Sidebar";
import TerminalPane from "./components/TerminalPane";
import StatusBar from "./components/StatusBar";
import NewSessionDialog from "./components/NewSessionDialog";
import CloudSettingsDialog from "./components/CloudSettingsDialog";
import ApiKeysPanel from "./components/ApiKeysPanel";
import AdminPanel from "./components/AdminPanel";
import { useToast, ToastContainer } from "./components/Toast";
import { ModeProvider } from "./hooks/useMode";

const LOCATIONS_KEY = "cockpit-locations";
const RECENTS_KEY = "cockpit-recent-locations";
const SESSIONS_KEY = "cockpit-sessions";

/** Safe localStorage helpers — silently swallow quota/security errors */
function lsLoad(key, fallback = []) {
  try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
  catch { return fallback; }
}
function lsSave(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
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
  const [layout, setLayout] = useState(1);
  const [user, setUser] = useState(null);
  const [backendReady, setBackendReady] = useState(false);
  const [backendError, setBackendError] = useState(false);
  const [appMode, setAppMode] = useState("local"); // "local" or "relay"

  // Sessions: { id (local), name, terminalId (backend), model, status, workdir }
  const [sessions, setSessions] = useState([]);
  const [activeIds, setActiveIds] = useState([]);
  const [savedLocations, setSavedLocations] = useState(loadSavedLocations);
  const [recentLocations, setRecentLocations] = useState(() => lsLoad(RECENTS_KEY));
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [gitStatuses, setGitStatuses] = useState({});
  const [broadcastMode, setBroadcastMode] = useState(false);
  const [broadcastText, setBroadcastText] = useState("");
  const [cloudStatus, setCloudStatus] = useState({ connected: false, relay_url: "", instance_id: "" });
  const [showCloudDialog, setShowCloudDialog] = useState(false);
  const [showApiKeys, setShowApiKeys] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const paneRefs = useRef([]);
  const prevStatesRef = useRef({});

  const isRelay = appMode === "relay";

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

  // Mode context value
  const modeCtx = useMemo(() => ({
    mode: appMode,
    isRelay,
    isAdmin: user?.is_admin || false,
  }), [appMode, isRelay, user]);

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
              // On remote hosts, redirect unauthenticated users to login
              if (!data.authenticated && !["localhost", "127.0.0.1"].includes(location.hostname)) {
                window.location.href = "/login";
                return;
              }
              setBackendReady(true);
              setBackendError(false);
              if (data.authenticated) setUser(data);
              if (data.mode) setAppMode(data.mode);
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

    if (!isRelay) addLocations([dir]);

    if (!isRelay) {
      setRecentLocations((prev) => {
        const next = [dir, ...prev.filter((l) => l !== dir)].slice(0, 5);
        lsSave(RECENTS_KEY, next);
        return next;
      });
    }

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
      const next = [...prev];
      if (next.length >= layout) {
        next[next.length - 1] = localId;
      } else {
        next.push(localId);
      }
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
      // In relay mode, include instance_id so relay knows which desktop to target
      if (isRelay && options.instance_id) {
        body.instance_id = options.instance_id;
      }

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
  }, [model, layout, addLocations, isRelay, toast]);

  // Remove a session (kills terminal on both local and relay)
  const removeSession = useCallback(async (localId) => {
    const session = sessions.find((s) => s.id === localId);
    if (session?.terminalId) {
      fetch(`/api/terminals/${session.terminalId}`, { method: "DELETE" }).catch(() => toast("Failed to kill session on server", "error"));
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

  // Persist sessions to localStorage (local mode only)
  const sessionCountRef = useRef(0);
  useEffect(() => {
    if (isRelay) return;
    if (sessions.length !== sessionCountRef.current) {
      sessionCountRef.current = sessions.length;
      if (sessions.length > 0) saveSessions(sessions);
      else { try { localStorage.removeItem(SESSIONS_KEY); } catch {} }
    }
  }, [sessions, isRelay]);

  // Restore saved sessions once backend is ready (local mode only)
  // Reconciles with backend: if backend has no terminals, saved sessions are stale (crash recovery)
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!backendReady || restoredRef.current || isRelay) return;
    restoredRef.current = true;

    (async () => {
      const saved = loadSavedSessions();
      if (!saved.length) return;

      // Check what the backend actually has
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
      } catch {
        // Backend unreachable — don't restore, don't clear
        return;
      }

      // Backend has terminals — restore saved sessions
      for (const s of saved) {
        createSession(s.name, s.workdir, s.model);
      }
    })();
  }, [backendReady, createSession, isRelay]);

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

        if (isRelay) {
          // Relay mode: terminals from API ARE the sessions
          setSessions((prev) => {
            const newSessions = data.terminals.map((t) => ({
              id: t.id,
              name: t.name || "Session",
              terminalId: t.id,
              model: t.model || "",
              status: "running",
              workdir: t.workdir || "",
              activityState: t.activity_state || "idle",
              tokens: t.tokens || 0,
              cost: t.cost || 0,
              hostname: t.hostname || "",
              instance_id: t.instance_id || "",
            }));

            for (const s of newSessions) {
              notifyActivityChange(s.name, s.terminalId, prevStatesRef.current[s.terminalId], s.activityState);
              prevStatesRef.current[s.terminalId] = s.activityState;
            }

            // Auto-select first session if none active
            if (newSessions.length > 0 && prev.length === 0) {
              setActiveIds([newSessions[0].id]);
            }

            // Skip re-render if nothing changed
            if (newSessions.length === prev.length) {
              let same = true;
              for (let i = 0; i < newSessions.length; i++) {
                const n = newSessions[i];
                const p = prev[i];
                if (!p || n.id !== p.id || n.activityState !== p.activityState ||
                    n.tokens !== p.tokens || n.cost !== p.cost || n.name !== p.name) {
                  same = false;
                  break;
                }
              }
              if (same) return prev;
            }

            return newSessions;
          });
        } else {
          // Local mode: update existing sessions with poll data
          setSessions((prev) => {
            let changed = false;
            const updated = prev.map((s) => {
              if (!s.terminalId || !termMap[s.terminalId]) return s;
              const t = termMap[s.terminalId];
              const newState = t.activity_state;
              const newTokens = t.tokens || 0;
              const newCost = t.cost || 0;
              if (s.activityState === newState && s.tokens === newTokens && s.cost === newCost) {
                return s;
              }
              changed = true;
              return { ...s, activityState: newState, tokens: newTokens, cost: newCost };
            });

            for (const s of updated) {
              if (!s.terminalId) continue;
              notifyActivityChange(s.name, s.terminalId, prevStatesRef.current[s.terminalId], s.activityState);
              prevStatesRef.current[s.terminalId] = s.activityState;
            }

            return changed ? updated : prev;
          });
        }
      } catch {
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
  }, [backendReady, isRelay]);

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
        ...(isRelay ? [] : savedLocationsRef.current.map((l) => l.path)),
      ]);
      if (dirs.size === 0) return;
      const results = {};
      const entries = [...dirs];
      // In relay mode, derive instance_id from first session
      const instanceId = isRelay
        ? sessionsRef.current.find((s) => s.instance_id)?.instance_id || ""
        : "";
      const fetches = entries.map(async (dir) => {
        try {
          let url = `/api/git/status?path=${encodeURIComponent(dir)}`;
          if (instanceId) url += `&instance_id=${encodeURIComponent(instanceId)}`;
          const res = await fetch(url);
          if (res.ok) {
            const data = await res.json();
            const normPath = dir.replace(/\//g, "\\").replace(/\\$/, "");
            results[normPath] = data;
          }
        } catch { /* skip */ }
      });
      await Promise.all(fetches);
      setGitStatuses(results);
    };
    fetchGit();
    const id = setInterval(fetchGit, 30000);
    return () => clearInterval(id);
  }, [backendReady, isRelay]);

  // Poll cloud tunnel status (local mode only)
  useEffect(() => {
    if (!backendReady || isRelay) return;
    const pollCloud = async () => {
      try {
        const res = await fetch("/api/tunnel/status");
        if (res.ok) {
          const data = await res.json();
          setCloudStatus(data);
        }
      } catch { /* skip */ }
    };
    pollCloud();
    const id = setInterval(pollCloud, 5000);
    return () => clearInterval(id);
  }, [backendReady, isRelay]);

  const totalTokens = useMemo(
    () => sessions.reduce((sum, s) => sum + (s.tokens || 0), 0),
    [sessions]
  );
  const totalCost = useMemo(
    () => sessions.reduce((sum, s) => sum + (s.cost || 0), 0),
    [sessions]
  );

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
        if (i < visibleSessions.length) {
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
  }, [createSession, visibleSessions, isRelay, zoomIn, zoomOut, zoomReset]);

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
    <ModeProvider value={modeCtx}>
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
            cloudConnected={cloudStatus.connected}
            onCloudToggle={() => setShowCloudDialog(true)}
            isRelay={isRelay}
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
                  onNewAt={(dir) => createSession("", dir, undefined, { bypassPermissions: getLocationBypass(dir) })}
                  onToggleLocationBypass={toggleLocationBypass}
                  onDelete={removeSession}
                  open={sidebarOpen}
                  savedLocations={savedLocations}
                  onAddLocations={addLocations}
                  onRemoveLocation={removeLocation}
                  gitStatuses={gitStatuses}
                  isRelay={isRelay}
                  onShowApiKeys={() => setShowApiKeys(true)}
                  onShowAdmin={() => setShowAdmin(true)}
                  isAdmin={user?.is_admin || false}
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
                    isRelay={isRelay}
                    terminalZoom={terminalZoom}
                    toast={toast}
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
                      onClick={() => setShowNewDialog(true)}
                      className="text-sm px-4 py-2 rounded-md transition-colors hover-bg-surface"
                      style={{ border: "1px solid var(--border-color)" }}
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
            cloudConnected={cloudStatus.connected}
            isRelay={isRelay}
            terminalZoom={terminalZoom}
            onZoomIn={zoomIn}
            onZoomOut={zoomOut}
            onZoomReset={zoomReset}
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
            isRelay={isRelay}
            instances={isRelay ? [...new Map(sessions.map(s => [s.instance_id, { instance_id: s.instance_id, hostname: s.hostname }])).values()] : []}
            onConfirm={(name, workdir, bypassPermissions, instanceId) => {
              setShowNewDialog(false);
              createSession(name, workdir, undefined, { bypassPermissions, instance_id: instanceId });
            }}
            onCancel={() => setShowNewDialog(false)}
          />
        )}

        {showCloudDialog && !isRelay && (
          <CloudSettingsDialog
            cloudStatus={cloudStatus}
            onConnect={async (relayUrl, apiKey) => {
              const res = await fetch("/api/tunnel/connect", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ relay_url: relayUrl, api_key: apiKey }),
              });
              if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || "Connection failed");
              }
              setTimeout(async () => {
                try {
                  const statusRes = await fetch("/api/tunnel/status");
                  if (statusRes.ok) setCloudStatus(await statusRes.json());
                } catch {}
              }, 2000);
              setShowCloudDialog(false);
            }}
            onDisconnect={async () => {
              await fetch("/api/tunnel/disconnect", { method: "POST" });
              setCloudStatus({ connected: false, relay_url: "", instance_id: "" });
              setShowCloudDialog(false);
            }}
            onCancel={() => setShowCloudDialog(false)}
          />
        )}

        {showApiKeys && isRelay && (
          <ApiKeysPanel onClose={() => setShowApiKeys(false)} />
        )}

        {showAdmin && isRelay && user?.is_admin && (
          <AdminPanel onClose={() => setShowAdmin(false)} />
        )}

        <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      </div>
    </ModeProvider>
  );
}
