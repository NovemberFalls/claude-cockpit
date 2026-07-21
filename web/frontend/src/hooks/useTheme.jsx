/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useEffect, useCallback } from "react";
import {
  getTheme, getSavedTheme, saveTheme, applyThemeToDOM, listThemes,
  getSavedAccent, saveAccent, getSavedGlowEnabled, saveGlowEnabled,
  getSavedGlowStrength, saveGlowStrength, DEFAULT_THEME_ID,
} from "../themes/themeData";

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [themeId, setThemeId] = useState(() => getSavedTheme() || DEFAULT_THEME_ID);
  const [accent, setAccentState] = useState(() => getSavedAccent());
  const [glowEnabled, setGlowEnabledState] = useState(() => getSavedGlowEnabled());
  const [glowStrength, setGlowStrengthState] = useState(() => getSavedGlowStrength());

  const theme = getTheme(themeId) || getTheme(DEFAULT_THEME_ID);

  useEffect(() => {
    applyThemeToDOM(theme, { accent, glowEnabled, glowStrength });
    saveTheme(themeId);
  }, [themeId, theme, accent, glowEnabled, glowStrength]);

  const switchTheme = useCallback((id) => {
    if (getTheme(id)) setThemeId(id);
  }, []);

  const setAccent = useCallback((value) => {
    setAccentState(value);
    saveAccent(value);
  }, []);

  const setGlowEnabled = useCallback((value) => {
    setGlowEnabledState(value);
    saveGlowEnabled(value);
  }, []);

  const setGlowStrength = useCallback((value) => {
    setGlowStrengthState(value);
    saveGlowStrength(value);
  }, []);

  return (
    <ThemeContext.Provider
      value={{
        themeId, theme, switchTheme, themes: listThemes(),
        accent, setAccent, glowEnabled, setGlowEnabled, glowStrength, setGlowStrength,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}

/**
 * Non-throwing variant for components that must render even without a
 * ThemeProvider ancestor (e.g. HexGrid inside ErrorBoundary's fallback).
 * Returns the real context when available; falls back to the default theme
 * so purely decorative components stay functional without crashing.
 */
export function useThemeSafe() {
  const ctx = useContext(ThemeContext);
  if (ctx) return ctx;
  const defaultTheme = getTheme(DEFAULT_THEME_ID);
  return {
    themeId: DEFAULT_THEME_ID,
    theme: defaultTheme,
    switchTheme: () => {},
    themes: listThemes(),
    accent: null,
    setAccent: () => {},
    glowEnabled: true,
    setGlowEnabled: () => {},
    glowStrength: 30,
    setGlowStrength: () => {},
  };
}
