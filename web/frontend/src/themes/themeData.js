/**
 * Claude Cockpit — Theme Data
 * Two palettes: Visual Assist Night (default) and Cockpit Blue.
 * Drives the `--cc-*` design-token custom properties consumed by index.css.
 */

export const THEMES = {
  "va-night": {
    id: "va-night", label: "Visual Assist Night", group: "dark",
    bg: "#1a1a1a", bg2: "#151515", surface: "#212121", elev: "#262626", term: "#181818",
    border: "rgba(255,255,255,.08)", line: "rgba(255,255,255,.06)",
    fg: "#d7d6d3", dim: "#9a9a97", muted: "#666664",
    accent: "#4ea1e8",
    kw: "#cc7832", fn: "#ffc66d", type: "#4ec9b0", ok: "#7fb86a", macro: "#c497d6", num: "#6897bb",
    working: "#4ea1e8", thinking: "#7cc7ff", waiting: "#e0b060", idle: "#5bbf9f", error: "#e0698a",
  },
  "cockpit-blue": {
    id: "cockpit-blue", label: "Cockpit Blue", group: "dark",
    bg: "#1b1e23", bg2: "#101317", surface: "#20242b", elev: "#262b33", term: "#16191d",
    border: "rgba(255,255,255,.08)", line: "rgba(255,255,255,.06)",
    fg: "#d6dae1", dim: "#9aa4af", muted: "#626d78",
    accent: "#4ea1e8",
    kw: "#4ea1e8", fn: "#d8a75f", type: "#45c4b0", ok: "#86c26b", macro: "#b98ee0", num: "#6897bb",
    working: "#4ea1e8", thinking: "#7cc7ff", waiting: "#d8a75f", idle: "#45c4b0", error: "#e5698a",
  },
};

const STORAGE_KEY = "cockpit-theme";
const ACCENT_KEY = "cockpit-accent";
const GLOW_KEY = "cockpit-glow";
const GLOW_SIZE_KEY = "cockpit-glow-size";

const DEFAULT_THEME_ID = "va-night";
const DEFAULT_GLOW_SIZE = 30;

export function getTheme(id) {
  return THEMES[id] || null;
}

export function listThemes() {
  return Object.values(THEMES).map(({ id, label, group }) => ({ id, label, group }));
}

export function getSavedTheme() {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

export function saveTheme(id) {
  try { localStorage.setItem(STORAGE_KEY, id); } catch {}
}

export function getSavedAccent() {
  try { return localStorage.getItem(ACCENT_KEY) || null; } catch { return null; }
}

export function saveAccent(accent) {
  try {
    if (accent) localStorage.setItem(ACCENT_KEY, accent);
    else localStorage.removeItem(ACCENT_KEY);
  } catch {}
}

export function getSavedGlowEnabled() {
  try {
    const v = localStorage.getItem(GLOW_KEY);
    return v === null ? true : v === "on";
  } catch { return true; }
}

export function saveGlowEnabled(enabled) {
  try { localStorage.setItem(GLOW_KEY, enabled ? "on" : "off"); } catch {}
}

export function getSavedGlowStrength() {
  try {
    const v = localStorage.getItem(GLOW_SIZE_KEY);
    const n = v === null ? DEFAULT_GLOW_SIZE : parseInt(v, 10);
    return Number.isFinite(n) ? n : DEFAULT_GLOW_SIZE;
  } catch { return DEFAULT_GLOW_SIZE; }
}

export function saveGlowStrength(strength) {
  try { localStorage.setItem(GLOW_SIZE_KEY, String(strength)); } catch {}
}

/**
 * Applies a theme + user overrides (accent, glow) to the document root as
 * `--cc-*` custom properties. Legacy `--bg`, `--text-primary`, etc. vars are
 * aliased to the `--cc-*` tokens statically in index.css, so they update too.
 */
export function applyThemeToDOM(theme, options = {}) {
  if (!theme) return;
  const { accent, glowEnabled = true, glowStrength = DEFAULT_GLOW_SIZE } = options;
  const root = document.documentElement;
  const s = root.style;

  s.setProperty("--cc-bg", theme.bg);
  s.setProperty("--cc-bg2", theme.bg2);
  s.setProperty("--cc-surface", theme.surface);
  s.setProperty("--cc-elev", theme.elev);
  s.setProperty("--cc-term", theme.term);
  s.setProperty("--cc-border", theme.border);
  s.setProperty("--cc-line", theme.line);
  s.setProperty("--cc-fg", theme.fg);
  s.setProperty("--cc-dim", theme.dim);
  s.setProperty("--cc-muted", theme.muted);
  s.setProperty("--cc-kw", theme.kw);
  s.setProperty("--cc-fn", theme.fn);
  s.setProperty("--cc-type", theme.type);
  s.setProperty("--cc-ok", theme.ok);
  s.setProperty("--cc-macro", theme.macro);
  s.setProperty("--cc-num", theme.num);

  s.setProperty("--cc-thinking", theme.thinking);
  s.setProperty("--cc-waiting", theme.waiting);
  s.setProperty("--cc-idle", theme.idle);
  s.setProperty("--cc-error", theme.error);

  // Accent override retints both --cc-accent AND --cc-working (the "working" glow).
  const accentValue = accent || theme.accent;
  s.setProperty("--cc-accent", accentValue);
  s.setProperty("--cc-working", accentValue);

  s.setProperty("--cc-glow-size", `${glowStrength}px`);
  root.setAttribute("data-glow", glowEnabled ? "on" : "off");

  document.body.style.background = theme.bg;
  document.body.classList.remove("scanlines");
}

export { DEFAULT_THEME_ID, DEFAULT_GLOW_SIZE };
