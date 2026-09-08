import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const state = vi.hoisted(() => ({ terminals: [], sockets: [], frames: new Map(), nextFrame: 0, platformPromise: null, platformPending: Symbol("pending") }));

// Keep the actual xterm parser, buffer, scrolling, write queue and clear/reset
// behavior. Only the renderer/addons are replaced: jsdom has no font layout.
vi.mock("@xterm/xterm", async (importOriginal) => {
  // xterm probes a canvas for CSS color parsing at import. No renderer is
  // opened here; return its supported no-canvas fallback without jsdom noise.
  const canvas = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const { Terminal } = await importOriginal();
  canvas.mockRestore();
  return {
    Terminal: vi.fn(function (options) {
      const terminal = new Terminal({ ...options, cols: 40, rows: 4, allowProposedApi: true });
      terminal.open = vi.fn();
      terminal.loadAddon = vi.fn();
      terminal.focus = vi.fn();
      terminal.attachCustomKeyEventHandler = vi.fn();
      vi.spyOn(terminal, "clear");
      state.terminals.push(terminal);
      return terminal;
    }),
  };
});
vi.mock("@xterm/addon-fit", () => ({ FitAddon: vi.fn(function () { this.fit = vi.fn(); }) }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: vi.fn() }));
vi.mock("@xterm/addon-canvas", () => ({ CanvasAddon: vi.fn() }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: vi.fn() }));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ theme: {} }) }));
vi.mock("../modelCatalog", async (importOriginal) => ({
  ...await importOriginal(),
  useModelCatalog: () => ({ models: [] }),
}));
vi.mock("../utils/platformInfo", () => ({
  getPlatformInfo: () => state.platformPromise || Promise.resolve({}),
  getPlatformInfoSync: () => state.platformPromise ? state.platformPending : {},
  PLATFORM_INFO_PENDING: state.platformPending,
  buildWindowsPtyOption: () => ({ backend: "conpty", buildNumber: 26100 }),
}));
vi.mock("../wsDiagnose", () => ({
  diagnoseSocketFailure: () => Promise.resolve("unknown"),
  WS_REFUSED: "refused",
  REFUSED_MESSAGE: "origin refused",
}));

import TerminalPane from "../components/TerminalPane";
import PopoutTerminal from "../components/PopoutTerminal";

const session = { id: "session-1", terminalId: "terminal-1", name: "Codex", model: "codex", harness: "codex", status: "running" };
const pane = (overrides = {}) => <TerminalPane session={{ ...session, ...overrides }} toast={vi.fn()} onClose={vi.fn()} />;
const flushWrites = (terminal) => new Promise((resolve) => terminal.write("", resolve));
const bufferText = (terminal) => Array.from({ length: terminal.buffer.active.length }, (_, i) => terminal.buffer.active.getLine(i).translateToString(true)).join("\n");

function flushFrames() {
  while (state.frames.size) {
    const frames = [...state.frames.values()];
    state.frames.clear();
    frames.forEach((callback) => callback());
  }
}

beforeEach(() => {
  state.terminals.length = 0;
  state.sockets.length = 0;
  state.frames.clear();
  state.platformPromise = null;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("BroadcastChannel", class { close() {} postMessage() {} addEventListener() {} removeEventListener() {} });
  vi.stubGlobal("requestAnimationFrame", (callback) => {
    const id = ++state.nextFrame;
    state.frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id) => state.frames.delete(id));
  vi.stubGlobal("WebSocket", class {
    static OPEN = 1;
    readyState = 1;
    send = vi.fn();
    close = vi.fn();
    constructor(url) { this.url = url; state.sockets.push(this); }
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("terminal history and connection ownership", () => {
  it.each(["docked", "popout"])("keeps the %s terminal mounted while reading saved conversation history", async (kind) => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ available: true, messages: [{ index: 0, role: "user", text: "Saved conversation message" }], before: null, has_more: false }) })));
    render(kind === "docked" ? pane() : <PopoutTerminal terminalId="terminal-1" name="Codex" model="gpt-6-astra" />);
    const terminal = state.terminals.at(-1);
    const socket = state.sockets.at(-1);
    act(() => { socket.onmessage({ data: "Current terminal contents" }); flushFrames(); });
    await flushWrites(terminal);
    fireEvent.click(screen.getByRole("button", { name: "Conversation history" }));
    await screen.findByText("Saved conversation message");
    fireEvent.click(screen.getByRole("button", { name: "Close conversation history" }));
    expect(screen.queryByRole("dialog", { name: "Conversation history" })).toBeNull();
    expect(state.terminals).toHaveLength(1);
    expect(state.sockets).toHaveLength(1);
    expect(bufferText(terminal)).toContain("Current terminal contents");
  });
  it.each(["docked", "popout"])("preserves Codex scrollback through chunked ED3 in a %s terminal", async (kind) => {
    render(kind === "docked" ? pane() : <PopoutTerminal terminalId="terminal-1" name="Codex" model="gpt-6-astra" harness="codex" />);
    const socket = state.sockets.at(-1);
    const terminal = state.terminals.at(-1);
    act(() => { socket.onmessage({ data: "old context\r\ntwo\r\nthree\r\nfour\r\nfive\r\n" }); flushFrames(); });
    await flushWrites(terminal);
    act(() => { socket.onmessage({ data: "\x1b[3" }); flushFrames(); });
    await flushWrites(terminal);
    act(() => { socket.onmessage({ data: "J\x1b[2J\x1b[Hrepainted viewport" }); flushFrames(); });
    await flushWrites(terminal);
    expect(bufferText(terminal)).toContain("old context");
    expect(bufferText(terminal)).toContain("repainted viewport");
    expect(terminal.options.scrollback).toBe(50000);
  });

  it("demonstrates ED3 destroys unprotected history without changing Claude semantics", async () => {
    render(pane({ harness: "claude-code", model: "sonnet" }));
    const socket = state.sockets.at(-1);
    act(() => { socket.onmessage({ data: "old context\r\ntwo\r\nthree\r\nfour\r\nfive\r\n\x1b[3J" }); flushFrames(); });
    await flushWrites(state.terminals.at(-1));
    expect(bufferText(state.terminals.at(-1))).not.toContain("old context");
    expect(state.terminals.at(-1).options.scrollback).toBe(10000);
  });

  it.each(["docked", "popout"])("restores retained output into a fresh %s view and exposes truncation", async (kind) => {
    render(kind === "docked" ? pane() : <PopoutTerminal terminalId="terminal-1" name="Codex" model="gpt-6-astra" />);
    const socket = state.sockets.at(-1);
    expect(socket.url).toContain("?replay=1");
    act(() => {
      socket.onmessage({ data: JSON.stringify({ type: "replay_start", reset: true, truncated: true }) });
      socket.onmessage({ data: JSON.stringify({ type: "output", seq: 7, data: "restored context\r\ntwo\r\nthree\r\nfour\r\nfive\r\n" }) });
      socket.onmessage({ data: JSON.stringify({ type: "replay_end", seq: 7 }) });
      flushFrames();
    });
    await flushWrites(state.terminals.at(-1));
    expect(bufferText(state.terminals.at(-1))).toContain("restored context");
    expect(screen.getByRole("status").textContent).toContain("Older terminal output is unavailable");
  });

  it.each(["docked", "popout"])("does not duplicate queued output on a %s reconnect before the write frame", async (kind) => {
    render(kind === "docked" ? pane() : <PopoutTerminal terminalId="terminal-1" name="Codex" model="gpt-6-astra" />);
    const socket = state.sockets.at(-1);
    const timer = vi.spyOn(globalThis, "setTimeout");
    act(() => {
      socket.onmessage({ data: JSON.stringify({ type: "output", seq: 1, data: "one retained line\r\n" }) });
      socket.onclose({ code: 1006 });
    });
    const index = timer.mock.calls.findIndex(([, delay]) => delay === 1000);
    clearTimeout(timer.mock.results[index].value);
    act(() => timer.mock.calls[index][0]());
    const replacement = state.sockets.at(-1);
    expect(replacement.url).toContain("after=1");
    act(() => {
      replacement.onmessage({ data: JSON.stringify({ type: "replay_start", reset: false, truncated: false }) });
      replacement.onmessage({ data: JSON.stringify({ type: "output", seq: 1, data: "one retained line\r\n" }) });
      replacement.onmessage({ data: JSON.stringify({ type: "output", seq: 2, data: "next line\r\n" }) });
      flushFrames();
    });
    await flushWrites(state.terminals.at(-1));
    expect(bufferText(state.terminals.at(-1)).match(/one retained line/g)).toHaveLength(1);
    expect(bufferText(state.terminals.at(-1))).toContain("next line");
  });

  it("replaces a truncated snapshot after queued parser writes without mixing histories", async () => {
    render(pane());
    const socket = state.sockets.at(-1);
    act(() => {
      socket.onmessage({ data: JSON.stringify({ type: "output", seq: 1, data: "old submitted history" }) });
      flushFrames();
      socket.onmessage({ data: JSON.stringify({ type: "output", seq: 2, data: "old pending history" }) });
      socket.onmessage({ data: JSON.stringify({ type: "replay_start", reset: true, truncated: true }) });
      socket.onmessage({ data: JSON.stringify({ type: "output", seq: 20, data: "replacement retained history" }) });
      socket.onmessage({ data: JSON.stringify({ type: "replay_end", seq: 20 }) });
      flushFrames();
    });
    await flushWrites(state.terminals.at(-1));
    const text = bufferText(state.terminals.at(-1));
    expect(text).toContain("replacement retained history");
    expect(text).not.toContain("old submitted");
    expect(text).not.toContain("old pending");
  });

  it("keeps the missing-history notice across a successful delta reconnect", () => {
    render(pane());
    const socket = state.sockets.at(-1);
    act(() => socket.onmessage({ data: JSON.stringify({ type: "replay_start", reset: true, truncated: true }) }));
    expect(screen.getByRole("status").textContent).toContain("Older terminal output is unavailable");
    act(() => socket.onmessage({ data: JSON.stringify({ type: "replay_start", reset: false, truncated: false }) }));
    expect(screen.getByRole("status").textContent).toContain("Older terminal output is unavailable");
    act(() => socket.onmessage({ data: JSON.stringify({ type: "replay_start", reset: true, truncated: false }) }));
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("opens one socket and never clears history on a cached-platform mount", () => {
    render(pane());
    expect(state.sockets).toHaveLength(1);
    expect(state.terminals[0].clear).not.toHaveBeenCalled();
  });

  it("connects the latest PTY if the session changes while platform info is loading", async () => {
    let resolvePlatform;
    state.platformPromise = new Promise((resolve) => { resolvePlatform = resolve; });
    const { rerender } = render(pane());
    rerender(pane({ terminalId: "terminal-2" }));
    await act(async () => resolvePlatform({}));
    expect(state.sockets).toHaveLength(1);
    expect(state.sockets[0].url).toContain("/ws/terminal/terminal-2");
  });

  it("keeps actual scrollback and the reader's scroll position while new output arrives", async () => {
    const { rerender } = render(pane());
    const socket = state.sockets.at(-1);
    const terminal = state.terminals[0];
    act(() => { socket.onmessage({ data: "old context\r\ntwo\r\nthree\r\nfour\r\nfive\r\n" }); flushFrames(); });
    await flushWrites(terminal);
    terminal.scrollToTop();
    rerender(pane({ name: "Renamed", activityState: "busy" }));
    act(() => { socket.onmessage({ data: "new output\r\n" }); flushFrames(); });
    await flushWrites(terminal);
    expect(terminal.buffer.active.baseY).toBeGreaterThan(0);
    expect(terminal.buffer.active.viewportY).toBe(0);
    expect(bufferText(terminal)).toContain("old context");
    expect(bufferText(terminal)).toContain("new output");
  });

  it("drops old queued frames and late socket output when switching PTYs", async () => {
    const { rerender } = render(pane());
    const oldSocket = state.sockets.at(-1);
    const lateMessage = oldSocket.onmessage;
    act(() => oldSocket.onmessage({ data: "old pending output\r\n" }));
    rerender(pane({ terminalId: "terminal-2" }));
    act(() => {
      lateMessage({ data: "stale socket output\r\n" });
      state.sockets.at(-1).onmessage({ data: "new session\r\n" });
      flushFrames();
    });
    await flushWrites(state.terminals[0]);
    expect(bufferText(state.terminals[0])).toContain("new session");
    expect(bufferText(state.terminals[0])).not.toContain("old pending");
    expect(bufferText(state.terminals[0])).not.toContain("stale socket");
  });

  it("orders a new PTY reset after old writes already queued in xterm", async () => {
    const { rerender } = render(pane());
    act(() => { state.sockets.at(-1).onmessage({ data: "previous PTY cursor line" }); flushFrames(); });
    rerender(pane({ terminalId: "terminal-2" }));
    act(() => { state.sockets.at(-1).onmessage({ data: "new PTY" }); flushFrames(); });
    await flushWrites(state.terminals[0]);
    expect(bufferText(state.terminals[0])).toContain("new PTY");
    expect(bufferText(state.terminals[0])).not.toContain("previous PTY");
  });

  it("ignores a superseded socket close instead of scheduling a reconnect to the old PTY", () => {
    const { rerender } = render(pane());
    const lateClose = state.sockets.at(-1).onclose;
    rerender(pane({ terminalId: "terminal-2" }));
    const timeout = vi.spyOn(globalThis, "setTimeout");
    act(() => lateClose({ code: 1006 }));
    const reconnects = timeout.mock.calls.filter(([, delay]) => delay === 1000);
    // Clear a faulty implementation's timer so this negative test stays isolated.
    timeout.mock.results.forEach((result, i) => {
      if (timeout.mock.calls[i][1] === 1000) clearTimeout(result.value);
    });
    expect(reconnects).toHaveLength(0);
  });

  it.each(["docked", "popout"])("ignores late callbacks after a %s terminal unmounts", (kind) => {
    const { unmount } = render(kind === "docked" ? pane() : <PopoutTerminal terminalId="terminal-1" name="Codex" model="codex" />);
    const { onclose, onmessage } = state.sockets.at(-1);
    unmount();
    flushFrames();
    const timeout = vi.spyOn(globalThis, "setTimeout");
    act(() => { onclose({ code: 1006 }); onmessage({ data: "late output" }); });
    const reconnects = timeout.mock.calls.filter(([, delay]) => delay === 1000);
    timeout.mock.results.forEach((result, i) => {
      if (timeout.mock.calls[i][1] === 1000) clearTimeout(result.value);
    });
    expect(reconnects).toHaveLength(0);
    expect(state.frames.size).toBe(0);
  });

  it("demonstrates why an alternate-screen TUI cannot keep scrollback", async () => {
    render(pane());
    act(() => {
      state.sockets.at(-1).onmessage({ data: "\x1b[?1049hold context\r\ntwo\r\nthree\r\nfour\r\nfive\r\n" });
      flushFrames();
    });
    const terminal = state.terminals[0];
    await flushWrites(terminal);
    expect(terminal.options.scrollback).toBe(50000);
    expect(terminal.buffer.active.type).toBe("alternate");
    expect(terminal.buffer.active.baseY).toBe(0);
    expect(bufferText(terminal)).not.toContain("old context");
  });
});
