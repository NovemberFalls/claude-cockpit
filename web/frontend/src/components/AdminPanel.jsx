import { useState, useEffect, useCallback } from "react";
import { Shield, Server, PowerOff, X } from "lucide-react";

export default function AdminPanel({ onClose }) {
  const [instances, setInstances] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchInstances = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/instances");
      if (res.ok) {
        const data = await res.json();
        setInstances(data.instances || []);
      }
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchInstances();
    const id = setInterval(fetchInstances, 5000);
    return () => clearInterval(id);
  }, [fetchInstances]);

  const killInstance = async (instanceId) => {
    try {
      await fetch(`/api/admin/instances/${instanceId}/kill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      fetchInstances();
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
          width: "560px",
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
            <Shield size={14} style={{ color: "var(--accent)" }} />
            Admin — Connected Instances
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
          {loading ? (
            <p className="text-xs text-center py-4" style={{ color: "var(--text-muted)" }}>
              Loading...
            </p>
          ) : instances.length === 0 ? (
            <p className="text-xs text-center py-4" style={{ color: "var(--text-muted)" }}>
              No instances connected
            </p>
          ) : (
            <div className="space-y-2">
              {instances.map((inst) => (
                <div
                  key={inst.instance_id}
                  className="flex items-center gap-3 px-3 py-2 rounded-lg"
                  style={{
                    backgroundColor: "var(--bg-surface)",
                    border: "1px solid var(--border-color)",
                  }}
                >
                  <Server size={12} style={{ color: "var(--accent)", flexShrink: 0 }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium truncate" style={{ color: "var(--text-primary)" }}>
                      {inst.hostname || inst.instance_id}
                    </div>
                    <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                      {inst.user_email} · {inst.session_count} sessions · {inst.total_tokens} tokens · ${inst.total_cost?.toFixed(2)}
                    </div>
                  </div>
                  <span
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: "var(--green)" }}
                  />
                  <button
                    onClick={() => killInstance(inst.instance_id)}
                    className="p-1 rounded transition-colors"
                    style={{ color: "var(--text-muted)" }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = "var(--red)")}
                    onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
                    title="Kill instance"
                  >
                    <PowerOff size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
