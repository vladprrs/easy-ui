/**
 * BR-09 (план `docs/plans/2026-08-08-blocker-removal-eui-br.md` §9): владение переливом как форма
 * документа и как composition layout-токен.
 *
 * Предмет — ровно контракт формы: одна ось, один режим, отсутствие поля остаётся отсутствием, и
 * оба пути авторинга компилируются в **одно** runtime-поле. Семантика замера проверяется в
 * `src/capture/geometry.test.ts`, отказ записи под kill-switch'ем — в bun-тесте сервера.
 */
import { describe, expect, it } from "vitest";
import { compiledLayoutProps, compileLayout, compileLayoutElementFields, compositionLayoutSchema } from "./compositionV3/layout";
import { elementSchema, overflowOwnershipSchema } from "./schema";

const OWNERSHIP = { axis: "x", mode: "scroll", expectedContentOverflow: true } as const;

describe("BR-09 · overflowOwnership", () => {
  it("элемент принимает декларацию и не получает дефолта без неё", () => {
    const declared = elementSchema.parse({ type: "YpBox", props: {}, overflowOwnership: OWNERSHIP });
    expect(declared.overflowOwnership).toEqual(OWNERSHIP);
    // Отсутствие обязано остаться отсутствием: документ без поля сохраняется байт-в-байт прежним.
    expect("overflowOwnership" in elementSchema.parse({ type: "YpBox", props: {} })).toBe(false);
  });

  it("контракт v1 знает одну ось и один режим: остальное — отказ, а не молчаливая нормализация", () => {
    expect(overflowOwnershipSchema.safeParse({ axis: "both", mode: "scroll" }).success).toBe(false);
    expect(overflowOwnershipSchema.safeParse({ axis: "x", mode: "clip" }).success).toBe(false);
    expect(overflowOwnershipSchema.safeParse({ axis: "x" }).success).toBe(false);
    // Неизвестное поле — отказ (strictObject): опечатка в имени иначе прошла бы с другой семантикой.
    expect(overflowOwnershipSchema.safeParse({ axis: "x", mode: "scroll", owner: "rail" }).success).toBe(false);
    expect(overflowOwnershipSchema.safeParse({ axis: "y", mode: "scroll", viewportOwner: "rail" }).success).toBe(true);
  });

  it("composition layout-токен компилируется в то же runtime-поле — но полем элемента, не prop'ом", () => {
    const layout = compositionLayoutSchema.parse({ scroll: true, overflowOwnership: OWNERSHIP });
    // Props контракта v1 токеном не заняты: prop'ом `overflowOwnership` был бы неизвестным ключом
    // схемы **любого** компонента (`Unknown props … are errors`) и ронял бы раскрытие композиции.
    expect(compileLayout(layout)).toEqual({ scroll: true });
    expect(compiledLayoutProps(layout)).not.toContain("overflowOwnership");
    // Поле элемента — то же самое, что объявляет авторский документ напрямую.
    expect(compileLayoutElementFields(layout)).toEqual({ overflowOwnership: OWNERSHIP });
    expect(compileLayoutElementFields(compositionLayoutSchema.parse({ scroll: true }))).toEqual({});
  });
});
