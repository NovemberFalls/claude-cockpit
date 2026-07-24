/**
 * LocalMetricsPanel — reporting dashboard for the local-lane broker.
 *
 * Renders the broker's read-only aggregates (proxied via
 * GET /api/local/metrics?window=lifetime|24h|session): runs, prompts, tokens,
 * tokens/sec, run-time distribution, and by-session / by-agent / by-lane-class
 * breakdowns. The broker's definitions of run / prompt / session / agent are
 * rendered VERBATIM (broker-team request) so the numbers are never ambiguous.
 *
 * Props:
 *   metrics   — object from GET /api/local/metrics, or null when offline/loading
 *   window    — "lifetime" | "24h" | "session"
 *   setWindow — (w:string) => void
 */

const WINDOWS = [
  { id: "lifetime", label: "Lifetime" },
  { id: "24h", label: "24h" },
  { id: "session", label: "Session" },
];

// Broker-team definitional contract — rendered verbatim, do not paraphrase.
const DEFINITIONS = [
  "run = one completion call to a lane (one jobs.jsonl record)",
  "prompt = one client dispatch identified by distinct X-Trace-Id (untagged runs count as one prompt each, so runs==prompts for untagged clients)",
  "session = X-Client-Id",
  "agent = X-Agent-Id",
];
const TPS_NOTE =
  "tps = completion tokens ÷ wall clock (includes prompt-processing) — a floor on true decode speed, not LM Studio's stats number.";

function fmtInt(n) {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  return n.toLocaleString();
}
function fmtTokens(n) {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}
function fmtMs(n) {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  if (n >= 1000) return (n / 1000).toFixed(1) + "s";
  return Math.round(n) + "ms";
}
function fmtNum(n, digits = 1) {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  return n.toFixed(digits);
}

function Stat({ label, value, sub }) {
  return (
    <div
      style={{
        border: "1px solid var(--border-color)",
        borderRadius: 8,
        padding: "8px 10px",
        background: "var(--bg-surface)",
        minWidth: 0,
      }}
    >
      <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
        {label}
      </div>
      <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary)", marginTop: 2 }}>{value}</div>
      {sub != null && <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

function Breakdown({ title, rows, keyLabel }) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return (
    <div style={{ marginTop: 10 }}>
      <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)", marginBottom: 4 }}>
        {title}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
          <thead>
            <tr style={{ color: "var(--text-muted)", textAlign: "right" }}>
              <th style={{ textAlign: "left", padding: "2px 6px 2px 0", fontWeight: 500 }}>{keyLabel}</th>
              <th style={{ padding: "2px 6px", fontWeight: 500 }}>runs</th>
              <th style={{ padding: "2px 6px", fontWeight: 500 }}>prompts</th>
              <th style={{ padding: "2px 0 2px 6px", fontWeight: 500 }}>tokens</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const tot = r.tokens_total || {};
              const tokens = (tot.prompt || 0) + (tot.completion || 0);
              const key = r.key ?? r.id ?? r.name ?? `#${i + 1}`;
              return (
                <tr key={key} style={{ color: "var(--text-secondary)", textAlign: "right" }}>
                  <td
                    style={{
                      textAlign: "left",
                      padding: "2px 6px 2px 0",
                      color: "var(--text-primary)",
                      maxWidth: 140,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={String(key)}
                  >
                    {String(key)}
                  </td>
                  <td style={{ padding: "2px 6px" }}>{fmtInt(r.runs_total)}</td>
                  <td style={{ padding: "2px 6px" }}>{fmtInt(r.prompts_total)}</td>
                  <td style={{ padding: "2px 0 2px 6px" }}>{fmtTokens(tokens)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function LocalMetricsPanel({ metrics, window, setWindow }) {
  const offline = !metrics || metrics.reachable === false;

  const runs = metrics?.runs_total;
  const prompts = metrics?.prompts_total;
  const runsPerPrompt =
    typeof runs === "number" && typeof prompts === "number" && prompts > 0 ? runs / prompts : null;
  const tokTot = metrics?.tokens_total || {};
  const totalTokens = (tokTot.prompt || 0) + (tokTot.completion || 0);
  const tps = metrics?.tokens_per_sec || {};
  const rt = metrics?.run_time_ms || {};

  return (
    <div style={{ padding: "10px 12px" }}>
      {/* Window selector */}
      <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
        {WINDOWS.map((w) => (
          <button
            key={w.id}
            onClick={() => setWindow(w.id)}
            className="text-[11px] px-2 py-0.5 rounded-full transition-colors"
            style={{
              color: w.id === window ? "var(--accent)" : "var(--text-secondary)",
              border: `1px solid ${w.id === window ? "var(--accent)" : "var(--border-color)"}`,
              background: "var(--bg-surface)",
              fontWeight: w.id === window ? 600 : 400,
            }}
            aria-pressed={w.id === window}
          >
            {w.label}
          </button>
        ))}
        {metrics?.persisted != null && (
          <span
            style={{ marginLeft: "auto", alignSelf: "center", fontSize: 10, color: "var(--text-muted)" }}
            title={
              metrics.persisted
                ? "Recomputed from jobs.jsonl — survives broker restart"
                : "Since broker start — resets on broker restart"
            }
          >
            {metrics.persisted ? "persisted" : "since broker start"}
          </span>
        )}
      </div>

      {offline ? (
        <div className="text-xs" style={{ color: "var(--text-muted)" }}>
          Broker offline — no metrics for this window.
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <Stat label="Runs" value={fmtInt(runs)} />
            <Stat label="Prompts" value={fmtInt(prompts)} sub={runsPerPrompt != null ? `${fmtNum(runsPerPrompt, 2)} runs/prompt` : null} />
            <Stat
              label="Tokens"
              value={fmtTokens(totalTokens)}
              sub={`${fmtTokens(tokTot.prompt)} in · ${fmtTokens(tokTot.completion)} out`}
            />
            <Stat label="Tokens/sec" value={fmtNum(tps.current, 0)} sub={`avg ${fmtNum(tps.avg, 1)}`} />
          </div>

          <div style={{ marginTop: 8 }}>
            <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)", marginBottom: 4 }}>
              Run time per prompt
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 11,
                color: "var(--text-secondary)",
                gap: 6,
              }}
            >
              <span>min {fmtMs(rt.min)}</span>
              <span>avg {fmtMs(rt.avg)}</span>
              <span>p50 {fmtMs(rt.p50)}</span>
              <span>p95 {fmtMs(rt.p95)}</span>
              <span>max {fmtMs(rt.max)}</span>
            </div>
          </div>

          <Breakdown title="By session" rows={metrics?.by_session} keyLabel="session" />
          <Breakdown title="By agent" rows={metrics?.by_agent} keyLabel="agent" />
          <Breakdown title="By lane class" rows={metrics?.by_lane_class} keyLabel="lane" />

          {/* Verbatim broker definitions — the numbers mean exactly this. */}
          <details style={{ marginTop: 10 }}>
            <summary
              className="text-[10px] uppercase tracking-wider"
              style={{ color: "var(--text-muted)", cursor: "pointer" }}
            >
              What these words mean
            </summary>
            <ul style={{ margin: "6px 0 0", padding: "0 0 0 14px", fontSize: 10, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {DEFINITIONS.map((d) => (
                <li key={d}>{d}</li>
              ))}
              <li>{TPS_NOTE}</li>
            </ul>
          </details>
        </>
      )}
    </div>
  );
}
