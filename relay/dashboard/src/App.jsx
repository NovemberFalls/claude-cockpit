import { useState, useEffect, useCallback } from "react";
import {
  LogIn,
  Server,
  Terminal,
  Key,
  Plus,
  Trash2,
  Shield,
  ShieldOff,
  Power,
  PowerOff,
  Copy,
  Eye,
  EyeOff,
  RefreshCw,
  LogOut,
  Cloud,
} from "lucide-react";
import TerminalPane from "./components/TerminalPane";

function LoginPage() {
  return (
    <div className="flex items-center justify-center h-screen">
      <div className="text-center">
        <Cloud size={48} style={{ color: "var(--accent)", margin: "0 auto 16px" }} />
        <h1 className="text-2xl font-bold mb-2">Cockpit Relay</h1>
        <p className="text-sm mb-6" style={{ color: "var(--text-muted)" }}>
          Access your Claude Cockpit sessions from anywhere
        </p>
        <a
          href="/login"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          style={{
            backgroundColor: "var(--accent)",
            color: "#fff",
          }}
        >
          <LogIn size={16} />
          Sign in with Google
        </a>
      </div>
    </div>
  );
}

function InstanceList({ instances, onSelectTerminal, selectedTerminal }) {
  if (instances.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center" style={{ color: "var(--text-muted)" }}>
          <Server size={32} style={{ margin: "0 auto 12px", opacity: 0.5 }} />
          <p className="text-sm mb-1">No instances connected</p>
          <p className="text-xs">Connect a local cockpit using an API key</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3">
      {instances.map((inst) => (
        <div
          key={inst.instance_id}
          className="rounded-lg p-3"
          style={{
            backgroundColor: "var(--bg-surface)",
            border: "1px solid var(--border-color)",
          }}
        >
          <div className="flex items-center gap-2 mb-2">
            <Server size={14} style={{ color: "var(--accent)" }} />
            <span className="text-sm font-medium">{inst.hostname || inst.instance_id}</span>
            <span
              className="w-2 h-2 rounded-full ml-auto"
              style={{ backgroundColor: "var(--green)" }}
            />
          </div>

          {inst.terminals && inst.terminals.length > 0 ? (
            <div className="space-y-1">
              {inst.terminals.map((t) => {
                const isSelected =
                  selectedTerminal?.instance_id === inst.instance_id &&
                  selectedTerminal?.terminal_id === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() =>
                      onSelectTerminal({
                        instance_id: inst.instance_id,
                        terminal_id: t.id,
                        name: t.name,
                      })
                    }
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-left transition-colors"
                    style={{
                      backgroundColor: isSelected ? "var(--bg-highlight)" : "transparent",
                      color: isSelected ? "var(--accent)" : "var(--text-secondary)",
                    }}
                    onMouseEnter={(e) => {
                      if (!isSelected) e.currentTarget.style.backgroundColor = "var(--bg-elevated)";
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected) e.currentTarget.style.backgroundColor = "transparent";
                    }}
                  >
                    <Terminal size={11} />
                    <span className="truncate flex-1">{t.name || t.id}</span>
                    <span style={{ color: "var(--text-muted)" }}>{t.model}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              No active sessions
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function ApiKeysPanel({ user }) {
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
    <div className="p-4">
      <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
        <Key size={14} />
        API Keys
      </h2>

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
              onClick={() => {
                navigator.clipboard.writeText(createdKey);
              }}
              className="p-1 rounded"
              style={{ color: "var(--text-muted)" }}
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
            <span className="text-xs flex-1 truncate">{k.name || k.id}</span>
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
  );
}

function AdminPanel() {
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

  if (loading) {
    return (
      <div className="p-4 text-center" style={{ color: "var(--text-muted)" }}>
        Loading...
      </div>
    );
  }

  return (
    <div className="p-4">
      <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
        <Shield size={14} />
        Admin — Connected Instances
      </h2>

      {instances.length === 0 ? (
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
                <div className="text-xs font-medium truncate">{inst.hostname || inst.instance_id}</div>
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
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [instances, setInstances] = useState([]);
  const [selectedTerminal, setSelectedTerminal] = useState(null);
  const [activeTab, setActiveTab] = useState("instances");

  // Auth check
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const res = await fetch("/api/me");
        if (res.ok) {
          const data = await res.json();
          if (data.authenticated) {
            setUser(data);
          }
        }
      } catch {}
      setLoading(false);
    };
    checkAuth();
  }, []);

  // Poll instances
  useEffect(() => {
    if (!user) return;
    const fetchInstances = async () => {
      try {
        const res = await fetch("/api/instances");
        if (res.ok) {
          const data = await res.json();
          setInstances(data.instances || []);
        }
      } catch {}
    };
    fetchInstances();
    const id = setInterval(fetchInstances, 5000);
    return () => clearInterval(id);
  }, [user]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p style={{ color: "var(--text-muted)" }}>Loading...</p>
      </div>
    );
  }

  if (!user) return <LoginPage />;

  const tabs = [
    { id: "instances", label: "Instances", icon: Server },
    { id: "keys", label: "API Keys", icon: Key },
    ...(user.is_admin ? [{ id: "admin", label: "Admin", icon: Shield }] : []),
  ];

  return (
    <div className="flex h-screen">
      {/* Left panel */}
      <div
        className="flex flex-col flex-shrink-0"
        style={{
          width: 320,
          borderRight: "1px solid var(--border-color)",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 h-12 flex-shrink-0"
          style={{ borderBottom: "1px solid var(--border-color)" }}
        >
          <div className="flex items-center gap-2">
            <Cloud size={16} style={{ color: "var(--accent)" }} />
            <span className="text-sm font-semibold">Cockpit Relay</span>
          </div>
          <div className="flex items-center gap-1">
            {user.picture && (
              <img
                src={user.picture}
                alt=""
                className="w-6 h-6 rounded-full"
                style={{ border: "1px solid var(--border-color)" }}
              />
            )}
            <a
              href="/logout"
              className="p-1.5 rounded transition-colors"
              style={{ color: "var(--text-muted)" }}
              title="Logout"
            >
              <LogOut size={14} />
            </a>
          </div>
        </div>

        {/* Tabs */}
        <div
          className="flex px-2 pt-2"
          style={{ borderBottom: "1px solid var(--border-color)" }}
        >
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-t transition-colors"
                style={{
                  color: isActive ? "var(--accent)" : "var(--text-muted)",
                  borderBottom: isActive ? "2px solid var(--accent)" : "2px solid transparent",
                }}
              >
                <Icon size={12} />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto">
          {activeTab === "instances" && (
            <InstanceList
              instances={instances}
              onSelectTerminal={setSelectedTerminal}
              selectedTerminal={selectedTerminal}
            />
          )}
          {activeTab === "keys" && <ApiKeysPanel user={user} />}
          {activeTab === "admin" && <AdminPanel />}
        </div>
      </div>

      {/* Main content — terminal */}
      <div className="flex-1 flex flex-col min-w-0">
        {selectedTerminal ? (
          <>
            <div
              className="flex items-center gap-2 px-4 h-10 flex-shrink-0"
              style={{ borderBottom: "1px solid var(--border-color)" }}
            >
              <Terminal size={14} style={{ color: "var(--accent)" }} />
              <span className="text-sm font-medium">
                {selectedTerminal.name || selectedTerminal.terminal_id}
              </span>
              <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                on {selectedTerminal.instance_id}
              </span>
            </div>
            <div className="flex-1 min-h-0">
              <TerminalPane
                key={`${selectedTerminal.instance_id}-${selectedTerminal.terminal_id}`}
                instanceId={selectedTerminal.instance_id}
                terminalId={selectedTerminal.terminal_id}
              />
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center" style={{ color: "var(--text-muted)" }}>
              <Terminal size={32} style={{ margin: "0 auto 12px", opacity: 0.5 }} />
              <p className="text-sm">Select a terminal to connect</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
