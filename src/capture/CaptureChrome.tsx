import { useEffect, type MutableRefObject } from "react";
import type { CaptureReady } from "./protocol";
import { publishReady, settleSurface } from "./readiness";

/** Applies (and reverts) the `dark` theme class on the document element. */
export function useCaptureTheme(theme: "light" | "dark"): void {
  useEffect(() => {
    if (typeof document === "undefined") return;
    const el = document.documentElement;
    el.classList.toggle("dark", theme === "dark");
    return () => { el.classList.remove("dark"); };
  }, [theme]);
}

/** Kills animations, transitions, and the text caret so captures are deterministic. */
export function CaptureStyle() {
  return <style>{
    "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;" +
    "transition-duration:0s!important;transition-delay:0s!important;scroll-behavior:auto!important;" +
    "caret-color:transparent!important}html,body{margin:0;padding:0}"
  }</style>;
}

/**
 * Runs once after mount: waits for fonts and image decode inside the surface,
 * then publishes the readiness object (or an error readiness on failure).
 */
export function usePublishOnSettle(ref: MutableRefObject<HTMLElement | null>, buildReady: () => CaptureReady): void {
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await settleSurface(ref.current ?? document);
        if (!cancelled) publishReady(buildReady());
      } catch (error) {
        if (!cancelled) publishReady({ status: "error", error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => { cancelled = true; };
    // Publish once on mount: data is already loaded by the time this hook runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** Publishes an immediate error readiness (used when data loading fails). */
export function usePublishError(message: string | null): void {
  useEffect(() => {
    if (message !== null) publishReady({ status: "error", error: message });
  }, [message]);
}
