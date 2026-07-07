/**
 * Unit tests for web/frontend/src/utils/bridgeEvents.js — the pure helpers
 * that detect when a peer bridge (V2) or channel (V3) run has ended, so
 * App.jsx can toast the reason instead of letting the pulsing pane glow
 * vanish silently.
 *
 * What is tested:
 *   computeEndEvents      — active->terminal transition detection, seeding,
 *                            vanish-while-active, dedupe, malformed input
 *   formatEndEventToast   — human-readable copy + Toast type per endState
 */

import { describe, it, expect } from "vitest";
import {
  computeEndEvents,
  formatEndEventToast,
  BRIDGE_KIND,
  CHANNEL_KIND,
} from "../utils/bridgeEvents";

// ---------------------------------------------------------------------------
// Fixtures
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
    worker_ids: ["term-w1", "term-w2"],
    worker_names: { "term-w1": "Worker One", "term-w2": "Worker Two" },
    turns_used: 3,
    max_turns: 6,
    state: "active",
    ...overrides,
  };
}

// ===========================================================================
// computeEndEvents
// ===========================================================================

describe("computeEndEvents", () => {
  it("fires no event on the first poll while a record is active (seeding)", () => {
    const prevStates = new Map();
    const seenIds = new Set();
    const events = computeEndEvents(BRIDGE_KIND, [bridgeRecord({ state: "active" })], prevStates, seenIds);

    expect(events).toEqual([]);
    expect(prevStates.get("b1").state).toBe("active");
    expect(seenIds.size).toBe(0);
  });

  it("fires exactly once when a previously-active id transitions to an ended state", () => {
    const prevStates = new Map();
    const seenIds = new Set();

    // Poll 1: active — seeds prevStates, no event.
    computeEndEvents(BRIDGE_KIND, [bridgeRecord({ state: "active" })], prevStates, seenIds);

    // Poll 2: same id now ended_capped — must fire.
    const events = computeEndEvents(
      BRIDGE_KIND,
      [bridgeRecord({ state: "ended_capped", turns_used: 4, max_turns: 4 })],
      prevStates,
      seenIds,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: "b1", kind: BRIDGE_KIND, endState: "ended_capped" });
    expect(events[0].record.turns_used).toBe(4);
    expect(seenIds.has("b1")).toBe(true);
  });

  it("never fires for a record that is already ended on the very first poll it is observed", () => {
    const prevStates = new Map();
    const seenIds = new Set();

    // App just loaded; backend's TTL window still has a recently-ended
    // record in the payload. No toast storm on reload.
    const events = computeEndEvents(
      BRIDGE_KIND,
      [bridgeRecord({ state: "ended_sentinel" })],
      prevStates,
      seenIds,
    );

    expect(events).toEqual([]);
    expect(seenIds.size).toBe(0);
    // Still seeded so a later poll of the SAME id doesn't retroactively fire.
    expect(prevStates.get("b1").state).toBe("ended_sentinel");
  });

  it("does not refire on subsequent polls that keep observing the same ended state (TTL window)", () => {
    const prevStates = new Map();
    const seenIds = new Set();

    computeEndEvents(BRIDGE_KIND, [bridgeRecord({ state: "active" })], prevStates, seenIds);
    const firstEnd = computeEndEvents(BRIDGE_KIND, [bridgeRecord({ state: "ended_user" })], prevStates, seenIds);
    expect(firstEnd).toHaveLength(1);

    // Backend keeps serving the ended record for the rest of its TTL.
    const secondPoll = computeEndEvents(BRIDGE_KIND, [bridgeRecord({ state: "ended_user" })], prevStates, seenIds);
    const thirdPoll = computeEndEvents(BRIDGE_KIND, [bridgeRecord({ state: "ended_user" })], prevStates, seenIds);

    expect(secondPoll).toEqual([]);
    expect(thirdPoll).toEqual([]);
  });

  it("fires a generic (endState: null) event when a previously-active id vanishes from the payload", () => {
    const prevStates = new Map();
    const seenIds = new Set();

    computeEndEvents(BRIDGE_KIND, [bridgeRecord({ state: "active" })], prevStates, seenIds);

    // Next poll: the record is gone entirely (TTL race / backend restart).
    const events = computeEndEvents(BRIDGE_KIND, [], prevStates, seenIds);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: "b1", kind: BRIDGE_KIND, endState: null });
    expect(events[0].record.from_name).toBe("Session 18"); // last-known snapshot preserved
    expect(prevStates.has("b1")).toBe(false); // pruned — never reappears
  });

  it("does not fire a vanish event for a record that already ended before it vanished", () => {
    const prevStates = new Map();
    const seenIds = new Set();

    computeEndEvents(BRIDGE_KIND, [bridgeRecord({ state: "active" })], prevStates, seenIds);
    const endedEvents = computeEndEvents(BRIDGE_KIND, [bridgeRecord({ state: "errored" })], prevStates, seenIds);
    expect(endedEvents).toHaveLength(1); // fired once, as errored

    // Now it vanishes from the payload entirely (TTL prune). Must NOT fire
    // again — prevStates already reflects "errored", not "active", by the
    // time it vanishes.
    const vanishEvents = computeEndEvents(BRIDGE_KIND, [], prevStates, seenIds);
    expect(vanishEvents).toEqual([]);
  });

  it("dedupes across many repeated polls even if seenIds were somehow bypassed for prevStates", () => {
    const prevStates = new Map();
    const seenIds = new Set();

    computeEndEvents(BRIDGE_KIND, [bridgeRecord({ state: "active" })], prevStates, seenIds);
    let totalEvents = 0;
    for (let i = 0; i < 5; i++) {
      const events = computeEndEvents(BRIDGE_KIND, [bridgeRecord({ state: "ended_capped" })], prevStates, seenIds);
      totalEvents += events.length;
    }
    expect(totalEvents).toBe(1);
  });

  it("handles multiple independent ids concurrently without cross-contamination", () => {
    const prevStates = new Map();
    const seenIds = new Set();

    computeEndEvents(
      BRIDGE_KIND,
      [bridgeRecord({ bridge_id: "b1", state: "active" }), bridgeRecord({ bridge_id: "b2", state: "active" })],
      prevStates,
      seenIds,
    );

    const events = computeEndEvents(
      BRIDGE_KIND,
      [
        bridgeRecord({ bridge_id: "b1", state: "active" }), // still running
        bridgeRecord({ bridge_id: "b2", state: "ended_capped" }), // ended
      ],
      prevStates,
      seenIds,
    );

    expect(events).toHaveLength(1);
    expect(events[0].id).toBe("b2");
  });

  it("works for channel records using channel_id", () => {
    const prevStates = new Map();
    const seenIds = new Set();

    computeEndEvents(CHANNEL_KIND, [channelRecord({ state: "active" })], prevStates, seenIds);
    const events = computeEndEvents(CHANNEL_KIND, [channelRecord({ state: "ended_sentinel" })], prevStates, seenIds);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: "c1", kind: CHANNEL_KIND, endState: "ended_sentinel" });
  });

  // -------------------------------------------------------------------------
  // Malformed input — must never throw, must be silently ignored.
  // -------------------------------------------------------------------------

  it("ignores non-array records without throwing", () => {
    const prevStates = new Map();
    const seenIds = new Set();
    expect(() => computeEndEvents(BRIDGE_KIND, null, prevStates, seenIds)).not.toThrow();
    expect(() => computeEndEvents(BRIDGE_KIND, undefined, prevStates, seenIds)).not.toThrow();
    expect(() => computeEndEvents(BRIDGE_KIND, "not-an-array", prevStates, seenIds)).not.toThrow();
    expect(computeEndEvents(BRIDGE_KIND, null, prevStates, seenIds)).toEqual([]);
  });

  it("skips null/non-object entries inside the records array", () => {
    const prevStates = new Map();
    const seenIds = new Set();
    const events = computeEndEvents(
      BRIDGE_KIND,
      [null, undefined, 42, "oops", bridgeRecord({ state: "active" })],
      prevStates,
      seenIds,
    );
    expect(events).toEqual([]);
    expect(prevStates.size).toBe(1);
  });

  it("skips entries missing an id field", () => {
    const prevStates = new Map();
    const seenIds = new Set();
    const rec = bridgeRecord({ state: "active" });
    delete rec.bridge_id;
    const events = computeEndEvents(BRIDGE_KIND, [rec], prevStates, seenIds);
    expect(events).toEqual([]);
    expect(prevStates.size).toBe(0);
  });

  it("skips entries missing or non-string state", () => {
    const prevStates = new Map();
    const seenIds = new Set();
    const events = computeEndEvents(
      BRIDGE_KIND,
      [bridgeRecord({ state: undefined }), bridgeRecord({ bridge_id: "b2", state: 123 })],
      prevStates,
      seenIds,
    );
    expect(events).toEqual([]);
    expect(prevStates.size).toBe(0);
  });

  it("returns an empty array for an unknown kind instead of throwing", () => {
    const prevStates = new Map();
    const seenIds = new Set();
    expect(computeEndEvents("bogus", [bridgeRecord()], prevStates, seenIds)).toEqual([]);
  });

  it("returns an empty array if prevStates/seenIds are not the expected collection types", () => {
    expect(computeEndEvents(BRIDGE_KIND, [bridgeRecord()], {}, new Set())).toEqual([]);
    expect(computeEndEvents(BRIDGE_KIND, [bridgeRecord()], new Map(), [])).toEqual([]);
  });
});

// ===========================================================================
// formatEndEventToast
// ===========================================================================

describe("formatEndEventToast", () => {
  it("formats ended_capped with turn counts when available", () => {
    const { message, type } = formatEndEventToast({
      kind: BRIDGE_KIND,
      endState: "ended_capped",
      record: bridgeRecord({ turns_used: 4, max_turns: 4 }),
    });
    expect(message).toBe("Bridge Session 18 ↔ Session 21 ended: turn limit reached (4/4)");
    expect(type).toBe("info");
  });

  it("formats ended_capped without counts when turns_used/max_turns are missing", () => {
    const record = bridgeRecord();
    delete record.turns_used;
    delete record.max_turns;
    const { message } = formatEndEventToast({ kind: BRIDGE_KIND, endState: "ended_capped", record });
    expect(message).toBe("Bridge Session 18 ↔ Session 21 ended: turn limit reached");
  });

  it("formats ended_sentinel", () => {
    const { message, type } = formatEndEventToast({
      kind: BRIDGE_KIND,
      endState: "ended_sentinel",
      record: bridgeRecord(),
    });
    expect(message).toBe("Bridge Session 18 ↔ Session 21 ended: task completed (BRIDGE-DONE)");
    expect(type).toBe("info");
  });

  it("formats ended_user as a stop, not an 'ended:' phrase", () => {
    const { message, type } = formatEndEventToast({
      kind: BRIDGE_KIND,
      endState: "ended_user",
      record: bridgeRecord(),
    });
    expect(message).toBe("Bridge Session 18 ↔ Session 21 stopped");
    expect(type).toBe("info");
  });

  it("formats errored with error styling", () => {
    const { message, type } = formatEndEventToast({
      kind: BRIDGE_KIND,
      endState: "errored",
      record: bridgeRecord(),
    });
    expect(message).toBe("Bridge Session 18 ↔ Session 21 failed — a session died or a write failed");
    expect(type).toBe("error");
  });

  it("formats a generic (vanished) event with endState: null", () => {
    const { message, type } = formatEndEventToast({
      kind: BRIDGE_KIND,
      endState: null,
      record: bridgeRecord(),
    });
    expect(message).toBe("Bridge Session 18 ↔ Session 21 ended");
    expect(type).toBe("info");
  });

  it("omits names entirely when the record does not expose from_name/to_name", () => {
    const { message } = formatEndEventToast({
      kind: BRIDGE_KIND,
      endState: "ended_user",
      record: { bridge_id: "b1", state: "ended_user" },
    });
    expect(message).toBe("Bridge stopped");
  });

  it("formats channel events using the lead name and worker count", () => {
    const { message } = formatEndEventToast({
      kind: CHANNEL_KIND,
      endState: "ended_capped",
      record: channelRecord({ turns_used: 6, max_turns: 6 }),
    });
    expect(message).toBe("Channel Session 5 + 2 workers ended: turn limit reached (6/6)");
  });

  it("uses singular 'worker' for a single-worker channel", () => {
    const { message } = formatEndEventToast({
      kind: CHANNEL_KIND,
      endState: "ended_user",
      record: channelRecord({ worker_ids: ["term-w1"], worker_names: { "term-w1": "Worker One" } }),
    });
    expect(message).toBe("Channel Session 5 + 1 worker stopped");
  });

  it("falls back to lead name alone when worker_names is empty/missing", () => {
    const { message } = formatEndEventToast({
      kind: CHANNEL_KIND,
      endState: "ended_user",
      record: channelRecord({ worker_names: {} }),
    });
    expect(message).toBe("Channel Session 5 stopped");
  });

  it("never throws on a malformed event object", () => {
    expect(() => formatEndEventToast(null)).not.toThrow();
    expect(() => formatEndEventToast(undefined)).not.toThrow();
    expect(() => formatEndEventToast({})).not.toThrow();
    expect(formatEndEventToast({}).type).toBe("info");
    expect(() => formatEndEventToast({ kind: BRIDGE_KIND, endState: "errored", record: null })).not.toThrow();
  });
});
