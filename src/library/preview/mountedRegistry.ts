// Жёсткий бюджет смонтированных инлайн-превью (план 2026-07-31 §4.4.5).
//
// Правило спеки «размонтировать дальше 800 px» и её же гейт «≤12 смонтированных» несовместимы
// напрямую: полоса удержания ±800 px при карточке ~320 px и трёх колонках держит ~21 превью.
// Поэтому реестр вытесняет самое дальнее от вьюпорта превью при превышении бюджета — это строго
// сильнее правила 800 px, поэтому оно не нарушается.

export const MOUNTED_PREVIEW_BUDGET = 12;

export interface MountedPreview {
  /** Расстояние до вьюпорта в px; 0 — карточка на экране. */
  distance: () => number;
  /** Снять превью с монтирования; вернётся само, когда снова подойдёт к вьюпорту. */
  unmount: () => void;
}

const mounted = new Map<string, MountedPreview>();

/** Кратчайшее расстояние от узла до вьюпорта по вертикали; 0 — пересекается. */
export function viewportDistance(node: Element | null | undefined): number {
  if (!node || typeof node.getBoundingClientRect !== "function") return Number.POSITIVE_INFINITY;
  const rect = node.getBoundingClientRect();
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  if (rect.bottom < 0) return -rect.bottom;
  if (rect.top > viewportHeight) return rect.top - viewportHeight;
  return 0;
}

function enforceBudget() {
  while (mounted.size > MOUNTED_PREVIEW_BUDGET) {
    let farthestKey: string | null = null;
    let farthest = Number.NEGATIVE_INFINITY;
    for (const [key, preview] of mounted) {
      const distance = preview.distance();
      if (distance > farthest) { farthest = distance; farthestKey = key; }
    }
    if (farthestKey === null) return;
    const victim = mounted.get(farthestKey)!;
    mounted.delete(farthestKey);
    // Вытесненной может оказаться и только что вставшая карточка — если она дальше всех, это верно.
    victim.unmount();
  }
}

/** Регистрирует смонтированное превью; возвращает идемпотентный release. */
export function acquireMountedPreview(key: string, preview: MountedPreview): () => void {
  // Повторный acquire того же ключа (StrictMode, смена приоритета) — замена записи, а НЕ вытеснение:
  // unmount() старой ручки снял бы ту же самую живую карточку.
  mounted.set(key, preview);
  enforceBudget();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (mounted.get(key) === preview) mounted.delete(key);
  };
}

export function mountedPreviewCount(): number { return mounted.size; }

export function mountedPreviewKeys(): string[] { return [...mounted.keys()]; }

export function resetMountedPreviewsForTests(): void { mounted.clear(); }
