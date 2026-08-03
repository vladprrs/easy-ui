import { describe, expect, it } from "vitest";
import compositionFixture from "../../../test/fixtures/architecture/ctyp-payment-success.composition.json";
import composedScreenFixture from "../../../test/fixtures/architecture/composition-screen.json";
import { COMPOSITION_TYPE, SLOT_TYPE } from "../../catalog/hostPrimitives/composition.definition";
import {
  compositionDocSchema, expandCompositions,
  type CompositionCatalogEntry, type CompositionDoc,
} from "../composition";
import { inputPrototypeDocSchema, type PrototypeDoc } from "../schema";

/**
 * Снапшоты **диспетчеризации** (план 2026-08-03, D8 / триаж R1-M5).
 *
 * Аддитивность v3 доказывается не на телах, а на двух точках выбора:
 * `isCompositionSource` (какие `version` считаются pin-source'ом) и выбор алгоритма
 * в `expandCompositions`. Эталоны ниже сняты **до** правки диспетчеров: v1-документ обязан
 * остаться на legacy-пути (origin без `chain`), v2-документ — на nested-пути (origin с `chain`).
 */

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
  return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
}, 2);

const v1Composition = compositionDocSchema.parse(structuredClone(compositionFixture));
const v1Screen = () => inputPrototypeDocSchema.parse(structuredClone(composedScreenFixture)) as PrototypeDoc;

const v2Composition = compositionDocSchema.parse({
  version: 2,
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
}) satisfies CompositionDoc;

const v2Screen = () => inputPrototypeDocSchema.parse({
  version: 1,
  id: "dispatch-v2",
  name: "Dispatch v2",
  designSystem: "test-ds",
  startScreen: "main",
  state: {},
  screens: [{
    id: "main",
    name: "Main",
    spec: {
      root: "screen",
      elements: {
        screen: { type: COMPOSITION_TYPE, props: { composition: "payment-row", params: { label: "Given" } }, children: ["body"] },
        body: { type: "Text", props: { text: "Body" }, slot: "content" },
      },
    },
  }],
}) as PrototypeDoc;

const expand = (doc: PrototypeDoc, compositions: Record<string, CompositionCatalogEntry>) => {
  const result = expandCompositions(doc, { compositions });
  return canonical({ doc: result.doc, issues: result.issues, refs: result.refs, expandedFrom: result.expandedFrom });
};

describe("composition expansion dispatch (D8)", () => {
  it("keeps a wholly-v1 document on the frozen legacy path", () => {
    const serialized = expand(v1Screen(), { "ctyp-payment-success": v1Composition });
    // v1-эталон: origin без `chain` (legacy-путь), ключи и порядок детей неизменны.
    expect(JSON.parse(serialized).expandedFrom).toEqual({
      "screen$shell": { compositionId: "ctyp-payment-success", hostKey: "screen", innerKey: "shell" },
      "screen$badge": { compositionId: "ctyp-payment-success", hostKey: "screen", innerKey: "badge" },
    });
    expect(serialized).toMatchSnapshot("v1-expansion");
  });

  it("keeps a v2 reference on the nested path", () => {
    const serialized = expand(v2Screen(), { "payment-row": { doc: v2Composition, version: 3, designSystem: "test-ds", status: "active" } });
    // v2-эталон: origin несёт `chain` — признак nested-алгоритма.
    expect(JSON.parse(serialized).expandedFrom["screen$label"].chain).toHaveLength(1);
    expect(serialized).toMatchSnapshot("v2-expansion");
  });

  it("routes a document that only references v3 through the nested path", () => {
    const v3Composition = compositionDocSchema.parse({
      version: 3,
      name: "Tone row",
      atomicLevel: "molecule",
      params: { tone: { type: "enum", values: ["brand", "muted"], default: "brand" } },
      slots: [],
      spec: {
        root: "row",
        elements: {
          row: { type: "Box", props: {}, children: ["label", "extra"] },
          label: { type: "Text", props: { tone: { $switch: { param: "tone", cases: { brand: "accent", muted: "grey" } } } } },
          extra: { type: "Text", props: { text: "muted only" }, when: { param: "tone", eq: "muted" } },
        },
      },
    });
    const doc = inputPrototypeDocSchema.parse({
      version: 1, id: "dispatch-v3", name: "Dispatch v3", designSystem: "test-ds", startScreen: "main", state: {},
      screens: [{ id: "main", name: "Main", spec: { root: "screen", elements: {
        screen: { type: COMPOSITION_TYPE, props: { composition: "tone-row" } },
      } } }],
    }) as PrototypeDoc;

    const result = expandCompositions(doc, {
      compositions: { "tone-row": { doc: v3Composition, version: 2, designSystem: "test-ds", status: "active" } },
    });

    expect(result.issues).toEqual([]);
    // Nested-путь: origin с `chain`. Legacy-ветка не знает ни `when`, ни `$switch`,
    // поэтому попадание сюда — и есть проверка диспетчера.
    expect(result.expandedFrom["screen$label"]!.chain).toEqual([
      { compositionId: "tone-row", version: 2, hostKey: "screen", innerKey: "label" },
    ]);
    expect(result.doc.screens[0]!.spec.elements["screen$label"]!.props).toEqual({ tone: "accent" });
    expect(result.doc.screens[0]!.spec.elements["screen$extra"]).toBeUndefined();
  });

  it("accepts a v3 pin source instead of silently reading it as version 1", () => {
    const v3 = compositionDocSchema.parse({
      version: 3, name: "Leaf", atomicLevel: "molecule", params: {}, slots: [],
      spec: { root: "leaf", elements: { leaf: { type: "Box", props: {} } } },
    });
    const doc = inputPrototypeDocSchema.parse({
      version: 1, id: "dispatch-v3-pin", name: "Pin", designSystem: "test-ds", startScreen: "main", state: {},
      screens: [{ id: "main", name: "Main", spec: { root: "screen", elements: {
        screen: { type: COMPOSITION_TYPE, props: { composition: "leaf" } },
      } } }],
    }) as PrototypeDoc;

    const result = expandCompositions(doc, {
      // `isCompositionSource` обязан распознать `{doc, version}` для v3: иначе pin-обёртка
      // была бы прочитана как сам документ, а версия публикации схлопнулась бы в 1.
      compositions: { leaf: { doc: v3, version: 9, designSystem: "test-ds", status: "active" } },
    });
    expect(result.issues).toEqual([]);
    expect(result.expandedFrom["screen$leaf"]!.chain).toEqual([
      { compositionId: "leaf", version: 9, hostKey: "screen", innerKey: "leaf" },
    ]);
  });
});
