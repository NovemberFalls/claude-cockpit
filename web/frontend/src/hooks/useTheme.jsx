import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { THEMES, getTheme, getSavedTheme, saveTheme, applyThemeToDOM, listThemes } from "../themes/themeData";

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
