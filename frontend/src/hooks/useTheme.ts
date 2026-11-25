import { useEffect } from "react";
import { useSettingsStore } from "@/stores/settingsStore";

export const useTheme = () => {
  const { theme, setTheme } = useSettingsStore();

  useEffect(() => {
    const root = window.document.documentElement;
    const system = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "system" ? system.matches : theme === "dark";
      root.classList.toggle("dark", dark);
      root.classList.toggle("light", !dark);
    };
    apply();
    if (theme === "system") {
      system.addEventListener("change", apply);
      return () => system.removeEventListener("change", apply);
    }
  }, [theme]);

  return { theme, setTheme };
};
