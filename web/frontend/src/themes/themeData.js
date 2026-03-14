/**
 * Claude Cockpit — Theme Data (ported from vanilla themes.js)
 * 10 themes x 2 variants = 20 total
 */

export const THEMES = {
  "tokyo-night-dark": {
    id: "tokyo-night-dark", label: "Tokyo Night", group: "dark",
    bg: "#1a1b26", bgSurface: "#1f2335", bgElevated: "#292e42", bgHighlight: "#33395a",
    fg: "#c0caf5", fgDim: "#a9b1d6", fgMuted: "#565f89",
    accent: "#7aa2f7", accentWarm: "#ff9e64", green: "#9ece6a", red: "#f7768e",
    yellow: "#e0af68", purple: "#bb9af7", cyan: "#7dcfff", border: "#292e42",
    hexBase: "#292e42", hexGlow: "#7aa2f7", hexGlowIntensity: 0.6,
    fontFamily: "inherit", scanlines: false,
  },
  "tokyo-night-light": {
    id: "tokyo-night-light", label: "Tokyo Night", group: "light",
    bg: "#d5d6db", bgSurface: "#cbccd1", bgElevated: "#c0c1c6", bgHighlight: "#b4b5ba",
    fg: "#343b58", fgDim: "#4c5279", fgMuted: "#9699a3",
    accent: "#34548a", accentWarm: "#965027", green: "#485e30", red: "#8c4351",
    yellow: "#8f5e15", purple: "#5a4a78", cyan: "#0f4b6e", border: "#b4b5ba",
    hexBase: "#b4b5ba", hexGlow: "#34548a", hexGlowIntensity: 0.4,
    fontFamily: "inherit", scanlines: false,
  },
  "nord-dark": {
    id: "nord-dark", label: "Nord", group: "dark",
    bg: "#2e3440", bgSurface: "#3b4252", bgElevated: "#434c5e", bgHighlight: "#4c566a",
    fg: "#eceff4", fgDim: "#d8dee9", fgMuted: "#7b88a1",
    accent: "#88c0d0", accentWarm: "#d08770", green: "#a3be8c", red: "#bf616a",
    yellow: "#ebcb8b", purple: "#b48ead", cyan: "#8fbcbb", border: "#434c5e",
    hexBase: "#3b4252", hexGlow: "#88c0d0", hexGlowIntensity: 0.55,
    fontFamily: "inherit", scanlines: false,
  },
  "nord-light": {
    id: "nord-light", label: "Nord", group: "light",
    bg: "#eceff4", bgSurface: "#e5e9f0", bgElevated: "#d8dee9", bgHighlight: "#c9d1e0",
    fg: "#2e3440", fgDim: "#3b4252", fgMuted: "#7b88a1",
    accent: "#5e81ac", accentWarm: "#d08770", green: "#a3be8c", red: "#bf616a",
    yellow: "#ebcb8b", purple: "#b48ead", cyan: "#8fbcbb", border: "#d8dee9",
    hexBase: "#d8dee9", hexGlow: "#5e81ac", hexGlowIntensity: 0.35,
    fontFamily: "inherit", scanlines: false,
  },
  "dracula-dark": {
    id: "dracula-dark", label: "Dracula", group: "dark",
    bg: "#282a36", bgSurface: "#2d2f3d", bgElevated: "#343746", bgHighlight: "#44475a",
    fg: "#f8f8f2", fgDim: "#d4d4cc", fgMuted: "#6272a4",
    accent: "#bd93f9", accentWarm: "#ffb86c", green: "#50fa7b", red: "#ff5555",
    yellow: "#f1fa8c", purple: "#ff79c6", cyan: "#8be9fd", border: "#44475a",
    hexBase: "#44475a", hexGlow: "#bd93f9", hexGlowIntensity: 0.65,
    fontFamily: "inherit", scanlines: false,
  },
  "dracula-light": {
    id: "dracula-light", label: "Dracula", group: "light",
    bg: "#f8f8f2", bgSurface: "#f0f0ea", bgElevated: "#e8e8e0", bgHighlight: "#d9d9d0",
    fg: "#282a36", fgDim: "#44475a", fgMuted: "#8a90b0",
    accent: "#7c5bbf", accentWarm: "#c28040", green: "#2d8e47", red: "#cc3333",
    yellow: "#a09e20", purple: "#cc50a0", cyan: "#3aa5c0", border: "#d9d9d0",
    hexBase: "#d9d9d0", hexGlow: "#7c5bbf", hexGlowIntensity: 0.35,
    fontFamily: "inherit", scanlines: false,
  },
  "catppuccin-dark": {
    id: "catppuccin-dark", label: "Catppuccin", group: "dark",
    bg: "#1e1e2e", bgSurface: "#24243b", bgElevated: "#313244", bgHighlight: "#3b3b52",
    fg: "#cdd6f4", fgDim: "#bac2de", fgMuted: "#6c7086",
    accent: "#cba6f7", accentWarm: "#fab387", green: "#a6e3a1", red: "#f38ba8",
    yellow: "#f9e2af", purple: "#cba6f7", cyan: "#94e2d5", border: "#313244",
    hexBase: "#313244", hexGlow: "#cba6f7", hexGlowIntensity: 0.55,
    fontFamily: "inherit", scanlines: false,
  },
  "catppuccin-light": {
    id: "catppuccin-light", label: "Catppuccin", group: "light",
    bg: "#eff1f5", bgSurface: "#e6e9ef", bgElevated: "#dce0e8", bgHighlight: "#ccd0da",
    fg: "#4c4f69", fgDim: "#5c5f77", fgMuted: "#9ca0b0",
    accent: "#8839ef", accentWarm: "#fe640b", green: "#40a02b", red: "#d20f39",
    yellow: "#df8e1d", purple: "#8839ef", cyan: "#179299", border: "#ccd0da",
    hexBase: "#ccd0da", hexGlow: "#8839ef", hexGlowIntensity: 0.35,
    fontFamily: "inherit", scanlines: false,
  },
  "solarized-dark": {
    id: "solarized-dark", label: "Solarized", group: "dark",
    bg: "#002b36", bgSurface: "#073642", bgElevated: "#0d4150", bgHighlight: "#174956",
    fg: "#fdf6e3", fgDim: "#eee8d5", fgMuted: "#657b83",
    accent: "#268bd2", accentWarm: "#cb4b16", green: "#859900", red: "#dc322f",
    yellow: "#b58900", purple: "#6c71c4", cyan: "#2aa198", border: "#0d4150",
    hexBase: "#073642", hexGlow: "#268bd2", hexGlowIntensity: 0.5,
    fontFamily: "inherit", scanlines: false,
  },
  "solarized-light": {
    id: "solarized-light", label: "Solarized", group: "light",
    bg: "#fdf6e3", bgSurface: "#eee8d5", bgElevated: "#e4ddc8", bgHighlight: "#d6cfb7",
    fg: "#002b36", fgDim: "#073642", fgMuted: "#93a1a1",
    accent: "#268bd2", accentWarm: "#cb4b16", green: "#859900", red: "#dc322f",
    yellow: "#b58900", purple: "#6c71c4", cyan: "#2aa198", border: "#d6cfb7",
    hexBase: "#e4ddc8", hexGlow: "#268bd2", hexGlowIntensity: 0.3,
    fontFamily: "inherit", scanlines: false,
  },
  "retro-dark": {
    id: "retro-dark", label: "Retro Terminal", group: "dark",
    bg: "#0a0a0a", bgSurface: "#111111", bgElevated: "#1a1a1a", bgHighlight: "#252525",
    fg: "#33ff33", fgDim: "#28cc28", fgMuted: "#1a801a",
    accent: "#33ff33", accentWarm: "#ffaa00", green: "#33ff33", red: "#ff3333",
    yellow: "#ffff33", purple: "#cc66ff", cyan: "#33ffff", border: "#1a3a1a",
    hexBase: "#1a3a1a", hexGlow: "#33ff33", hexGlowIntensity: 0.75,
    fontFamily: "'Press Start 2P', monospace", scanlines: true,
  },
  "retro-light": {
    id: "retro-light", label: "Retro Terminal", group: "light",
    bg: "#e0ffe0", bgSurface: "#d0f0d0", bgElevated: "#c0e0c0", bgHighlight: "#a8d4a8",
    fg: "#003300", fgDim: "#1a4d1a", fgMuted: "#6b996b",
    accent: "#006600", accentWarm: "#995500", green: "#006600", red: "#cc0000",
    yellow: "#998800", purple: "#663399", cyan: "#006666", border: "#a8d4a8",
    hexBase: "#a8d4a8", hexGlow: "#006600", hexGlowIntensity: 0.4,
    fontFamily: "'Press Start 2P', monospace", scanlines: true,
  },
  "cyberpunk-dark": {
    id: "cyberpunk-dark", label: "Cyberpunk", group: "dark",
    bg: "#0d0221", bgSurface: "#150530", bgElevated: "#1e0940", bgHighlight: "#2a1050",
    fg: "#e8e0ff", fgDim: "#c8b8f0", fgMuted: "#6b5a8e",
    accent: "#ff2a6d", accentWarm: "#ff6b2a", green: "#05d9e8", red: "#ff2a6d",
    yellow: "#f5d300", purple: "#d300f5", cyan: "#05d9e8", border: "#2a1050",
    hexBase: "#1e0940", hexGlow: "#ff2a6d", hexGlowIntensity: 0.7,
    fontFamily: "inherit", scanlines: false,
  },
  "cyberpunk-light": {
    id: "cyberpunk-light", label: "Cyberpunk", group: "light",
    bg: "#f0e6ff", bgSurface: "#e8dcf8", bgElevated: "#ddd0f0", bgHighlight: "#cfc0e8",
    fg: "#1a0533", fgDim: "#2d1050", fgMuted: "#8e7aaa",
    accent: "#cc1555", accentWarm: "#cc5520", green: "#048a95", red: "#cc1555",
    yellow: "#a08a00", purple: "#9900aa", cyan: "#048a95", border: "#cfc0e8",
    hexBase: "#cfc0e8", hexGlow: "#cc1555", hexGlowIntensity: 0.35,
    fontFamily: "inherit", scanlines: false,
  },
  "ocean-dark": {
    id: "ocean-dark", label: "Ocean Depths", group: "dark",
    bg: "#0a1628", bgSurface: "#0f1e35", bgElevated: "#152842", bgHighlight: "#1e3555",
    fg: "#d4e5f7", fgDim: "#b0c8e0", fgMuted: "#5a7a9a",
    accent: "#40c9a2", accentWarm: "#f0a050", green: "#40c9a2", red: "#e06070",
    yellow: "#e0c060", purple: "#9080d0", cyan: "#50b8e8", border: "#1e3555",
    hexBase: "#152842", hexGlow: "#40c9a2", hexGlowIntensity: 0.55,
    fontFamily: "inherit", scanlines: false,
  },
  "ocean-light": {
    id: "ocean-light", label: "Ocean Depths", group: "light",
    bg: "#e8f0fe", bgSurface: "#dde8f8", bgElevated: "#d0ddf0", bgHighlight: "#c0d0e6",
    fg: "#0a1628", fgDim: "#1a2a40", fgMuted: "#7090b0",
    accent: "#1a8a6e", accentWarm: "#b07030", green: "#1a8a6e", red: "#b84050",
    yellow: "#9a8030", purple: "#6a58a8", cyan: "#2888b8", border: "#c0d0e6",
    hexBase: "#c0d0e6", hexGlow: "#1a8a6e", hexGlowIntensity: 0.35,
    fontFamily: "inherit", scanlines: false,
  },
  "rose-pine-dark": {
    id: "rose-pine-dark", label: "Rose Pine", group: "dark",
    bg: "#191724", bgSurface: "#1f1d2e", bgElevated: "#26233a", bgHighlight: "#312e4a",
    fg: "#e0def4", fgDim: "#c5c0e0", fgMuted: "#6e6a86",
    accent: "#ebbcba", accentWarm: "#f6c177", green: "#9ccfd8", red: "#eb6f92",
    yellow: "#f6c177", purple: "#c4a7e7", cyan: "#9ccfd8", border: "#26233a",
    hexBase: "#26233a", hexGlow: "#ebbcba", hexGlowIntensity: 0.55,
    fontFamily: "inherit", scanlines: false,
  },
  "rose-pine-light": {
    id: "rose-pine-light", label: "Rose Pine", group: "light",
    bg: "#faf4ed", bgSurface: "#f2e9de", bgElevated: "#e8ddd0", bgHighlight: "#ddd2c3",
    fg: "#191724", fgDim: "#2a2740", fgMuted: "#9893a5",
    accent: "#b4637a", accentWarm: "#d7827e", green: "#56949f", red: "#b4637a",
    yellow: "#ea9d34", purple: "#907aa9", cyan: "#56949f", border: "#ddd2c3",
    hexBase: "#ddd2c3", hexGlow: "#b4637a", hexGlowIntensity: 0.35,
    fontFamily: "inherit", scanlines: false,
  },
  "midnight-dark": {
    id: "midnight-dark", label: "Midnight", group: "dark",
    bg: "#000000", bgSurface: "#0a0a0a", bgElevated: "#141414", bgHighlight: "#1e1e1e",
    fg: "#ffffff", fgDim: "#cccccc", fgMuted: "#555555",
    accent: "#ffffff", accentWarm: "#ff8844", green: "#44dd44", red: "#ff4444",
    yellow: "#dddd44", purple: "#aa66ff", cyan: "#44dddd", border: "#1e1e1e",
    hexBase: "#141414", hexGlow: "#ffffff", hexGlowIntensity: 0.5,
    fontFamily: "inherit", scanlines: false,
  },
  "midnight-light": {
    id: "midnight-light", label: "Midnight", group: "light",
    bg: "#ffffff", bgSurface: "#f5f5f5", bgElevated: "#ebebeb", bgHighlight: "#dddddd",
    fg: "#000000", fgDim: "#333333", fgMuted: "#999999",
    accent: "#000000", accentWarm: "#cc5500", green: "#228822", red: "#cc2222",
    yellow: "#888800", purple: "#6633cc", cyan: "#228888", border: "#dddddd",
    hexBase: "#ebebeb", hexGlow: "#000000", hexGlowIntensity: 0.3,
    fontFamily: "inherit", scanlines: false,
  },
};

const STORAGE_KEY = "cockpit-theme";

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

export function applyThemeToDOM(theme) {
  if (!theme) return;
  const s = document.documentElement.style;
  // Core colors
  s.setProperty("--bg", theme.bg);
  s.setProperty("--panel-bg", `${theme.bgSurface}dd`);
  s.setProperty("--panel-hover", `${theme.bgElevated}ee`);
  s.setProperty("--surface-bg", theme.bgSurface);
  s.setProperty("--accent", theme.accent);
  s.setProperty("--accent-glow", `${theme.accent}4d`);
  s.setProperty("--text-primary", theme.fg);
  s.setProperty("--text-secondary", theme.fgDim);
  s.setProperty("--text-muted", theme.fgMuted);
  s.setProperty("--border-color", `${theme.border}80`);
  s.setProperty("--status-running", theme.green);
  s.setProperty("--status-idle", theme.fgMuted);
  s.setProperty("--status-error", theme.red);
  s.setProperty("--hex-line", `${theme.hexBase}14`);
  s.setProperty("--hex-glow", `${theme.hexGlow}40`);
  s.setProperty("--scrollbar-thumb", `${theme.accent}33`);
  // Extended palette
  s.setProperty("--green", theme.green);
  s.setProperty("--red", theme.red);
  s.setProperty("--yellow", theme.yellow);
  s.setProperty("--purple", theme.purple);
  s.setProperty("--cyan", theme.cyan);
  s.setProperty("--accent-warm", theme.accentWarm);
  s.setProperty("--bg-surface", theme.bgSurface);
  s.setProperty("--bg-elevated", theme.bgElevated);
  s.setProperty("--bg-highlight", theme.bgHighlight);

  document.body.style.background = theme.bg;

  if (theme.scanlines) {
    document.body.classList.add("scanlines");
  } else {
    document.body.classList.remove("scanlines");
  }
}
