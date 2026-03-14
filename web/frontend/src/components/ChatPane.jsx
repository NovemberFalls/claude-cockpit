import { useState, useRef, useEffect, useCallback } from "react";
import { Send, Paperclip, Square, Loader2, MoreHorizontal } from "lucide-react";

function Message({ msg }) {
  const isUser = msg.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-3`}>
      <div
        className="max-w-[85%] text-sm leading-relaxed rounded-lg px-4 py-2.5 whitespace-pre-wrap"
        style={
          isUser
            ? {
                backgroundColor: "var(--bg-surface)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-color)",
              }
            : {
                color: "var(--text-primary)",
              }
        }
      >
        {msg.text}
        {msg.ts && (
          <div
            className="text-[10px] mt-1 text-right"
            style={{ color: "var(--text-muted)" }}
          >
            {new Date(msg.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ChatPane({
  session,
  onSend,
  onCancel,
  onAttach,
  attachedFiles = [],
  onRemoveFile,
}) {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);
  const isRunning = session.status === "running";

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [session.messages]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 150) + "px";
    }
  }, [input]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || isRunning) return;
    onSend(text, attachedFiles.map((f) => f.path));
    setInput("");
  }, [input, isRunning, onSend, attachedFiles]);

  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  // File drop handler
  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      if (e.dataTransfer.files?.length) {
        onAttach?.(Array.from(e.dataTransfer.files));
      }
    },
    [onAttach]
  );

  const handleDragOver = (e) => e.preventDefault();

  return (
    <div
      className="flex flex-col h-full min-w-0"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 h-10 flex-shrink-0"
        style={{ borderBottom: "1px solid var(--border-color)" }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="text-sm font-medium truncate"
            style={{ color: "var(--text-primary)" }}
          >
            {session.name}
          </span>
          {isRunning && (
            <Loader2
              size={12}
              className="animate-spin flex-shrink-0"
              style={{ color: "var(--accent)" }}
            />
          )}
        </div>
        <div className="flex items-center gap-1">
          <span
            className="text-[10px] px-1.5 py-0.5 rounded"
            style={{ color: "var(--text-muted)", backgroundColor: "var(--bg-surface)" }}
          >
            {session.model}
          </span>
          <button
            className="p-0.5 rounded transition-colors"
            style={{ color: "var(--text-muted)" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-secondary)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
          >
            <MoreHorizontal size={15} />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {session.messages.length === 0 && (
          <div
            className="flex items-center justify-center h-full text-sm"
            style={{ color: "var(--text-muted)" }}
          >
            Send a message to start...
          </div>
        )}
        {session.messages.map((msg, i) => (
          <Message key={i} msg={msg} />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Attached files */}
      {attachedFiles.length > 0 && (
        <div
          className="flex gap-2 px-4 py-2 flex-wrap"
          style={{ borderTop: "1px solid var(--border-color)" }}
        >
          {attachedFiles.map((f, i) => (
            <span
              key={i}
              className="flex items-center gap-1 text-xs px-2 py-1 rounded"
              style={{
                backgroundColor: "var(--bg-surface)",
                color: "var(--text-secondary)",
                border: "1px solid var(--border-color)",
              }}
            >
              {f.name}
              <button
                onClick={() => onRemoveFile?.(i)}
                className="ml-1 hover:opacity-70"
                style={{ color: "var(--text-muted)" }}
              >
                x
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Input */}
      <div
        className="flex items-end gap-2 px-4 py-3 flex-shrink-0"
        style={{ borderTop: "1px solid var(--border-color)" }}
      >
        <button
          onClick={() => {
            const fileInput = document.createElement("input");
            fileInput.type = "file";
            fileInput.multiple = true;
            fileInput.onchange = (e) => onAttach?.(Array.from(e.target.files));
            fileInput.click();
          }}
          className="p-1 rounded transition-colors flex-shrink-0 mb-0.5"
          style={{ color: "var(--text-muted)" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-secondary)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
          title="Attach files"
        >
          <Paperclip size={15} />
        </button>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Send a message..."
          rows={1}
          className="flex-1 text-sm bg-transparent outline-none resize-none"
          style={{
            color: "var(--text-primary)",
            maxHeight: "150px",
          }}
          disabled={isRunning}
        />
        {isRunning ? (
          <button
            onClick={onCancel}
            className="p-1 rounded transition-colors flex-shrink-0 mb-0.5"
            style={{ color: "var(--red)" }}
            title="Cancel"
          >
            <Square size={15} />
          </button>
        ) : (
          <button
            onClick={handleSend}
            className="p-1 rounded transition-colors flex-shrink-0 mb-0.5"
            style={{ color: input.trim() ? "var(--accent)" : "var(--text-muted)" }}
            title="Send (Enter)"
          >
            <Send size={15} />
          </button>
        )}
      </div>
    </div>
  );
}
