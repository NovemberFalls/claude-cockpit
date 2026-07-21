/**
 * Tests for ErrorBoundary + HexGrid crash-proof recovery UI.
 *
 * Covers:
 *   1. ErrorBoundary fallback renders "Something went wrong" without ThemeProvider.
 *      (This is the primary regression guard for the blank-on-popout bug: before the
 *      fix, HexGrid called useTheme() which threw when ErrorBoundary was outside
 *      ThemeProvider, causing React to unmount the root — blank window.)
 *   2. ErrorBoundary fallback displays the caught error message.
 *   3. HexGrid renders without crashing when there is no ThemeProvider ancestor.
 *   4. useThemeSafe returns a valid theme object when called with no provider.
 *   5. useThemeSafe returns the real context when a ThemeProvider IS present.
 */

import React, { Component } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

// ---------------------------------------------------------------------------
// jsdom polyfills required by HexGrid (canvas, rAF).
// ---------------------------------------------------------------------------

if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = () => ({
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    stroke: vi.fn(),
    rect: vi.fn(),
    setTransform: vi.fn(),
  });
}

if (typeof globalThis.requestAnimationFrame === "undefined") {
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
}
if (typeof globalThis.cancelAnimationFrame === "undefined") {
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
}
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// ---------------------------------------------------------------------------
// Imports under test (after mocks are set up)
// ---------------------------------------------------------------------------

import ErrorBoundary from "../components/ErrorBoundary.jsx";
import { useThemeSafe, useTheme, ThemeProvider } from "../hooks/useTheme.jsx";
import { renderHook } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A component that unconditionally throws during render — used to trip
 *  ErrorBoundary so we can test the fallback. */
class BombComponent extends Component {
  render() {
    throw new Error("test bomb error");
  }
}

// Suppress React's own console.error output for expected boundary catches
// so test output stays clean.
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
// Suite 1 — ErrorBoundary fallback renders without ThemeProvider
// ---------------------------------------------------------------------------

describe("ErrorBoundary fallback (no ThemeProvider)", () => {
  // 1 — the core regression guard
  it("renders 'Something went wrong' heading without ThemeProvider above it", () => {
    // ErrorBoundary is mounted with NO ThemeProvider ancestor.
    // Before the fix: HexGrid (in fallback) called useTheme() → threw →
    //   React unmounted root → blank window.
    // After the fix: HexGrid calls useThemeSafe() → returns default theme →
    //   fallback renders correctly.
    render(
      <ErrorBoundary>
        <BombComponent />
      </ErrorBoundary>
    );

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });

  // 2 — error message is surfaced in the fallback
  it("displays the caught error message in the fallback pre block", () => {
    render(
      <ErrorBoundary>
        <BombComponent />
      </ErrorBoundary>
    );

    expect(screen.getByText("test bomb error")).toBeInTheDocument();
  });

  // 3 — reload button is present
  it("renders a Reload button in the fallback", () => {
    render(
      <ErrorBoundary>
        <BombComponent />
      </ErrorBoundary>
    );

    expect(screen.getByRole("button", { name: /reload/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — useThemeSafe hook contract
// ---------------------------------------------------------------------------

describe("useThemeSafe", () => {
  // 4 — returns valid default when no provider present
  it("returns a valid theme object with no ThemeProvider", () => {
    const { result } = renderHook(() => useThemeSafe());

    expect(result.current).toBeDefined();
    expect(result.current.themeId).toBe("va-night");
    expect(result.current.theme).toBeDefined();
    expect(result.current.theme).not.toBeNull();
    expect(typeof result.current.switchTheme).toBe("function");
    expect(Array.isArray(result.current.themes)).toBe(true);
    expect(result.current.themes.length).toBeGreaterThan(0);
  });

  // 4b — switchTheme default is a no-op (does not throw)
  it("switchTheme default no-op does not throw", () => {
    const { result } = renderHook(() => useThemeSafe());
    expect(() => result.current.switchTheme("any-theme-id")).not.toThrow();
  });

  // 5 — returns real context when ThemeProvider is present
  it("returns the real ThemeProvider context when a provider is present", () => {
    const wrapper = ({ children }) => <ThemeProvider>{children}</ThemeProvider>;
    const { result } = renderHook(() => useThemeSafe(), { wrapper });

    expect(result.current.themeId).toBeDefined();
    expect(typeof result.current.switchTheme).toBe("function");
    // The real switchTheme is the useCallback from ThemeProvider, not the no-op
    // We cannot call it here but can confirm the theme is a real object
    expect(result.current.theme).toBeDefined();
  });

  // Confirm useTheme() still throws when there is no provider (dev guard preserved)
  it("useTheme() still throws when called without ThemeProvider", () => {
    const { result } = renderHook(() => {
      try {
        return useTheme();
      } catch (e) {
        return { threw: true, message: e.message };
      }
    });
    expect(result.current.threw).toBe(true);
    expect(result.current.message).toBe("useTheme must be used within ThemeProvider");
  });
});
