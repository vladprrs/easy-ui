import { describe, expect, it } from "vitest";
import { COMPOSITION_TYPE, SLOT_TYPE } from "../../catalog/hostPrimitives/composition.definition";
import {
  COMPOSITION_PARAMS_LIMIT, compositionDocSchema, expandCompositions,
  type CompositionCatalogEntry, type CompositionDoc,
} from "../composition";
import { paramValueMatches, type CompositionParamV3 } from "../compositionV3/params";
import { variantDimensionsOf } from "../compositionV3/variants";
import { inputPrototypeDocSchema, type PrototypeDoc } from "../schema";

/**
 * Композиции v3 (план 2026-08-03 §5 W8a): типизированные параметры и параметрические условия.
 * Граница D7 — всё разрешается от значений параметров в точке ссылки, на этапе раскрытия.
 */

const doc = (value: Record<string, unknown>): unknown => ({
  version: 3, name: "V3", atomicLevel: "molecule", slots: [], ...value,
});

const parse = (value: Record<string, unknown>) => compositionDocSchema.safeParse(doc(value));
const parsed = (value: Record<string, unknown>): CompositionDoc => compositionDocSchema.parse(doc(value));

const pinned = (composition: CompositionDoc, version = 1): CompositionCatalogEntry =>
  ({ doc: composition, version, designSystem: "test-ds", status: "active" });

function screen(compositionId: string, params: Record<string, unknown> = {}, children: Record<string, Record<string, unknown>> = {}): PrototypeDoc {
  return inputPrototypeDocSchema.parse({
    version: 1, id: "v3-screen", name: "V3 screen", designSystem: "test-ds", startScreen: "main", state: {},
    screens: [{
      id: "main", name: "Main",
      spec: {
        root: "screen",
        elements: {
          screen: { type: COMPOSITION_TYPE, props: { composition: compositionId, params }, children: Object.keys(children) },
          ...children,
        },
      },
    }],
  }) as PrototypeDoc;
}

const boxRoot = { root: "row", elements: { row: { type: "Box", props: {} } } };

describe("composition v3 schema — typed params", () => {
  it("accepts enum, object and array declarations", () => {
    const result = parse({
      params: {
        tone: { type: "enum", values: ["brand", "muted"], default: "brand" },
        header: { type: "object", schema: { title: { type: "string", required: true }, badge: { type: "string" } } },
        items: { type: "array", items: { type: "object", schema: { text: { type: "string", required: true } } }, maxItems: 10, default: [] },
        legacy: { type: "string", required: true },
      },
      spec: boxRoot,
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.version === 3) expect(result.data.params.tone!.type).toBe("enum");
  });

  it("rejects malformed declarations and defaults that do not match their type", () => {
    const cases: Record<string, unknown> = {
      "empty enum": { type: "enum", values: [] },
      "duplicate enum values": { type: "enum", values: ["a", "a"] },
      "enum default outside values": { type: "enum", values: ["a"], default: "b" },
      "object without fields": { type: "object", schema: {} },
      "object with a nested schema": { type: "object", schema: { nested: { type: "object" } } },
      "object default missing a required field": { type: "object", schema: { title: { type: "string", required: true } }, default: {} },
      "array without maxItems": { type: "array", items: { type: "string" } },
      "array over the maxItems ceiling": { type: "array", items: { type: "string" }, maxItems: 51 },
      "array default over maxItems": { type: "array", items: { type: "string" }, maxItems: 1, default: ["a", "b"] },
      "unknown type": { type: "record" },
    };
    for (const [label, param] of Object.entries(cases)) {
      expect(parse({ params: { p: param }, spec: boxRoot }).success, label).toBe(false);
    }
  });

  it("counts typed params against COMPOSITION_PARAMS_LIMIT", () => {
    const params = Object.fromEntries(Array.from({ length: COMPOSITION_PARAMS_LIMIT + 1 }, (_, index) => [
      `p-${index}`, { type: "enum", values: ["a"] },
    ]));
    expect(parse({ params, spec: boxRoot }).success).toBe(false);
  });

  it("matches values against typed declarations", () => {
    const enumParam: CompositionParamV3 = { type: "enum", values: ["a", "b"] };
    expect(paramValueMatches(enumParam, "a")).toBe(true);
    expect(paramValueMatches(enumParam, "c")).toBe(false);
    expect(paramValueMatches(enumParam, 1)).toBe(false);

    const objectParam: CompositionParamV3 = { type: "object", schema: { title: { type: "string", required: true }, count: { type: "number" } } };
    expect(paramValueMatches(objectParam, { title: "x" })).toBe(true);
    expect(paramValueMatches(objectParam, { title: "x", count: 2 })).toBe(true);
    expect(paramValueMatches(objectParam, { count: 2 })).toBe(false);
    expect(paramValueMatches(objectParam, { title: "x", extra: 1 })).toBe(false);
    expect(paramValueMatches(objectParam, { title: 1 })).toBe(false);

    const arrayParam: CompositionParamV3 = { type: "array", items: { type: "string" }, maxItems: 2 };
    expect(paramValueMatches(arrayParam, ["a"])).toBe(true);
    expect(paramValueMatches(arrayParam, ["a", "b", "c"])).toBe(false);
    expect(paramValueMatches(arrayParam, [1])).toBe(false);
    expect(paramValueMatches(arrayParam, "a")).toBe(false);
  });

  it("reports a typed mismatch at the reference point", () => {
    const composition = parsed({
      params: { tone: { type: "enum", values: ["brand", "muted"], required: true } },
      spec: boxRoot,
    });
    const result = expandCompositions(screen("tone", { tone: "loud" }), { compositions: { tone: pinned(composition) } });
    expect(result.issues).toEqual([{
      path: "/screens/0/spec/elements/screen/props/params/tone",
      message: "composition param tone must be of type enum",
    }]);
  });
});

describe("composition v3 — element.when", () => {
  const composition = (extra: Record<string, unknown> = {}) => parsed({
    params: { mode: { type: "enum", values: ["short", "full"], default: "short" } },
    spec: {
      root: "row",
      elements: {
        row: { type: "Box", props: {}, children: ["always", "detail"] },
        always: { type: "Text", props: { text: "always" } },
        detail: { type: "Box", props: {}, children: ["deep"], when: { param: "mode", eq: "full" } },
        deep: { type: "Text", props: { text: "deep" } },
        ...extra,
      },
    },
  });

  it("materializes the gated subtree when the condition holds", () => {
    const result = expandCompositions(screen("row", { mode: "full" }), { compositions: { row: pinned(composition()) } });
    expect(result.issues).toEqual([]);
    const elements = result.doc.screens[0]!.spec.elements;
    expect(elements["screen$row"]!.children).toEqual(["screen$always", "screen$detail"]);
    expect(elements["screen$detail"]!.children).toEqual(["screen$deep"]);
    // `when` — авторская конструкция композиции: раскрытый элемент её не несёт.
    expect(elements["screen$detail"]).not.toHaveProperty("when");
  });

  it("drops the element and its whole subtree when the condition is false", () => {
    const result = expandCompositions(screen("row", { mode: "short" }), { compositions: { row: pinned(composition()) } });
    expect(result.issues).toEqual([]);
    const elements = result.doc.screens[0]!.spec.elements;
    expect(elements["screen$row"]!.children).toEqual(["screen$always"]);
    expect(elements["screen$detail"]).toBeUndefined();
    expect(elements["screen$deep"]).toBeUndefined();
  });

  it("supports neq and in, and treats an unset optional param as unequal to every value", () => {
    const optional = parsed({
      params: { tone: { type: "string" } },
      spec: {
        root: "row",
        elements: {
          row: { type: "Box", props: {}, children: ["eq", "neq", "in"] },
          eq: { type: "Text", props: {}, when: { param: "tone", eq: "brand" } },
          neq: { type: "Text", props: {}, when: { param: "tone", neq: "brand" } },
          in: { type: "Text", props: {}, when: { param: "tone", in: ["brand", "muted"] } },
        },
      },
    });
    const unset = expandCompositions(screen("row"), { compositions: { row: pinned(optional) } });
    expect(unset.doc.screens[0]!.spec.elements["screen$row"]!.children).toEqual(["screen$neq"]);

    const given = expandCompositions(screen("row", { tone: "muted" }), { compositions: { row: pinned(optional) } });
    expect(given.doc.screens[0]!.spec.elements["screen$row"]!.children).toEqual(["screen$neq", "screen$in"]);
  });

  it("rejects when on the root, on an undeclared param, outside an enum, or over a slot", () => {
    expect(parse({ params: {}, spec: { root: "row", elements: { row: { type: "Box", props: {}, when: { param: "x", eq: 1 } } } } }).success).toBe(false);

    expect(parse({
      params: {},
      spec: { root: "row", elements: { row: { type: "Box", props: {}, children: ["a"] }, a: { type: "Text", props: {}, when: { param: "missing", eq: 1 } } } },
    }).success).toBe(false);

    expect(parse({
      params: { mode: { type: "enum", values: ["short"] } },
      spec: { root: "row", elements: { row: { type: "Box", props: {}, children: ["a"] }, a: { type: "Text", props: {}, when: { param: "mode", eq: "full" } } } },
    }).success).toBe(false);

    expect(parse({
      params: { mode: { type: "boolean" } },
      spec: { root: "row", elements: { row: { type: "Box", props: {}, children: ["a"] }, a: { type: "Text", props: {}, when: { param: "mode", eq: true, neq: false } } } },
    }).success).toBe(false);

    // Слоты — контракт с точкой ссылки; условная материализация слотов въезжает в W8c.
    expect(parse({
      params: { mode: { type: "boolean" } },
      slots: ["body"],
      spec: {
        root: "row",
        elements: {
          row: { type: "Box", props: {}, children: ["wrap"] },
          wrap: { type: "Box", props: {}, children: ["body-slot"], when: { param: "mode", eq: true } },
          "body-slot": { type: SLOT_TYPE, props: { name: "body" } },
        },
      },
    }).success).toBe(false);
  });
});

describe("composition v3 — $switch in props", () => {
  it("substitutes the matching case and falls back to default", () => {
    const composition = parsed({
      params: { size: { type: "string", default: "m" } },
      spec: {
        root: "row",
        elements: {
          row: { type: "Box", props: { pad: { $switch: { param: "size", cases: { s: 4, m: 8 }, default: 16 } } } },
        },
      },
    });
    const compositions = { row: pinned(composition) };
    expect(expandCompositions(screen("row", { size: "s" }), { compositions }).doc.screens[0]!.spec.elements["screen$row"]!.props).toEqual({ pad: 4 });
    expect(expandCompositions(screen("row"), { compositions }).doc.screens[0]!.spec.elements["screen$row"]!.props).toEqual({ pad: 8 });
    expect(expandCompositions(screen("row", { size: "xl" }), { compositions }).doc.screens[0]!.spec.elements["screen$row"]!.props).toEqual({ pad: 16 });
  });

  it("reports a missing case without a default as an expansion issue", () => {
    const composition = parsed({
      params: { size: { type: "string", required: true } },
      spec: { root: "row", elements: { row: { type: "Box", props: { pad: { $switch: { param: "size", cases: { s: 4 } } } } } } },
    });
    const result = expandCompositions(screen("row", { size: "xl" }), { compositions: { row: pinned(composition) } });
    expect(result.issues).toEqual([expect.objectContaining({
      code: "composition/switch-unresolved",
      message: 'composition row: $switch on param "size" has no case for "xl" and no default at row/pad',
    })]);
    // Ключ с нерешённым `$switch` в дерево не попадает — значения-полуфабриката не остаётся.
    expect(result.doc.screens[0]!.spec.elements["screen$row"]!.props).toEqual({});
  });

  it("resolves nested $param inside the chosen case", () => {
    const composition = parsed({
      params: { mode: { type: "string", default: "a" }, label: { type: "string", default: "Label" } },
      spec: { root: "row", elements: { row: { type: "Box", props: { text: { $switch: { param: "mode", cases: { a: { $param: "label" } }, default: "none" } } } } } },
    });
    const result = expandCompositions(screen("row", { mode: "a", label: "Given" }), { compositions: { row: pinned(composition) } });
    expect(result.doc.screens[0]!.spec.elements["screen$row"]!.props).toEqual({ text: "Given" });
  });

  it("requires exhaustive cases (or a default) for enum and boolean params at authoring time", () => {
    const enumSpec = (cases: Record<string, unknown>, withDefault = false) => parse({
      params: { tone: { type: "enum", values: ["brand", "muted"] } },
      spec: { root: "row", elements: { row: { type: "Box", props: { tone: { $switch: { param: "tone", cases, ...(withDefault ? { default: "x" } : {}) } } } } } },
    });
    expect(enumSpec({ brand: "a", muted: "b" }).success).toBe(true);
    expect(enumSpec({ brand: "a" }).success).toBe(false);
    expect(enumSpec({ brand: "a" }, true).success).toBe(true);
    expect(enumSpec({ brand: "a", muted: "b", loud: "c" }).success).toBe(false);

    expect(parse({
      params: { on: { type: "boolean" } },
      spec: { root: "row", elements: { row: { type: "Box", props: { pad: { $switch: { param: "on", cases: { true: 1 } } } } } } },
    }).success).toBe(false);
  });

  it("rejects an undeclared param and a malformed directive", () => {
    expect(parse({
      params: {},
      spec: { root: "row", elements: { row: { type: "Box", props: { pad: { $switch: { param: "missing", cases: { a: 1 } } } } } } },
    }).success).toBe(false);
    expect(parse({
      params: { size: { type: "string" } },
      spec: { root: "row", elements: { row: { type: "Box", props: { pad: { $switch: { param: "size" } } } } } },
    }).success).toBe(false);
  });

  it("leaves a literal $switch value untouched in a v2 body", () => {
    const v2 = compositionDocSchema.parse({
      version: 2, name: "Legacy", atomicLevel: "molecule", params: {}, slots: [],
      spec: { root: "row", elements: { row: { type: "Box", props: { pad: { $switch: { param: "size", cases: { s: 4 } } } } } } },
    });
    const result = expandCompositions(screen("row"), { compositions: { row: pinned(v2) } });
    expect(result.issues).toEqual([]);
    expect(result.doc.screens[0]!.spec.elements["screen$row"]!.props).toEqual({ pad: { $switch: { param: "size", cases: { s: 4 } } } });
  });
});

describe("composition v3 — nesting with v2", () => {
  const leafV3 = parsed({
    params: { tone: { type: "enum", values: ["brand", "muted"], default: "brand" } },
    spec: {
      root: "leaf",
      elements: {
        leaf: { type: "Box", props: { tone: { $switch: { param: "tone", cases: { brand: "accent", muted: "grey" } } } }, children: ["extra"] },
        extra: { type: "Text", props: { text: "muted" }, when: { param: "tone", eq: "muted" } },
      },
    },
  });

  it("expands v3 nested inside v2", () => {
    const host = compositionDocSchema.parse({
      version: 2, name: "Host", atomicLevel: "organism", params: {}, slots: [],
      spec: { root: "host", elements: {
        host: { type: "Box", props: {}, children: ["leaf"] },
        leaf: { type: COMPOSITION_TYPE, props: { composition: "leaf-v3", params: { tone: "muted" } } },
      } },
    });
    const result = expandCompositions(screen("host"), {
      compositions: { host: pinned(host, 2), "leaf-v3": pinned(leafV3, 5) },
    });
    expect(result.issues).toEqual([]);
    const elements = result.doc.screens[0]!.spec.elements;
    expect(elements["screen$leaf$leaf"]!.props).toEqual({ tone: "grey" });
    expect(elements["screen$leaf$extra"]!.props).toEqual({ text: "muted" });
    expect(result.expandedFrom["screen$leaf$leaf"]!.chain).toHaveLength(2);
  });

  it("expands v2 nested inside v3, including a v3-gated nested reference", () => {
    const leafV2 = compositionDocSchema.parse({
      version: 2, name: "Leaf v2", atomicLevel: "molecule", params: { label: { type: "string", default: "leaf" } }, slots: [],
      spec: { root: "leaf", elements: { leaf: { type: "Text", props: { text: { $param: "label" } } } } },
    });
    const host = parsed({
      atomicLevel: "organism",
      params: { "with-leaf": { type: "boolean", default: true } },
      spec: { root: "host", elements: {
        host: { type: "Box", props: {}, children: ["leaf"] },
        leaf: { type: COMPOSITION_TYPE, props: { composition: "leaf-v2", params: { label: "given" } }, when: { param: "with-leaf", eq: true } },
      } },
    });
    const compositions = { host: pinned(host, 1), "leaf-v2": pinned(leafV2, 4) };

    const on = expandCompositions(screen("host", { "with-leaf": true }), { compositions });
    expect(on.issues).toEqual([]);
    expect(on.doc.screens[0]!.spec.elements["screen$leaf$leaf"]!.props).toEqual({ text: "given" });

    // Ложное условие снимает саму ссылку — вложенная композиция не раскрывается вовсе.
    const off = expandCompositions(screen("host", { "with-leaf": false }), { compositions });
    expect(off.issues).toEqual([]);
    expect(off.doc.screens[0]!.spec.elements["screen$host"]!.children).toBeUndefined();
    expect(Object.keys(off.expandedFrom)).toEqual(["screen$host"]);
  });
});

describe("composition v3 — repeatParam (W8b)", () => {
  const scalarList = (extra: Record<string, unknown> = {}) => parsed({
    params: { items: { type: "array", items: { type: "string" }, maxItems: 10, default: [] } },
    spec: {
      root: "row",
      elements: {
        row: { type: "Box", props: {}, children: ["item"] },
        item: { type: "Text", props: { text: { $item: true }, order: { $index: true } }, repeatParam: { param: "items" }, ...extra },
      },
    },
  });

  it("clones the element per array item and substitutes $item/$index", () => {
    const result = expandCompositions(screen("list", { items: ["a", "b"] }), { compositions: { list: pinned(scalarList()) } });
    expect(result.issues).toEqual([]);
    const elements = result.doc.screens[0]!.spec.elements;
    expect(elements["screen$row"]!.children).toEqual(["screen$item__r0", "screen$item__r1"]);
    expect(elements["screen$item__r0"]!.props).toEqual({ text: "a", order: 0 });
    expect(elements["screen$item__r1"]!.props).toEqual({ text: "b", order: 1 });
    // Авторская директива не доезжает до раскрытого документа.
    expect(elements["screen$item__r0"]).not.toHaveProperty("repeatParam");
    expect(elements["screen$item"]).toBeUndefined();
  });

  it("expands an empty array to no elements at all", () => {
    const result = expandCompositions(screen("list", { items: [] }), { compositions: { list: pinned(scalarList()) } });
    expect(result.issues).toEqual([]);
    expect(result.doc.screens[0]!.spec.elements["screen$row"]!.children).toBeUndefined();
  });

  it("clones the whole subtree and keys it by the declared item field", () => {
    const composition = parsed({
      params: {
        rows: {
          type: "array",
          items: { type: "object", schema: { id: { type: "string", required: true }, title: { type: "string" } } },
          maxItems: 10,
        },
      },
      spec: {
        root: "list",
        elements: {
          list: { type: "Box", props: {}, children: ["row"] },
          row: { type: "Box", props: {}, children: ["title"], repeatParam: { param: "rows", key: "id" } },
          title: { type: "Text", props: { text: { $item: "title" } } },
        },
      },
    });
    const result = expandCompositions(
      screen("rows", { rows: [{ id: "first", title: "One" }, { id: "second/two", title: "Two" }] }),
      { compositions: { rows: pinned(composition) } },
    );
    expect(result.issues).toEqual([]);
    const elements = result.doc.screens[0]!.spec.elements;
    expect(elements["screen$list"]!.children).toEqual(["screen$row__rfirst", "screen$row__rsecond-two"]);
    expect(elements["screen$row__rfirst"]!.children).toEqual(["screen$title__rfirst"]);
    expect(elements["screen$title__rfirst"]!.props).toEqual({ text: "One" });
    expect(elements["screen$title__rsecond-two"]!.props).toEqual({ text: "Two" });
    expect(result.expandedFrom["screen$title__rfirst"]!.innerKey).toBe("title__rfirst");
  });

  it("caps the expansion at maxItems and reports duplicate key suffixes", () => {
    const capped = parsed({
      params: { items: { type: "array", items: { type: "string" }, maxItems: 10 } },
      spec: {
        root: "row",
        elements: {
          row: { type: "Box", props: {}, children: ["item"] },
          item: { type: "Text", props: { text: { $item: true } }, repeatParam: { param: "items", maxItems: 2 } },
        },
      },
    });
    const result = expandCompositions(screen("list", { items: ["a", "b", "c"] }), { compositions: { list: pinned(capped) } });
    expect(result.issues).toEqual([expect.objectContaining({ code: "composition/repeat-max-items" })]);
    expect(result.doc.screens[0]!.spec.elements["screen$row"]!.children).toEqual(["screen$item__r0", "screen$item__r1"]);

    const keyed = parsed({
      params: { rows: { type: "array", items: { type: "object", schema: { id: { type: "string", required: true } } }, maxItems: 10 } },
      spec: {
        root: "row",
        elements: {
          row: { type: "Box", props: {}, children: ["item"] },
          item: { type: "Text", props: { text: { $item: "id" } }, repeatParam: { param: "rows", key: "id" } },
        },
      },
    });
    const collision = expandCompositions(screen("list", { rows: [{ id: "same" }, { id: "same" }] }), { compositions: { list: pinned(keyed) } });
    expect(collision.issues).toEqual([expect.objectContaining({ code: "composition/repeat-key-collision" })]);
    expect(collision.doc.screens[0]!.spec.elements["screen$row"]!.children).toEqual(["screen$item__rsame"]);
  });

  it("counts clones against the expansion budget", () => {
    const composition = parsed({
      params: { items: { type: "array", items: { type: "string" }, maxItems: 50 } },
      spec: {
        root: "row",
        elements: {
          row: { type: "Box", props: {}, children: ["item"] },
          item: { type: "Text", props: { text: { $item: true } }, repeatParam: { param: "items" } },
        },
      },
    });
    const result = expandCompositions(
      screen("list", { items: Array.from({ length: 10 }, (_, index) => `i${index}`) }),
      { compositions: { list: pinned(composition) }, maxExpandedElements: 4 },
    );
    expect(result.issues.some((issue) => issue.code === "composition/expanded-elements")).toBe(true);
  });

  it("rejects the incompatible and forbidden placements at authoring time", () => {
    const body = (elements: Record<string, unknown>, params: Record<string, unknown> = {
      items: { type: "array", items: { type: "string" }, maxItems: 10 },
    }) => parse({ params, slots: [], spec: { root: "row", elements } });

    // repeatParam на корне.
    expect(body({ row: { type: "Box", props: {}, repeatParam: { param: "items" } } }).success).toBe(false);
    // repeatParam вместе со state-driven repeat.
    expect(body({
      row: { type: "Box", props: {}, children: ["item"] },
      item: { type: "Text", props: {}, repeat: { statePath: "/list" }, repeatParam: { param: "items" } },
    }).success).toBe(false);
    // Параметр не массив / не объявлен.
    expect(body({
      row: { type: "Box", props: {}, children: ["item"] },
      item: { type: "Text", props: {}, repeatParam: { param: "items" } },
    }, { items: { type: "string" } }).success).toBe(false);
    expect(body({
      row: { type: "Box", props: {}, children: ["item"] },
      item: { type: "Text", props: {}, repeatParam: { param: "missing" } },
    }).success).toBe(false);
    // maxItems выше объявленного параметром.
    expect(body({
      row: { type: "Box", props: {}, children: ["item"] },
      item: { type: "Text", props: {}, repeatParam: { param: "items", maxItems: 11 } },
    }).success).toBe(false);
    // key на скалярных items.
    expect(body({
      row: { type: "Box", props: {}, children: ["item"] },
      item: { type: "Text", props: {}, repeatParam: { param: "items", key: "id" } },
    }).success).toBe(false);
    // Вложенный repeatParam.
    expect(body({
      row: { type: "Box", props: {}, children: ["item"] },
      item: { type: "Box", props: {}, children: ["inner"], repeatParam: { param: "items" } },
      inner: { type: "Text", props: {}, repeatParam: { param: "items" } },
    }).success).toBe(false);
    // Зарезервированный суффикс в авторском ключе.
    expect(body({
      row: { type: "Box", props: {}, children: ["item__r0"] },
      item__r0: { type: "Text", props: {} },
    }).success).toBe(false);
    // `@eui/Slot` внутри повторяемого поддерева.
    expect(parse({
      params: { items: { type: "array", items: { type: "string" }, maxItems: 10 } },
      slots: ["body"],
      spec: {
        root: "row",
        elements: {
          row: { type: "Box", props: {}, children: ["item"] },
          item: { type: "Box", props: {}, children: ["body-slot"], repeatParam: { param: "items" } },
          "body-slot": { type: SLOT_TYPE, props: { name: "body" } },
        },
      },
    }).success).toBe(false);
  });

  it("rejects $item/$index outside a repeatParam subtree and malformed directives", () => {
    const params = { items: { type: "array", items: { type: "object", schema: { text: { type: "string" } } }, maxItems: 10 } };
    // $item вне повторяемого поддерева.
    expect(parse({
      params,
      spec: { root: "row", elements: { row: { type: "Box", props: { text: { $item: "text" } } } } },
    }).success).toBe(false);
    // Неизвестное поле item-объекта.
    expect(parse({
      params,
      spec: {
        root: "row",
        elements: {
          row: { type: "Box", props: {}, children: ["item"] },
          item: { type: "Text", props: { text: { $item: "missing" } }, repeatParam: { param: "items" } },
        },
      },
    }).success).toBe(false);
    // `$item: true` на объектных items и `$index` не `true`.
    expect(parse({
      params,
      spec: {
        root: "row",
        elements: {
          row: { type: "Box", props: {}, children: ["item"] },
          item: { type: "Text", props: { text: { $item: true } }, repeatParam: { param: "items" } },
        },
      },
    }).success).toBe(false);
    expect(parse({
      params,
      spec: {
        root: "row",
        elements: {
          row: { type: "Box", props: {}, children: ["item"] },
          item: { type: "Text", props: { order: { $index: "yes" } }, repeatParam: { param: "items" } },
        },
      },
    }).success).toBe(false);
  });
});

describe("composition v3 — slots with metadata (W8c)", () => {
  const dictComposition = (body: Record<string, unknown>) => parsed({
    slots: body.slots as Record<string, unknown>,
    spec: body.spec as Record<string, unknown>,
    params: {},
  });

  const shell = (slots: Record<string, unknown>, extra: Record<string, unknown> = {}) => parsed({
    slots,
    spec: {
      root: "row",
      elements: {
        row: { type: "Box", props: {}, children: ["body-slot"] },
        "body-slot": { type: SLOT_TYPE, props: { name: "body" } },
        ...extra,
      },
    },
  });

  const child = (type = "Text") => ({ child: { type, props: { text: "x" }, slot: "body" } });

  it("normalizes both declarations to the same expansion", () => {
    const arrayForm = shell(["body"] as unknown as Record<string, unknown>);
    const dictForm = shell({ body: {} });
    const expandOne = (composition: CompositionDoc) =>
      expandCompositions(screen("shell", {}, child()), { compositions: { shell: pinned(composition) } });
    const fromArray = expandOne(arrayForm);
    const fromDict = expandOne(dictForm);
    expect(fromArray.issues).toEqual([]);
    expect(fromDict.issues).toEqual([]);
    expect(JSON.stringify(fromDict.doc)).toEqual(JSON.stringify(fromArray.doc));
    expect(dictComposition({ slots: { body: {} }, spec: arrayForm.spec }).slots).toEqual({ body: {} });
  });

  it("reports an empty required slot and accepts it once filled", () => {
    const composition = shell({ body: { required: true } });
    const empty = expandCompositions(screen("shell"), { compositions: { shell: pinned(composition) } });
    expect(empty.issues).toEqual([expect.objectContaining({ code: "composition/slot-required" })]);
    const filled = expandCompositions(screen("shell", {}, child()), { compositions: { shell: pinned(composition) } });
    expect(filled.issues).toEqual([]);
  });

  it("materializes fallback for an empty slot and drops it once the slot is filled", () => {
    const composition = shell({ body: { required: true, fallback: ["empty"] } }, {
      empty: { type: "Text", props: { text: "Nothing here" } },
    });
    const empty = expandCompositions(screen("shell"), { compositions: { shell: pinned(composition) } });
    expect(empty.issues).toEqual([]);
    expect(empty.doc.screens[0]!.spec.elements["screen$row"]!.children).toEqual(["screen$empty"]);
    expect(empty.doc.screens[0]!.spec.elements["screen$empty"]!.props).toEqual({ text: "Nothing here" });

    const filled = expandCompositions(screen("shell", {}, child()), { compositions: { shell: pinned(composition) } });
    expect(filled.issues).toEqual([]);
    expect(filled.doc.screens[0]!.spec.elements["screen$row"]!.children).toEqual(["child"]);
    expect(filled.doc.screens[0]!.spec.elements["screen$empty"]).toBeUndefined();
  });

  it("enforces cardinality and allowedTypes at the reference point", () => {
    const composition = shell({ body: { cardinality: { min: 2, max: 2 }, allowedTypes: ["Text"] } });
    const one = expandCompositions(screen("shell", {}, child()), { compositions: { shell: pinned(composition) } });
    expect(one.issues).toEqual([expect.objectContaining({ code: "composition/slot-cardinality" })]);

    const wrongType = expandCompositions(
      screen("shell", {}, { a: { type: "Text", props: {}, slot: "body" }, b: { type: "Box", props: {}, slot: "body" } }),
      { compositions: { shell: pinned(composition) } },
    );
    expect(wrongType.issues).toEqual([expect.objectContaining({ code: "composition/slot-type" })]);

    const ok = expandCompositions(
      screen("shell", {}, { a: { type: "Text", props: {}, slot: "body" }, b: { type: "Text", props: {}, slot: "body" } }),
      { compositions: { shell: pinned(composition) } },
    );
    expect(ok.issues).toEqual([]);
  });

  it("checks allowedRoles only when the caller supplies the canonical-role map", () => {
    const composition = shell({ body: { allowedRoles: ["primary-action"] } });
    const compositions = { shell: pinned(composition) };
    const doc = screen("shell", {}, { a: { type: "Button", props: {}, slot: "body" } });
    // Клиентское раскрытие ролей не знает — проверка молчит.
    expect(expandCompositions(doc, { compositions }).issues).toEqual([]);
    expect(expandCompositions(doc, { compositions, componentRoles: { Button: ["primary-action"] } }).issues).toEqual([]);
    expect(expandCompositions(doc, { compositions, componentRoles: { Button: ["list-row"] } }).issues)
      .toEqual([expect.objectContaining({ code: "composition/slot-role" })]);
  });

  it("rejects malformed slot metadata at authoring time", () => {
    const spec = (extra: Record<string, unknown> = {}) => ({
      root: "row",
      elements: {
        row: { type: "Box", props: {}, children: ["body-slot"] },
        "body-slot": { type: SLOT_TYPE, props: { name: "body" } },
        ...extra,
      },
    });
    // Неизвестный fallback-ключ.
    expect(parse({ slots: { body: { fallback: ["missing"] } }, spec: spec() }).success).toBe(false);
    // Fallback — корень.
    expect(parse({ slots: { body: { fallback: ["row"] } }, spec: spec() }).success).toBe(false);
    // Fallback уже является ребёнком другого элемента.
    expect(parse({
      slots: { body: { fallback: ["inner"] } },
      spec: {
        root: "row",
        elements: {
          row: { type: "Box", props: {}, children: ["body-slot", "wrap"] },
          "body-slot": { type: SLOT_TYPE, props: { name: "body" } },
          wrap: { type: "Box", props: {}, children: ["inner"] },
          inner: { type: "Text", props: {} },
        },
      },
    }).success).toBe(false);
    // Недостижимый элемент, не объявленный fallback'ом.
    expect(parse({ slots: { body: {} }, spec: spec({ orphan: { type: "Text", props: {} } }) }).success).toBe(false);
    // Fallback содержит слот.
    expect(parse({
      slots: { body: { fallback: ["alt"] }, extra: {} },
      spec: {
        root: "row",
        elements: {
          row: { type: "Box", props: {}, children: ["body-slot"] },
          "body-slot": { type: SLOT_TYPE, props: { name: "body" } },
          alt: { type: "Box", props: {}, children: ["extra-slot"] },
          "extra-slot": { type: SLOT_TYPE, props: { name: "extra" } },
        },
      },
    }).success).toBe(false);
    // Противоречивая кардинальность и пустые списки.
    expect(parse({ slots: { body: { cardinality: { min: 3, max: 1 } } }, spec: spec() }).success).toBe(false);
    expect(parse({ slots: { body: { cardinality: {} } }, spec: spec() }).success).toBe(false);
    expect(parse({ slots: { body: { allowedTypes: [] } }, spec: spec() }).success).toBe(false);
    // Слот словаря без своего `@eui/Slot`-элемента.
    expect(parse({ slots: { body: {}, extra: {} }, spec: spec() }).success).toBe(false);
  });
});

/**
 * W8d — параметр типа `action` (триаж T-M6). Рантайм-границы композиции не существует:
 * host-элемент исчезает при раскрытии, поэтому «событие композиции» некому испустить.
 * Точка ссылки передаёт готовый биндинг обработчика, раскрытие вписывает его в `on`.
 */
describe("composition v3 — action params", () => {
  const tapRow = (extra: Record<string, unknown> = {}) => parsed({
    params: { "on-tap": { type: "action", required: true }, "on-long": { type: "action" }, label: { type: "string", default: "Tap" } },
    spec: {
      root: "row",
      elements: {
        row: {
          type: "Row", props: { text: { $param: "label" } },
          on: { press: { $param: "on-tap" }, longPress: { $param: "on-long" } },
          ...extra,
        },
      },
    },
  });

  it("substitutes a single action and an array of actions into on", () => {
    const single = expandCompositions(screen("row", { "on-tap": { action: "navigate", params: { screenId: "next" } } }), {
      compositions: { row: pinned(tapRow()) },
    });
    expect(single.issues).toEqual([]);
    const row = single.doc.screens[0]!.spec.elements["screen$row"]!;
    expect(row.on).toEqual({ press: { action: "navigate", params: { screenId: "next" } } });
    // Незаполненный необязательный action снимает событие целиком.
    expect(row.on).not.toHaveProperty("longPress");

    const many = expandCompositions(screen("row", {
      "on-tap": [{ action: "setState", params: { statePath: "/tapped", value: true } }, { action: "navigate", params: { screenId: "next" } }],
    }), { compositions: { row: pinned(tapRow()) } });
    expect(many.issues).toEqual([]);
    expect(many.doc.screens[0]!.spec.elements["screen$row"]!.on).toEqual({
      press: [
        { action: "setState", params: { statePath: "/tapped", value: true } },
        { action: "navigate", params: { screenId: "next" } },
      ],
    });
  });

  it("splices a directive that sits inside an authored action array", () => {
    const composition = parsed({
      params: { "on-tap": { type: "action" } },
      spec: {
        root: "row",
        elements: {
          row: {
            type: "Row", props: {},
            on: { press: [{ action: "setState", params: { statePath: "/seen", value: true } }, { $param: "on-tap" }] },
          },
        },
      },
    });
    const result = expandCompositions(screen("row", { "on-tap": { action: "back" } }), { compositions: { row: pinned(composition) } });
    expect(result.issues).toEqual([]);
    expect(result.doc.screens[0]!.spec.elements["screen$row"]!.on).toEqual({
      press: [{ action: "setState", params: { statePath: "/seen", value: true } }, { action: "back" }],
    });
    // Незаполненный параметр оставляет только авторское действие (и снимает массив).
    const unset = expandCompositions(screen("row"), { compositions: { row: pinned(composition) } });
    expect(unset.doc.screens[0]!.spec.elements["screen$row"]!.on).toEqual({
      press: { action: "setState", params: { statePath: "/seen", value: true } },
    });
  });

  it("validates the handler binding at the reference point", () => {
    const bad = expandCompositions(screen("row", { "on-tap": { action: "" } }), { compositions: { row: pinned(tapRow()) } });
    expect(bad.issues.map((issue) => issue.message).join(" ")).toContain("must be of type action");

    const missing = expandCompositions(screen("row"), { compositions: { row: pinned(tapRow()) } });
    expect(missing.issues.map((issue) => issue.message).join(" ")).toContain("required composition param is missing: on-tap");

    expect(paramValueMatches({ type: "action" }, { action: "back" })).toBe(true);
    expect(paramValueMatches({ type: "action" }, [{ action: "back" }])).toBe(true);
    expect(paramValueMatches({ type: "action" }, [])).toBe(false);
    expect(paramValueMatches({ type: "action" }, { action: "back", nope: 1 })).toBe(false);
    expect(paramValueMatches({ type: "action" }, "navigate")).toBe(false);
  });

  it("leaves navigation targets to the post-expansion validator", () => {
    // Раскрытие проверяет только форму: существование экрана — дело validatePrototype,
    // который работает уже по раскрытому документу (save-путь: expand → validate).
    const result = expandCompositions(screen("row", { "on-tap": { action: "navigate", params: { screenId: "nowhere" } } }), {
      compositions: { row: pinned(tapRow()) },
    });
    expect(result.issues).toEqual([]);
    expect(result.doc.screens[0]!.spec.elements["screen$row"]!.on).toEqual({
      press: { action: "navigate", params: { screenId: "nowhere" } },
    });
  });

  it("rejects action params outside on, and non-action params inside on", () => {
    // action-параметр в props.
    expect(parse({
      params: { "on-tap": { type: "action" } },
      spec: { root: "row", elements: { row: { type: "Row", props: { handler: { $param: "on-tap" } } } } },
    }).success).toBe(false);
    // Обычный параметр в позиции обработчика.
    expect(parse({
      params: { label: { type: "string" } },
      spec: { root: "row", elements: { row: { type: "Row", props: {}, on: { press: { $param: "label" } } } } },
    }).success).toBe(false);
    // Необъявленный параметр в `on`.
    expect(parse({
      params: {},
      spec: { root: "row", elements: { row: { type: "Row", props: {}, on: { press: { $param: "ghost" } } } } },
    }).success).toBe(false);
    // Директива внутри самого действия — подстановка туда не ходит.
    expect(parse({
      params: { screen: { type: "string" }, "on-tap": { type: "action" } },
      spec: { root: "row", elements: { row: { type: "Row", props: {}, on: { press: { action: "navigate", params: { screenId: { $param: "screen" } } } } } } },
    }).success).toBe(false);
    // `when`/`$switch`/`repeatParam` не ветвятся по действию.
    expect(parse({
      params: { "on-tap": { type: "action" } },
      spec: { root: "row", elements: { row: { type: "Row", props: {}, children: ["kid"] }, kid: { type: "Text", props: {}, when: { param: "on-tap", eq: "x" } } } },
    }).success).toBe(false);
    expect(parse({
      params: { "on-tap": { type: "action" } },
      spec: { root: "row", elements: { row: { type: "Row", props: { x: { $switch: { param: "on-tap", cases: { a: 1 }, default: 2 } } } } } },
    }).success).toBe(false);
    // action-параметр не несёт `default`.
    expect(parse({
      params: { "on-tap": { type: "action", default: { action: "back" } } },
      spec: boxRoot,
    }).success).toBe(false);
  });

  it("keeps on untouched in a v1/v2 body", () => {
    const v2 = compositionDocSchema.parse({
      version: 2, name: "V2", atomicLevel: "molecule", params: {}, slots: [],
      spec: { root: "row", elements: { row: { type: "Row", props: {}, on: { press: { action: "back" } } } } },
    });
    const result = expandCompositions(screen("row"), { compositions: { row: pinned(v2) } });
    expect(result.issues).toEqual([]);
    expect(result.doc.screens[0]!.spec.elements["screen$row"]!.on).toEqual({ press: { action: "back" } });
  });
});

/**
 * W8e — token layout: декларация в токенах компилируется в props контракта
 * spacing/layout v1. Новых рантайм-примитивов нет, `layout` в раскрытом дереве не остаётся.
 */
describe("composition v3 — token layout", () => {
  const stack = (layout: Record<string, unknown>) => parsed({
    params: {},
    spec: { root: "row", elements: { row: { type: "Stack", props: { text: "x" }, layout } } },
  });
  const flexContract = {
    version: 1 as const,
    spacing: ["gap", "padding"] as ("gap" | "padding" | "paddingX" | "paddingY")[],
    flow: { kind: "flex" as const, direction: { prop: "direction", vertical: ["vertical"], horizontal: ["horizontal"] }, wrap: { prop: "wrap", enabled: [true] } },
  };

  it("compiles tokens into the canonical props and drops the layout block", () => {
    const composition = stack({
      flow: { kind: "flex", direction: "vertical", wrap: true },
      gap: "md", padding: "lg", align: "center", justify: "between",
      sizing: { width: "full", grow: true }, radius: "xl", clip: true, background: "surface-muted",
    });
    const result = expandCompositions(screen("row"), { compositions: { row: pinned(composition) } });
    expect(result.issues).toEqual([]);
    const row = result.doc.screens[0]!.spec.elements["screen$row"]!;
    expect(row).not.toHaveProperty("layout");
    expect(row.props).toEqual({
      text: "x", direction: "vertical", wrap: true, gap: "md", padding: "lg",
      align: "center", justify: "between", width: "full", grow: true, radius: "xl", clip: true, background: "surface-muted",
    });
  });

  it("reports composition/layout-unsupported against the design system contract", () => {
    const composition = stack({ flow: { kind: "flex", direction: "horizontal" }, gap: "md", paddingX: "sm" });
    const supported = expandCompositions(screen("row"), {
      compositions: { row: pinned(composition) },
      componentLayouts: { Stack: { ...flexContract, spacing: ["gap", "padding", "paddingX"] } },
    });
    expect(supported.issues).toEqual([]);

    const unsupported = expandCompositions(screen("row"), {
      compositions: { row: pinned(composition) },
      componentLayouts: { Stack: flexContract },
    });
    expect(unsupported.issues.map((issue) => issue.code)).toEqual(["composition/layout-unsupported"]);
    expect(unsupported.issues[0]!.message).toContain("paddingX");

    const noContract = expandCompositions(screen("row"), {
      compositions: { row: pinned(composition) },
      componentLayouts: {},
    });
    expect(noContract.issues[0]!.code).toBe("composition/layout-unsupported");
    expect(noContract.issues[0]!.message).toContain("does not declare the layout contract v1");

    // Статическое направление потока компилировать нечем: оно присуще компоненту.
    const fixed = expandCompositions(screen("row"), {
      compositions: { row: pinned(stack({ flow: { kind: "flex", direction: "vertical" } })) },
      componentLayouts: { Stack: { version: 1, spacing: ["gap"], flow: { kind: "flex", direction: "vertical" } } },
    });
    expect(fixed.issues[0]!.message).toContain("fixed vertical flow direction");
  });

  it("compiles identically without a contract map (client and server agree)", () => {
    const composition = stack({ gap: "md", radius: "full" });
    const withMap = expandCompositions(screen("row"), {
      compositions: { row: pinned(composition) },
      componentLayouts: { Stack: { version: 1, spacing: ["gap"] } },
    });
    const withoutMap = expandCompositions(screen("row"), { compositions: { row: pinned(composition) } });
    expect(withoutMap.doc.screens[0]!.spec.elements["screen$row"]!.props)
      .toEqual(withMap.doc.screens[0]!.spec.elements["screen$row"]!.props);
  });

  /**
   * W5 T5b (план 2026-08-06): потолок высоты и владение прокруткой. Компилируются **токенами**
   * (`maxHeight:"viewport"`, `scroll:true`), а не CSS-строками: закрытые перечисления — единственная
   * причина, по которой сырых px в композиции быть не может. Контракт v1 их не описывает, поэтому
   * `layoutSupportIssues` о них молчит — ровно как о `radius`/`clip`/`background`.
   */
  it("компилирует sizing.maxHeight и scroll и не выдумывает по ним диагностики", () => {
    const composition = stack({ sizing: { width: "full", maxHeight: "viewport" }, scroll: true });
    const result = expandCompositions(screen("row"), {
      compositions: { row: pinned(composition) },
      componentLayouts: { Stack: { version: 1, spacing: ["gap"] } },
    });
    expect(result.issues).toEqual([]);
    expect(result.doc.screens[0]!.spec.elements["screen$row"]!.props)
      .toEqual({ text: "x", width: "full", maxHeight: "viewport", scroll: true });
    // Тот же результат без карты контрактов: клиентское раскрытие обязано дать то же дерево.
    expect(expandCompositions(screen("row"), { compositions: { row: pinned(composition) } })
      .doc.screens[0]!.spec.elements["screen$row"]!.props)
      .toEqual({ text: "x", width: "full", maxHeight: "viewport", scroll: true });
    // Значение закрыто одним токеном, а конфликт с авторским prop'ом ловится статически.
    expect(parse({ params: {}, spec: { root: "row", elements: { row: { type: "Stack", props: {}, layout: { sizing: { maxHeight: "100%" } } } } } }).success).toBe(false);
    expect(parse({ params: {}, spec: { root: "row", elements: { row: { type: "Stack", props: { scroll: false }, layout: { scroll: true } } } } }).success).toBe(false);
    // `sizing: { maxHeight }` — непустой блок: refine больше не требует width/height/grow/basis.
    expect(parse({ params: {}, spec: { root: "row", elements: { row: { type: "Stack", props: {}, layout: { sizing: { maxHeight: "viewport" } } } } } }).success).toBe(true);
  });

  it("rejects raw values, empty blocks and props already taken by the compilation", () => {
    expect(parse({ params: {}, spec: { root: "row", elements: { row: { type: "Stack", props: {}, layout: { gap: "12px" } } } } }).success).toBe(false);
    expect(parse({ params: {}, spec: { root: "row", elements: { row: { type: "Stack", props: {}, layout: { background: "#ffffff" } } } } }).success).toBe(false);
    expect(parse({ params: {}, spec: { root: "row", elements: { row: { type: "Stack", props: {}, layout: {} } } } }).success).toBe(false);
    expect(parse({ params: {}, spec: { root: "row", elements: { row: { type: "Stack", props: {}, layout: { sizing: {} } } } } }).success).toBe(false);
    expect(parse({ params: {}, spec: { root: "row", elements: { row: { type: "Stack", props: {}, layout: { flow: { kind: "grid", direction: "vertical" } } } } } }).success).toBe(false);
    // Конфликт с авторским prop'ом — статически.
    expect(parse({ params: {}, spec: { root: "row", elements: { row: { type: "Stack", props: { gap: "sm" }, layout: { gap: "md" } } } } }).success).toBe(false);
    // v2 не знает `layout` вовсе.
    expect(compositionDocSchema.safeParse({
      version: 2, name: "V2", atomicLevel: "molecule", params: {}, slots: [],
      spec: { root: "row", elements: { row: { type: "Stack", props: {}, layout: { gap: "md" } } } },
    }).success).toBe(false);
  });
});

/**
 * W8f — варианты: одна композиция с легальными комбинациями осей вместо семейства копий.
 */
describe("composition v3 — variants", () => {
  const variantDoc = parsed({
    params: { tone: { type: "enum", values: ["brand", "muted"] }, dense: { type: "boolean" }, label: { type: "string", default: "Row" } },
    variants: {
      dimensions: { state: ["default", "pressed"], size: ["s", "m"] },
      tuples: [
        { dims: { state: "default", size: "s" }, params: { tone: "brand", dense: true } },
        { dims: { state: "default", size: "m" }, params: { tone: "brand", dense: false } },
        { dims: { state: "pressed", size: "m" }, params: { tone: "muted", dense: false } },
      ],
      defaults: { state: "default", size: "m" },
    },
    spec: { root: "row", elements: { row: { type: "Row", props: { tone: { $param: "tone" }, dense: { $param: "dense" }, text: { $param: "label" } } } } },
  });

  const variantScreen = (variant: unknown, params: Record<string, unknown> = {}): PrototypeDoc => inputPrototypeDocSchema.parse({
    version: 1, id: "variant-screen", name: "Variant screen", designSystem: "test-ds", startScreen: "main", state: {},
    screens: [{
      id: "main", name: "Main",
      spec: { root: "screen", elements: { screen: { type: COMPOSITION_TYPE, props: { composition: "row", variant, params } } } },
    }],
  }) as PrototypeDoc;

  const expand = (variant: unknown, params: Record<string, unknown> = {}) =>
    expandCompositions(variantScreen(variant, params), { compositions: { row: pinned(variantDoc) } });

  it("resolves a tuple into parameter values and fills missing axes from defaults", () => {
    const full = expand({ state: "pressed", size: "m" });
    expect(full.issues).toEqual([]);
    expect(full.doc.screens[0]!.spec.elements["screen$row"]!.props).toEqual({ tone: "muted", dense: false, text: "Row" });

    // `size` доопределяется из defaults.
    const partial = expand({ state: "default" });
    expect(partial.issues).toEqual([]);
    expect(partial.doc.screens[0]!.spec.elements["screen$row"]!.props).toEqual({ tone: "brand", dense: false, text: "Row" });
  });

  it("rejects unknown axes, unknown values and combinations outside the tuples", () => {
    expect(expand({ shape: "round" }).issues[0]!.code).toBe("composition/variant-unknown");
    expect(expand({ state: "hovered" }).issues[0]!.code).toBe("composition/variant-unknown");
    const illegal = expand({ state: "pressed", size: "s" });
    expect(illegal.issues[0]!.code).toBe("composition/variant-unknown-tuple");
    expect(illegal.issues[0]!.message).toContain("size=s|state=pressed");
  });

  it("rejects an explicit param that the variant already fixes", () => {
    const conflict = expand({ state: "default", size: "m" }, { tone: "muted" });
    expect(conflict.issues.map((issue) => issue.code)).toEqual(["composition/variant-param-conflict"]);
    // Параметр вне варианта задаётся явно как обычно.
    const fine = expand({ state: "default", size: "m" }, { label: "Given" });
    expect(fine.issues).toEqual([]);
    expect(fine.doc.screens[0]!.spec.elements["screen$row"]!.props).toMatchObject({ text: "Given" });
  });

  it("reports a variant on a composition that declares none, and an axis without a default", () => {
    const plain = parsed({ params: {}, spec: boxRoot });
    const result = expandCompositions(variantScreen({ state: "default" }), { compositions: { row: pinned(plain) } });
    expect(result.issues[0]!.code).toBe("composition/variant-unknown");

    const noDefault = parsed({
      params: { tone: { type: "enum", values: ["brand"] } },
      variants: { dimensions: { state: ["default", "pressed"], size: ["s"] }, tuples: [{ dims: { state: "default", size: "s" }, params: { tone: "brand" } }] },
      spec: { root: "row", elements: { row: { type: "Row", props: { tone: { $param: "tone" } } } } },
    });
    const incomplete = expandCompositions(variantScreen({ state: "default" }), { compositions: { row: pinned(noDefault) } });
    expect(incomplete.issues[0]!.code).toBe("composition/variant-incomplete");
  });

  it("rejects malformed variant declarations at authoring time", () => {
    const withVariants = (variants: Record<string, unknown>) => parse({
      params: { tone: { type: "enum", values: ["brand"] } },
      variants,
      spec: { root: "row", elements: { row: { type: "Row", props: { tone: { $param: "tone" } } } } },
    });
    expect(withVariants({ dimensions: {} }).success).toBe(false);
    expect(withVariants({ dimensions: { state: ["a", "a"] } }).success).toBe(false);
    // Неполный tuple.
    expect(withVariants({ dimensions: { state: ["a"], size: ["s"] }, tuples: [{ dims: { state: "a" } }] }).success).toBe(false);
    // Дубль комбинации.
    expect(withVariants({ dimensions: { state: ["a"] }, tuples: [{ dims: { state: "a" } }, { dims: { state: "a" } }] }).success).toBe(false);
    // Значение вне оси и ось вне объявления.
    expect(withVariants({ dimensions: { state: ["a"] }, tuples: [{ dims: { state: "b" } }] }).success).toBe(false);
    expect(withVariants({ dimensions: { state: ["a"] }, tuples: [{ dims: { size: "a" } }] }).success).toBe(false);
    // Параметр tuple'а не объявлен / не того типа.
    expect(withVariants({ dimensions: { state: ["a"] }, tuples: [{ dims: { state: "a" }, params: { ghost: 1 } }] }).success).toBe(false);
    expect(withVariants({ dimensions: { state: ["a"] }, tuples: [{ dims: { state: "a" }, params: { tone: "loud" } }] }).success).toBe(false);
    // Defaults вне объявленных значений и вне перечисленных tuples.
    expect(withVariants({ dimensions: { state: ["a"] }, defaults: { state: "b" } }).success).toBe(false);
    expect(withVariants({ dimensions: { state: ["a", "b"] }, tuples: [{ dims: { state: "a" } }], defaults: { state: "b" } }).success).toBe(false);
    // Tuple не задаёт action-параметр: биндинг принадлежит точке ссылки.
    expect(parse({
      params: { "on-tap": { type: "action" } },
      variants: { dimensions: { state: ["a"] }, tuples: [{ dims: { state: "a" }, params: { "on-tap": { action: "back" } } }] },
      spec: { root: "row", elements: { row: { type: "Row", props: {}, on: { press: { $param: "on-tap" } } } } },
    }).success).toBe(false);
  });

  it("exports variant dimensions as a pure projection", () => {
    expect(variantDimensionsOf(variantDoc)).toEqual({ state: ["default", "pressed"], size: ["s", "m"] });
    expect(variantDimensionsOf(parsed({ params: {}, spec: boxRoot }))).toEqual({});
    expect(variantDimensionsOf({ version: 2 })).toEqual({});
  });
});
