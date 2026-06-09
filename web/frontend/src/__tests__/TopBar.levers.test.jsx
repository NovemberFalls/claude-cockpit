/**
 * Tests for TopBar spawn-time levers: permission mode, effort, fast toggle.
 *
 * TopBar calls useTheme() which requires a ThemeProvider. We follow the same
 * pattern as TopBar.test.jsx — wrap every render in ThemeProvider.
 */

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ThemeProvider } from "../hooks/useTheme.jsx";
import TopBar from "../components/TopBar.jsx";

// ---------------------------------------------------------------------------
// Helper — renders TopBar with all lever props supplied as spies
// ---------------------------------------------------------------------------

function renderTopBar({
  model = "claude-opus-4-8",
  permissionMode = "default",
  effort = "",
  fast = false,
} = {}) {
  const spies = {
    setModel: vi.fn(),
    setPermissionMode: vi.fn(),
    setEffort: vi.fn(),
    setFast: vi.fn(),
    setSidebarOpen: vi.fn(),
  };

  render(
    <ThemeProvider>
      <TopBar
        model={model}
        setModel={spies.setModel}
        permissionMode={permissionMode}
        setPermissionMode={spies.setPermissionMode}
        effort={effort}
        setEffort={spies.setEffort}
        fast={fast}
        setFast={spies.setFast}
        sidebarOpen={false}
        setSidebarOpen={spies.setSidebarOpen}
        user={{ name: "X" }}
      />
    </ThemeProvider>
  );

  return spies;
}

// ---------------------------------------------------------------------------
// Permission-mode pill
// ---------------------------------------------------------------------------

describe("TopBar — permission mode pill", () => {
  it("renders current permission mode label uppercased in the pill button", () => {
    renderTopBar({ permissionMode: "plan" });
    // The pill button shows the label for "plan" → "Plan", uppercased → "PLAN"
    expect(screen.getByRole("button", { name: /permission mode: plan/i })).toBeInTheDocument();
    // The visible text inside the pill is uppercased
    const pill = screen.getByRole("button", { name: /permission mode: plan/i });
    expect(pill.textContent).toMatch(/PLAN/);
  });

  it("shows 'ASK' label (default mode) when permissionMode is 'default'", () => {
    renderTopBar({ permissionMode: "default" });
    const pill = screen.getByRole("button", { name: /permission mode: ask/i });
    expect(pill.textContent).toMatch(/ASK/);
  });

  it("opens the permission-mode dropdown when the pill is clicked", () => {
    renderTopBar({ permissionMode: "default" });
    const pill = screen.getByRole("button", { name: /permission mode:/i });
    fireEvent.click(pill);
    // All four permission mode options should now be visible
    expect(screen.getByRole("option", { name: "Ask" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Plan" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Accept Edits" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Bypass" })).toBeInTheDocument();
  });

  it("calls setPermissionMode with 'plan' when the Plan option is clicked", () => {
    const spies = renderTopBar({ permissionMode: "default" });
    const pill = screen.getByRole("button", { name: /permission mode:/i });
    fireEvent.click(pill);
    const planOption = screen.getByRole("option", { name: "Plan" });
    fireEvent.click(planOption);
    expect(spies.setPermissionMode).toHaveBeenCalledWith("plan");
  });

  it("calls setPermissionMode with 'bypassPermissions' when Bypass is clicked", () => {
    const spies = renderTopBar({ permissionMode: "default" });
    const pill = screen.getByRole("button", { name: /permission mode:/i });
    fireEvent.click(pill);
    const bypassOption = screen.getByRole("option", { name: "Bypass" });
    fireEvent.click(bypassOption);
    expect(spies.setPermissionMode).toHaveBeenCalledWith("bypassPermissions");
  });

  it("calls setPermissionMode with 'acceptEdits' when Accept Edits is clicked", () => {
    const spies = renderTopBar({ permissionMode: "default" });
    const pill = screen.getByRole("button", { name: /permission mode:/i });
    fireEvent.click(pill);
    fireEvent.click(screen.getByRole("option", { name: "Accept Edits" }));
    expect(spies.setPermissionMode).toHaveBeenCalledWith("acceptEdits");
  });
});

// ---------------------------------------------------------------------------
// Effort pill
// ---------------------------------------------------------------------------

describe("TopBar — effort pill", () => {
  it("renders 'Auto' label when effort is empty string (default)", () => {
    renderTopBar({ effort: "" });
    expect(screen.getByRole("button", { name: /effort: auto/i })).toBeInTheDocument();
  });

  it("opens the effort dropdown when the pill is clicked", () => {
    renderTopBar({ effort: "" });
    fireEvent.click(screen.getByRole("button", { name: /effort:/i }));
    expect(screen.getByRole("option", { name: "Auto" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Low" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Medium" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "High" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "XHigh" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Max" })).toBeInTheDocument();
  });

  it("calls setEffort with 'high' when High is clicked", () => {
    const spies = renderTopBar({ effort: "" });
    fireEvent.click(screen.getByRole("button", { name: /effort:/i }));
    fireEvent.click(screen.getByRole("option", { name: "High" }));
    expect(spies.setEffort).toHaveBeenCalledWith("high");
  });

  it("calls setEffort with '' when Auto is clicked (maps to empty string)", () => {
    const spies = renderTopBar({ effort: "high" });
    fireEvent.click(screen.getByRole("button", { name: /effort:/i }));
    fireEvent.click(screen.getByRole("option", { name: "Auto" }));
    expect(spies.setEffort).toHaveBeenCalledWith("");
  });

  it("calls setEffort with 'max' when Max is clicked", () => {
    const spies = renderTopBar({ effort: "" });
    fireEvent.click(screen.getByRole("button", { name: /effort:/i }));
    fireEvent.click(screen.getByRole("option", { name: "Max" }));
    expect(spies.setEffort).toHaveBeenCalledWith("max");
  });

  it("calls setEffort with 'xhigh' when XHigh is clicked", () => {
    const spies = renderTopBar({ effort: "" });
    fireEvent.click(screen.getByRole("button", { name: /effort:/i }));
    fireEvent.click(screen.getByRole("option", { name: "XHigh" }));
    expect(spies.setEffort).toHaveBeenCalledWith("xhigh");
  });
});

// ---------------------------------------------------------------------------
// Fast toggle — disabled for non-Opus, enabled for Opus
// ---------------------------------------------------------------------------

describe("TopBar — fast toggle eligibility", () => {
  it("is DISABLED when model is a non-Opus id (sonnet)", () => {
    renderTopBar({ model: "sonnet", fast: false });
    const btn = screen.getByRole("button", { name: /fast mode/i });
    expect(btn).toBeDisabled();
  });

  it("is DISABLED when model is haiku", () => {
    renderTopBar({ model: "haiku", fast: false });
    const btn = screen.getByRole("button", { name: /fast mode/i });
    expect(btn).toBeDisabled();
  });

  it("is DISABLED when model is claude-sonnet-4-6 (no 'opus')", () => {
    renderTopBar({ model: "claude-sonnet-4-6", fast: false });
    const btn = screen.getByRole("button", { name: /fast mode/i });
    expect(btn).toBeDisabled();
  });

  it("is ENABLED when model is claude-opus-4-8", () => {
    renderTopBar({ model: "claude-opus-4-8", fast: false });
    const btn = screen.getByRole("button", { name: /fast mode/i });
    expect(btn).not.toBeDisabled();
  });

  it("is ENABLED when model is claude-opus-4-7", () => {
    renderTopBar({ model: "claude-opus-4-7", fast: false });
    const btn = screen.getByRole("button", { name: /fast mode/i });
    expect(btn).not.toBeDisabled();
  });

  it("is ENABLED when model is bare 'opus'", () => {
    renderTopBar({ model: "opus", fast: false });
    const btn = screen.getByRole("button", { name: /fast mode/i });
    expect(btn).not.toBeDisabled();
  });

  it("is ENABLED when model is claude-opus-4-8[1m]", () => {
    renderTopBar({ model: "claude-opus-4-8[1m]", fast: false });
    const btn = screen.getByRole("button", { name: /fast mode/i });
    expect(btn).not.toBeDisabled();
  });

  it("calls setFast when clicked with an Opus model", () => {
    const spies = renderTopBar({ model: "claude-opus-4-8", fast: false });
    const btn = screen.getByRole("button", { name: /fast mode/i });
    fireEvent.click(btn);
    expect(spies.setFast).toHaveBeenCalled();
  });

  it("does NOT call setFast when clicked with a non-Opus model (button is disabled)", () => {
    const spies = renderTopBar({ model: "sonnet", fast: false });
    const btn = screen.getByRole("button", { name: /fast mode/i });
    // Disabled buttons should not fire onClick; also the impl guards with fastEligible check.
    fireEvent.click(btn);
    expect(spies.setFast).not.toHaveBeenCalled();
  });

  it("has aria-pressed=true when fast=true and model is Opus", () => {
    renderTopBar({ model: "claude-opus-4-8", fast: true });
    const btn = screen.getByRole("button", { name: /fast mode on/i });
    expect(btn).toHaveAttribute("aria-pressed", "true");
  });

  it("has aria-pressed=false when fast=false and model is Opus", () => {
    renderTopBar({ model: "claude-opus-4-8", fast: false });
    const btn = screen.getByRole("button", { name: /fast mode off/i });
    expect(btn).toHaveAttribute("aria-pressed", "false");
  });
});
