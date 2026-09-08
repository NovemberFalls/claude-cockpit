import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { attachCodexHistoryScroll } from "../utils/codexHistoryScroll";

vi.mock("@xterm/xterm", async (original) => {
  const canvas = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const module = await original();
  canvas.mockRestore();
  return module;
});
import { Terminal } from "@xterm/xterm";

const disposables = [];
afterEach(() => { disposables.forEach((item) => item.dispose()); disposables.length = 0; document.body.innerHTML = ""; vi.restoreAllMocks(); });
const write = (terminal, data) => new Promise((resolve) => terminal.write(data, resolve));
function setup() {
  const terminal = new Terminal({ cols: 40, rows: 4, allowProposedApi: true });
  const element = document.createElement("div");
  document.body.append(element);
  const onHistory = vi.fn();
  const options = { enabled: () => true, onHistory };
  const listener = attachCodexHistoryScroll(terminal, element, options);
  disposables.push(terminal, listener);
  return { terminal, element, onHistory, listener };
}

describe("ordinary Codex scroll reaches durable messages", () => {
  it("crosses on upward wheel after real ED2 repaint and resize erased in-viewport messages", async () => {
    const { terminal, element, onHistory } = setup();
    await write(terminal, "User message\r\nAssistant reply");
    await write(terminal, "\x1b[2J\x1b[HOpenAI Codex startup");
    terminal.resize(24, 3); terminal.resize(40, 8);
    const text = Array.from({ length: terminal.buffer.active.length }, (_, index) => terminal.buffer.active.getLine(index).translateToString(true)).join("\n");
    expect(text).toContain("OpenAI Codex startup");
    expect(text).not.toContain("User message");
    expect(onHistory).not.toHaveBeenCalled();
    const cliWheel = vi.fn();
    element.addEventListener("wheel", cliWheel);
    const event = new WheelEvent("wheel", { deltaY: -50, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    expect(onHistory).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(cliWheel).not.toHaveBeenCalled();
  });

  it("does not open on replay, programmatic scrolling or resize alone", async () => {
    const { terminal, onHistory } = setup();
    await write(terminal, "one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n");
    terminal.scrollToTop(); terminal.resize(30, 8);
    expect(onHistory).not.toHaveBeenCalled();
  });

  it("supports PageUp and touch upward-history intent at the boundary", () => {
    const { element, onHistory } = setup();
    fireEvent.keyDown(element, { key: "PageUp", shiftKey: true });
    expect(onHistory).toHaveBeenCalledTimes(1);
    fireEvent.touchStart(element, { touches: [{ clientY: 40 }] });
    fireEvent.touchMove(element, { touches: [{ clientY: 80 }] });
    expect(onHistory).toHaveBeenCalledTimes(2);
  });

  it("recognizes a scrollbar drag to the top without treating ordinary selection as scrolling", async () => {
    const { terminal, element, onHistory } = setup();
    element.getBoundingClientRect = () => ({ right: 100 });
    await write(terminal, "one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n");
    element.dispatchEvent(new MouseEvent("pointerdown", { clientX: 20, bubbles: true }));
    window.dispatchEvent(new MouseEvent("pointermove"));
    terminal.scrollToTop();
    expect(onHistory).not.toHaveBeenCalled();
    terminal.scrollToBottom();
    element.dispatchEvent(new MouseEvent("pointerdown", { clientX: 99, bubbles: true }));
    window.dispatchEvent(new MouseEvent("pointermove"));
    terminal.scrollToTop();
    expect(onHistory).toHaveBeenCalledOnce();
  });

  it("ignores zoom, downward scrolling and disposed listeners", () => {
    const { element, onHistory, listener } = setup();
    fireEvent.wheel(element, { deltaY: -100, ctrlKey: true });
    fireEvent.wheel(element, { deltaY: 100 });
    expect(onHistory).not.toHaveBeenCalled();
    listener.dispose();
    fireEvent.wheel(element, { deltaY: -100 });
    expect(onHistory).not.toHaveBeenCalled();
  });
});
