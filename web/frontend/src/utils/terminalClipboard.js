async function nativeImage() {
  if (!window.__TAURI_INTERNALS__) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  const image = await invoke("read_clipboard_image");
  if (!image) return null;
  const blob = new Blob([new Uint8Array(image.bytes)], { type: image.mime });
  if (image.mime === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Cannot convert clipboard image");
    context.drawImage(bitmap, 0, 0);
    return await new Promise((resolve, reject) => canvas.toBlob(
      (png) => png ? resolve(png) : reject(new Error("Cannot convert clipboard image")), "image/png"));
  } finally { bitmap.close(); }
}

// The read phase has TWO bounds that must coexist: _READ_STRATEGY_MS caps any ONE strategy
// (so a hung first strategy cannot starve a working second one — R-181 at a smaller scale)
// and _READ_PHASE_MS caps all of them combined (so four strategies cannot cost more than
// the whole paste budget, the 2.1.18 defect). Each strategy races against whichever of the
// two is smaller. The upload gets its own independent _UPLOAD_MS, started when it begins.
const _READ_STRATEGY_MS = 2000;
const _READ_PHASE_MS = 6000;
const _UPLOAD_MS = 20000;

// The upload phase is not one span. A `fetch` can sit in the browser's
// per-origin connection pool before a byte leaves the process (Studio holds a
// terminals poll, a workflows poll per session, provider health polls and a
// WebSocket per pane against the same origin), then spend time on the wire,
// then spend more time streaming the body. Those three have DIFFERENT remedies,
// so the failure toast must not report them as one number. `PerformanceResource-
// Timing` is the only client-side view of the queueing portion; it is absent in
// jsdom and for a request that never completed, which is why every read of it is
// optional and never throws.
const _UPLOAD_PATH = "/api/upload";

function uploadResourceUrl() {
  try { return new URL(_UPLOAD_PATH, window.location.href).href; }
  catch { return _UPLOAD_PATH; }
}

/** Milliseconds this upload spent queued/stalled before its request was sent,
 *  or null when the browser cannot tell us (no entry yet, or no API). */
function queuedMsSince(perfStart) {
  try {
    const entries = performance.getEntriesByName(uploadResourceUrl(), "resource") || [];
    const entry = entries.filter((e) => e.startTime >= perfStart - 1).pop();
    if (!entry || !entry.requestStart) return null;
    return Math.max(0, entry.requestStart - entry.startTime);
  } catch { return null; }
}

export function createTerminalClipboard({ captureTarget, isCurrent, notify, readNative = nativeImage,
  clipboard = navigator.clipboard,
  upload = (body, options) => fetch("/api/upload", { method: "POST", body, signal: options.signal }) }) {
  let busy = false;
  let disposed = false;
  let active = null;
  async function paste(event) {
    event?.preventDefault();
    event?.stopImmediatePropagation();
    if (disposed) return;
    if (busy) { notify("Paste already in progress; wait for it to finish, then paste again", "error"); return; }
    const target = captureTarget();
    if (!target) { notify("Paste failed: terminal is disconnected", "error"); return; }
    busy = true;
    const controller = new AbortController();
    const request = { controller, error: null };
    active = request;
    let rejectPending;
    const cancelled = new Promise((_, reject) => { rejectPending = reject; });
    // Synchronous text pastes may never await this promise.
    cancelled.catch(() => {});
    request.cancel = (message) => {
      request.error = new Error(message);
      controller.abort();
      rejectPending(request.error);
    };
    let clipboardElapsedMs = 0;
    let uploadElapsedMs = 0;
    const check = () => {
      if (request.error) throw request.error;
      if (disposed || active !== request) throw new Error("Paste cancelled");
    };
    const wait = async (operation) => {
      check();
      const result = await Promise.race([operation(), cancelled]).catch((error) => {
        if (request.error) throw request.error;
        throw error;
      });
      check();
      return result;
    };
    try {
      const transfer = event?.clipboardData;
      const item = Array.from(transfer?.items || []).find((entry) => entry.kind === "file" && entry.type?.startsWith("image/"));
      let image = item?.getAsFile() || Array.from(transfer?.files || []).find((file) => file.type?.startsWith("image/"));
      let text = transfer?.getData("text/plain") || "";
      // A timeout is never actionable; a real failure (e.g. "Focus the local terminal
      // window before pasting") always is. The most actionable error wins the report.
      let actionableError;
      let hadTimeout = false;
      const recordReadError = (error) => {
        if (error.message === "Reading timed out") hadTimeout = true;
        else actionableError = error;
      };
      if (!image && (item || !text)) {
        // One shared deadline for every read strategy combined — a strategy that finds it
        // already exhausted rejects locally and falls through, it never cancels the paste.
        const readPhaseStart = Date.now();
        const readDeadline = readPhaseStart + _READ_PHASE_MS;
        const readStep = (operation) => wait(() => new Promise((resolve, reject) => {
          // Always invoke the strategy — an operation that rejects with its own (actionable)
          // reason right away must win even with zero budget left; only a strategy that
          // actually hangs past the shared deadline gets the generic "Reading timed out".
          const budget = Math.min(_READ_STRATEGY_MS, Math.max(0, readDeadline - Date.now()));
          const stepTimer = setTimeout(() => reject(new Error("Reading timed out")), budget);
          operation().then(
            (value) => { clearTimeout(stepTimer); resolve(value); },
            (error) => { clearTimeout(stepTimer); reject(error); });
        }));
        try {
          try {
            const items = await readStep(() => clipboard?.read?.());
            for (const entry of items || []) {
              const type = entry.types.find((value) => value.startsWith("image/"));
              if (type) { image = await readStep(() => entry.getType(type)); break; }
            }
          } catch (error) { recordReadError(error); }
          if (!image) {
            try { image = await readStep(() => readNative()); }
            catch (error) { recordReadError(error); }
          }
          if (!image) {
            try { text = await readStep(() => clipboard?.readText?.()) || text; }
            catch (error) { recordReadError(error); }
          }
        } finally { clipboardElapsedMs = Date.now() - readPhaseStart; }
      }
      check();
      if (!image && !text) {
        throw new Error(actionableError?.message || (hadTimeout
          ? "Clipboard contains no readable image or text (the window may not have focus; click into the terminal and paste again)"
          : "Clipboard contains no readable image or text"));
      }
      if (disposed || !isCurrent(target)) throw new Error("Terminal changed before paste completed; paste again in the intended session");
      if (image) {
        if (!image.size) throw new Error("Clipboard image is empty");
        const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[image.type];
        if (!ext) throw new Error("Clipboard image format is unsupported");
        const form = new FormData();
        form.append("files", new File([image], `paste.${ext}`, { type: image.type }));
        const uploadStart = Date.now();
        let perfStart = 0;
        try { perfStart = performance.now(); } catch { perfStart = 0; }
        let headersMs = null;
        let bodyMs = null;
        // The breakdown is computed at REPORT time, not at fetch time, so a
        // timeout (where nothing finished) and a late failure (where the
        // resource entry exists) both say as much as they honestly can.
        const uploadDetail = () => {
          const parts = [headersMs == null ? "headers pending" : `headers ${(headersMs / 1000).toFixed(1)}s`];
          if (headersMs != null) {
            parts.push(bodyMs == null ? "body pending" : `body ${((bodyMs - headersMs) / 1000).toFixed(1)}s`);
          }
          const queued = queuedMsSince(perfStart);
          if (queued != null) parts.push(`queued ${(queued / 1000).toFixed(1)}s`);
          return parts.join(", ");
        };
        const uploadTimer = setTimeout(() => {
          uploadElapsedMs = Date.now() - uploadStart;
          request.cancel(`Paste timed out after ${(_UPLOAD_MS / 1000).toFixed(1)}s while uploading the image ` +
            `(clipboard ${(clipboardElapsedMs / 1000).toFixed(1)}s, upload ${(uploadElapsedMs / 1000).toFixed(1)}s` +
            `: ${uploadDetail()}); please try pasting again`);
        }, _UPLOAD_MS);
        let response, data;
        try {
          response = await wait(() => upload(form, { signal: controller.signal }));
          headersMs = Date.now() - uploadStart;
          data = await wait(() => response.json());
          bodyMs = Date.now() - uploadStart;
        } finally {
          clearTimeout(uploadTimer);
          uploadElapsedMs = Date.now() - uploadStart;
        }
        if (!response.ok || !Array.isArray(data.paths) || typeof data.paths[0] !== "string" || !data.paths[0]) {
          throw new Error(data.errors?.[0] || "Image upload did not return a file path");
        }
        if (disposed || !isCurrent(target)) throw new Error("Terminal changed during image upload; paste again in the intended session");
        const path = data.paths[0];
        if (/[\r\n\0]/.test(path)) throw new Error("Image upload returned an invalid file path");
        target.term.paste(path.includes(" ") ? `"${path}"` : path);
        notify("Image pasted", "success");
      } else target.term.paste(text);
    } catch (error) {
      if (!disposed) notify(`Paste failed: ${error.message || error}`, "error");
    } finally {
      if (active === request) { active = null; busy = false; }
    }
  }
  return { paste, dispose() { disposed = true; active?.cancel("Paste cancelled"); } };
}
