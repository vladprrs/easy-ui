import { describe, expect, it } from "vitest";
import { canonicalSpacingScale, resolveSpacingScale, shadcnSpacingScale, spacingResolverDiagnostics, wireframeSpacingScale, yandexPaySpacingScale } from "./spacingScale";

describe("resolveSpacingScale", () => {
  it("uses explicit nine-token tables for every builtin family", () => {
    expect(resolveSpacingScale("custom", {})).toEqual(canonicalSpacingScale);
    expect(resolveSpacingScale("wireframe", {})).toEqual(wireframeSpacingScale);
    expect(resolveSpacingScale("yandex-pay", {})).toEqual(yandexPaySpacingScale);
    expect(resolveSpacingScale("shadcn", {})).toEqual(shadcnSpacingScale);
  });

  it("preserves custom-only retired wireframe revision geometry", () => {
    expect(resolveSpacingScale("wireframe", {})).toEqual({
      none: "0px", xs: "4px", sm: "8px", md: "16px", lg: "24px", xl: "32px", "2xl": "48px", "3xl": "64px", "4xl": "80px",
    });
  });

  it("merges valid theme values and synthesizes missing tokens", () => {
    expect(resolveSpacingScale("custom", { "space.md": "14px", "color.brand": "red" })).toEqual({
      ...canonicalSpacingScale, md: "14px",
    });
  });

  it("uses canonical synthesis for missing theme keys even on a non-canonical builtin", () => {
    expect(resolveSpacingScale("wireframe", { "space.md": "14px" })).toEqual({ ...canonicalSpacingScale, md: "14px" });
  });

  it.each([
    { "space.md": 12 },
    { "space.md": "calc(12px)" },
    { "space.unknown": "12px" },
    { "space.none": "1px" },
    { "space.md": "30px" },
  ])("ignores a malformed space group as a whole: %o", (tokens) => {
    expect(resolveSpacingScale("wireframe", tokens as unknown as Record<string, string | number>)).toEqual(canonicalSpacingScale);
  });
});

// Версионирование резолвера (план 2026-08-02 P6.3б, миграция v23). Резолвер 1 обязан остаться
// байт-в-байт таким, каким его видели существующие версии тем; резолвер 2 чинит base-drop.
describe("resolveSpacingScale — versioned resolver", () => {
  const partial = { "space.md": "14px" } as Record<string, string | number>;

  it.each([
    ["wireframe", wireframeSpacingScale],
    ["shadcn", shadcnSpacingScale],
    ["yandex-pay", yandexPaySpacingScale],
    ["custom", canonicalSpacingScale],
  ] as const)("resolver 1 keeps the historical result for %s", (systemId, base) => {
    // Без space.* — базовая шкала DS (это не менялось).
    expect(resolveSpacingScale(systemId, {}, 1)).toEqual(base);
    // С частичным оверрайдом — исторический мердж на каноническую шкалу.
    expect(resolveSpacingScale(systemId, partial, 1)).toEqual({ ...canonicalSpacingScale, md: "14px" });
    // Малформленный набор — исторический откат на каноническую шкалу.
    expect(resolveSpacingScale(systemId, { "space.md": "calc(12px)" }, 1)).toEqual(canonicalSpacingScale);
  });

  it("resolver 2 merges partial overrides onto the design-system base", () => {
    expect(resolveSpacingScale("wireframe", partial, 2)).toEqual({ ...wireframeSpacingScale, md: "14px" });
    expect(resolveSpacingScale("shadcn", partial, 2)).toEqual({ ...shadcnSpacingScale, md: "14px" });
    // Для систем, чья база и есть каноническая шкала, резолверы совпадают.
    expect(resolveSpacingScale("custom", partial, 2)).toEqual(resolveSpacingScale("custom", partial, 1));
    expect(resolveSpacingScale("yandex-pay", partial, 2)).toEqual(resolveSpacingScale("yandex-pay", partial, 1));
  });

  it("resolver 2 falls back to the design-system base instead of the canonical scale", () => {
    expect(resolveSpacingScale("wireframe", { "space.md": "calc(12px)" }, 2)).toEqual(wireframeSpacingScale);
  });

  it("defaults to the legacy resolver so an unversioned call site cannot change behaviour", () => {
    expect(resolveSpacingScale("wireframe", partial)).toEqual(resolveSpacingScale("wireframe", partial, 1));
  });

  it("diagnostics classify base-drop and fallback for the audit script", () => {
    expect(spacingResolverDiagnostics("wireframe", partial)).toMatchObject({ spaceTokensPresent: true, fallbackTriggered: false, baseDropped: true, differs: true });
    expect(spacingResolverDiagnostics("wireframe", { "space.md": "calc(12px)" })).toMatchObject({ fallbackTriggered: true, baseDropped: false, differs: true });
    expect(spacingResolverDiagnostics("custom", partial)).toMatchObject({ baseDropped: false, differs: false });
    expect(spacingResolverDiagnostics("wireframe", {})).toMatchObject({ spaceTokensPresent: false, fallbackTriggered: false, baseDropped: false, differs: false });
  });
});
