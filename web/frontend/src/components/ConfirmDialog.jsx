export default function ConfirmDialog({
  title = "Confirm",
  message = "Are you sure?",
  confirmLabel = "Confirm",
  confirmColor = "var(--red, #f7768e)",
  onConfirm,
  onCancel,
}) {
  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 z-50"
        style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
        onClick={onCancel}
      />

      {/* Card */}
      <div
        className="fixed z-50 rounded-xl"
        style={{
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: "380px",
          backgroundColor: "var(--bg-elevated)",
          border: "1px solid var(--border-color)",
          boxShadow: "0 16px 48px rgba(0,0,0,0.3)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div
          className="px-5 pt-5 pb-0"
        >
          <h2
            className="text-sm font-semibold"
            style={{ color: "var(--text-primary)" }}
          >
            {title}
          </h2>
        </div>

        {/* Body */}
        <div className="px-5 py-4">
          <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
            {message}
          </p>
        </div>

        {/* Actions */}
        <div
          className="flex justify-end gap-2 px-5 pb-5"
        >
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded text-xs font-medium transition-colors hover-bg-surface"
            style={{
              color: "var(--text-secondary)",
              border: "1px solid var(--border-color)",
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 rounded text-xs font-medium"
            style={{
              backgroundColor: confirmColor,
              color: "#fff",
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </>
  );
}
