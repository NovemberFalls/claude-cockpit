import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useToast } from "../components/Toast";

afterEach(() => { cleanup(); vi.useRealTimers(); });

it("expires notifications normally and cancels pending or late notifications on unmount", () => {
  vi.useFakeTimers();
  const { result, unmount } = renderHook(() => useToast());
  act(() => { result.current.toast("First", "info", 1000); });
  expect(result.current.toasts).toHaveLength(1);
  act(() => { vi.advanceTimersByTime(1000); });
  expect(result.current.toasts).toHaveLength(0);
  act(() => { result.current.toast("Pending"); });
  const lateNotification = result.current.toast;
  expect(vi.getTimerCount()).toBe(1);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
  expect(lateNotification("Async response after close")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});
