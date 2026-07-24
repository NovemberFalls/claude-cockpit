/**
 * ProviderPicker — dropdown for selecting the local model provider.
 *
 * Fetches GET /api/local/providers, persists the selected id to
 * localStorage (`localProviderId`), and notifies the parent of the full
 * selected provider object (including capabilities/scope) via onSelect.
 * Renders nothing while the provider list is empty/unfetched. Remote-scope
 * entries get a small "remote" badge.
 *
 * Props:
 *   enabled  — bool, gates the fetch (mirrors the localEnabled pattern elsewhere)
 *   onSelect — (provider | null) => void, called whenever selection/list changes
 */

import { useState, useEffect, useRef } from "react";

const STORAGE_KEY = "localProviderId";

export default function ProviderPicker({ enabled, onSelect }) {
  const [providers, setProviders] = useState([]);
  const [selectedId, setSelectedId] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) || ""; } catch (_) { return ""; }
  });
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    let cancelled = false;
    // All setState goes through this async fn (never directly in the effect
    // body) — same shape as App.jsx's pollers; keeps react-hooks/set-state-
    // in-effect quiet without changing behavior.
    const fetchProviders = async () => {
      if (!enabled) {
        if (!cancelled) setProviders([]);
        return;
      }
      try {
        const res = await fetch("/api/local/providers");
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setProviders(Array.isArray(data.providers) ? data.providers : []);
      } catch (_) {
        // silent — best-effort, list stays as-is
      }
    };
    fetchProviders();
    return () => { cancelled = true; };
  }, [enabled]);

  // Selection normalization: derive the effective selection during render and
  // adjust state with the documented setState-during-render pattern (not an
  // effect) — the list changing is a render-time input, not an external system.
  const match = providers.length > 0
    ? providers.find((p) => p.id === selectedId) || providers[0]
    : null;
  if (match && match.id !== selectedId) setSelectedId(match.id);

  // Parent notification IS an external interaction — effect is the right home.
  const matchId = match ? match.id : null;
  useEffect(() => {
    if (matchId === null) { onSelectRef.current?.(null); return; }
    const current = providers.find((p) => p.id === matchId) || null;
    onSelectRef.current?.(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on matchId; providers lookup is derived from it
  }, [matchId]);

  const handleChange = (e) => {
    const id = e.target.value;
    setSelectedId(id);
    try { localStorage.setItem(STORAGE_KEY, id); } catch (_) { /* ignore */ }
  };

  if (providers.length === 0) return null;

  const active = providers.find((p) => p.id === selectedId) || providers[0];

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 12px" }}>
      <select
        value={selectedId}
        onChange={handleChange}
        className="text-xs"
        style={{
          background: "var(--bg-surface)",
          color: "var(--text-primary)",
          border: "1px solid var(--border-color)",
          borderRadius: 6,
          padding: "3px 6px",
          flex: 1,
          minWidth: 0,
        }}
        aria-label="Local model provider"
      >
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}{p.scope === "remote" ? " (remote)" : ""}
          </option>
        ))}
      </select>
      {active?.scope === "remote" && (
        <span
          className="text-[10px] px-1.5 py-0.5 rounded-full"
          style={{ color: "var(--text-muted)", border: "1px solid var(--border-color)", flexShrink: 0 }}
        >
          remote
        </span>
      )}
    </div>
  );
}
