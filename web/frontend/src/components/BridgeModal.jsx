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
// NeonWarningPanel — used in the Auto and Channel tabs
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
    onStartChannel,
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

    // ---- channel tab state ----
    const [channelLeadId, setChannelLeadId] = useState(null);
    const [channelWorkerIds, setChannelWorkerIds] = useState(new Set());
    const [channelPrompt, setChannelPrompt] = useState("");
    const [channelMaxTurns, setChannelMaxTurns] = useState(6);
    const [channelConfirmed, setChannelConfirmed] = useState(false);
    const [channelError, setChannelError] = useState(null);

    const cardRef = useRef(null);
    const firstFieldRef = useRef(null);

    // ---- sync prefix when fromSession changes ----
    useEffect(() => {
        if (fromSession) {
            setPrefix(`[From session "${fromSession.name}"]:`);
        }
    }, [fromSession]);

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

    // ---- tab switch resets confirmStep and channel confirm ----
    const handleTabChange = (newTab) => {
        setTab(newTab);
        setConfirmStep(0);
        setChannelConfirmed(false);
        setChannelError(null);
    };

    // ---- receiver helpers ----
    const eligibleSessions = allSessions.filter(
        (s) =>
            s.id !== fromSession?.id &&
            s.status === "running" &&
            s.terminalId != null
    );
    const receiverSession = eligibleSessions.find((s) => s.id === toSessionId) || null;

    // ---- channel session helpers ----
    // Eligible for the channel tab (excludes modal's own session)
    const channelEligible = allSessions.filter(
        (s) =>
            s.id !== fromSession?.id &&
            s.status === "running" &&
            s.terminalId != null
    );
    // After a lead is chosen, workers are the remaining eligible sessions (excluding lead)
    const channelWorkerEligible = channelEligible.filter((s) => s.id !== channelLeadId);

    const toggleChannelWorker = (sessionId) => {
        setChannelWorkerIds((prev) => {
            const next = new Set(prev);
            if (next.has(sessionId)) next.delete(sessionId);
            else next.add(sessionId);
            return next;
        });
    };

    // When lead changes, remove the new lead from workers if it was selected
    const handleChannelLeadChange = (sessionId) => {
        setChannelLeadId(sessionId);
        setChannelWorkerIds((prev) => {
            const next = new Set(prev);
            next.delete(sessionId);
            return next;
        });
    };

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

    // ---- channel start ----
    const handleStartChannel = async () => {
        if (submitting) return;
        if (!channelLeadId || channelWorkerIds.size === 0 || !channelPrompt.trim()) return;
        setSubmitting(true);
        setChannelError(null);
        try {
            const err = await onStartChannel({
                leadId: channelLeadId,
                workerIds: [...channelWorkerIds],
                prompt: channelPrompt.trim(),
                maxTurns: channelMaxTurns,
            });
            if (err) {
                setChannelError(err);
                setSubmitting(false);
                return;
            }
        } catch (e) {
            setChannelError(e.message || "Unknown error");
            setSubmitting(false);
            return;
        }
        setSubmitting(false);
        onClose();
    };

    // ---- disabled logic ----
    const manualSendDisabled =
        !toSessionId ||
        submitting ||
        (manualMode === "latest" && (!latestText || latestLoading)) ||
        (manualMode === "custom" && !customText.trim());

    const autoContinueDisabled = !toSessionId || !autoPrompt.trim();

    const channelStartDisabled =
        !channelLeadId ||
        channelWorkerIds.size === 0 ||
        !channelPrompt.trim() ||
        !channelConfirmed ||
        submitting;

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

                    {/* Intro */}
                    <p
                        className="text-xs mb-4"
                        style={{ color: "var(--text-muted)", lineHeight: 1.6 }}
                    >
                        Send a message from this session to another running session.{" "}
                        <strong style={{ color: "var(--text-secondary)" }}>Manual</strong>{" "}
                        relays a single message (your latest reply or a custom prompt).{" "}
                        <strong style={{ color: "var(--text-secondary)" }}>Auto-relay</strong>{" "}
                        lets two sessions exchange messages back and forth until a turn cap is reached.{" "}
                        <strong style={{ color: "var(--text-secondary)" }}>Channel</strong>{" "}
                        coordinates one lead session with multiple workers simultaneously.
                    </p>

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
                                borderRight: "1px solid var(--border-color)",
                            }}
                        >
                            Auto-relay
                        </button>
                        <button
                            type="button"
                            role="tab"
                            aria-selected={tab === "channel"}
                            onClick={() => handleTabChange("channel")}
                            className="flex-1 px-3 py-1.5 text-xs font-medium transition-colors"
                            style={{
                                color: tab === "channel" ? "var(--bg)" : "var(--text-muted)",
                                backgroundColor:
                                    tab === "channel" ? "var(--accent)" : "transparent",
                            }}
                        >
                            Channel
                        </button>
                    </div>

                    {/* Receiver picker — only visible for Manual and Auto tabs */}
                    {tab !== "channel" && (
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
                    )}

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
                                    {/* Lead session label (formerly "From session") */}
                                    <div className="mb-2">
                                        <span
                                            className="block text-[11px] uppercase tracking-wider font-medium mb-0.5"
                                            style={{ color: "var(--text-muted)" }}
                                        >
                                            Lead session
                                        </span>
                                        <span
                                            className="text-xs"
                                            style={{ color: "var(--text-secondary)" }}
                                        >
                                            {fromSession.name}
                                        </span>
                                    </div>

                                    {/* Worker session label (formerly "To session") */}
                                    <div className="mb-3">
                                        <label
                                            className="block text-[11px] uppercase tracking-wider font-medium mb-1.5"
                                            style={{ color: "var(--text-muted)" }}
                                        >
                                            Worker session
                                        </label>
                                        {/* ReceiverList is rendered above the tabs section for non-channel tabs;
                                            the worker selection reuses the already-rendered toSessionId picker */}
                                        {receiverSession ? (
                                            <span
                                                className="text-xs"
                                                style={{ color: "var(--text-secondary)" }}
                                            >
                                                {receiverSession.name}
                                            </span>
                                        ) : (
                                            <span
                                                className="text-xs"
                                                style={{ color: "var(--text-muted)" }}
                                            >
                                                Select a session above
                                            </span>
                                        )}
                                    </div>

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

                    {/* ---- CHANNEL TAB ---- */}
                    {tab === "channel" && (
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
                                            AUTONOMOUS CHANNEL
                                        </div>
                                        <div style={{ fontSize: "11px", fontWeight: 400, lineHeight: 1.5 }}>
                                            One lead and multiple workers will exchange messages without
                                            your input until the turn cap is hit or you click Stop.
                                            Token cost scales with the number of sessions. Use Manual
                                            unless you have a specific reason.
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Lead session picker */}
                            <div className="mb-4">
                                <label
                                    className="block text-[11px] uppercase tracking-wider font-medium mb-1.5"
                                    style={{ color: "var(--text-muted)" }}
                                >
                                    Lead session
                                </label>
                                {channelEligible.length === 0 ? (
                                    <p
                                        className="text-xs py-2 px-1"
                                        style={{ color: "var(--text-muted)" }}
                                    >
                                        No other running sessions available.
                                    </p>
                                ) : (
                                    <div className="flex flex-col gap-1" role="radiogroup" aria-label="Lead session">
                                        {channelEligible.map((s) => {
                                            const isSelected = s.id === channelLeadId;
                                            return (
                                                <button
                                                    key={s.id}
                                                    type="button"
                                                    role="radio"
                                                    aria-checked={isSelected}
                                                    onClick={() => handleChannelLeadChange(s.id)}
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
                                )}
                            </div>

                            {/* Worker sessions picker */}
                            <div className="mb-4">
                                <label
                                    className="block text-[11px] uppercase tracking-wider font-medium mb-1.5"
                                    style={{ color: "var(--text-muted)" }}
                                >
                                    Worker sessions
                                </label>
                                {!channelLeadId ? (
                                    <p
                                        className="text-xs py-2 px-1"
                                        style={{ color: "var(--text-muted)" }}
                                    >
                                        Select a lead session first.
                                    </p>
                                ) : channelWorkerEligible.length === 0 ? (
                                    <p
                                        className="text-xs py-2 px-1"
                                        style={{ color: "var(--text-muted)" }}
                                    >
                                        No other running sessions available as workers.
                                    </p>
                                ) : (
                                    <div className="flex flex-col gap-1" role="group" aria-label="Worker sessions">
                                        {channelWorkerEligible.map((s) => {
                                            const isChecked = channelWorkerIds.has(s.id);
                                            return (
                                                <button
                                                    key={s.id}
                                                    type="button"
                                                    role="checkbox"
                                                    aria-checked={isChecked}
                                                    onClick={() => toggleChannelWorker(s.id)}
                                                    className="flex items-center gap-2 px-2.5 py-1.5 rounded text-xs text-left transition-colors hover-bg-surface"
                                                    style={{
                                                        border: isChecked
                                                            ? "1px solid var(--accent)"
                                                            : "1px solid var(--border-color)",
                                                        backgroundColor: isChecked
                                                            ? "var(--bg-highlight)"
                                                            : "transparent",
                                                        color: "var(--text-primary)",
                                                    }}
                                                >
                                                    {/* Checkbox visual */}
                                                    <span
                                                        style={{
                                                            width: 12,
                                                            height: 12,
                                                            flexShrink: 0,
                                                            border: isChecked
                                                                ? "2px solid var(--accent)"
                                                                : "2px solid var(--border-color)",
                                                            borderRadius: 2,
                                                            backgroundColor: isChecked
                                                                ? "var(--accent)"
                                                                : "transparent",
                                                            display: "flex",
                                                            alignItems: "center",
                                                            justifyContent: "center",
                                                        }}
                                                    >
                                                        {isChecked && (
                                                            <svg width="8" height="6" viewBox="0 0 8 6" fill="none">
                                                                <path d="M1 3L3 5L7 1" stroke="var(--bg)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                                            </svg>
                                                        )}
                                                    </span>
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
                                )}
                            </div>

                            {/* Kickoff prompt */}
                            <div className="mb-3">
                                <label
                                    htmlFor="channel-prompt"
                                    className="block text-[11px] uppercase tracking-wider font-medium mb-1"
                                    style={{ color: "var(--text-muted)" }}
                                >
                                    Kickoff prompt
                                </label>
                                <textarea
                                    id="channel-prompt"
                                    ref={firstFieldRef}
                                    rows={4}
                                    value={channelPrompt}
                                    onChange={(e) => setChannelPrompt(e.target.value)}
                                    onKeyDown={(e) => e.stopPropagation()}
                                    placeholder="Describe the task and how each session should collaborate..."
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
                                    htmlFor="channel-max-turns"
                                    className="block text-[11px] uppercase tracking-wider font-medium mb-1"
                                    style={{ color: "var(--text-muted)" }}
                                >
                                    Max turns
                                </label>
                                <input
                                    id="channel-max-turns"
                                    type="number"
                                    min={1}
                                    max={20}
                                    value={channelMaxTurns}
                                    onChange={(e) =>
                                        setChannelMaxTurns(
                                            Math.min(20, Math.max(1, parseInt(e.target.value, 10) || 1))
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

                            {/* Confirm gate */}
                            {!channelConfirmed ? (
                                <div className="mb-4">
                                    <div style={NEON_PANEL_SMALL_STYLE} role="alert">
                                        <div className="flex items-start gap-2">
                                            <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: "1px" }} />
                                            <span>
                                                This will start an autonomous loop across{" "}
                                                {channelWorkerIds.size > 0
                                                    ? `1 lead + ${channelWorkerIds.size} worker${channelWorkerIds.size > 1 ? "s" : ""}`
                                                    : "multiple sessions"}
                                                . Confirm to enable the Start button.
                                            </span>
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => setChannelConfirmed(true)}
                                        className="w-full px-3 py-1.5 rounded text-xs font-medium transition-colors"
                                        style={{
                                            backgroundColor: "transparent",
                                            color: "#ff5577",
                                            border: "2px solid #ff5577",
                                            cursor: "pointer",
                                        }}
                                    >
                                        I understand — confirm channel
                                    </button>
                                </div>
                            ) : (
                                <div
                                    className="mb-4 px-3 py-2 rounded text-xs"
                                    style={{
                                        border: "1px solid var(--border-color)",
                                        color: "var(--text-muted)",
                                        backgroundColor: "var(--bg-surface)",
                                    }}
                                >
                                    Confirmed. Click Start Channel to proceed.
                                    <button
                                        type="button"
                                        onClick={() => setChannelConfirmed(false)}
                                        className="ml-2 underline"
                                        style={{ color: "var(--text-muted)" }}
                                    >
                                        Undo
                                    </button>
                                </div>
                            )}

                            {/* Error display */}
                            {channelError && (
                                <div
                                    className="mb-3 px-3 py-2 rounded text-xs"
                                    style={{
                                        border: "1px solid var(--color-red, #ff0033)",
                                        color: "var(--color-red, #ff0033)",
                                        backgroundColor: "rgba(255,0,51,0.08)",
                                    }}
                                >
                                    {channelError}
                                </div>
                            )}

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
                                    disabled={channelStartDisabled}
                                    onClick={handleStartChannel}
                                    className="px-3 py-1.5 rounded text-xs font-medium transition-colors"
                                    style={{
                                        backgroundColor: channelStartDisabled
                                            ? "var(--bg-surface)"
                                            : "#ff0033",
                                        color: channelStartDisabled
                                            ? "var(--text-muted)"
                                            : "#ffffff",
                                        cursor: channelStartDisabled ? "not-allowed" : "pointer",
                                        border: channelStartDisabled
                                            ? "1px solid var(--border-color)"
                                            : "2px solid #ff5577",
                                        boxShadow: channelStartDisabled
                                            ? "none"
                                            : "0 0 12px rgba(255,0,51,0.5)",
                                    }}
                                >
                                    {submitting ? (
                                        <span className="flex items-center gap-1.5">
                                            <Loader size={11} className="state-icon-spin" />
                                            Starting...
                                        </span>
                                    ) : (
                                        "Start Channel"
                                    )}
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </>
    );
}
