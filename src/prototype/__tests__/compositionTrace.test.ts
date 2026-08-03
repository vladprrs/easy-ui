import { describe, expect, it } from "vitest";
import { COMPOSITION_TYPE, SLOT_TYPE } from "../../catalog/hostPrimitives/composition.definition";
import {
  createCompositionTrace, compositionDocSchema, expandCompositions,
  type CompositionCatalogEntry, type CompositionDoc,
} from "../composition";
import { inputPrototypeDocSchema, type PrototypeDoc } from "../schema";

/**
 * Trace-коллектор раскрытия (план 2026-08-03 §5 W8g).
 *
 * Два инварианта: события отражают **фактическое** раскрытие (те же ветки/case'ы/клоны,
 * что попали в дерево), и раскрытие **без** коллектора идентично — трасса аддитивна.
 */

const composition = compositionDocSchema.parse({
  version: 3,
  name: "Traced",
  atomicLevel: "organism",
  params: {
    tone: { type: "enum", values: ["brand", "muted"], default: "brand" },
    items: { type: "array", items: { type: "object", schema: { text: { type: "string", required: true } } }, maxItems: 5, default: [] },
    "with-hint": { type: "boolean", default: true },
  },
  slots: { footer: { required: true } },
  spec: {
    root: "shell",
    elements: {
      shell: {
        type: "Box",
        props: { tone: { $switch: { param: "tone", cases: { brand: "accent", muted: "grey" } } } },
        layout: { flow: { kind: "flex", direction: "vertical" }, gap: "sm" },
        children: ["hint", "row", "footer-slot"],
      },
      hint: { type: "Text", props: { text: "Hint" }, when: { param: "with-hint", eq: true } },
      row: { type: "Text", props: { text: { $item: "text" } }, repeatParam: { param: "items" } },
      "footer-slot": { type: SLOT_TYPE, props: { name: "footer" } },
    },
  },
}) satisfies CompositionDoc;

const pinned: Record<string, CompositionCatalogEntry> = {
  traced: { doc: composition, version: 3, designSystem: "test-ds", status: "active" },
};

const screen = (params: Record<string, unknown>): PrototypeDoc => inputPrototypeDocSchema.parse({
  version: 1, id: "traced", name: "Traced", designSystem: "test-ds", startScreen: "main", state: {},
  screens: [{
    id: "main", name: "Main",
    spec: {
      root: "host",
      elements: {
        host: { type: COMPOSITION_TYPE, props: { composition: "traced", params }, children: ["footer"] },
        footer: { type: "Text", props: { text: "Footer" }, slot: "footer" },
      },
    },
  }],
}) as PrototypeDoc;

describe("composition expansion trace (W8g)", () => {
  it("records the decisions the expanded tree actually shows", () => {
    const { trace, log } = createCompositionTrace();
    const doc = screen({ tone: "muted", "with-hint": false, items: [{ text: "One" }, { text: "Two" }] });
    const expanded = expandCompositions(doc, { compositions: pinned, trace });

    expect(expanded.issues).toEqual([]);
    expect(log.params).toEqual([{
      compositionId: "traced", version: 3, hostKey: "host",
      params: { tone: "muted", items: [{ text: "One" }, { text: "Two" }], "with-hint": false },
    }]);
    expect(log.branches).toEqual([{
      compositionId: "traced", version: 3, hostKey: "host",
      elementKey: "host$hint", innerKey: "hint", when: { param: "with-hint", eq: true }, taken: false,
    }]);
    expect(log.switches).toEqual([{
      compositionId: "traced", version: 3, hostKey: "host",
      elementKey: "host$shell", innerKey: "shell", prop: "tone", param: "tone", case: "muted",
    }]);
    expect(log.repeats).toEqual([{
      compositionId: "traced", version: 3, hostKey: "host",
      elementKey: "host$row", innerKey: "row", param: "items", count: 2,
    }]);
    expect(log.slots).toEqual([{
      compositionId: "traced", version: 3, hostKey: "host",
      slot: "footer", required: true, filled: true, fallbackUsed: false, children: ["footer"],
    }]);
    expect(log.layouts).toEqual([{
      compositionId: "traced", version: 3, hostKey: "host",
      elementKey: "host$shell", innerKey: "shell", type: "Box",
      props: { direction: "vertical", gap: "sm" },
    }]);

    // Трасса согласована с деревом: снятая ветка отсутствует, клоны на месте.
    const elements = expanded.doc.screens[0]!.spec.elements;
    expect(Object.keys(elements).sort()).toEqual(["footer", "host$row__r0", "host$row__r1", "host$shell"]);
    expect(elements["host$shell"]!.props.tone).toBe("grey");
  });

  it("is additive: expansion without a collector produces the identical result", () => {
    const params = { tone: "brand", items: [{ text: "One" }] };
    const withTrace = expandCompositions(screen(params), { compositions: pinned, trace: createCompositionTrace().trace });
    const without = expandCompositions(screen(params), { compositions: pinned });
    expect(JSON.stringify(withTrace.doc)).toBe(JSON.stringify(without.doc));
    expect(withTrace.issues).toEqual(without.issues);
    expect(withTrace.expandedFrom).toEqual(without.expandedFrom);
  });
});
