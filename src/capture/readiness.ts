import { CAPTURE_BOOTSTRAP_KEY, CAPTURE_READY_KEY, type CaptureBootstrap, type CaptureReady } from "./protocol";

/** Reads the frozen worker bootstrap, if any (absent in browser preview mode). */
export function readBootstrap(): CaptureBootstrap | undefined {
  return typeof window === "undefined" ? undefined : window[CAPTURE_BOOTSTRAP_KEY];
}

/** rendererBuild is echoed from the bootstrap; browser preview has no bootstrap → null. */
export function bootstrapRendererBuild(): string | null {
  return readBootstrap()?.expected.rendererBuild ?? null;
}

/** Waits for the surface to settle: fonts loaded and every image decoded. */
export async function settleSurface(root: ParentNode): Promise<void> {
  if (typeof document !== "undefined" && document.fonts?.ready) {
    try { await document.fonts.ready; } catch { /* fonts API best-effort */ }
  }
  const images = Array.from(root.querySelectorAll("img"));
  await Promise.all(images.map(async (img) => {
    try { if (typeof img.decode === "function") await img.decode(); } catch { /* broken image: not fatal for readiness */ }
  }));
}

/** Publishes the discriminated readiness object the worker polls for. */
export function publishReady(ready: CaptureReady): void {
  if (typeof window !== "undefined") window[CAPTURE_READY_KEY] = ready;
}
