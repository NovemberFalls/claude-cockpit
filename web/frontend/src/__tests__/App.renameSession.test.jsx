/**
 * Tests for App.jsx's renameSession() mutation — the callback TerminalPane's
 * inline rename invokes via the onRenameSession prop.
 *
 * App.jsx is a large root component with heavy backend/localStorage/timer
 * dependencies, so — following the same isolation strategy already used by
 * the "App BroadcastChannel CLOSED integration" suite in popout.test.jsx —
 * we replicate the exact renameSession() function body (App.jsx, "Rename a
 * session" block) inside a minimal harness component. This exercises the
 * real contract (PATCH request shape, state update on success, info Toast on
 * claude_synced:false, error Toast on failure) without booting the full App
 * component tree.
 *
 * Contract:
 *   PATCH /api/terminals/{terminalId}  {name, sync_claude}
 *     -> OPTIMISTIC: the new name is applied to state BEFORE the fetch
 *        resolves (sync_claude can block the PATCH for seconds waiting for
 *        the session to go idle; the header must not sit on the stale name)
 *     -> {ok:true, terminal, claude_synced} on success (name stays)
 *     -> claude_synced:false + sync_claude requested -> info Toast, NOT an error
 *     -> non-ok / !data.ok -> error Toast, name rolled back
 *     -> network exception -> error Toast, name rolled back
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const { useState, useCallback } = React;

/**
 * Minimal harness replicating App.jsx's renameSession callback + the
 * `sessions` state array it mutates. Renders each session's current name so
 * tests can assert the "sidebar" (here: this list) updates immediately.
 */
function RenameHarness({ toast }) {
  const [sessions, setSessions] = useState([
    { id: 1, name: "Alpha", terminalId: "term-1" },
  ]);

  // Mirrors App.jsx's renameSession exactly.
  const renameSession = useCallback(async (localId, newName, syncClaude) => {
    const session = sessions.find((s) => s.id === localId);
    if (!session?.terminalId) return;
    const prevName = session.name;
    setSessions((prev) =>
      prev.map((s) => (s.id === localId ? { ...s, name: newName } : s))
    );
    const rollback = () =>
      setSessions((prev) =>
        prev.map((s) => (s.id === localId ? { ...s, name: prevName } : s))
      );
    try {
      const res = await fetch(`/api/terminals/${session.terminalId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName, sync_claude: syncClaude }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        rollback();
        toast(data.error || "Rename failed", "error");
        return;
      }
      if (syncClaude && data.claude_synced === false) {
        toast(`Renamed to "${newName}" — Claude session sync did not go through`, "info");
      }
    } catch (err) {
      rollback();
      toast(`Rename failed: ${err.message}`, "error");
    }
  }, [sessions, toast]);

  return (
    <div>
      {sessions.map((s) => (
        <span key={s.id} data-testid={`session-${s.id}`}>{s.name}</span>
      ))}
      <button onClick={() => renameSession(1, "Bravo", true)}>rename-sync</button>
      <button onClick={() => renameSession(1, "Charlie", false)}>rename-nosync</button>
    </div>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("App.jsx renameSession contract", () => {
  it("PATCHes the terminal and updates the displayed name on success", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: true, claude_synced: true }),
    });
    const toast = vi.fn();
    render(<RenameHarness toast={toast} />);

    expect(screen.getByTestId("session-1")).toHaveTextContent("Alpha");

    await act(async () => {
      fireEvent.click(screen.getByText("rename-sync"));
    });

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/terminals/term-1",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ name: "Bravo", sync_claude: true }),
        }),
      );
    });
    expect(screen.getByTestId("session-1")).toHaveTextContent("Bravo");
    expect(toast).not.toHaveBeenCalled();
  });

  it("shows an info Toast (not an error) when claude_synced is false", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: true, claude_synced: false }),
    });
    const toast = vi.fn();
    render(<RenameHarness toast={toast} />);

    await act(async () => {
      fireEvent.click(screen.getByText("rename-sync"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("session-1")).toHaveTextContent("Bravo");
    });
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("Claude session sync"), "info");
  });

  it("does not toast about sync when sync_claude was not requested", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: true, claude_synced: false }),
    });
    const toast = vi.fn();
    render(<RenameHarness toast={toast} />);

    await act(async () => {
      fireEvent.click(screen.getByText("rename-nosync"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("session-1")).toHaveTextContent("Charlie");
    });
    expect(toast).not.toHaveBeenCalled();
  });

  it("shows the new name optimistically while the PATCH is still in flight", async () => {
    let resolveFetch;
    globalThis.fetch = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );
    const toast = vi.fn();
    render(<RenameHarness toast={toast} />);

    await act(async () => {
      fireEvent.click(screen.getByText("rename-sync"));
    });

    // fetch has NOT resolved yet — the displayed name must already be updated
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("session-1")).toHaveTextContent("Bravo");

    await act(async () => {
      resolveFetch({
        ok: true,
        json: vi.fn().mockResolvedValue({ ok: true, claude_synced: true }),
      });
    });
    expect(screen.getByTestId("session-1")).toHaveTextContent("Bravo");
    expect(toast).not.toHaveBeenCalled();
  });

  it("surfaces an error Toast and rolls the name back when the PATCH fails", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: vi.fn().mockResolvedValue({ error: "Terminal not found" }),
    });
    const toast = vi.fn();
    render(<RenameHarness toast={toast} />);

    await act(async () => {
      fireEvent.click(screen.getByText("rename-sync"));
    });

    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith("Terminal not found", "error");
    });
    expect(screen.getByTestId("session-1")).toHaveTextContent("Alpha");
  });

  it("surfaces an error Toast and rolls the name back on a network exception", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down"));
    const toast = vi.fn();
    render(<RenameHarness toast={toast} />);

    await act(async () => {
      fireEvent.click(screen.getByText("rename-sync"));
    });

    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith("Rename failed: network down", "error");
    });
    expect(screen.getByTestId("session-1")).toHaveTextContent("Alpha");
  });
});
