import { useState, useEffect, useRef } from "react";
import { Search, Clock, Play } from "lucide-react";

/** Strip Claude Code XML tags from message previews (safety net for backend) */
function cleanPreview(text) {
  if (!text) return text;
  // Strip block tags with content (may be truncated — also match unclosed)
  let cleaned = text.replace(/<(?:system-reminder|local-command-caveat)[^>]*>[\s\S]*?(?:<\/(?:system-reminder|local-command-caveat)>|$)/g, "");
  // Extract command-args if present
  const m = cleaned.match(/<command-args>([\s\S]*?)<\/command-args>/);
  if (m) return m[1].trim();
  // Strip remaining simple tags
  cleaned = cleaned.replace(/<\/?(?:command-message|command-name|command-args|scheduled-task)[^>]*>/g, "").trim();
  // If the entire message was a tag, return a fallback
  return cleaned || "(system message)";
}

function relativeTime(isoString) {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diff = Math.max(0, now - then);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export default function HistoryPanel({
  workdir,
  onViewSession,
  onResumeSession,
  backendReady,
  onDragHistorySession,
}) {
  const [sessions, setSessions] = useState([]);
  const [search, setSearch] = useState("");
  const pollRef = useRef(null);

  useEffect(() => {
    if (!workdir || !backendReady) return;
    let cancelled = false;
    const fetchHistory = async () => {
      try {
        const res = await fetch(
          `/api/history?workdir=${encodeURIComponent(workdir)}`
        );
        if (res.ok && !cancelled) {
          const data = await res.json();
          setSessions(data.sessions || []);
        }
      } catch {
        // silently fail
      }
    };
    fetchHistory();
    pollRef.current = setInterval(fetchHistory, 30000);
    return () => {
      cancelled = true;
      clearInterval(pollRef.current);
    };
  }, [workdir, backendReady]);

  const filtered = search
    ? sessions.filter((s) =>
        (s.first_message || "").toLowerCase().includes(search.toLowerCase())
      )
    : sessions;

  if (!workdir) {
    return (
      <div
        className="flex flex-col items-center justify-center py-8 px-4 text-center"
        style={{ color: "var(--text-muted)" }}
      >
        <Clock size={24} style={{ marginBottom: 8, opacity: 0.5 }} />
        <p className="text-xs">Select a session to view history</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-w-0 overflow-hidden">
      {/* Search input */}
      <div className="px-3 mb-2">
        <div
          className="flex items-center gap-1.5 px-2 py-1 rounded-md"
          style={{
            backgroundColor: "var(--bg-surface)",
            border: "1px solid var(--border-color)",
          }}
        >
          <Search size={12} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
          <input
            type="text"
            placeholder="Search history..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 text-xs bg-transparent outline-none"
            style={{ color: "var(--text-primary)" }}
          />
        </div>
      </div>

      {/* Session list */}
      {filtered.length === 0 ? (
        <div
          className="flex flex-col items-center justify-center py-8 px-4 text-center"
          style={{ color: "var(--text-muted)" }}
        >
          <Clock size={24} style={{ marginBottom: 8, opacity: 0.5 }} />
          <p className="text-xs">No session history</p>
        </div>
      ) : (
        <div className="flex flex-col">
          {filtered.map((session) => (
            <HistoryEntry
              key={session.session_id}
              session={session}
              onView={onViewSession}
              onResume={onResumeSession}
              onDragStart={onDragHistorySession}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function HistoryEntry({ session, onView, onResume, onDragStart }) {
  const rawMsg = session.first_message || "Untitled session";
  const firstMsg = cleanPreview(rawMsg);
  const truncated = firstMsg.length > 60 ? firstMsg.slice(0, 57) + "..." : firstMsg;

  return (
    <div
      className="group flex flex-col gap-0.5 px-3 py-1.5 cursor-pointer rounded-md transition-colors hover-bg-surface min-w-0 overflow-hidden"
      onClick={() => onView(session)}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", `history:${session.session_id}`);
        if (onDragStart) onDragStart(session);
      }}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <span
          className="text-xs truncate flex-1"
          style={{ color: "var(--text-primary)" }}
          title={firstMsg}
        >
          {truncated}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onResume(session);
          }}
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded transition-all flex-shrink-0 hover-bg-elevated"
          style={{ color: "var(--accent)" }}
          title="Resume session"
        >
          <Play size={12} />
        </button>
      </div>
      <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
        <span className="text-[10px] flex-shrink-0" style={{ color: "var(--text-muted)" }}>
          {relativeTime(session.last_modified)}
        </span>
        {session.model && (
          <span
            className="text-[10px] px-1 py-0.5 rounded-full truncate"
            style={{
              backgroundColor: "var(--bg-elevated)",
              color: "var(--text-muted)",
              maxWidth: "80px",
            }}
          >
            {session.model}
          </span>
        )}
        <span className="text-[10px] flex-shrink-0" style={{ color: "var(--text-muted)" }}>
          {session.message_count} msgs
        </span>
      </div>
    </div>
  );
}
