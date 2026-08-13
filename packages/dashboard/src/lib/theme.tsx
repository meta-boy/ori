import { createContext, useCallback, useContext, useEffect, useState } from "react";

type Theme = "light" | "dark";
const STORAGE = "ori_theme";

/**
 * Theme state lives in one place and the class on <html> is derived from it.
 *
 * The previous dashboard kept the choice in a module-level const captured at page load and
 * re-applied it whenever the shell rebuilt, which silently reverted Light on every navigation.
 * Here there is nothing to go stale: one state, one effect.
 */
const ThemeContext = createContext<{ theme: Theme; setTheme: (t: Theme) => void }>({
  theme: "dark",
  setTheme: () => {},
});

function readStored(): Theme {
  try {
    return localStorage.getItem(STORAGE) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStored);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      localStorage.setItem(STORAGE, theme);
    } catch {
      /* private mode */
    }
  }, [theme]);

  const setTheme = useCallback((t: Theme) => setThemeState(t), []);
  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
