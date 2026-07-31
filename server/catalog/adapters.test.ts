import { describe, expect, test } from "bun:test";
import { applyMigrationAdapter, type MigrationSpec } from "./adapters";
import type { MigrationAdapter } from "./migrationPlan";

const spec = (elements: MigrationSpec["elements"]): MigrationSpec => ({ root: "root", elements });

describe("declarative migration adapters", () => {
  test("maps type, props, enum values, events/payloads, and slots", () => {
    const document = spec({
      root: { type: "LegacyCard", props: { title: "Pay", variant: "primary" }, children: ["body"], on: { activate: { action: "setState", params: { value: 3 } } } },
      body: { type: "Text", props: { value: "body" }, slot: "body" },
    });
    const migration: MigrationAdapter = {
      typeMap: { LegacyCard: "Card" },
      props: {
        LegacyCard: {
          rename: { title: "label" },
          defaults: { tone: "neutral" },
          enumMap: { variant: { primary: "default" } },
        },
      },
      events: { LegacyCard: { rename: { activate: "press" }, payloadMap: { value: "amount" } } },
      slots: { rename: { body: "content" } },
    };

    const result = applyMigrationAdapter(document, migration);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.elements.root).toEqual({
      type: "Card",
      props: { label: "Pay", tone: "neutral", variant: "default" },
      children: ["body"],
      on: { press: { action: "setState", params: { amount: 3 } } },
    });
    expect(result.doc.elements.body?.slot).toBe("content");
    expect(result.changedPaths).toContain("/elements/root/props/title");
    expect(result.changedPaths).toContain("/elements/root/props/label");
    expect(result.changedPaths).toContain("/elements/root/on/press/params/amount");
    expect(result.changedPaths).toContain("/elements/body/slot");
  });

  test("refuses populated prop, event, and slot drops without returning a partial rewrite", () => {
    const document = spec({
      root: { type: "Legacy", props: { obsolete: "keep" }, on: { old: { action: "noop" } }, slot: "old-slot" },
    });
    const migration: MigrationAdapter = {
      typeMap: {},
      props: { Legacy: { drop: ["obsolete"] } },
      events: { Legacy: { drop: ["old"] } },
      slots: { drop: ["old-slot"] },
    };

    const result = applyMigrationAdapter(document, migration);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.changedPaths).toEqual([]);
    expect(result.refusals.map((refusal) => refusal.code)).toEqual([
      "populated_event_drop",
      "populated_prop_drop",
      "populated_slot_drop",
    ]);
    expect(result.doc).toEqual(document);
    expect(document.elements.root?.props).toEqual({ obsolete: "keep" });
  });

  test("component-to-composition conversion maps params and routes direct children", () => {
    const document = spec({
      root: { type: "LegacyOrganism", props: { title: "Checkout" }, children: ["content"] },
      content: { type: "Text", props: { value: "items" } },
    });
    const migration: MigrationAdapter = {
      typeMap: { LegacyOrganism: "@eui/Composition" },
      props: { LegacyOrganism: {} },
      composition: { id: "checkout-organism", paramMap: { title: "heading" }, defaultSlot: "content", declaredSlots: ["content"] },
    };

    const result = applyMigrationAdapter(document, migration);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.elements.root).toEqual({
      type: "@eui/Composition",
      props: { composition: "checkout-organism", params: { heading: "Checkout" } },
      children: ["content"],
    });
    expect(result.doc.elements.content?.slot).toBe("content");
    expect(result.changedPaths).toContain("/elements/root/props/composition");
    expect(result.changedPaths).toContain("/elements/root/props/params");
    expect(result.changedPaths).toContain("/elements/content/slot");

    const second = applyMigrationAdapter(result.doc, migration);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.changedPaths).toEqual([]);
    expect(second.doc).toEqual(result.doc);
  });

  test("refuses an incomplete composition parameter or slot mapping", () => {
    const document = spec({
      root: { type: "LegacyOrganism", props: { title: "Checkout", subtitle: "Pay" }, children: ["content"] },
      content: { type: "Text", props: { value: "items" }, slot: "missing" },
    });
    const migration: MigrationAdapter = {
      typeMap: { LegacyOrganism: "@eui/Composition" },
      props: { LegacyOrganism: {} },
      composition: { id: "checkout-organism", paramMap: { title: "heading" }, declaredSlots: ["content"] },
    };

    const result = applyMigrationAdapter(document, migration);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusals.map((refusal) => refusal.code)).toContain("composition_prop_not_mapped");
    expect(result.refusals.map((refusal) => refusal.code)).toContain("composition_slot_not_declared");
    expect(result.doc).toEqual(document);
  });
});

