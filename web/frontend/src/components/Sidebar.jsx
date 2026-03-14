import { Plus, X, FolderOpen, ChevronRight, ChevronDown, Pencil, CircleHelp, CircleCheck, CircleX, Loader, GitBranch } from "lucide-react";
import { useState, useMemo, useEffect, useCallback, useRef } from "react";

const stateIconMap = {
  busy: { icon: Pencil, color: "var(--accent)", className: "state-icon-busy" },
  waiting: { icon: CircleHelp, color: "var(--yellow)", className: "" },
  idle: { icon: CircleCheck, color: "var(--green)", className: "" },
  running: { icon: CircleCheck, color: "var(--green)", className: "" },
  error: { icon: CircleX, color: "var(--red)", className: "" },
  starting: { icon: Loader, color: "var(--text-muted)", className: "state-icon-spin" },
};

function StateIcon({ state }) {
  const entry = stateIconMap[state] || stateIconMap.idle;
  const Icon = entry.icon;
  return <Icon size={12} style={{ color: entry.color, flexShrink: 0 }} className={entry.className} />;
}

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
 * Build a tree from a flat list of paths.
 * Each node: { path, name, children: [] }
 * A path is nested under another if it's a direct or indirect child.
 */
function buildTree(paths) {
  const sorted = [...paths].sort((a, b) => norm(a).localeCompare(norm(b)));
  const roots = [];
  const nodes = new Map(); // norm(path) -> node

  for (const p of sorted) {
    const n = norm(p);
    const node = { path: p, name: shortPath(p), children: [] };
    nodes.set(n, node);

    // Find deepest parent in the tree
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
function LocationContextMenu({ x, y, path, onExpand, onNewAt, onRemove, onClose }) {
  const menuRef = useRef(null);
  const [pos, setPos] = useState({ x, y });

  // Clamp to viewport on mount
  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const nx = x + rect.width > window.innerWidth ? window.innerWidth - rect.width - 4 : x;
    const ny = y + rect.height > window.innerHeight ? window.innerHeight - rect.height - 4 : y;
    setPos({ x: nx, y: ny });
  }, [x, y]);

  // Dismiss on click-outside or Escape
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
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--bg-elevated)")}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
        onClick={() => { navigator.clipboard.writeText(path); onClose(); }}
      >
        Copy path
      </div>
      <div
        style={itemStyle}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--bg-elevated)")}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
        onClick={() => { onExpand(path); onClose(); }}
      >
        Expand 1 layer
      </div>
      <div
        style={itemStyle}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--bg-elevated)")}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
        onClick={() => { onNewAt(path); onClose(); }}
      >
        Open session here
      </div>
      <div
        style={{ height: "1px", backgroundColor: "var(--border-color)", margin: "4px 0" }}
      />
      <div
        style={{ ...itemStyle, color: "var(--red)" }}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--bg-elevated)")}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
        onClick={() => { onRemove(path); onClose(); }}
      >
        Remove
      </div>
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
  gitStatuses = {},
}) {
  if (!open) return null;

  const active = sessions;

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState(null); // { x, y, path }

  const tree = useMemo(() => buildTree(savedLocations), [savedLocations]);

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

  const renderSession = (s) => {
    const isActive = activeIds.includes(s.id);
    return (
      <div key={s.id} className="group flex items-center">
        <button
          onClick={() => onSelect(s.id)}
          className="flex items-center gap-2 flex-1 text-left px-3 py-1.5 rounded-md text-sm transition-colors min-w-0"
          style={{
            color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
            fontWeight: isActive ? 600 : 400,
            backgroundColor: isActive ? "var(--bg-surface)" : "transparent",
          }}
          onMouseEnter={(e) => {
            if (!isActive) e.currentTarget.style.backgroundColor = "var(--bg-surface)";
          }}
          onMouseLeave={(e) => {
            if (!isActive) e.currentTarget.style.backgroundColor = "transparent";
          }}
        >
          <StateIcon state={s.activityState || s.status} />
          <span className="truncate">{s.name}</span>
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded transition-all flex-shrink-0 mr-1"
          style={{ color: "var(--text-muted)" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--red)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
          title="Close session"
        >
          <X size={12} />
        </button>
      </div>
    );
  };

  function LocationNode({ node, depth = 0 }) {
    const sessionsHere = active.filter((s) => norm(s.workdir) === norm(node.path));
    const hasChildren = node.children.length > 0 || sessionsHere.length > 0;
    const [expanded, setExpanded] = useState(true);

    return (
      <div>
        <div
          className="group flex items-center gap-1 py-0.5 cursor-pointer rounded-md transition-colors"
          style={{
            color: "var(--text-secondary)",
            paddingLeft: `${depth * 12 + 8}px`,
            paddingRight: "8px",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--bg-surface)")}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setCtxMenu({ x: e.clientX, y: e.clientY, path: node.path });
          }}
        >
          {/* Expand/collapse toggle */}
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

          {/* Folder icon + name — click to toggle expand */}
          <button
            className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
            onClick={() => setExpanded(!expanded)}
            onDoubleClick={() => onNewAt(node.path)}
            title={node.path}
          >
            <FolderOpen size={12} style={{ color: "var(--accent)", flexShrink: 0 }} />
            <span className="text-xs truncate">{node.name}</span>
          </button>

          {/* Git status badge */}
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
                  {git.branch.length > 12 ? git.branch.slice(0, 12) + "…" : git.branch}
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
            size={11}
            className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 cursor-pointer"
            style={{ color: "var(--accent)" }}
            onClick={(e) => { e.stopPropagation(); onNewAt(node.path); }}
          />
        </div>

        {/* Expanded children */}
        {expanded && (
          <>
            {/* Sessions at this location */}
            {sessionsHere.length > 0 && (
              <div style={{ paddingLeft: `${depth * 12 + 20}px` }}>
                {sessionsHere.map(renderSession)}
              </div>
            )}
            {/* Child folders */}
            {node.children.map((child) => (
              <LocationNode key={child.path} node={child} depth={depth + 1} />
            ))}
          </>
        )}
      </div>
    );
  }

  return (
    <aside
      className="flex flex-col flex-shrink-0 py-4 px-2 overflow-y-auto h-full"
    >
      {/* New button */}
      <button
        onClick={onNew}
        className="flex items-center gap-2 text-sm font-medium px-3 py-1.5 rounded-md mb-4 transition-colors"
        style={{ color: "var(--text-secondary)" }}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--bg-surface)")}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
        title="New session (Ctrl+Shift+N)"
      >
        <Plus size={15} />
        <span>New</span>
      </button>

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
              <LocationNode key={node.path} node={node} depth={0} />
            ))}
          </div>
        </>
      )}

      {/* Context menu */}
      {ctxMenu && (
        <LocationContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          path={ctxMenu.path}
          onExpand={handleExpand}
          onNewAt={onNewAt}
          onRemove={onRemoveLocation}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </aside>
  );
}
