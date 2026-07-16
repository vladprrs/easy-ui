import type { PrototypeDoc } from "./schema";
import type { ValidationIssue } from "./types";

const path = (parts: (string | number)[]) => `/${parts.map(String).join("/")}`;

/** Structural rules specific to the viewport-anchored Overlay host primitive. */
export function validateOverlayRules(doc: PrototypeDoc): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  const add = (parts: (string | number)[], message: string) => errors.push({ path: path(parts), message });
  doc.screens.forEach((screen, screenIndex) => {
    const elements = screen.spec.elements;
    const base = ["screens", screenIndex, "spec", "elements"];
    let hasOverlay = false;
    const seen = new Set<string>();
    const walk = (key: string, parent: string | undefined, inRepeat: boolean, inOverlay: boolean, inHotspot: boolean): void => {
      if (seen.has(key)) return;
      seen.add(key);
      const element = elements[key];
      if (!element) return;
      const isOverlay = element.type === "Overlay";
      const isHotspot = element.type === "Hotspot";
      if (isOverlay) {
        hasOverlay = true;
        if (parent !== screen.spec.root) add([...base, key], "Overlay must be a direct child of the screen root");
        if (element.repeat || inRepeat) add([...base, key], "Overlay is not allowed inside a repeat subtree");
        if (inHotspot) add([...base, key], "Overlay is not allowed inside Hotspot");
        if (inOverlay) add([...base, key], "Overlay is not allowed inside another Overlay");
      }
      if (isHotspot && inOverlay) add([...base, key], "Hotspot is not allowed inside Overlay");
      for (const child of element.children ?? []) {
        walk(child, key, inRepeat || Boolean(element.repeat), inOverlay || isOverlay, inHotspot || isHotspot);
      }
    };
    walk(screen.spec.root, undefined, false, false, false);
    if (hasOverlay && (doc.device ?? "desktop") === "desktop" && !screen.canvas) {
      add(["screens", screenIndex], "Overlay on a desktop screen requires a canvas");
    }
  });
  return errors;
}
