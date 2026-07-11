import { shadcnComponentDefinitions } from "@json-render/shadcn/catalog";
import { describe, expect, it } from "vitest";
import { shadcnAtomicLevels } from "./atomicLevels";
import { componentDefinitions } from "./index";

describe("shadcn atomic levels", () => {
  it("covers every builtin definition in both directions", () => {
    const definitions = new Set([...Object.keys(shadcnComponentDefinitions), "Hotspot"]);
    const levels = new Set(Object.keys(shadcnAtomicLevels));
    expect(levels).toEqual(definitions);
    expect(definitions).toEqual(levels);
    expect(levels.size).toBe(37);
  });

  it("applies every level and only marks Stack and Grid as layout-neutral", () => {
    for (const [name, level] of Object.entries(shadcnAtomicLevels)) {
      expect(componentDefinitions[name as keyof typeof componentDefinitions].atomicLevel).toBe(level);
    }
    expect(Object.entries(componentDefinitions)
      .filter(([, definition]) => definition.layoutNeutral)
      .map(([name]) => name)
      .sort()).toEqual(["Grid", "Stack"]);
  });
});
