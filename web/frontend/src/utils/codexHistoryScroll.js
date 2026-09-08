// User intent, not terminal onScroll alone, crosses into saved conversation.
// xterm also emits scroll events while replaying output or resizing its buffer.
export function attachUpwardHistoryScroll(element, { enabled, atTop, onHistory, subscribeScroll }) {
  let disposed = false;
  let frame = null;
  let touchY = null;
  let draggingScrollbar = false;
  let pointerMoved = false;

  const allowed = () => !disposed && enabled();
  const cross = (event) => {
    if (!allowed() || !atTop()) return false;
    event?.preventDefault();
    event?.stopImmediatePropagation();
    onHistory();
    return true;
  };
  const checkAfterScroll = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { frame = null; cross(); });
  };
  const wheel = (event) => {
    if (event.deltaY >= 0 || event.ctrlKey || event.metaKey || !allowed()) return;
    if (!cross(event)) checkAfterScroll();
  };
  const key = (event) => {
    if (event.key !== "PageUp" || event.altKey || event.ctrlKey || event.metaKey || !allowed()) return;
    if (!cross(event)) checkAfterScroll();
  };
  const touchStart = (event) => { touchY = event.touches.length === 1 ? event.touches[0].clientY : null; };
  const touchMove = (event) => {
    if (touchY === null || event.touches.length !== 1) return;
    const nextY = event.touches[0].clientY;
    if (nextY > touchY + 3 && allowed() && !cross(event)) checkAfterScroll();
    touchY = nextY;
  };
  const touchEnd = () => { touchY = null; };
  const pointerDown = (event) => {
    const target = event.target.closest?.(".xterm-viewport, .xterm-scrollable-element, .scrollbar, .slider") || element;
    const bounds = target.getBoundingClientRect();
    draggingScrollbar = event.pointerType !== "touch" && (event.target.closest?.(".scrollbar, .slider") || event.clientX >= bounds.right - 20);
    pointerMoved = false;
  };
  const pointerMove = () => { if (draggingScrollbar) pointerMoved = true; };
  const pointerEnd = () => { draggingScrollbar = false; pointerMoved = false; };
  const scroll = () => { if (draggingScrollbar && pointerMoved) cross(); };

  element.addEventListener("wheel", wheel, { capture: true, passive: false });
  element.addEventListener("keydown", key, true);
  element.addEventListener("touchstart", touchStart, { passive: true });
  element.addEventListener("touchmove", touchMove, { capture: true, passive: false });
  element.addEventListener("touchend", touchEnd);
  element.addEventListener("touchcancel", touchEnd);
  element.addEventListener("pointerdown", pointerDown, true);
  window.addEventListener("pointermove", pointerMove, true);
  window.addEventListener("pointerup", pointerEnd, true);
  element.addEventListener("scroll", scroll, true);
  const subscription = subscribeScroll?.(scroll);
  return { dispose() {
    disposed = true;
    if (frame !== null) cancelAnimationFrame(frame);
    element.removeEventListener("wheel", wheel, true);
    element.removeEventListener("keydown", key, true);
    element.removeEventListener("touchstart", touchStart);
    element.removeEventListener("touchmove", touchMove, true);
    element.removeEventListener("touchend", touchEnd);
    element.removeEventListener("touchcancel", touchEnd);
    element.removeEventListener("pointerdown", pointerDown, true);
    window.removeEventListener("pointermove", pointerMove, true);
    window.removeEventListener("pointerup", pointerEnd, true);
    element.removeEventListener("scroll", scroll, true);
    subscription?.dispose();
  } };
}

export function attachCodexHistoryScroll(terminal, element, options) {
  return attachUpwardHistoryScroll(element, {
    ...options,
    atTop: () => terminal.buffer.active.viewportY === 0,
    subscribeScroll: (callback) => terminal.onScroll?.(callback),
  });
}
