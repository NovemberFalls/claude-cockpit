import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalClipboard } from "../utils/terminalClipboard";

function fixture(overrides = {}) {
  const target = { term: { paste: vi.fn() } };
  const notify = vi.fn();
  const upload = vi.fn(async () => ({ ok: true, json: async () => ({ paths: ["C:\\Image Folder\\paste.png"] }) }));
  const readNative = vi.fn(async () => null);
  const options = { captureTarget: () => target, isCurrent: () => true, notify, upload, readNative, clipboard: {}, ...overrides };
  return { target, ...options, ...createTerminalClipboard(options) };
}
const image = () => new Blob([Uint8Array.from(atob(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jSioAAAAASUVORK5CYII="),
  (character) => character.charCodeAt(0))], { type: "image/png" });
const event = (blob = null, text = "") => ({ preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(),
  clipboardData: { items: blob ? [{ kind: "file", type: blob.type, getAsFile: () => blob }] : [], getData: () => text } });

describe("terminal clipboard gesture pipeline", () => {
  afterEach(() => vi.useRealTimers());
  it("bounds a hanging clipboard.read to its own step budget, permits retry, and ignores its late image", async () => {
    vi.useFakeTimers();
    let finish;
    const f = fixture({ clipboard: { read: () => new Promise((resolve) => { finish = resolve; }), readText: async () => "" } });
    const pending = f.paste(event());
    await vi.advanceTimersByTimeAsync(4000);
    await pending;
    expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("Reading timed out"), "error");
    await f.paste(event(null, "retry"));
    finish([{ types: ["image/png"], getType: async () => image() }]);
    await Promise.resolve();
    expect(f.target.term.paste).toHaveBeenCalledExactlyOnceWith("retry");
    expect(f.upload).not.toHaveBeenCalled();
  });
  it("still lets readNative supply the image when clipboard.read hangs past its step budget", async () => {
    vi.useFakeTimers();
    const readNative = vi.fn(async () => image());
    const f = fixture({ clipboard: { read: () => new Promise(() => {}) }, readNative });
    const pending = f.paste(event());
    await vi.advanceTimersByTimeAsync(4000);
    await pending;
    expect(readNative).toHaveBeenCalledOnce();
    expect(f.target.term.paste).toHaveBeenCalledExactlyOnceWith('"C:\\Image Folder\\paste.png"');
    expect(f.upload).toHaveBeenCalledOnce();
  });
  it("names the in-flight step in the 15s timeout message", async () => {
    vi.useFakeTimers();
    const upload = vi.fn(() => new Promise(() => {}));
    const f = fixture({ upload });
    const pending = f.paste(event(image()));
    await vi.advanceTimersByTimeAsync(15000);
    await pending;
    expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("uploading the image"), "error");
  });
  it("reports our own timeout reason, never the browser's AbortError, when the aborted fetch wins the race", async () => {
    vi.useFakeTimers();
    const upload = vi.fn((_, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("signal is aborted without reason", "AbortError")));
    }));
    const f = fixture({ upload });
    const pending = f.paste(event(image()));
    await vi.advanceTimersByTimeAsync(15000);
    await pending;
    expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("timed out after 15s while uploading the image"), "error");
    expect(f.notify).not.toHaveBeenCalledWith(expect.stringContaining("signal is aborted"), "error");
  });
  it("aborts a hanging upload and ignores its late response after retry", async () => {
    vi.useFakeTimers();
    let finish;
    const upload = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const f = fixture({ upload });
    const pending = f.paste(event(image()));
    await vi.advanceTimersByTimeAsync(15000);
    await pending;
    expect(upload.mock.calls[0][1].signal.aborted).toBe(true);
    await f.paste(event(null, "retry"));
    finish({ ok: true, json: async () => ({ paths: ["old.png"] }) });
    await Promise.resolve();
    expect(f.target.term.paste).toHaveBeenCalledExactlyOnceWith("retry");
    expect(f.notify).toHaveBeenCalledTimes(1);
  });
  it("aborts disposal during upload without notifications or insertion", async () => {
    const upload = vi.fn(() => new Promise(() => {}));
    const f = fixture({ upload });
    const pending = f.paste(event(image()));
    f.dispose();
    await pending;
    expect(upload.mock.calls[0][1].signal.aborted).toBe(true);
    expect(f.notify).not.toHaveBeenCalled();
    expect(f.target.term.paste).not.toHaveBeenCalled();
  });
  it("uploads DOM image exactly once and inserts a quoted path without submit", async () => {
    const f = fixture(); const e = event(image());
    await f.paste(e);
    expect(e.preventDefault).toHaveBeenCalledOnce();
    expect(e.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(f.upload).toHaveBeenCalledOnce();
    expect(f.target.term.paste).toHaveBeenCalledExactlyOnceWith('"C:\\Image Folder\\paste.png"');
    expect(f.readNative).not.toHaveBeenCalled();
  });
  it("preserves DOM text without probing unrelated clipboard data", async () => {
    const f = fixture();
    await f.paste(event(null, "hello\nworld"));
    expect(f.target.term.paste).toHaveBeenCalledExactlyOnceWith("hello\nworld");
    expect(f.upload).not.toHaveBeenCalled(); expect(f.readNative).not.toHaveBeenCalled();
  });
  it("falls back to native image when WebView exposes no DOM data and denies clipboard.read", async () => {
    const readNative = vi.fn(async () => image());
    const f = fixture({ readNative, clipboard: { read: vi.fn(async () => { throw new Error("Denied"); }) } });
    await f.paste(event());
    expect(readNative).toHaveBeenCalledOnce(); expect(f.upload).toHaveBeenCalledOnce();
  });
  it("does not read clipboard before a gesture and falls back to text when image APIs fail", async () => {
    const readText = vi.fn(async () => "text only");
    const f = fixture({ clipboard: { readText }, readNative: vi.fn(async () => { throw new Error("busy"); }) });
    expect(readText).not.toHaveBeenCalled();
    await f.paste(); expect(f.target.term.paste).toHaveBeenCalledExactlyOnceWith("text only");
  });
  it("prevents overlapping paste events and rejects destination changes during upload", async () => {
    let finish; let current = true;
    const upload = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const f = fixture({ upload, isCurrent: () => current });
    const pending = f.paste(event(image()));
    await f.paste(event(image()));
    expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("already in progress"), "error");
    current = false; finish({ ok: true, json: async () => ({ paths: ["C:\\paste.png"] }) });
    await pending;
    expect(upload).toHaveBeenCalledOnce(); expect(f.target.term.paste).not.toHaveBeenCalled();
    expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("Terminal changed"), "error");
  });
  it("shows failed uploads and disconnected terminals instead of silent success", async () => {
    const f = fixture({ upload: vi.fn(async () => ({ ok: false, json: async () => ({ errors: ["Too large"] }) })) });
    await f.paste(event(image()));
    expect(f.notify).toHaveBeenCalledWith("Paste failed: Too large", "error");
    const disconnected = fixture({ captureTarget: () => null });
    await disconnected.paste(event(image()));
    expect(disconnected.upload).not.toHaveBeenCalled();
    expect(disconnected.notify).toHaveBeenCalledWith(expect.stringContaining("disconnected"), "error");
  });
  it("does not paste after disposal", async () => {
    const f = fixture(); f.dispose(); await f.paste(event(image()));
    expect(f.upload).not.toHaveBeenCalled(); expect(f.target.term.paste).not.toHaveBeenCalled();
  });
});
