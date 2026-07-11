import { describe, expect, it } from "vitest";
import { componentDefinitions } from "../catalog/definitions";
import { fixtures } from "../catalog/fixtures";
import { designSystems, getDesignSystem, resolveDefinitions } from ".";
import { shadcnSystem } from "./shadcn";

describe("design system import smoke test", () => {
  it("imports compat modules, registry, and shadcn system together", () => {
    expect(designSystems.shadcn).toBe(shadcnSystem);
    expect(getDesignSystem("shadcn")).toBe(shadcnSystem);
    expect(resolveDefinitions("shadcn")).toBe(shadcnSystem.definitions);
    expect(componentDefinitions).toBe(shadcnSystem.definitions);
    expect(fixtures).toBe(shadcnSystem.fixtures);
    expect(Object.keys(shadcnSystem.components)).toEqual(Object.keys(componentDefinitions));
  });

  it("rejects unknown systems", () => {
    expect(() => getDesignSystem("unknown")).toThrow("Unknown design system: unknown");
  });
});
