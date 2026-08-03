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
    expect(geometryVerdictBlocks(result.policyVerdict)).toBe(true);
    expect(geometryVerdictBlocks(result.policyVerdict, { allowPaintOverflow: true })).toBe(false);
  });

  it("blur внутри overflow:hidden — чисто: краска не выходит за контур, клип назван", () => {
    const result = evaluate({
      paintBounds: { ...layout },
      clipChain: [{ key: "card", property: "overflow", value: "hidden hidden", effective: true }],
    });
    expect(result.policyVerdict).toBe("clean");
    expect(result.overflow.sources).toHaveLength(0);
    expect(result.clippedBy).toMatchObject({ key: "card", property: "overflow" });
    expect(geometryVerdictBlocks(result.policyVerdict)).toBe(false);
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
    expect(geometryVerdictBlocks(result.policyVerdict)).toBe(true);
    expect(geometryVerdictBlocks(result.policyVerdict, { expectedClip: true })).toBe(false);
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
    expect(geometryVerdictBlocks(drifted.policyVerdict, { allowPaintOverflow: true })).toBe(true);
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
    expect(geometryVerdictBlocks("indeterminate")).toBe(false);
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
});
