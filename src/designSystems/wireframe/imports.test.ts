import { describe, expect, it } from "vitest";
import { designSystems, getDesignSystem } from "..";
import { shadcnSystem } from "../shadcn";
import { wireframeSystem } from ".";

describe("design system import smoke test", () => {
  it("imports both builtin systems and the registry together", () => {
    expect(designSystems.shadcn).toBe(shadcnSystem);
    expect(designSystems.wireframe).toBe(wireframeSystem);
    expect(getDesignSystem("shadcn")).toBe(shadcnSystem);
    expect(getDesignSystem("wireframe")).toBe(wireframeSystem);
  });
});
