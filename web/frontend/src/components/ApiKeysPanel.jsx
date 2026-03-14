import { useState, useEffect, useCallback } from "react";
import { Key, Plus, Trash2, Copy, Eye, EyeOff, X } from "lucide-react";

export default function ApiKeysPanel({ onClose }) {
  const [keys, setKeys] = useState([]);
  const [newKeyName, setNewKeyName] = useState("");
  const [createdKey, setCreatedKey] = useState(null);
  const [showCreated, setShowCreated] = useState(false);

  const fetchKeys = useCallback(async () => {
    try {
      const res = await fetch("/api/keys");
      if (res.ok) {
        const data = await res.json();
        setKeys(data.keys || []);
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  const createKey = async () => {
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newKeyName || "Default" }),
      });
      if (res.ok) {
        const data = await res.json();
        setCreatedKey(data.key);
        setShowCreated(true);
        setNewKeyName("");
        fetchKeys();
      }
    } catch {}
  };

  const deleteKey = async (keyId) => {
    try {
      await fetch(`/api/keys/${keyId}`, { method: "DELETE" });
      fetchKeys();
    } catch {}
  };

  const toggleKey = async (keyId, enabled) => {
    try {
      await fetch(`/api/keys/${keyId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !enabled }),
      });
      fetchKeys();
    } catch {}
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50"
        style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
        onClick={onClose}
      />

      {/* Dialog */}
      <div
        className="fixed z-50 rounded-xl"
        style={{
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: "480px",
          maxHeight: "80vh",
          backgroundColor: "var(--bg-elevated)",
          border: "1px solid var(--border-color)",
          boxShadow: "0 16px 48px rgba(0,0,0,0.3)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-4"
          style={{ borderBottom: "1px solid var(--border-color)" }}
        >
          <h2 className="text-sm font-semibold flex items-center gap-2" style={{ color: "var(--text-primary)" }}>
            <Key size={14} style={{ color: "var(--accent)" }} />
            API Keys
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded transition-colors"
            style={{ color: "var(--text-muted)" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 overflow-y-auto flex-1">
          {/* Create new key */}
          <div className="flex gap-2 mb-4">
            <input
              type="text"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              placeholder="Key name..."
              className="flex-1 px-3 py-1.5 rounded text-sm outline-none"
              style={{
                backgroundColor: "var(--bg-surface)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-color)",
              }}
              onKeyDown={(e) => e.key === "Enter" && createKey()}
            />
            <button
              onClick={createKey}
              className="flex items-center gap-1 px-3 py-1.5 rounded text-xs font-medium"
              style={{ backgroundColor: "var(--accent)", color: "#fff" }}
            >
              <Plus size={12} />
              Create
            </button>
          </div>

          {/* Newly created key banner */}
          {showCreated && createdKey && (
            <div
              className="p-3 rounded-lg mb-4"
              style={{
                backgroundColor: "rgba(34, 197, 94, 0.08)",
                border: "1px solid rgba(34, 197, 94, 0.2)",
              }}
            >
              <p className="text-xs font-medium mb-1" style={{ color: "var(--green)" }}>
                Key created — copy it now! It won't be shown again.
              </p>
              <div className="flex items-center gap-2">
                <code
                  className="flex-1 text-xs px-2 py-1 rounded"
                  style={{ backgroundColor: "var(--bg)", color: "var(--text-primary)" }}
                >
                  {createdKey}
                </code>
                <button
                  onClick={() => navigator.clipboard.writeText(createdKey)}
                  className="p-1 rounded"
                  style={{ color: "var(--text-muted)" }}
                  title="Copy"
                >
                  <Copy size={14} />
                </button>
                <button
                  onClick={() => setShowCreated(false)}
                  className="text-xs px-2 py-1 rounded"
                  style={{ color: "var(--text-muted)" }}
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {/* Key list */}
          <div className="space-y-2">
            {keys.map((k) => (
              <div
                key={k.id}
                className="flex items-center gap-2 px-3 py-2 rounded-lg"
                style={{
                  backgroundColor: "var(--bg-surface)",
                  border: "1px solid var(--border-color)",
                  opacity: k.enabled ? 1 : 0.5,
                }}
              >
                <Key size={12} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
                <span className="text-xs flex-1 truncate" style={{ color: "var(--text-primary)" }}>
                  {k.name || k.id}
                </span>
                <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                  {k.last_used
                    ? `Used ${new Date(k.last_used * 1000).toLocaleDateString()}`
                    : "Never used"}
                </span>
                <button
                  onClick={() => toggleKey(k.id, k.enabled)}
                  className="p-1 rounded"
                  style={{ color: k.enabled ? "var(--green)" : "var(--red)" }}
                  title={k.enabled ? "Disable" : "Enable"}
                >
                  {k.enabled ? <Eye size={12} /> : <EyeOff size={12} />}
                </button>
                <button
                  onClick={() => deleteKey(k.id)}
                  className="p-1 rounded"
                  style={{ color: "var(--text-muted)" }}
                  title="Delete key"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            {keys.length === 0 && (
              <p className="text-xs text-center py-4" style={{ color: "var(--text-muted)" }}>
                No API keys yet. Create one to connect your cockpit.
              </p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
