/**
 * V0-диагностика BR-05 (план `docs/plans/2026-08-08-blocker-removal-eui-br.md` §5, §12 V0).
 *
 * Симптом фидбэка (`docs/EASYUI_BLOCKER_REMOVAL_REQUIREMENTS_20260809.md` §8): transform-tail
 * тултипа `8×24` «расширяет layout union для 24 из 36 roots». Контрольное ревью плана установило,
 * что **буквально** это неверно: `visit()` в `src/capture/geometry.mjs:469` уже дисквалифицирует
 * transform/out-of-flow узлы из `layoutBounds`. Файл фиксирует, каким маршрутом декорация всё же
 * доводит кейс до блокера, и где предложенные §5 механизмы бьют мимо.
 *
 * **Статус после волны BR-05.** Ассерты первого блока сохранены дословно и переименованы в
 * `LEGACY`: они описывают поведение при снятом владении геометрией
 * (`EASYUI_GEOMETRY_OWNERSHIP_DISABLED=1` ⇒ `decorationOwnership:false`, вердикт без
 * `decorationSources`) и служат гарантией byte-for-byte отката. Второй блок — те же четыре
 * маршрута **с включённой** семантикой: там каждый RED-ассерт инвертирован, и именно этим доказано,
 * что чинилось то самое.
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
function installRects(values:Record<string, Box>, offsets:Record<string, {left:number;top:number;width:number;height:number}> = {}) {
  const originalBounding = Element.prototype.getBoundingClientRect;
  const originalClient = Element.prototype.getClientRects;
  Element.prototype.getBoundingClientRect = function () { return values[(this as HTMLElement).dataset.rect ?? ""] ?? box(0, 0, 0, 0); };
  Element.prototype.getClientRects = function () {
    const value = values[(this as HTMLElement).dataset.rect ?? ""];
    return (value ? [value] : []) as unknown as DOMRectList;
  };
  // BR-05: offset-система — второй стаб раскладки, ровно такой же по природе, что и стаб боксов:
  // jsdom не считает ни то, ни другое. Числа здесь — **pre-transform** коробки, то есть то, что
  // Chromium отдаёт по `offsetLeft/offsetTop/offsetWidth/offsetHeight` независимо от матрицы.
  // `offsetParent` подменён на родителя, поэтому накопление идёт по всей цепочке DOM.
  const owner = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent");
  const originals: Record<string, PropertyDescriptor|undefined> = {
    offsetParent: owner,
    offsetLeft: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetLeft"),
    offsetTop: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop"),
    offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth"),
    offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight"),
  };
  const read = (element:HTMLElement, key:"left"|"top"|"width"|"height"):number =>
    offsets[element.dataset.rect ?? ""]?.[key] ?? 0;
  Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get() { return (this as HTMLElement).parentElement; } });
  Object.defineProperty(HTMLElement.prototype, "offsetLeft", { configurable: true, get() { return read(this as HTMLElement, "left"); } });
  Object.defineProperty(HTMLElement.prototype, "offsetTop", { configurable: true, get() { return read(this as HTMLElement, "top"); } });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get() { return read(this as HTMLElement, "width"); } });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return read(this as HTMLElement, "height"); } });
  return () => {
    Element.prototype.getBoundingClientRect = originalBounding;
    Element.prototype.getClientRects = originalClient;
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
    }
  };
}

const SURFACE = box(0, 0, 440, 160);
const BUBBLE = box(16, 16, 391, 88);
/** Пост-transform коробка хвоста: ровно то, что отдаёт `getBoundingClientRect` в Chromium. */
const TAIL = box(207, 104, 8, 24);
/** In-flow строка внутри пузыря — фикстура «декларация на контейнере с layout-детьми». */
const LABEL = box(24, 24, 100, 40);

/** Хвост — absolute+transform ребёнок пузыря (канонический DOM тултипа). */
const TOOLTIP_HTML = `<div id="eui-capture-surface" data-rect="surface"><span data-eui-key="pay-tooltip" style="display:contents"><div data-rect="bubble" style="position:relative"><i data-rect="tail" style="position:absolute;transform:rotate(45deg)"></i></div></span></div>`;

/** Тот же хвост, но сиблинг пузыря во фрагменте-корне (вторая распространённая разметка tail). */
const FRAGMENT_HTML = `<div id="eui-capture-surface" data-rect="surface"><span data-eui-key="pay-tooltip" style="display:contents"><div data-rect="bubble" style="position:relative"></div><i data-rect="tail" style="position:absolute;transform:rotate(45deg)"></i></span></div>`;

/**
 * Pre-transform коробки фикстуры (offset-геометрия), в координатах **родителя**.
 *
 * Хвост тултипа сидит внутри нижней кромки пузыря (`203..211 × 80..104` в координатах
 * поверхности — ровно в контуре `16..407 × 16..104`), а наружу его выносит матрица. Это и есть
 * тот факт, которого до волны в кадре не было вовсе и без которого «декорация» неотличима от
 * «половина компонента уехала».
 */
const NESTED_OFFSETS = {
  surface: { left:0, top:0, width:440, height:160 },
  bubble: { left:16, top:16, width:391, height:88 },
  tail: { left:187, top:64, width:8, height:24 },
};
/** Тот же хвост, но его pre-transform коробка **выходит** за контур: авто-правило не срабатывает. */
const DETACHED_OFFSETS = { ...NESTED_OFFSETS, tail: { left:187, top:84, width:8, height:24 } };
const LABELLED_OFFSETS = { ...NESTED_OFFSETS, label: { left:8, top:8, width:100, height:40 } };

/** Пузырь с in-flow строкой: ровно тот узел, объявлять который декорацией нельзя. */
const CONTAINER_HTML = `<div id="eui-capture-surface" data-rect="surface"><span data-eui-key="pay-tooltip" style="display:contents"><div data-rect="bubble" style="position:relative"><em data-rect="label"></em><i data-rect="tail" style="position:absolute;transform:rotate(45deg)"></i></div></span></div>`;

function measure(html:string, options:Parameters<typeof collectGeometry>[0] = {}, offsets = NESTED_OFFSETS) {
  document.body.innerHTML = html;
  const restore = installRects({ surface:SURFACE, bubble:BUBBLE, tail:TAIL, label:LABEL }, offsets);
  try { return collectGeometry({ detailKeys: [], ...options }); }
  finally { restore(); }
}
/** Сбор с включённой волной: ровно то, что кладёт сервер при снятом kill-switch'е. */
const measureOwned = (html:string, options:Parameters<typeof collectGeometry>[0] = {}, offsets = NESTED_OFFSETS) =>
  measure(html, { decorationOwnership: true, ...options }, offsets);

/** Decoration-источники вердикта из фактов замера — та же проекция, что делает гейт геометрии. */
const decorationSourcesOf = (detail:{ outOfFlowNodes:{ role?:string; elementKey:string; elementPath:string; causes:string[]; postTransformPaintBounds:{x:number;y:number;width:number;height:number}; roleSource?:string }[] }) =>
  detail.outOfFlowNodes.filter((node) => node.role === "decoration").map((node) => ({
    elementKey: node.elementKey, elementPath: node.elementPath, causes: node.causes,
    bounds: node.postTransformPaintBounds, roleSource: (node.roleSource ?? "auto") as "auto" | "declared",
  }));

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

describe("BR-05 · LEGACY (kill-switch): симптом «tail расширяет layout union» — что именно происходит", () => {
  it("LEGACY (EASYUI_GEOMETRY_OWNERSHIP_DISABLED=1): опровержение буквального симптома — layoutBounds хвост НЕ включает (geometry.mjs:469)", () => {
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

  it("LEGACY (EASYUI_GEOMETRY_OWNERSHIP_DISABLED=1): МАРШРУТ 1 — v1 `rects[]` хвост включает: probe-уровень показывает автору 391×112 (geometry.mjs:221-252)", () => {
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

  it("LEGACY (EASYUI_GEOMETRY_OWNERSHIP_DISABLED=1): МАРШРУТ 1b — expectedGeometry, снятый с probe-числа, даёт БЛОКЕР layout-overflow (geometryPolicy.ts:290-295)", () => {
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

  it("LEGACY (EASYUI_GEOMETRY_OWNERSHIP_DISABLED=1): МАРШРУТ 2 — при честном expectedGeometry вердикт всё равно блокирует как paint-overflow-not-clipped", () => {
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

  it("LEGACY (EASYUI_GEOMETRY_OWNERSHIP_DISABLED=1): МАРШРУТ 3 — expectedSurfaces без хвоста в paint ⇒ surface-mismatch, блокирует безусловно (geometryPolicy.ts:432)", () => {
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

  it("LEGACY (EASYUI_GEOMETRY_OWNERSHIP_DISABLED=1): МАРШРУТ 4 — хвост-сиблинг убивает rootBounds ⇒ поверхность root «not-measured» ⇒ indeterminate (geometry.mjs:397-421)", () => {
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

describe("BR-05 · механизм «фикс effectReachPx» — где он на самом деле нужен (не тронут волной)", () => {
  it("LEGACY (EASYUI_GEOMETRY_OWNERSHIP_DISABLED=1): reach=0 у transform/position, но атрибуция считается по пост-transform коробке (geometryPolicy.ts:194, 218-224)", () => {
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

  it("LEGACY (EASYUI_GEOMETRY_OWNERSHIP_DISABLED=1): reach=0 бьёт ТОЛЬКО когда коробка узла не покрывает краску (краска ЗА пределами пост-transform бокса)", () => {
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

// ---------------------------------------------------------------------------------------------
// BR-05 — те же четыре маршрута с включённой семантикой владения геометрией. Каждый ассерт ниже
// инвертирует свой RED-парник выше; расхождение между блоками и есть предмет волны.
// ---------------------------------------------------------------------------------------------

describe("BR-05 · авто-правило decoration: маршруты 1, 2 и 4 сняты без единой декларации", () => {
  it("маршрут 1 снят: probe различает габариты — layout 391×88 рядом с paint-габаритом 391×112", () => {
    const geometry = measureOwned(TOOLTIP_HTML);
    // `content` не переименован и не пересчитан: аддитивность обязательна, на нём стоят
    // существующие потребители probe'а.
    expect(geometry.content).toMatchObject({ width:391, height:112 });
    // …а рядом теперь едет число, по которому и считается вердикт. Автору больше незачем писать
    // декорированный габарит в `expectedGeometry`.
    expect(geometry.layout).toMatchObject({ x:16, y:16, width:391, height:88 });
    expect(geometry.content.height - geometry.layout.height).toBe(24);
  });

  it("факты замера: pre-transform коробка, матрица, post-transform краска и роль каждой поверхности", () => {
    const detail = measureOwned(TOOLTIP_HTML).details![0]!;
    expect(detail.outOfFlowNodes).toHaveLength(1);
    const tail = detail.outOfFlowNodes[0]!;
    expect(tail.causes).toEqual(["position:absolute", "transform:rotate(45deg)"]);
    expect(tail.preTransformBounds).toMatchObject({ x:203, y:80, width:8, height:24 });
    expect(tail.transform).toBe("rotate(45deg)");
    expect(tail.postTransformPaintBounds).toMatchObject({ x:207, y:104, width:8, height:24 });
    expect(tail.role).toBe("decoration");
    expect(tail.roleSource).toBe("auto");
    expect(tail.participation).toEqual({
      layoutUnion: "excluded:decoration", root: "excluded:decoration", paint: "included",
    });
  });

  it("замер расширился, а измерения — прежние: layoutBounds/effectSources байт-в-байт легаси", () => {
    const legacy = measure(TOOLTIP_HTML).details![0]!;
    const owned = measureOwned(TOOLTIP_HTML).details![0]!;
    expect(owned.layoutBounds).toEqual(legacy.layoutBounds);
    expect(owned.effectSources).toEqual(legacy.effectSources);
    expect(owned.clipChain).toEqual(legacy.clipChain);
    // Расходятся ровно два места: роль узла и (у fragment-корня) сам `rootBounds`.
    expect(legacy.outOfFlowNodes[0]!.role).toBeUndefined();
  });

  it("маршрут 4 снят: хвост-сиблинг прозрачен для rootBoxOf ⇒ root измерен, поверхность clean", () => {
    const detail = measureOwned(FRAGMENT_HTML).details![0]!;
    // Было `null` (вечный `indeterminate` у 24 из 36 корней фидбэка) — стало честное измерение.
    expect(detail.rootBounds).toMatchObject({ x:16, y:16, width:391, height:88 });
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
      decorationSources: decorationSourcesOf(detail),
      tolerances: {
        expectedSurfaces: { root:{ width:391, height:88 }, layoutUnion:{ width:391, height:88 } },
        tolerancePx: 1, sizeTolerancePx: 1,
      },
    });
    expect(policy.surfaces!.root).toMatchObject({ verdict:"clean", observed:{ width:391, height:88 } });
    expect(policy.surfaces!.layoutUnion).toMatchObject({ verdict:"clean" });
    expect(policy.divergingSurfaces).toEqual([]);
    // И — главное — без единого допуска: `pass`, а не `indeterminate` и не `fail`.
    expect(gateStatus(policy)).toBe("pass");
  });

  it("маршрут 2 снят: краска, объяснённая декорацией, не блокирует БЕЗ allowPaintOverflow", () => {
    const detail = measureOwned(TOOLTIP_HTML).details![0]!;
    const policy = evaluateGeometryPolicy({
      layoutBounds: detail.layoutBounds,
      paintBounds: PAINT_BOUNDS,
      paintBoundsSource: "alpha",
      paintClamped: { left:false, right:false, top:false, bottom:false },
      effectSources: detail.effectSources,
      clipChain: detail.clipChain,
      rootBounds: detail.rootBounds,
      rootClip: detail.rootClip,
      decorationSources: decorationSourcesOf(detail),
      tolerances: { expectedGeometry: { width: 391, height: 88 }, tolerancePx: 1, sizeTolerancePx: 1 },
    });
    // Класс вердикта честный: краска действительно вышла, и факт остаётся в сохранённом вердикте.
    expect(policy.policyVerdict).toBe("paint-overflow-decoration");
    expect(policy.overflow).toMatchObject({ left:0, right:0, top:0, bottom:24 });
    expect(policy.decorationSources!.map((source) => source.roleSource)).toEqual(["auto"]);
    expect(geometryVerdictBlocks(policy.policyVerdict, policy.overflow, {})).toBe(false);
    expect(gateStatus(policy)).toBe("pass");
  });

  it("не всякий overflow прощён: краска ЗА коробкой декорации по-прежнему блокирует", () => {
    const detail = measureOwned(TOOLTIP_HTML).details![0]!;
    const policy = evaluateGeometryPolicy({
      layoutBounds: detail.layoutBounds,
      // Краска уехала ниже хвоста ещё на 20 px — этого никто не объявлял.
      paintBounds: { x: 16, y: 16, width: 391, height: 132 },
      paintBoundsSource: "alpha",
      paintClamped: { left:false, right:false, top:false, bottom:false },
      effectSources: detail.effectSources,
      clipChain: detail.clipChain,
      decorationSources: decorationSourcesOf(detail),
      tolerances: { tolerancePx: 1 },
    });
    expect(policy.policyVerdict).toBe("paint-overflow-not-clipped");
    expect(policy.decorationSources).toBeUndefined();
    expect(gateStatus(policy)).toBe("fail");
  });
});

describe("BR-05 · per-case geometryOwnership: маршрут 3 и неоднозначный DOM", () => {
  /** Хвост, чья pre-transform коробка НЕ вложена в контур: авто-правило молчит по построению. */
  it("авто-правило не срабатывает на невложенной коробке — декларация обязательна", () => {
    const auto = measureOwned(FRAGMENT_HTML, {}, DETACHED_OFFSETS).details![0]!;
    expect(auto.outOfFlowNodes[0]!.role).toBeUndefined();
    expect(auto.rootBounds).toBeNull();

    const declared = measureOwned(FRAGMENT_HTML, {
      geometryOwnership: { "pay-tooltip//i": { role: "decoration", participatesIn: ["paint"] } },
    }, DETACHED_OFFSETS).details![0]!;
    expect(declared.outOfFlowNodes[0]!.role).toBe("decoration");
    expect(declared.outOfFlowNodes[0]!.roleSource).toBe("declared");
    expect(declared.rootBounds).toMatchObject({ width:391, height:88 });
  });

  it("маршрут 3 снят: expectedSurfaces по макету сходятся, а хвост остаётся в краске и в визуале", () => {
    const detail = measureOwned(TOOLTIP_HTML, {
      geometryOwnership: { "pay-tooltip//i": { role: "decoration", participatesIn: ["paint"] } },
    }).details![0]!;
    const policy = evaluateGeometryPolicy({
      layoutBounds: detail.layoutBounds,
      paintBounds: PAINT_BOUNDS,
      paintBoundsSource: "alpha",
      paintClamped: { left:false, right:false, top:false, bottom:false },
      effectSources: detail.effectSources,
      clipChain: detail.clipChain,
      rootBounds: detail.rootBounds,
      rootClip: detail.rootClip,
      decorationSources: decorationSourcesOf(detail),
      tolerances: {
        expectedSurfaces: { root:{ width:391, height:88 }, layoutUnion:{ width:391, height:88 }, paint:{ width:391, height:88 } },
        tolerancePx: 1, sizeTolerancePx: 1,
      },
    });
    // Поверхности сошлись, а дальше работает обычный аппарат краски — и он честно говорит, что
    // краска вышла и кем объяснена. Блокирующим этот класс не является (`geometryVerdictBlocks`).
    expect(policy.policyVerdict).toBe("paint-overflow-decoration");
    expect(policy.divergingSurfaces).toEqual([]);
    expect(policy.surfaces!.paint).toMatchObject({ verdict:"clean", observed:{ width:391, height:88 } });
    // Хвост при этом **никуда не делся**: сырое измерение краски по-прежнему 391×112, и именно
    // этот кадр уезжает в визуальный дифф. Владение поправило вердикт, а не пиксели.
    expect(policy.paintOwnership).toEqual({
      raw: { width:391, height:112 }, observed: { width:391, height:88 }, decorationSources: 1,
    });
    expect(gateStatus(policy)).toBe("pass");
  });

  it("злоупотребление: метка на in-flow контейнере с layout-детьми — факт замера для отказа", () => {
    const detail = measureOwned(CONTAINER_HTML, {
      // `div` пузыря — обычный in-flow контейнер: он и держит габариты компонента.
      geometryOwnership: { "pay-tooltip//div": { role: "decoration", participatesIn: ["paint"] } },
    }, LABELLED_OFFSETS).details![0]! as unknown as { ownershipViolations: { elementPath:string; reason:string; layoutChildren:number }[] };
    expect(detail.ownershipViolations).toHaveLength(1);
    expect(detail.ownershipViolations[0]).toMatchObject({ reason:"in-flow-container", layoutChildren:1 });
  });
});
