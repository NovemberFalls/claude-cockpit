/**
 * WorkspacePanel — Right sidebar showing the agent workspace hierarchy.
 *
 * Displays all active agent workspace folders grouped into trees. Clicking a
 * file opens it in the built-in FileViewer (rendered below the tree). Status
 * badges are color-coded by agent state.
 *
 * Props:
 *   workspaces  Array<{ compound_id, agent_name, status, files[] }>
 *               (from /ws/workspaces WebSocket, refreshed on file events)
 *   onClose     () => void  — hides the panel
 */

import { useState, useEffect, useCallback } from "react";
import { X, ChevronRight, ChevronDown, FileText, RefreshCw } from "lucide-react";
import { marked } from "marked";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a forest (array of root nodes) from a flat workspace list. */
function buildTree(workspaces) {
  const byId = {};
  for (const ws of workspaces) byId[ws.compound_id] = { ...ws, children: [] };

  const roots = [];
  for (const ws of workspaces) {
    const parts = ws.compound_id.split("+");
    if (parts.length === 1) {
      roots.push(byId[ws.compound_id]);
    } else {
      const parentId = parts.slice(0, -1).join("+");
      if (byId[parentId]) {
        byId[parentId].children.push(byId[ws.compound_id]);
      } else {
        // Parent not in list — treat as root
        roots.push(byId[ws.compound_id]);
      }
    }
  }
  return roots;
}

const STATUS_COLORS = {
  starting:  "var(--text-muted)",
  working:   "var(--yellow)",
  idle:      "var(--green)",
  complete:  "var(--accent)",
  error:     "var(--red)",
  compacted: "var(--purple)",
  unknown:   "var(--text-muted)",
};

const STATUS_LABEL = {
  starting:  "starting",
  working:   "working",
  idle:      "idle",
  complete:  "done",
  error:     "error",
  compacted: "compacted",
  unknown:   "?",
};

// Files the viewer should render as markdown (not plain text)
const MD_EXTS = new Set([".md", ".markdown"]);

function isMarkdown(filename) {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 && MD_EXTS.has(filename.slice(dot).toLowerCase());
}

// ---------------------------------------------------------------------------
// TreeNode — recursive workspace node
// ---------------------------------------------------------------------------

function TreeNode({ node, depth = 0, onFileClick, activeFile }) {
  const [expanded, setExpanded] = useState(depth === 0);
  const hasChildren = node.children && node.children.length > 0;
  const statusColor = STATUS_COLORS[node.status] || STATUS_COLORS.unknown;
  const statusLabel = STATUS_LABEL[node.status] || node.status;
  const shortId = node.compound_id.split("+").pop();

  return (
    <div style={{ paddingLeft: depth > 0 ? 12 : 0 }}>
      {/* Node header */}
      <div
        className="flex items-center gap-1 px-2 py-1 rounded cursor-pointer hover-bg-surface"
        style={{ fontSize: 12 }}
        onClick={() => setExpanded((v) => !v)}
      >
        {hasChildren ? (
          expanded ? (
            <ChevronDown size={11} style={{ flexShrink: 0, color: "var(--text-muted)" }} />
          ) : (
            <ChevronRight size={11} style={{ flexShrink: 0, color: "var(--text-muted)" }} />
          )
        ) : (
          <span style={{ width: 11, flexShrink: 0 }} />
        )}

        {/* Status dot */}
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            backgroundColor: statusColor,
            flexShrink: 0,
            boxShadow: `0 0 4px ${statusColor}`,
          }}
        />

        <span
          className="flex-1 truncate font-medium"
          style={{ color: "var(--text-primary)" }}
          title={node.compound_id}
        >
          {node.agent_name}
        </span>

        <span
          style={{
            fontSize: 9,
            color: statusColor,
            fontFamily: "monospace",
            flexShrink: 0,
          }}
        >
          {statusLabel}
        </span>

        <span
          style={{
            fontSize: 9,
            color: "var(--text-muted)",
            fontFamily: "monospace",
            flexShrink: 0,
            marginLeft: 2,
          }}
        >
          {shortId}
        </span>
      </div>

      {/* Files */}
      {expanded && node.files && node.files.length > 0 && (
        <div style={{ paddingLeft: depth === 0 ? 22 : 22 }}>
          {node.files
            .filter((f) => f !== "_meta.json")
            .map((filename) => {
              const fileKey = `${node.compound_id}/${filename}`;
              const isActive = activeFile === fileKey;
              return (
                <div
                  key={filename}
                  className="flex items-center gap-1 px-2 py-0.5 rounded cursor-pointer hover-bg-surface"
                  style={{
                    fontSize: 11,
                    color: isActive ? "var(--accent)" : "var(--text-secondary)",
                    backgroundColor: isActive ? "var(--bg-surface)" : undefined,
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onFileClick(node.compound_id, filename);
                  }}
                >
                  <FileText size={10} style={{ flexShrink: 0, opacity: 0.7 }} />
                  <span className="truncate">{filename}</span>
                </div>
              );
            })}
        </div>
      )}

      {/* Children */}
      {expanded &&
        node.children.map((child) => (
          <TreeNode
            key={child.compound_id}
            node={child}
            depth={depth + 1}
            onFileClick={onFileClick}
            activeFile={activeFile}
          />
        ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FileViewer — embedded below the tree
// ---------------------------------------------------------------------------

function FileViewer({ compound_id, filename, onClose }) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastFetch, setLastFetch] = useState(0);

  const fetchContent = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(compound_id)}/read?filename=${encodeURIComponent(filename)}`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setContent(data.content || "");
      setError(null);
      setLastFetch(Date.now());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [compound_id, filename]);

  // Initial fetch + 3s live polling
  useEffect(() => {
    setLoading(true);
    setContent("");
    setError(null);
    fetchContent();
    const id = setInterval(fetchContent, 3000);
    return () => clearInterval(id);
  }, [fetchContent]);

  const renderedHtml = isMarkdown(filename)
    ? marked.parse(content || "")
    : null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        borderTop: "1px solid var(--border-color)",
        minHeight: 0,
        flex: 1,
      }}
    >
      {/* File viewer header */}
      <div
        className="flex items-center gap-2 px-3 flex-shrink-0"
        style={{
          height: 32,
          backgroundColor: "var(--bg-elevated)",
          borderBottom: "1px solid var(--border-color)",
        }}
      >
        <FileText size={11} style={{ color: "var(--accent)", flexShrink: 0 }} />
        <span
          className="flex-1 truncate"
          style={{ fontSize: 11, color: "var(--text-secondary)", fontFamily: "monospace" }}
          title={`${compound_id}/${filename}`}
        >
          {filename}
        </span>
        {lastFetch > 0 && (
          <span style={{ fontSize: 9, color: "var(--text-muted)" }}>
            live
          </span>
        )}
        <button
          onClick={onClose}
          className="hover-color-red"
          style={{ color: "var(--text-muted)", display: "flex", padding: 2 }}
        >
          <X size={11} />
        </button>
      </div>

      {/* Content */}
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: "10px 12px",
          fontSize: 12,
          lineHeight: 1.6,
          color: "var(--text-primary)",
        }}
      >
        {loading && (
          <span style={{ color: "var(--text-muted)" }}>Loading…</span>
        )}
        {error && (
          <span style={{ color: "var(--red)" }}>{error}</span>
        )}
        {!loading && !error && renderedHtml !== null && (
          <div
            className="workspace-markdown"
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
          />
        )}
        {!loading && !error && renderedHtml === null && (
          <pre
            style={{
              margin: 0,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontFamily: "monospace",
              fontSize: 11,
            }}
          >
            {content || "(empty)"}
          </pre>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WorkspacePanel — main export
// ---------------------------------------------------------------------------

export default function WorkspacePanel({ workspaces = [], onClose }) {
  const [openFile, setOpenFile] = useState(null); // { compound_id, filename } | null

  const tree = buildTree(workspaces);
  const activeFileKey = openFile
    ? `${openFile.compound_id}/${openFile.filename}`
    : null;

  function handleFileClick(compound_id, filename) {
    setOpenFile({ compound_id, filename });
  }

  const isEmpty = workspaces.length === 0;

  return (
    <div
      style={{
        width: 280,
        flexShrink: 0,
        borderLeft: "1px solid var(--border-color)",
        backgroundColor: "var(--panel-bg, var(--bg))",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      {/* Panel header */}
      <div
        className="flex items-center gap-2 px-3 flex-shrink-0"
        style={{
          height: 36,
          borderBottom: "1px solid var(--border-color)",
          backgroundColor: "var(--bg-elevated)",
        }}
      >
        <span
          style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", flex: 1, letterSpacing: "0.05em" }}
        >
          WORKSPACES
        </span>
        <span
          style={{
            fontSize: 10,
            color: "var(--text-muted)",
            backgroundColor: "var(--bg-surface)",
            borderRadius: 10,
            padding: "1px 7px",
            border: "1px solid var(--border-color)",
          }}
        >
          {workspaces.length}
        </span>
        <button
          onClick={onClose}
          className="hover-color-red"
          style={{ color: "var(--text-muted)", display: "flex", padding: 2 }}
        >
          <X size={13} />
        </button>
      </div>

      {/* Tree */}
      <div
        style={{
          flex: openFile ? "0 0 auto" : 1,
          maxHeight: openFile ? "45%" : undefined,
          overflow: "auto",
          padding: "6px 0",
        }}
      >
        {isEmpty ? (
          <div
            className="flex flex-col items-center justify-center"
            style={{ padding: "24px 16px", color: "var(--text-muted)", fontSize: 12, textAlign: "center", gap: 8 }}
          >
            <RefreshCw size={20} style={{ opacity: 0.4 }} />
            <span>No agent workspaces yet.</span>
            <span style={{ fontSize: 11 }}>
              Spawn an orchestrator session to see its workspace tree here.
            </span>
          </div>
        ) : (
          tree.map((node) => (
            <TreeNode
              key={node.compound_id}
              node={node}
              depth={0}
              onFileClick={handleFileClick}
              activeFile={activeFileKey}
            />
          ))
        )}
      </div>

      {/* Embedded file viewer */}
      {openFile && (
        <FileViewer
          compound_id={openFile.compound_id}
          filename={openFile.filename}
          onClose={() => setOpenFile(null)}
        />
      )}
    </div>
  );
}
