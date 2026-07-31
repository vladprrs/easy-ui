import { describe, expect, it } from "vitest";
import { COMPOSITION_TYPE, SLOT_TYPE } from "../../catalog/hostPrimitives/composition.definition";
import {
  compositionDocSchema,
  expandCompositions,
  type CompositionDoc,
  type CompositionDocV2,
} from "../composition";
import { inputPrototypeDocSchema, type PrototypeDoc } from "../schema";

const v2 = (value: Omit<CompositionDocV2, "version">): CompositionDoc =>
  compositionDocSchema.parse({ version: 2, ...value });

const pinned = (doc: CompositionDoc, version: number, designSystem = "test-ds") => ({
  doc,
  version,
  designSystem,
  status: "active",
});

function screenWithComposition(composition: string, children: Record<string, Record<string, unknown>> = {}): PrototypeDoc {
  return inputPrototypeDocSchema.parse({
    version: 1,
    id: "composition-v2-screen",
    name: "Composition v2 screen",
    designSystem: "test-ds",
    startScreen: "main",
    state: {},
    screens: [{
      id: "main",
      name: "Main",
      spec: {
        root: "screen",
        elements: {
          screen: { type: COMPOSITION_TYPE, props: { composition }, children: Object.keys(children) },
          ...children,
        },
      },
    }],
  }) as PrototypeDoc;
}

describe("composition v2 schema", () => {
  it("accepts the metadata required by v2 while keeping v1 nesting frozen", () => {
    const parsed = v2({
      name: "Payment row",
      atomicLevel: "molecule",
      scope: "section",
      canonicalFor: ["payment-row"],
      ownership: { reason: "The composition owns the row layout." },
      params: {},
      slots: [],
      spec: { root: "row", elements: { row: { type: "Box", props: {} } } },
    });
    expect(parsed.version).toBe(2);
    if (parsed.version === 2) expect(parsed.atomicLevel).toBe("molecule");

    const v1WithNested = {
      version: 1,
      name: "Legacy",
      params: {},
      slots: [],
      spec: {
        root: "root",
        elements: {
          root: { type: COMPOSITION_TYPE, props: { composition: "nested" } },
        },
      },
    };
    expect(compositionDocSchema.safeParse(v1WithNested).success).toBe(false);
  });
});

describe("composition v2 expansion", () => {
  it("expands nested params/defaults and routes a named slot through two levels", () => {
    const row = v2({
      name: "Payment row",
      atomicLevel: "molecule",
      params: { label: { type: "string", default: "Default label" } },
      slots: ["content"],
      spec: {
        root: "row-shell",
        elements: {
          "row-shell": { type: "Box", props: {}, children: ["label", "content-slot"] },
          label: { type: "Text", props: { text: { $param: "label" } } },
          "content-slot": { type: SLOT_TYPE, props: { name: "content" } },
        },
      },
    });
    const picker = v2({
      name: "Payment picker",
      atomicLevel: "organism",
      params: { title: { type: "string", default: "Default title" } },
      slots: ["body"],
      spec: {
        root: "picker",
        elements: {
          picker: { type: "Box", props: {}, children: ["row"] },
          row: {
            type: COMPOSITION_TYPE,
            props: { composition: "payment-row", params: { label: { $param: "title" } } },
            children: ["body-slot"],
          },
          "body-slot": { type: SLOT_TYPE, props: { name: "body" }, slot: "content" },
        },
      },
    });

    const body = { type: "Text", props: { text: "Body" }, slot: "body" };
    const result = expandCompositions(screenWithComposition("payment-picker", { body }), {
      compositions: {
        "payment-picker": pinned(picker, 11),
        "payment-row": pinned(row, 3),
      },
    });

    expect(result.issues).toEqual([]);
    const elements = result.doc.screens[0]!.spec.elements;
    expect(elements.screen).toBeUndefined();
    expect(elements.root).toBeUndefined();
    expect(elements["screen$picker"]!.children).toEqual(["screen$row$row-shell"]);
    expect(elements["screen$row$row-shell"]!.children).toEqual([
      "screen$row$label",
      "body",
    ]);
    expect(elements["screen$row$label"]!.props).toEqual({ text: "Default title" });
    expect((elements.body as { slot?: string }).slot).toBeUndefined();
    expect(result.expandedFrom["screen$row$label"]).toEqual({
      compositionId: "payment-row",
      hostKey: "screen$row",
      innerKey: "label",
      chain: [
        { compositionId: "payment-picker", version: 11, hostKey: "screen", innerKey: "row" },
        { compositionId: "payment-row", version: 3, hostKey: "screen$row", innerKey: "label" },
      ],
    });
  });

  it("reports a full versioned cycle path without recursing forever", () => {
    const a = v2({
      name: "A",
      atomicLevel: "organism",
      params: {},
      slots: [],
      spec: { root: "a", elements: {
        a: { type: "Box", props: {}, children: ["b"] },
        b: { type: COMPOSITION_TYPE, props: { composition: "cycle-b" } },
      } },
    });
    const b = v2({
      name: "B",
      atomicLevel: "molecule",
      params: {},
      slots: [],
      spec: { root: "b", elements: {
        b: { type: "Box", props: {}, children: ["a"] },
        a: { type: COMPOSITION_TYPE, props: { composition: "cycle-a" } },
      } },
    });

    const result = expandCompositions(screenWithComposition("cycle-a"), {
      compositions: {
        "cycle-a": pinned(a, 2),
        "cycle-b": pinned(b, 4),
      },
    });

    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "composition/cycle",
      message: "composition cycle detected: cycle-a@2 → cycle-b@4 → cycle-a@2",
    }));
    expect(Object.keys(result.doc.screens[0]!.spec.elements).length).toBeLessThan(20);
  });

  it("accepts depth five and rejects depth six", () => {
    const chain = (length: number) => Object.fromEntries(Array.from({ length }, (_, index) => {
      const id = `chain-${index + 1}`;
      const next = `chain-${index + 2}`;
      return [id, pinned(v2({
        name: id,
        atomicLevel: index === 0 ? "organism" : "molecule",
        params: {},
        slots: [],
        spec: {
          root: `root-${index + 1}`,
          elements: {
            [`root-${index + 1}`]: index + 1 === length
              ? { type: "Box", props: {} }
              : { type: COMPOSITION_TYPE, props: { composition: next } },
          },
        },
      }), index + 1)];
    }));

    expect(expandCompositions(screenWithComposition("chain-1"), { compositions: chain(5) }).issues).toEqual([]);
    expect(expandCompositions(screenWithComposition("chain-1"), { compositions: chain(6) }).issues).toContainEqual(
      expect.objectContaining({ code: "composition/depth" }),
    );
  });

  it("reports expanded element, tree-depth, and active design-system diagnostics", () => {
    const deepElements: Record<string, Record<string, unknown>> = {};
    for (let index = 0; index < 51; index += 1) {
      deepElements[`deep-${index}`] = {
        type: "Box",
        props: {},
        ...(index < 50 ? { children: [`deep-${index + 1}`] } : {}),
      };
    }
    const deep = v2({
      name: "Deep",
      atomicLevel: "template",
      params: {},
      slots: [],
      spec: { root: "deep-0", elements: deepElements as CompositionDocV2["spec"]["elements"] },
    });
    const manyElements: Record<string, Record<string, unknown>> = {
      host: { type: COMPOSITION_TYPE, props: { composition: "deep" } },
    };
    for (let index = 0; index < 501; index += 1) manyElements[`orphan-${index}`] = { type: "Box", props: {} };
    const large = inputPrototypeDocSchema.parse({
      version: 1,
      id: "large-composition-v2-screen",
      name: "Large",
      designSystem: "test-ds",
      startScreen: "main",
      state: {},
      screens: [{ id: "main", name: "Main", spec: { root: "host", elements: manyElements } }],
    }) as PrototypeDoc;

    const result = expandCompositions(large, {
      compositions: { deep: pinned(deep, 7, "other-ds") },
    });
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "composition/design-system" }),
      expect.objectContaining({ code: "composition/expanded-elements" }),
      expect.objectContaining({ code: "composition/tree-depth" }),
    ]));
  });
});
