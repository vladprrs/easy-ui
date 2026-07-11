import { describe, expect, it } from "vitest";
import type { CatalogComponent, DesignSystemSummary } from "../api/client";
import { groupLibraryEntries, selectionForComponent, selectionForStory, selectionKey } from "./libraryModel";

const systems: DesignSystemSummary[] = [
  { id: "shadcn", name: "Shadcn", description: "", builtinCatalogHash: "one", components: [] },
  { id: "yandex-pay", name: "Yandex Pay Design System", description: "", builtinCatalogHash: "", components: [] },
];
const component = (designSystem: string, version: number): CatalogComponent => ({
  id: "shared", name: "Shared", designSystem, version, bundleUrl: "/bundle.js", bundleHash: "hash", atomicLevel: "atom", description: "", events: [], slots: [], hostAbiVersion: 1,
});

describe("library model", () => {
  it("groups each manifest entry by its design system and keeps empty registry systems", () => {
    const groups = groupLibraryEntries(systems, [], [component("shadcn", 1), component("yandex-pay", 2)]);
    expect(groups.map((group) => [group.system.id, group.components.map((entry) => entry.version)])).toEqual([
      ["shadcn", [1]], ["yandex-pay", [2]],
    ]);
    expect(groupLibraryEntries(systems, [], []).find((group) => group.system.id === "yandex-pay")?.components).toEqual([]);
  });

  it("uses a discriminated selection and the component/system pair as custom identity", () => {
    expect(selectionForStory({ id: "button", title: "Shadcn/Atoms/Button", name: "Default", type: "story" })).toEqual({ kind: "story", storyId: "button" });
    expect(selectionKey(selectionForComponent(component("shadcn", 1)))).not.toBe(selectionKey(selectionForComponent(component("yandex-pay", 2))));
  });
});
