import { useState, useRef, useEffect, useCallback } from "react";
import { X, FolderOpen, Folder } from "lucide-react";

export default function NewSessionDialog({
  recentLocations,
  onConfirm,
  onCancel,
}) {
  const [workdir, setWorkdir] = useState(recentLocations[0] || "C:\\Code");
  const [name, setName] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const inputRef = useRef(null);
  const dirRef = useRef(null);
  const suggestionsRef = useRef(null);
  const debounceRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Close suggestions on outside click
  useEffect(() => {
    const handler = (e) => {
      if (
        suggestionsRef.current &&
        !suggestionsRef.current.contains(e.target) &&
        dirRef.current &&
        !dirRef.current.contains(e.target)
      ) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const fetchSuggestions = useCallback((path) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/browse?path=${encodeURIComponent(path)}`
        );
        const data = await res.json();
        setSuggestions(data.dirs || []);
        setShowSuggestions((data.dirs || []).length > 0);
        setHighlightIdx(-1);
      } catch {
        setSuggestions([]);
      }
    }, 150);
  }, []);

  const handleDirChange = (e) => {
    const val = e.target.value;
    setWorkdir(val);
    if (val.length >= 2) {
      fetchSuggestions(val);
    } else {
      setSuggestions([]);
      setShowSuggestions(false);
    }
  };

  const handleDirFocus = () => {
    if (workdir.length >= 2) {
      fetchSuggestions(workdir);
    }
  };

  const selectSuggestion = (dir) => {
    setWorkdir(dir);
    setShowSuggestions(false);
    setHighlightIdx(-1);
    // Fetch children of selected dir
    fetchSuggestions(dir + "\\");
    dirRef.current?.focus();
  };

  const handleDirKeyDown = (e) => {
    if (!showSuggestions || suggestions.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Tab" || e.key === "Enter") {
      if (highlightIdx >= 0 && highlightIdx < suggestions.length) {
        e.preventDefault();
        selectSuggestion(suggestions[highlightIdx]);
      } else if (e.key === "Tab" && suggestions.length > 0) {
        e.preventDefault();
        selectSuggestion(suggestions[0]);
      }
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
    }
  };

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightIdx >= 0 && suggestionsRef.current) {
      const el = suggestionsRef.current.children[highlightIdx];
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [highlightIdx]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (showSuggestions) {
      setShowSuggestions(false);
      return;
    }
    onConfirm(name.trim(), workdir.trim());
  };

  const handleKeyDown = (e) => {
    if (e.key === "Escape" && !showSuggestions) onCancel();
  };

  // Extract just the folder name for display
  const folderName = (fullPath) => {
    const parts = fullPath.replace(/\//g, "\\").split("\\");
    return parts[parts.length - 1] || fullPath;
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
      onClick={onCancel}
      onKeyDown={handleKeyDown}
    >
      <div
        className="w-[420px] rounded-lg p-5"
        style={{
          backgroundColor: "var(--bg-elevated)",
          border: "1px solid var(--border-color)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3
            className="text-sm font-semibold"
            style={{ color: "var(--text-primary)" }}
          >
            New Session
          </h3>
          <button
            onClick={onCancel}
            className="p-0.5 rounded"
            style={{ color: "var(--text-muted)" }}
          >
            <X size={14} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          {/* Session name (optional) */}
          <label
            className="block text-[11px] uppercase tracking-wider font-medium mb-1"
            style={{ color: "var(--text-muted)" }}
          >
            Name (optional)
          </label>
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Auto-generated"
            className="w-full px-3 py-1.5 rounded text-sm mb-3 outline-none"
            style={{
              backgroundColor: "var(--bg-surface)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-color)",
            }}
          />

          {/* Working directory with autocomplete */}
          <label
            className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-medium mb-1"
            style={{ color: "var(--text-muted)" }}
          >
            <FolderOpen size={11} />
            Working Directory
          </label>
          <div className="relative">
            <input
              ref={dirRef}
              type="text"
              value={workdir}
              onChange={handleDirChange}
              onFocus={handleDirFocus}
              onKeyDown={handleDirKeyDown}
              placeholder="C:\Code"
              className="w-full px-3 py-1.5 rounded text-sm outline-none"
              style={{
                backgroundColor: "var(--bg-surface)",
                color: "var(--text-primary)",
                border: showSuggestions
                  ? "1px solid var(--accent)"
                  : "1px solid var(--border-color)",
              }}
            />

            {/* Directory suggestions dropdown */}
            {showSuggestions && suggestions.length > 0 && (
              <div
                ref={suggestionsRef}
                className="absolute z-10 left-0 right-0 mt-0.5 rounded overflow-hidden"
                style={{
                  backgroundColor: "var(--bg-elevated)",
                  border: "1px solid var(--border-color)",
                  maxHeight: "200px",
                  overflowY: "auto",
                  boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
                }}
              >
                {suggestions.map((dir, idx) => (
                  <button
                    key={dir}
                    type="button"
                    onClick={() => selectSuggestion(dir)}
                    className="w-full text-left px-2.5 py-1.5 text-xs flex items-center gap-2 transition-colors"
                    style={{
                      color:
                        idx === highlightIdx
                          ? "var(--text-primary)"
                          : "var(--text-secondary)",
                      backgroundColor:
                        idx === highlightIdx
                          ? "var(--bg-highlight)"
                          : "transparent",
                    }}
                    onMouseEnter={(e) => {
                      setHighlightIdx(idx);
                      e.currentTarget.style.backgroundColor =
                        "var(--bg-highlight)";
                    }}
                    onMouseLeave={(e) => {
                      if (idx !== highlightIdx)
                        e.currentTarget.style.backgroundColor = "transparent";
                    }}
                  >
                    <Folder
                      size={12}
                      style={{ color: "var(--accent)", flexShrink: 0 }}
                    />
                    <span className="truncate">{folderName(dir)}</span>
                    <span
                      className="ml-auto text-[10px] truncate max-w-[50%]"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {dir}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Recent locations — only show when suggestions not open */}
          {!showSuggestions && recentLocations.length > 0 && (
            <>
              <p
                className="text-[10px] uppercase tracking-wider font-medium mb-1.5 mt-3"
                style={{ color: "var(--text-muted)" }}
              >
                Recent Locations
              </p>
              <div className="flex flex-col gap-0.5 mb-4 max-h-32 overflow-y-auto">
                {recentLocations.map((loc) => (
                  <button
                    key={loc}
                    type="button"
                    onClick={() => setWorkdir(loc)}
                    className="text-left text-xs px-2 py-1 rounded truncate transition-colors"
                    style={{
                      color:
                        workdir === loc
                          ? "var(--accent)"
                          : "var(--text-secondary)",
                      backgroundColor:
                        workdir === loc ? "var(--bg-highlight)" : "transparent",
                    }}
                    onMouseEnter={(e) => {
                      if (workdir !== loc)
                        e.currentTarget.style.backgroundColor =
                          "var(--bg-surface)";
                    }}
                    onMouseLeave={(e) => {
                      if (workdir !== loc)
                        e.currentTarget.style.backgroundColor = "transparent";
                    }}
                  >
                    {loc}
                  </button>
                ))}
              </div>
            </>
          )}

          {/* Spacer when suggestions are open */}
          {showSuggestions && <div className="mb-3" />}

          {/* Actions */}
          <div className="flex justify-end gap-2 mt-3">
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-1.5 rounded text-xs transition-colors"
              style={{
                color: "var(--text-muted)",
                border: "1px solid var(--border-color)",
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-3 py-1.5 rounded text-xs font-medium transition-colors"
              style={{
                backgroundColor: "var(--accent)",
                color: "var(--bg)",
              }}
            >
              Open Session
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
