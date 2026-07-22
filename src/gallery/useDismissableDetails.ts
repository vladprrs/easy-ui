import { useEffect, useRef, type RefObject } from "react";

/**
 * Wires native <details> dismissal: click-outside (pointerdown on document) and
 * Escape close the element; Escape also returns focus to its <summary>. Document
 * listeners are attached only while the element is open (observed via its `toggle`
 * event) and removed on unmount. Clicks inside the element never close it.
 *
 * When `locked` is true a mutation is in-flight: neither click-outside nor Escape
 * close the element, so live-region feedback stays mounted until it settles.
 */
export function useDismissableDetails(
  ref: RefObject<HTMLDetailsElement | null>,
  options?: { locked?: boolean },
): void {
  const locked = options?.locked ?? false;
  const lockedRef = useRef(locked);
  useEffect(() => { lockedRef.current = locked; }, [locked]);

  useEffect(() => {
    const details = ref.current;
    if (!details) return;

    const close = () => { details.open = false; };

    const onPointerDown = (event: PointerEvent) => {
      if (lockedRef.current) return;
      const target = event.target;
      if (target instanceof Node && details.contains(target)) return;
      close();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (lockedRef.current) return;
      close();
      details.querySelector("summary")?.focus();
    };

    const attach = () => {
      document.addEventListener("pointerdown", onPointerDown);
      document.addEventListener("keydown", onKeyDown);
    };
    const detach = () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };

    const onToggle = () => {
      if (details.open) attach();
      else detach();
    };

    if (details.open) attach();
    details.addEventListener("toggle", onToggle);

    return () => {
      details.removeEventListener("toggle", onToggle);
      detach();
    };
  }, [ref]);
}
