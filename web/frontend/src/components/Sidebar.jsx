import { Plus, X, FolderOpen, ChevronRight, ChevronDown, GitBranch, ShieldOff, Puzzle } from "lucide-react";
import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import StateIcon from "./StateIcon";

/** Normalize path separators to backslash for comparison */
function norm(dir) {
  return dir.replace(/\//g, "\\").replace(/\\$/, "");
}

/** Get the last segment of a path */
function shortPath(dir) {
  if (!dir) return "";
  const parts = norm(dir).split("\\").filter(Boolean);
  return parts[parts.length - 1] || dir;
}

/**
 * Build a tree from a flat list of location objects.
 * Each node: { path, name, bypassPermissions, children: [] }
 */
function buildTree(locations) {
  const sorted = [...locations].sort((a, b) => norm(a.path).localeCompare(norm(b.path)));
  const roots = [];
  const nodes = new Map();

  for (const loc of sorted) {
    const n = norm(loc.path);
    const node = { path: loc.path, name: shortPath(loc.path), bypassPermissions: loc.bypassPermissions || false, children: [] };
    nodes.set(n, node);

    let placed = false;
    const parts = n.split("\\");
    for (let i = parts.length - 1; i > 0; i--) {
      const parentPath = parts.slice(0, i).join("\\");
      if (nodes.has(parentPath)) {
        nodes.get(parentPath).children.push(node);
        placed = true;
        break;
      }
    }
    if (!placed) roots.push(node);
  }

  return roots;
}

/** Context menu for location nodes */
function LocationContextMenu({ x, y, path, isBypass, onExpand, onNewAt, onRemove, onToggleBypass, onClose }) {
  const menuRef = useRef(null);
  const [pos, setPos] = useState({ x, y });

  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const nx = x + rect.width > window.innerWidth ? window.innerWidth - rect.width - 4 : x;
    const ny = y + rect.height > window.innerHeight ? window.innerHeight - rect.height - 4 : y;
    setPos({ x: nx, y: ny });
  }, [x, y]);

  useEffect(() => {
    const handleClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose();
    };
    const handleKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  const itemStyle = {
    padding: "6px 12px",
    fontSize: "12px",
    cursor: "pointer",
    color: "var(--text-secondary)",
    whiteSpace: "nowrap",
  };

  return (
    <div
      ref={menuRef}
      style={{
        position: "fixed",
        left: pos.x,
        top: pos.y,
        zIndex: 1000,
        backgroundColor: "var(--bg-surface)",
        border: "1px solid var(--border-color)",
        borderRadius: "6px",
        padding: "4px 0",
        boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
        minWidth: "150px",
      }}
    >
      <div
        style={itemStyle}
        className="hover-bg-elevated"
        onClick={() => { navigator.clipboard.writeText(path); onClose(); }}
      >
        Copy path
      </div>
      <div
        style={itemStyle}
        className="hover-bg-elevated"
        onClick={() => { onExpand(path); onClose(); }}
      >
        Expand 1 layer
      </div>
      <div
        style={itemStyle}
        className="hover-bg-elevated"
        onClick={() => { onNewAt(path); onClose(); }}
      >
        Open session here
      </div>
      <div
        style={{ ...itemStyle, color: isBypass ? "var(--yellow)" : "var(--text-secondary)" }}
        className="hover-bg-elevated"
        onClick={() => { onToggleBypass(path); onClose(); }}
      >
        {isBypass ? "Disable bypass" : "Enable bypass"}
      </div>
      <div
        style={{ height: "1px", backgroundColor: "var(--border-color)", margin: "4px 0" }}
      />
      <div
        style={{ ...itemStyle, color: "var(--red)" }}
        className="hover-bg-elevated"
        onClick={() => { onRemove(path); onClose(); }}
      >
        Remove
      </div>
    </div>
  );
}

function SessionItem({ session, isActive, onSelect, onDelete }) {
  return (
    <div
      className="group flex items-center"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", `session:${session.id}`);
      }}
    >
      <button
        onClick={() => onSelect(session.id)}
        className={`flex items-center gap-2 flex-1 text-left px-3 py-1.5 rounded-md text-sm transition-colors min-w-0 ${!isActive ? "hover-bg-surface" : ""}`}
        style={{
          color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
          fontWeight: isActive ? 600 : 400,
          backgroundColor: isActive ? "var(--bg-surface)" : "transparent",
        }}
      >
        <StateIcon state={session.activityState || session.status} />
        <span className="truncate">{session.name}</span>
        {session.bypassPermissions && (
          <ShieldOff
            size={10}
            style={{ color: "var(--yellow)", flexShrink: 0 }}
            title="Permissions bypassed"
          />
        )}
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(session.id); }}
        className="opacity-0 group-hover:opacity-100 p-1.5 rounded transition-all flex-shrink-0 mr-1 hover-color-red"
        style={{ color: "var(--text-muted)" }}
        title="Close session"
      >
        <X size={28} />
      </button>
    </div>
  );
}

function LocationNode({ node, depth = 0, sessionsByDir, activeIds, onSelect, onDelete, gitStatuses, onNewAt, onContextMenu }) {
  const sessionsHere = sessionsByDir[norm(node.path)] || [];
  const hasChildren = node.children.length > 0 || sessionsHere.length > 0;
  const [expanded, setExpanded] = useState(true);

  return (
    <div>
      <div
        className="group flex items-center gap-1 py-0.5 cursor-pointer rounded-md transition-colors hover-bg-surface"
        style={{
          color: "var(--text-secondary)",
          paddingLeft: `${depth * 12 + 8}px`,
          paddingRight: "8px",
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onContextMenu(e, node.path);
        }}
      >
        {hasChildren ? (
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
            className="p-0.5 flex-shrink-0"
            style={{ color: "var(--text-muted)" }}
          >
            {expanded
              ? <ChevronDown size={10} />
              : <ChevronRight size={10} />
            }
          </button>
        ) : (
          <span className="w-[18px] flex-shrink-0" />
        )}

        <button
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
          onClick={() => setExpanded(!expanded)}
          onDoubleClick={() => onNewAt(node.path)}
          title={node.path}
        >
          <FolderOpen size={12} style={{ color: "var(--accent)", flexShrink: 0 }} />
          <span className="text-xs truncate">{node.name}</span>
          {node.bypassPermissions && (
            <ShieldOff size={10} style={{ color: "var(--yellow)", flexShrink: 0 }} title="Bypass permissions enabled" />
          )}
        </button>

        {(() => {
          const git = gitStatuses[norm(node.path)];
          if (!git?.git) return null;
          return (
            <span
              className="flex items-center gap-0.5 flex-shrink-0"
              title={`${git.branch}${git.dirty ? ` (${git.files_changed} changed)` : ""}`}
            >
              <GitBranch size={9} style={{ color: "var(--text-muted)" }} />
              <span className="text-[9px]" style={{ color: "var(--text-muted)" }}>
                {git.branch.length > 12 ? git.branch.slice(0, 12) + "\u2026" : git.branch}
              </span>
              {git.dirty && (
                <span
                  className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: "var(--yellow)" }}
                />
              )}
            </span>
          );
        })()}

        {sessionsHere.length > 0 && (
          <span
            className="text-[10px] flex-shrink-0"
            style={{ color: "var(--text-muted)" }}
          >
            {sessionsHere.length}
          </span>
        )}

        <Plus
          size={14}
          className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 cursor-pointer"
          style={{ color: "var(--accent)" }}
          onClick={(e) => { e.stopPropagation(); onNewAt(node.path); }}
        />
      </div>

      {expanded && (
        <>
          {sessionsHere.length > 0 && (
            <div style={{ paddingLeft: `${depth * 12 + 20}px` }}>
              {sessionsHere.map((s) => (
                <SessionItem key={s.id} session={s} isActive={activeIds.includes(s.id)} onSelect={onSelect} onDelete={onDelete} />
              ))}
            </div>
          )}
          {node.children.map((child) => (
            <LocationNode key={child.path} node={child} depth={depth + 1} sessionsByDir={sessionsByDir} activeIds={activeIds} onSelect={onSelect} onDelete={onDelete} gitStatuses={gitStatuses} onNewAt={onNewAt} onContextMenu={onContextMenu} />
          ))}
        </>
      )}
    </div>
  );
}

export default function Sidebar({
  sessions,
  activeIds,
  onSelect,
  onNew,
  onNewAt,
  onDelete,
  open,
  savedLocations,
  onAddLocations,
  onRemoveLocation,
  onToggleLocationBypass,
  gitStatuses = {},
}) {
  if (!open) return null;

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState(null);

  const tree = useMemo(() => buildTree(savedLocations), [savedLocations]);

  // Pre-compute workdir → sessions[] map (O(n) once, not per LocationNode)
  const sessionsByDir = useMemo(() => {
    const map = {};
    for (const s of sessions) {
      const key = norm(s.workdir);
      if (!map[key]) map[key] = [];
      map[key].push(s);
    }
    return map;
  }, [sessions]);

  // Expand 1 layer: fetch subdirs from backend and add them
  const handleExpand = useCallback(async (path) => {
    try {
      const res = await fetch(`/api/browse?path=${encodeURIComponent(path)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.dirs && data.dirs.length > 0) {
        onAddLocations(data.dirs);
      }
    } catch {
      // silently fail
    }
  }, [onAddLocations]);

  const handleContextMenu = useCallback((e, path) => {
    const loc = savedLocations.find((l) => l.path === path);
    setCtxMenu({ x: e.clientX, y: e.clientY, path, isBypass: loc?.bypassPermissions || false });
  }, [savedLocations]);

  return (
    <aside
      data-tour="sidebar"
      className="flex flex-col flex-shrink-0 py-4 px-2 overflow-y-auto h-full"
    >
      {/* New button */}
      <button
        data-tour="new-session-btn"
        onClick={onNew}
        className="flex items-center gap-2 text-sm font-medium px-3 py-1.5 rounded-md mb-2 transition-colors hover-bg-surface"
        style={{ color: "var(--text-secondary)" }}
        title="New session (Ctrl+Shift+N)"
      >
        <Plus size={16} />
        <span>New</span>
      </button>

      {/* Empty state / first-run card */}
      {tree.length === 0 && sessions.length === 0 && (
        <div className="px-2 py-4">
          <div
            className="rounded-lg p-4"
            style={{
              backgroundColor: "var(--bg-elevated)",
              border: "1px solid var(--border-color)",
            }}
          >
            <p className="text-xs font-semibold mb-3" style={{ color: "var(--text-primary)" }}>
              Welcome to Claude Cockpit
            </p>
            <ul className="space-y-2 text-xs" style={{ color: "var(--text-secondary)" }}>
              <li>• Run multiple Claude Code sessions side-by-side</li>
              <li>• Organize by project folder with git status</li>
              <li style={{ color: "var(--accent)" }}>
                • <strong>Orchestrator Mode</strong> — one Claude coordinates others via MCP
              </li>
            </ul>
            <button
              onClick={onNew}
              className="mt-4 w-full py-1.5 rounded-md text-xs font-medium transition-colors hover-bg-surface"
              style={{
                border: "1px solid var(--border-color)",
                color: "var(--accent)",
              }}
            >
              Create your first session →
            </button>
          </div>
        </div>
      )}

      {/* Location tree */}
      {tree.length > 0 && (
        <>
          <p
            className="text-[10px] uppercase tracking-widest font-semibold px-3 mb-1"
            style={{ color: "var(--text-muted)" }}
          >
            Locations
          </p>
          <div className="flex flex-col">
            {tree.map((node) => (
              <LocationNode key={node.path} node={node} depth={0} sessionsByDir={sessionsByDir} activeIds={activeIds} onSelect={onSelect} onDelete={onDelete} gitStatuses={gitStatuses} onNewAt={onNewAt} onContextMenu={handleContextMenu} />
            ))}
          </div>
        </>
      )}

      {/* Resources footer */}
      <>
        <div style={{ flex: 1 }} />
        <div
          className="border-t pt-3 mt-3"
          style={{ borderColor: "var(--border-color)" }}
        >
          <button
            onClick={() => {
              const url = "https://registry.modelcontextprotocol.io/";
              fetch("/api/open-url", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) })
                .catch(() => window.open(url, "_blank"));
            }}
            className="flex items-center gap-2 text-xs w-full text-left px-3 py-1.5 rounded-md transition-colors hover-bg-surface"
            style={{ color: "var(--text-secondary)" }}
            title="Browse MCP server registry"
          >
            <Puzzle size={12} />
            MCP Servers
          </button>
        </div>
      </>

      {/* Context menu */}
      {ctxMenu && (
        <LocationContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          path={ctxMenu.path}
          isBypass={ctxMenu.isBypass}
          onExpand={handleExpand}
          onNewAt={onNewAt}
          onRemove={onRemoveLocation}
          onToggleBypass={onToggleLocationBypass}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </aside>
  );
}
