/**
 * Tests for the local-broker panels
 * (LaneQueuePanel.jsx + LocalMetricsPanel.jsx).
 *
 * Covers:
 *   1. LaneQueuePanel renders in-flight + queued jobs and the spill count.
 *   2. LaneQueuePanel shows an offline message when queue is null/unreachable.
 *   3. LaneQueuePanel's spill slider is disabled (broker write endpoint not wired).
 *   4. LocalMetricsPanel renders runs/prompts/tokens + derived runs-per-prompt.
 *   5. LocalMetricsPanel window buttons call setWindow.
 *   6. LocalMetricsPanel renders the verbatim broker definitions.
 */

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import LaneQueuePanel from "../components/LaneQueuePanel.jsx";
import LocalMetricsPanel from "../components/LocalMetricsPanel.jsx";

const QUEUE = {
  in_flight: { id: "abc1234567890", class: "workhorse" },
  queued: [
    { id: "q1", class: "mundane" },
    { id: "q2", class: "workhorse" },
  ],
  estimated_clear_seconds: 42,
  spill: 3,
};

const METRICS = {
  window: "lifetime",
  window_start: "2026-07-01T00:00:00Z",
  persisted: true,
  runs_total: 812,
  prompts_total: 640,
  tokens_total: { prompt: 900000, completion: 300000 },
  tokens_per_sec: { current: 34, avg: 29 },
  run_time_ms: { min: 120, max: 90000, avg: 4200, p50: 3000, p95: 12000 },
  by_session: [{ key: "client-a", runs_total: 400, prompts_total: 320, tokens_total: { prompt: 500000, completion: 150000 } }],
  by_agent: [{ key: "ash", runs_total: 200, prompts_total: 200, tokens_total: { prompt: 200000, completion: 60000 } }],
  by_lane_class: [{ key: "workhorse", runs_total: 600, prompts_total: 480, tokens_total: { prompt: 700000, completion: 250000 } }],
};

describe("LaneQueuePanel", () => {
  it("renders in-flight + queued jobs and spill count", () => {
    render(<LaneQueuePanel queue={QUEUE} />);
    expect(screen.getAllByText(/workhorse/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/spill: 3/)).toBeInTheDocument();
    expect(screen.getByText(/queued: 2/)).toBeInTheDocument();
    expect(screen.getByText(/clears ~42s/)).toBeInTheDocument();
  });

  it("shows offline message when queue is null", () => {
    render(<LaneQueuePanel queue={null} />);
    expect(screen.getByText(/Broker offline/)).toBeInTheDocument();
  });

  it("disables the spill slider (write endpoint not wired)", () => {
    render(<LaneQueuePanel queue={QUEUE} />);
    const slider = screen.getByRole("slider");
    expect(slider).toBeDisabled();
  });
});

describe("LocalMetricsPanel", () => {
  it("renders runs, prompts, tokens and derived runs/prompt", () => {
    render(<LocalMetricsPanel metrics={METRICS} window="lifetime" setWindow={() => {}} />);
    expect(screen.getByText("812")).toBeInTheDocument();
    expect(screen.getByText("640")).toBeInTheDocument();
    expect(screen.getByText(/1\.27 runs\/prompt/)).toBeInTheDocument(); // 812/640
  });

  it("calls setWindow when a window button is clicked", () => {
    const setWindow = vi.fn();
    render(<LocalMetricsPanel metrics={METRICS} window="lifetime" setWindow={setWindow} />);
    fireEvent.click(screen.getByText("24h"));
    expect(setWindow).toHaveBeenCalledWith("24h");
  });

  it("renders the verbatim broker definitions", () => {
    render(<LocalMetricsPanel metrics={METRICS} window="lifetime" setWindow={() => {}} />);
    expect(screen.getByText(/run = one completion call to a lane/)).toBeInTheDocument();
    expect(screen.getByText(/session = X-Client-Id/)).toBeInTheDocument();
  });
});
