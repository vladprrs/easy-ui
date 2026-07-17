/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, test } from "vitest";
import type { PrototypeDoc } from "./schema";
import { diffPrototypeDocs, safeCanonicalize, type PrototypeRevisionForDiff } from "./revisionDiff";

const doc = (overrides: Partial<PrototypeDoc> = {}): PrototypeDoc => ({
  version: 1, id: "proto", name: "Before", designSystem: "shadcn", device: "desktop", startScreen: "home", state: { count: 0 },
  screens: [{ id: "home", name: "Home", spec: { root: "root", elements: { root: { type: "Text", props: { text: "before" } } } } }],
  ...overrides,
});
const revision = (rev: number, value: PrototypeDoc, extra: Partial<PrototypeRevisionForDiff> = {}): PrototypeRevisionForDiff => ({
  rev, doc: value, message: null, createdAt: `2026-07-15T00:00:0${rev}.000Z`, builtinCatalogHash: "catalog", componentManifestHash: "manifest", designSystemMetaVersion: 1, components: [], assets: [], ...extra,
});

describe("diffPrototypeDocs", () => {
  test("returns stable entry-array diffs and complete static counters", () => {
    const after = doc({
      name: "After", state: { count: 1, enabled: true },
      screens: [{ id: "home", name: "Main", spec: { root: "root", elements: {
        root: { type: "Text", props: { text: "after" }, children: ["child"] },
        child: { type: "Button", props: {} },
      } } }],
    });
    expect(diffPrototypeDocs(revision(1, doc()), revision(2, after))).toEqual({
      prototypeId: "proto",
      from: { rev: 1, message: { value: null }, createdAt: "2026-07-15T00:00:01.000Z" },
      to: { rev: 2, message: { value: null }, createdAt: "2026-07-15T00:00:02.000Z" },
      doc: [{ key: "name", from: { value: "Before" }, to: { value: "After" } }],
      state: { added: [{ key: "enabled", value: { value: true } }], changed: [{ key: "count", from: { value: 0 }, to: { value: 1 } }] },
      screens: { changed: [{ id: "home", meta: [{ key: "name", from: { value: "Home" }, to: { value: "Main" } }], elements: {
        added: [{ id: "child", type: "Button" }],
        changed: [{ id: "root", props: { changed: [{ key: "text", from: { value: "before" }, to: { value: "after" } }] }, children: { from: { missing: true }, to: { value: ["child"] } } }],
      } }] },
      summary: { screensAdded: 0, screensRemoved: 0, screensChanged: 1, staticElementsAdded: 1, staticElementsRemoved: 0, staticElementsChanged: 1, identical: false, docIdentical: false, truncated: false, omittedSections: [] },
    });
  });

  test("canonicalizes object keys safely and preserves __proto__/constructor entries", () => {
    const beforeProps = JSON.parse('{"__proto__":1,"constructor":2,"nested":{"b":1,"a":2}}');
    const afterProps = JSON.parse('{"__proto__":3,"constructor":4,"nested":{"a":2,"b":1}}');
    const a = doc(); a.screens[0]!.spec.elements.root!.props = beforeProps;
    const b = doc(); b.screens[0]!.spec.elements.root!.props = afterProps;
    const result = diffPrototypeDocs(revision(1, a), revision(2, b)) as any;
    expect(result.screens.changed[0].elements.changed[0].props.changed.map((x: any) => x.key)).toEqual(["__proto__", "constructor"]);
    expect(Object.keys(safeCanonicalize(JSON.parse('{"constructor":1,"__proto__":2}')) as object)).toEqual(["__proto__", "constructor"]);
  });

  test("treats directives/repeat/slot as opaque values and array order as significant", () => {
    const a = doc(), b = doc();
    a.screens[0]!.spec.elements.root = { type: "Box", props: { value: { $cond: { if: { $state: "/ok" }, then: { $asset: "a" } } } }, children: ["a", "b"], repeat: { statePath: "/old", key: "id" }, slot: "body" };
    b.screens[0]!.spec.elements.root = { type: "Box", props: { value: { $cond: { if: { $state: "/ok" }, then: { $asset: "b" } } } }, children: ["b", "a"], repeat: { statePath: "/new", key: "key" }, slot: "footer" };
    const changed = (diffPrototypeDocs(revision(1,a), revision(2,b)) as any).screens.changed[0].elements.changed[0];
    expect(changed.props.changed[0].key).toBe("value");
    expect(changed.children).toBeDefined(); expect(changed.repeat).toBeDefined(); expect(changed.slot).toBeDefined();
  });

  test("computes identity before truncation and includes render inputs and pins", () => {
    const a = revision(1, doc(), { message: "a".repeat(1000), components: [{ id: "x", version: 1 }] });
    const b = revision(2, doc(), { message: "b".repeat(1000), components: [{ id: "x", version: 1 }], designSystemMetaVersion: 2 });
    const result = diffPrototypeDocs(a, b) as any;
    expect(result.summary).toMatchObject({ docIdentical: true, identical: false, truncated: true });
    expect(result.renderInputs).toEqual([{ key: "designSystemMetaVersion", from: { value: 1 }, to: { value: 2 } }]);
    expect(result.from.message.truncated.preview.length).toBeLessThanOrEqual(120);
  });

  test("bounds every string, applies the global budget, and enforces the UTF-8 byte cap", () => {
    const a = doc(), b = doc();
    const hugeKey = "ключ😀".repeat(20_000), hugeType = "тип😀".repeat(20_000);
    a.screens[0]!.spec.elements.root!.props = { [hugeKey]: 0, ...Object.fromEntries(Array.from({ length: 700 }, (_, i) => [`key-${i}`, i])) };
    b.screens[0]!.spec.elements.root = { type: hugeType, props: { [hugeKey]: 1, ...Object.fromEntries(Array.from({ length: 700 }, (_, i) => [`key-${i}`, i + 1])) } };
    const result = diffPrototypeDocs(revision(1,a,{message:"😀".repeat(100_000)}), revision(2,b,{message:"\u0000".repeat(100_000)}));
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(256 * 1024);
    expect((result as any).summary.truncated).toBe(true);
    expect((result as any).summary.omittedSections).toContain("props");
  });

  test("emits screenOrder only for reorder and omits orders over 100 entries", () => {
    const screens = Array.from({length: 101}, (_, i) => ({ id: `s${i}`, name: `S${i}`, spec: { root: "r", elements: { r: { type: "Text", props: {} } } } }));
    const a = doc({ startScreen: "s0", screens }), b = doc({ startScreen: "s0", screens: [...screens].reverse() });
    const result = diffPrototypeDocs(revision(1,a), revision(2,b)) as any;
    expect(result.screenOrder).toEqual({ omitted: true });
    expect(result.summary.omittedSections).toContain("screenOrder");
  });

  test("reports flows in a dedicated diff section", () => {
    const before = doc();
    const after = doc({
      flows: [{ id: "main", name: "Main", steps: [{ screenId: "home" }] }],
    });
    const result = diffPrototypeDocs(revision(1, before), revision(2, after)) as any;
    expect(result.flows).toEqual({
      from: { missing: true },
      to: { value: [{ id: "main", name: "Main", steps: [{ screenId: "home" }] }] },
    });
    expect(result.doc).toBeUndefined();
    expect(result.summary).toMatchObject({ docIdentical: false, identical: false });
  });

  test("accounts for and omits the flows section under the leaf budget", () => {
    const before = doc();
    const after = doc({
      flows: [{ id: "main", name: "Main", steps: [{ screenId: "home" }] }],
    });
    const result = diffPrototypeDocs(revision(1, before), revision(2, after), { leafBudget: 0 }) as any;
    expect(result.flows).toEqual({ omitted: true });
    expect(result.summary).toMatchObject({ truncated: true, omittedSections: ["flows"] });
  });
});
