export { attachCodexHistoryScroll } from "./codexHistoryScroll";

// A fresh view requests the retained stream; a reconnect requests only data
// already accepted into neither xterm nor our pending write buffer.
export function createReplayCursor() { return { seq: null }; }

export function replayQuery(cursor) {
  return `?replay=1${cursor.seq === null ? "" : `&after=${cursor.seq}`}`;
}

export function consumeReplayFrame(raw, cursor, { reset, enqueue, warning }) {
  if (typeof raw !== "string" || !raw.startsWith("{")) return false;
  let frame;
  try { frame = JSON.parse(raw); } catch { return false; }
  if (frame.type === "replay_start") {
    if (frame.reset === true) { cursor.seq = null; reset(); }
    // A delta reconnect does not restore the older missing prefix. Keep its
    // notice until a replacement snapshot can establish complete history.
    if (frame.reset === true || frame.truncated === true) {
      warning(frame.truncated === true
        ? "Older terminal output is unavailable; showing the retained portion."
        : null);
    }
    return true;
  }
  if (frame.type === "replay_end") {
    if (Number.isSafeInteger(frame.seq) && frame.seq >= 0) cursor.seq = Math.max(cursor.seq ?? 0, frame.seq);
    return true;
  }
  if (frame.type !== "output" || !Number.isSafeInteger(frame.seq) || frame.seq < 0 || typeof frame.data !== "string") return false;
  if (cursor.seq !== null && frame.seq <= cursor.seq) return true;
  enqueue(frame.data);
  // The write buffer belongs to the pane, not the socket, and survives a
  // disconnect. Record acceptance now so a reconnect before the next animation
  // frame cannot duplicate output. Reset/unmount discards this cursor too.
  cursor.seq = frame.seq;
  return true;
}

export function preserveCodexScrollback(terminal, enabled) {
  // Let xterm parse chunked escape sequences. Only ED3 (erase saved lines) is
  // intercepted; ED2 and cursor movement still repaint the CLI normally. An
  // explicit host reset for a different PTY/replay snapshot remains effective.
  return terminal.parser?.registerCsiHandler?.({ final: "J" }, (params) =>
    enabled() && params.length === 1 && params[0] === 3);
}
