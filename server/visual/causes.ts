/**
 * Таксономия визуальных причин (план `docs/plans/2026-08-03-family-acceptance-and-composition-v3.md`
 * §5 W5b, фидбэк `docs/EASYUI_PRODUCT_IMPROVEMENTS.md` §19.6).
 *
 * Модуль отвечает на единственный вопрос: **что именно чинить**, когда случай уже признан
 * провальным. Три границы, за которые он не выходит:
 *
 * 1. **Классификация никогда не влияет на pass/fail** (§2/§10 плана). Вердикт выдают гейты; здесь
 *    только диагностика поверх уже посчитанных метрик. Поэтому функции чистые, без БД, без CAS и
 *    без подпроцессов: вход — то, что случай уже измерил (метрики визуального гейта, факты
 *    геометрии v2, доказательство readiness), выход — список причин.
 * 2. **Ни одна причина не выдумывается.** У каждого классификатора свой сигнал и свои пороги-
 *    константы (`CAUSE_THRESHOLDS`), а `confidence` — сила сигнала, а не украшение. Нет сигнала —
 *    классификатор молчит.
 * 3. **Список никогда не пуст.** Если не сработал ни один классификатор, возвращается
 *    `unclassified` с честным описанием наблюдаемого — «причина не названа» обязано быть видимым
 *    состоянием, а не пустым массивом, который читатель примет за «причин нет».
 *
 * Единицы. Регионы diff-маски приходят в пикселях нормализованного холста (device px), а
 * `layoutBounds`/`paintBounds`/`effectSources[].rect` — в CSS px относительно левого верхнего угла
 * снятой поверхности (контракт `src/capture/geometryPolicy.ts`). Paint-кадр случая снимается с
 * маргин-полем **внутри** поверхности, поэтому у обеих систем общий ноль, и переход между ними —
 * умножение на `deviceScaleFactor`. Он делается ровно в одном месте (`toCanvas`).
 */

export interface CauseRect { x: number; y: number; width: number; height: number }

export type VisualCauseCode =
  | "surface-tint"
  | "edge-radius-stroke"
  | "geometry-shift"
  | "text-raster-residual"
  | "missing-late-asset"
  | "alpha-compositing"
  | "effect-overflow"
  | "descendant-outside-mask"
  | "unclassified";

/** Опорная область причины: bbox в пикселях холста + его доля от опорного контура (для группировки). */
export interface CauseRegionRef {
  bbox: CauseRect;
  /** `bbox`, нормированный к layout-контуру случая (или к холсту, если контура нет): 0..1. */
  norm: { x: number; y: number; width: number; height: number };
  /** Что послужило базисом нормировки — от него зависит сопоставимость сигнатур между случаями. */
  basis: "layoutBounds" | "canvas";
}

export interface VisualCause {
  code: VisualCauseCode;
  /** Сила сигнала, 0..1. Не вероятность: ранжирование причин внутри случая и между случаями. */
  confidence: number;
  detail: string;
  /** Названный виновник, если атрибуция возможна (`effectSources` геометрии v2). */
  elementKey?: string;
  region?: CauseRegionRef;
}

export interface CauseVisualMetrics {
  rawDiffPct: number;
  aaDiffPct: number;
  maxChannelDelta: number;
  regions: { bbox: CauseRect; areaPct: number; meanDelta: number }[];
  totalRegions: number;
  bestOffset: { dx: number; dy: number; residualPct: number };
  canvas?: { width: number; height: number } | null;
  channelStats?: {
    pixels: number;
    meanDelta: { r: number; g: number; b: number; a: number };
    meanMaxDelta: number;
    stdMaxDelta: number;
    alphaDominantPct: number;
    semiTransparentPct: number;
  } | null;
}

export interface CauseGeometryFacts {
  layoutBounds?: CauseRect | null;
  paintBounds?: CauseRect | null;
  effectSources?: { elementKey?: string; elementPath?: string; cause: string; rect: CauseRect }[];
}

export interface CauseReadinessFacts {
  /** Доказательство W4: сколько изображений не декодировалось к моменту съёмки. */
  images?: { total?: number; decoded?: number; failed?: number } | null;
  pendingRequests?: string[];
}

export interface CauseInput {
  /** Метрики визуального гейта; `null` — вердикт `indeterminate` без измерения. */
  visual?: CauseVisualMetrics | null;
  geometry?: CauseGeometryFacts | null;
  readiness?: CauseReadinessFacts | null;
  /** Масштаб кадра: перевод CSS px геометрии в пиксели холста. */
  deviceScaleFactor?: number;
  /** Причина `indeterminate` визуального гейта (`no_reference`, `dimensions_irreconcilable`, …). */
  visualReason?: string | null;
}

/**
 * Пороги классификаторов. Вынесены одной таблицей намеренно: они — единственная настраиваемая
 * часть таксономии, и подбирать их придётся по реальным семьям, а не по коду классификаторов.
 */
export const CAUSE_THRESHOLDS = {
  /** Доля холста в diff-маске, с которой расхождение считается «по всей поверхности», %. */
  surfaceCoveragePct: 45,
  /** Разброс поканальной дельты внутри маски, при котором заливка считается равномерной. */
  surfaceUniformStdDelta: 24,
  /** Толщина «тонкой рамки» в пикселях холста (до умножения на dsf — CSS px). */
  edgeThicknessCssPx: 4,
  /** Допуск прилегания региона к стороне контура, CSS px. */
  edgeProximityCssPx: 3,
  /** Доля регионов, которые обязаны быть рамочными, чтобы причина называлась, %. */
  edgeRegionSharePct: 70,
  /** Остаток после лучшего смещения — доля от `rawDiffPct`, ниже которой это «съехало». */
  shiftResidualRatio: 0.35,
  /** `aaDiffPct` как доля `rawDiffPct`, ниже которой расхождение объясняется растеризацией. */
  textAaRatio: 0.25,
  /** Ниже этого `rawDiffPct` растровый остаток не обсуждается — сравнивать нечего, %. */
  textMinRawDiffPct: 0.02,
  /** Растровый остаток фрагментарен: не меньше стольких связных областей. */
  textMinRegions: 3,
  /** …и самая крупная из них не больше этой доли холста, %. */
  textMaxRegionAreaPct: 25,
  /** Доля пикселей маски, где расходится именно альфа, %. */
  alphaDominantPct: 50,
  /** …либо доля пикселей, где хотя бы одна сторона полупрозрачна, %. */
  semiTransparentPct: 60,
  /** Доля площади diff, попавшая в кольцо layout→paint, с которой называется effect-overflow, %. */
  ringSharePct: 40,
  /** Доля площади diff вне paint-контура, с которой называется descendant-outside-mask, %. */
  outsideSharePct: 40,
  /** Допуск на границы контуров при проверке «внутри/снаружи», CSS px. */
  boundsTolerancePx: 1,
} as const;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
const area = (rect: CauseRect): number => Math.max(0, rect.width) * Math.max(0, rect.height);
const right = (rect: CauseRect): number => rect.x + rect.width;
const bottom = (rect: CauseRect): number => rect.y + rect.height;

/** Пересечение двух прямоугольников (нулевое, если не пересекаются). */
function intersection(left: CauseRect, other: CauseRect): CauseRect {
  const x = Math.max(left.x, other.x);
  const y = Math.max(left.y, other.y);
  const width = Math.min(right(left), right(other)) - x;
  const height = Math.min(bottom(left), bottom(other)) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : { x, y, width: 0, height: 0 };
}

/** CSS px геометрии → пиксели нормализованного холста. */
const toCanvas = (rect: CauseRect, dsf: number): CauseRect =>
  ({ x: rect.x * dsf, y: rect.y * dsf, width: rect.width * dsf, height: rect.height * dsf });

const isRect = (value: unknown): value is CauseRect =>
  value !== null && typeof value === "object"
  && ["x", "y", "width", "height"].every((key) => typeof (value as Record<string, unknown>)[key] === "number");

/**
 * Сопоставимы ли факты геометрии с холстом расхождения.
 *
 * Оба измерения приходят из одной сессии, поэтому в норме контур лежит внутри кадра. Если он туда
 * не помещается, системы координат не совпали (другой масштаб, другой кадр, эталон снят иначе) —
 * и любой вывод «регион вне paint-контура» был бы артефактом пересчёта, а не находкой. В таком
 * случае геометрические классификаторы молчат: это честнее, чем назвать причину наугад.
 */
export function geometryComparable(input: CauseInput): boolean {
  const canvas = input.visual?.canvas;
  const dsf = input.deviceScaleFactor ?? 1;
  if (!canvas || canvas.width <= 0 || canvas.height <= 0) return true;
  const tolerance = Math.max(2, CAUSE_THRESHOLDS.boundsTolerancePx * dsf);
  for (const rect of [input.geometry?.layoutBounds, input.geometry?.paintBounds]) {
    if (!isRect(rect)) continue;
    const box = toCanvas(rect, dsf);
    if (box.x < -tolerance || box.y < -tolerance) return false;
    if (right(box) > canvas.width + tolerance || bottom(box) > canvas.height + tolerance) return false;
  }
  return true;
}

/**
 * Опорный контур случая в пикселях холста: layout-контур, если он измерен, иначе весь холст.
 * От него нормируются bbox'ы причин — без общего базиса сигнатуры разных случаев несопоставимы,
 * и группировка (W5b, `server/acceptance/grouping.ts`) распалась бы на 20 групп вместо одной.
 */
export function signatureBasisOf(input: CauseInput): { rect: CauseRect; basis: CauseRegionRef["basis"] } | null {
  const dsf = input.deviceScaleFactor ?? 1;
  const layout = geometryComparable(input) ? input.geometry?.layoutBounds : null;
  if (isRect(layout) && layout.width > 0 && layout.height > 0) {
    return { rect: toCanvas(layout, dsf), basis: "layoutBounds" };
  }
  const canvas = input.visual?.canvas;
  if (canvas && canvas.width > 0 && canvas.height > 0) {
    return { rect: { x: 0, y: 0, width: canvas.width, height: canvas.height }, basis: "canvas" };
  }
  return null;
}

function regionRefOf(bbox: CauseRect, input: CauseInput): CauseRegionRef | undefined {
  const basis = signatureBasisOf(input);
  if (!basis) return undefined;
  return {
    bbox,
    norm: {
      x: round2((bbox.x - basis.rect.x) / basis.rect.width),
      y: round2((bbox.y - basis.rect.y) / basis.rect.height),
      width: round2(bbox.width / basis.rect.width),
      height: round2(bbox.height / basis.rect.height),
    },
    basis: basis.basis,
  };
}

/** Объединяющий bbox набора регионов (опорная область причины, охватывающей несколько областей). */
function unionBbox(rects: CauseRect[]): CauseRect | null {
  if (rects.length === 0) return null;
  let x = Infinity; let y = Infinity; let x2 = -Infinity; let y2 = -Infinity;
  for (const rect of rects) {
    x = Math.min(x, rect.x); y = Math.min(y, rect.y);
    x2 = Math.max(x2, right(rect)); y2 = Math.max(y2, bottom(rect));
  }
  return { x, y, width: x2 - x, height: y2 - y };
}

/**
 * Ближайший виновник из `effectSources` геометрии v2: источник, чья коробка сильнее всего
 * пересекается с областью расхождения. Ровно та атрибуция, которой требует KPI §1 («0 провалов
 * без названного descendant/cause»), только применённая к пикселям, а не к overflow.
 */
export function dominantElementKey(bbox: CauseRect, input: CauseInput): string | undefined {
  const sources = input.geometry?.effectSources ?? [];
  const dsf = input.deviceScaleFactor ?? 1;
  let best: { key: string; overlap: number } | null = null;
  for (const source of sources) {
    if (!isRect(source.rect)) continue;
    const key = source.elementKey ?? source.elementPath ?? "";
    if (key === "") continue;
    const overlap = area(intersection(bbox, toCanvas(source.rect, dsf)));
    if (overlap <= 0) continue;
    if (!best || overlap > best.overlap) best = { key, overlap };
  }
  return best?.key;
}

// --------------------------------------------------------------------- коды

/** Незагруженный/поздний ассет: доказательство readiness (W4), а не пиксели. */
export function classifyMissingLateAsset(input: CauseInput): VisualCause | null {
  const readiness = input.readiness;
  if (!readiness) return null;
  const failed = readiness.images?.failed ?? 0;
  const pending = (readiness.pendingRequests ?? []).filter((item) => typeof item === "string" && item.length > 0);
  if (failed <= 0 && pending.length === 0) return null;
  const parts: string[] = [];
  if (failed > 0) parts.push(`${failed} image(s) failed to decode`);
  if (pending.length > 0) parts.push(`${pending.length} request(s) still in flight: ${pending.slice(0, 3).join("; ")}`);
  return {
    code: "missing-late-asset",
    // Провалившийся декод — прямое доказательство; висящий запрос — сильная, но косвенная улика.
    confidence: failed > 0 ? 0.9 : 0.7,
    detail: `Capture evidence reports unfinished resources (${parts.join(", ")}), so the frame may predate the component's own assets`,
  };
}

/** Сдвиг целиком: остаток после лучшего смещения кратно меньше исходного расхождения. */
export function classifyGeometryShift(input: CauseInput): VisualCause | null {
  const visual = input.visual;
  if (!visual || visual.rawDiffPct <= 0) return null;
  const { dx, dy, residualPct } = visual.bestOffset;
  if (dx === 0 && dy === 0) return null;
  if (residualPct > visual.rawDiffPct * CAUSE_THRESHOLDS.shiftResidualRatio) return null;
  const explained = clamp01((visual.rawDiffPct - residualPct) / visual.rawDiffPct);
  const bbox = unionBbox(visual.regions.map((region) => region.bbox));
  return {
    code: "geometry-shift",
    confidence: round2(clamp01(0.5 + explained * 0.45)),
    detail: `Shifting the candidate by ${dx}/${dy}px leaves ${residualPct}% residual against ${visual.rawDiffPct}% raw diff:`
      + " the content is drawn at the wrong offset rather than drawn differently",
    ...(bbox ? { region: regionRefOf(bbox, input) } : {}),
  };
}

/** Равномерная заливка по всей площади: тинт/фон, а не локальный дефект. */
export function classifySurfaceTint(input: CauseInput): VisualCause | null {
  const visual = input.visual;
  if (!visual || visual.rawDiffPct < CAUSE_THRESHOLDS.surfaceCoveragePct) return null;
  const stats = visual.channelStats ?? null;
  // Без статистики маски равномерность подтверждается «одной большой областью с ровной дельтой»:
  // сигнал слабее, поэтому и confidence ниже — метрики W5a остаются читаемыми.
  const uniform = stats
    ? stats.stdMaxDelta <= CAUSE_THRESHOLDS.surfaceUniformStdDelta
    : visual.totalRegions <= 2;
  if (!uniform) return null;
  const bbox = unionBbox(visual.regions.map((region) => region.bbox));
  const spread = stats ? stats.stdMaxDelta : null;
  return {
    code: "surface-tint",
    confidence: round2(stats ? clamp01(0.6 + (1 - stats.stdMaxDelta / CAUSE_THRESHOLDS.surfaceUniformStdDelta) * 0.3) : 0.5),
    detail: `${visual.rawDiffPct}% of the canvas differs with a ${spread === null ? "low regional" : `${spread}`} delta spread`
      + " — a whole-surface tint or fill mismatch, not a local defect",
    ...(bbox ? { region: regionRefOf(bbox, input) } : {}),
  };
}

/** Тонкие рамочные области по периметру контура: бордер, радиус, обводка. */
export function classifyEdgeRadiusStroke(input: CauseInput): VisualCause | null {
  const visual = input.visual;
  if (!visual || visual.regions.length === 0) return null;
  const basis = signatureBasisOf(input);
  if (!basis) return null;
  const dsf = input.deviceScaleFactor ?? 1;
  const thickness = CAUSE_THRESHOLDS.edgeThicknessCssPx * dsf;
  const proximity = CAUSE_THRESHOLDS.edgeProximityCssPx * dsf;
  const near = (value: number, edge: number): boolean => Math.abs(value - edge) <= proximity;
  const edgeRegions = visual.regions.filter((region) => {
    const bbox = region.bbox;
    const thin = Math.min(bbox.width, bbox.height) <= thickness;
    const touches = near(bbox.x, basis.rect.x) || near(right(bbox), right(basis.rect))
      || near(bbox.y, basis.rect.y) || near(bottom(bbox), bottom(basis.rect));
    return thin && touches;
  });
  const share = (edgeRegions.length / visual.regions.length) * 100;
  if (share < CAUSE_THRESHOLDS.edgeRegionSharePct) return null;
  const bbox = unionBbox(edgeRegions.map((region) => region.bbox));
  return {
    code: "edge-radius-stroke",
    confidence: round2(clamp01(0.55 + (share / 100) * 0.35)),
    detail: `${edgeRegions.length} of ${visual.regions.length} diff region(s) are thin strips along the ${basis.basis} perimeter`
      + " — an edge, corner radius or stroke mismatch",
    ...(bbox ? { region: regionRefOf(bbox, input) } : {}),
  };
}

/** Растровый остаток текста: строгая метрика значима, AA-терпимая — почти нулевая. */
export function classifyTextRasterResidual(input: CauseInput): VisualCause | null {
  const visual = input.visual;
  if (!visual || visual.rawDiffPct < CAUSE_THRESHOLDS.textMinRawDiffPct) return null;
  if (visual.aaDiffPct > visual.rawDiffPct * CAUSE_THRESHOLDS.textAaRatio) return null;
  if (visual.totalRegions < CAUSE_THRESHOLDS.textMinRegions) return null;
  const largest = visual.regions.reduce((max, region) => Math.max(max, region.areaPct), 0);
  if (largest > CAUSE_THRESHOLDS.textMaxRegionAreaPct) return null;
  const bbox = unionBbox(visual.regions.map((region) => region.bbox));
  const ratio = visual.rawDiffPct === 0 ? 0 : visual.aaDiffPct / visual.rawDiffPct;
  return {
    code: "text-raster-residual",
    confidence: round2(clamp01(0.55 + (1 - ratio / CAUSE_THRESHOLDS.textAaRatio) * 0.35)),
    detail: `Raw diff ${visual.rawDiffPct}% collapses to ${visual.aaDiffPct}% once anti-aliasing is tolerated,`
      + ` spread over ${visual.totalRegions} small region(s) — a text rasterisation residual, not a layout change`,
    ...(bbox ? { region: regionRefOf(bbox, input) } : {}),
  };
}

/** Альфа-композитинг: расходится прозрачность, а не цвет. */
export function classifyAlphaCompositing(input: CauseInput): VisualCause | null {
  const visual = input.visual;
  const stats = visual?.channelStats;
  // Без статистики маски сигнала нет вовсе: `maxChannelDelta` не различает канал, в котором
  // случилось расхождение, и обвинять композитинг «по общему ощущению» нельзя.
  if (!visual || !stats || stats.pixels === 0) return null;
  const alphaDominant = stats.alphaDominantPct >= CAUSE_THRESHOLDS.alphaDominantPct;
  const semiTransparent = stats.semiTransparentPct >= CAUSE_THRESHOLDS.semiTransparentPct;
  if (!alphaDominant && !semiTransparent) return null;
  const bbox = unionBbox(visual.regions.map((region) => region.bbox));
  return {
    code: "alpha-compositing",
    confidence: round2(clamp01(0.5 + (Math.max(stats.alphaDominantPct, stats.semiTransparentPct) / 100) * 0.4)),
    detail: `${stats.alphaDominantPct}% of differing pixels diverge mainly in alpha and ${stats.semiTransparentPct}%`
      + " touch partially transparent pixels — an alpha/compositing mismatch (opacity, blend or backdrop), not a colour change",
    ...(bbox ? { region: regionRefOf(bbox, input) } : {}),
  };
}

/** Доля площади регионов, попавшая в предикат (по площади пересечений, а не по числу областей). */
function shareOf(regions: { bbox: CauseRect }[], keep: (bbox: CauseRect) => number): { share: number; rects: CauseRect[] } {
  let total = 0; let matched = 0;
  const rects: CauseRect[] = [];
  for (const region of regions) {
    const size = area(region.bbox);
    if (size <= 0) continue;
    total += size;
    const hit = keep(region.bbox);
    if (hit > 0) { matched += hit; rects.push(region.bbox); }
  }
  return { share: total === 0 ? 0 : (matched / total) * 100, rects };
}

/** Кольцо между layout- и paint-контуром: краска эффекта за пределами вёрстки. */
export function classifyEffectOverflow(input: CauseInput): VisualCause | null {
  const visual = input.visual;
  const layout = input.geometry?.layoutBounds;
  const paint = input.geometry?.paintBounds;
  if (!visual || visual.regions.length === 0 || !isRect(layout) || !isRect(paint)) return null;
  if (!geometryComparable(input)) return null;
  const dsf = input.deviceScaleFactor ?? 1;
  const tolerance = CAUSE_THRESHOLDS.boundsTolerancePx * dsf;
  const layoutBox = toCanvas(layout, dsf);
  const paintBox = toCanvas(paint, dsf);
  const grownLayout = {
    x: layoutBox.x - tolerance, y: layoutBox.y - tolerance,
    width: layoutBox.width + tolerance * 2, height: layoutBox.height + tolerance * 2,
  };
  // Кольца нет — краска не выходит за вёрстку, и объяснять нечего.
  if (area(paintBox) <= area(grownLayout) + 1) return null;
  const { share, rects } = shareOf(visual.regions, (bbox) =>
    Math.max(0, area(intersection(bbox, paintBox)) - area(intersection(bbox, grownLayout))));
  if (share < CAUSE_THRESHOLDS.ringSharePct) return null;
  const bbox = unionBbox(rects);
  const elementKey = bbox ? dominantElementKey(bbox, input) : undefined;
  return {
    code: "effect-overflow",
    confidence: round2(clamp01(0.5 + (share / 100) * 0.4)),
    detail: `${Math.round(share)}% of the differing area sits in the ring between layoutBounds and paintBounds`
      + `${elementKey ? ` (nearest effect source: ${elementKey})` : ""} — an effect painting outside the layout box`,
    ...(elementKey ? { elementKey } : {}),
    ...(bbox ? { region: regionRefOf(bbox, input) } : {}),
  };
}

/** Расхождение за пределами paint-контура: потомок вне маски владения. */
export function classifyDescendantOutsideMask(input: CauseInput): VisualCause | null {
  const visual = input.visual;
  const paint = input.geometry?.paintBounds ?? input.geometry?.layoutBounds;
  if (!visual || visual.regions.length === 0 || !isRect(paint)) return null;
  if (!geometryComparable(input)) return null;
  const dsf = input.deviceScaleFactor ?? 1;
  const tolerance = CAUSE_THRESHOLDS.boundsTolerancePx * dsf;
  const mask = toCanvas(paint, dsf);
  const grown = {
    x: mask.x - tolerance, y: mask.y - tolerance,
    width: mask.width + tolerance * 2, height: mask.height + tolerance * 2,
  };
  const { share, rects } = shareOf(visual.regions, (bbox) => Math.max(0, area(bbox) - area(intersection(bbox, grown))));
  if (share < CAUSE_THRESHOLDS.outsideSharePct) return null;
  const bbox = unionBbox(rects);
  const elementKey = bbox ? dominantElementKey(bbox, input) : undefined;
  return {
    code: "descendant-outside-mask",
    confidence: round2(clamp01(0.5 + (share / 100) * 0.4)),
    detail: `${Math.round(share)}% of the differing area lies outside the measured ownership mask`
      + `${elementKey ? ` (nearest source: ${elementKey})` : ""} — an unexpected descendant paints beyond the component`,
    ...(elementKey ? { elementKey } : {}),
    ...(bbox ? { region: regionRefOf(bbox, input) } : {}),
  };
}

/**
 * Порядок объявления классификаторов = порядок разрешения ничьих при равной `confidence`: от
 * самых «структурных» причин (незагруженный ассет, сдвиг, потомок вне маски) к самым «поверхностным».
 */
const CLASSIFIERS: ((input: CauseInput) => VisualCause | null)[] = [
  classifyMissingLateAsset,
  classifyGeometryShift,
  classifyDescendantOutsideMask,
  classifyEffectOverflow,
  classifyAlphaCompositing,
  classifyEdgeRadiusStroke,
  classifySurfaceTint,
  classifyTextRasterResidual,
];

/** Фолбэк: причина не названа. Отдельный код, а не пустой список — «не знаю» обязано быть видимым. */
export function unclassifiedCause(input: CauseInput): VisualCause {
  const visual = input.visual;
  const observed = visual
    ? `raw ${visual.rawDiffPct}%, aa ${visual.aaDiffPct}%, ${visual.totalRegions} region(s),`
      + ` best offset ${visual.bestOffset.dx}/${visual.bestOffset.dy}px with ${visual.bestOffset.residualPct}% residual`
    : input.visualReason
      ? `no metrics were produced (${input.visualReason})`
      : "no visual metrics were produced";
  return {
    code: "unclassified",
    confidence: 0.2,
    detail: `No cause classifier matched this case (${observed}); inspect diff.png and geometry.json in the evidence archive`,
  };
}

/**
 * Классифицирует расхождение случая. Всегда возвращает **не менее одной** причины, отсортированной
 * по убыванию `confidence`; при равенстве побеждает более структурная (порядок `CLASSIFIERS`).
 */
export function classifyVisualCauses(input: CauseInput): VisualCause[] {
  const causes: VisualCause[] = [];
  for (const classify of CLASSIFIERS) {
    const cause = classify(input);
    if (cause) causes.push(cause);
  }
  if (causes.length === 0) return [unclassifiedCause(input)];
  return causes
    .map((cause, index) => ({ cause, index }))
    .sort((left, rightItem) =>
      rightItem.cause.confidence - left.cause.confidence || left.index - rightItem.index)
    .map((item) => item.cause);
}
