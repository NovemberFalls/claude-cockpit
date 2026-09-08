/**
 * RemoteSettings — the Settings ▸ Remote page (Studio Remote / Plexar Mobile pairing).
 *
 * Remote access is OPT-IN and OFF by default (SPEC §1). This page:
 *   - toggles `remote.enabled` and edits `remote.hostname` through useSettings
 *     (the normal draft/save flow the rest of Settings uses — a change here is
 *     not live until "Save changes" is clicked, exactly like every other page).
 *   - reads live server state from GET /api/remote/status (enabled devices,
 *     hostname as the server currently sees it, protocol version) — this is
 *     NOT the same as the draft above; the draft is what will be saved, the
 *     status call is what the server is doing right now.
 *   - starts a pairing via POST /api/remote/pairings and renders the code, an
 *     expiry countdown, and a QR of the server's `qr_payload` string rendered
 *     VERBATIM (never re-serialized) with the `qrcode` package.
 *   - revokes a device via an in-app confirm (never window.confirm) that AWAITS
 *     DELETE /api/remote/devices/{id} and only removes the row on success.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { RadioTower, QrCode, ShieldOff, Smartphone, TriangleAlert } from "lucide-react";
import QRCode from "qrcode";

const ACCENT_FG = "#0f1216";
const tint = (token, pct) => `color-mix(in srgb, ${token} ${pct}%, transparent)`;

const CARD = {
  borderRadius: 12,
  background: "var(--cc-surface)",
  border: "1px solid var(--cc-border)",
  padding: 16,
};

const LABEL = {
  fontSize: 10,
  fontWeight: 800,
  textTransform: "uppercase",
  letterSpacing: ".08em",
  color: "var(--cc-muted)",
};

function CardHeader({ icon: Icon, token, name, children }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        paddingBottom: 10,
        marginBottom: 4,
        borderBottom: "1px solid var(--cc-line)",
      }}
    >
      {Icon && (
        <span
          aria-hidden="true"
          style={{
            width: 22,
            height: 22,
            borderRadius: 7,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: token,
            background: tint(token, 8),
            border: `1px solid ${tint(token, 30)}`,
            flexShrink: 0,
          }}
        >
          <Icon size={12} />
        </span>
      )}
      <span style={{ fontSize: 13, fontWeight: 700, color: "var(--cc-fg)" }}>{name}</span>
      {children}
    </div>
  );
}

function Callout({ token = "var(--cc-waiting)", icon: Icon = TriangleAlert, children, testId, alert }) {
  return (
    <div
      data-testid={testId}
      role={alert ? "alert" : "note"}
      style={{
        display: "flex",
        gap: 8,
        alignItems: "flex-start",
        marginTop: 10,
        padding: "8px 10px",
        borderRadius: 9,
        fontSize: 11,
        lineHeight: 1.5,
        color: token,
        background: tint(token, 8),
        border: `1px solid ${tint(token, 35)}`,
      }}
    >
      <Icon size={13} style={{ flexShrink: 0, marginTop: 1 }} />
      <span>{children}</span>
    </div>
  );
}

function ActionButton({ label, onClick, disabled, title, accent, testId, icon: Icon, danger }) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      title={title || label}
      aria-label={label}
      className="rounded transition-colors hover-bg-elevated"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: 26,
        padding: "0 12px",
        fontSize: 11,
        fontWeight: 600,
        borderRadius: 7,
        background: accent && !disabled ? "var(--cc-accent)" : "var(--cc-elev)",
        color: accent && !disabled ? ACCENT_FG : danger ? "var(--cc-error)" : "var(--cc-fg)",
        border: `1px solid ${accent && !disabled ? "transparent" : "var(--cc-border)"}`,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {Icon && <Icon size={12} aria-hidden="true" />}
      {label}
    </button>
  );
}

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function secondsLeft(expiresAt, now) {
  if (typeof expiresAt !== "number") return 0;
  return Math.max(0, Math.round(expiresAt - now / 1000));
}

/** In-app confirm dialog — NEVER window.confirm. Awaits the caller's action. */
function RevokeConfirm({ device, onCancel, onConfirm, busy, error }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Revoke device"
      data-testid="revoke-confirm"
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "color-mix(in srgb, black 55%, transparent)",
        zIndex: 1000,
      }}
    >
      <div
        style={{
          ...CARD,
          width: 340,
          background: "var(--cc-bg2)",
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--cc-fg)", marginBottom: 8 }}>
          Revoke &ldquo;{device?.name}&rdquo;?
        </div>
        <p style={{ fontSize: 11, lineHeight: 1.5, color: "var(--cc-dim)", margin: "0 0 12px" }}>
          This device will lose access immediately and any open stream from it will be closed. It
          will need to be paired again to reconnect.
        </p>
        {error && (
          <div
            role="alert"
            data-testid="revoke-error"
            style={{ fontSize: 11, color: "var(--cc-error)", marginBottom: 10, lineHeight: 1.5 }}
          >
            {error}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <ActionButton label="Cancel" onClick={onCancel} disabled={busy} testId="revoke-cancel" />
          <ActionButton
            label={busy ? "Revoking…" : "Revoke"}
            onClick={onConfirm}
            disabled={busy}
            danger
            testId="revoke-confirm-button"
          />
        </div>
      </div>
    </div>
  );
}

function DevicesTable({ devices, onRevokeRequest }) {
  if (!devices || devices.length === 0) {
    return (
      <div style={{ fontSize: 11, color: "var(--cc-muted)", padding: "10px 0" }}>
        No devices paired yet.
      </div>
    );
  }
  return (
    <table
      data-testid="devices-table"
      style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, marginTop: 6 }}
    >
      <thead>
        <tr style={{ textAlign: "left", color: "var(--cc-muted)" }}>
          <th style={{ padding: "4px 6px", fontWeight: 600 }}>Name</th>
          <th style={{ padding: "4px 6px", fontWeight: 600 }}>Created</th>
          <th style={{ padding: "4px 6px", fontWeight: 600 }}>Last seen</th>
          <th style={{ padding: "4px 6px", fontWeight: 600 }}>Status</th>
          <th style={{ padding: "4px 6px", fontWeight: 600 }} />
        </tr>
      </thead>
      <tbody>
        {devices.map((d) => {
          const revoked = Boolean(d.revoked_at);
          return (
            <tr key={d.id} data-testid={`device-row-${d.id}`} style={{ borderTop: "1px solid var(--cc-line)" }}>
              <td style={{ padding: "6px" }}>{d.name}</td>
              <td style={{ padding: "6px", color: "var(--cc-dim)" }}>{fmtTime(d.created_at)}</td>
              <td style={{ padding: "6px", color: "var(--cc-dim)" }}>{fmtTime(d.last_seen)}</td>
              <td style={{ padding: "6px", color: revoked ? "var(--cc-error)" : "var(--cc-idle)" }}>
                {revoked ? "Revoked" : "Active"}
              </td>
              <td style={{ padding: "6px", textAlign: "right" }}>
                {!revoked && (
                  <ActionButton
                    label="Revoke"
                    danger
                    testId={`revoke-${d.id}`}
                    onClick={() => onRevokeRequest(d)}
                  />
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default function RemoteSettings({ get, setField }) {
  const enabledDraft = Boolean(get("remote.enabled", false));
  const hostnameDraft = get("remote.hostname", "") || "";

  const [status, setStatus] = useState(null); // {enabled, hostname, protocol, devices}
  const [statusError, setStatusError] = useState(null);

  const [pairing, setPairing] = useState(null); // {code, expires_at, url, qr_payload}
  const [pairingError, setPairingError] = useState(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState(null);

  const [now, setNow] = useState(Date.now());
  const [revokeTarget, setRevokeTarget] = useState(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState(null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/remote/status");
      const data = await res.json().catch(() => ({}));
      if (!mounted.current) return;
      if (!res.ok) {
        setStatusError(data?.error || "Could not load remote status");
        return;
      }
      setStatus(data);
      setStatusError(null);
    } catch {
      if (mounted.current) setStatusError("Could not load remote status");
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  // Live countdown for an active pairing.
  useEffect(() => {
    if (!pairing) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [pairing]);

  // Render the QR from the server's qr_payload string, verbatim.
  useEffect(() => {
    let cancelled = false;
    if (!pairing?.qr_payload) {
      setQrDataUrl(null);
      return undefined;
    }
    QRCode.toDataURL(pairing.qr_payload, { margin: 1 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [pairing]);

  const startPairing = useCallback(async () => {
    setPairingBusy(true);
    setPairingError(null);
    try {
      const res = await fetch("/api/remote/pairings", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPairingError(data?.error || "Could not start pairing");
        setPairing(null);
        return;
      }
      setPairing(data);
    } catch {
      setPairingError("Could not start pairing");
      setPairing(null);
    } finally {
      if (mounted.current) setPairingBusy(false);
    }
  }, []);

  const requestRevoke = useCallback((device) => {
    setRevokeTarget(device);
    setRevokeError(null);
  }, []);

  const cancelRevoke = useCallback(() => {
    if (revokeBusy) return;
    setRevokeTarget(null);
    setRevokeError(null);
  }, [revokeBusy]);

  const confirmRevoke = useCallback(async () => {
    if (!revokeTarget) return;
    setRevokeBusy(true);
    setRevokeError(null);
    try {
      const res = await fetch(`/api/remote/devices/${encodeURIComponent(revokeTarget.id)}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRevokeError(data?.error || "Could not revoke this device");
        return;
      }
      setStatus((prev) =>
        prev
          ? {
              ...prev,
              devices: prev.devices.filter((d) => d.id !== revokeTarget.id),
            }
          : prev
      );
      setRevokeTarget(null);
    } catch {
      setRevokeError("Could not revoke this device");
    } finally {
      if (mounted.current) setRevokeBusy(false);
    }
  }, [revokeTarget]);

  const left = pairing ? secondsLeft(pairing.expires_at, now) : 0;
  const expired = pairing ? left <= 0 : false;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: 16, minWidth: 0 }}>
      {/* ── Remote access toggle ─────────────────────────── */}
      <div style={CARD} data-testid="card-remote-toggle">
        <CardHeader icon={RadioTower} token="var(--cc-accent)" name="Remote access" />

        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 0 4px",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            data-testid="remote-enabled-toggle"
            checked={enabledDraft}
            onChange={(e) => setField("remote.enabled", e.target.checked)}
          />
          <span style={{ fontSize: 12, color: "var(--cc-fg)" }}>
            Enable remote access from Plexar Mobile
          </span>
        </label>
        <p style={{ fontSize: 11, lineHeight: 1.5, color: "var(--cc-muted)", margin: "4px 0 8px" }}>
          Off by default. When off, every <code>/remote/v1/*</code> route (pairing included)
          answers 404. Turning this on and saving lets a paired phone list sessions, start one, and
          attach to its live output through a tunnel you control.
        </p>

        <div style={{ marginTop: 4 }}>
          <div style={LABEL}>Public URL</div>
          <input
            type="text"
            data-testid="remote-hostname-input"
            value={hostnameDraft}
            onChange={(e) => setField("remote.hostname", e.target.value)}
            placeholder="https://studio.example.com"
            style={{
              width: "100%",
              maxWidth: 420,
              height: 28,
              marginTop: 4,
              borderRadius: 8,
              padding: "0 8px",
              fontFamily: "inherit",
              fontSize: 11,
              background: "var(--cc-elev)",
              border: "1px solid var(--cc-border)",
              color: "var(--cc-fg)",
            }}
          />
          <p style={{ fontSize: 10, lineHeight: 1.5, color: "var(--cc-muted)", margin: "4px 0 0" }}>
            The base URL a phone should use, e.g. your Cloudflare Tunnel hostname. Leave empty to
            fall back to this machine&rsquo;s LAN address in the pairing QR.
          </p>
        </div>

        {statusError && (
          <Callout token="var(--cc-error)" testId="status-error" alert>
            {statusError}
          </Callout>
        )}
      </div>

      {/* ── Pair a phone ─────────────────────────────────── */}
      <div style={CARD} data-testid="card-pairing">
        <CardHeader icon={QrCode} token="var(--cc-macro)" name="Pair a phone" />

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "8px 0 2px" }}>
          <ActionButton
            label={pairingBusy ? "Starting…" : "Pair a phone"}
            icon={Smartphone}
            accent
            testId="start-pairing"
            onClick={status?.enabled ? startPairing : undefined}
            disabled={!status?.enabled || pairingBusy}
            title={
              status?.enabled
                ? "Generate a one-time pairing code and QR for Plexar Mobile"
                : "Enable remote access and save changes first."
            }
          />
          {!status?.enabled && (
            <span data-testid="pairing-disabled-reason" style={{ fontSize: 11, color: "var(--cc-muted)" }}>
              Remote access is off, so pairing is disabled. Enable it above and save changes.
            </span>
          )}
        </div>

        {pairingError && (
          <Callout token="var(--cc-error)" testId="pairing-error" alert>
            {pairingError}
          </Callout>
        )}

        {pairing && (
          <div
            data-testid="pairing-result"
            style={{
              display: "flex",
              gap: 16,
              alignItems: "flex-start",
              marginTop: 12,
              flexWrap: "wrap",
            }}
          >
            {qrDataUrl && (
              <img
                data-testid="pairing-qr"
                src={qrDataUrl}
                alt="Pairing QR code"
                width={140}
                height={140}
                style={{ borderRadius: 8, background: "#fff", padding: 6 }}
              />
            )}
            <div style={{ minWidth: 0 }}>
              <div style={LABEL}>Code</div>
              <div
                data-testid="pairing-code"
                style={{
                  fontSize: 20,
                  fontWeight: 800,
                  fontFamily: "var(--font-mono, monospace)",
                  letterSpacing: "0.06em",
                  color: expired ? "var(--cc-muted)" : "var(--cc-fg)",
                  padding: "4px 0",
                }}
              >
                {pairing.code}
              </div>
              <div data-testid="pairing-expiry" style={{ fontSize: 11, color: "var(--cc-dim)" }}>
                {expired ? "Expired — start a new pairing." : `Expires in ${left}s`}
              </div>
              {pairing.url && (
                <div style={{ fontSize: 10, color: "var(--cc-muted)", marginTop: 4, overflowWrap: "anywhere" }}>
                  {pairing.url}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Devices ───────────────────────────────────────── */}
      <div style={CARD} data-testid="card-devices">
        <CardHeader icon={ShieldOff} token="var(--cc-waiting)" name="Devices" />
        <DevicesTable devices={status?.devices} onRevokeRequest={requestRevoke} />
      </div>

      {revokeTarget && (
        <RevokeConfirm
          device={revokeTarget}
          onCancel={cancelRevoke}
          onConfirm={confirmRevoke}
          busy={revokeBusy}
          error={revokeError}
        />
      )}
    </div>
  );
}
