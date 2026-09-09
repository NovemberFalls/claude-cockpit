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

const _STEP_TIMEOUT_MS = 4000;

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
    let step = "starting";
    const timer = setTimeout(
      () => request.cancel(`Paste timed out after 15s while ${step}; please try pasting again`), 15000);
    const check = () => {
      if (request.error) throw request.error;
      if (disposed || active !== request) throw new Error("Paste cancelled");
    };
    const wait = async (operation, label) => {
      check();
      if (label) step = label;
      const result = await Promise.race([operation(), cancelled]).catch((error) => {
        if (request.error) throw request.error;
        throw error;
      });
      check();
      return result;
    };
    // The per-step budget applies to the read strategies only; it is a local fallback
    // (falls through to the next strategy), never a cancellation of the whole paste.
    const readStep = (operation, label) => wait(() => new Promise((resolve, reject) => {
      const stepTimer = setTimeout(() => reject(new Error(`Reading timed out`)), _STEP_TIMEOUT_MS);
      operation().then(
        (value) => { clearTimeout(stepTimer); resolve(value); },
        (error) => { clearTimeout(stepTimer); reject(error); });
    }), label);
    try {
      const transfer = event?.clipboardData;
      const item = Array.from(transfer?.items || []).find((entry) => entry.kind === "file" && entry.type?.startsWith("image/"));
      let image = item?.getAsFile() || Array.from(transfer?.files || []).find((file) => file.type?.startsWith("image/"));
      let text = transfer?.getData("text/plain") || "";
      let readError;
      if (!image && (item || !text)) {
        try {
          const items = await readStep(() => clipboard?.read?.(), "reading the clipboard");
          for (const entry of items || []) {
            const type = entry.types.find((value) => value.startsWith("image/"));
            if (type) { image = await readStep(() => entry.getType(type), "reading the clipboard"); break; }
          }
        } catch (error) { readError = error; }
        if (!image) {
          try { image = await readStep(() => readNative(), "reading the clipboard image"); }
          catch (error) { readError = error; }
        }
        if (!image) {
          try { text = await readStep(() => clipboard?.readText?.(), "reading clipboard text") || text; }
          catch (error) { readError = error; }
        }
      }
      check();
      if (!image && !text) throw new Error(readError?.message || "Clipboard contains no readable image or text");
      if (disposed || !isCurrent(target)) throw new Error("Terminal changed before paste completed; paste again in the intended session");
      if (image) {
        if (!image.size) throw new Error("Clipboard image is empty");
        const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[image.type];
        if (!ext) throw new Error("Clipboard image format is unsupported");
        const form = new FormData();
        form.append("files", new File([image], `paste.${ext}`, { type: image.type }));
        const response = await wait(() => upload(form, { signal: controller.signal }), "uploading the image");
        const data = await wait(() => response.json(), "reading the upload response");
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
      clearTimeout(timer);
      if (active === request) { active = null; busy = false; }
    }
  }
  return { paste, dispose() { disposed = true; active?.cancel("Paste cancelled"); } };
}
