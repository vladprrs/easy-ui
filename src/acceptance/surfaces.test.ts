import { describe, expect, it } from "vitest";
import { caseSetManifestSchema } from "./caseSetSchema";
import {
  caseSurfaceIssueOf, comparisonSurfaceOf, comparisonSurfaceProjection, declaresSurfaces,
  expectedSurfacesOf, verdictSurfaceProjection,
} from "./surfaces";

/**
 * Нормализация поверхностей (план 2026-08-07 §W1a). Предмет — **инвариант N3**: результат
 * нормализации существует только внутри вызова потребителя, а дискриминатор нового пути вердикта —
 * исключительно явная декларация.
 */

const manifest = (item: Record<string, unknown>) => caseSetManifestSchema.safeParse({
  manifestVersion: 1,
  componentId: "cmp",
  capture: { viewport: { width: 390, height: 844 } },
  cases: [{ id: "alpha", props: {}, ...item }],
});

describe("expectedSurfacesOf", () => {
  it("легаси `expectedGeometry` читается как `layoutUnion` — и не считается декларацией", () => {
    const legacy = { expectedGeometry: { width: 480, height: 88 } };
    expect(expectedSurfacesOf(legacy)).toEqual({ layoutUnion: { width: 480, height: 88 } });
    // Ключевое: нормализованный случай **не** уходит на новый путь вердикта (иначе весь корпус
    // сменил бы вердикты при замороженном ALGO 7).
    expect(declaresSurfaces(legacy)).toBe(false);
    expect(comparisonSurfaceOf(legacy)).toBe("layoutUnion");
  });

  it("поля нет вовсе — пустая карта, а не выдуманные нули", () => {
    expect(expectedSurfacesOf({})).toEqual({});
    expect(declaresSurfaces({})).toBe(false);
  });

  it("явная декларация побеждает и включает новый путь", () => {
    const declared = { expectedSurfaces: { root: { width: 343, height: 88 } } };
    expect(declaresSurfaces(declared)).toBe(true);
    expect(expectedSurfacesOf(declared)).toEqual({ root: { width: 343, height: 88 } });
  });
});

describe("проекции слоёв (N15)", () => {
  const all = {
    root: { width: 343, height: 88 },
    layoutUnion: { width: 480, height: 88 },
    paint: { width: 486, height: 92 },
    referenceExport: { width: 367, height: 88 },
  };

  it("сравнение видит только referenceExport, вердикт — только остальные три", () => {
    expect(comparisonSurfaceProjection(all)).toEqual({ referenceExport: all.referenceExport });
    expect(verdictSurfaceProjection(all)).toEqual({ root: all.root, layoutUnion: all.layoutUnion, paint: all.paint });
  });

  it("пустая проекция — `undefined`, чтобы ключ не доехал до пре-образа хэша", () => {
    expect(comparisonSurfaceProjection({ root: all.root })).toBeUndefined();
    expect(verdictSurfaceProjection({ referenceExport: all.referenceExport })).toBeUndefined();
    expect(comparisonSurfaceProjection(undefined)).toBeUndefined();
    expect(verdictSurfaceProjection(null)).toBeUndefined();
  });
});

describe("отказы декларации", () => {
  it("case_surface_conflict: два написания одной величины", () => {
    expect(caseSurfaceIssueOf({
      expectedGeometry: { width: 480, height: 88 },
      expectedSurfaces: { layoutUnion: { width: 480, height: 88 } },
    }, "alpha")?.code).toBe("case_surface_conflict");
  });

  it("case_comparison_surface_undeclared: канва без габаритов", () => {
    expect(caseSurfaceIssueOf({
      expectedSurfaces: { root: { width: 343, height: 88 } },
      comparisonSurface: "referenceExport",
    }, "alpha")?.code).toBe("case_comparison_surface_undeclared");
    // Легаси-случай сравнивается с `layoutUnion` законно: нормализация её объявляет.
    expect(caseSurfaceIssueOf({
      expectedGeometry: { width: 480, height: 88 },
      comparisonSurface: "layoutUnion",
    }, "alpha")).toBeNull();
  });

  it("case_clip_expectation_requires_root: ожидание без предмета", () => {
    expect(caseSurfaceIssueOf({
      expectedSurfaces: { layoutUnion: { width: 480, height: 88 } },
      clipExpectation: "root-does-not-clip-layout",
    }, "alpha")?.code).toBe("case_clip_expectation_requires_root");
    expect(caseSurfaceIssueOf({
      expectedSurfaces: { root: { width: 343, height: 88 } },
      clipExpectation: "root-does-not-clip-layout",
    }, "alpha")).toBeNull();
  });
});

describe("схема манифеста", () => {
  it("принимает четыре поверхности, comparisonSurface и clipExpectation", () => {
    const parsed = manifest({
      expectedSurfaces: {
        root: { width: 343, height: 88 }, layoutUnion: { width: 480, height: 88 },
        paint: { width: 486, height: 92 }, referenceExport: { width: 367, height: 88 },
      },
      comparisonSurface: "referenceExport",
      clipExpectation: "root-does-not-clip-layout",
    });
    expect(parsed.success).toBe(true);
    // Без `.default()`: поля, которых нет, обязаны отсутствовать в `parsed.data` — `caseSetIdOf`
    // хэширует именно его, и любой дефолт сменил бы контентный адрес всех прежних наборов.
    const bare = manifest({ expectedGeometry: { width: 480, height: 88 } });
    expect(Object.keys(bare.data!.cases[0]!).sort()).toEqual(["expectedGeometry", "id", "props"]);
  });

  it("отвергает пустой объект поверхностей, неизвестную поверхность и не-целые габариты", () => {
    expect(manifest({ expectedSurfaces: {} }).success).toBe(false);
    expect(manifest({ expectedSurfaces: { border: { width: 1, height: 1 } } }).success).toBe(false);
    expect(manifest({ expectedSurfaces: { root: { width: 1.5, height: 1 } } }).success).toBe(false);
    expect(manifest({ comparisonSurface: "border" }).success).toBe(false);
    expect(manifest({ clipExpectation: "root-clips-layout" }).success).toBe(false);
    // `null` не принимается нигде: необязательное поле опускают, а не зануляют.
    expect(manifest({ expectedSurfaces: null }).success).toBe(false);
  });
});
