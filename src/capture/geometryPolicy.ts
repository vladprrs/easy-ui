/**
 * Geometry Contract 2.0 — **вердикт** над фактами капчура (план
 * `docs/plans/2026-08-03-family-acceptance-and-composition-v3.md` §3 D3/D4, §5 W3).
 *
 * Разделение, ради которого функция вынесена сюда: **факты собирает браузер, вердикт считает
 * чистая функция**. Ни DOM, ни PNG, ни политика профиля сюда не попадают — только измерения
 * (`layoutBounds`/`paintBounds`), атрибуция (`effectSources`/`clipChain`) и допуски случая.
 * Поэтому кейс из фидбэка («layout 140×96, paint 175×130, виноват потомок `highlight` с
 * `filter:blur`») проверяется unit-тестом без браузера.
 *
 * Три инварианта:
 *
 * 1. **Единицы — CSS px** (триаж R1-M2). Вызывающий обязан поделить PNG-пиксели на
 *    `deviceScaleFactor` **до** вызова; иначе dsf=2 давал бы ложный overflow ×2. Здесь
 *    пересчёта нет намеренно: две системы координат в одной функции — источник тихих ошибок.
 * 2. **Вердикт `fail` требует названного виновника.** Функция сама не решает pass/fail, но
 *    гейт (`server/acceptance/gates/geometry2.ts`) обязан падать только при непустых
 *    `overflow.sources` либо названном `expectedGeometry`-расхождении — поэтому и то, и другое
 *    возвращается явно (`sources`, `expectedGeometryDelta`).
 * 3. **`indeterminate` вместо догадки.** Не измерили paint, чернила упёрлись в край поля,
 *    нет layout-контура — вердикт не выдаётся, и `reasons[]` говорит, что чинить (увеличить
 *    маргин, снять непрозрачный фон), а не обвиняет компонент.
 */

export interface GeometryPolicyRect { x: number; y: number; width: number; height: number }

/** Ink упёрся в соответствующую сторону поля — измерение обрезано холстом, а не компонентом. */
export interface PaintClamp { left: boolean; right: boolean; top: boolean; bottom: boolean }

export interface GeometryPolicyEffectSource {
  elementKey?: string;
  elementPath?: string;
  /** `filter:blur(68px)`, `box-shadow:…`, `position:absolute`, … */
  cause: string;
  rect: GeometryPolicyRect;
}

export interface GeometryPolicyClipLink {
  key?: string;
  elementPath?: string;
  property: string;
  value: string;
  effective: boolean;
}

export interface GeometryTolerancesInput {
  /** Краска за пределами layout-контура ожидаема (тень/свечение по дизайну). */
  allowPaintOverflow?: boolean;
  /** Обрезка краски предком ожидаема (маска/скруглённый контейнер по дизайну). */
  expectedClip?: boolean;
  /** Ожидаемые габариты layout-контура из case-set-манифеста (CSS px). */
  expectedGeometry?: { width: number; height: number } | null;
  /** Допуск на сторону, CSS px (профиль: `policy.geometry.overflowPx`). */
  tolerancePx?: number;
  /**
   * Допуск расхождения с `expectedGeometry`, CSS px (профиль: `policy.geometry.sizeDeltaPx`,
   * перекрывается per-case `policy.perCase.<id>.sizeDeltaPx` — план 2026-08-06 §W3).
   */
  sizeTolerancePx?: number;
  /**
   * Per-case бюджет paint-overflow по сторонам, CSS px (`policy.perCase.<id>.overflowBudgetPx`).
   * Неназванная сторона — бюджет 0. Влияет **только** на `geometryVerdictBlocks`: вердикт-класс
   * остаётся честным (`paint-overflow-*`), меняется лишь то, блокирует ли он.
   */
  overflowBudgetPx?: { top?: number; right?: number; bottom?: number; left?: number };
}

export interface GeometryPolicyInput {
  layoutBounds: GeometryPolicyRect | null;
  paintBounds: GeometryPolicyRect | null;
  /** Как получен `paintBounds`; `null`/отсутствие — измерения не было. */
  paintBoundsSource?: "alpha" | null;
  paintClamped?: PaintClamp | null;
  effectSources?: GeometryPolicyEffectSource[];
  clipChain?: GeometryPolicyClipLink[];
  tolerances?: GeometryTolerancesInput;
}

export type GeometryPolicyVerdict =
  | "clean"
  | "paint-overflow-clipped"
  | "paint-overflow-not-clipped"
  | "layout-overflow"
  | "indeterminate";

export interface GeometryOverflowSource {
  elementKey: string | null;
  elementPath: string | null;
  cause: string;
  /** Вклад источника по сторонам и суммарно, CSS px — по нему ранжируется список. */
  contribution: { left: number; right: number; top: number; bottom: number; total: number };
}

export interface GeometryOverflow {
  left: number;
  right: number;
  top: number;
  bottom: number;
  sources: GeometryOverflowSource[];
}

export interface GeometryExpectedDelta {
  expected: { width: number; height: number };
  actual: { width: number; height: number };
  widthDelta: number;
  heightDelta: number;
}

export interface GeometryPolicyResult {
  policyVerdict: GeometryPolicyVerdict;
  overflow: GeometryOverflow;
  /** Названное расхождение с `expectedGeometry`, если оно есть, иначе `null`. */
  expectedGeometryDelta: GeometryExpectedDelta | null;
  /** Клип, который реально режет краску (первое эффективное звено цепочки). */
  clippedBy: { key: string | null; property: string; value: string } | null;
  /** Человекочитаемые причины вердикта — уезжают в `detail` гейта и в evidence. */
  reasons: string[];
}

const DEFAULT_TOLERANCE_PX = 1;
const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
const positive = (value: number, tolerance: number): number => (value > tolerance ? round2(value) : 0);
const right = (rect: GeometryPolicyRect): number => rect.x + rect.width;
const bottom = (rect: GeometryPolicyRect): number => rect.y + rect.height;

const emptyOverflow = (): GeometryOverflow => ({ left: 0, right: 0, top: 0, bottom: 0, sources: [] });

const anyClamp = (clamp: PaintClamp | null | undefined): boolean =>
  clamp !== null && clamp !== undefined && (clamp.left || clamp.right || clamp.top || clamp.bottom);

/**
 * Насколько далеко причина красит **за пределами** собственной коробки элемента, CSS px.
 *
 * Без этой оценки атрибуция была бы слепа к самому частому случаю: `box-shadow` на корневом
 * элементе не выходит за свою border-box геометрически, но чернила его тени — выходят. Считаем
 * по числам самой CSS-декларации (они уже в `cause`), консервативно и без парсера CSS:
 * `blur(r)` красит примерно до 1.5–3 радиусов, у `box-shadow`/`outline` вклад — сумма смещений,
 * размытия и растяжения. Смысл величины — **потолок правдоподобия**, а не точная граница:
 * вклад всё равно ограничен сверху наблюдённым overflow.
 */
export function effectReachPx(cause: string): number {
  if (cause.startsWith("position:") || cause.startsWith("transform:")) return 0;
  const numbers = [...cause.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map((match) => Math.abs(Number(match[1])));
  if (numbers.length === 0) return 0;
  const sum = numbers.reduce((total, value) => total + value, 0);
  return cause.startsWith("filter:") ? sum * 3 : sum;
}

/**
 * Ранжирование источников. Вклад по стороне — это то, насколько далеко источник **мог** дотянуться
 * за layout-контур (своя коробка плюс `effectReachPx`), ограниченное сверху наблюдённым overflow.
 * Источник, который ни при каком правдоподобии не достаёт до «живой» стороны, в список не
 * попадает: гейт обязан падать только с объяснением, а не с любым найденным эффектом.
 */
function attributeSources(
  layout: GeometryPolicyRect,
  overflow: { left: number; right: number; top: number; bottom: number },
  sources: GeometryPolicyEffectSource[],
  tolerance: number,
): GeometryOverflowSource[] {
  const ranked: GeometryOverflowSource[] = [];
  for (const source of sources) {
    const rect = source.rect;
    if (!rect) continue;
    const reach = effectReachPx(source.cause);
    const side = (observed: number, distance: number): number =>
      (observed > 0 ? Math.min(observed, positive(distance + reach, tolerance)) : 0);
    const contribution = {
      left: side(overflow.left, layout.x - rect.x),
      right: side(overflow.right, right(rect) - right(layout)),
      top: side(overflow.top, layout.y - rect.y),
      bottom: side(overflow.bottom, bottom(rect) - bottom(layout)),
      total: 0,
    };
    contribution.total = round2(contribution.left + contribution.right + contribution.top + contribution.bottom);
    if (contribution.total <= 0) continue;
    ranked.push({
      elementKey: source.elementKey ?? null,
      elementPath: source.elementPath ?? null,
      cause: source.cause,
      contribution,
    });
  }
  return ranked.sort((left_, right_) => right_.contribution.total - left_.contribution.total
    || (left_.cause < right_.cause ? -1 : left_.cause > right_.cause ? 1 : 0));
}

/**
 * Вердикт геометрии одного случая. Порядок проверок значим и отражает «что чинить первым»:
 * сначала отсутствие измерения, затем честное расхождение layout-контура с заявленным
 * (`layout-overflow` — дефект вёрстки, а не эффекта), затем обрезанное измерение краски
 * (`indeterminate` — виновато поле, не компонент), и только потом сам paint-overflow.
 */
export function evaluateGeometryPolicy(input: GeometryPolicyInput): GeometryPolicyResult {
  const tolerances = input.tolerances ?? {};
  const tolerance = Math.max(tolerances.tolerancePx ?? DEFAULT_TOLERANCE_PX, 0);
  const sizeTolerance = Math.max(tolerances.sizeTolerancePx ?? tolerance, 0);
  const layout = input.layoutBounds;
  const paint = input.paintBounds;
  const clip = (input.clipChain ?? []).find((link) => link.effective) ?? null;
  const clippedBy = clip ? { key: clip.key ?? null, property: clip.property, value: clip.value } : null;

  if (!layout) {
    return {
      policyVerdict: "indeterminate", overflow: emptyOverflow(), expectedGeometryDelta: null, clippedBy,
      reasons: ["layout bounds were not measured: the capture surface reported no in-flow descendant boxes"],
    };
  }

  // Расхождение с заявленными габаритами — самостоятельный, названный дефект: он не зависит от
  // краски и остаётся вердиктом даже там, где paint измерить не удалось.
  let expectedGeometryDelta: GeometryExpectedDelta | null = null;
  const expected = tolerances.expectedGeometry ?? null;
  if (expected) {
    const widthDelta = round2(layout.width - expected.width);
    const heightDelta = round2(layout.height - expected.height);
    if (Math.abs(widthDelta) > sizeTolerance || Math.abs(heightDelta) > sizeTolerance) {
      expectedGeometryDelta = {
        expected: { width: expected.width, height: expected.height },
        actual: { width: round2(layout.width), height: round2(layout.height) },
        widthDelta, heightDelta,
      };
    }
  }
  if (expectedGeometryDelta) {
    return {
      policyVerdict: "layout-overflow", overflow: emptyOverflow(), expectedGeometryDelta, clippedBy,
      reasons: [`layout bounds ${expectedGeometryDelta.actual.width}×${expectedGeometryDelta.actual.height} differ from the expected ${expected!.width}×${expected!.height} (Δ ${expectedGeometryDelta.widthDelta}×${expectedGeometryDelta.heightDelta} CSS px)`],
    };
  }

  if (!paint || input.paintBoundsSource !== "alpha") {
    return {
      policyVerdict: "indeterminate", overflow: emptyOverflow(), expectedGeometryDelta: null, clippedBy,
      reasons: ["paint bounds were not measured: capture the case with probe=\"paint\" (transparent surface + margin field)"],
    };
  }
  if (anyClamp(input.paintClamped)) {
    const sides = (["left", "right", "top", "bottom"] as const).filter((side) => input.paintClamped![side]);
    return {
      policyVerdict: "indeterminate", overflow: emptyOverflow(), expectedGeometryDelta: null, clippedBy,
      reasons: [`ink touches the ${sides.join("/")} edge of the capture field: increase the paint margin and recapture`],
    };
  }

  const overflow = {
    left: positive(layout.x - paint.x, tolerance),
    right: positive(right(paint) - right(layout), tolerance),
    top: positive(layout.y - paint.y, tolerance),
    bottom: positive(bottom(paint) - bottom(layout), tolerance),
  };
  const total = overflow.left + overflow.right + overflow.top + overflow.bottom;
  if (total === 0) {
    return {
      policyVerdict: "clean", overflow: { ...overflow, sources: [] }, expectedGeometryDelta: null, clippedBy,
      reasons: [],
    };
  }
  const sources = attributeSources(layout, overflow, input.effectSources ?? [], tolerance);
  const named = sources.length > 0
    ? `; sources: ${sources.slice(0, 3).map((item) => `${item.elementKey || item.elementPath || "?"} (${item.cause}, ${item.contribution.total}px)`).join(", ")}`
    : "; no descendant effect explains it";
  return {
    policyVerdict: clip ? "paint-overflow-clipped" : "paint-overflow-not-clipped",
    overflow: { ...overflow, sources },
    expectedGeometryDelta: null,
    clippedBy,
    reasons: [`ink extends past the layout bounds by left ${overflow.left} / right ${overflow.right} / top ${overflow.top} / bottom ${overflow.bottom} CSS px${clip ? ` and is clipped by ${clip.property}: ${clip.value}` : ""}${named}`],
  };
}

/**
 * Считает ли политика такой вердикт продуктовым провалом при данных допусках. Вынесено сюда, а не
 * в гейт: «что означает `paint-overflow-clipped`» — свойство контракта геометрии, и unit-тест на
 * него не должен поднимать БД и капчур-сервис.
 *
 * Величины overflow приходят параметром (а не выводятся из вердикта), потому что per-side бюджет
 * `overflowBudgetPx` иначе невыразим: класс вердикта знает «краска вышла», но не «на сколько и с
 * какой стороны» (план 2026-08-06 §W3, точка 6).
 */
export function geometryVerdictBlocks(
  verdict: GeometryPolicyVerdict,
  overflow: GeometryOverflowSides | null | undefined,
  tolerances: GeometryTolerancesInput = {},
): boolean {
  if (verdict === "layout-overflow") return true;
  if (verdict !== "paint-overflow-not-clipped" && verdict !== "paint-overflow-clipped") return false;
  if (tolerances.allowPaintOverflow === true) return false;
  if (verdict === "paint-overflow-clipped" && tolerances.expectedClip === true) return false;
  return !withinOverflowBudget(overflow, tolerances.overflowBudgetPx);
}

/** Стороны наблюдённого overflow — ровно то, что бюджет обязан сравнивать (CSS px). */
export type GeometryOverflowSides = { left: number; right: number; top: number; bottom: number };

/**
 * Уложился ли наблюдённый overflow в объявленный бюджет. Бюджета нет — не уложился (сегодняшнее
 * поведение). Бюджет есть, а измерений нет — тоже **не** уложился: бюджет снимает блокировку
 * только доказанно, догадка здесь была бы тихим пропуском провала.
 */
function withinOverflowBudget(
  overflow: GeometryOverflowSides | null | undefined,
  budget: GeometryTolerancesInput["overflowBudgetPx"],
): boolean {
  if (!budget) return false;
  if (!overflow) return false;
  return (["left", "right", "top", "bottom"] as const).every((side) => overflow[side] <= (budget[side] ?? 0));
}
