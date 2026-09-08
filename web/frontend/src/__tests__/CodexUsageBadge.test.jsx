import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import CodexUsageBadge from "../components/CodexUsageBadge.jsx";

afterEach(cleanup);

it("labels retained metrics when the current conversation is unverified", () => {
  render(<CodexUsageBadge usage={{ binding_status: "last_known" }} />);
  expect(screen.getByText("Last known")).toHaveAttribute("title", expect.stringContaining("could not be verified"));
});

it("shows unknown telemetry instead of a zero cost or zero context", () => {
  render(<CodexUsageBadge usage={{ usage_available: false, est_cost_usd: null }} />);
  expect(screen.getByText("Ctx unknown")).toBeInTheDocument();
  expect(screen.getByText("Usage pending")).toBeInTheDocument();
  expect(screen.getByText("API unknown")).toBeInTheDocument();
  expect(screen.queryByText(/\$0\.00/)).not.toBeInTheDocument();
});

it("separates current context from cumulative usage and labels the API estimate", () => {
  render(<CodexUsageBadge usage={{ usage_available: true, total_tokens: 1200000,
    context_tokens: 129200, context_window: 258400, context_percent: 50, est_cost_usd: 12.34 }} />);
  expect(screen.getByText("129.2K/258.4K")).toBeInTheDocument();
  expect(screen.getByRole("meter", { name: "Context window used" })).toHaveAttribute("aria-valuenow", "50");
  expect(screen.getByRole("meter").querySelectorAll("circle")).toHaveLength(2);
  expect(screen.getByText("50%")).toBeInTheDocument();
  expect(screen.getByText("1.2M tokens")).toBeInTheDocument();
  expect(screen.getByText("API ≈$12.34")).toHaveAttribute("title", expect.stringContaining("not your ChatGPT subscription bill"));
});
