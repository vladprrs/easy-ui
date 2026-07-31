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

/**
 * Реестр ведётся по идентичности регистрации, а не по ключу записи каталога: ключ — это то, что
 * показывают (`libraryEntryKey`), и он обязан быть уникальным на странице (`partitionTiers`
 * повышает, а не копирует), но реестр не имеет права **зависеть** от этого. Схлопни он две живые
 * регистрации в одну, `mountedPreviewCount()` вернул бы 1 на два живых превью — бюджет ≤12 и его
 * perf-гейт считали бы неправду, а вытеснение снимало бы только одно из двух.
 */
interface Registration {
  key: string;
  preview: MountedPreview;
}

const mounted = new Map<number, Registration>();
let nextRegistrationId = 1;

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
    let farthestId: number | null = null;
    let farthest = Number.NEGATIVE_INFINITY;
    for (const [id, registration] of mounted) {
      const distance = registration.preview.distance();
      if (distance > farthest) { farthest = distance; farthestId = id; }
    }
    if (farthestId === null) return;
    const victim = mounted.get(farthestId)!;
    mounted.delete(farthestId);
    // Вытесненной может оказаться и только что вставшая карточка — если она дальше всех, это верно.
    victim.preview.unmount();
  }
}

/**
 * Регистрирует смонтированное превью; возвращает идемпотентный release.
 *
 * Каждый acquire — своя ячейка бюджета, даже при совпадении ключа: release снимает ровно свою
 * регистрацию и никогда не трогает чужую. Размонтировать соседа по ключу тоже нельзя — это сняло бы
 * живое превью; лишнее уедет обычным вытеснением по расстоянию.
 */
export function acquireMountedPreview(key: string, preview: MountedPreview): () => void {
  const id = nextRegistrationId++;
  mounted.set(id, { key, preview });
  enforceBudget();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    mounted.delete(id);
  };
}

export function mountedPreviewCount(): number { return mounted.size; }

export function mountedPreviewKeys(): string[] { return [...mounted.values()].map((registration) => registration.key); }

export function resetMountedPreviewsForTests(): void { mounted.clear(); }
