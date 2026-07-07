/**
 * Light integration test for the bridge/channel "end toast" wiring added to
 * App.jsx's /api/bridge and /api/bridge/channel poll effects.
 *
 * App.jsx is a large root component with heavy backend/localStorage/timer
 * dependencies, so — following the same isolation strategy already used by
 * App.renameSession.test.jsx and the "App BroadcastChannel CLOSED
 * integration" suite in popout.test.jsx — we replicate the EXACT poll
 * effect body (App.jsx, "Poll /api/bridge every 3s..." block) inside a
 * minimal harness component. This exercises the real contract (fetch ->
 * computeEndEvents -> toast) without booting the full App component tree.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { computeEndEvents, formatEndEventToast, BRIDGE_KIND, CHANNEL_KIND } from "../utils/bridgeEvents";

const { useState, useEffect, useRef } = React;

// ---------------------------------------------------------------------------
// Harness — mirrors the bridge poll effect in App.jsx verbatim.
// ---------------------------------------------------------------------------

function BridgePollHarness({ toast }) {
  const [activeBridges, setActiveBridges] = useState([]);
  const prevBridgeStatesRef = useRef(new Map());
  const seenBridgeIdsRef = useRef(new Set());

  useEffect(() => {
    const fetchBridges = async () => {
      try {
        const res = await fetch("/api/bridge");
        if (!res.ok) return;
        const data = await res.json();
        const bridges = data.bridges || [];
        setActiveBridges(bridges);
        const events = computeEndEvents(BRIDGE_KIND, bridges, prevBridgeStatesRef.current, seenBridgeIdsRef.current);
        events.forEach((evt) => {
          const { message, type } = formatEndEventToast(evt);
          toast(message, type);
        });
      } catch (_) {
        // soft-fail — stale bridge state is not critical
      }
    };
    fetchBridges();
    const id = setInterval(fetchBridges, 3000);
    return () => clearInterval(id);
  }, [toast]);

  return <div data-testid="bridge-count">{activeBridges.length}</div>;
}

// ---------------------------------------------------------------------------
// Harness — mirrors the channel poll effect in App.jsx verbatim.
// ---------------------------------------------------------------------------

function ChannelPollHarness({ toast }) {
  const [channels, setChannels] = useState([]);
  const prevChannelStatesRef = useRef(new Map());
  const seenChannelIdsRef = useRef(new Set());

  useEffect(() => {
    const fetchChannels = async () => {
      try {
        const res = await fetch("/api/bridge/channel");
        if (!res.ok) return;
        const data = await res.json();
        const channelList = data.channels || [];
        setChannels(channelList);
        const events = computeEndEvents(CHANNEL_KIND, channelList, prevChannelStatesRef.current, seenChannelIdsRef.current);
        events.forEach((evt) => {
          const { message, type } = formatEndEventToast(evt);
          toast(message, type);
        });
      } catch (_) {
        // soft-fail — stale channel state is not critical
      }
    };
    fetchChannels();
    const id = setInterval(fetchChannels, 3000);
    return () => clearInterval(id);
  }, [toast]);

  return <div data-testid="channel-count">{channels.length}</div>;
}

// ---------------------------------------------------------------------------
// Fixtures + fetch sequencer
// ---------------------------------------------------------------------------

function bridgeRecord(overrides = {}) {
  return {
    bridge_id: "b1",
    from_id: "term-a",
    to_id: "term-b",
    from_name: "Session 18",
    to_name: "Session 21",
    turns_used: 2,
    max_turns: 4,
    state: "active",
    ...overrides,
  };
}

function channelRecord(overrides = {}) {
  return {
    channel_id: "c1",
    lead_id: "term-lead",
    lead_name: "Session 5",
    worker_ids: ["term-w1"],
    worker_names: { "term-w1": "Worker One" },
    turns_used: 1,
    max_turns: 6,
    state: "active",
    ...overrides,
  };
}

/** Installs a fetch mock that returns `responses[i]` on the i-th call,
 *  clamped to the last entry once exhausted (so a later poll keeps returning
 *  the final state, mirroring a steady-state backend). */
function mockFetchSequence(responses) {
  let call = 0;
  globalThis.fetch = vi.fn().mockImplementation(() => {
    const body = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ===========================================================================
// Bridge polling
// ===========================================================================

describe("App bridge poll — end-of-bridge toast", () => {
  it("toasts once, with turn counts, when an active bridge transitions to ended_capped", async () => {
    const toast = vi.fn();
    mockFetchSequence([
      { bridges: [bridgeRecord({ state: "active" })] },
      { bridges: [bridgeRecord({ state: "ended_capped", turns_used: 4, max_turns: 4 })] },
      { bridges: [] }, // vanishes after — must NOT double-toast
    ]);

    await act(async () => {
      render(<BridgePollHarness toast={toast} />);
    });
    await act(async () => {}); // flush the initial (immediate) fetchBridges() call

    expect(toast).not.toHaveBeenCalled(); // first poll only sees "active"

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(
      "Bridge Session 18 ↔ Session 21 ended: turn limit reached (4/4)",
      "info",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    // Record already ended last poll, then vanished — no second toast.
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("uses error styling when a bridge ends in the errored state", async () => {
    const toast = vi.fn();
    mockFetchSequence([
      { bridges: [bridgeRecord({ state: "active" })] },
      { bridges: [bridgeRecord({ state: "errored" })] },
    ]);

    await act(async () => {
      render(<BridgePollHarness toast={toast} />);
    });
    await act(async () => {});

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(
      "Bridge Session 18 ↔ Session 21 failed — a session died or a write failed",
      "error",
    );
  });

  it("does not toast for a bridge that is already ended on the very first poll (reload mid-TTL)", async () => {
    const toast = vi.fn();
    mockFetchSequence([{ bridges: [bridgeRecord({ state: "ended_sentinel" })] }]);

    await act(async () => {
      render(<BridgePollHarness toast={toast} />);
    });
    await act(async () => {});

    expect(toast).not.toHaveBeenCalled();
  });

  it("stays silent when the poll fetch fails (soft-fail, matches existing polling behavior)", async () => {
    const toast = vi.fn();
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down"));

    await act(async () => {
      render(<BridgePollHarness toast={toast} />);
    });
    await act(async () => {});

    expect(toast).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Channel polling
// ===========================================================================

describe("App channel poll — end-of-channel toast", () => {
  it("toasts with the channel wording (lead + worker count) when a channel is stopped by the user", async () => {
    const toast = vi.fn();
    mockFetchSequence([
      { channels: [channelRecord({ state: "active" })] },
      { channels: [channelRecord({ state: "ended_user" })] },
    ]);

    await act(async () => {
      render(<ChannelPollHarness toast={toast} />);
    });
    await act(async () => {});

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith("Channel Session 5 + 1 worker stopped", "info");
  });
});
