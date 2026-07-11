import type { Spec } from "@json-render/core";
import { describe, expect, it } from "vitest";
import { stripSpecEvents } from "./stripSpecEvents";

describe("stripSpecEvents", () => {
  it("removes on from every element without mutating the runtime spec", () => {
    const spec: Spec = {
      root: "root",
      state: { count: 0 },
      elements: {
        root: { type: "MountEmitter", props: {}, children: ["child"], on: { mount: { action: "increment" } } },
        child: { type: "Text", props: { text: "Child" }, on: { press: [{ action: "navigate" }] } },
      },
    };
    const result = stripSpecEvents(spec);
    expect(result).not.toBe(spec);
    expect(result.state).toBe(spec.state);
    expect(result.elements.root).not.toHaveProperty("on");
    expect(result.elements.child).not.toHaveProperty("on");
    expect(spec.elements.root).toHaveProperty("on");
    // A component emitting `mount` has no binding to dispatch after stripping.
    expect(result.elements.root!.on?.mount).toBeUndefined();
  });

  it("returns the original reference when no events exist", () => {
    const spec: Spec = { root: "root", elements: { root: { type: "Text", props: {} } } };
    expect(stripSpecEvents(spec)).toBe(spec);
  });
});
