import { useState, useRef, useEffect, useCallback } from "react";
import { X, AlertTriangle, Loader } from "lucide-react";
import StateIcon from "./StateIcon.jsx";

// ---------------------------------------------------------------------------
// Preset chips for the custom-message mode
// ---------------------------------------------------------------------------
const PRESET_CHIPS = [
    {
        label: "Share blast radius",
        text: "Share your current blast radius — the files you intend to touch — so we can reconcile if there is overlap.",
    },
    {
        label: "Reconcile overlap",
        text: "List the files you plan to modify. Let us identify any overlap and agree on ownership before proceeding.",
    },
    {
        label: "Status check",
        text: "Give a brief status update: what you have completed, what is in progress, and what blockers you have.",
    },
];

// ---------------------------------------------------------------------------
// SessionDot — small coloured dot keyed off activityState
// ---------------------------------------------------------------------------
function SessionDot({ activityState }) {
    return (
        <StateIcon state={activityState || "idle"} />
    );
}

// ---------------------------------------------------------------------------
// ReceiverList — radio-style list of selectable target sessions
// ---------------------------------------------------------------------------
function ReceiverList({ sessions, fromSessionId, selected, onSelect }) {
    const eligible = sessions.filter(
        (s) =>
            s.id !== fromSessionId &&
            s.status === "running" &&
            s.terminalId != null
    );

    if (eligible.length === 0) {
        return (
            <p
                className="text-xs py-2 px-1"
                style={{ color: "var(--text-muted)" }}
            >
                No other running sessions to bridge with.
            </p>
        );
    }

    return (
        <div className="flex flex-col gap-1" role="radiogroup" aria-label="Target session">
            {eligible.map((s) => {
                const isSelected = s.id === selected;
                return (
                    <button
                        key={s.id}
                        type="button"
                        role="radio"
                        aria-checked={isSelected}
                        onClick={() => onSelect(s.id)}
                        className="flex items-center gap-2 px-2.5 py-1.5 rounded text-xs text-left transition-colors hover-bg-surface"
                        style={{
                            border: isSelected
                                ? "1px solid var(--accent)"
                                : "1px solid var(--border-color)",
                            backgroundColor: isSelected
                                ? "var(--bg-highlight)"
                                : "transparent",
                            color: "var(--text-primary)",
                        }}
                    >
                        <SessionDot activityState={s.activityState} />
                        <span className="flex-1 truncate">{s.name}</span>
                        <span
                            className="text-[10px] truncate"
                            style={{ color: "var(--text-muted)" }}
                        >
                            {s.model}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}

// ---------------------------------------------------------------------------
// NeonWarningPanel — used in the Auto tab
// ---------------------------------------------------------------------------
const NEON_PANEL_STYLE = {
    background: "linear-gradient(135deg, #ff0033, #cc0028)",
    border: "2px solid #ff5577",
    color: "#ffffff",
    padding: "14px 16px",
    borderRadius: "6px",
    boxShadow: "0 0 18px rgba(255,0,51,0.55)",
    fontWeight: 600,
    marginBottom: "16px",
    animation: "bridge-neon-pulse 2s ease-in-out infinite",
};

const NEON_PANEL_SMALL_STYLE = {
    ...NEON_PANEL_STYLE,
    fontSize: "12px",
    padding: "10px 14px",
    fontWeight: 500,
    marginBottom: "14px",
};

// ---------------------------------------------------------------------------
// BridgeModal
// ---------------------------------------------------------------------------
export default function BridgeModal({
    open,
    fromSession,
    allSessions,
    onSendManual,
    onStartAuto,
    onClose,
    fetchLatestAssistant,
}) {
    // ---- state ----
    const [tab, setTab] = useState("manual");
    const [toSessionId, setToSessionId] = useState(null);
    const [manualMode, setManualMode] = useState("latest");
    const [latestText, setLatestText] = useState("");
    const [latestLoading, setLatestLoading] = useState(false);
    const [customText, setCustomText] = useState("");
    const [prefix, setPrefix] = useState(
        fromSession ? `[From session "${fromSession.name}"]:` : ""
    );
    const [autoPrompt, setAutoPrompt] = useState("");
    const [maxTurns, setMaxTurns] = useState(4);
    const [confirmStep, setConfirmStep] = useState(0);
    const [submitting, setSubmitting] = useState(false);

    const cardRef = useRef(null);
    const firstFieldRef = useRef(null);

    // ---- sync prefix when fromSession changes ----
    useEffect(() => {
        if (fromSession) {
            setPrefix(`[From session "${fromSession.name}"]:`);
        }
    }, [fromSession?.name]);

    // ---- focus management ----
    useEffect(() => {
        if (open) {
            firstFieldRef.current?.focus();
        }
    }, [open]);

    // ---- escape key ----
    useEffect(() => {
        if (!open) return;
        const handler = (e) => {
            if (e.key === "Escape" && !submitting) {
                onClose();
            }
        };
        document.addEventListener("keydown", handler);
        return () => document.removeEventListener("keydown", handler);
    }, [open, submitting, onClose]);

    // ---- click-outside to close ----
    useEffect(() => {
        if (!open) return;
        const handler = (e) => {
            if (cardRef.current && !cardRef.current.contains(e.target)) {
                if (!submitting) onClose();
            }
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, [open, submitting, onClose]);

    // ---- fetch latest assistant reply when receiver is set or tab/mode activates ----
    const fetchLatest = useCallback(async () => {
        if (!fromSession?.terminalId || !fetchLatestAssistant) return;
        setLatestLoading(true);
        setLatestText("");
        try {
            const result = await fetchLatestAssistant(fromSession.terminalId);
            setLatestText(result || "");
        } catch {
            setLatestText("");
        } finally {
            setLatestLoading(false);
        }
    }, [fromSession?.terminalId, fetchLatestAssistant]);

    useEffect(() => {
        if (!open) return;
        if (tab === "manual" && manualMode === "latest" && toSessionId != null) {
            fetchLatest();
        }
    }, [open, tab, manualMode, toSessionId, fetchLatest]);

    // ---- tab switch resets confirmStep ----
    const handleTabChange = (newTab) => {
        setTab(newTab);
        setConfirmStep(0);
    };

    // ---- receiver helpers ----
    const eligibleSessions = allSessions.filter(
        (s) =>
            s.id !== fromSession?.id &&
            s.status === "running" &&
            s.terminalId != null
    );
    const receiverSession = eligibleSessions.find((s) => s.id === toSessionId) || null;

    // ---- manual send ----
    const handleSendManual = async () => {
        if (submitting) return;
        const text = manualMode === "latest" ? latestText : customText.trim();
        if (!text || !toSessionId) return;
        setSubmitting(true);
        try {
            await onSendManual({ to: toSessionId, text, prefix });
        } finally {
            setSubmitting(false);
            onClose();
        }
    };

    // ---- auto start ----
    const handleStartAuto = async () => {
        if (submitting) return;
        if (!toSessionId || !autoPrompt.trim()) return;
        setSubmitting(true);
        try {
            await onStartAuto({ to: toSessionId, prompt: autoPrompt.trim(), maxTurns });
        } finally {
            setSubmitting(false);
            onClose();
        }
    };

    // ---- disabled logic ----
    const manualSendDisabled =
        !toSessionId ||
        submitting ||
        (manualMode === "latest" && (!latestText || latestLoading)) ||
        (manualMode === "custom" && !customText.trim());

    const autoContinueDisabled = !toSessionId || !autoPrompt.trim();

    if (!open || !fromSession) return null;

    return (
        <>
            {/* Keyframe for neon pulse — scoped inline */}
            <style>{`
                @keyframes bridge-neon-pulse {
                    0%, 100% { box-shadow: 0 0 18px rgba(255,0,51,0.40); }
                    50%       { box-shadow: 0 0 22px rgba(255,0,51,0.65); }
                }
            `}</style>

            {/* Overlay */}
            <div
                className="fixed inset-0 z-50 flex items-center justify-center"
                style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
                aria-modal="true"
                role="dialog"
                aria-label={`Bridge from "${fromSession.name}"`}
            >
                {/* Card */}
                <div
                    ref={cardRef}
                    className="rounded-lg flex flex-col"
                    style={{
                        width: "100%",
                        maxWidth: "520px",
                        maxHeight: "90vh",
                        backgroundColor: "var(--bg-elevated)",
                        border: "1px solid var(--border-color)",
                        padding: "20px",
                        overflowY: "auto",
                    }}
                    onClick={(e) => e.stopPropagation()}
                >
                    {/* Header */}
                    <div className="flex items-center justify-between mb-4">
                        <h3
                            className="text-sm font-semibold"
                            style={{ color: "var(--text-primary)" }}
                        >
                            Bridge from &quot;{fromSession.name}&quot;
                        </h3>
                        <button
                            type="button"
                            aria-label="Close modal"
                            onClick={onClose}
                            className="p-0.5 rounded hover-color-red"
                            style={{ color: "var(--text-muted)" }}
                        >
                            <X size={14} />
                        </button>
                    </div>

                    {/* Tabs */}
                    <div
                        className="flex gap-0 mb-4 rounded overflow-hidden"
                        style={{ border: "1px solid var(--border-color)" }}
                        role="tablist"
                    >
                        <button
                            type="button"
                            role="tab"
                            aria-selected={tab === "manual"}
                            onClick={() => handleTabChange("manual")}
                            className="flex-1 px-3 py-1.5 text-xs font-medium transition-colors"
                            style={{
                                color: tab === "manual" ? "var(--bg)" : "var(--text-muted)",
                                backgroundColor:
                                    tab === "manual" ? "var(--accent)" : "transparent",
                                borderRight: "1px solid var(--border-color)",
                            }}
                        >
                            Manual (recommended)
                        </button>
                        <button
                            type="button"
                            role="tab"
                            aria-selected={tab === "auto"}
                            onClick={() => handleTabChange("auto")}
                            className="flex-1 px-3 py-1.5 text-xs font-medium transition-colors"
                            style={{
                                color: tab === "auto" ? "var(--bg)" : "var(--text-muted)",
                                backgroundColor:
                                    tab === "auto" ? "var(--accent)" : "transparent",
                            }}
                        >
                            Auto-relay
                        </button>
                    </div>

                    {/* Receiver picker — always visible */}
                    <div className="mb-4">
                        <label
                            className="block text-[11px] uppercase tracking-wider font-medium mb-1.5"
                            style={{ color: "var(--text-muted)" }}
                        >
                            Send to:
                        </label>
                        <ReceiverList
                            sessions={allSessions}
                            fromSessionId={fromSession.id}
                            selected={toSessionId}
                            onSelect={(id) => setToSessionId(id)}
                        />
                    </div>

                    {/* ---- MANUAL TAB ---- */}
                    {tab === "manual" && (
                        <div>
                            {/* Mode toggle */}
                            <div className="mb-3">
                                <label
                                    className="block text-[11px] uppercase tracking-wider font-medium mb-1.5"
                                    style={{ color: "var(--text-muted)" }}
                                >
                                    Message source
                                </label>
                                <div
                                    className="flex gap-0 rounded overflow-hidden"
                                    style={{ border: "1px solid var(--border-color)" }}
                                    role="group"
                                    aria-label="Message source"
                                >
                                    <button
                                        type="button"
                                        aria-pressed={manualMode === "latest"}
                                        onClick={() => setManualMode("latest")}
                                        className="flex-1 px-3 py-1.5 text-xs transition-colors"
                                        style={{
                                            color:
                                                manualMode === "latest"
                                                    ? "var(--bg)"
                                                    : "var(--text-muted)",
                                            backgroundColor:
                                                manualMode === "latest"
                                                    ? "var(--accent)"
                                                    : "transparent",
                                            borderRight: "1px solid var(--border-color)",
                                        }}
                                    >
                                        Relay my latest reply
                                    </button>
                                    <button
                                        type="button"
                                        aria-pressed={manualMode === "custom"}
                                        onClick={() => setManualMode("custom")}
                                        className="flex-1 px-3 py-1.5 text-xs transition-colors"
                                        style={{
                                            color:
                                                manualMode === "custom"
                                                    ? "var(--bg)"
                                                    : "var(--text-muted)",
                                            backgroundColor:
                                                manualMode === "custom"
                                                    ? "var(--accent)"
                                                    : "transparent",
                                        }}
                                    >
                                        Custom message
                                    </button>
                                </div>
                            </div>

                            {/* Latest reply display */}
                            {manualMode === "latest" && (
                                <div className="mb-3">
                                    {latestLoading ? (
                                        <div
                                            className="flex items-center gap-2 py-3 text-xs"
                                            style={{ color: "var(--text-muted)" }}
                                        >
                                            <Loader
                                                size={12}
                                                className="state-icon-spin"
                                                style={{ color: "var(--accent)" }}
                                            />
                                            Fetching latest reply...
                                        </div>
                                    ) : latestText ? (
                                        <pre
                                            className="text-xs rounded px-3 py-2"
                                            style={{
                                                backgroundColor: "var(--bg-surface)",
                                                border: "1px solid var(--border-color)",
                                                color: "var(--text-secondary)",
                                                fontFamily: "inherit",
                                                maxHeight: "140px",
                                                overflowY: "auto",
                                                whiteSpace: "pre-wrap",
                                                wordBreak: "break-word",
                                                margin: 0,
                                            }}
                                        >
                                            {latestText}
                                        </pre>
                                    ) : (
                                        <p
                                            className="text-xs py-2"
                                            style={{ color: "var(--text-muted)" }}
                                        >
                                            {toSessionId
                                                ? "(No assistant reply found yet for this session.)"
                                                : "Select a target session above to load the latest reply."}
                                        </p>
                                    )}
                                </div>
                            )}

                            {/* Custom message */}
                            {manualMode === "custom" && (
                                <div className="mb-3">
                                    {/* Preset chips */}
                                    <div className="flex flex-wrap gap-1.5 mb-2">
                                        {PRESET_CHIPS.map((chip) => (
                                            <button
                                                key={chip.label}
                                                type="button"
                                                onClick={() => setCustomText(chip.text)}
                                                className="px-2 py-1 rounded text-[11px] transition-colors hover-bg-surface"
                                                style={{
                                                    border: "1px solid var(--border-color)",
                                                    color: "var(--text-secondary)",
                                                    backgroundColor: "transparent",
                                                }}
                                            >
                                                {chip.label}
                                            </button>
                                        ))}
                                    </div>
                                    <label
                                        htmlFor="bridge-custom-text"
                                        className="block text-[11px] uppercase tracking-wider font-medium mb-1"
                                        style={{ color: "var(--text-muted)" }}
                                    >
                                        Message
                                    </label>
                                    <textarea
                                        id="bridge-custom-text"
                                        ref={manualMode === "custom" ? firstFieldRef : null}
                                        rows={4}
                                        value={customText}
                                        onChange={(e) => setCustomText(e.target.value)}
                                        onKeyDown={(e) => {
                                            // Allow Enter for newlines; do not submit
                                            e.stopPropagation();
                                        }}
                                        placeholder="Type a message to relay..."
                                        className="w-full px-3 py-1.5 rounded text-xs outline-none resize-none"
                                        style={{
                                            backgroundColor: "var(--bg-surface)",
                                            color: "var(--text-primary)",
                                            border: "1px solid var(--border-color)",
                                            fontFamily: "inherit",
                                        }}
                                    />
                                </div>
                            )}

                            {/* Prefix input */}
                            <div className="mb-4">
                                <label
                                    htmlFor="bridge-prefix"
                                    className="block text-[11px] uppercase tracking-wider font-medium mb-1"
                                    style={{ color: "var(--text-muted)" }}
                                >
                                    Prefix (prepended to message)
                                </label>
                                <input
                                    id="bridge-prefix"
                                    ref={manualMode === "latest" ? firstFieldRef : null}
                                    type="text"
                                    value={prefix}
                                    onChange={(e) => setPrefix(e.target.value)}
                                    className="w-full px-3 py-1.5 rounded text-xs outline-none"
                                    style={{
                                        backgroundColor: "var(--bg-surface)",
                                        color: "var(--text-primary)",
                                        border: "1px solid var(--border-color)",
                                        fontFamily: "inherit",
                                    }}
                                />
                            </div>

                            {/* Footer buttons */}
                            <div className="flex justify-between items-center gap-2">
                                <button
                                    type="button"
                                    onClick={onClose}
                                    className="px-3 py-1.5 rounded text-xs transition-colors"
                                    style={{
                                        color: "var(--text-muted)",
                                        border: "1px solid var(--border-color)",
                                    }}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    disabled={manualSendDisabled}
                                    onClick={handleSendManual}
                                    className="px-3 py-1.5 rounded text-xs font-medium transition-colors"
                                    style={{
                                        backgroundColor: manualSendDisabled
                                            ? "var(--bg-surface)"
                                            : "var(--accent)",
                                        color: manualSendDisabled
                                            ? "var(--text-muted)"
                                            : "var(--bg)",
                                        cursor: manualSendDisabled ? "not-allowed" : "pointer",
                                        border: manualSendDisabled
                                            ? "1px solid var(--border-color)"
                                            : "none",
                                    }}
                                >
                                    {submitting ? (
                                        <span className="flex items-center gap-1.5">
                                            <Loader size={11} className="state-icon-spin" />
                                            Sending...
                                        </span>
                                    ) : receiverSession ? (
                                        `Send to "${receiverSession.name}"`
                                    ) : (
                                        "Send"
                                    )}
                                </button>
                            </div>
                        </div>
                    )}

                    {/* ---- AUTO TAB ---- */}
                    {tab === "auto" && (
                        <div>
                            {/* Neon red warning panel */}
                            <div style={NEON_PANEL_STYLE} role="alert">
                                <div className="flex items-start gap-2">
                                    <AlertTriangle
                                        size={16}
                                        style={{ flexShrink: 0, marginTop: "1px" }}
                                    />
                                    <div>
                                        <div style={{ fontSize: "13px", marginBottom: "4px" }}>
                                            AUTONOMOUS BRIDGE
                                        </div>
                                        <div style={{ fontSize: "11px", fontWeight: 400, lineHeight: 1.5 }}>
                                            Two agents will relay messages to each other without your
                                            input until the turn cap is hit, one says BRIDGE-DONE, or
                                            you click Stop. Token cost is doubled. Use Manual unless
                                            you have a specific reason.
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Confirm step 0 — show form */}
                            {confirmStep === 0 && (
                                <>
                                    {/* Kickoff prompt */}
                                    <div className="mb-3">
                                        <label
                                            htmlFor="bridge-auto-prompt"
                                            className="block text-[11px] uppercase tracking-wider font-medium mb-1"
                                            style={{ color: "var(--text-muted)" }}
                                        >
                                            Kickoff prompt
                                        </label>
                                        <textarea
                                            id="bridge-auto-prompt"
                                            ref={firstFieldRef}
                                            rows={4}
                                            value={autoPrompt}
                                            onChange={(e) => setAutoPrompt(e.target.value)}
                                            onKeyDown={(e) => e.stopPropagation()}
                                            placeholder="Share your blast radius — files you intend to touch — and reconcile any overlap. End with BRIDGE-DONE when aligned."
                                            className="w-full px-3 py-1.5 rounded text-xs outline-none resize-none"
                                            style={{
                                                backgroundColor: "var(--bg-surface)",
                                                color: "var(--text-primary)",
                                                border: "1px solid var(--border-color)",
                                                fontFamily: "inherit",
                                            }}
                                        />
                                    </div>

                                    {/* Max turns */}
                                    <div className="mb-4">
                                        <label
                                            htmlFor="bridge-max-turns"
                                            className="block text-[11px] uppercase tracking-wider font-medium mb-1"
                                            style={{ color: "var(--text-muted)" }}
                                        >
                                            Max round-trips
                                        </label>
                                        <input
                                            id="bridge-max-turns"
                                            type="number"
                                            min={1}
                                            max={10}
                                            value={maxTurns}
                                            onChange={(e) =>
                                                setMaxTurns(
                                                    Math.min(10, Math.max(1, parseInt(e.target.value, 10) || 1))
                                                )
                                            }
                                            className="w-20 px-3 py-1.5 rounded text-xs outline-none"
                                            style={{
                                                backgroundColor: "var(--bg-surface)",
                                                color: "var(--text-primary)",
                                                border: "1px solid var(--border-color)",
                                                fontFamily: "inherit",
                                            }}
                                        />
                                    </div>

                                    {/* Footer buttons — step 0 */}
                                    <div className="flex justify-between items-center gap-2">
                                        <button
                                            type="button"
                                            onClick={onClose}
                                            className="px-3 py-1.5 rounded text-xs transition-colors"
                                            style={{
                                                color: "var(--text-muted)",
                                                border: "1px solid var(--border-color)",
                                            }}
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            type="button"
                                            disabled={autoContinueDisabled}
                                            onClick={() => setConfirmStep(1)}
                                            className="px-3 py-1.5 rounded text-xs font-medium transition-colors"
                                            style={{
                                                backgroundColor: autoContinueDisabled
                                                    ? "var(--bg-surface)"
                                                    : "var(--accent)",
                                                color: autoContinueDisabled
                                                    ? "var(--text-muted)"
                                                    : "var(--bg)",
                                                cursor: autoContinueDisabled ? "not-allowed" : "pointer",
                                                border: autoContinueDisabled
                                                    ? "1px solid var(--border-color)"
                                                    : "none",
                                            }}
                                        >
                                            Continue to confirm
                                        </button>
                                    </div>
                                </>
                            )}

                            {/* Confirm step 1 — replace form with second banner + buttons */}
                            {confirmStep === 1 && (
                                <>
                                    <div style={NEON_PANEL_SMALL_STYLE} role="alert">
                                        <div className="flex items-start gap-2">
                                            <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: "1px" }} />
                                            <span>
                                                Are you absolutely sure? This will start an autonomous
                                                loop between two agents.
                                            </span>
                                        </div>
                                    </div>

                                    <div className="flex justify-between items-center gap-2">
                                        <button
                                            type="button"
                                            onClick={() => setConfirmStep(0)}
                                            className="px-3 py-1.5 rounded text-xs transition-colors"
                                            style={{
                                                color: "var(--text-muted)",
                                                border: "1px solid var(--border-color)",
                                            }}
                                        >
                                            Go back
                                        </button>
                                        <button
                                            type="button"
                                            disabled={submitting}
                                            onClick={handleStartAuto}
                                            className="px-3 py-1.5 rounded text-xs font-medium transition-colors"
                                            style={{
                                                backgroundColor: submitting ? "#991122" : "#ff0033",
                                                color: "#ffffff",
                                                border: "2px solid #ff5577",
                                                cursor: submitting ? "not-allowed" : "pointer",
                                                boxShadow: "0 0 12px rgba(255,0,51,0.5)",
                                            }}
                                        >
                                            {submitting ? (
                                                <span className="flex items-center gap-1.5">
                                                    <Loader size={11} className="state-icon-spin" />
                                                    Starting...
                                                </span>
                                            ) : (
                                                "I understand — start auto-relay"
                                            )}
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </>
    );
}
