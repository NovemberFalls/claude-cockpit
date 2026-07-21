/**
 * Tests for FleetView (web/frontend/src/components/FleetView.jsx).
 *
 * Covers:
 *   1. Renders without crashing on empty/undefined props.
 *   2. Renders daily total cost from dailyUsage.
 *   3. Renders per-session cards from usageByTerminal.
 *   4. Close button fires onClose.
 */

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import FleetView from "../components/FleetView.jsx";

const SESSIONS = [
  { id: "s1", terminalId: "term-1", name: "Alpha", model: "claude-opus-4", status: "idle", activityState: "idle" },
  { id: "s2", terminalId: "term-2", name: "Beta", model: "claude-sonnet-5", status: "busy", activityState: "busy" },
];

const USAGE_BY_TERMINAL = {
  "term-1": { total_tokens: 1200000, est_cost_usd: 12.5, tokensPerSec: 0, effort: "low" },
  "term-2": { total_tokens: 4500, est_cost_usd: 0.45, tokensPerSec: 30, effort: null },
};

const DAILY_USAGE = {
  day: "2026-07-19",
  est_cost_usd: 42.5,
  by_model: {
    "claude-opus-4": { est_cost_usd: 30.0, input_tokens: 1000000, output_tokens: 1000000 },
    "claude-sonnet-5": { est_cost_usd: 12.5, input_tokens: 500000, output_tokens: 500000 },
  },
};

describe("FleetView — empty/undefined props", () => {
  it("renders without crashing when no props are given", () => {
    expect(() => render(<FleetView />)).not.toThrow();
  });

  it("shows the no-sessions message when sessions is empty", () => {
    render(<FleetView sessions={[]} onClose={vi.fn()} />);
    expect(screen.getByText("No sessions yet.")).toBeInTheDocument();
  });

  it("shows the no-usage-today message when dailyUsage is undefined", () => {
    render(<FleetView sessions={[]} onClose={vi.fn()} />);
    expect(screen.getByText("No usage recorded today.")).toBeInTheDocument();
  });
});

describe("FleetView — daily total", () => {
  it("renders today's total cost from dailyUsage", () => {
    render(
      <FleetView
        sessions={SESSIONS}
        usageByTerminal={USAGE_BY_TERMINAL}
        dailyUsage={DAILY_USAGE}
        workflowsByTerminal={{}}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByText("Today: $42.50")).toBeInTheDocument();
  });

  it("renders per-model breakdown rows from dailyUsage.by_model", () => {
    render(
      <FleetView
        sessions={SESSIONS}
        usageByTerminal={USAGE_BY_TERMINAL}
        dailyUsage={DAILY_USAGE}
        workflowsByTerminal={{}}
        onClose={vi.fn()}
      />
    );
    expect(screen.getAllByText("claude-opus-4").length).toBeGreaterThan(0);
    expect(screen.getAllByText("claude-sonnet-5").length).toBeGreaterThan(0);
  });
});

describe("FleetView — per-session cards", () => {
  it("renders one card per session with name, model, and usage stats", () => {
    render(
      <FleetView
        sessions={SESSIONS}
        usageByTerminal={USAGE_BY_TERMINAL}
        dailyUsage={DAILY_USAGE}
        workflowsByTerminal={{}}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getAllByText("claude-opus-4").length).toBeGreaterThan(0);
    expect(screen.getAllByText("claude-sonnet-5").length).toBeGreaterThan(0);
    // effort chip for session with effort set
    expect(screen.getByText("low")).toBeInTheDocument();
    // token/cost stats
    expect(screen.getByText(/1\.2M/)).toBeInTheDocument();
    expect(screen.getAllByText("$12.50").length).toBeGreaterThan(0);
    expect(screen.getByText("$0.45")).toBeInTheDocument();
    // tok/s only shown when > 0
    expect(screen.getByText("30 t/s")).toBeInTheDocument();
  });
});

describe("FleetView — close button", () => {
  it("calls onClose when the close button is clicked", () => {
    const onClose = vi.fn();
    render(
      <FleetView
        sessions={SESSIONS}
        usageByTerminal={USAGE_BY_TERMINAL}
        dailyUsage={DAILY_USAGE}
        workflowsByTerminal={{}}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByLabelText("Close fleet view"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
