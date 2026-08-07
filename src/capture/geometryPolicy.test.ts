import { describe, expect, it } from "vitest";
import { effectReachPx, evaluateGeometryPolicy, geometryVerdictBlocks, type GeometryPolicyInput } from "./geometryPolicy";

// Geometry Contract 2.0 (план 2026-08-03 §5 W3). Тесты намеренно без DOM и без PNG: политика —
// чистая функция над измерениями, поэтому кейс из фидбэка проверяется арифметикой, а не браузером.

const layout = { x: 64, y: 64, width: 140, height: 96 };
/** Blur-подсветка выходит за контур на 17.5px по каждой стороне: 140×96 → 175×130 (по вертикали). */
const blurSource = {
  elementKey: "highlight",
  elementPath: "div>div.highlight",
  cause: "filter:blur(68px)",
  rect: { x: 46.5, y: 47, width: 175, height: 130 },
};

const evaluate = (overrides: Partial<GeometryPolicyInput> = {}) => evaluateGeometryPolicy({
  layoutBounds: layout,
  paintBounds: { x: 46.5, y: 47, width: 175, height: 130 },
  paintBoundsSource: "alpha",
  paintClamped: { left: false, right: false, top: false, bottom: false },
  effectSources: [blurSource],
  clipChain: [],
  ...overrides,
});

describe("geometry policy", () => {
  it("кейс фидбэка: layout 140×96 честный, краска шире, виноват назван потомок с CSS-причиной", () => {
    const result = evaluate();
    expect(result.policyVerdict).toBe("paint-overflow-not-clipped");
    expect(result.overflow).toMatchObject({ left: 17.5, right: 17.5, top: 17, bottom: 17 });
    expect(result.overflow.sources).toHaveLength(1);
    expect(result.overflow.sources[0]).toMatchObject({ elementKey: "highlight", cause: "filter:blur(68px)" });
    expect(result.overflow.sources[0]!.contribution.total).toBeCloseTo(69, 5);
    expect(result.reasons[0]).toContain("highlight");
    // Допуск случая переводит ожидаемое свечение в неблокирующее, вердикт при этом честный.
    expect(geometryVerdictBlocks(result.policyVerdict, result.overflow)).toBe(true);
    expect(geometryVerdictBlocks(result.policyVerdict, result.overflow, { allowPaintOverflow: true })).toBe(false);
  });

  it("blur внутри overflow:hidden — чисто: краска не выходит за контур, клип назван", () => {
    const result = evaluate({
      paintBounds: { ...layout },
      clipChain: [{ key: "card", property: "overflow", value: "hidden hidden", effective: true }],
    });
    expect(result.policyVerdict).toBe("clean");
    expect(result.overflow.sources).toHaveLength(0);
    expect(result.clippedBy).toMatchObject({ key: "card", property: "overflow" });
    expect(geometryVerdictBlocks(result.policyVerdict, result.overflow)).toBe(false);
  });

  it("краска выходит наружу и режется предком: paint-overflow-clipped, expectedClip снимает блокировку", () => {
    const result = evaluate({
      clipChain: [
        { key: "outer", property: "overflow", value: "visible visible", effective: false },
        { key: "card", property: "overflow", value: "hidden hidden", effective: true },
      ],
    });
    expect(result.policyVerdict).toBe("paint-overflow-clipped");
    expect(result.overflow.sources[0]!.cause).toBe("filter:blur(68px)");
    expect(geometryVerdictBlocks(result.policyVerdict, result.overflow)).toBe(true);
    expect(geometryVerdictBlocks(result.policyVerdict, result.overflow, { expectedClip: true })).toBe(false);
  });

  it("расхождение с expectedGeometry названо отдельным вердиктом layout-overflow", () => {
    const result = evaluate({
      paintBounds: { ...layout },
      tolerances: { expectedGeometry: { width: 140, height: 96 }, sizeTolerancePx: 1 },
    });
    expect(result.policyVerdict).toBe("clean");

    const drifted = evaluate({
      layoutBounds: { ...layout, width: 175 },
      paintBounds: { ...layout, width: 175 },
      tolerances: { expectedGeometry: { width: 140, height: 96 }, sizeTolerancePx: 1 },
    });
    expect(drifted.policyVerdict).toBe("layout-overflow");
    expect(drifted.expectedGeometryDelta).toMatchObject({ widthDelta: 35, heightDelta: 0 });
    expect(geometryVerdictBlocks(drifted.policyVerdict, drifted.overflow, { allowPaintOverflow: true })).toBe(true);
  });

  it("dsf=2: нормализованные в CSS px измерения не дают ложного overflow ×2", () => {
    // Так выглядят те же чернила, если ink-воркер честно поделил PNG-пиксели на deviceScaleFactor.
    const deviceBounds = { x: 128, y: 128, width: 280, height: 192 };
    const cssBounds = { x: deviceBounds.x / 2, y: deviceBounds.y / 2, width: deviceBounds.width / 2, height: deviceBounds.height / 2 };
    expect(evaluate({ paintBounds: cssBounds, effectSources: [] }).policyVerdict).toBe("clean");
    // Забытая нормализация — ровно тот ложный overflow, ради которого правило и записано.
    expect(evaluate({ paintBounds: deviceBounds, effectSources: [] }).policyVerdict).toBe("paint-overflow-not-clipped");
  });

  it("чернила на краю поля и отсутствующие измерения дают indeterminate, а не вердикт", () => {
    const clamped = evaluate({ paintClamped: { left: false, right: true, top: false, bottom: false } });
    expect(clamped.policyVerdict).toBe("indeterminate");
    expect(clamped.reasons[0]).toContain("increase the paint margin");
    expect(clamped.overflow.sources).toHaveLength(0);

    expect(evaluate({ paintBounds: null, paintBoundsSource: null }).policyVerdict).toBe("indeterminate");
    expect(evaluate({ layoutBounds: null }).policyVerdict).toBe("indeterminate");
    expect(geometryVerdictBlocks("indeterminate", null)).toBe(false);
  });

  it("overflow без объяснимого источника не получает виновника — гейту нечем падать", () => {
    const result = evaluate({ effectSources: [] });
    expect(result.policyVerdict).toBe("paint-overflow-not-clipped");
    expect(result.overflow.sources).toHaveLength(0);
    expect(result.reasons[0]).toContain("no descendant effect explains it");
  });

  it("box-shadow корневого элемента атрибутируется, хотя его коробка равна layout-контуру", () => {
    // Самый частый случай и слепая зона наивной атрибуции «по превышению коробки»: тень красит за
    // border-box, не выходя за него геометрически. Правдоподобие берётся из чисел самой причины.
    const shadow = { elementKey: "card", cause: "box-shadow:0px 0px 40px 20px rgba(0,0,0,0.6)", rect: { ...layout } };
    const result = evaluate({ paintBounds: { x: 44, y: 44, width: 180, height: 136 }, effectSources: [shadow] });
    expect(result.policyVerdict).toBe("paint-overflow-not-clipped");
    expect(result.overflow.sources[0]).toMatchObject({ elementKey: "card" });
    expect(effectReachPx("box-shadow:0px 0px 40px 20px rgba(0,0,0,0.6)")).toBe(60);
    expect(effectReachPx("filter:blur(68px)")).toBe(204);
    // Позиция и трансформация доказываются собственной коробкой, а не «дотягиванием».
    expect(effectReachPx("position:absolute")).toBe(0);
    expect(effectReachPx("transform:matrix(1, 0, 0, 1, 30, 0)")).toBe(0);

    // Крошечная тень глубоко внутри контура наблюдённый overflow не объясняет.
    const tiny = { elementKey: "dot", cause: "box-shadow:0px 1px 2px rgba(0,0,0,0.2)", rect: { x: 100, y: 100, width: 10, height: 10 } };
    expect(evaluate({ paintBounds: { x: 44, y: 44, width: 180, height: 136 }, effectSources: [tiny] }).overflow.sources).toHaveLength(0);
  });

  it("источники ранжируются по вкладу в наблюдённые стороны overflow", () => {
    const small = { elementKey: "badge", cause: "box-shadow:0 2px 4px", rect: { x: 60, y: 64, width: 148, height: 96 } };
    const result = evaluate({ effectSources: [small, blurSource] });
    expect(result.overflow.sources.map((item) => item.elementKey)).toEqual(["highlight", "badge"]);
  });
  // ------------------------------------------------ per-case бюджет overflow (план 2026-08-06 §W3)

  it("overflow внутри бюджета не блокирует, но вердикт-класс в фактах сохраняется", () => {
    const result = evaluate();
    expect(result.policyVerdict).toBe("paint-overflow-not-clipped");
    // Наблюдено left/right 17.5, top/bottom 17 — бюджет объявлен щедро по каждой стороне.
    const budget = { left: 18, right: 18, top: 18, bottom: 18 };
    expect(geometryVerdictBlocks(result.policyVerdict, result.overflow, { overflowBudgetPx: budget })).toBe(false);
    // Факты не переписаны: бюджет отвечает «блокирует ли», а не «было ли».
    expect(result.overflow).toMatchObject({ left: 17.5, right: 17.5, top: 17, bottom: 17 });
    expect(result.overflow.sources[0]).toMatchObject({ elementKey: "highlight" });
  });

  it("граница бюджета включительна, превышение по любой стороне возвращает блокировку", () => {
    const result = evaluate();
    const exact = { left: 17.5, right: 17.5, top: 17, bottom: 17 };
    expect(geometryVerdictBlocks(result.policyVerdict, result.overflow, { overflowBudgetPx: exact })).toBe(false);
    for (const side of ["left", "right", "top", "bottom"] as const) {
      const short = { ...exact, [side]: exact[side] - 0.5 };
      expect(geometryVerdictBlocks(result.policyVerdict, result.overflow, { overflowBudgetPx: short })).toBe(true);
    }
  });

  it("неназванная сторона имеет бюджет 0: односторонний бюджет не разрешает соседние стороны", () => {
    // Краска вылезла только вправо на 20 px — ровно тот случай, ради которого бюджет per-side.
    const rightOnly = evaluate({
      paintBounds: { x: 64, y: 64, width: 160, height: 96 },
      effectSources: [{ elementKey: "glow", cause: "filter:blur(20px)", rect: { x: 64, y: 64, width: 160, height: 96 } }],
    });
    expect(rightOnly.overflow).toMatchObject({ left: 0, right: 20, top: 0, bottom: 0 });
    expect(geometryVerdictBlocks(rightOnly.policyVerdict, rightOnly.overflow, { overflowBudgetPx: { right: 20 } })).toBe(false);
    // Тот же бюджет, но краска ушла влево — не разрешено: неназванная сторона это ноль.
    const both = evaluate();
    expect(geometryVerdictBlocks(both.policyVerdict, both.overflow, { overflowBudgetPx: { right: 20 } })).toBe(true);
  });

  it("бюджет без измерений overflow блокировку не снимает, а layout-overflow не смягчает вовсе", () => {
    const generous = { top: 256, right: 256, bottom: 256, left: 256 };
    expect(geometryVerdictBlocks("paint-overflow-not-clipped", null, { overflowBudgetPx: generous })).toBe(true);
    expect(geometryVerdictBlocks("layout-overflow", { left: 0, right: 0, top: 0, bottom: 0 }, { overflowBudgetPx: generous })).toBe(true);
    // Клипнутый overflow бюджет закрывает так же, как и неклипнутый.
    const clipped = evaluate({ clipChain: [{ key: "card", property: "overflow", value: "hidden hidden", effective: true }] });
    expect(clipped.policyVerdict).toBe("paint-overflow-clipped");
    expect(geometryVerdictBlocks(clipped.policyVerdict, clipped.overflow, { overflowBudgetPx: generous })).toBe(false);
  });

  it("per-case sizeTolerancePx решает судьбу расхождения с expectedGeometry", () => {
    const drift = (sizeTolerancePx: number) => evaluate({
      layoutBounds: { ...layout, width: 146 },
      paintBounds: { ...layout, width: 146 },
      effectSources: [],
      tolerances: { expectedGeometry: { width: 140, height: 96 }, sizeTolerancePx },
    });
    // Профильный допуск 1 px расхождение видит, per-case 8 px — прощает (то же расхождение, те же факты).
    expect(drift(1).policyVerdict).toBe("layout-overflow");
    expect(drift(6).policyVerdict).toBe("clean");
    expect(drift(5).policyVerdict).toBe("layout-overflow");
  });
});

/**
 * Четыре поверхности геометрии (план `docs/plans/2026-08-07-migration-feedback-wave.md` §W1a).
 *
 * Два предмета, и первый важнее второго: **легаси-вход обязан исполнять прежний код байт-в-байт**
 * (иначе включённый по умолчанию recompute сдвинул бы вердикты всего накопленного корпуса при
 * замороженном `CASE_FINGERPRINT_ALGO_VERSION = 7`), и только потом — сами per-surface вердикты.
 */
describe("geometry surfaces (W1a)", () => {
  /**
   * Golden байт-идентичности легаси-ветки. Литералы, а не пересчёт: значение, вычисленное после
   * правки, доказывало бы только само себя. Матрица покрывает все пять исходов легаси-вердикта.
   */
  const LEGACY_MATRIX: [string, GeometryPolicyInput][] = [
    ["clean", { layoutBounds: layout, paintBounds: { ...layout }, paintBoundsSource: "alpha" }],
    ["paint-overflow-not-clipped", {
      layoutBounds: layout, paintBounds: { x: 46.5, y: 47, width: 175, height: 130 },
      paintBoundsSource: "alpha", effectSources: [blurSource],
    }],
    ["paint-overflow-clipped", {
      layoutBounds: layout, paintBounds: { x: 46.5, y: 47, width: 175, height: 130 },
      paintBoundsSource: "alpha", effectSources: [blurSource],
      clipChain: [{ key: "card", property: "overflow", value: "hidden hidden", effective: true }],
    }],
    ["layout-overflow", {
      layoutBounds: layout, paintBounds: { ...layout }, paintBoundsSource: "alpha",
      tolerances: { expectedGeometry: { width: 120, height: 96 } },
    }],
    ["indeterminate (no layout)", { layoutBounds: null, paintBounds: null }],
    ["indeterminate (no paint)", { layoutBounds: layout, paintBounds: null }],
    ["indeterminate (clamped)", {
      layoutBounds: layout, paintBounds: { ...layout }, paintBoundsSource: "alpha",
      paintClamped: { left: true, right: false, top: false, bottom: false },
    }],
  ];

  it("легаси-вход исполняет прежний код: ни одного нового ключа в результате", () => {
    for (const [name, input] of LEGACY_MATRIX) {
      const result = evaluateGeometryPolicy(input);
      // Новые поля кладутся только новым путём — присутствие ключа со значением `undefined` уже
      // сдвинуло бы `geometry.json` и производные артефакты всего корпуса.
      expect(Object.keys(result).sort(), name).toEqual(
        ["clippedBy", "expectedGeometryDelta", "overflow", "policyVerdict", "reasons"],
      );
      expect("surfaces" in result, name).toBe(false);
    }
  });

  it("легаси-вердикты байт-в-байт: golden JSON всей матрицы", () => {
    const golden = LEGACY_MATRIX.map(([name, input]) => [name, evaluateGeometryPolicy(input)] as const);
    expect(JSON.stringify(golden)).toBe(JSON.stringify([
      ["clean", { policyVerdict: "clean", overflow: { left: 0, right: 0, top: 0, bottom: 0, sources: [] }, expectedGeometryDelta: null, clippedBy: null, reasons: [] }],
      ["paint-overflow-not-clipped", {
        policyVerdict: "paint-overflow-not-clipped",
        overflow: {
          left: 17.5, right: 17.5, top: 17, bottom: 17,
          sources: [{ elementKey: "highlight", elementPath: "div>div.highlight", cause: "filter:blur(68px)", contribution: { left: 17.5, right: 17.5, top: 17, bottom: 17, total: 69 } }],
        },
        expectedGeometryDelta: null, clippedBy: null,
        reasons: ["ink extends past the layout bounds by left 17.5 / right 17.5 / top 17 / bottom 17 CSS px; sources: highlight (filter:blur(68px), 69px)"],
      }],
      ["paint-overflow-clipped", {
        policyVerdict: "paint-overflow-clipped",
        overflow: {
          left: 17.5, right: 17.5, top: 17, bottom: 17,
          sources: [{ elementKey: "highlight", elementPath: "div>div.highlight", cause: "filter:blur(68px)", contribution: { left: 17.5, right: 17.5, top: 17, bottom: 17, total: 69 } }],
        },
        expectedGeometryDelta: null, clippedBy: { key: "card", property: "overflow", value: "hidden hidden" },
        reasons: ["ink extends past the layout bounds by left 17.5 / right 17.5 / top 17 / bottom 17 CSS px and is clipped by overflow: hidden hidden; sources: highlight (filter:blur(68px), 69px)"],
      }],
      ["layout-overflow", {
        policyVerdict: "layout-overflow", overflow: { left: 0, right: 0, top: 0, bottom: 0, sources: [] },
        expectedGeometryDelta: { expected: { width: 120, height: 96 }, actual: { width: 140, height: 96 }, widthDelta: 20, heightDelta: 0 },
        clippedBy: null,
        reasons: ["layout bounds 140×96 differ from the expected 120×96 (Δ 20×0 CSS px)"],
      }],
      ["indeterminate (no layout)", {
        policyVerdict: "indeterminate", overflow: { left: 0, right: 0, top: 0, bottom: 0, sources: [] },
        expectedGeometryDelta: null, clippedBy: null,
        reasons: ["layout bounds were not measured: the capture surface reported no in-flow descendant boxes"],
      }],
      ["indeterminate (no paint)", {
        policyVerdict: "indeterminate", overflow: { left: 0, right: 0, top: 0, bottom: 0, sources: [] },
        expectedGeometryDelta: null, clippedBy: null,
        reasons: ["paint bounds were not measured: capture the case with probe=\"paint\" (transparent surface + margin field)"],
      }],
      ["indeterminate (clamped)", {
        policyVerdict: "indeterminate", overflow: { left: 0, right: 0, top: 0, bottom: 0, sources: [] },
        expectedGeometryDelta: null, clippedBy: null,
        reasons: ["ink touches the left edge of the capture field: increase the paint margin and recapture"],
      }],
    ]));
  });

  it("пустая карта поверхностей — всё ещё легаси-вход (дискриминатор это декларация, а не ключ)", () => {
    const result = evaluateGeometryPolicy({
      layoutBounds: layout, paintBounds: { ...layout }, paintBoundsSource: "alpha",
      tolerances: { expectedSurfaces: {} },
    });
    expect(result.surfaces).toBeUndefined();
    expect(result.policyVerdict).toBe("clean");
  });

  /**
   * Головной кейс ретроспективы (Payment Schedule): одно число `expectedGeometry` отвечало на
   * четыре разных вопроса — корень 343×88, экспорт Figma 367×88, union потомков 480×88 при одной
   * ширине поля и 558×88 при другой. Теперь каждая величина проверяется своей поверхностью.
   */
  const PAYMENT_SCHEDULE = {
    layoutBounds: { x: 64, y: 64, width: 480, height: 88 },
    paintBounds: { x: 64, y: 64, width: 480, height: 88 },
    paintBoundsSource: "alpha" as const,
    rootBounds: { x: 64, y: 64, width: 343, height: 88 },
    referenceExportDims: { width: 367, height: 88 },
  };

  it("Payment Schedule: четыре поверхности — четыре независимых вердикта", () => {
    const result = evaluateGeometryPolicy({
      ...PAYMENT_SCHEDULE,
      tolerances: {
        expectedSurfaces: {
          root: { width: 343, height: 88 },
          layoutUnion: { width: 480, height: 88 },
          paint: { width: 480, height: 88 },
          referenceExport: { width: 367, height: 88 },
        },
      },
    });
    expect(result.policyVerdict).toBe("clean");
    expect(result.divergingSurfaces).toEqual([]);
    for (const name of ["root", "layoutUnion", "paint", "referenceExport"] as const) {
      expect(result.surfaces?.[name]?.verdict, name).toBe("clean");
    }
    // Ровно тот же кадр против **другой** ширины поля: расходится только union, и вердикт называет
    // именно его — а не обвиняет компонент целиком, как делал единственный `expectedGeometry`.
    const otherWidth = evaluateGeometryPolicy({
      ...PAYMENT_SCHEDULE,
      tolerances: {
        expectedSurfaces: {
          root: { width: 343, height: 88 },
          layoutUnion: { width: 558, height: 88 },
          referenceExport: { width: 367, height: 88 },
        },
      },
    });
    expect(otherWidth.policyVerdict).toBe("surface-mismatch");
    expect(otherWidth.divergingSurfaces).toEqual(["layoutUnion"]);
    expect(otherWidth.surfaces?.root?.verdict).toBe("clean");
    expect(otherWidth.surfaces?.referenceExport?.verdict).toBe("clean");
    // Проекция на легаси-поле сохраняется: прежние читатели метрик не ломаются.
    expect(otherWidth.expectedGeometryDelta).toEqual({
      expected: { width: 558, height: 88 }, actual: { width: 480, height: 88 },
      widthDelta: -78, heightDelta: 0,
    });
    expect(geometryVerdictBlocks(otherWidth.policyVerdict, otherWidth.overflow)).toBe(true);
    // Бюджет краски и бланкетное разрешение к размеру поверхности отношения не имеют.
    expect(geometryVerdictBlocks(otherWidth.policyVerdict, otherWidth.overflow, { allowPaintOverflow: true })).toBe(true);
  });

  it("порядок divergingSurfaces — root → layoutUnion → paint → referenceExport", () => {
    const result = evaluateGeometryPolicy({
      ...PAYMENT_SCHEDULE,
      tolerances: {
        expectedSurfaces: {
          referenceExport: { width: 1, height: 1 },
          paint: { width: 1, height: 1 },
          layoutUnion: { width: 1, height: 1 },
          root: { width: 1, height: 1 },
        },
      },
    });
    expect(result.divergingSurfaces).toEqual(["root", "layoutUnion", "paint", "referenceExport"]);
  });

  it("факта нет — `not-measured`, а не подстановка чужого числа", () => {
    // Доволновой кадр: `rootBounds`/`referenceExportDims` в нём отсутствуют вовсе.
    const result = evaluateGeometryPolicy({
      layoutBounds: { x: 64, y: 64, width: 480, height: 88 },
      paintBounds: null,
      tolerances: {
        expectedSurfaces: {
          root: { width: 343, height: 88 },
          layoutUnion: { width: 480, height: 88 },
          paint: { width: 480, height: 88 },
          referenceExport: { width: 367, height: 88 },
        },
      },
    });
    expect(result.surfaces?.root?.verdict).toBe("not-measured");
    expect(result.surfaces?.paint?.verdict).toBe("not-measured");
    expect(result.surfaces?.referenceExport?.verdict).toBe("not-measured");
    expect(result.surfaces?.layoutUnion?.verdict).toBe("clean");
    // «Не измерили» — не «разошлось»: обвинения нет, вердикт уходит по прежней ветке краски.
    expect(result.divergingSurfaces).toEqual([]);
    expect(result.policyVerdict).toBe("indeterminate");
  });

  it("допуск поверхности — существующий sizeDeltaPx, единый для всех поверхностей", () => {
    const drift = (sizeTolerancePx: number) => evaluateGeometryPolicy({
      ...PAYMENT_SCHEDULE,
      tolerances: { sizeTolerancePx, expectedSurfaces: { layoutUnion: { width: 474, height: 88 } } },
    });
    expect(drift(1).policyVerdict).toBe("surface-mismatch");
    expect(drift(6).policyVerdict).toBe("clean");
    expect(drift(5).policyVerdict).toBe("surface-mismatch");
  });

  it("clipExpectation: без rootBounds — null, с клипом на корне — нарушено (W1b)", () => {
    const withoutRoot = evaluateGeometryPolicy({
      layoutBounds: layout, paintBounds: { ...layout }, paintBoundsSource: "alpha",
      tolerances: { expectedSurfaces: { layoutUnion: { width: 140, height: 96 } }, clipExpectation: "root-does-not-clip-layout" },
    });
    expect(withoutRoot.clipSatisfied).toBeNull();
    expect(withoutRoot.policyVerdict).toBe("clean");

    // W1b: факт — клип **самого корня**, а не первое эффективное звено восходящей цепочки.
    const clipped = evaluateGeometryPolicy({
      ...PAYMENT_SCHEDULE,
      rootClip: { property: "overflow", value: "hidden hidden" },
      tolerances: { expectedSurfaces: { root: { width: 343, height: 88 } }, clipExpectation: "root-does-not-clip-layout" },
    });
    expect(clipped.clipSatisfied).toBe(false);
    expect(clipped.reasons.join(" ")).toContain("the root box declares overflow: hidden hidden");
    expect(clipped.policyVerdict).toBe("surface-mismatch");
    expect(geometryVerdictBlocks(clipped.policyVerdict, clipped.overflow)).toBe(true);

    // Клипающий **предок** поверхности съёмки утверждение о корне не опровергает: он режет краску
    // (и остаётся в `clippedBy`), но layout корня по-прежнему не обрезан самим корнем.
    const ancestorOnly = evaluateGeometryPolicy({
      ...PAYMENT_SCHEDULE,
      clipChain: [{ key: "card", property: "overflow", value: "hidden hidden", effective: true }],
      tolerances: { expectedSurfaces: { root: { width: 343, height: 88 } }, clipExpectation: "root-does-not-clip-layout" },
    });
    expect(ancestorOnly.clipSatisfied).toBe(true);
    expect(ancestorOnly.clippedBy).toMatchObject({ key: "card" });

    const honest = evaluateGeometryPolicy({
      ...PAYMENT_SCHEDULE,
      tolerances: { expectedSurfaces: { root: { width: 343, height: 88 } }, clipExpectation: "root-does-not-clip-layout" },
    });
    expect(honest.clipSatisfied).toBe(true);
    expect(honest.policyVerdict).toBe("clean");
  });
});
