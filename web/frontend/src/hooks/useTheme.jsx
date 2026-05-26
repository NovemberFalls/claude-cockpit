/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { getTheme, getSavedTheme, saveTheme, applyThemeToDOM, listThemes } from "../themes/themeData";

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [themeId, setThemeId] = useState(() => getSavedTheme() || "tokyo-night-dark");
  const theme = getTheme(themeId) || getTheme("tokyo-night-dark");

  useEffect(() => {
    applyThemeToDOM(theme);
    saveTheme(themeId);
  }, [themeId, theme]);

  const switchTheme = useCallback((id) => {
    if (getTheme(id)) setThemeId(id);
  }, []);

  return (
    <ThemeContext.Provider value={{ themeId, theme, switchTheme, themes: listThemes() }}>
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
 * Returns the real context when available; falls back to tokyo-night-dark
 * so purely decorative components stay functional without crashing.
 */
export function useThemeSafe() {
  const ctx = useContext(ThemeContext);
  if (ctx) return ctx;
  const defaultTheme = getTheme("tokyo-night-dark");
  return {
    themeId: "tokyo-night-dark",
    theme: defaultTheme,
    switchTheme: () => {},
    themes: listThemes(),
  };
}
