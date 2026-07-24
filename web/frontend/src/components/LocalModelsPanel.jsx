/**
 * LocalModelsPanel — list of models known to the selected provider's
 * management API.
 *
 * Renders GET /api/local/{provider}/models: id, quantization, arch, max
 * context length, and loaded state. Loaded models are highlighted. Offline
 * state mirrors LaneQueuePanel.
 *
 * Props:
 *   models — object from GET /api/local/{provider}/models, or null when offline/loading
 */

function fmtCtx(n) {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  if (n >= 1000) return (n % 1000 === 0 ? n / 1000 : (n / 1000).toFixed(1)) + "k";
  return String(n);
}

export default function LocalModelsPanel({ models }) {
  const offline = !models || models.reachable === false;

  if (offline) {
    return (
      <div style={{ padding: "10px 12px" }}>
        <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)", marginBottom: 6 }}>
          Models
        </div>
        <div className="text-xs" style={{ color: "var(--text-muted)" }}>
          Provider offline — no models data.
        </div>
      </div>
    );
  }

  const list = Array.isArray(models.models) ? models.models : [];

  return (
    <div style={{ padding: "10px 12px" }}>
      <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)", marginBottom: 6 }}>
        Models
      </div>
      {list.length === 0 ? (
        <div className="text-xs" style={{ color: "var(--text-muted)" }}>no models reported</div>
      ) : (
        list.map((m, i) => {
          const loaded = m.state === "loaded";
          return (
            <div
              key={m.id || i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 0",
                opacity: loaded ? 1 : 0.7,
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 999,
                  flexShrink: 0,
                  background: loaded ? "var(--accent)" : "var(--text-muted)",
                }}
              />
              <span
                style={{
                  fontSize: 12,
                  fontWeight: loaded ? 600 : 400,
                  color: "var(--text-primary)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  maxWidth: 150,
                }}
                title={m.id || ""}
              >
                {m.id || "—"}
              </span>
              <span style={{ fontSize: 10, color: "var(--text-muted)", marginLeft: "auto", flexShrink: 0, textAlign: "right" }}>
                {[m.arch, m.quantization].filter(Boolean).join(" · ") || "—"}
              </span>
              <span style={{ fontSize: 10, color: "var(--text-secondary)", flexShrink: 0, minWidth: 60, textAlign: "right" }}>
                {fmtCtx(m.loaded_context_length)} / {fmtCtx(m.max_context_length)}
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}
