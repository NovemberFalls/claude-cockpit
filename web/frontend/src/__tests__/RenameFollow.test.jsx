/**
 * Tests for App.jsx's /api/terminals polling reconciliation block adopting a
 * CLI-initiated rename (SPEC §2, "Studio follows a rename made INSIDE the
 * CLI"). App.jsx is a large root component with heavy backend/localStorage/
 * timer dependencies, so — following the same isolation strategy as
 * App.renameSession.test.jsx — this harness replicates the exact poll-merge
 * body (App.jsx, the `setSessions((prev) => ...)` block inside the
 * `/api/terminals` poll effect, keyed on `newClaudeSessionId`) inside a
 * minimal component.
 *
 * Contract:
 *   - Each session tracks `backendName`: the last name value SEEN from the
 *     backend for that session (distinct from `name`, the displayed value).
 *   - On each poll, if `t.name` is a non-empty string and differs from the
 *     session's current `backendName`, BOTH `name` and `backendName` adopt
 *     the backend value (the CLI renamed the session; Studio follows it).
 *   - If `t.name === s.backendName`, `name` is left untouched — this is what
 *     protects an in-flight local (desktop-initiated) rename from being
 *     clobbered by a poll response that still carries the pre-rename name.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

const { useState, useEffect } = React;

/**
 * Minimal harness replicating the App.jsx poll-merge logic for the fields
 * relevant to rename-follow: name/backendName only (activity/tokens/cost
 * fields are omitted — they are untouched by this change and covered
 * elsewhere).
 */
function PollHarness({ pollIntervalMs = 10 }) {
  const [sessions, setSessions] = useState([
    { id: 1, name: "Alpha", terminalId: "term-1", backendName: "Alpha" },
  ]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/terminals");
        if (!res.ok) throw new Error("not ok");
        const data = await res.json();
        const termMap = {};
        for (const t of data.terminals) termMap[t.id] = t;

        if (cancelled) return;
        setSessions((prev) => {
          let changed = false;
          const updated = prev.map((s) => {
            if (!s.terminalId || !termMap[s.terminalId]) return s;
            const t = termMap[s.terminalId];
            const followsRename =
              typeof t.name === "string" && t.name.length > 0 && t.name !== s.backendName;
            const newName = followsRename ? t.name : s.name;
            const newBackendName = followsRename ? t.name : s.backendName;
            if (s.name === newName && s.backendName === newBackendName) return s;
            changed = true;
            return { ...s, name: newName, backendName: newBackendName };
          });
          return changed ? updated : prev;
        });
      } catch (_) {
        // ignore for this harness
      }
    };
    const id = setInterval(poll, pollIntervalMs);
    poll();
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pollIntervalMs]);

  return (
    <div>
      {sessions.map((s) => (
        <span key={s.id} data-testid={`session-${s.id}`}>{s.name}</span>
      ))}
      <button
        onClick={() =>
          setSessions((prev) =>
            prev.map((s) => (s.id === 1 ? { ...s, name: "Locally Renamed" } : s))
          )
        }
      >
        local-rename
      </button>
    </div>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

function mockTerminals(terminals) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue({ terminals }),
  });
}

describe("App.jsx poll rename-follow contract", () => {
  it("adopts a new backend name (CLI rename) into the displayed session name", async () => {
    mockTerminals([{ id: "term-1", name: "Renamed By CLI" }]);
    render(<PollHarness />);

    expect(screen.getByTestId("session-1")).toHaveTextContent("Alpha");

    await waitFor(() => {
      expect(screen.getByTestId("session-1")).toHaveTextContent("Renamed By CLI");
    });
  });

  it("does not clobber a pending local rename when the poll still carries the old backend name", async () => {
    // The backend still reports "Alpha" (its last-seen name), matching the
    // session's initial `backendName` — so subsequent polls must not touch
    // `name` even though a local (desktop-initiated) rename is in flight.
    mockTerminals([{ id: "term-1", name: "Alpha" }]);
    render(<PollHarness />);

    await act(async () => {
      fireEvent.click(screen.getByText("local-rename"));
    });
    expect(screen.getByTestId("session-1")).toHaveTextContent("Locally Renamed");

    // Let several more poll cycles run while the backend still echoes the
    // pre-rename name (backendName === t.name, so followsRename is false).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(screen.getByTestId("session-1")).toHaveTextContent("Locally Renamed");
  });

  it("adopts a later CLI rename even after the name was previously synced", async () => {
    mockTerminals([{ id: "term-1", name: "First CLI Title" }]);
    render(<PollHarness />);

    await waitFor(() => {
      expect(screen.getByTestId("session-1")).toHaveTextContent("First CLI Title");
    });

    mockTerminals([{ id: "term-1", name: "Second CLI Title" }]);

    await waitFor(() => {
      expect(screen.getByTestId("session-1")).toHaveTextContent("Second CLI Title");
    });
  });
});
