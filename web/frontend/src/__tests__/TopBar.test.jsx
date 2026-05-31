/**
 * Tests for TopBar model picker — verifies Claude 4.8 group appears
 * and is ordered before Claude 4.7.
 *
 * TopBar calls useTheme() which requires a ThemeProvider. We wrap
 * the render in a ThemeProvider to satisfy that requirement.
 */

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ThemeProvider } from "../hooks/useTheme.jsx";
import TopBar from "../components/TopBar.jsx";

// lucide-react icons render as real SVGs — no mock needed.

function renderTopBar(modelOverride = "claude-opus-4-7") {
  return render(
    <ThemeProvider>
      <TopBar
        model={modelOverride}
        setModel={vi.fn()}
        sidebarOpen={false}
        setSidebarOpen={vi.fn()}
        user={{ name: "X" }}
      />
    </ThemeProvider>
  );
}

// ---------------------------------------------------------------------------
// Suite — Claude 4.8 models appear in the picker
// ---------------------------------------------------------------------------

describe("TopBar model picker — Claude 4.8 group", () => {
  it("shows Opus 4.8 and Opus 4.8 (1M) entries after opening the picker", () => {
    renderTopBar();

    // Open the model picker by clicking the button that shows the current model label
    const pickerButton = screen.getByRole("button", { name: /opus/i });
    fireEvent.click(pickerButton);

    // Both model entries must be in the DOM
    expect(screen.getByText("Opus 4.8")).toBeInTheDocument();
    expect(screen.getByText("Opus 4.8 (1M)")).toBeInTheDocument();
  });

  it("shows the Claude 4.8 group label in the picker", () => {
    renderTopBar();

    const pickerButton = screen.getByRole("button", { name: /opus/i });
    fireEvent.click(pickerButton);

    expect(screen.getByText("Claude 4.8")).toBeInTheDocument();
  });

  it("Claude 4.8 group label appears before Claude 4.7 group label in the DOM", () => {
    renderTopBar();

    const pickerButton = screen.getByRole("button", { name: /opus/i });
    fireEvent.click(pickerButton);

    const allText = document.body.textContent;
    const idx48 = allText.indexOf("Claude 4.8");
    const idx47 = allText.indexOf("Claude 4.7");

    expect(idx48).toBeGreaterThan(-1);
    expect(idx47).toBeGreaterThan(-1);
    expect(idx48).toBeLessThan(idx47);
  });
});
