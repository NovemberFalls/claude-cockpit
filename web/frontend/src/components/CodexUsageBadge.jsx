function tokens(value) {
  if (!Number.isFinite(value)) return "unknown";
  return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export default function CodexUsageBadge({ usage }) {
  const known = usage?.usage_available === true;
  const contextKnown = Number.isFinite(usage?.context_tokens) && Number.isFinite(usage?.context_window) && usage.context_window > 0;
  const percent = contextKnown ? Math.max(0, Math.min(100, Math.round(100 * usage.context_tokens / usage.context_window))) : null;
  const contextColor = percent > 75 ? "var(--cc-error, var(--red))" : percent > 50 ? "var(--cc-waiting, var(--yellow))" : "var(--cc-idle, var(--green))";
  const cost = usage?.est_cost_usd;
  return (
    <div className="flex flex-wrap items-center gap-2 text-[10px]" style={{ color: "var(--cc-muted)", minWidth: 0 }} data-testid="codex-usage">
      {usage?.binding_status === "last_known" && <span title="Showing the last identified conversation. The current CLI conversation could not be verified yet.">Last known</span>}
      <span className="flex items-center gap-1" title={contextKnown ? `Context used: ${usage.context_tokens.toLocaleString()} of ${usage.context_window.toLocaleString()} tokens (${percent}%). Latest Codex turn, not cumulative session tokens.` : "Codex has not reported its current context usage and limit yet."}>
        <svg width="20" height="20" viewBox="0 0 20 20" role="meter" aria-label="Context window used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined} aria-valuetext={percent === null ? "Unknown" : `${percent}%`} style={{ flexShrink: 0 }}>
          <circle cx="10" cy="10" r="7" fill="none" stroke="var(--cc-border, rgba(255,255,255,.1))" strokeWidth="2.5" />
          {percent !== null && <circle cx="10" cy="10" r="7" fill="none" stroke={contextColor} strokeWidth="2.5" strokeLinecap="round" strokeDasharray="44" strokeDashoffset={44 - 44 * percent / 100} transform="rotate(-90 10 10)" />}
        </svg>
        <span style={{ color: percent === null ? undefined : contextColor, fontWeight: 600 }}>{percent === null ? "Ctx unknown" : `${percent}%`}</span>
        {contextKnown && <span>{tokens(usage.context_tokens)}/{tokens(usage.context_window)}</span>}
      </span>
      <span title="Cumulative tokens reported by this Codex session; cached input and reasoning tokens are not counted twice.">
        {known ? `${tokens(usage.total_tokens)} tokens` : "Usage pending"}
      </span>
      <span title={Number.isFinite(cost) ? "Estimated Standard API-equivalent token cost, not your ChatGPT subscription bill. Uses recorded model/reference rates; excludes tools, Fast mode and regional uplifts." : "API estimate unavailable until usage and a supported model price are known."}>
        {Number.isFinite(cost) ? `API ≈$${cost < 0.01 && cost > 0 ? cost.toFixed(4) : cost.toFixed(2)}` : "API unknown"}
      </span>
    </div>
  );
}
