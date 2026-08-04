/**
 * Стабилизация layout перед кадром (план `docs/plans/2026-08-03-renderer-contract-2.md` §2 P5,
 * §5 **R4**).
 *
 * Зачем. `settleFrames` доказывает, что браузер отрисовал N кадров подряд, но **не** доказывает,
 * что за это время геометрия не поехала: компонент, дописывающий строки через 380 мс после
 * монтирования (фикстура корпуса `corpus-late-layout-mutation`), проходит frames-settle и всё
 * равно попадает в PNG в произвольной фазе. Перемеры там нет — она здесь.
 *
 * Как. Подпись кадра — прямоугольники **поверхности** и всех geometry-узлов (`[data-eui-key]` —
 * те же маркеры, по которым меряет `geometry.mjs`), округлённые до 1/64 CSS px: субпиксельный
 * шум раствора не должен выглядеть движением, а реальный сдвиг на 1/64 px — должен. Цикл —
 * «rAF → мера → rAF → мера → сравнение», до `attempts` попыток; исчерпание попыток даёт
 * `layout_unstable` с `elementKey` первого разъехавшегося узла (виновник, а не «что-то поехало»).
 *
 * Модуль не знает ни про политику, ни про коды: он возвращает факт. Код `layout_unstable`
 * собирает `readiness.ts`, который один владеет словарём причин.
 */

/** Округление до 1/64 CSS px: ниже этого порога различие — шум раствора, а не движение. */
const QUANTUM = 64;

export const quantize = (value: number): number =>
  Number.isFinite(value) ? Math.round(value * QUANTUM) / QUANTUM : 0;

/**
 * Подпись геометрии кадра: `surface` — прямоугольник самой поверхности, `nodes` — прямоугольники
 * geometry-узлов по их ключу. Порядок узлов внутри подписи не значим (сравнение по ключам).
 */
export interface LayoutSignature {
  surface: string;
  nodes: Record<string, string>;
}

const rectOf = (element: Element): string => {
  let rect: { x: number; y: number; width: number; height: number };
  try {
    rect = element.getBoundingClientRect();
  } catch {
    return "unavailable";
  }
  return `${quantize(rect.x)},${quantize(rect.y)},${quantize(rect.width)},${quantize(rect.height)}`;
};

/** Потолок узлов в подписи: та же величина, что у выборки readiness — подпись не должна стоить кадра. */
const NODE_LIMIT = 400;

/**
 * Снимает подпись поверхности. `root` — та же поверхность, что меряет readiness
 * (`#eui-capture-surface` либо документ в preview-режиме).
 */
export function rectSignature(root: ParentNode): LayoutSignature {
  const surface = root instanceof Element ? rectOf(root) : "document";
  const nodes: Record<string, string> = {};
  let seen = 0;
  try {
    for (const marker of root.querySelectorAll("[data-eui-key]")) {
      if (seen >= NODE_LIMIT) break;
      const key = marker.getAttribute("data-eui-key") ?? "";
      // Один и тот же ключ может встретиться у повторяемых узлов (`repeat`): различаем позицией.
      const id = key in nodes ? `${key}#${seen}` : key;
      nodes[id] = rectOf(marker);
      seen += 1;
    }
  } catch { /* нет layout-движка (jsdom без DOM) — подпись беднее, стабилизация не падает */ }
  return { surface, nodes };
}

/** Первый разъехавшийся узел двух подписей: имя виновника, а не факт «что-то поехало». */
export function firstUnstableKey(before: LayoutSignature, after: LayoutSignature): string | null {
  if (before.surface !== after.surface) return "#eui-capture-surface";
  const keys = new Set([...Object.keys(before.nodes), ...Object.keys(after.nodes)]);
  const sorted = [...keys].sort();
  for (const key of sorted) if (before.nodes[key] !== after.nodes[key]) return key;
  return null;
}

export interface LayoutStabilityOutcome {
  /** Совпали ли две подряд идущие меры хоть на одной попытке. */
  stable: boolean;
  /** Сколько попыток «rAF → мера → rAF → мера» израсходовано (≤ `attempts`). */
  attempts: number;
  /** Ключ первого разъехавшегося узла — `null`, если layout устоялся. */
  elementKey: string | null;
  /** Истёк потолок политики прямо посреди стабилизации: это не «нестабильно», а «не успели». */
  timedOut: boolean;
}

const nextAnimationFrame = (): Promise<void> =>
  typeof requestAnimationFrame === "function"
    ? new Promise<void>((done) => { requestAnimationFrame(() => done()); })
    : new Promise<void>((done) => { setTimeout(done, 0); });

/**
 * Исполняет цикл стабилизации. `measure`/`nextFrame` инъектируются ради теста: в браузере это
 * `rectSignature(root)` и rAF, в unit-тесте — детерминированная последовательность подписей.
 *
 * Никогда не бросает и никогда не ждёт дольше `deadline`: превышение — `timedOut`, а решение,
 * что с этим делать, принимает вызывающий (`readiness.ts`).
 */
export async function settleLayout(options: {
  attempts: number;
  deadline?: number;
  now?: () => number;
  measure: () => LayoutSignature;
  nextFrame?: () => Promise<void>;
}): Promise<LayoutStabilityOutcome> {
  const attempts = Math.max(1, Math.floor(options.attempts));
  const frame = options.nextFrame ?? nextAnimationFrame;
  const now = options.now ?? (() => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now()));
  const deadline = options.deadline ?? Number.POSITIVE_INFINITY;
  let elementKey: string | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (now() >= deadline) return { stable: false, attempts: attempt - 1, elementKey, timedOut: true };
    await frame();
    const before = options.measure();
    await frame();
    const after = options.measure();
    elementKey = firstUnstableKey(before, after);
    if (elementKey === null) return { stable: true, attempts: attempt, elementKey: null, timedOut: false };
  }
  return { stable: false, attempts, elementKey, timedOut: false };
}
