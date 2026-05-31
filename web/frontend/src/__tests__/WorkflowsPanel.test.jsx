/**
 * Tests for WorkflowsPanel (web/frontend/src/components/WorkflowsPanel.jsx).
 *
 * Covers:
 *   1. Empty state — "No recent workflows." text appears when workflows=[].
 *   2. Rows render — both workflow names appear; in-progress row has the
 *      pulsing animation on its status dot.
 *   3. Error completed state — dot uses var(--red) for is_error: true.
 *   4. Backdrop click calls onClose.
 */

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import WorkflowsPanel from "../components/WorkflowsPanel.jsx";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const IN_PROGRESS_WF = {
  tool_id: "toolu_wf_ip",
  name: "Deploy",
  description: "deploy step",
  status: "in_progress",
  is_error: false,
  started_at: new Date().toISOString(),
  completed_at: null,
};

const COMPLETED_WF = {
  tool_id: "toolu_wf_done",
  name: "Build",
  description: "build step",
  status: "completed",
  is_error: false,
  started_at: new Date(Date.now() - 120000).toISOString(),
  completed_at: new Date(Date.now() - 60000).toISOString(),
};

const ERROR_WF = {
  tool_id: "toolu_wf_err",
  name: "Test",
  description: "",
  status: "completed",
  is_error: true,
  started_at: new Date(Date.now() - 300000).toISOString(),
  completed_at: new Date(Date.now() - 180000).toISOString(),
};

// ---------------------------------------------------------------------------
// Test 1 — empty state
// ---------------------------------------------------------------------------

describe("WorkflowsPanel — empty state", () => {
  it("renders 'No recent workflows.' when workflows is empty", () => {
    render(<WorkflowsPanel workflows={[]} onClose={vi.fn()} />);
    expect(screen.getByText("No recent workflows.")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Test 2 — rows render with correct animation on in-progress dot
// ---------------------------------------------------------------------------

describe("WorkflowsPanel — workflow rows", () => {
  it("renders both workflow names when two workflows are provided", () => {
    render(
      <WorkflowsPanel
        workflows={[IN_PROGRESS_WF, COMPLETED_WF]}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("Deploy")).toBeInTheDocument();
    expect(screen.getByText("Build")).toBeInTheDocument();
  });

  it("in-progress dot has state-pulse animation in its inline style", () => {
    const { container } = render(
      <WorkflowsPanel
        workflows={[IN_PROGRESS_WF]}
        onClose={vi.fn()}
      />
    );

    // The dot is an aria-hidden div with inline style animation.
    // Query all divs that have an animation style containing "state-pulse".
    const dots = container.querySelectorAll("div[aria-hidden='true']");
    const pulsingDot = Array.from(dots).find(
      (el) => el.style.animation && el.style.animation.includes("state-pulse")
    );

    expect(pulsingDot).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Test 3 — error completed state uses var(--red)
// ---------------------------------------------------------------------------

describe("WorkflowsPanel — error state", () => {
  it("error-completed dot uses var(--red) background color", () => {
    const { container } = render(
      <WorkflowsPanel workflows={[ERROR_WF]} onClose={vi.fn()} />
    );

    const dots = container.querySelectorAll("div[aria-hidden='true']");
    const redDot = Array.from(dots).find(
      (el) => el.style.backgroundColor === "var(--red)"
    );

    expect(redDot).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Test 4 — backdrop click calls onClose
// ---------------------------------------------------------------------------

describe("WorkflowsPanel — backdrop", () => {
  it("calls onClose when the backdrop is clicked", () => {
    const onClose = vi.fn();
    const { container } = render(
      <WorkflowsPanel workflows={[]} onClose={onClose} />
    );

    // The backdrop is the fixed inset-0 z-40 div
    const backdrop = container.querySelector(".fixed.inset-0.z-40");
    expect(backdrop).toBeTruthy();

    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
