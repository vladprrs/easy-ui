import { describe, expect, it, vi } from "vitest";
import { EasyUiActionRuntime, type EmitContext } from "../actionRuntime";
import { InspectorLog, type InspectorEntry } from "../inspector/log";

const ctx = (over: Partial<EmitContext> = {}): EmitContext =>
  ({ event: "press", payload: { value: 7 }, elementId: "el", correlationId: "e1", ...over });

function runtimeWith(initialState: Record<string, unknown> = {}, screenIds = new Set(["home", "next"])) {
  const log = new InspectorLog();
  const onError = vi.fn();
  const deps = { navigate: vi.fn(), back: vi.fn(), openUrl: vi.fn(), restart: vi.fn() };
  const runtime = new EasyUiActionRuntime({ initialState, screenIds, deps, onError, logger: log });
  return { runtime, log, deps, onError };
}

const actions = (log: InspectorLog): Extract<InspectorEntry, { kind: "action" }>[] =>
  log.getSnapshot().filter((entry): entry is Extract<InspectorEntry, { kind: "action" }> => entry.kind === "action");

describe("EasyUiActionRuntime inspector decoration", () => {
  it("logs setState with resolved params and a prev/next diff", async () => {
    const { runtime, log } = runtimeWith({ selectedMethod: "sbp" });
    await runtime.dispatch({ action: "setState", params: { statePath: "/selectedMethod", value: { $event: "/value" } } }, ctx({ payload: { value: "pay-card" } }));
    expect(actions(log)).toEqual([expect.objectContaining({
      correlationId: "e1",
      action: "setState",
      params: { statePath: "/selectedMethod", value: "pay-card" },
      result: { type: "state", statePath: "/selectedMethod", previous: "sbp", next: "pay-card" },
    })]);
  });

  it("logs pushState/removeState state diffs", async () => {
    const { runtime, log } = runtimeWith({ list: [10, 20] });
    await runtime.dispatch({ action: "pushState", params: { statePath: "/list", value: 30 } }, ctx());
    await runtime.dispatch({ action: "removeState", params: { statePath: "/list", index: 0 } }, ctx());
    const [push, remove] = actions(log);
    expect(push!.result).toEqual({ type: "state", statePath: "/list", previous: [10, 20], next: [10, 20, 30] });
    expect(remove!.result).toEqual({ type: "state", statePath: "/list", previous: [10, 20, 30], next: [20, 30] });
  });

  it("logs a skipped entry when $if is false", async () => {
    const { runtime, log } = runtimeWith({ count: 0 });
    await runtime.dispatch({ action: "setState", $if: { $event: "/ok", eq: true }, params: { statePath: "/count", value: 5 } }, ctx({ payload: { ok: false } }));
    expect(actions(log)).toEqual([expect.objectContaining({ action: "setState", result: { type: "skipped" } })]);
    expect(runtime.store.get("/count")).toBe(0);
  });

  it("logs navigation, terminal actions and openUrl", async () => {
    const { runtime, log } = runtimeWith();
    await runtime.dispatch([
      { action: "navigate", params: { screenId: "next" } },
    ], ctx());
    await runtime.dispatch({ action: "back" }, ctx());
    await runtime.dispatch({ action: "openUrl", params: { url: "https://example.com" } }, ctx());
    expect(actions(log).map((entry) => entry.result)).toEqual([
      { type: "nav", target: "next" },
      { type: "nav", target: "(back)" },
      { type: "url", url: "https://example.com" },
    ]);
  });

  it("logs runtime errors: unknown navigate target and removeState out of range", async () => {
    const { runtime, log, onError } = runtimeWith({ list: [1] });
    await runtime.dispatch({ action: "navigate", params: { screenId: "ghost" } }, ctx());
    await runtime.dispatch({ action: "removeState", params: { statePath: "/list", index: 9 } }, ctx());
    const errorsInLedger = actions(log).filter((entry) => entry.result.type === "error");
    expect(errorsInLedger).toHaveLength(2);
    const runtimeErrors = log.getSnapshot().filter((entry) => entry.kind === "runtime-error");
    expect(runtimeErrors.map((entry) => entry.message)).toEqual([
      "navigate target does not exist: ghost",
      "removeState index out of range: 9",
    ]);
    expect(onError).toHaveBeenCalledTimes(2); // existing reports still delivered
  });

  it("logs builtin store mutations (set/update outside dispatch) with a store-level diff", () => {
    const { runtime, log } = runtimeWith({ name: "Ada", a: 1 });
    runtime.store.set("/name", "Lin");
    runtime.store.update({ "/a": 2, "/b": 3 });
    runtime.store.set("/name", "Lin"); // unchanged: not logged
    expect(actions(log)).toEqual([
      expect.objectContaining({ correlationId: "", action: "setState", result: { type: "state", statePath: "/name", previous: "Ada", next: "Lin" } }),
      expect.objectContaining({ result: { type: "state", statePath: "/a", previous: 1, next: 2 } }),
      expect.objectContaining({ result: { type: "state", statePath: "/b", previous: undefined, next: 3 } }),
    ]);
  });

  it("does not double-log dispatched state actions through the store wrapper", async () => {
    const { runtime, log } = runtimeWith({ count: 0 });
    await runtime.dispatch({ action: "setState", params: { statePath: "/count", value: 1 } }, ctx());
    expect(actions(log)).toHaveLength(1);
  });

  it("keeps behavior identical without a logger", async () => {
    const deps = { navigate: vi.fn(), back: vi.fn(), openUrl: vi.fn(), restart: vi.fn() };
    const runtime = new EasyUiActionRuntime({ initialState: { count: 0 }, screenIds: new Set(["next"]), deps });
    await runtime.dispatch({ action: "setState", params: { statePath: "/count", value: 2 } }, ctx());
    expect(runtime.store.get("/count")).toBe(2);
    expect(runtime.logger).toBeUndefined();
  });
});
