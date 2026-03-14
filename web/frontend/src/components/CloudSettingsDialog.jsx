import { useState, useRef, useEffect } from "react";
import { X, Cloud, CloudOff, Key, Link, Loader } from "lucide-react";

export default function CloudSettingsDialog({
  cloudStatus,
  onConnect,
  onDisconnect,
  onCancel,
}) {
  const [relayUrl, setRelayUrl] = useState(
    cloudStatus?.relay_url || "wss://cockpit.boord-its.com/tunnel"
  );
  const [apiKey, setApiKey] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleConnect = async (e) => {
    e.preventDefault();
    if (!relayUrl.trim() || !apiKey.trim()) {
      setError("Both fields are required");
      return;
    }
    setConnecting(true);
    setError("");
    try {
      await onConnect(relayUrl.trim(), apiKey.trim());
    } catch (err) {
      setError(err.message || "Connection failed");
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setConnecting(true);
    try {
      await onDisconnect();
    } finally {
      setConnecting(false);
    }
  };

  const isConnected = cloudStatus?.connected;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
      onClick={onCancel}
      onKeyDown={(e) => e.key === "Escape" && onCancel()}
    >
      <div
        className="w-[420px] rounded-lg p-5"
        style={{
          backgroundColor: "var(--bg-elevated)",
          border: "1px solid var(--border-color)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3
            className="text-sm font-semibold flex items-center gap-2"
            style={{ color: "var(--text-primary)" }}
          >
            {isConnected ? (
              <Cloud size={14} style={{ color: "var(--green)" }} />
            ) : (
              <CloudOff size={14} style={{ color: "var(--text-muted)" }} />
            )}
            Cloud Relay
          </h3>
          <button
            onClick={onCancel}
            className="p-0.5 rounded"
            style={{ color: "var(--text-muted)" }}
          >
            <X size={14} />
          </button>
        </div>

        {isConnected ? (
          /* Connected state */
          <div>
            <div
              className="flex items-center gap-2 p-3 rounded mb-3"
              style={{
                backgroundColor: "rgba(34, 197, 94, 0.08)",
                border: "1px solid rgba(34, 197, 94, 0.2)",
              }}
            >
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: "var(--green)" }}
              />
              <span className="text-xs" style={{ color: "var(--green)" }}>
                Connected to relay
              </span>
            </div>

            <div className="text-xs mb-4" style={{ color: "var(--text-muted)" }}>
              <p className="mb-1">
                <span style={{ color: "var(--text-secondary)" }}>Relay:</span>{" "}
                {cloudStatus.relay_url}
              </p>
              {cloudStatus.instance_id && (
                <p>
                  <span style={{ color: "var(--text-secondary)" }}>Instance:</span>{" "}
                  {cloudStatus.instance_id}
                </p>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onCancel}
                className="px-3 py-1.5 rounded text-xs transition-colors"
                style={{
                  color: "var(--text-muted)",
                  border: "1px solid var(--border-color)",
                }}
              >
                Close
              </button>
              <button
                onClick={handleDisconnect}
                disabled={connecting}
                className="px-3 py-1.5 rounded text-xs font-medium transition-colors flex items-center gap-1.5"
                style={{
                  backgroundColor: "var(--red)",
                  color: "#fff",
                  opacity: connecting ? 0.6 : 1,
                }}
              >
                {connecting && <Loader size={10} className="animate-spin" />}
                Disconnect
              </button>
            </div>
          </div>
        ) : (
          /* Disconnected state — show connect form */
          <form onSubmit={handleConnect}>
            <label
              className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-medium mb-1"
              style={{ color: "var(--text-muted)" }}
            >
              <Link size={11} />
              Relay URL
            </label>
            <input
              ref={inputRef}
              type="text"
              value={relayUrl}
              onChange={(e) => setRelayUrl(e.target.value)}
              placeholder="wss://cockpit.boord-its.com/tunnel"
              className="w-full px-3 py-1.5 rounded text-sm mb-3 outline-none"
              style={{
                backgroundColor: "var(--bg-surface)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-color)",
              }}
            />

            <label
              className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-medium mb-1"
              style={{ color: "var(--text-muted)" }}
            >
              <Key size={11} />
              API Key
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="cpk_..."
              className="w-full px-3 py-1.5 rounded text-sm mb-3 outline-none"
              style={{
                backgroundColor: "var(--bg-surface)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-color)",
              }}
            />

            {error && (
              <p className="text-xs mb-3" style={{ color: "var(--red)" }}>
                {error}
              </p>
            )}

            <p className="text-[10px] mb-3" style={{ color: "var(--text-muted)" }}>
              Connect to a cloud relay to access your sessions from any browser.
              Terminal content is relayed end-to-end and never stored on the relay server.
            </p>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onCancel}
                className="px-3 py-1.5 rounded text-xs transition-colors"
                style={{
                  color: "var(--text-muted)",
                  border: "1px solid var(--border-color)",
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={connecting}
                className="px-3 py-1.5 rounded text-xs font-medium transition-colors flex items-center gap-1.5"
                style={{
                  backgroundColor: "var(--accent)",
                  color: "var(--bg)",
                  opacity: connecting ? 0.6 : 1,
                }}
              >
                {connecting && <Loader size={10} className="animate-spin" />}
                Connect
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
