import { createContext, useContext } from "react";

/**
 * Mode context: "local" (desktop cockpit) or "relay" (cloud relay dashboard).
 * Populated from /api/me response in App.jsx.
 */
const ModeContext = createContext({ mode: "local", isRelay: false, isAdmin: false });

export const ModeProvider = ModeContext.Provider;

export function useMode() {
  return useContext(ModeContext);
}
