// Cache only identified conversations; fresh responses always verify native identity.
export const historyCache = new Map();
export function clearTranscriptCache() { historyCache.clear(); }
export function remember(id, page, top) {
  if (!page?.session_id || !page.messages.length) { historyCache.delete(id); return; }
  const serialized = JSON.stringify(page);
  if (serialized.length > 1024 * 1024 || page.messages.length > 300) {
    historyCache.delete(id);
    return;
  }
  historyCache.delete(id);
  historyCache.set(id, { page, top });
  while (historyCache.size > 8) historyCache.delete(historyCache.keys().next().value);
}

