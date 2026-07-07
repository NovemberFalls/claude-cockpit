/**
 * Unit tests for web/frontend/src/utils/terminalFit.js — the pure helpers
 * extracted from TerminalPane.jsx / PopoutTerminal.jsx's resize-notify path
 * (safeFit). These are plain functions with no xterm/DOM dependency, so they
 * can be tested directly without mocking xterm.js.
 *
 * What is tested:
 *   isContainerMeasurable — hidden/zero-size guard
 *   dimsChanged           — resize-notify dedupe
 *   debounce              — trailing-edge debounce + .cancel()
 *   loadPersistedZoom     — localStorage read with bounds-checking and fallback
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  MIN_MEASURABLE_SIZE,
  isContainerMeasurable,
  dimsChanged,
  debounce,
  ZOOM_STORAGE_KEY,
  DEFAULT_ZOOM,
  MIN_ZOOM,
  MAX_ZOOM,
  loadPersistedZoom,
} from "../utils/terminalFit";

describe("isContainerMeasurable", () => {
  it("returns false for null/undefined elements", () => {
    expect(isContainerMeasurable(null)).toBe(false);
    expect(isContainerMeasurable(undefined)).toBe(false);
  });

  it("returns false when width is below the minimum", () => {
    expect(isContainerMeasurable({ clientWidth: MIN_MEASURABLE_SIZE - 1, clientHeight: 500 })).toBe(false);
  });

  it("returns false when height is below the minimum", () => {
    expect(isContainerMeasurable({ clientWidth: 500, clientHeight: MIN_MEASURABLE_SIZE - 1 })).toBe(false);
  });

  it("returns false for a fully collapsed (display:none) element", () => {
    expect(isContainerMeasurable({ clientWidth: 0, clientHeight: 0 })).toBe(false);
  });

  it("returns true when both dimensions meet the minimum", () => {
    expect(isContainerMeasurable({ clientWidth: MIN_MEASURABLE_SIZE, clientHeight: MIN_MEASURABLE_SIZE })).toBe(true);
  });

  it("returns true for a normally-sized pane", () => {
    expect(isContainerMeasurable({ clientWidth: 800, clientHeight: 400 })).toBe(true);
  });
});

describe("dimsChanged", () => {
  it("returns true when there is no previous value (first fit)", () => {
    expect(dimsChanged(null, { cols: 80, rows: 24 })).toBe(true);
    expect(dimsChanged(undefined, { cols: 80, rows: 24 })).toBe(true);
  });

  it("returns true when next is missing", () => {
    expect(dimsChanged({ cols: 80, rows: 24 }, null)).toBe(true);
  });

  it("returns false when cols and rows are identical", () => {
    expect(dimsChanged({ cols: 136, rows: 26 }, { cols: 136, rows: 26 })).toBe(false);
  });

  it("returns true when cols differs (e.g. zoom out, more columns fit)", () => {
    expect(dimsChanged({ cols: 136, rows: 26 }, { cols: 150, rows: 26 })).toBe(true);
  });

  it("returns true when rows differs", () => {
    expect(dimsChanged({ cols: 136, rows: 26 }, { cols: 136, rows: 30 })).toBe(true);
  });

  it("returns true when both differ", () => {
    expect(dimsChanged({ cols: 136, rows: 26 }, { cols: 80, rows: 24 })).toBe(true);
  });
});

describe("debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not invoke fn before the wait elapses", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 150);
    debounced();
    vi.advanceTimersByTime(100);
    expect(fn).not.toHaveBeenCalled();
  });

  it("invokes fn once after the wait elapses", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 150);
    debounced();
    vi.advanceTimersByTime(150);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("collapses a rapid burst into a single trailing call (ResizeObserver storm)", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 150);
    // Simulate a burst of ResizeObserver callbacks during a window drag-resize
    for (let i = 0; i < 20; i++) {
      debounced();
      vi.advanceTimersByTime(10); // 10ms apart — always within the 150ms window
    }
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("passes through the latest arguments", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 150);
    debounced("first");
    debounced("second");
    vi.advanceTimersByTime(150);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("second");
  });

  it("cancel() prevents a pending invocation", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 150);
    debounced();
    debounced.cancel();
    vi.advanceTimersByTime(300);
    expect(fn).not.toHaveBeenCalled();
  });

  it("cancel() is safe to call when nothing is pending", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 150);
    expect(() => debounced.cancel()).not.toThrow();
  });

  it("allows a fresh call after a previous one has fired", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 150);
    debounced();
    vi.advanceTimersByTime(150);
    expect(fn).toHaveBeenCalledTimes(1);
    debounced();
    vi.advanceTimersByTime(150);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("loadPersistedZoom", () => {
  const originalLocalStorage = globalThis.localStorage;

  beforeEach(() => {
    // jsdom provides a real localStorage; clear it between tests.
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    globalThis.localStorage = originalLocalStorage;
  });

  it("returns DEFAULT_ZOOM when nothing is persisted", () => {
    expect(loadPersistedZoom()).toBe(DEFAULT_ZOOM);
  });

  it("returns the persisted value when it is within bounds", () => {
    localStorage.setItem(ZOOM_STORAGE_KEY, JSON.stringify(18));
    expect(loadPersistedZoom()).toBe(18);
  });

  it("clamps out-of-range values back to DEFAULT_ZOOM (too large)", () => {
    localStorage.setItem(ZOOM_STORAGE_KEY, JSON.stringify(MAX_ZOOM + 50));
    expect(loadPersistedZoom()).toBe(DEFAULT_ZOOM);
  });

  it("clamps out-of-range values back to DEFAULT_ZOOM (too small)", () => {
    localStorage.setItem(ZOOM_STORAGE_KEY, JSON.stringify(MIN_ZOOM - 5));
    expect(loadPersistedZoom()).toBe(DEFAULT_ZOOM);
  });

  it("accepts the boundary values MIN_ZOOM and MAX_ZOOM", () => {
    localStorage.setItem(ZOOM_STORAGE_KEY, JSON.stringify(MIN_ZOOM));
    expect(loadPersistedZoom()).toBe(MIN_ZOOM);
    localStorage.setItem(ZOOM_STORAGE_KEY, JSON.stringify(MAX_ZOOM));
    expect(loadPersistedZoom()).toBe(MAX_ZOOM);
  });

  it("falls back to DEFAULT_ZOOM on corrupt JSON", () => {
    localStorage.setItem(ZOOM_STORAGE_KEY, "{not-json");
    expect(loadPersistedZoom()).toBe(DEFAULT_ZOOM);
  });

  it("falls back to DEFAULT_ZOOM when localStorage.getItem throws", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(loadPersistedZoom()).toBe(DEFAULT_ZOOM);
    spy.mockRestore();
  });
});
