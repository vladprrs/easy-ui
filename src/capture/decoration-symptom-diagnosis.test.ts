/**
 * V0-диагностика BR-05 (план `docs/plans/2026-08-08-blocker-removal-eui-br.md` §5, §12 V0).
 *
 * Симптом фидбэка (`docs/EASYUI_BLOCKER_REMOVAL_REQUIREMENTS_20260809.md` §8): transform-tail
 * тултипа `8×24` «расширяет layout union для 24 из 36 roots». Контрольное ревью плана установило,
 * что **буквально** это неверно: `visit()` в `src/capture/geometry.mjs:469` уже дисквалифицирует
 * transform/out-of-flow узлы из `layoutBounds`. Файл фиксирует, каким маршрутом декорация всё же
 * доводит кейс до блокера, и где предложенные §5 механизмы бьют мимо.
 *
 * Все ассерты — **RED (BR-05)**: они описывают ТЕКУЩЕЕ поведение. Волна BR-05 обязана их
 * переписать (и тем доказать, что чинилось то самое).
 *
 * Геометрия фикстуры — из фидбэка: bubble `391×88`, tail `8×24` под нижней кромкой.
 */
import { describe, expect, it } from "vitest";
import { collectGeometry } from "./geometry.mjs";
import {
  effectReachPx, evaluateGeometryPolicy, geometryVerdictBlocks,
  type GeometryPolicyResult,
} from "./geometryPolicy";

type Box = { left:number; top:number; right:number; bottom:number; width:number; height:number; x:number; y:number; toJSON():unknown };
const box = (left:number, top:number, width:number, height:number):Box =>
  ({ left, top, right:left+width, bottom:top+height, width, height, x:left, y:top, toJSON(){ return this; } });

/** Тот же стаб раскладки, что и в `geometry.test.ts`: jsdom не считает боксы. */
function installRects(values:Record<string, Box>) {
  const originalBounding = Element.prototype.getBoundingClientRect;
  const originalClient = Element.prototype.getClientRects;
  Element.prototype.getBoundingClientRect = function () { return values[(this as HTMLElement).dataset.rect ?? ""] ?? box(0, 0, 0, 0); };
  Element.prototype.getClientRects = function () {
    const value = values[(this as HTMLElement).dataset.rect ?? ""];
    return (value ? [value] : []) as unknown as DOMRectList;
  };
  return () => { Element.prototype.getBoundingClientRect = originalBounding; Element.prototype.getClientRects = originalClient; };
}

const SURFACE = box(0, 0, 440, 160);
const BUBBLE = box(16, 16, 391, 88);
/** Пост-transform коробка хвоста: ровно то, что отдаёт `getBoundingClientRect` в Chromium. */
const TAIL = box(207, 104, 8, 24);

/** Хвост — absolute+transform ребёнок пузыря (канонический DOM тултипа). */
const TOOLTIP_HTML = `<div id="eui-capture-surface" data-rect="surface"><span data-eui-key="pay-tooltip" style="display:contents"><div data-rect="bubble" style="position:relative"><i data-rect="tail" style="position:absolute;transform:rotate(45deg)"></i></div></span></div>`;

/** Тот же хвост, но сиблинг пузыря во фрагменте-корне (вторая распространённая разметка tail). */
const FRAGMENT_HTML = `<div id="eui-capture-surface" data-rect="surface"><span data-eui-key="pay-tooltip" style="display:contents"><div data-rect="bubble" style="position:relative"></div><i data-rect="tail" style="position:absolute;transform:rotate(45deg)"></i></span></div>`;

function measure(html:string) {
  document.body.innerHTML = html;
  const restore = installRects({ surface:SURFACE, bubble:BUBBLE, tail:TAIL });
  try { return collectGeometry({ detailKeys: [] }); }
  finally { restore(); }
}

/** Ink-bbox кадра `probe:"paint"`: альфа видит хвост, поэтому краска = union пузыря и хвоста. */
const PAINT_BOUNDS = { x: 16, y: 16, width: 391, height: 112 };

/**
 * Статус гейта по вердикту — формула `server/acceptance/gates/geometry2.ts:334-337`,
 * воспроизведённая здесь дословно: импортировать сам гейт значило бы затащить в юнит-тест
 * evidence-хранилище и ink-воркер.
 */
function gateStatus(policy:GeometryPolicyResult, tolerances:Parameters<typeof geometryVerdictBlocks>[2] = {}):string {
  const named = policy.overflow.sources.length > 0
    || policy.expectedGeometryDelta !== null
    || (policy.divergingSurfaces?.length ?? 0) > 0
    || policy.clipSatisfied === false;
  const blocks = geometryVerdictBlocks(policy.policyVerdict, policy.overflow, tolerances);
  const unmeasured = Object.values(policy.surfaces ?? {}).filter((surface) => surface.verdict === "not-measured").length;
  return policy.policyVerdict === "indeterminate" ? "indeterminate"
    : blocks ? (named ? "fail" : "indeterminate")
    : unmeasured > 0 ? "indeterminate"
    : "pass";
}

describe("BR-05 · симптом «tail расширяет layout union» — что именно происходит", () => {
  it("RED (BR-05): опровержение буквального симптома — layoutBounds хвост НЕ включает (geometry.mjs:469)", () => {
    const detail = measure(TOOLTIP_HTML).details![0]!;
    // Контур layout — чистые 391×88 фидбэка: transform-узел дисквалифицирован `keeps`.
    expect(detail.layoutBounds).toMatchObject({ x:16, y:16, width:391, height:88 });
    expect(detail.rootBounds).toMatchObject({ x:16, y:16, width:391, height:88 });
    // Хвост зафиксирован как источник эффекта — дважды, по обеим причинам выпадения из потока.
    expect(detail.effectSources.map((source) => source.cause)).toEqual([
      "position:absolute", "transform:rotate(45deg)",
    ]);
    expect(detail.effectSources[0]!.rect).toMatchObject({ x:207, y:104, width:8, height:24 });
  });

  it("RED (BR-05): МАРШРУТ 1 — v1 `rects[]` хвост включает: probe-уровень показывает автору 391×112 (geometry.mjs:221-252)", () => {
    // `rects[]` — union `getClientRects()` ВСЕХ потомков без фильтра потока, и именно он уезжает в
    // `driver.mjs preview --probe geometry` / `geometry <proto> <screen>` (details у probe
    // "geometry" не собираются вовсе — `scripts/screenshot-worker.mjs:253`). Автор кейса меряет
    // корень этой ручкой и видит габарит С ХВОСТОМ: +24 px по высоте. Вот он, «layout union,
    // расширенный декорацией», — только это НЕ тот union, по которому считается вердикт.
    const geometry = measure(TOOLTIP_HTML);
    expect(geometry.rects[0]).toMatchObject({ key:"pay-tooltip", x:16, y:16, width:391, height:112 });
    expect(geometry.content).toMatchObject({ width:391, height:112 });
    expect("details" in geometry).toBe(true); // detailKeys запрошены явно; у probe "geometry" их нет
    // Расхождение двух измерений одного корня — 24 px, ровно высота хвоста.
    expect(geometry.rects[0]!.height - geometry.details![0]!.layoutBounds!.height).toBe(24);
  });

  it("RED (BR-05): МАРШРУТ 1b — expectedGeometry, снятый с probe-числа, даёт БЛОКЕР layout-overflow (geometryPolicy.ts:290-295)", () => {
    const detail = measure(TOOLTIP_HTML).details![0]!;
    const policy = evaluateGeometryPolicy({
      layoutBounds: detail.layoutBounds,
      paintBounds: PAINT_BOUNDS,
      paintBoundsSource: "alpha",
      paintClamped: { left:false, right:false, top:false, bottom:false },
      effectSources: detail.effectSources,
      clipChain: detail.clipChain,
      rootBounds: detail.rootBounds,
      rootClip: detail.rootClip,
      // 391×112 — то, что автор прочитал у `preview --probe geometry`.
      tolerances: { expectedGeometry: { width: 391, height: 112 }, tolerancePx: 1, sizeTolerancePx: 1 },
    });
    expect(policy.policyVerdict).toBe("layout-overflow");
    expect(policy.expectedGeometryDelta).toMatchObject({ actual:{ width:391, height:88 }, widthDelta:0, heightDelta:-24 });
    // `layout-overflow` блокирует безусловно: ни allowPaintOverflow, ни бюджет его не снимают.
    expect(geometryVerdictBlocks(policy.policyVerdict, policy.overflow, { allowPaintOverflow: true })).toBe(true);
    expect(gateStatus(policy)).toBe("fail");
  });

  it("RED (BR-05): МАРШРУТ 2 — при честном expectedGeometry вердикт всё равно блокирует как paint-overflow-not-clipped", () => {
    const detail = measure(TOOLTIP_HTML).details![0]!;
    const policy = evaluateGeometryPolicy({
      layoutBounds: detail.layoutBounds,
      paintBounds: PAINT_BOUNDS,
      paintBoundsSource: "alpha",
      paintClamped: { left:false, right:false, top:false, bottom:false },
      effectSources: detail.effectSources,
      clipChain: detail.clipChain,
      rootBounds: detail.rootBounds,
      rootClip: detail.rootClip,
      tolerances: { expectedGeometry: { width: 391, height: 88 }, tolerancePx: 1, sizeTolerancePx: 1 },
    });
    expect(policy.policyVerdict).toBe("paint-overflow-not-clipped");
    expect(policy.overflow).toMatchObject({ left:0, right:0, top:0, bottom:24 });
    // Виновник НАЗВАН — вопреки гипотезе плана «effectReachPx=0 ⇒ атрибуции нет».
    expect(policy.overflow.sources.map((source) => source.cause)).toEqual([
      "position:absolute", "transform:rotate(45deg)",
    ]);
    expect(policy.overflow.sources[0]!.contribution).toMatchObject({ bottom:24, total:24 });
    // Значит вердикт не `indeterminate`, а честный `fail` — и это блокер, снимаемый только допуском.
    expect(gateStatus(policy)).toBe("fail");
    expect(gateStatus(policy, { allowPaintOverflow: true })).toBe("pass");
    expect(gateStatus(policy, { overflowBudgetPx: { bottom: 24 } })).toBe("pass");
  });

  it("RED (BR-05): МАРШРУТ 3 — expectedSurfaces без хвоста в paint ⇒ surface-mismatch, блокирует безусловно (geometryPolicy.ts:432)", () => {
    const detail = measure(TOOLTIP_HTML).details![0]!;
    const policy = evaluateGeometryPolicy({
      layoutBounds: detail.layoutBounds,
      paintBounds: PAINT_BOUNDS,
      paintBoundsSource: "alpha",
      paintClamped: { left:false, right:false, top:false, bottom:false },
      effectSources: detail.effectSources,
      clipChain: detail.clipChain,
      rootBounds: detail.rootBounds,
      rootClip: detail.rootClip,
      tolerances: {
        // Автор объявил поверхности по макету — без декорации.
        expectedSurfaces: { root:{ width:391, height:88 }, layoutUnion:{ width:391, height:88 }, paint:{ width:391, height:88 } },
        tolerancePx: 1, sizeTolerancePx: 1,
      },
    });
    expect(policy.policyVerdict).toBe("surface-mismatch");
    expect(policy.divergingSurfaces).toEqual(["paint"]);
    expect(policy.surfaces!.root).toMatchObject({ verdict:"clean" });
    expect(policy.surfaces!.layoutUnion).toMatchObject({ verdict:"clean" });
    expect(policy.surfaces!.paint).toMatchObject({ verdict:"size-mismatch", observed:{ width:391, height:112 }, delta:{ widthDelta:0, heightDelta:24 } });
    // Ни один допуск краски `surface-mismatch` не снимает (geometryPolicy.ts:475).
    expect(geometryVerdictBlocks(policy.policyVerdict, policy.overflow, { allowPaintOverflow:true, overflowBudgetPx:{ bottom:24 } })).toBe(true);
    expect(gateStatus(policy)).toBe("fail");
  });

  it("RED (BR-05): МАРШРУТ 4 — хвост-сиблинг убивает rootBounds ⇒ поверхность root «not-measured» ⇒ indeterminate (geometry.mjs:397-421)", () => {
    // `boxedGeneration` считает боксовых детей первого поколения БЕЗ учёта потока: absolute+
    // transform декорация — второй бокс, и корень объявляется неизмеримым (как Fragment-корень).
    const detail = measure(FRAGMENT_HTML).details![0]!;
    expect(detail.rootBounds).toBeNull();
    // layout-union при этом честный: хвост из него по-прежнему исключён.
    expect(detail.layoutBounds).toMatchObject({ width:391, height:88 });
    const policy = evaluateGeometryPolicy({
      layoutBounds: detail.layoutBounds,
      paintBounds: PAINT_BOUNDS,
      paintBoundsSource: "alpha",
      paintClamped: { left:false, right:false, top:false, bottom:false },
      effectSources: detail.effectSources,
      clipChain: detail.clipChain,
      rootBounds: detail.rootBounds,
      rootClip: detail.rootClip,
      tolerances: {
        expectedSurfaces: { root:{ width:391, height:88 }, layoutUnion:{ width:391, height:88 } },
        tolerancePx: 1, sizeTolerancePx: 1,
      },
    });
    expect(policy.surfaces!.root).toMatchObject({ verdict:"not-measured", observed:null });
    // Не-измеренная поверхность НЕ попадает в divergingSurfaces — обвинения нет, но и pass нет.
    expect(policy.divergingSurfaces).toEqual([]);
    expect(policy.reasons.some((reason) => reason.includes("surface root was not measured"))).toBe(true);
    // Пока краска блокирует, статус — `fail` по хвосту (маршрут 2), и «root не измерен» тонет
    // в детали; снимешь краску допуском — вылезет вечный `indeterminate` вместо `pass`.
    expect(gateStatus(policy)).toBe("fail");
    expect(gateStatus(policy, { allowPaintOverflow: true })).toBe("indeterminate");
    expect(gateStatus(policy, { overflowBudgetPx: { bottom: 24 } })).toBe("indeterminate");
  });
});

describe("BR-05 · механизм «фикс effectReachPx» — где он на самом деле нужен", () => {
  it("RED (BR-05): reach=0 у transform/position, но атрибуция считается по пост-transform коробке (geometryPolicy.ts:194, 218-224)", () => {
    expect(effectReachPx("transform:rotate(45deg)")).toBe(0);
    expect(effectReachPx("transform:matrix(0.707, 0.707, -0.707, 0.707, 0, 0)")).toBe(0);
    expect(effectReachPx("position:absolute")).toBe(0);
    // …и это не мешает: вклад стороны = min(наблюдённый overflow, расстояние коробки + reach), а
    // коробка transform-узла УЖЕ пост-transform. Хвост объясняет свои 24 px при нулевом reach.
    const explained = evaluateGeometryPolicy({
      layoutBounds: { x:16, y:16, width:391, height:88 },
      paintBounds: PAINT_BOUNDS,
      paintBoundsSource: "alpha",
      paintClamped: { left:false, right:false, top:false, bottom:false },
      effectSources: [{ elementKey:"pay-tooltip", elementPath:"div>i", cause:"transform:rotate(45deg)", rect:{ x:207, y:104, width:8, height:24 } }],
      clipChain: [],
      tolerances: { tolerancePx: 1 },
    });
    expect(explained.overflow.sources).toHaveLength(1);
    expect(explained.overflow.sources[0]!.contribution.total).toBe(24);
  });

  it("RED (BR-05): reach=0 бьёт ТОЛЬКО когда коробка узла не покрывает краску (краска ЗА пределами пост-transform бокса)", () => {
    // Синтетика: transform-узел стоит внутри layout-контура, а красит наружу (тень/размытие,
    // отданные без собственной причины). Тогда объяснения нет и гейт выдаёт indeterminate.
    // Из геометрии tail'а 8×24 такой кейс НЕ следует — см. предыдущий тест.
    const unexplained = evaluateGeometryPolicy({
      layoutBounds: { x:16, y:16, width:391, height:88 },
      paintBounds: PAINT_BOUNDS,
      paintBoundsSource: "alpha",
      paintClamped: { left:false, right:false, top:false, bottom:false },
      effectSources: [{ elementKey:"pay-tooltip", elementPath:"div>i", cause:"transform:rotate(45deg)", rect:{ x:207, y:80, width:8, height:24 } }],
      clipChain: [],
      tolerances: { tolerancePx: 1 },
    });
    expect(unexplained.policyVerdict).toBe("paint-overflow-not-clipped");
    expect(unexplained.overflow.sources).toEqual([]);
    expect(unexplained.reasons[0]).toContain("no descendant effect explains it");
    expect(gateStatus(unexplained)).toBe("indeterminate");
  });
});
