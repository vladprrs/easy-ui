import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ComponentDefinition } from "../catalog/definitions";
import {
  buildScreenArchitectureTree,
  flattenArchitectureNodes,
  getElementPath,
  issueElementKey,
  type ScreenSpec,
} from "./screenTree";

const definition = (extra: Partial<ComponentDefinition> & Record<string, unknown> = {}): ComponentDefinition => ({
  description: "test",
  props: z.object({
    title: z.string().default("Заголовок"),
    tone: z.enum(["neutral", "brand"]).default("neutral"),
    count: z.number().optional(),
  }),
  ...extra,
} as ComponentDefinition);

const spec: ScreenSpec = {
  root: "root",
  elements: {
    root: { type: "@eui/FlowRoot", props: {}, children: ["header", "body"] },
    header: { type: "YpNavBar", props: { title: "Оплата" }, region: "header" },
    body: { type: "YpBox", props: {}, children: ["card"] },
    card: { type: "YpCard", props: { title: "Заголовок", tone: "brand", count: 3, extra: 1 }, slot: "content" },
    lost: { type: "YpBox", props: {} },
  },
};

describe("buildScreenArchitectureTree", () => {
  it("walks children from the root, keeps depth/ancestors and puts unreachable elements in orphans", () => {
    const tree = buildScreenArchitectureTree({ spec });
    expect(flattenArchitectureNodes(tree.roots).map((node) => `${node.key}@${node.depth}`))
      .toEqual(["root@0", "header@1", "body@1", "card@2"]);
    expect(tree.orphans.map((node) => node.key)).toEqual(["lost"]);
    expect(tree.orphans[0]!.depth).toBe(0);
    expect(tree.byKey.get("card")!.ancestors).toEqual(["root", "body"]);
    expect(tree.byKey.get("root")!.children.map((node) => node.key)).toEqual(["header", "body"]);
  });

  it("terminates on cycles and visits every element once", () => {
    const tree = buildScreenArchitectureTree({
      root: "a",
      elements: { a: { type: "A", props: {}, children: ["b"] }, b: { type: "B", props: {}, children: ["a"] } },
    });
    expect(flattenArchitectureNodes(tree.roots).map((node) => node.key)).toEqual(["a", "b"]);
    expect(tree.orphans).toEqual([]);
  });

  it("carries authored region and slot markers", () => {
    const tree = buildScreenArchitectureTree({ spec });
    expect(tree.byKey.get("header")!.region).toBe("header");
    expect(tree.byKey.get("card")!.slot).toBe("content");
    expect(tree.byKey.get("body")!.region).toBeUndefined();
  });

  it("splits host primitives from custom components and marks unresolved types", () => {
    const tree = buildScreenArchitectureTree({ spec }, { definitions: { YpCard: definition() } });
    expect(tree.byKey.get("root")!.source).toBe("host");
    expect(tree.byKey.get("card")!.source).toBe("custom");
    expect(tree.byKey.get("card")!.unresolved).toBe(false);
    expect(tree.byKey.get("header")!.unresolved).toBe(true);
  });

  it("diffs only props that differ from the declared zod default", () => {
    const tree = buildScreenArchitectureTree({ spec }, { definitions: { YpCard: definition() } });
    const diff = tree.byKey.get("card")!.propsDiff;
    expect(diff.map((entry) => entry.name)).toEqual(["count", "extra", "tone"]);
    expect(diff.find((entry) => entry.name === "tone")).toMatchObject({ value: "brand", defaultValue: "neutral", hasDeclaredDefault: true, unknownProp: false });
    expect(diff.find((entry) => entry.name === "count")).toMatchObject({ hasDeclaredDefault: false, unknownProp: false });
    expect(diff.find((entry) => entry.name === "extra")!.unknownProp).toBe(true);
  });

  it("treats a prop deep-equal to its declared default as not a diff", () => {
    const shaped = definition({ props: z.object({ pad: z.object({ x: z.number(), y: z.number() }).default({ x: 1, y: 2 }) }) });
    const tree = buildScreenArchitectureTree({
      root: "r",
      elements: { r: { type: "Shaped", props: { pad: { x: 1, y: 2 } } } },
    }, { definitions: { Shaped: shaped } });
    expect(tree.byKey.get("r")!.propsDiff).toEqual([]);
  });

  it("reports every authored prop when the definition is missing", () => {
    const tree = buildScreenArchitectureTree({ spec });
    expect(tree.byKey.get("card")!.propsDiff.map((entry) => entry.name)).toEqual(["count", "extra", "title", "tone"]);
    expect(tree.byKey.get("card")!.propsDiff.every((entry) => !entry.unknownProp)).toBe(true);
  });

  it("takes atomicLevel from the definition and version/status/id from pins", () => {
    const tree = buildScreenArchitectureTree({ spec }, {
      definitions: { YpCard: definition({ atomicLevel: "molecule" }) },
      pins: [{ id: "cmp_card", name: "YpCard", version: 4, status: "deprecated" }],
    });
    const card = tree.byKey.get("card")!;
    expect(card).toMatchObject({ atomicLevel: "molecule", version: 4, status: "deprecated", componentId: "cmp_card" });
    expect(tree.byKey.get("body")!.version).toBeUndefined();
  });

  it("reads wave-2 metadata defensively and ignores malformed values", () => {
    const tree = buildScreenArchitectureTree({ spec }, {
      definitions: {
        YpCard: definition({ scope: "section", canonicalFor: ["ctyp-card"], sourceBounded: true, replacement: "YpCard2" }),
        YpBox: definition({ scope: "not-a-scope", canonicalFor: [1], sourceBounded: "yes" }),
      },
    });
    expect(tree.byKey.get("card")!).toMatchObject({ scope: "section", canonicalFor: ["ctyp-card"], sourceBounded: true, replacement: "YpCard2" });
    const box = tree.byKey.get("body")!;
    expect(box.scope).toBeUndefined();
    expect(box.canonicalFor).toBeUndefined();
    expect(box.sourceBounded).toBeUndefined();
  });

  it("attaches validation issues to their element by path", () => {
    const tree = buildScreenArchitectureTree({ spec }, {
      issues: {
        errors: [{ path: "/screens/0/spec/elements/card/props/title", message: "нет title" }],
        warnings: [
          { path: "/screens/0/spec/elements/card", message: "arch/monolith-root", code: "arch/monolith-root" },
          { path: "/screens/0/name", message: "не про элемент" },
        ],
      },
    });
    expect(tree.byKey.get("card")!.issues).toEqual([
      { path: "/screens/0/spec/elements/card/props/title", message: "нет title", severity: "error" },
      { path: "/screens/0/spec/elements/card", message: "arch/monolith-root", code: "arch/monolith-root", severity: "warning" },
    ]);
    expect(tree.byKey.get("body")!.issues).toEqual([]);
  });
});

describe("issueElementKey", () => {
  it("extracts the element key or null", () => {
    expect(issueElementKey("/screens/0/spec/elements/card/props/title")).toBe("card");
    expect(issueElementKey("/screens/0/spec/elements/card")).toBe("card");
    expect(issueElementKey("/screens/0/name")).toBeNull();
    expect(issueElementKey("/screens/0/spec/elements/")).toBeNull();
  });
});

describe("getElementPath", () => {
  it("returns the ancestor chain including the element and empty for unknown keys", () => {
    expect(getElementPath(spec, "card")).toEqual(["root", "body", "card"]);
    expect(getElementPath(spec, "lost")).toEqual(["lost"]);
    expect(getElementPath(spec, "ghost")).toEqual([]);
  });
});
