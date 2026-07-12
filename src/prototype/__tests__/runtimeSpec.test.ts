import { describe, expect, it } from "vitest";
import type { PrototypeDoc } from "../schema";
import { toRuntimeSpec } from "../runtimeSpec";

function specWith(props: Record<string, unknown>): PrototypeDoc["screens"][number]["spec"] {
  return { root: "text", elements: { text: { type: "Text", props } } };
}

describe("toRuntimeSpec", () => {
  it("adapts exact $cond directives at any prop depth", () => {
    const spec = specWith({
      top: { $cond: { if: { $state: "/ready" }, then: false, else: 0 } },
      nested: { value: { $cond: { if: true, then: "yes", else: "no" } } },
      array: [{ $cond: { if: false, then: 1, else: 2 } }],
    });

    expect(toRuntimeSpec(spec).elements.text?.props).toEqual({
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
    expect(runtime.elements.text?.props.value).toEqual({ $cond: true, $then: branch, $else: branch });
  });

  it.each([
    { $cond: { if: true, then: 1, else: 2 }, other: 1 },
    { $cond: { if: true, then: 1 } },
    { $cond: { if: true, then: 1, else: 2, extra: 1 } },
    { $cond: true, $then: 1, $else: 2 },
    { $cond: [true, 1, 2] },
  ])("leaves a $cond lookalike untouched: %j", (lookalike) => {
    const runtime = toRuntimeSpec(specWith({ value: lookalike }));
    expect(runtime.elements.text?.props.value).toBe(lookalike);
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
    expect(runtime.elements.list?.repeat).toEqual({ statePath: "/items", key: "id" });
    expect(runtime.elements.item?.props).toEqual({ label: { $item: "label" } });
  });

  it("preserves other directives", () => {
    const props = {
      state: { $state: "/name" },
      binding: { $bindState: "/name" },
      template: { $template: "Hello ${/name}" },
    };
    expect(toRuntimeSpec(specWith(props)).elements.text?.props).toEqual(props);
  });
});
