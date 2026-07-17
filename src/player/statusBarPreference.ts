import { useCallback, useEffect, useState } from "react";

const storageKey = "eui.statusBarHidden";
const preferenceEvent = "eui:status-bar-preference-change";

function readStatusBarHidden(): boolean {
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === "true") return true;
    if (stored === "false") return false;
  } catch {
    // localStorage may be unavailable (for example, in a restricted iframe).
  }
  return false;
}

function persistStatusBarHidden(hidden: boolean): void {
  try {
    window.localStorage.setItem(storageKey, String(hidden));
  } catch {
    // The in-memory preference remains usable when persistence is unavailable.
  }
}

export function useStatusBarPreference(): readonly [boolean, (hidden: boolean) => void] {
  const [hidden, setHidden] = useState(readStatusBarHidden);

  useEffect(() => {
    const onPreferenceChange = (event: Event) => {
      if (event instanceof CustomEvent && typeof event.detail === "boolean") setHidden(event.detail);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === storageKey) setHidden(readStatusBarHidden());
    };
    window.addEventListener(preferenceEvent, onPreferenceChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(preferenceEvent, onPreferenceChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const updateHidden = useCallback((next: boolean) => {
    persistStatusBarHidden(next);
    setHidden(next);
    window.dispatchEvent(new CustomEvent(preferenceEvent, { detail: next }));
  }, []);

  return [hidden, updateHidden] as const;
}
