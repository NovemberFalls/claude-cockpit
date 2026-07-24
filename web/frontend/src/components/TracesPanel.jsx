/**
 * TracesPanel — recent trace roots + drill-down into a trace's node tree.
 *
 * Renders GET /api/local/{provider}/traces (agent, runs, total wall, last
 * activity). Clicking a trace fetches GET /api/local/{provider}/trace/{id}
 * and renders an indented tree built from nodes+edges (parent -> child);
 * each node line: agent/client · lane class · wall_ms · tokens if non-null.
 *
 * Props:
 *   traces     — object from GET /api/local/{provider}/traces, or null when offline/loading
 *   providerId — id used to build the drill-down fetch URL
 */

import { useState } from "react";

function fmtMs(n) {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  if (n >= 1000) return (n / 1000).toFixed(1) + "s";
  return Math.round(n) + "ms";
}
function fmtTokens(t) {
  if (!t) return null;
  const { prompt, completion } = t;
  if (prompt == null && completion == null) return null;
  return `${prompt ?? "—"}/${completion ?? "—"} tok`;
}
function fmtTs(ts) {
  if (!ts) return "—";
  try { return new Date(ts).toLocaleTimeString(); } catch (_) { return String(ts); }
}

/** Indented parent -> child tree for a single trace closure. */
function TraceTree({ trace, onClose }) {
  const nodes = Array.isArray(trace?.nodes) ? trace.nodes : [];
  const edges = Array.isArray(trace?.edges) ? trace.edges : [];
  const byParent = new Map();
  for (const [parent, child] of edges) {
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(child);
  }
  const byId = new Map(nodes.map((n) => [n.trace_id, n]));
  const childIds = new Set(edges.map(([, c]) => c));
  const rootIds = nodes.map((n) => n.trace_id).filter((id) => !childIds.has(id));

  const renderNode = (traceId, depth) => {
    const node = byId.get(traceId);
    if (!node) return null;
    const tokens = fmtTokens(node.tokens);
    return (
      <div key={traceId}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", padding: "2px 0", paddingLeft: depth * 14 }}>
          <span style={{ width: 5, height: 5, borderRadius: 999, background: "var(--text-muted)", flexShrink: 0 }} />
          <span style={{ fontSize: 11, color: "var(--text-primary)", fontWeight: 600 }}>
            {node.agent || node.client_id || "—"}
          </span>
          <span style={{ fontSize: 10, color: "var(--text-muted)" }}>· {node.lane_class || "—"}</span>
          <span style={{ fontSize: 10, color: "var(--text-secondary)" }}>· {fmtMs(node.wall_ms)}</span>
          {tokens && <span style={{ fontSize: 10, color: "var(--text-muted)" }}>· {tokens}</span>}
        </div>
        {(byParent.get(traceId) || []).map((childId) => renderNode(childId, depth + 1))}
      </div>
    );
  };

  return (
    <div style={{ marginTop: 6, marginBottom: 6, paddingTop: 6, paddingLeft: 15, borderTop: "1px solid var(--border-color)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <span className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
          {trace?.trace_id}
        </span>
        <button
          onClick={onClose}
          className="text-[10px]"
          style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}
        >
          close
        </button>
      </div>
      {rootIds.length === 0 ? (
        <div className="text-xs" style={{ color: "var(--text-muted)" }}>no nodes</div>
      ) : (
        rootIds.map((id) => renderNode(id, 0))
      )}
    </div>
  );
}

export default function TracesPanel({ traces, providerId }) {
  const [openTraceId, setOpenTraceId] = useState(null);
  const [openTrace, setOpenTrace] = useState(null);

  const offline = !traces || traces.reachable === false;

  const handleClick = async (traceId) => {
    if (openTraceId === traceId) { setOpenTraceId(null); setOpenTrace(null); return; }
    setOpenTraceId(traceId);
    setOpenTrace(null);
    try {
      const res = await fetch(`/api/local/${encodeURIComponent(providerId)}/trace/${encodeURIComponent(traceId)}`);
      if (res.ok) setOpenTrace(await res.json());
    } catch (_) {
      // silent — best-effort
    }
  };

  if (offline) {
    return (
      <div style={{ padding: "10px 12px" }}>
        <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)", marginBottom: 6 }}>
          Traces
        </div>
        <div className="text-xs" style={{ color: "var(--text-muted)" }}>
          Broker offline — no trace data.
        </div>
      </div>
    );
  }

  const list = Array.isArray(traces.traces) ? traces.traces : [];

  return (
    <div style={{ padding: "10px 12px" }}>
      <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)", marginBottom: 6 }}>
        Traces
      </div>
      {list.length === 0 ? (
        <div className="text-xs" style={{ color: "var(--text-muted)" }}>no traces yet</div>
      ) : (
        list.map((t) => (
          <div key={t.trace_id}>
            <div
              onClick={() => handleClick(t.trace_id)}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", cursor: "pointer" }}
              title={t.trace_id}
            >
              <span style={{ width: 7, height: 7, borderRadius: 999, background: "var(--text-secondary)", flexShrink: 0 }} />
              <span
                style={{
                  fontSize: 12, fontWeight: 600, color: "var(--text-primary)",
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 130,
                }}
              >
                {t.agent || t.trace_id}
              </span>
              <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{t.runs_total} runs</span>
              <span style={{ fontSize: 10, color: "var(--text-muted)", marginLeft: "auto", flexShrink: 0 }}>
                {fmtMs(t.wall_ms_total)} · {fmtTs(t.last_ts)}
              </span>
            </div>
            {openTraceId === t.trace_id && (
              openTrace ? (
                <TraceTree trace={openTrace} onClose={() => { setOpenTraceId(null); setOpenTrace(null); }} />
              ) : (
                <div className="text-xs" style={{ color: "var(--text-muted)", padding: "2px 0 2px 15px" }}>loading…</div>
              )
            )}
          </div>
        ))
      )}
    </div>
  );
}
