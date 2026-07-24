/**
 * LaneQueuePanel — live view of the local-lane broker queue.
 *
 * Renders the broker's read-only /queue snapshot (proxied via
 * GET /api/local/queue): the in-flight job + class, queued jobs in order,
 * estimated seconds-to-clear, and spill count. Includes a spill-threshold
 * slider that is INERT for now — the broker contract is read-only, so the
 * write endpoint (POST /api/local/spill) currently returns 501. The slider
 * exists so it lights up the moment the broker ships a control endpoint.
 *
 * Props:
 *   queue        — object from GET /api/local/queue, or null when offline/loading
 *   onSpillChange — (value:number) => void, called on slider commit (currently inert)
 */

/** Read the in-flight job from any of the broker's plausible field names. */
function readInFlight(q) {
  return q?.in_flight ?? q?.inflight ?? q?.current ?? null;
}

/** Read the queued list (in order) from any of the broker's plausible field names. */
function readQueued(q) {
  const v = q?.queued ?? q?.queue ?? [];
  return Array.isArray(v) ? v : [];
}

/** Read the spill count from any of the broker's plausible field names. */
function readSpill(q) {
  return q?.spill ?? q?.spill_count ?? 0;
}

function jobLabel(job) {
  if (!job) return null;
  const cls = job.class ?? job.lane_class ?? job.lane ?? "";
  const id = job.id ?? job.trace_id ?? job.job_id ?? "";
  const shortId = typeof id === "string" && id.length > 10 ? id.slice(0, 10) + "…" : id;
  return { cls: String(cls || "—"), id: String(shortId || "") };
}

function Row({ dotColor, primary, secondary }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
      <span style={{ width: 7, height: 7, borderRadius: 999, background: dotColor, flexShrink: 0 }} />
      <span
        style={{
          fontSize: 12,
          color: "var(--text-primary)",
          fontWeight: 600,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {primary}
      </span>
      {secondary != null && (
        <span style={{ fontSize: 11, color: "var(--text-muted)", marginLeft: "auto", flexShrink: 0 }}>
          {secondary}
        </span>
      )}
    </div>
  );
}

export default function LaneQueuePanel({ queue, onSpillChange }) {
  const offline = !queue || queue.reachable === false;

  if (offline) {
    return (
      <div style={{ padding: "10px 12px" }}>
        <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)", marginBottom: 6 }}>
          Lane Queue
        </div>
        <div className="text-xs" style={{ color: "var(--text-muted)" }}>
          Broker offline — no queue data. (Expecting broker at <code>127.0.0.1:1235</code>.)
        </div>
      </div>
    );
  }

  const inFlight = jobLabel(readInFlight(queue));
  const queued = readQueued(queue);
  const spill = readSpill(queue);
  const clearSec = queue.estimated_clear_seconds;

  return (
    <div style={{ padding: "10px 12px" }}>
      <div
        className="text-[10px] uppercase tracking-wider"
        style={{ color: "var(--text-muted)", marginBottom: 6, display: "flex", justifyContent: "space-between" }}
      >
        <span>Lane Queue</span>
        {typeof clearSec === "number" && (
          <span style={{ color: "var(--text-secondary)" }}>clears ~{Math.round(clearSec)}s</span>
        )}
      </div>

      {inFlight ? (
        <Row dotColor="var(--accent)" primary={`▶ ${inFlight.cls}`} secondary={inFlight.id || "in flight"} />
      ) : (
        <Row dotColor="var(--text-muted)" primary="idle — no job in flight" />
      )}

      {queued.length === 0 ? (
        <div className="text-xs" style={{ color: "var(--text-muted)", padding: "4px 0 2px 15px" }}>
          nothing queued
        </div>
      ) : (
        queued.map((job, i) => {
          const j = jobLabel(job);
          return (
            <Row
              key={j.id || i}
              dotColor="var(--text-secondary)"
              primary={`${i + 1}. ${j.cls}`}
              secondary={j.id}
            />
          );
        })
      )}

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 8,
          paddingTop: 8,
          borderTop: "1px solid var(--border-color)",
          fontSize: 11,
          color: "var(--text-secondary)",
        }}
      >
        <span>queued: {queued.length}</span>
        <span>spill: {spill}</span>
      </div>

      {/* Spill threshold — inert until the broker ships a control endpoint. */}
      <div style={{ marginTop: 10 }}>
        <label
          className="text-[10px] uppercase tracking-wider"
          style={{ color: "var(--text-muted)", display: "flex", justifyContent: "space-between" }}
        >
          <span>Spill threshold</span>
          <span style={{ fontStyle: "italic", textTransform: "none", letterSpacing: 0 }}>
            pending broker control endpoint
          </span>
        </label>
        <input
          type="range"
          min={0}
          max={32}
          defaultValue={typeof queue.spill_threshold === "number" ? queue.spill_threshold : 8}
          disabled
          onChange={(e) => onSpillChange?.(Number(e.target.value))}
          title="Read-only for now — the broker exposes no spill-control endpoint yet."
          style={{ width: "100%", marginTop: 4, opacity: 0.4, cursor: "not-allowed" }}
        />
      </div>
    </div>
  );
}
