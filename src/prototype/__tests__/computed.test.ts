import { describe, expect, it } from "vitest";
import { applyComputed, computedKeys, evaluateComputed, isComputedPath } from "../computed";
import {
  COMPUTED_ENTRIES_LIMIT,
  COMPUTED_FIELDS_LIMIT,
  COMPUTED_TERMS_LIMIT,
  inputPrototypeDocSchema,
  storedPrototypeDocSchema,
} from "../schema";

const cart = [
  { id: "a", price: 1000, qty: 2 },
  { id: "b", price: 250, qty: 3 },
];

describe("evaluateComputed — operations (D2)", () => {
  it("counts array items and yields 0 for a non-array or missing source", () => {
    expect(evaluateComputed({ cart }, { n: { op: "count", from: "/cart" } })).toEqual({ n: 2 });
    expect(evaluateComputed({ cart: 5 }, { n: { op: "count", from: "/cart" } })).toEqual({ n: 0 });
    expect(evaluateComputed({}, { n: { op: "count", from: "/missing" } })).toEqual({ n: 0 });
    expect(evaluateComputed({ a: { b: [1, 2, 3] } }, { n: { op: "count", from: "/a/b" } })).toEqual({ n: 3 });
  });

  it("sums a field, and sums items themselves without `field`", () => {
    expect(evaluateComputed({ cart }, { s: { op: "sum", from: "/cart", field: "price" } })).toEqual({ s: 1250 });
    expect(evaluateComputed({ nums: [1, 2, 3.5] }, { s: { op: "sum", from: "/nums" } })).toEqual({ s: 6.5 });
    expect(evaluateComputed({ nested: [{ a: { b: 4 } }, { a: { b: 6 } }] }, { s: { op: "sum", from: "/nested", field: "a/b" } })).toEqual({ s: 10 });
  });

  it("sums products of 2..4 fields", () => {
    expect(evaluateComputed({ cart }, { s: { op: "sumProduct", from: "/cart", fields: ["price", "qty"] } })).toEqual({ s: 2750 });
    expect(evaluateComputed(
      { rows: [{ a: 2, b: 3, c: 4 }] },
      { s: { op: "sumProduct", from: "/rows", fields: ["a", "b", "c"] } },
    )).toEqual({ s: 24 });
  });

  it("adds pointer terms, literals and negative discounts", () => {
    const state = { subtotal: 2750, shipping: 300 };
    expect(evaluateComputed(state, { t: { op: "add", terms: ["/subtotal", "/shipping", -500] } })).toEqual({ t: 2550 });
    expect(evaluateComputed({}, { t: { op: "add", terms: [10, 32] } })).toEqual({ t: 42 });
    expect(evaluateComputed({ a: 5 }, { t: { op: "add", terms: ["/a", "/missing"] } })).toEqual({ t: 5 });
  });
});

describe("evaluateComputed — numeric semantics (D3)", () => {
  it("counts only finite numbers, otherwise the item contributes 0", () => {
    const state = { rows: [{ p: 10 }, { p: "20" }, { p: null }, {}, { p: Number.NaN }, 7] };
    expect(evaluateComputed(state, { s: { op: "sum", from: "/rows", field: "p" } })).toEqual({ s: 10 });
    expect(evaluateComputed({ rows: [1, "2", null, { a: 1 }, 3] }, { s: { op: "sum", from: "/rows" } })).toEqual({ s: 4 });
  });

  it("zeroes the whole item in sumProduct when any field is missing or non-numeric (not ×1)", () => {
    const state = {
      rows: [
        { price: 100, qty: 2 },
        { price: 100 },
        { price: 100, qty: "2" },
        { price: 100, qty: null },
      ],
    };
    expect(evaluateComputed(state, { s: { op: "sumProduct", from: "/rows", fields: ["price", "qty"] } })).toEqual({ s: 200 });
  });

  it("treats non-finite terms and totals as 0 without coercing strings", () => {
    expect(evaluateComputed({ a: Number.POSITIVE_INFINITY, b: 5 }, { t: { op: "add", terms: ["/a", "/b"] } })).toEqual({ t: 5 });
    expect(evaluateComputed({}, { t: { op: "add", terms: [Number.NaN, 3] } })).toEqual({ t: 3 });
    expect(evaluateComputed({ rows: [{ p: Number.POSITIVE_INFINITY }, { p: 2 }] }, { s: { op: "sum", from: "/rows", field: "p" } })).toEqual({ s: 2 });
    // Infinity accumulated through a product also collapses to 0 for that item.
    expect(evaluateComputed(
      { rows: [{ a: Number.MAX_VALUE, b: Number.MAX_VALUE }, { a: 2, b: 3 }] },
      { s: { op: "sumProduct", from: "/rows", fields: ["a", "b"] } },
    )).toEqual({ s: 6 });
    // Strings are never coerced.
    expect(evaluateComputed({ a: "5", b: 1 }, { t: { op: "add", terms: ["/a", "/b"] } })).toEqual({ t: 1 });
  });
});

describe("evaluateComputed — order and references (D4)", () => {
  it("evaluates in key order and lets later entries read earlier keys", () => {
    const spec = {
      subtotal: { op: "sumProduct", from: "/cart", fields: ["price", "qty"] },
      shipping: { op: "add", terms: ["/shippingFee", 0] },
      total: { op: "add", terms: ["/subtotal", "/shipping", -250] },
    };
    const values = evaluateComputed({ cart, shippingFee: 300 }, spec);
    expect(values).toEqual({ subtotal: 2750, shipping: 300, total: 2800 });
    expect(Object.keys(values)).toEqual(["subtotal", "shipping", "total"]);
  });

  it("yields 0 for a forward reference to a not-yet-computed key", () => {
    const spec = {
      total: { op: "add", terms: ["/subtotal", 100] },
      subtotal: { op: "count", from: "/cart" },
    };
    expect(evaluateComputed({ cart }, spec)).toEqual({ total: 100, subtotal: 2 });
  });

  it("does not mutate the input state", () => {
    const state = { cart: [{ price: 5, qty: 2 }] };
    const frozen = JSON.parse(JSON.stringify(state));
    evaluateComputed(state, { n: { op: "count", from: "/cart" }, s: { op: "sum", from: "/cart", field: "price" } });
    expect(state).toEqual(frozen);
    expect("n" in state).toBe(false);
  });
});

describe("evaluateComputed — defensive against the stored form", () => {
  it("returns 0 for non-object entries and unknown ops without throwing", () => {
    const spec = {
      a: null,
      b: 42,
      c: [1, 2],
      d: "count",
      e: { op: "avg", from: "/cart" },
      f: {},
      g: { op: "count" },
      h: { op: "sumProduct", from: "/cart", fields: [] },
      i: { op: "add" },
      j: { op: "add", terms: "nope" },
    };
    expect(() => evaluateComputed({ cart }, spec)).not.toThrow();
    expect(evaluateComputed({ cart }, spec)).toEqual({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, g: 0, h: 0, i: 0, j: 0 });
  });

  it("tolerates a non-object state and a non-object spec", () => {
    expect(evaluateComputed(null, { n: { op: "count", from: "/cart" } })).toEqual({ n: 0 });
    expect(evaluateComputed({ cart }, null)).toEqual({});
    expect(evaluateComputed({ cart }, undefined)).toEqual({});
    expect(evaluateComputed({ cart }, [] as unknown as Record<string, unknown>)).toEqual({});
  });
});

describe("applyComputed / computedKeys / isComputedPath", () => {
  it("returns the identical state reference for an empty or absent spec", () => {
    const state = { cart };
    expect(applyComputed(state, undefined)).toBe(state);
    expect(applyComputed(state, null)).toBe(state);
    expect(applyComputed(state, {})).toBe(state);
  });

  it("seeds computed values on a copy, leaving the input untouched", () => {
    const state = { cart, shippingFee: 300 };
    const seeded = applyComputed(state, { cartCount: { op: "count", from: "/cart" } });
    expect(seeded).not.toBe(state);
    expect(seeded).toEqual({ cart, shippingFee: 300, cartCount: 2 });
    expect("cartCount" in state).toBe(false);
  });

  it("lists keys in declaration order and tolerates junk specs", () => {
    expect(computedKeys({ b: 1, a: 2 })).toEqual(["b", "a"]);
    expect(computedKeys(undefined)).toEqual([]);
    expect(computedKeys(null)).toEqual([]);
  });

  it("matches computed pointers by prefix", () => {
    const keys = ["cartTotal", "cart_count"];
    expect(isComputedPath("/cartTotal", keys)).toBe(true);
    expect(isComputedPath("/cartTotal/deep/0", keys)).toBe(true);
    expect(isComputedPath("/cart_count", keys)).toBe(true);
    expect(isComputedPath("/cartTotalX", keys)).toBe(false);
    expect(isComputedPath("/cart", keys)).toBe(false);
    expect(isComputedPath("/", keys)).toBe(false);
    expect(isComputedPath("", keys)).toBe(false);
    expect(isComputedPath("/cartTotal", [])).toBe(false);
  });
});

const screen = (id: string) => ({
  id,
  name: id,
  spec: { root: "root", elements: { root: { type: "Text", props: { text: id } } } },
});

function doc(computed?: unknown) {
  return {
    version: 1,
    id: "computed-test",
    name: "Computed test",
    designSystem: "shadcn",
    startScreen: "home",
    state: { cart: [], shippingFee: 300 },
    screens: [screen("home")],
    ...(computed === undefined ? {} : { computed }),
  };
}

const validSpec = {
  cartCount: { op: "count", from: "/cart" },
  cartItems: { op: "sum", from: "/cart", field: "qty" },
  cartSubtotal: { op: "sumProduct", from: "/cart", fields: ["price", "qty"] },
  cartTotal: { op: "add", terms: ["/cartSubtotal", "/shippingFee", -500] },
};

const inputIssues = (computed: unknown) => {
  const result = inputPrototypeDocSchema.safeParse(doc(computed));
  return result.success ? [] : result.error.issues;
};

const entries = (count: number) =>
  Object.fromEntries(Array.from({ length: count }, (_, index) => [`k${index}`, { op: "count", from: "/cart" }]));

describe("computed schema — input branch", () => {
  it("accepts a document with all four ops and one without computed at all", () => {
    expect(inputPrototypeDocSchema.safeParse(doc(validSpec)).success).toBe(true);
    expect(inputPrototypeDocSchema.safeParse(doc()).success).toBe(true);
  });

  it("preserves the declaration order of keys after parse", () => {
    const parsed = inputPrototypeDocSchema.parse(doc(validSpec));
    expect(Object.keys(parsed.computed!)).toEqual(Object.keys(validSpec));
  });

  it("rejects the 21st entry — in a document without flows", () => {
    expect(inputPrototypeDocSchema.safeParse(doc(entries(COMPUTED_ENTRIES_LIMIT))).success).toBe(true);
    const issues = inputIssues(entries(COMPUTED_ENTRIES_LIMIT + 1));
    expect(issues.some((issue) => issue.path.join("/") === "computed" && /limit of 20 entries/.test(issue.message))).toBe(true);
  });

  it("rejects too many fields and too many terms", () => {
    expect(inputIssues({ x: { op: "sumProduct", from: "/cart", fields: ["a", "b", "c", "d", "e"] } }).length).toBeGreaterThan(0);
    expect(inputPrototypeDocSchema.safeParse(doc({
      x: { op: "sumProduct", from: "/cart", fields: Array.from({ length: COMPUTED_FIELDS_LIMIT }, (_, i) => `f${i}`) },
    })).success).toBe(true);
    expect(inputIssues({ x: { op: "add", terms: Array.from({ length: COMPUTED_TERMS_LIMIT + 1 }, () => 1) } }).length).toBeGreaterThan(0);
    expect(inputPrototypeDocSchema.safeParse(doc({
      x: { op: "add", terms: Array.from({ length: COMPUTED_TERMS_LIMIT }, () => 1) },
    })).success).toBe(true);
    expect(inputIssues({ x: { op: "add", terms: [1] } }).length).toBeGreaterThan(0);
    expect(inputIssues({ x: { op: "sumProduct", from: "/cart", fields: ["a"] } }).length).toBeGreaterThan(0);
  });

  it("rejects an unknown op and unknown entry fields", () => {
    expect(inputIssues({ x: { op: "avg", from: "/cart" } }).length).toBeGreaterThan(0);
    expect(inputIssues({ x: { op: "count", from: "/cart", field: "price" } }).length).toBeGreaterThan(0);
    expect(inputIssues({ x: { op: "count", from: "cart" } }).length).toBeGreaterThan(0);
  });

  it("rejects keys that are not bare identifiers", () => {
    for (const key of ["/cartTotal", "_x", "0x", "cart total", ""]) {
      expect(inputIssues({ [key]: { op: "count", from: "/cart" } }).length).toBeGreaterThan(0);
    }
    // `__proto__` приезжает own-property только через JSON.parse (присваивание трогало бы
    // прототип). zod вырезает такой ключ из record молча — до регекса дело не доходит,
    // но в разобранном документе его нет: ключ `__proto__` невозможен по построению (D1).
    const polluted = JSON.parse('{"__proto__": {"op": "count", "from": "/cart"}}') as Record<string, unknown>;
    const parsed = inputPrototypeDocSchema.parse(doc(polluted));
    expect(Object.getOwnPropertyNames(parsed.computed!)).toEqual([]);
  });
});

describe("computed schema — stored branch", () => {
  it("reads back anything a newer version could have written", () => {
    for (const computed of [
      entries(COMPUTED_ENTRIES_LIMIT + 1),
      { "/weird key~": { op: "count", from: "/cart" } },
      { x: { op: "avg", from: "/cart" } },
      { x: { op: "count", from: "/cart", round: 2 } },
      null,
      { a: 5, b: null, c: [1, 2], d: "count" },
      {},
    ]) {
      const result = storedPrototypeDocSchema.safeParse(doc(computed));
      expect(result.success, JSON.stringify(computed)).toBe(true);
    }
  });

  it("does not enforce authoring limits on stored documents", () => {
    const parsed = storedPrototypeDocSchema.parse(doc({ x: { op: "add", terms: Array.from({ length: 40 }, () => 1) } }));
    expect(parsed.computed).toBeDefined();
  });

  it("keeps the stored root strict", () => {
    expect(storedPrototypeDocSchema.safeParse({ ...doc(validSpec), unexpected: 1 }).success).toBe(false);
  });
});
