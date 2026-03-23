import { useState } from "react";
import { X, Plus, FolderOpen, Keyboard, Network, ChevronRight } from "lucide-react";

const ONBOARDING_KEY = "cockpit-onboarding-suppressed";

export default function OnboardingModal({ onDismiss }) {
  const [suppress, setSuppress] = useState(false);

  const handleClose = () => {
    if (suppress) {
      try { localStorage.setItem(ONBOARDING_KEY, "true"); } catch (_) {}
    }
    onDismiss();
  };

  const Kbd = ({ children }) => (
    <kbd
      className="px-1 py-0.5 rounded text-[10px] font-mono"
      style={{ backgroundColor: "var(--bg-surface)", border: "1px solid var(--border-color)", color: "var(--text-primary)" }}
    >
      {children}
    </kbd>
  );

  const Bullet = ({ children }) => (
    <li className="flex items-start gap-2">
      <ChevronRight size={10} className="mt-0.5 flex-shrink-0" style={{ color: "var(--accent)" }} />
      <span>{children}</span>
    </li>
  );

  const Divider = () => (
    <div style={{ borderTop: "1px solid var(--border-color)" }} />
  );

  const SectionHeader = ({ icon: Icon, label }) => (
    <div className="flex items-center gap-2 mb-2">
      <Icon size={14} style={{ color: "var(--accent)" }} />
      <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-primary)" }}>
        {label}
      </h3>
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.55)" }}
    >
      <div
        className="w-[540px] max-h-[82vh] overflow-y-auto rounded-lg p-6"
        style={{
          backgroundColor: "var(--bg-elevated)",
          border: "1px solid var(--border-color)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            Welcome to Claude Cockpit
          </h2>
          <button
            onClick={handleClose}
            className="p-0.5 rounded hover-color-secondary"
            style={{ color: "var(--text-muted)" }}
          >
            <X size={14} />
          </button>
        </div>

        <div className="space-y-5 text-xs" style={{ color: "var(--text-secondary)" }}>

          {/* + New */}
          <section>
            <SectionHeader icon={Plus} label="The + New Button" />
            <p className="leading-relaxed">
              Opens the <strong style={{ color: "var(--text-primary)" }}>New Session</strong> dialog.
              Pick a <strong style={{ color: "var(--text-primary)" }}>working directory</strong> (the
              project folder Claude will work in), optionally name the session, choose a model (Sonnet,
              Opus, or Haiku), and click <strong style={{ color: "var(--text-primary)" }}>Create</strong>.
              You can also press <Kbd>Ctrl+Shift+N</Kbd> anywhere in the app.
            </p>
            <p className="leading-relaxed mt-1.5">
              A <strong style={{ color: "var(--accent)" }}>+ button</strong> also appears when you hover
              any saved folder row — click it to instantly start a session there without opening the dialog.
            </p>
          </section>

          <Divider />

          {/* Tips & Tricks */}
          <section>
            <SectionHeader icon={Keyboard} label="Tips & Tricks" />
            <ul className="space-y-1.5">
              <Bullet>
                <strong style={{ color: "var(--text-primary)" }}>Layouts</strong> — Switch between
                1×1, 2×1, and 2×2 pane layouts with <Kbd>Ctrl+Shift+!</Kbd> <Kbd>Ctrl+Shift+@</Kbd> <Kbd>Ctrl+Shift+$</Kbd>,
                or use the layout buttons in the status bar.
              </Bullet>
              <Bullet>
                <strong style={{ color: "var(--text-primary)" }}>Instant session</strong> — Double-click
                any saved folder in the sidebar to immediately start a new session there.
              </Bullet>
              <Bullet>
                <strong style={{ color: "var(--text-primary)" }}>File sharing</strong> — Drag and drop
                files, images, or PDFs directly onto a terminal pane to share them with Claude (up to 50 MB each).
              </Bullet>
              <Bullet>
                <strong style={{ color: "var(--text-primary)" }}>Close a session</strong> — Hover over
                a session row in the sidebar to reveal the <strong>×</strong> button on the right.
              </Bullet>
              <Bullet>
                <strong style={{ color: "var(--text-primary)" }}>Toggle sidebar</strong> — Press <Kbd>Ctrl+Shift+B</Kbd> to
                hide/show the sidebar and reclaim horizontal space.
              </Bullet>
              <Bullet>
                <strong style={{ color: "var(--text-primary)" }}>Broadcast Mode</strong> — Enable in the
                status bar to send the same message to all running sessions at once.
              </Bullet>
              <Bullet>
                <strong style={{ color: "var(--text-primary)" }}>Themes</strong> — Click the palette
                icon in the top bar to cycle through 20 themes (10 color palettes × dark/light).
              </Bullet>
            </ul>
          </section>

          <Divider />

          {/* Adding Folders */}
          <section>
            <SectionHeader icon={FolderOpen} label="Adding Folders" />
            <ul className="space-y-1.5">
              <Bullet>
                Type a path in the <strong style={{ color: "var(--text-primary)" }}>New Session</strong> dialog
                — the folder is automatically saved to your sidebar for quick access next time.
              </Bullet>
              <Bullet>
                <strong style={{ color: "var(--accent)" }}>Expand 1 layer</strong> — Right-click any
                saved folder in the sidebar and choose <em>Expand 1 layer</em>. This instantly
                discovers and adds all immediate subdirectories, building out your project tree
                without manual navigation. Great for quickly populating a workspace.
              </Bullet>
              <Bullet>
                Right-click a folder for more options: remove it, toggle bypass permissions, or
                open a new session in that folder.
              </Bullet>
            </ul>
          </section>

          <Divider />

          {/* Orchestrator Mode */}
          <section>
            <SectionHeader icon={Network} label="Orchestrator Mode" />
            <p className="leading-relaxed">
              Enable via the <strong style={{ color: "var(--text-primary)" }}>network icon</strong> in
              the status bar. Create one session as the <strong style={{ color: "var(--accent)" }}>Orchestrator</strong> —
              it gets MCP tools to list, read, and control all other sessions. Then spin up worker
              sessions: the orchestrator can delegate tasks, check their output, and coordinate them
              autonomously. Click the <strong style={{ color: "var(--text-primary)" }}>ⓘ icon</strong> in
              the top bar for a full step-by-step guide.
            </p>
          </section>

        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between mt-6 pt-4"
          style={{ borderTop: "1px solid var(--border-color)" }}
        >
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={suppress}
              onChange={(e) => setSuppress(e.target.checked)}
              style={{ accentColor: "var(--accent)" }}
            />
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              Don't show this again
            </span>
          </label>
          <button
            onClick={handleClose}
            className="px-4 py-1.5 rounded-md text-xs font-semibold transition-colors"
            style={{ backgroundColor: "var(--accent)", color: "var(--bg)" }}
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
