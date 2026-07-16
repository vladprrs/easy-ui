import { describe, expect, it } from "vitest";
import type { PrototypeDoc } from "../schema";
import { EUI_KEY_PROP, splitCanvas, splitHostPrimitives, stripEvents, toRuntimeSpec } from "../runtimeSpec";

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

  it("keeps authored events in metadata, injects a string __euiKey for builtin and custom elements, and records custom repeatKey", () => {
    const { spec: runtime, metadata } = toRuntimeSpec(spec, { customTypes: new Set(["MyCard", "Cards"]) });
    // Custom element: on stripped from spec, __euiKey injected, raw on in metadata.
    expect(runtime.elements.card?.on).toBeUndefined();
    expect(runtime.elements.card?.props[EUI_KEY_PROP]).toBe("card");
    expect(typeof runtime.elements.card?.props[EUI_KEY_PROP]).toBe("string");
    expect(metadata.card?.on?.press).toEqual({ action: "navigate", params: { screenId: "next" } });
    expect(metadata.card?.repeatKey).toBe("id");
    // Builtin element (Hotspot): on stays in spec and is also available as metadata.
    expect(runtime.elements.hs?.on).toEqual({ press: { action: "back" } });
    expect(runtime.elements.hs?.props[EUI_KEY_PROP]).toBe("hs");
    expect(metadata.hs?.on?.press).toEqual({ action: "back" });
    // The raw $item binding survives unresolved into metadata's element props.
    expect(runtime.elements.card?.props.title).toEqual({ $item: "title" });
  });

  it("keeps elements native without customTypes while still producing runtime markers and metadata", () => {
    const { spec: runtime, metadata } = toRuntimeSpec(spec);
    expect(runtime.elements.card?.on).toEqual({ press: { action: "navigate", params: { screenId: "next" } } });
    expect(runtime.elements.card?.props[EUI_KEY_PROP]).toBe("card");
    expect(metadata.card?.on?.press).toEqual({ action: "navigate", params: { screenId: "next" } });
  });

  it("stripEvents removes on from both spec and metadata", () => {
    const tree = toRuntimeSpec(spec, { customTypes: new Set(["MyCard", "Cards"]) });
    const inert = stripEvents(tree);
    expect(inert.spec.elements.hs?.on).toBeUndefined();
    expect(inert.metadata.card?.on).toBeUndefined();
    expect(inert.metadata.hs?.on).toBeUndefined();
    expect(inert.spec.elements.hs?.props[EUI_KEY_PROP]).toBe("hs");
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

  it("splitHostPrimitives recursively extracts Overlay descendants with metadata markers", () => {
    const authored: Spec = {
      root: "root",
      elements: {
        root: { type: "Stack", props: {}, children: ["body", "overlay"] },
        body: { type: "Text", props: { text: "Body" } },
        overlay: { type: "Overlay", props: { placement: "top" }, children: ["panel"] },
        panel: { type: "Stack", props: {}, children: ["label"] },
        label: { type: "Text", props: { text: "Notice" } },
      },
    };
    const tree = toRuntimeSpec(authored);
    const { content, hostPrimitives } = splitHostPrimitives(tree);
    expect(content?.spec.elements.root?.children).toEqual(["body"]);
    expect(content?.spec.elements.overlay).toBeUndefined();
    expect(content?.metadata.label).toBeUndefined();
    expect(hostPrimitives).toHaveLength(1);
    expect(Object.keys(hostPrimitives[0]!.spec.elements)).toEqual(["overlay", "panel", "label"]);
    expect(hostPrimitives[0]!.metadata.label?.type).toBe("Text");
    expect(hostPrimitives[0]!.spec.elements.label?.props[EUI_KEY_PROP]).toBe("label");
  });

  it("applies host splitting before canvas splitting without losing Hotspot trees", () => {
    const authored: Spec = {
      root: "root",
      elements: {
        root: { type: "Stack", props: {}, children: ["hotspot", "overlay"] },
        hotspot: { type: "Hotspot", props: { x: 0, y: 0, width: 10, height: 10, ariaLabel: "Area" } },
        overlay: { type: "Overlay", props: { placement: "center" }, children: ["label"] },
        label: { type: "Text", props: { text: "Notice" } },
      },
    };
    const hostSplit = splitHostPrimitives(toRuntimeSpec(authored));
    const canvasSplit = splitCanvas(hostSplit.content!);
    expect(canvasSplit.content?.spec.elements.root?.children).toEqual([]);
    expect(canvasSplit.hotspots[0]!.metadata.hotspot).toBeDefined();
    expect(hostSplit.hostPrimitives[0]!.metadata.label).toBeDefined();
  });

  it("extracts only Overlay and leaves host Image and Hotspot in ordinary flow content", () => {
    const authored: Spec = {
      root: "root",
      elements: {
        root: { type: "Stack", props: {}, children: ["image", "hotspot", "overlay"] },
        image: { type: "Image", props: { src: "/images/hero.png", alt: "Hero" } },
        hotspot: { type: "Hotspot", props: { x: 0, y: 0, width: 20, height: 20, ariaLabel: "Open" } },
        overlay: { type: "Overlay", props: { placement: "center" } },
      },
    };

    const split = splitHostPrimitives(toRuntimeSpec(authored));
    expect(split.content?.spec.elements.root?.children).toEqual(["image", "hotspot"]);
    expect(split.content?.spec.elements.image).toBeDefined();
    expect(split.content?.spec.elements.hotspot).toBeDefined();
    expect(split.hostPrimitives.map((item) => item.spec.root)).toEqual(["overlay"]);
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
      [EUI_KEY_PROP]: "text",
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
    expect(runtime.spec.elements.item?.props).toEqual({ label: { $item: "label" }, [EUI_KEY_PROP]: "item" });
  });

  it("resolves an $asset directive to its /api/assets URL", () => {
    const id = `asset_${"a".repeat(64)}`;
    const runtime = toRuntimeSpec(specWith({ src: { $asset: id }, nested: { icon: { $asset: id } } }));
    expect(runtime.spec.elements.text?.props).toEqual({ src: `/api/assets/${id}`, nested: { icon: `/api/assets/${id}` }, [EUI_KEY_PROP]: "text" });
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
    expect(toRuntimeSpec(specWith(props)).spec.elements.text?.props).toEqual({ ...props, [EUI_KEY_PROP]: "text" });
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
