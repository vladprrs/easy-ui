import { expect, test } from "bun:test";
import type { VisualCause } from "../visual/causes";
import {
  QUANTIZATION_GRID, groupRemediations, quantizeBbox, remediationKeyOf, sharedVariantFamily,
} from "./grouping";

/**
 * Группировка ремедиаций (план 2026-08-03 §5 W5b; фидбэк §19.6).
 *
 * Главный тест здесь — «20 состояний с одной сломанной иконкой → одна группа»: ровно это
 * требование фидбэка и отличает отчёт приёмки от россыпи независимых failures.
 */

const cause = (patch: Partial<VisualCause> & { code: VisualCause["code"] }): VisualCause => ({
  confidence: 0.8,
  detail: "synthetic",
  ...patch,
});

/** Причина с областью: `norm` — доля от layout-контура, её и квантует сигнатура. */
const withRegion = (
  code: VisualCause["code"],
  norm: { x: number; y: number; width: number; height: number },
  elementKey?: string,
): VisualCause => cause({
  code,
  ...(elementKey ? { elementKey } : {}),
  region: { bbox: { x: norm.x * 200, y: norm.y * 200, width: norm.width * 200, height: norm.height * 200 }, norm, basis: "layoutBounds" },
});

test("одна сломанная иконка на 20 состояний — одна группа", () => {
  // Позиция иконки в каждом состоянии слегка «дышит» (текст рядом другой длины) — сетка 8×8
  // склеивает эти bbox'ы в одну ячейку, иначе группа распалась бы на 20 штук.
  const cases = Array.from({ length: 20 }, (_, index) => ({
    caseId: `case-${String(index).padStart(2, "0")}`,
    causes: [withRegion("missing-late-asset", {
      x: 0.12 + index * 0.001, y: 0.1, width: 0.1, height: 0.1,
    }, "icon")],
    dims: { theme: index % 2 === 0 ? "light" : "dark", size: "m" },
  }));

  const groups = groupRemediations(cases);
  expect(groups).toHaveLength(1);
  expect(groups[0]!.caseCount).toBe(20);
  expect(groups[0]!.cases).toHaveLength(20);
  expect(groups[0]!.cause.code).toBe("missing-late-asset");
  expect(groups[0]!.sharedElementKey).toBe("icon");
  // `variantFamily` — пересечение измерений: тема у участников разная, размер общий.
  expect(groups[0]!.variantFamily).toEqual({ size: "m" });
  expect(groups[0]!.suggestion).toContain("recapture");
  expect(groups[0]!.bboxSignature).toMatchObject({ grid: QUANTIZATION_GRID });
});

test("две независимые причины — две группы, отсортированные по числу случаев", () => {
  const groups = groupRemediations([
    { caseId: "a", causes: [withRegion("surface-tint", { x: 0, y: 0, width: 1, height: 1 })], dims: { theme: "dark" } },
    { caseId: "b", causes: [withRegion("surface-tint", { x: 0, y: 0, width: 1, height: 1 })], dims: { theme: "dark" } },
    { caseId: "c", causes: [withRegion("edge-radius-stroke", { x: 0, y: 0, width: 1, height: 0.05 }, "border")], dims: { theme: "light" } },
  ]);
  expect(groups).toHaveLength(2);
  expect(groups[0]!.cause.code).toBe("surface-tint");
  expect(groups[0]!.cases).toEqual(["a", "b"]);
  expect(groups[0]!.variantFamily).toEqual({ theme: "dark" });
  expect(groups[1]!.cause.code).toBe("edge-radius-stroke");
  expect(groups[1]!.cases).toEqual(["c"]);
  // Ключи групп различны и стабильны при повторном счёте.
  expect(groups[0]!.key).not.toBe(groups[1]!.key);
  expect(groupRemediations([
    { caseId: "a", causes: [withRegion("surface-tint", { x: 0, y: 0, width: 1, height: 1 })], dims: { theme: "dark" } },
    { caseId: "b", causes: [withRegion("surface-tint", { x: 0, y: 0, width: 1, height: 1 })], dims: { theme: "dark" } },
  ])[0]!.key).toBe(groups[0]!.key);
});

test("одна причина в разных местах компонента — разные группы", () => {
  const groups = groupRemediations([
    { caseId: "top", causes: [withRegion("edge-radius-stroke", { x: 0, y: 0, width: 1, height: 0.05 })] },
    { caseId: "bottom", causes: [withRegion("edge-radius-stroke", { x: 0, y: 0.95, width: 1, height: 0.05 })] },
  ]);
  expect(groups).toHaveLength(2);
  expect(groups.map((group) => group.bboxSignature?.y).sort()).toEqual([0, 7]);
});

test("случай группируется по своей самой уверенной причине, а не по всем сразу", () => {
  const groups = groupRemediations([{
    caseId: "multi",
    causes: [
      cause({ code: "geometry-shift", confidence: 0.9 }),
      cause({ code: "surface-tint", confidence: 0.6 }),
    ],
  }]);
  expect(groups).toHaveLength(1);
  expect(groups[0]!.cause.code).toBe("geometry-shift");
});

test("variantFamily: без общих значений и без dims — null", () => {
  expect(sharedVariantFamily([{ theme: "dark" }, { theme: "light" }])).toBeNull();
  expect(sharedVariantFamily([{ theme: "dark" }, null])).toBeNull();
  expect(sharedVariantFamily([])).toBeNull();
  expect(sharedVariantFamily([{ theme: "dark", size: "m" }, { theme: "dark", size: "l" }])).toEqual({ theme: "dark" });
});

test("квантование: доля контура → ячейки сетки, вырожденная область не исчезает", () => {
  expect(quantizeBbox({ x: 0, y: 0, width: 1, height: 1 })).toEqual({ x: 0, y: 0, width: 8, height: 8, grid: 8 });
  expect(quantizeBbox({ x: 0.99, y: 0.99, width: 0, height: 0 })).toEqual({ x: 7, y: 7, width: 1, height: 1, grid: 8 });
  // Отрицательная координата (область левее контура) не уходит в отрицательную ячейку.
  expect(quantizeBbox({ x: -0.4, y: 0.5, width: 0.2, height: 0.2 })).toMatchObject({ x: 0, y: 4 });
});

test("ключ ремедиации не зависит от порядка полей и различает variantFamily", () => {
  const base = { causeCode: "surface-tint" as const, bbox: null, elementKey: "root", variantFamily: { theme: "dark", size: "m" } };
  expect(remediationKeyOf(base)).toBe(remediationKeyOf({ ...base, variantFamily: { size: "m", theme: "dark" } }));
  expect(remediationKeyOf(base)).not.toBe(remediationKeyOf({ ...base, variantFamily: null }));
});

test("случай без причин в группы не попадает", () => {
  expect(groupRemediations([{ caseId: "clean", causes: [] }])).toEqual([]);
});
