/**
 * WorkflowsPanel — popover listing recent workflows for a terminal session.
 *
 * Props:
 *   workflows  — array from the API, or [] if none
 *   onClose    — () => void, called when user clicks outside
 */

/** Format an ISO timestamp as a relative time string, e.g. "2m ago". */
function relativeTime(isoString) {
  const diffMs = Date.now() - Date.parse(isoString);
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${Math.max(diffSec, 0)}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

function WorkflowRow({ workflow }) {
  const isInProgress = workflow.status === "in_progress";
  const isError = workflow.is_error;

  let dotStyle;
  if (isInProgress) {
    dotStyle = {
      width: 8,
      height: 8,
      borderRadius: "50%",
      backgroundColor: "var(--accent)",
      flexShrink: 0,
      animation: "state-pulse 1.5s ease-in-out infinite",
    };
  } else if (isError) {
    dotStyle = {
      width: 8,
      height: 8,
      borderRadius: "50%",
      backgroundColor: "var(--red)",
      flexShrink: 0,
    };
  } else {
    dotStyle = {
      width: 8,
      height: 8,
      borderRadius: "50%",
      backgroundColor: "var(--green)",
      flexShrink: 0,
    };
  }

  const timeLabel = relativeTime(workflow.started_at) + (workflow.completed_at ? " · done" : "");

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        padding: "6px 12px",
        borderBottom: "1px solid var(--border-color)",
      }}
    >
      <div style={{ paddingTop: 3 }}>
        <div style={dotStyle} aria-hidden="true" />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--text-primary)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {workflow.name}
        </div>
        {workflow.description && (
          <div
            style={{
              fontSize: 11,
              color: "var(--text-secondary)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              marginTop: 1,
            }}
          >
            {workflow.description}
          </div>
        )}
        <div
          style={{
            fontSize: 10,
            color: "var(--text-muted)",
            marginTop: 2,
          }}
        >
          {timeLabel}
        </div>
      </div>
    </div>
  );
}

export default function WorkflowsPanel({ workflows, onClose }) {
  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Card */}
      <div
        role="dialog"
        aria-label="Recent workflows"
        style={{
          position: "absolute",
          right: 0,
          top: "calc(100% + 4px)",
          zIndex: 50,
          minWidth: 280,
          maxWidth: 360,
          maxHeight: 400,
          overflowY: "auto",
          backgroundColor: "var(--bg-elevated)",
          border: "1px solid var(--border-color)",
          borderRadius: 8,
          boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
        }}
      >
        <div
          className="text-[10px] uppercase tracking-wider px-3 pt-2 pb-1"
          style={{ color: "var(--text-muted)" }}
        >
          Workflows
        </div>

        {workflows.length === 0 ? (
          <div
            className="text-xs px-3 py-3"
            style={{ color: "var(--text-muted)" }}
          >
            No recent workflows.
          </div>
        ) : (
          workflows.map((wf) => (
            <WorkflowRow key={wf.tool_id} workflow={wf} />
          ))
        )}
      </div>
    </>
  );
}
