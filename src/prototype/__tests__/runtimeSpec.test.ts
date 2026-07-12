import { describe, expect, it } from "vitest";
import type { PrototypeDoc } from "../schema";
import { EUI_KEY_PROP, splitCanvas, stripEvents, toRuntimeSpec } from "../runtimeSpec";

function specWith(props: Record<string, unknown>): PrototypeDoc["screens"][number]["spec"] {
  return { root: "text", elements: { text: { type: "Text", props } } };
}

type Spec = PrototypeDoc["screens"][number]["spec"];

describe("toRuntimeSpec RuntimeTree", () => {
  const spec: Spec = {
    root: "list",
    elements: {
      list: { type: "Cards", props: {}, repeat: { statePath: "/items", key: "id" }, children: ["card", "hs"] },
      card: { type: "MyCard", props: { title: { $item: "title" } }, on: { press: { action: "navigate", params: { screenId: "next" } } } },
      hs: { type: "Hotspot", props: { x: 0, y: 0, width: 10, height: 10 }, on: { press: { action: "back" } } },
    },
  };

  it("moves custom on into metadata, injects only a string __euiKey, and records repeatKey", () => {
    const { spec: runtime, metadata } = toRuntimeSpec(spec, { customTypes: new Set(["MyCard", "Cards"]) });
    // Custom element: on stripped from spec, __euiKey injected, raw on in metadata.
    expect(runtime.elements.card?.on).toBeUndefined();
    expect(runtime.elements.card?.props[EUI_KEY_PROP]).toBe("card");
    expect(typeof runtime.elements.card?.props[EUI_KEY_PROP]).toBe("string");
    expect(metadata.card?.on?.press).toEqual({ action: "navigate", params: { screenId: "next" } });
    expect(metadata.card?.repeatKey).toBe("id");
    // Builtin element (Hotspot): on stays in spec, no __euiKey.
    expect(runtime.elements.hs?.on).toEqual({ press: { action: "back" } });
    expect(runtime.elements.hs?.props[EUI_KEY_PROP]).toBeUndefined();
    // The raw $item binding survives unresolved into metadata's element props.
    expect(runtime.elements.card?.props.title).toEqual({ $item: "title" });
  });

  it("does not treat any type as custom without customTypes (legacy passthrough)", () => {
    const { spec: runtime, metadata } = toRuntimeSpec(spec);
    expect(runtime.elements.card?.on).toEqual({ press: { action: "navigate", params: { screenId: "next" } } });
    expect(runtime.elements.card?.props[EUI_KEY_PROP]).toBeUndefined();
    expect(metadata.card?.on).toBeUndefined();
  });

  it("stripEvents removes on from both spec and metadata", () => {
    const tree = toRuntimeSpec(spec, { customTypes: new Set(["MyCard", "Cards"]) });
    const inert = stripEvents(tree);
    expect(inert.spec.elements.hs?.on).toBeUndefined();
    expect(inert.metadata.card?.on).toBeUndefined();
  });

  it("splitCanvas removes Hotspots and rebuilds metadata consistently", () => {
    const tree = toRuntimeSpec(spec, { customTypes: new Set(["MyCard", "Cards"]) });
    const { content, hotspots } = splitCanvas(tree);
    expect(content?.spec.elements.hs).toBeUndefined();
    expect(content?.spec.elements.list?.children).toEqual(["card"]);
    expect(content?.metadata.card).toBeDefined();
    expect(content?.metadata.hs).toBeUndefined();
    expect(hotspots).toHaveLength(1);
    expect(hotspots[0]!.spec.root).toBe("hs");
  });
});

describe("toRuntimeSpec", () => {
  it("adapts exact $cond directives at any prop depth", () => {
    const spec = specWith({
      top: { $cond: { if: { $state: "/ready" }, then: false, else: 0 } },
      nested: { value: { $cond: { if: true, then: "yes", else: "no" } } },
      array: [{ $cond: { if: false, then: 1, else: 2 } }],
    });

    expect(toRuntimeSpec(spec).spec.elements.text?.props).toEqual({
      top: { $cond: { $state: "/ready" }, $then: false, $else: 0 },
      nested: { value: { $cond: true, $then: "yes", $else: "no" } },
      array: [{ $cond: false, $then: 1, $else: 2 }],
    });
  });

  it("does not mutate the document spec or enter literal branches", () => {
    const branch = { nested: { $cond: { if: true, then: "changed", else: "unchanged" } } };
    const spec = specWith({ value: { $cond: { if: true, then: branch, else: branch } } });
    const before = structuredClone(spec);

    const runtime = toRuntimeSpec(spec);

    expect(spec).toEqual(before);
    expect(runtime.spec.elements.text?.props.value).toEqual({ $cond: true, $then: branch, $else: branch });
  });

  it.each([
    { $cond: { if: true, then: 1, else: 2 }, other: 1 },
    { $cond: { if: true, then: 1 } },
    { $cond: { if: true, then: 1, else: 2, extra: 1 } },
    { $cond: true, $then: 1, $else: 2 },
    { $cond: [true, 1, 2] },
  ])("leaves a $cond lookalike untouched: %j", (lookalike) => {
    const runtime = toRuntimeSpec(specWith({ value: lookalike }));
    expect(runtime.spec.elements.text?.props.value).toBe(lookalike);
  });

  it("passes repeat through to the runtime spec unchanged", () => {
    const spec: PrototypeDoc["screens"][number]["spec"] = {
      root: "list",
      elements: {
        list: { type: "List", props: {}, repeat: { statePath: "/items", key: "id" }, children: ["item"] },
        item: { type: "Item", props: { label: { $item: "label" } } },
      },
    };
    const runtime = toRuntimeSpec(spec);
    expect(runtime.spec.elements.list?.repeat).toEqual({ statePath: "/items", key: "id" });
    expect(runtime.spec.elements.item?.props).toEqual({ label: { $item: "label" } });
  });

  it("resolves an $asset directive to its /api/assets URL", () => {
    const id = `asset_${"a".repeat(64)}`;
    const runtime = toRuntimeSpec(specWith({ src: { $asset: id }, nested: { icon: { $asset: id } } }));
    expect(runtime.spec.elements.text?.props).toEqual({ src: `/api/assets/${id}`, nested: { icon: `/api/assets/${id}` } });
  });

  it("leaves an $asset lookalike (extra keys) untouched", () => {
    const lookalike = { $asset: "asset_x", extra: 1 };
    expect(toRuntimeSpec(specWith({ value: lookalike })).spec.elements.text?.props.value).toEqual(lookalike);
  });

  it("preserves other directives", () => {
    const props = {
      state: { $state: "/name" },
      binding: { $bindState: "/name" },
      template: { $template: "Hello ${/name}" },
    };
    expect(toRuntimeSpec(specWith(props)).spec.elements.text?.props).toEqual(props);
  });

  it("builds a slotIndices map on a custom parent and strips the slot field from the spec", () => {
    const spec: PrototypeDoc["screens"][number]["spec"] = {
      root: "panel",
      elements: {
        panel: { type: "Panel", props: {}, children: ["h", "a", "b"] },
        h: { type: "Item", props: {}, slot: "header" },
        a: { type: "Item", props: {}, slot: "items" },
        b: { type: "Item", props: {} },
      },
    };
    const { spec: runtime, metadata } = toRuntimeSpec(spec, { customTypes: new Set(["Panel"]) });
    expect(metadata.panel?.slotIndices).toEqual({ header: [0], items: [1], default: [2] });
    // The side-channel is the only carrier of slot: the field never leaks into the runtime spec.
    expect((runtime.elements.h as { slot?: unknown }).slot).toBeUndefined();
    expect((runtime.elements.a as { slot?: unknown }).slot).toBeUndefined();
  });

  it("omits slotIndices when no child declares a slot", () => {
    const spec: PrototypeDoc["screens"][number]["spec"] = {
      root: "panel",
      elements: {
        panel: { type: "Panel", props: {}, children: ["a"] },
        a: { type: "Item", props: {} },
      },
    };
    const { metadata } = toRuntimeSpec(spec, { customTypes: new Set(["Panel"]) });
    expect(metadata.panel?.slotIndices).toBeUndefined();
  });

  it("propagates repeatKey through a named-slot parent to a slotted child (item context)", () => {
    const spec: PrototypeDoc["screens"][number]["spec"] = {
      root: "list",
      elements: {
        list: { type: "List", props: {}, repeat: { statePath: "/rows", key: "id" }, children: ["panel"] },
        panel: { type: "Panel", props: {}, children: ["cell"] },
        cell: { type: "Cell", props: {}, slot: "items", on: { tap: { action: "back" } } },
      },
    };
    const { metadata } = toRuntimeSpec(spec, { customTypes: new Set(["List", "Panel", "Cell"]) });
    // The repeat scope reaches a custom component nested inside a slot inside a repeat.
    expect(metadata.cell?.repeatKey).toBe("id");
    expect(metadata.panel?.slotIndices).toEqual({ items: [0] });
  });
});
