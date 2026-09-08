import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import CodexTranscript from "../components/CodexTranscript";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const response = (body) => ({ ok: true, json: async () => body });
const page = (messages, more = false, before = null) => ({ available: true, messages, has_more: more, before });
const message = (index, text, role = "assistant") => ({ index, text, role });

describe("saved Codex conversation", () => {
  it("ordinary upward scrolling loads older messages only when the reader reaches the top", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(page([message(20, "Recent message")], true, 20)))
      .mockResolvedValueOnce(response(page([message(10, "Earlier message")], true, 10)));
    vi.stubGlobal("fetch", fetch);
    render(<CodexTranscript terminalId="term-1" presentation="scroll" onClose={vi.fn()} />);
    await screen.findByText("Recent message");
    const scroller = screen.getByTestId("transcript-scroll");
    expect(scroller).toHaveFocus();
    expect(screen.getByRole("button", { name: "Back to live terminal" })).toBeInTheDocument();
    fireEvent.scroll(scroller);
    expect(fetch).toHaveBeenCalledTimes(1);
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => scroller.querySelectorAll("article").length * 200 });
    scroller.scrollTop = 0;
    fireEvent.wheel(scroller, { deltaY: -40 });
    await screen.findByText("Earlier message");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(scroller.scrollTop).toBe(200);
    fireEvent.scroll(scroller);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns to the live terminal on downward wheel or PageDown at the newest edge", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(page([message(1, "Saved message")]))));
    const close = vi.fn();
    render(<CodexTranscript terminalId="term-1" presentation="scroll" onClose={close} />);
    await screen.findByText("Saved message");
    const scroller = screen.getByTestId("transcript-scroll");
    scroller.scrollTop = 0;
    fireEvent.wheel(scroller, { deltaY: 40 });
    expect(close).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(scroller, { key: "PageDown" });
    expect(close).toHaveBeenCalledTimes(2);
  });
  it("labels last-known history and avoids merging conversations after a native switch", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response({ ...page([message(20, "Chat A")], true, 20), session_id: "a", binding_status: "last_known" }))
      .mockResolvedValueOnce(response({ ...page([message(10, "Old offset in B")]), session_id: "b", binding_status: "verified" }))
      .mockResolvedValueOnce(response({ ...page([message(50, "Chat B")]), session_id: "b", binding_status: "verified" })));
    render(<CodexTranscript terminalId="term-1" onClose={vi.fn()} />);
    await screen.findByText("Chat A");
    expect(screen.getByText(/Showing the last identified conversation/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load older" }));
    await screen.findByText("Chat B");
    expect(screen.queryByText("Chat A")).toBeNull();
    expect(screen.queryByText("Old offset in B")).toBeNull();
    expect(fetch.mock.calls[2][0]).toBe("/api/terminals/term-1/transcript?limit=50");
    expect(screen.queryByText(/Showing the last identified conversation/)).toBeNull();
  });

  it("loads on open, renders message text safely, and refreshes explicitly", async () => {
    const fetch = vi.fn(async () => response(page([message(1, "<img src=x onerror=alert(1)>", "user")])));
    vi.stubGlobal("fetch", fetch);
    const { container } = render(<CodexTranscript terminalId="term-1" onClose={vi.fn()} />);
    await screen.findByText("<img src=x onerror=alert(1)>");
    expect(container.querySelector("img")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("/api/terminals/term-1/transcript?limit=50");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });

  it("prepends older pages in order without moving the reader's existing text", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response(page([message(20, "Newer answer")], true, 20)))
      .mockResolvedValueOnce(response(page([message(10, "Older question", "user")]))));
    render(<CodexTranscript terminalId="term-1" onClose={vi.fn()} />);
    await screen.findByText("Newer answer");
    const scroller = screen.getByTestId("transcript-scroll");
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => scroller.querySelectorAll("article").length * 200 });
    scroller.scrollTop = 60;
    fireEvent.click(screen.getByRole("button", { name: "Load older" }));
    await screen.findByText("Older question");
    expect(fetch.mock.calls[1][0]).toContain("before=20");
    expect(scroller.scrollTop).toBe(260);
    expect([...scroller.querySelectorAll("article")].map((node) => node.textContent)).toEqual(["YouOlder question", "CodexNewer answer"]);
  });

  it("distinguishes unavailable history from an empty saved conversation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ ...page([]), available: false })));
    render(<CodexTranscript terminalId="term-1" onClose={vi.fn()} />);
    await screen.findByText(/not available for this session yet/);
    expect(screen.queryByText("No saved user or assistant messages yet.")).toBeNull();
  });

  it("exposes a read failure without claiming no messages exist", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
    render(<CodexTranscript terminalId="term-1" onClose={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be loaded");
    expect(screen.queryByText("No saved user or assistant messages yet.")).toBeNull();
  });

  it("dismisses on Escape and aborts an outstanding read on unmount", () => {
    const close = vi.fn();
    const fetch = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetch);
    const { unmount } = render(<CodexTranscript terminalId="term-1" onClose={close} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
    unmount();
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });
});
