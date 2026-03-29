import { useState, useEffect, useCallback, useRef } from "react";

const ONBOARDING_KEY = "cockpit-onboarding-suppressed";

const TOUR_STEPS = [
  {
    target: null,
    placement: "center",
    title: "Welcome to Claude Cockpit",
    content:
      "Claude Cockpit lets you run multiple Claude Code sessions side by side. Let\u2019s take a quick tour.",
  },
  {
    target: '[data-tour="sidebar"]',
    placement: "right",
    title: "Sidebar",
    content:
      "Your saved project folders live here. Click any folder to expand it. Double-click to instantly start a session. Right-click for more options.",
  },
  {
    target: '[data-tour="new-session-btn"]',
    placement: "right",
    title: "+ New Session",
    content:
      'Click + New to start a Claude Code session. Pick a working directory, model (Sonnet / Opus / Haiku), and optionally check "Start as Orchestrator" for multi-agent mode.',
  },
  {
    target: '[data-tour="layout-switcher"]',
    placement: "top",
    title: "Layout Switcher",
    content:
      "Switch between 1, 2, or 4 pane layouts. Use Ctrl+Shift+! / @ / $ or the buttons here. Quad layout is great for watching multiple sessions at once.",
  },
  {
    target: '[data-tour="orchestrator-btn"]',
    placement: "top",
    title: "Orchestrator Mode",
    content:
      "Enable Orchestrator Mode to give one session MCP tools that let it spawn and control all the others \u2014 no commands, just plain English delegation.",
  },
  {
    target: '[data-tour="broadcast-btn"]',
    placement: "top",
    title: "Broadcast Mode",
    content:
      "Broadcast Mode sends the same message to all running sessions simultaneously. Useful for giving parallel instructions.",
  },
  {
    target: null,
    placement: "center",
    title: "You\u2019re All Set",
    content:
      "Drag files onto any terminal pane to share them with Claude. Press Ctrl+Shift+N to start a new session anytime. Click the \u24d8 icon in the status bar for a reference guide.",
  },
];

const GAP = 12;

export default function OnboardingModal({ onDismiss }) {
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState(null);
  const tooltipRef = useRef(null);
  const current = TOUR_STEPS[step];
  const isCenter = current.target === null;
  const isFirst = step === 0;
  const isLast = step === TOUR_STEPS.length - 1;

  // Measure the target element whenever step changes
  const measureTarget = useCallback(() => {
    if (!current.target) {
      setRect(null);
      return;
    }
    const el = document.querySelector(current.target);
    if (el) {
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    } else {
      setRect(null);
    }
  }, [current.target]);

  useEffect(() => {
    measureTarget();
    // Re-measure on resize/scroll
    window.addEventListener("resize", measureTarget);
    window.addEventListener("scroll", measureTarget, true);
    return () => {
      window.removeEventListener("resize", measureTarget);
      window.removeEventListener("scroll", measureTarget, true);
    };
  }, [measureTarget]);

  const finish = useCallback(() => {
    try {
      localStorage.setItem(ONBOARDING_KEY, "true");
    } catch (_) {}
    onDismiss();
  }, [onDismiss]);

  const next = useCallback(() => {
    if (isLast) {
      finish();
    } else {
      setStep((s) => s + 1);
    }
  }, [isLast, finish]);

  const back = useCallback(() => {
    if (!isFirst) setStep((s) => s - 1);
  }, [isFirst]);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e) => {
      if (e.key === "Escape") finish();
      if (e.key === "ArrowRight" || e.key === "Enter") next();
      if (e.key === "ArrowLeft") back();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [finish, next, back]);

  // Compute tooltip position
  const tooltipStyle = {};
  if (isCenter) {
    tooltipStyle.position = "fixed";
    tooltipStyle.top = "50%";
    tooltipStyle.left = "50%";
    tooltipStyle.transform = "translate(-50%, -50%)";
    tooltipStyle.maxWidth = "380px";
  } else if (rect) {
    tooltipStyle.position = "fixed";
    tooltipStyle.maxWidth = "300px";

    if (current.placement === "right") {
      tooltipStyle.top = rect.top;
      tooltipStyle.left = rect.left + rect.width + GAP;
    } else if (current.placement === "top") {
      // Position above the target; use bottom-anchoring so we don't need height
      tooltipStyle.bottom = window.innerHeight - rect.top + GAP;
      tooltipStyle.left = rect.left + rect.width / 2;
      tooltipStyle.transform = "translateX(-50%)";
    }
  }

  // Spotlight cutout style (the glowing border box)
  const spotlightPad = 6;
  const spotlightStyle =
    !isCenter && rect
      ? {
          position: "fixed",
          top: rect.top - spotlightPad,
          left: rect.left - spotlightPad,
          width: rect.width + spotlightPad * 2,
          height: rect.height + spotlightPad * 2,
          border: "2px solid var(--accent)",
          borderRadius: "8px",
          boxShadow: "0 0 0 9999px rgba(0,0,0,0.65)",
          zIndex: 9998,
          pointerEvents: "none",
          transition: "top 0.3s ease, left 0.3s ease, width 0.3s ease, height 0.3s ease",
        }
      : null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9997,
      }}
    >
      {/* Overlay — only for center steps (spotlight box-shadow handles it otherwise) */}
      {isCenter && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(0,0,0,0.65)",
            zIndex: 9998,
          }}
        />
      )}

      {/* Spotlight cutout */}
      {spotlightStyle && <div style={spotlightStyle} />}

      {/* Tooltip card */}
      <div
        ref={tooltipRef}
        style={{
          ...tooltipStyle,
          backgroundColor: "var(--bg-elevated)",
          border: "1px solid var(--border-color)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
          borderRadius: "10px",
          padding: "20px",
          zIndex: 9999,
          animation: "tour-fade-in 0.2s ease",
        }}
      >
        {/* Title */}
        <h3
          style={{
            margin: "0 0 8px 0",
            fontSize: "14px",
            fontWeight: 600,
            color: "var(--text-primary)",
          }}
        >
          {current.title}
        </h3>

        {/* Content */}
        <p
          style={{
            margin: "0 0 20px 0",
            fontSize: "13px",
            lineHeight: 1.55,
            color: "var(--text-secondary)",
          }}
        >
          {current.content}
        </p>

        {/* Footer: dots + buttons */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          {/* Progress dots */}
          <div style={{ display: "flex", gap: "6px" }}>
            {TOUR_STEPS.map((_, i) => (
              <span
                key={i}
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  backgroundColor:
                    i === step ? "var(--accent)" : "var(--border-color)",
                  transition: "background-color 0.2s ease",
                }}
              />
            ))}
          </div>

          {/* Buttons */}
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            {/* Skip (only on non-last steps) */}
            {!isLast && (
              <button
                onClick={finish}
                style={{
                  background: "none",
                  border: "none",
                  fontSize: "12px",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  padding: "6px 10px",
                }}
              >
                Skip
              </button>
            )}

            {/* Back (step > 0) */}
            {!isFirst && (
              <button
                onClick={back}
                style={{
                  background: "none",
                  border: "1px solid var(--border-color)",
                  borderRadius: "6px",
                  fontSize: "12px",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  padding: "6px 14px",
                }}
              >
                Back
              </button>
            )}

            {/* Next / Get Started / Finish */}
            <button
              onClick={next}
              style={{
                backgroundColor: "var(--accent)",
                color: "var(--bg)",
                border: "none",
                borderRadius: "6px",
                fontSize: "12px",
                fontWeight: 600,
                cursor: "pointer",
                padding: "6px 16px",
              }}
            >
              {isFirst ? "Get Started" : isLast ? "Finish" : "Next"}
            </button>
          </div>
        </div>
      </div>

      {/* Keyframe for fade-in */}
      <style>{`
        @keyframes tour-fade-in {
          from { opacity: 0; transform: ${isCenter ? "translate(-50%, -50%) scale(0.96)" : "translateY(6px)"}; }
          to   { opacity: 1; transform: ${isCenter ? "translate(-50%, -50%) scale(1)" : "translateY(0)"}; }
        }
      `}</style>
    </div>
  );
}
