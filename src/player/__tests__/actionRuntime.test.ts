import { describe, expect, it, vi } from "vitest";
import type { Spec } from "@json-render/core";
import { EasyUiActionRuntime, evaluateActionCondition, resolveParamValue, type EmitContext } from "../actionRuntime";
import { createHardenedStore } from "../../prototype/hardenedStore";
import { freezeJsonSafePayload } from "../easyUiRuntime";

const ctx = (over: Partial<EmitContext> = {}): EmitContext => ({ event: "e", payload: { value: 7, nested: { id: "a" } }, elementId: "el", itemIndex: 2, itemKey: "k9", ...over });

describe("resolveParamValue", () => {
  it("resolves $event (whole payload, pointer), $elementId, $itemIndex, $itemKey", () => {
    expect(resolveParamValue({ $event: "" }, ctx())).toEqual({ value: 7, nested: { id: "a" } });
    expect(resolveParamValue({ $event: "/value" }, ctx())).toBe(7);
    expect(resolveParamValue({ $event: "/nested/id" }, ctx())).toBe("a");
    expect(resolveParamValue({ $elementId: true }, ctx())).toBe("el");
    expect(resolveParamValue({ $itemIndex: true }, ctx())).toBe(2);
    expect(resolveParamValue({ $itemKey: true }, ctx())).toBe("k9");
  });
  it("resolves sources nested inside literals", () => {
    expect(resolveParamValue({ a: [{ $event: "/value" }, 1], b: { c: { $itemIndex: true } } }, ctx())).toEqual({ a: [7, 1], b: { c: 2 } });
  });
});

describe("evaluateActionCondition", () => {
  it("evaluates $event truthiness, eq/neq, not, $and/$or", () => {
    expect(evaluateActionCondition({ $event: "/value" }, ctx())).toBe(true);
    expect(evaluateActionCondition({ $event: "/value", eq: 7 }, ctx())).toBe(true);
    expect(evaluateActionCondition({ $event: "/value", eq: 8 }, ctx())).toBe(false);
    expect(evaluateActionCondition({ $event: "/value", neq: 7 }, ctx())).toBe(false);
    expect(evaluateActionCondition({ $event: "/value", eq: 7, not: true }, ctx())).toBe(false);
    expect(evaluateActionCondition({ $and: [{ $event: "/value" }, true] }, ctx())).toBe(true);
    expect(evaluateActionCondition({ $or: [false, { $event: "/value", eq: 8 }] }, ctx())).toBe(false);
  });
});

function runtimeWith(deps = { navigate: vi.fn(), back: vi.fn(), openUrl: vi.fn(), restart: vi.fn() }, initialState: Record<string, unknown> = {}) {
  const runtime = new EasyUiActionRuntime({ initialState, screenIds: new Set(["home", "next"]), deps, onError: vi.fn() });
  return { runtime, deps };
}

describe("EasyUiActionRuntime.dispatch", () => {
  it("executes state actions directly on the store", async () => {
    const { runtime } = runtimeWith(undefined, { count: 1, list: [] });
    await runtime.dispatch({ action: "setState", params: { statePath: "/count", value: { $event: "/value" } } }, ctx());
    expect(runtime.store.get("/count")).toBe(7);
    await runtime.dispatch({ action: "pushState", params: { statePath: "/list", value: { $event: "/nested" } } }, ctx());
    expect(runtime.store.get("/list")).toEqual([{ id: "a" }]);
  });

  it("navigates only to known screens; unknown target is a no-op error", async () => {
    const { runtime, deps } = runtimeWith();
    await runtime.dispatch({ action: "navigate", params: { screenId: "next" } }, ctx());
    expect(deps.navigate).toHaveBeenCalledWith("next");
    await runtime.dispatch({ action: "navigate", params: { screenId: "ghost" } }, ctx());
    expect(deps.navigate).toHaveBeenCalledTimes(1);
  });

  it("removeState out of range / non-integer is a no-op", async () => {
    const { runtime } = runtimeWith(undefined, { list: [10, 20, 30] });
    await runtime.dispatch({ action: "removeState", params: { statePath: "/list", index: { $event: "/value" } } }, ctx({ payload: { value: 1 } }));
    expect(runtime.store.get("/list")).toEqual([10, 30]);
    await runtime.dispatch({ action: "removeState", params: { statePath: "/list", index: { $event: "/value" } } }, ctx({ payload: { value: 9 } }));
    expect(runtime.store.get("/list")).toEqual([10, 30]);
  });

  it("skips actions whose $if is false", async () => {
    const { runtime } = runtimeWith(undefined, { count: 0 });
    await runtime.dispatch({ action: "setState", $if: { $event: "/ok", eq: true }, params: { statePath: "/count", value: 5 } }, ctx({ payload: { ok: false } }));
    expect(runtime.store.get("/count")).toBe(0);
    await runtime.dispatch({ action: "setState", $if: { $event: "/ok", eq: true }, params: { statePath: "/count", value: 5 } }, ctx({ payload: { ok: true } }));
    expect(runtime.store.get("/count")).toBe(5);
  });

  it("rejects a mutation that would exceed the render-cost budget", async () => {
    const onError = vi.fn();
    const spec: Spec = { root: "r", elements: { r: { type: "L", props: {}, repeat: { statePath: "/rows" }, children: ["c"] }, c: { type: "T", props: {} } } };
    const runtime = new EasyUiActionRuntime({ initialState: { rows: [] }, screenIds: new Set(), deps: { navigate: vi.fn(), back: vi.fn(), openUrl: vi.fn(), restart: vi.fn() }, onError });
    runtime.setScreenSpec(spec);
    await runtime.dispatch({ action: "setState", params: { statePath: "/rows", value: Array.from({ length: 5000 }, () => 1) } }, ctx());
    expect(runtime.store.get("/rows")).toEqual([]); // rejected
    expect(onError).toHaveBeenCalled();
  });

  it("uses the full authored spec so repeat content inside Overlay stays in the mutation budget", async () => {
    const onError = vi.fn();
    const spec: Spec = {
      root: "root",
      elements: {
        root: { type: "Stack", props: {}, children: ["overlay"] },
        overlay: { type: "Overlay", props: { placement: "top" }, children: ["list"] },
        list: { type: "Stack", props: {}, repeat: { statePath: "/rows" }, children: ["item"] },
        item: { type: "Text", props: { text: "item" } },
      },
    };
    const runtime = new EasyUiActionRuntime({ initialState: { rows: [] }, screenIds: new Set(), deps: { navigate: vi.fn(), back: vi.fn(), openUrl: vi.fn(), restart: vi.fn() }, onError });
    runtime.setScreenSpec(spec);
    await runtime.dispatch({ action: "setState", params: { statePath: "/rows", value: Array.from({ length: 2500 }, () => 1) } }, ctx());
    expect(runtime.store.get("/rows")).toEqual([]);
    expect(onError).toHaveBeenCalled();
  });
});

describe("createHardenedStore", () => {
  it("rejects prototype-polluting pointers and builds null-prototype containers", () => {
    const onError = vi.fn();
    const store = createHardenedStore({}, { onError });
    store.set("/__proto__/polluted", true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(onError).toHaveBeenCalled();
    store.set("/a/b", 1);
    const snapshot = store.getSnapshot() as { a: Record<string, unknown> };
    expect(Object.getPrototypeOf(snapshot.a)).toBeNull();
    expect(snapshot.a.b).toBe(1);
  });
});

describe("createHardenedStore with computed", () => {
  const computed = {
    cartCount: { op: "count", from: "/cart" },
    cartSubtotal: { op: "sumProduct", from: "/cart", fields: ["price", "qty"] },
    cartTotal: { op: "add", terms: ["/cartSubtotal", "/shippingFee"] },
  };
  const initial = { cart: [{ price: 100, qty: 2 }], shippingFee: 500 };
  const storeWith = (onError = vi.fn()) => ({ store: createHardenedStore(initial, { computed, onError }), onError });

  it("seeds computed values at construction", () => {
    const { store } = storeWith();
    expect(store.get("/cartCount")).toBe(1);
    expect(store.get("/cartSubtotal")).toBe(200);
    expect(store.get("/cartTotal")).toBe(700);
  });

  it("recomputes before notify: the listener sees a consistent snapshot (set/push/remove)", () => {
    const { store } = storeWith();
    const seen: Record<string, unknown>[] = [];
    store.subscribe(() => {
      const snapshot = store.getSnapshot() as Record<string, unknown>;
      seen.push({ cart: snapshot.cart, cartCount: snapshot.cartCount, cartSubtotal: snapshot.cartSubtotal, cartTotal: snapshot.cartTotal });
    });
    store.set("/cart", [{ price: 100, qty: 2 }, { price: 50, qty: 1 }]); // push
    store.set("/cart/0/qty", 3);                                        // set inside an item
    store.set("/cart", [{ price: 50, qty: 1 }]);                        // remove
    expect(seen.map((snapshot) => [snapshot.cartCount, snapshot.cartSubtotal, snapshot.cartTotal])).toEqual([
      [2, 250, 750],
      [2, 350, 850],
      [1, 50, 550],
    ]);
  });

  it("updates an add-chain (subtotal → total) within a single notification", () => {
    const { store } = storeWith();
    const notifications = vi.fn();
    store.subscribe(notifications);
    store.set("/cart", [{ price: 100, qty: 2 }, { price: 100, qty: 1 }]);
    expect(notifications).toHaveBeenCalledTimes(1);
    expect(store.get("/cartSubtotal")).toBe(300);
    expect(store.get("/cartTotal")).toBe(800);
  });

  it("rejects a direct write to a computed path, reporting exactly one error", () => {
    const { store, onError } = storeWith();
    const notifications = vi.fn();
    store.subscribe(notifications);
    store.set("/cartTotal", 1);
    expect(store.get("/cartTotal")).toBe(700);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(notifications).not.toHaveBeenCalled();
    store.set("/cartTotal/nested", 1); // under a computed key — same rejection
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("applies a batch update partially when one entry targets a computed path", () => {
    const { store, onError } = storeWith();
    store.update({ "/shippingFee": 300, "/cartCount": 42 });
    expect(store.get("/shippingFee")).toBe(300);
    expect(store.get("/cartCount")).toBe(1); // recomputed, not the rejected literal
    expect(store.get("/cartTotal")).toBe(500);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("keeps null-prototype containers after a recompute", () => {
    const { store } = storeWith();
    store.set("/a/b", 1);
    const snapshot = store.getSnapshot() as Record<string, unknown>;
    expect(Object.getPrototypeOf(snapshot)).toBeNull();
    expect(Object.getPrototypeOf(snapshot.a as object)).toBeNull();
    expect(snapshot.cartTotal).toBe(700);
  });
});

describe("freezeJsonSafePayload", () => {
  it("accepts JSON-safe payloads and deep-freezes them", () => {
    const result = freezeJsonSafePayload({ a: 1, b: [{ c: "x" }] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.isFrozen(result.value)).toBe(true);
  });
  it("rejects $-prefixed keys and non-finite/non-JSON values", () => {
    expect(freezeJsonSafePayload({ $bad: 1 }).ok).toBe(false);
    expect(freezeJsonSafePayload({ nested: { $x: 1 } }).ok).toBe(false);
    expect(freezeJsonSafePayload(Number.POSITIVE_INFINITY).ok).toBe(false);
    expect(freezeJsonSafePayload(() => {}).ok).toBe(false);
  });
});
