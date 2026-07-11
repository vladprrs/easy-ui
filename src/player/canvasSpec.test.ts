import type { Spec } from "@json-render/core";
import { describe, expect, it } from "vitest";
import { splitCanvasSpec } from "./canvasSpec";

describe("splitCanvasSpec", () => {
  it("removes hotspots from content and returns them separately", () => {
    const spec = {
      root: "content",
      elements: {
        content: { type: "Card", props: {}, children: ["copy", "hotspot"] },
        copy: { type: "Text", props: { text: "Copy" } },
        hotspot: { type: "Hotspot", props: {} },
      },
    } as Spec;

    const result = splitCanvasSpec(spec);

    expect(result.content?.elements.content.children).toEqual(["copy"]);
    expect(result.content?.elements.hotspot).toBeUndefined();
    expect(result.hotspots).toEqual([{ root: "hotspot", elements: { hotspot: spec.elements.hotspot } }]);
  });

  it("returns null content when the root is a hotspot", () => {
    const spec = { root: "hotspot", elements: { hotspot: { type: "Hotspot", props: {} } } } as Spec;
    expect(splitCanvasSpec(spec).content).toBeNull();
  });
});
