import { useState, useRef, useEffect, useCallback } from "react";
import { Send, Paperclip } from "lucide-react";

/**
 * ChatInput — native textarea for sending messages to Claude.
 *
 * Props:
 *   onSend     — (text: string) => void
 *   disabled   — boolean
 *   skills     — [{name, description}] for autocomplete
 *   onFileDrop — (files: File[]) => void
 *   theme      — cockpit theme
 */
export default function ChatInput({ onSend, disabled, skills = [], onFileDrop, theme }) {
  const [text, setText] = useState("");
  const [showSkills, setShowSkills] = useState(false);
  const [skillFilter, setSkillFilter] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);

  // Auto-resize
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }, [text]);

  const filteredSkills = showSkills
    ? skills.filter((s) => s.name.toLowerCase().includes(skillFilter.toLowerCase())).slice(0, 8)
    : [];

  useEffect(() => setSelectedIdx(0), [skillFilter]);

  const send = useCallback(() => {
    if (!text.trim() || disabled) return;
    onSend(text.trim());
    setText("");
    setShowSkills(false);
  }, [text, disabled, onSend]);

  const handleKeyDown = useCallback((e) => {
    // Skill autocomplete navigation
    if (showSkills && filteredSkills.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((i) => (i + 1) % filteredSkills.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((i) => (i - 1 + filteredSkills.length) % filteredSkills.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        const skill = filteredSkills[selectedIdx];
        if (skill) {
          setText("/" + skill.name + " ");
          setShowSkills(false);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShowSkills(false);
        return;
      }
    }

    // Enter = send, Shift+Enter = newline
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
      return;
    }
  }, [text, showSkills, filteredSkills, selectedIdx, send]);

  const handleChange = useCallback((e) => {
    const val = e.target.value;
    setText(val);
    const lines = val.split("\n");
    const currentLine = lines[lines.length - 1];
    if (currentLine.startsWith("/") && currentLine.length > 0) {
      setShowSkills(true);
      setSkillFilter(currentLine.slice(1));
    } else {
      setShowSkills(false);
    }
  }, []);

  // Drag-drop files
  const handleDrop = useCallback((e) => {
    const files = Array.from(e.dataTransfer?.files || []);
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    onFileDrop?.(files);
  }, [onFileDrop]);

  const handleDragOver = useCallback((e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  // File picker
  const handleFileSelect = useCallback((e) => {
    const files = Array.from(e.target.files || []);
    if (files.length) onFileDrop?.(files);
    e.target.value = "";
  }, [onFileDrop]);

  return (
    <div
      className="flex flex-col flex-shrink-0"
      style={{ borderTop: "1px solid var(--border-color)" }}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      {/* Skill autocomplete */}
      {showSkills && filteredSkills.length > 0 && (
        <div
          className="overflow-y-auto"
          style={{
            maxHeight: 180,
            borderBottom: "1px solid var(--border-color)",
            backgroundColor: "var(--bg-elevated)",
          }}
        >
          {filteredSkills.map((skill, idx) => (
            <button
              key={skill.name}
              className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2"
              style={{
                backgroundColor: idx === selectedIdx ? "rgba(122, 162, 247, 0.15)" : "transparent",
                color: "var(--text-primary)",
                border: "none",
                cursor: "pointer",
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                setText("/" + skill.name + " ");
                setShowSkills(false);
                textareaRef.current?.focus();
              }}
            >
              <span style={{ color: "var(--accent)", fontWeight: 600 }}>/{skill.name}</span>
              {skill.description && (
                <span className="truncate" style={{ color: "var(--text-muted)" }}>
                  {skill.description.slice(0, 50)}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Input row */}
      <div className="flex items-end gap-2 px-3 py-2">
        {/* File attach button */}
        <button
          onClick={() => fileInputRef.current?.click()}
          className="p-1.5 rounded transition-colors hover-bg-surface flex-shrink-0 mb-0.5"
          style={{ color: "var(--text-muted)" }}
          title="Attach file"
        >
          <Paperclip size={14} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileSelect}
        />

        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={disabled ? "Disconnected" : "Message Claude... (Shift+Enter for newline)"}
          disabled={disabled}
          rows={1}
          className="flex-1 resize-none text-sm leading-5 outline-none"
          style={{
            backgroundColor: "transparent",
            color: "var(--text-primary)",
            border: "none",
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            fontSize: 13,
            maxHeight: 150,
            overflowY: "auto",
            caretColor: theme?.accent || "var(--accent)",
          }}
          spellCheck={false}
        />

        {/* Send */}
        <button
          onClick={send}
          disabled={!text.trim() || disabled}
          title="Send (Enter)"
          className="p-1.5 rounded transition-colors flex-shrink-0 mb-0.5"
          style={{
            color: text.trim() ? "var(--accent)" : "var(--text-muted)",
            opacity: text.trim() ? 1 : 0.4,
          }}
        >
          <Send size={14} />
        </button>
      </div>
    </div>
  );
}
