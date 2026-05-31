/**
 * Tests for the paste handler logic ported into PopoutTerminal.
 * (web/frontend/src/components/PopoutTerminal.jsx)
 *
 * Strategy mirrors TerminalPane.paste.test.jsx exactly:
 *   xterm.js is mocked entirely (vi.mock) so we can exercise the pasteHandler
 *   closure without needing a real DOM canvas / WebGL context.  The tests
 *   extract the pasteHandler by capturing the 'paste' event listener that
 *   PopoutTerminal registers on its termRef element during mount.
 *
 * What is tested:
 *   1. text_paste_calls_xterm_paste_once        — text paste uses xterm.paste(), not ws.send
 *   2. image_paste_uploads_and_sends_path        — image paste POSTs to /api/upload, sends path via WS
 *   3. image_paste_sends_quoted_path_when_spaces — path with spaces is quoted before WS send
 *   4. paste_event_calls_preventDefault_and_stopPropagation
 *   5. ctrl_v_keydown_returns_false              — customKeyEventHandler blocks Ctrl+V → returns false
 *   6. alt_v_with_image_uploads_and_sends_path  — Alt+V reads clipboard image, uploads, sends path
 *   7. alt_v_with_text_only_calls_xterm_paste   — Alt+V with no image falls back to xterm.paste()
 *   8. alt_v_clipboard_unavailable_does_not_throw — Alt+V when clipboard API throws does not propagate
 *
 * PopoutTerminal has no `toast` prop — errors are swallowed silently.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

// ---------------------------------------------------------------------------
// jsdom polyfills
// ---------------------------------------------------------------------------

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    constructor(cb) { this._cb = cb; }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (typeof globalThis.requestAnimationFrame === "undefined") {
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
}

if (typeof globalThis.cancelAnimationFrame === "undefined") {
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
}

if (typeof globalThis.BroadcastChannel === "undefined") {
  globalThis.BroadcastChannel = class BroadcastChannel {
    constructor() {}
    postMessage() {}
    addEventListener() {}
    removeEventListener() {}
    close() {}
  };
}

// ---------------------------------------------------------------------------
// WebSocket stub
// ---------------------------------------------------------------------------

let _wsSendSpy = vi.fn();
let _wsInstance = null;

// ---------------------------------------------------------------------------
// Tracking variables for captured handlers (reset per test)
// ---------------------------------------------------------------------------

let capturedPasteHandler = null;
let capturedKeyHandler = null;
let mockTermPaste = null;

// ---------------------------------------------------------------------------
// Mock xterm and addons BEFORE importing the component.
// ---------------------------------------------------------------------------

vi.mock("@xterm/xterm", () => {
  const TerminalMock = vi.fn();
  return { Terminal: TerminalMock };
});

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn().mockImplementation(() => ({
    activate: vi.fn(),
    fit: vi.fn(),
    proposeDimensions: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
    dispose: vi.fn(),
  })),
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: vi.fn().mockImplementation(() => ({
    activate: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock("@xterm/addon-canvas", () => ({
  CanvasAddon: vi.fn().mockImplementation(() => ({
    activate: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

// Mock theme hook
vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({
    theme: {
      bg: "#1a1b26", fg: "#a9b1d6", accent: "#7aa2f7",
      bgSurface: "#16161e", bgElevated: "#1a1b26", bgHighlight: "#292e42",
      fgDim: "#565f89", fgMuted: "#3b4261", red: "#f7768e",
      green: "#9ece6a", yellow: "#e0af68", purple: "#bb9af7",
      cyan: "#7dcfff", border: "#292e42", hexBase: "#7aa2f7",
      hexGlow: "#7aa2f7", hexGlowIntensity: 0.4,
      fontFamily: "monospace", scanlines: false,
    },
  }),
}));

// ---------------------------------------------------------------------------
// Intercept addEventListener to capture the paste handler and the key handler.
// Uses the same pattern as TerminalPane.paste.test.jsx.
// ---------------------------------------------------------------------------

const _origAddEventListener = EventTarget.prototype.addEventListener;

function patchListeners() {
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (type === "paste") {
      capturedPasteHandler = listener;
    }
    return _origAddEventListener.call(this, type, listener, options);
  };
}

function unpatchListeners() {
  EventTarget.prototype.addEventListener = _origAddEventListener;
}

// ---------------------------------------------------------------------------
// Build the Terminal mock fresh for each test so clearAllMocks doesn't
// break the implementation.
// ---------------------------------------------------------------------------

async function setupTerminalMock() {
  const { Terminal } = await import("@xterm/xterm");
  capturedKeyHandler = null;
  mockTermPaste = vi.fn();

  Terminal.mockImplementation(() => ({
    loadAddon: vi.fn(),
    open: vi.fn(),
    paste: mockTermPaste,
    clear: vi.fn(),
    write: vi.fn(),
    writeln: vi.fn(),
    onData: vi.fn(),
    onKey: vi.fn(),
    hasSelection: vi.fn().mockReturnValue(false),
    getSelection: vi.fn().mockReturnValue(""),
    selectAll: vi.fn(),
    clearSelection: vi.fn(),
    scrollToBottom: vi.fn(),
    resize: vi.fn(),
    focus: vi.fn(),
    blur: vi.fn(),
    attachCustomKeyEventHandler: vi.fn().mockImplementation((fn) => {
      capturedKeyHandler = fn;
    }),
    dispose: vi.fn(),
    options: { theme: {}, fontSize: 13 },
    // _core.linkifier must be truthy so the CanvasAddon guard passes (happy path).
    // When linkifier is absent, Canvas is intentionally skipped — tested separately.
    _core: { linkifier: { onShowLinkUnderline: vi.fn(), onHideLinkUnderline: vi.fn() } },
  }));
}

// ---------------------------------------------------------------------------
// renderPopout — render PopoutTerminal with a mock WebSocket
// ---------------------------------------------------------------------------

async function renderPopout() {
  _wsSendSpy = vi.fn();
  _wsInstance = {
    readyState: 1, // WebSocket.OPEN
    send: _wsSendSpy,
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };

  const MockWebSocket = vi.fn().mockImplementation(() => _wsInstance);
  MockWebSocket.OPEN = 1;
  MockWebSocket.CONNECTING = 0;
  MockWebSocket.CLOSING = 2;
  MockWebSocket.CLOSED = 3;
  globalThis.WebSocket = MockWebSocket;

  const { default: PopoutTerminal } = await import("../components/PopoutTerminal.jsx");

  let unmount;
  await act(async () => {
    const result = render(
      React.createElement(PopoutTerminal, {
        terminalId: "term-popout-1",
        name: "PopoutTest",
        model: "claude-sonnet-4-6",
      }),
    );
    unmount = result.unmount;
  });

  return { wsSendSpy: _wsSendSpy, unmount };
}

// ---------------------------------------------------------------------------
// Helpers — build fake clipboard events (same shape as TerminalPane paste tests)
// ---------------------------------------------------------------------------

function makeTextPasteEvent(text = "hello world") {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    clipboardData: {
      getData: vi.fn().mockReturnValue(text),
      items: [],
    },
  };
}

function makeImagePasteEvent({ type = "image/png" } = {}) {
  const blob = new Blob(["fake-image-bytes"], { type });
  const item = {
    kind: "file",
    type,
    getAsFile: vi.fn().mockReturnValue(blob),
  };
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    clipboardData: {
      getData: vi.fn().mockReturnValue(""),
      items: [item],
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers — fake navigator.clipboard objects for Alt+V tests
// ---------------------------------------------------------------------------

function makeClipboardWithImage({ type = "image/png" } = {}) {
  const blob = new Blob(["fake-image-bytes"], { type });
  const clipboardItem = {
    types: [type],
    getType: vi.fn().mockResolvedValue(blob),
  };
  return {
    items: [clipboardItem],
    read: vi.fn().mockResolvedValue([clipboardItem]),
    readText: vi.fn().mockResolvedValue(""),
  };
}

function makeClipboardTextOnly(text = "alt-v text") {
  return {
    items: [],
    read: vi.fn().mockResolvedValue([]), // no image items
    readText: vi.fn().mockResolvedValue(text),
  };
}

function makeClipboardUnavailable(errorMessage = "Permission denied") {
  return {
    read: vi.fn().mockRejectedValue(new Error(errorMessage)),
    readText: vi.fn().mockRejectedValue(new Error(errorMessage)),
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("PopoutTerminal paste handler", () => {
  beforeEach(async () => {
    capturedPasteHandler = null;
    capturedKeyHandler = null;
    await setupTerminalMock();
    patchListeners();
    // Reset module cache so each test gets a fresh PopoutTerminal import
    vi.resetModules();
    await setupTerminalMock();
  });

  afterEach(() => {
    unpatchListeners();
    vi.clearAllMocks();
  });

  // 1 — text paste uses xterm.paste(), NOT ws.send directly
  it("text_paste_calls_xterm_paste_once", async () => {
    const { unmount } = await renderPopout();

    expect(capturedPasteHandler).not.toBeNull();

    const ev = makeTextPasteEvent("my pasted text");
    await act(async () => {
      await capturedPasteHandler(ev);
    });

    // xterm.paste() must be called exactly once with the text
    expect(mockTermPaste).toHaveBeenCalledTimes(1);
    expect(mockTermPaste).toHaveBeenCalledWith("my pasted text");
    // ws.send must NOT be called directly for plain text — xterm's onData handles it
    expect(_wsSendSpy).not.toHaveBeenCalled();

    unmount();
  });

  // 2 — image paste: fetch("/api/upload") is called, path injected via xterm.paste()
  it("image_paste_uploads_and_sends_path", async () => {
    const { wsSendSpy, unmount } = await renderPopout();

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ paths: ["C:\\uploads\\paste.png"] }),
    });

    const ev = makeImagePasteEvent({ type: "image/png" });
    await act(async () => {
      await capturedPasteHandler(ev);
    });

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/upload",
        expect.objectContaining({ method: "POST" }),
      );
    });

    // Image path is now injected via xterm.paste() (bracketed-paste-aware), NOT ws.send
    await waitFor(() => {
      expect(mockTermPaste).toHaveBeenCalled();
    });

    const sent = mockTermPaste.mock.calls[0][0];
    // Path has no spaces — must NOT be quoted
    expect(sent).toBe("C:\\uploads\\paste.png");
    // ws.send must NOT be called directly for image paths
    expect(wsSendSpy).not.toHaveBeenCalled();

    unmount();
  });

  // 3 — image paste: path containing a space is wrapped in double quotes
  it("image_paste_sends_quoted_path_when_spaces", async () => {
    const { wsSendSpy, unmount } = await renderPopout();

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ paths: ["C:\\my uploads\\paste.png"] }),
    });

    const ev = makeImagePasteEvent({ type: "image/png" });
    await act(async () => {
      await capturedPasteHandler(ev);
    });

    // Image path is now injected via xterm.paste() (bracketed-paste-aware), NOT ws.send
    await waitFor(() => {
      expect(mockTermPaste).toHaveBeenCalled();
    });

    const sent = mockTermPaste.mock.calls[0][0];
    // Path contains a space → must be wrapped in double quotes
    expect(sent).toBe('"C:\\my uploads\\paste.png"');
    // ws.send must NOT be called directly for image paths
    expect(wsSendSpy).not.toHaveBeenCalled();

    unmount();
  });

  // 4 — paste event calls preventDefault and stopPropagation
  it("paste_event_calls_preventDefault_and_stopPropagation", async () => {
    const { unmount } = await renderPopout();

    const ev = makeTextPasteEvent("test");
    await act(async () => {
      await capturedPasteHandler(ev);
    });

    expect(ev.preventDefault).toHaveBeenCalled();
    expect(ev.stopPropagation).toHaveBeenCalled();

    unmount();
  });

  // 5 — customKeyEventHandler returns false for Ctrl+V (suppresses raw \x16)
  it("ctrl_v_keydown_returns_false", async () => {
    const { unmount } = await renderPopout();

    await waitFor(() => {
      expect(capturedKeyHandler).not.toBeNull();
    });

    const ctrlVEvent = {
      type: "keydown",
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      key: "v",
    };

    const result = capturedKeyHandler(ctrlVEvent);
    // Must return false so xterm does not send raw \x16 to the PTY
    expect(result).toBe(false);

    unmount();
  });

  // 6 — Alt+V with image on clipboard: uploads image and injects path via xterm.paste()
  it("alt_v_with_image_uploads_and_sends_path", async () => {
    const { wsSendSpy, unmount } = await renderPopout();

    await waitFor(() => {
      expect(capturedKeyHandler).not.toBeNull();
    });

    const clipboard = makeClipboardWithImage();
    globalThis.navigator = {
      ...globalThis.navigator,
      clipboard,
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ paths: ["C:\\uploads\\altv.png"] }),
    });

    const altVEvent = {
      type: "keydown",
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      key: "v",
    };

    // Handler fires handleAltVPaste() asynchronously then returns false
    const result = capturedKeyHandler(altVEvent);
    expect(result).toBe(false);

    // Wait for the async upload to complete
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/upload",
        expect.objectContaining({ method: "POST" }),
      );
    });

    // Image path is now injected via xterm.paste() (bracketed-paste-aware), NOT ws.send
    await waitFor(() => {
      expect(mockTermPaste).toHaveBeenCalled();
    });

    const sent = mockTermPaste.mock.calls[0][0];
    // Path has no spaces — unquoted
    expect(sent).toBe("C:\\uploads\\altv.png");
    // ws.send must NOT be called directly for image paths
    expect(wsSendSpy).not.toHaveBeenCalled();

    unmount();
  });

  // 7 — Alt+V with text-only clipboard: falls back to xterm.paste()
  it("alt_v_with_text_only_calls_xterm_paste", async () => {
    const { unmount } = await renderPopout();

    await waitFor(() => {
      expect(capturedKeyHandler).not.toBeNull();
    });

    const clipboard = makeClipboardTextOnly("hello from alt-v");
    globalThis.navigator = {
      ...globalThis.navigator,
      clipboard,
    };

    const altVEvent = {
      type: "keydown",
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      key: "v",
    };

    const result = capturedKeyHandler(altVEvent);
    expect(result).toBe(false);

    // xterm.paste() should be called with the clipboard text
    await waitFor(() => {
      expect(mockTermPaste).toHaveBeenCalledWith("hello from alt-v");
    });

    // ws.send must NOT be called directly — xterm's onData handler does it
    expect(_wsSendSpy).not.toHaveBeenCalled();

    unmount();
  });

  // 8 — Alt+V when clipboard API throws: error is swallowed, nothing propagates
  it("alt_v_clipboard_unavailable_does_not_throw", async () => {
    const { unmount } = await renderPopout();

    await waitFor(() => {
      expect(capturedKeyHandler).not.toBeNull();
    });

    const clipboard = makeClipboardUnavailable("NotAllowedError: Permission denied");
    globalThis.navigator = {
      ...globalThis.navigator,
      clipboard,
    };

    const altVEvent = {
      type: "keydown",
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      key: "v",
    };

    // Must not throw — the handler wraps everything in try/catch
    let threw = false;
    try {
      const result = capturedKeyHandler(altVEvent);
      expect(result).toBe(false);
      // Let the async chain settle — error is swallowed inside handleAltVPaste
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);

    // Neither upload nor WS send should have occurred
    expect(_wsSendSpy).not.toHaveBeenCalled();
    expect(mockTermPaste).not.toHaveBeenCalled();

    unmount();
  });

  // 9 — Canvas guard: CanvasAddon IS loaded when core.linkifier is present (normal case)
  it("canvas_loaded_when_linkifier_present", async () => {
    const { CanvasAddon } = await import("@xterm/addon-canvas");
    const { Terminal } = await import("@xterm/xterm");

    // Ensure the mock exposes a truthy linkifier (default in setupTerminalMock)
    Terminal.mockImplementation(() => ({
      loadAddon: vi.fn(),
      open: vi.fn(),
      paste: vi.fn(),
      clear: vi.fn(),
      write: vi.fn(),
      writeln: vi.fn(),
      onData: vi.fn(),
      onKey: vi.fn(),
      hasSelection: vi.fn().mockReturnValue(false),
      getSelection: vi.fn().mockReturnValue(""),
      selectAll: vi.fn(),
      clearSelection: vi.fn(),
      scrollToBottom: vi.fn(),
      resize: vi.fn(),
      focus: vi.fn(),
      blur: vi.fn(),
      attachCustomKeyEventHandler: vi.fn().mockImplementation((fn) => { capturedKeyHandler = fn; }),
      dispose: vi.fn(),
      options: { theme: {}, fontSize: 13 },
      _core: { linkifier: { onShowLinkUnderline: vi.fn(), onHideLinkUnderline: vi.fn() } },
    }));

    const { unmount } = await renderPopout();

    // CanvasAddon must be constructed (guard passed with linkifier present)
    expect(CanvasAddon).toHaveBeenCalled();

    // loadAddon called >= 3 times: FitAddon + WebLinksAddon + CanvasAddon
    const termInstance = Terminal.mock.results[Terminal.mock.results.length - 1].value;
    expect(termInstance.loadAddon.mock.calls.length).toBeGreaterThanOrEqual(3);

    unmount();
  });

  // 11 — Dispose-time safety: unmounting does NOT throw even when CanvasAddon.dispose() throws.
  //       Simulates the xterm teardown race: CanvasAddon._createRenderer() runs after the
  //       linkifier MutableDisposable is cleared → TypeError in the real xterm code. The
  //       component wraps both canvasAddon.dispose() and term.dispose() in try/catch so the
  //       error is swallowed instead of escaping to the ErrorBoundary.
  it("unmount_does_not_throw_when_canvasAddon_dispose_throws", async () => {
    const { CanvasAddon } = await import("@xterm/addon-canvas");
    const { Terminal } = await import("@xterm/xterm");

    // Make CanvasAddon.dispose() simulate the linkifier teardown race crash
    CanvasAddon.mockImplementation(() => ({
      activate: vi.fn(),
      dispose: vi.fn(() => { throw new Error("onShowLinkUnderline"); }),
    }));

    Terminal.mockImplementation(() => ({
      loadAddon: vi.fn(),
      open: vi.fn(),
      paste: vi.fn(),
      clear: vi.fn(),
      write: vi.fn(),
      writeln: vi.fn(),
      onData: vi.fn(),
      onKey: vi.fn(),
      hasSelection: vi.fn().mockReturnValue(false),
      getSelection: vi.fn().mockReturnValue(""),
      selectAll: vi.fn(),
      clearSelection: vi.fn(),
      scrollToBottom: vi.fn(),
      resize: vi.fn(),
      focus: vi.fn(),
      blur: vi.fn(),
      attachCustomKeyEventHandler: vi.fn().mockImplementation((fn) => { capturedKeyHandler = fn; }),
      dispose: vi.fn(),
      options: { theme: {}, fontSize: 13 },
      _core: { linkifier: { onShowLinkUnderline: vi.fn(), onHideLinkUnderline: vi.fn() } },
    }));

    let threw = false;
    try {
      const { unmount } = await renderPopout();
      // Unmount triggers the effect cleanup — CanvasAddon.dispose() throws, but it
      // must be caught before reaching React, so unmount() itself must not throw.
      await act(async () => {
        unmount();
      });
    } catch {
      threw = true;
    }

    // The throw from CanvasAddon.dispose() must have been swallowed — no propagation
    expect(threw).toBe(false);
  });

  // 10 — Canvas guard: CanvasAddon is NOT loaded when core.linkifier is absent (popout timing window)
  //       No throw must escape to the ErrorBoundary.
  it("canvas_skipped_when_linkifier_absent_no_throw", async () => {
    const { CanvasAddon } = await import("@xterm/addon-canvas");
    const { Terminal } = await import("@xterm/xterm");

    // Override the mock to simulate the degenerate state: element present, linkifier undefined
    Terminal.mockImplementation(() => ({
      loadAddon: vi.fn(),
      open: vi.fn(),
      paste: vi.fn(),
      clear: vi.fn(),
      write: vi.fn(),
      writeln: vi.fn(),
      onData: vi.fn(),
      onKey: vi.fn(),
      hasSelection: vi.fn().mockReturnValue(false),
      getSelection: vi.fn().mockReturnValue(""),
      selectAll: vi.fn(),
      clearSelection: vi.fn(),
      scrollToBottom: vi.fn(),
      resize: vi.fn(),
      focus: vi.fn(),
      blur: vi.fn(),
      attachCustomKeyEventHandler: vi.fn().mockImplementation((fn) => { capturedKeyHandler = fn; }),
      dispose: vi.fn(),
      options: { theme: {}, fontSize: 13 },
      element: document.createElement("div"), // element IS set
      _core: {}, // linkifier is undefined — the crash window
    }));

    let threw = false;
    try {
      const { unmount } = await renderPopout();
      unmount();
    } catch {
      threw = true;
    }

    // Must not throw — guard skips CanvasAddon and falls back to DOM renderer
    expect(threw).toBe(false);

    // CanvasAddon constructor must NOT have been called (guard prevented it)
    expect(CanvasAddon).not.toHaveBeenCalled();
  });
});
