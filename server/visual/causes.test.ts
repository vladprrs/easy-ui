import { expect, test } from "bun:test";
import {
  CAUSE_THRESHOLDS, classifyVisualCauses,
  classifyAlphaCompositing, classifyDescendantOutsideMask, classifyEdgeRadiusStroke, classifyEffectOverflow,
  classifyGeometryShift, classifyMissingLateAsset, classifySurfaceTint, classifyTextRasterResidual,
  dominantElementKey, signatureBasisOf,
  type CauseInput, type CauseVisualMetrics,
} from "./causes";

/**
 * Таксономия визуальных причин (план 2026-08-03 §5 W5b, фидбэк §19.6).
 *
 * Тесты синтетические по построению: классификаторы — чистые функции над уже посчитанными
 * метриками, поэтому «сигнал → код» проверяется без chromium, без pngjs и без CAS. Предмет —
 * ровно два свойства: **каждый код срабатывает на своём сигнале** и **ни один не срабатывает на
 * пустом месте** (фолбэк `unclassified`).
 */

const region = (x: number, y: number, width: number, height: number, areaPct = 1, meanDelta = 40) =>
  ({ bbox: { x, y, width, height }, areaPct, meanDelta });

const visual = (patch: Partial<CauseVisualMetrics> = {}): CauseVisualMetrics => ({
  rawDiffPct: 5, aaDiffPct: 5, maxChannelDelta: 120,
  regions: [region(20, 20, 40, 40, 5)], totalRegions: 1,
  bestOffset: { dx: 0, dy: 0, residualPct: 5 },
  canvas: { width: 200, height: 200 },
  channelStats: {
    pixels: 1000, meanDelta: { r: 80, g: 20, b: 20, a: 0 },
    meanMaxDelta: 80, stdMaxDelta: 60, alphaDominantPct: 0, semiTransparentPct: 0,
  },
  ...patch,
});

/** Кейс по умолчанию: layout 100×100 CSS px при dsf=2 ⇒ холст 200×200 px, paint == layout. */
const input = (patch: Partial<CauseInput> = {}): CauseInput => ({
  visual: visual(),
  geometry: {
    layoutBounds: { x: 0, y: 0, width: 100, height: 100 },
    paintBounds: { x: 0, y: 0, width: 100, height: 100 },
    effectSources: [],
  },
  readiness: { images: { total: 2, decoded: 2, failed: 0 }, pendingRequests: [] },
  deviceScaleFactor: 2,
  ...patch,
});

test("missing-late-asset: провалившийся декод и висящие запросы — доказательство readiness, а не пиксели", () => {
  const failedImages = classifyMissingLateAsset({ readiness: { images: { total: 3, decoded: 2, failed: 1 }, pendingRequests: [] } });
  expect(failedImages?.code).toBe("missing-late-asset");
  expect(failedImages!.confidence).toBeGreaterThan(0.85);
  expect(failedImages!.detail).toContain("1 image(s) failed");

  const pending = classifyMissingLateAsset({ readiness: { pendingRequests: ["https://cdn/icon.svg"] } });
  expect(pending?.code).toBe("missing-late-asset");
  // Висящий запрос — улика послабее провалившегося декода.
  expect(pending!.confidence).toBeLessThan(failedImages!.confidence);
  expect(pending!.detail).toContain("icon.svg");

  expect(classifyMissingLateAsset(input())).toBeNull();
});

test("geometry-shift: остаток после лучшего смещения кратно меньше исходного расхождения", () => {
  const shifted = classifyGeometryShift(input({
    visual: visual({ rawDiffPct: 12, aaDiffPct: 11, bestOffset: { dx: 2, dy: -1, residualPct: 0.4 } }),
  }));
  expect(shifted?.code).toBe("geometry-shift");
  expect(shifted!.detail).toContain("2/-1px");
  expect(shifted!.region?.basis).toBe("layoutBounds");

  // Смещение есть, но оно ничего не объясняет — «перерисовано», а не «съехало».
  expect(classifyGeometryShift(input({
    visual: visual({ rawDiffPct: 12, bestOffset: { dx: 3, dy: 0, residualPct: 11 } }),
  }))).toBeNull();
  // Нулевое смещение — не сдвиг по определению.
  expect(classifyGeometryShift(input({ visual: visual({ bestOffset: { dx: 0, dy: 0, residualPct: 0.1 } }) }))).toBeNull();
});

test("surface-tint: равномерная дельта по всей площади с низким разбросом", () => {
  const tint = classifySurfaceTint(input({
    visual: visual({
      rawDiffPct: 92, aaDiffPct: 92, regions: [region(0, 0, 200, 200, 92, 18)], totalRegions: 1,
      channelStats: {
        pixels: 36_800, meanDelta: { r: 18, g: 16, b: 14, a: 0 },
        meanMaxDelta: 18, stdMaxDelta: 2, alphaDominantPct: 0, semiTransparentPct: 0,
      },
    }),
  }));
  expect(tint?.code).toBe("surface-tint");
  expect(tint!.confidence).toBeGreaterThan(0.8);

  // Та же площадь, но дельта рваная — это не заливка.
  expect(classifySurfaceTint(input({
    visual: visual({
      rawDiffPct: 92, regions: [region(0, 0, 200, 200, 92, 90)], totalRegions: 7,
      channelStats: {
        pixels: 36_800, meanDelta: { r: 90, g: 40, b: 10, a: 0 },
        meanMaxDelta: 90, stdMaxDelta: CAUSE_THRESHOLDS.surfaceUniformStdDelta + 30,
        alphaDominantPct: 0, semiTransparentPct: 0,
      },
    }),
  }))).toBeNull();
  // Локальное расхождение по площади до порога не дотягивает.
  expect(classifySurfaceTint(input())).toBeNull();
});

test("edge-radius-stroke: тонкие полосы по периметру контура", () => {
  const frame = classifyEdgeRadiusStroke(input({
    visual: visual({
      rawDiffPct: 3, aaDiffPct: 3,
      regions: [
        region(0, 0, 200, 4, 1.5), region(0, 196, 200, 4, 1.5),
        region(0, 0, 4, 200, 1.5), region(196, 0, 4, 200, 1.5),
      ],
      totalRegions: 4,
    }),
  }));
  expect(frame?.code).toBe("edge-radius-stroke");
  expect(frame!.detail).toContain("4 of 4");

  // Толстый блок в середине рамкой не является.
  expect(classifyEdgeRadiusStroke(input({
    visual: visual({ regions: [region(60, 60, 80, 80, 16)], totalRegions: 1 }),
  }))).toBeNull();
});

test("text-raster-residual: edge-маска решает одна — AA-эвристика в этом случае не голосует (R7a, T-M9)", () => {
  // Остаток лежит на контурах эталона ⇒ растровый, даже когда AA-метрика **не** схлопывается
  // (сдвиг глифа на 1 px даёт aa/raw ≈ 0,6 — доволновая эвристика здесь молчала бы).
  const onEdges = classifyTextRasterResidual(input({
    visual: visual({
      rawDiffPct: 4.35, aaDiffPct: 2.57, totalRegions: 38,
      edgeResidual: { residualPixels: 11138, insidePixels: 10995, outsidePixels: 143, insidePct: 98.72 },
    }),
  }));
  expect(onEdges?.code).toBe("text-raster-residual");
  expect(onEdges!.detail).toContain("reference's own edges");

  // Остаток вне контуров ⇒ не растровый, сколь угодно «текстовые» AA-метрики его не спасают:
  // это и есть инвариант волны, перенесённый на уровень классификатора.
  expect(classifyTextRasterResidual(input({
    visual: visual({
      rawDiffPct: 1.4, aaDiffPct: 0.05, totalRegions: 6,
      edgeResidual: { residualPixels: 948, insidePixels: 481, outsidePixels: 467, insidePct: 50.74 },
    }),
  }))).toBeNull();

  // Пустой остаток — сравнивать нечего.
  expect(classifyTextRasterResidual(input({
    visual: visual({ rawDiffPct: 1.4, aaDiffPct: 0.05, totalRegions: 6, edgeResidual: { residualPixels: 0, insidePixels: 0, outsidePixels: 0, insidePct: null } }),
  }))).toBeNull();
});

test("text-raster-residual (фолбэк без edge-маски): строгая метрика значима, AA-терпимая почти нулевая", () => {
  const text = classifyTextRasterResidual(input({
    visual: visual({
      rawDiffPct: 1.4, aaDiffPct: 0.05,
      regions: [region(20, 30, 30, 8, 0.5), region(60, 30, 24, 8, 0.4), region(20, 50, 40, 8, 0.5)],
      totalRegions: 3,
    }),
  }));
  expect(text?.code).toBe("text-raster-residual");
  expect(text!.detail).toContain("anti-aliasing");

  // Тот же разрыв, но одна крупная область — это не растровый остаток текста.
  expect(classifyTextRasterResidual(input({
    visual: visual({ rawDiffPct: 40, aaDiffPct: 0.5, regions: [region(0, 0, 180, 180, 40)], totalRegions: 1 }),
  }))).toBeNull();
  // AA-метрика не схлопывается ⇒ расхождение структурное.
  expect(classifyTextRasterResidual(input({
    visual: visual({ rawDiffPct: 4, aaDiffPct: 3.5, totalRegions: 5 }),
  }))).toBeNull();
});

test("alpha-compositing: дельта преимущественно в альфе и полупрозрачных зонах", () => {
  const alpha = classifyAlphaCompositing(input({
    visual: visual({
      channelStats: {
        pixels: 5_000, meanDelta: { r: 4, g: 4, b: 4, a: 90 },
        meanMaxDelta: 90, stdMaxDelta: 12, alphaDominantPct: 88, semiTransparentPct: 74,
      },
    }),
  }));
  expect(alpha?.code).toBe("alpha-compositing");
  expect(alpha!.detail).toContain("alpha");

  // Цветовое расхождение при непрозрачных пикселях — не композитинг.
  expect(classifyAlphaCompositing(input())).toBeNull();
  // Без статистики маски (результат снят до W5b) сигнала нет вовсе — и выдумывать его нельзя.
  expect(classifyAlphaCompositing(input({ visual: visual({ channelStats: null }) }))).toBeNull();
});

test("effect-overflow: расхождение в кольце между layout- и paint-контуром, виновник назван", () => {
  const overflow = classifyEffectOverflow(input({
    visual: visual({ regions: [region(0, 0, 200, 16, 4), region(0, 184, 200, 16, 4)], totalRegions: 2 }),
    geometry: {
      layoutBounds: { x: 0, y: 10, width: 100, height: 80 },
      paintBounds: { x: 0, y: 0, width: 100, height: 100 },
      effectSources: [{ elementKey: "glow", cause: "filter:blur(24px)", rect: { x: 0, y: 0, width: 100, height: 100 } }],
    },
  }));
  expect(overflow?.code).toBe("effect-overflow");
  expect(overflow!.elementKey).toBe("glow");

  // Кольца нет — paint совпал с layout, объяснять нечего.
  expect(classifyEffectOverflow(input())).toBeNull();
});

test("descendant-outside-mask: расхождение вне измеренной маски владения", () => {
  const outside = classifyDescendantOutsideMask(input({
    visual: visual({ regions: [region(150, 150, 40, 40, 4)], totalRegions: 1 }),
    geometry: {
      layoutBounds: { x: 0, y: 0, width: 60, height: 60 },
      paintBounds: { x: 0, y: 0, width: 60, height: 60 },
      effectSources: [{ elementKey: "badge", cause: "position:absolute", rect: { x: 70, y: 70, width: 30, height: 30 } }],
    },
  }));
  expect(outside?.code).toBe("descendant-outside-mask");
  expect(outside!.elementKey).toBe("badge");

  expect(classifyDescendantOutsideMask(input())).toBeNull();
});

test("фолбэк: без сигнала возвращается ровно одна причина unclassified", () => {
  const causes = classifyVisualCauses(input({
    visual: visual({ rawDiffPct: 4, aaDiffPct: 3.9, regions: [region(60, 60, 30, 30, 4)], totalRegions: 1 }),
  }));
  expect(causes).toHaveLength(1);
  expect(causes[0]!.code).toBe("unclassified");
  expect(causes[0]!.detail).toContain("raw 4%");

  // Визуального измерения нет вовсе (`indeterminate` без метрик) — причина всё равно названа.
  const noMetrics = classifyVisualCauses({ visual: null, visualReason: "dimensions_irreconcilable" });
  expect(noMetrics).toHaveLength(1);
  expect(noMetrics[0]!.detail).toContain("dimensions_irreconcilable");
});

test("классификация ранжирует причины по confidence и не бывает пустой", () => {
  const causes = classifyVisualCauses(input({
    visual: visual({ rawDiffPct: 12, aaDiffPct: 11, bestOffset: { dx: 2, dy: 0, residualPct: 0.2 } }),
    readiness: { images: { total: 2, decoded: 1, failed: 1 }, pendingRequests: [] },
  }));
  // Оба сигнала названы; порядок — по силе (объяснённые 98% расхождения весомее висящего ассета).
  expect([...causes].map((cause) => cause.code).sort()).toEqual(["geometry-shift", "missing-late-asset"]);
  expect(causes[0]!.confidence).toBeGreaterThanOrEqual(causes[1]!.confidence);
});

test("нормировка сигнатуры: layout-контур в приоритете, холст — запасной базис", () => {
  expect(signatureBasisOf(input())).toEqual({ rect: { x: 0, y: 0, width: 200, height: 200 }, basis: "layoutBounds" });
  const canvasOnly = signatureBasisOf(input({ geometry: { layoutBounds: null, paintBounds: null, effectSources: [] } }));
  expect(canvasOnly?.basis).toBe("canvas");
  expect(signatureBasisOf({ visual: null })).toBeNull();
});

test("атрибуция: виновник — источник эффекта с наибольшим пересечением", () => {
  const key = dominantElementKey({ x: 100, y: 100, width: 40, height: 40 }, input({
    geometry: {
      layoutBounds: { x: 0, y: 0, width: 100, height: 100 },
      paintBounds: { x: 0, y: 0, width: 100, height: 100 },
      effectSources: [
        { elementKey: "far", cause: "position:absolute", rect: { x: 0, y: 0, width: 20, height: 20 } },
        { elementKey: "near", cause: "box-shadow:0 2px 8px", rect: { x: 45, y: 45, width: 40, height: 40 } },
      ],
    },
  }));
  expect(key).toBe("near");
});
