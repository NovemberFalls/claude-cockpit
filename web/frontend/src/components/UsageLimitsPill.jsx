import { useCallback, useEffect, useRef, useState } from "react";
import { Gauge } from "lucide-react";

/**
 * Subscription limits follow the focused pane. Claude reads account usage;
 * Codex reads observed native windows from that terminal's bound rollout.
 * Never infer quotas from token counts or substitute another provider's data.
 * Unavailable observations show their reason, rather than a misleading 0%.
 */

// 5 minutes. A 60s poll earned repeated HTTP 429s from Anthropic: this endpoint
// is built for a human running /status occasionally, not a poller. Utilization
// moves slowly enough that 5 minutes loses nothing, and opening the popover
// forces a fresh read anyway.
const POLL_MS = 300_000;

/** Bar colour by how close to the cap we are. Severity comes from the API. */
function toneFor(percent, severity) {
  if (severity === "critical" || percent >= 90) return "var(--cc-error, var(--error))";
  if (severity === "warning" || percent >= 75) return "var(--cc-waiting, var(--warning))";
  return "var(--cc-accent, var(--accent))";
}

/** "4h 12m" / "3d 2h" — how long until the window resets. */
function untilReset(resetsAt) {
  if (!resetsAt) return null;
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const mins = Math.floor(ms / 60_000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  return `${mins}m`;
}

/** Local wall-clock time of the reset, matching how the CLI presents it. */
function resetClock(resetsAt) {
  if (!resetsAt) return null;
  const d = new Date(resetsAt);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function LimitBar({ limit }) {
  const pct = Math.max(0, Math.min(100, limit.percent));
  const tone = toneFor(pct, limit.severity);
  const remaining = untilReset(limit.resets_at);
  const clock = resetClock(limit.resets_at);

  return (
    <div style={{ padding: "9px 12px" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 8,
          marginBottom: 5,
        }}
      >
        <span style={{ fontSize: 12, color: "var(--cc-fg, var(--text-primary))", fontWeight: 600 }}>
          {limit.label}
        </span>
        <span style={{ fontSize: 12, color: tone, fontWeight: 700, whiteSpace: "nowrap" }}>
          {Math.round(limit.percent)}%
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${limit.label} usage`}
        aria-valuenow={Math.round(limit.percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{
          height: 6,
          borderRadius: 999,
          backgroundColor: "var(--bg-surface, rgba(127,127,127,.25))",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            backgroundColor: tone,
            borderRadius: 999,
            transition: "width .3s ease",
          }}
        />
      </div>
      {clock && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
          Resets {clock}
          {remaining ? ` · in ${remaining}` : ""}
        </div>
      )}
    </div>
  );
}

export default function UsageLimitsPill(props) {
  // The keyed boundary clears data synchronously when focus changes. A pending
  // response from another pane must never paint under the new provider label.
  const session = props.session === undefined ? { harness: "claude-code" } : props.session;
  const identity = session ? `${session.harness || "claude-code"}:${session.terminalId || ""}` : "none";
  return <UsageLimitsView key={identity} {...props} session={session} />;
}

function UsageLimitsView({ open, onToggle, onClose, session }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const request = useRef(0);
  const mounted = useRef(true);
  const harness = session?.harness || "claude-code";
  const terminalId = session?.terminalId;
  const hasSession = Boolean(session);
  const isCodex = hasSession && harness === "codex";
  const provider = !hasSession ? "Session" : isCodex ? "Codex" : "Claude";

  const load = useCallback(async (force = false) => {
    const generation = ++request.current;
    if (!hasSession || (harness === "codex" && !terminalId)) {
      setData({ available: false, detail: !hasSession ? "Focus a session to view its subscription limits." : "Codex session limits are not available yet." });
      setLoading(false);
      return;
    }
    try {
      const url = harness === "codex"
        ? `/api/terminals/${encodeURIComponent(terminalId)}/usage`
        : `/api/anthropic/usage${force ? "?refresh=true" : ""}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const payload = await res.json();
      if (!mounted.current || generation !== request.current) return;
      setData(harness === "codex" ? payload.subscription_limits || {
        available: false, detail: "No subscription limits have been observed in this Codex session.",
      } : payload);
    } catch {
      // Best-effort background read — a failed poll keeps the last known
      // state rather than blanking a panel the user may be reading.
    } finally {
      if (mounted.current && generation === request.current) setLoading(false);
    }
  }, [hasSession, harness, terminalId]);

  useEffect(() => {
    mounted.current = true;
    load();
    const id = setInterval(() => load(), isCodex ? 15_000 : POLL_MS);
    return () => { mounted.current = false; request.current += 1; clearInterval(id); };
  }, [load, isCodex]);

  // Opening the popover is an explicit "show me now" — bypass the server cache.
  useEffect(() => {
    if (open) load(true);
  }, [open, load]);

  const expired = isCodex && data?.limits?.some((limit) => limit.resets_at && new Date(limit.resets_at).getTime() <= Date.now());
  const limits = data?.available && Array.isArray(data.limits)
    ? data.limits.filter((limit) => Number.isFinite(limit.percent)
      && !(isCodex && limit.resets_at && new Date(limit.resets_at).getTime() <= Date.now())) : [];
  // The pill shows the tightest constraint, since that is the one that will
  // actually stop work.
  const peak = limits.length ? Math.max(...limits.map((l) => l.percent)) : null;
  const peakSeverity =
    limits.find((l) => l.percent === peak)?.severity || "normal";

  return (
    <div className="relative">
      <button
        onClick={onToggle}
        className="flex items-center transition-colors hover-bg-surface"
        style={{
          gap: 5,
          padding: peak === null ? 5 : "4px 9px",
          borderRadius: peak === null ? 7 : 999,
          color:
            peak === null
              ? "var(--cc-dim, var(--text-secondary))"
              : toneFor(peak, peakSeverity),
          border: peak === null ? "none" : "1px solid var(--border-color)",
        }}
        title={`${provider} subscription limits${isCodex ? " — observed in the focused session" : ""}`}
        aria-label={`${provider} subscription usage limits`}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <Gauge size={15} />
        {peak !== null && (
          <span style={{ fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}>
            {Math.round(peak)}%
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden="true" />
          <div
            role="dialog"
            aria-label={`${provider} subscription limits`}
            className="absolute right-0 mt-1 rounded-lg z-50"
            style={{
              width: 300,
              maxHeight: "70vh",
              overflowY: "auto",
              backgroundColor: "var(--bg-elevated)",
              border: "1px solid var(--border-color)",
              boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
            }}
          >
            <div
              style={{
                padding: "8px 12px",
                borderBottom: "1px solid var(--border-color)",
              }}
            >
              <span
                className="text-[11px] uppercase tracking-wider"
                style={{ color: "var(--text-secondary)", fontWeight: 600 }}
              >
                {provider} Limits
              </span>
            </div>

            {loading && !data ? (
              <div style={{ padding: "12px", fontSize: 12, color: "var(--text-muted)" }}>
                Loading…
              </div>
            ) : data?.available && limits.length > 0 ? (
              <>
                {limits.map((limit) => (
                  <LimitBar key={limit.kind} limit={limit} />
                ))}
                {data.extra_usage && (
                  <div
                    style={{
                      padding: "8px 12px",
                      borderTop: "1px solid var(--border-color)",
                      fontSize: 11,
                      color: "var(--text-muted)",
                    }}
                  >
                    Extra usage enabled
                    {data.extra_usage.spend_limit_reached ? " · spend limit reached" : ""}
                  </div>
                )}
                <div
                  style={{
                    padding: "8px 12px",
                    borderTop: "1px solid var(--border-color)",
                    fontSize: 11,
                    color: "var(--text-muted)",
                  }}
                >
                  {isCodex ? data.detail || "Observed in this Codex session; may lag account usage." : <>
                    Reported by Anthropic for this account — the same figures as
                    <code style={{ margin: "0 3px" }}>/status</code>.
                  </>}
                </div>
              </>
            ) : (
              /* Never render an empty bar here: "we could not read your usage"
                 and "0% used" look identical and mean opposite things. */
              <div style={{ padding: "12px", fontSize: 12, color: "var(--text-muted)" }}>
                {expired ? "Last observed Codex limits have reset. Waiting for a new observation." : data?.detail || "Usage limits are unavailable."}
              </div>
            )}
            {isCodex && data?.observed_at && (
              <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-muted)" }}>
                Observed {new Date(data.observed_at).toLocaleString()}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
