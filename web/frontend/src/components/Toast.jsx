import { useState, useCallback, useRef } from "react";
import { CheckCircle, CircleX } from "lucide-react";

let toastId = 0;

export function useToast() {
  const [toasts, setToasts] = useState([]);
  const timers = useRef({});

  const toast = useCallback((message, type = "info") => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, message, type }]);
    timers.current[id] = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      delete timers.current[id];
    }, 4000);
    return id;
  }, []);

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    if (timers.current[id]) {
      clearTimeout(timers.current[id]);
      delete timers.current[id];
    }
  }, []);

  return { toasts, toast, dismiss };
}

export function ToastContainer({ toasts, onDismiss }) {
  if (!toasts.length) return null;

  return (
    <div style={{
      position: "fixed",
      bottom: "40px",
      right: "16px",
      zIndex: 9999,
      display: "flex",
      flexDirection: "column-reverse",
      gap: "8px",
      maxWidth: "400px",
    }}>
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => onDismiss?.(t.id)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            padding: "10px 16px",
            borderRadius: "8px",
            backgroundColor: "var(--bg-elevated, #1a1a2e)",
            border: "1px solid var(--border-color, rgba(255,255,255,0.15))",
            color: "var(--text-primary, #e0e0e0)",
            fontSize: "13px",
            fontFamily: "'JetBrains Mono', monospace",
            cursor: "pointer",
            animation: "toast-in 0.2s ease-out",
            boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
          }}
        >
          {t.type === "error" ? (
            <CircleX size={16} style={{ color: "#ff6b6b", flexShrink: 0 }} />
          ) : (
            <CheckCircle size={16} style={{ color: "#51cf66", flexShrink: 0 }} />
          )}
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}
