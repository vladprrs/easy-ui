import { describe, expect, it } from "vitest";
import type { CatalogComponent, ComponentVersionSummary, DesignSystemSummary, VisualReference } from "../api/client";
import { componentLibraryStatus, groupLibraryEntries, matchesLibraryFilter, selectionForComponent, selectionForStory, selectionKey } from "./libraryModel";

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

const version = (v: number, status: ComponentVersionSummary["status"]): ComponentVersionSummary =>
  ({ version: v, rev: v, status, statusReason: null, supersededBy: null, statusRev: 1, designSystem: "shadcn", publishedAt: "now" });
const componentReference = (componentId: string, refVersion: number, runStatus: "pass" | "fail"): VisualReference =>
  ({ id: `ref-${componentId}-${refVersion}`, fingerprint: { scope: "component", componentId, refVersion }, note: null, createdAt: "now", lastRun: { runId: "r", referenceId: "ref", status: runStatus, createdAt: "now", diffPercent: 0 } });

describe("component library status", () => {
  it("maps published/rejected/blocked from the version history", () => {
    expect(componentLibraryStatus("c", 2, [version(1, "active"), version(2, "active")], [])).toMatchObject({ published: true, rejected: false, blocked: false });
    // Latest version rejected even though an older active version keeps it in the manifest.
    expect(componentLibraryStatus("c", 1, [version(1, "active"), version(2, "rejected")], [])).toMatchObject({ rejected: true, blocked: false });
    expect(componentLibraryStatus("c", 1, [version(1, "active"), version(2, "deprecated")], [])).toMatchObject({ blocked: true, rejected: false });
    expect(componentLibraryStatus("c", 1, [version(1, "staging")], [])).toMatchObject({ published: false, visualPending: false });
  });

  it("marks verified only on a passing run for the active version's component reference", () => {
    const versions = [version(2, "active")];
    expect(componentLibraryStatus("c", 2, versions, [componentReference("c", 2, "pass")])).toMatchObject({ verified: true, visualPending: false });
    expect(componentLibraryStatus("c", 2, versions, [componentReference("c", 2, "fail")])).toMatchObject({ verified: false, visualPending: true });
    // A passing run for a different version does not verify the active one.
    expect(componentLibraryStatus("c", 2, versions, [componentReference("c", 1, "pass")])).toMatchObject({ verified: false, visualPending: true });
    expect(componentLibraryStatus("c", 2, versions, [])).toMatchObject({ verified: false, visualPending: true });
  });

  it("matches each filter chip against its predicate", () => {
    const status = componentLibraryStatus("c", 2, [version(2, "active")], [componentReference("c", 2, "pass")]);
    expect(matchesLibraryFilter(status, "published")).toBe(true);
    expect(matchesLibraryFilter(status, "verified")).toBe(true);
    expect(matchesLibraryFilter(status, "visual-pending")).toBe(false);
    expect(matchesLibraryFilter(status, "blocked")).toBe(false);
    expect(matchesLibraryFilter(status, "rejected")).toBe(false);
  });
});
