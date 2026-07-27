import { describe, expect, it } from "vitest";
import { COMPONENT_SCOPES, inferScopeFromAtomicLevel, insertDefinitionScope, isComponentScope, isOwnerScope, planScopeBackfill, scopeRank } from "./scope";

describe("component scope", () => {
  it("orders scopes by ownership size", () => {
    expect(COMPONENT_SCOPES.map((scope) => scopeRank[scope])).toEqual([1, 2, 3, 4]);
    expect(isOwnerScope("shell")).toBe(true);
    expect(isOwnerScope("section")).toBe(false);
    expect(isOwnerScope(undefined)).toBe(false);
  });

  it("guards unknown values", () => {
    expect(isComponentScope("screen")).toBe(true);
    expect(isComponentScope("page")).toBe(false);
    expect(isComponentScope(2)).toBe(false);
  });

  it("infers a display-only scope from the atomic level", () => {
    expect(inferScopeFromAtomicLevel("atom")).toBe("primitive");
    expect(inferScopeFromAtomicLevel("molecule")).toBe("primitive");
    expect(inferScopeFromAtomicLevel("organism")).toBe("section");
    expect(inferScopeFromAtomicLevel("template")).toBe("shell");
    expect(inferScopeFromAtomicLevel("page")).toBe("screen");
    expect(inferScopeFromAtomicLevel(undefined)).toBeUndefined();
  });
});

describe("scope backfill planning", () => {
  it("applies the manual override list before the atomicLevel rule", () => {
    const plan = planScopeBackfill([
      { id: "yp-screen", name: "YpScreen", atomicLevel: "organism" },
      { id: "yp-scroll-area", name: "YpScrollArea", atomicLevel: "molecule" },
      { id: "yp-button", name: "YpButton", atomicLevel: "atom" },
      { id: "yp-ctyp-success", name: "YpCtypSuccess", atomicLevel: "page" },
    ]);
    expect(plan.map((entry) => [entry.id, entry.action, entry.nextScope, entry.source])).toEqual([
      ["yp-screen", "set", "shell", "override"],
      ["yp-scroll-area", "set", "shell", "override"],
      ["yp-button", "set", "primitive", "atomicLevel"],
      ["yp-ctyp-success", "set", "screen", "atomicLevel"],
    ]);
  });

  it("skips components without an atomic level and keeps a declared scope", () => {
    const plan = planScopeBackfill([
      { id: "yp-mystery", name: "YpMystery" },
      { id: "yp-panel", name: "YpPanel", atomicLevel: "organism", currentScope: "section" },
      { id: "yp-card", name: "YpCard", atomicLevel: "organism", currentScope: "section" },
    ]);
    expect(plan[0]).toMatchObject({ action: "skip", source: "unknown" });
    // Объявленный scope не переписывается, но расхождение с override помечается.
    expect(plan[1]).toMatchObject({ action: "keep", source: "declared", conflict: true });
    expect(plan[2]).toMatchObject({ action: "keep", source: "declared" });
    expect(plan[2]!.conflict).toBeUndefined();
  });
});

describe("definition scope insertion", () => {
  const source = [
    'import { z } from "zod";',
    "",
    "export const definition = {",
    "  props: z.object({}),",
    '  description: "Каркас экрана",',
    '  atomicLevel: "organism",',
    "};",
    "",
    "export default function YpScreen() { return null; }",
    "",
  ].join("\n");

  it("inserts the scope as the first definition field", () => {
    const result = insertDefinitionScope(source, "shell");
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.source).toContain('export const definition = {\n  scope: "shell",\n  props:');
  });

  it("handles a typed definition declaration", () => {
    const typed = source.replace("export const definition =", "export const definition: CustomComponentDefinition =");
    const result = insertDefinitionScope(typed, "screen");
    expect(result.ok && result.source).toContain('definition: CustomComponentDefinition = {\n  scope: "screen",');
  });

  it("refuses to touch a source that already declares a scope or has no definition", () => {
    const declared = source.replace("  props:", '  scope: "shell",\n  props:');
    expect(insertDefinitionScope(declared, "shell")).toEqual({ ok: false, reason: "already-declared" });
    expect(insertDefinitionScope("export default function X() { return null; }", "shell")).toEqual({ ok: false, reason: "no-definition" });
  });
});
