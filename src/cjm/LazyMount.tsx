import { useEffect, useRef, useState, useSyncExternalStore, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { flushSync } from "react-dom";

/**
 * Ленивое монтирование тяжёлого поддерева по IntersectionObserver
 * (план `docs/plans/2026-07-29-scrn-gallery-ux.md` §7 T2a).
 *
 * Обёртка сознательно не знает ни про дорожки, ни про CJM: её переиспользует
 * режим «Сценарии» (T2b). Контракт:
 * - обёрточный `<div>` всегда в DOM (потребители геометрии — `CjmEdgesOverlay` —
 *   меряют именно его, поэтому плейсхолдер держит габариты);
 * - `data-lazy-mounted="true|false"` — детерминированный счётчик для e2e;
 * - монтирование **однократно** (mount-once): размонтирование ничего не
 *   стабилизирует, а стоимость повторного монтирования тайла высока;
 * - печать форсирует монтирование всех обёрток (см. `usePrintMountForce`).
 */

/** Всплывающее DOM-событие: «внутри обёртки смонтировалось поддерево». */
export const LAZY_MOUNT_EVENT = "eui:lazy-mounted";

/**
 * Горизонтальный запас ненулевой: CJM-грид скроллится по горизонтали, и запас
 * по одной вертикали пропускал бы соседа по колонке до самого его появления.
 */
export const LAZY_MOUNT_ROOT_MARGIN = "240px 600px";

let printForced = false;
let printAttached = false;
const printListeners = new Set<() => void>();

function firePrintForce() {
  if (printForced) return;
  printForced = true;
  const notify = () => { for (const listener of [...printListeners]) listener(); };
  // `beforeprint` — не React-событие: без flushSync браузер снимает страницу
  // раньше, чем React успеет смонтировать тайлы, и печать выходит пустой.
  try { flushSync(notify); } catch { notify(); }
}

function attachPrintForce() {
  if (printAttached || typeof window === "undefined") return;
  printAttached = true;
  window.addEventListener("beforeprint", firePrintForce);
  const media = window.matchMedia?.("print");
  if (!media) return;
  const onChange = (event: MediaQueryListEvent) => { if (event.matches) firePrintForce(); };
  if (typeof media.addEventListener === "function") media.addEventListener("change", onChange);
}

function subscribePrintForce(listener: () => void) {
  attachPrintForce();
  printListeners.add(listener);
  return () => { printListeners.delete(listener); };
}

/** Печатный контекст уже наступил? Проверяется и по медиазапросу — печать из превью не шлёт `beforeprint`. */
export function isPrintMountForced(): boolean {
  if (printForced) return true;
  if (typeof window !== "undefined" && window.matchMedia?.("print").matches === true) printForced = true;
  return printForced;
}

/** Test-only: модульный флаг печати «залипает» по контракту mount-once. */
export function resetPrintMountForce() {
  printForced = false;
}

/** `true`, как только страница ушла в печать. Значение только нарастает. */
export function usePrintMountForce(): boolean {
  return useSyncExternalStore(subscribePrintForce, isPrintMountForced, () => false);
}

export interface LazyMountProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  children: ReactNode;
  /** Габариты плейсхолдера: та же высота, с которой стартует сам тайл, — монтирование height-нейтрально. */
  placeholderHeight: number;
  placeholderWidth?: number;
  rootMargin?: string;
}

export function LazyMount({ children, placeholderHeight, placeholderWidth, rootMargin = LAZY_MOUNT_ROOT_MARGIN, ...rest }: LazyMountProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  const printing = usePrintMountForce();
  const mounted = visible || printing;

  useEffect(() => {
    const root = rootRef.current;
    if (!root || visible || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
    }, { rootMargin });
    observer.observe(root);
    return () => observer.disconnect();
  }, [rootMargin, visible]);

  useEffect(() => {
    if (!mounted) return;
    rootRef.current?.dispatchEvent(new CustomEvent(LAZY_MOUNT_EVENT, { bubbles: true }));
  }, [mounted]);

  return <div ref={rootRef} {...rest} data-lazy-mounted={mounted ? "true" : "false"}>
    {mounted ? children : <div data-lazy-placeholder="true" aria-hidden="true" style={{ height: placeholderHeight, width: placeholderWidth }} />}
  </div>;
}
