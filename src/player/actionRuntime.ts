import type { StateModel, StateStore } from "@json-render/react";
import type { Spec } from "@json-render/core";
import type { PlayerRuntimeDeps } from "../catalog/runtime";
import { createHardenedStore } from "../prototype/hardenedStore";
import { getAtPointer, isSafeJsonPointer } from "../prototype/pointer";
import { computeRenderCost, REPEAT_RENDER_COST_BUDGET } from "../prototype/renderCost";
import type { InspectorActionResult, InspectorLogger } from "./inspector/log";

export interface EmitContext {
  event: string;
  /** Deep-frozen payload delivered to actions via `$event`. */
  payload: unknown;
  elementId: string;
  itemIndex?: number;
  itemKey?: unknown;
  /** Inspector correlation id assigned synchronously on emit. */
  correlationId?: string;
}

export interface RawAction {
  action: string;
  params?: Record<string, unknown>;
  preventDefault?: boolean;
  $if?: unknown;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Resolves an `$event`/`$elementId`/`$itemIndex`/`$itemKey` param source, or a nested literal. */
export function resolveParamValue(value: unknown, ctx: EmitContext): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveParamValue(item, ctx));
  if (!isObject(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 1) {
    const key = keys[0]!;
    if (key === "$event") {
      const pointer = value.$event;
      if (pointer === "" || pointer === undefined) return ctx.payload;
      if (typeof pointer === "string") return getAtPointer(ctx.payload, pointer).value;
      return undefined;
    }
    if (key === "$elementId" && value.$elementId === true) return ctx.elementId;
    if (key === "$itemIndex" && value.$itemIndex === true) return ctx.itemIndex;
    if (key === "$itemKey" && value.$itemKey === true) return ctx.itemKey;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveParamValue(item, ctx)]));
}

function resolveConditionOperand(subject: unknown, ctx: EmitContext): unknown {
  if (isObject(subject) && Object.keys(subject).length === 1 && "$event" in subject) {
    return resolveParamValue(subject, ctx);
  }
  return undefined;
}

/**
 * Evaluates an action `$if` condition (v1 condition grammar restricted to the
 * `{$event}` operand plus eq/neq/truthiness). Returns `true` when the action
 * should run. Malformed conditions default to running the action closed-safe? No:
 * a malformed `$if` is a validation error, so at runtime we treat unknown as false.
 */
export function evaluateActionCondition(condition: unknown, ctx: EmitContext): boolean {
  if (typeof condition === "boolean") return condition;
  if (!isObject(condition)) return false;
  if ("$and" in condition && Array.isArray(condition.$and)) return condition.$and.every((c) => evaluateActionCondition(c, ctx));
  if ("$or" in condition && Array.isArray(condition.$or)) return condition.$or.some((c) => evaluateActionCondition(c, ctx));
  if (!("$event" in condition)) return false;
  const actual = resolveConditionOperand({ $event: condition.$event }, ctx);
  let result: boolean;
  if ("eq" in condition) result = actual === condition.eq;
  else if ("neq" in condition) result = actual !== condition.neq;
  else result = Boolean(actual);
  return condition.not === true ? !result : result;
}

export interface EasyUiActionRuntimeOptions {
  initialState: StateModel;
  screenIds: ReadonlySet<string>;
  deps: PlayerRuntimeDeps;
  onError?: (message: string, detail?: Record<string, unknown>) => void;
  /** Optional inspector logger (plan H.1). Behavior is unchanged when omitted. */
  logger?: InspectorLogger;
}

/**
 * Hardened action runtime for custom-component events. Owns the state store
 * (safe pointers + render-cost budget), resolves terminal navigation against
 * the document's known screen ids, and executes state actions directly on the
 * store (never via the library's `execute`, which would re-resolve `$` keys).
 */
export class EasyUiActionRuntime {
  readonly store: StateStore;
  /** Inspector logger shared with the event adapter (read via runtime context). */
  readonly logger: InspectorLogger | undefined;
  private readonly screenIds: ReadonlySet<string>;
  private readonly deps: PlayerRuntimeDeps;
  private readonly onError: (message: string, detail?: Record<string, unknown>) => void;
  private currentSpec: Spec | null = null;
  /** True while a dispatched state action mutates the store (suppresses the store-level log). */
  private inDispatchMutation = false;

  constructor(options: EasyUiActionRuntimeOptions) {
    this.screenIds = options.screenIds;
    this.deps = options.deps;
    this.logger = options.logger;
    const report = options.onError ?? (() => {});
    this.onError = (message, detail) => {
      this.logger?.logRuntimeError(message, detail);
      report(message, detail);
    };
    const store = createHardenedStore(options.initialState, {
      guard: (next) => this.withinBudget(next),
      onError: (message) => this.onError(message),
    });
    this.store = this.logger ? this.instrumentStore(store, this.logger) : store;
  }

  /**
   * Wraps the store so mutations that do not come from {@link dispatch} (builtin
   * component actions executed by the library) still land in the inspector as
   * `setState` entries with a store-level prev/next diff.
   */
  private instrumentStore(store: StateStore, logger: InspectorLogger): StateStore {
    const logSet = (statePath: string, previous: unknown, next: unknown): void => {
      if (this.inDispatchMutation || previous === next) return;
      logger.logAction({ correlationId: "", action: "setState", params: { statePath }, result: { type: "state", statePath, previous, next } });
    };
    return {
      ...store,
      set: (path, value) => {
        const previous = store.get(path);
        store.set(path, value);
        logSet(path, previous, store.get(path));
      },
      update: (updates) => {
        const before = Object.keys(updates).map((path) => [path, store.get(path)] as const);
        store.update(updates);
        for (const [path, previous] of before) logSet(path, previous, store.get(path));
      },
    };
  }

  private logAction(ctx: EmitContext, action: string, params: Record<string, unknown>, result: InspectorActionResult): void {
    this.logger?.logAction({ correlationId: ctx.correlationId ?? "", action, params, result });
  }

  /** Runs a store mutation with the store-level inspector log muted (dispatch logs richer entries itself). */
  private mutate(fn: () => void): void {
    this.inDispatchMutation = true;
    try { fn(); } finally { this.inDispatchMutation = false; }
  }

  private withinBudget(state: StateModel): boolean {
    if (!this.currentSpec) return true;
    return computeRenderCost(this.currentSpec, this.currentSpec.root, state) <= REPEAT_RENDER_COST_BUDGET;
  }

  /** Registers the current screen tree for the mutation cost guard. */
  setScreenSpec(spec: Spec | null): void {
    this.currentSpec = spec;
  }

  private async dispatchOne(action: RawAction, ctx: EmitContext): Promise<void> {
    if (action.$if !== undefined && !evaluateActionCondition(action.$if, ctx)) {
      if (this.logger) {
        const params = action.params ? (resolveParamValue(action.params, ctx) as Record<string, unknown>) : {};
        this.logAction(ctx, action.action, params, { type: "skipped" });
      }
      return;
    }
    const params = action.params ? (resolveParamValue(action.params, ctx) as Record<string, unknown>) : {};
    switch (action.action) {
      case "setState": {
        if (typeof params.statePath === "string") {
          const statePath = params.statePath;
          const previous = this.store.get(statePath);
          this.mutate(() => this.store.set(statePath, params.value));
          this.logAction(ctx, "setState", params, { type: "state", statePath, previous, next: this.store.get(statePath) });
        }
        return;
      }
      case "pushState": {
        if (typeof params.statePath === "string") {
          const statePath = params.statePath;
          const arr = this.store.get(statePath);
          const base = Array.isArray(arr) ? arr : [];
          const previous = arr;
          this.mutate(() => {
            this.store.set(statePath, [...base, params.value]);
            if (typeof params.clearStatePath === "string") this.store.set(params.clearStatePath, "");
          });
          this.logAction(ctx, "pushState", params, { type: "state", statePath, previous, next: this.store.get(statePath) });
        }
        return;
      }
      case "removeState": {
        if (typeof params.statePath !== "string") return;
        const statePath = params.statePath;
        const index = params.index;
        const arr = this.store.get(statePath);
        if (!Array.isArray(arr)) return;
        if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= arr.length) {
          const message = `removeState index out of range: ${String(index)}`;
          this.onError(message, { statePath });
          this.logAction(ctx, "removeState", params, { type: "error", message });
          return;
        }
        const previous = arr;
        this.mutate(() => this.store.set(statePath, arr.filter((_, i) => i !== index)));
        this.logAction(ctx, "removeState", params, { type: "state", statePath, previous, next: this.store.get(statePath) });
        return;
      }
      case "navigate": {
        const screenId = params.screenId;
        if (typeof screenId !== "string" || !this.screenIds.has(screenId)) {
          const message = `navigate target does not exist: ${String(screenId)}`;
          this.onError(message);
          this.logAction(ctx, "navigate", params, { type: "error", message });
          return;
        }
        this.logAction(ctx, "navigate", params, { type: "nav", target: screenId });
        await this.deps.navigate(screenId);
        return;
      }
      case "back": {
        this.logAction(ctx, "back", params, { type: "nav", target: "(back)" });
        await this.deps.back();
        return;
      }
      case "restart": {
        this.logAction(ctx, "restart", params, { type: "nav", target: "(restart)" });
        await this.deps.restart();
        return;
      }
      case "openUrl": {
        if (typeof params.url === "string") {
          this.logAction(ctx, "openUrl", params, { type: "url", url: params.url });
          await this.deps.openUrl(params.url);
        }
        return;
      }
      default: {
        const message = `unknown action: ${action.action}`;
        this.onError(message);
        this.logAction(ctx, action.action, params, { type: "error", message });
      }
    }
  }

  /** Executes an event's action bindings in order, resolving param sources and `$if`. */
  async dispatch(bindings: RawAction | RawAction[] | undefined, ctx: EmitContext): Promise<void> {
    if (!bindings) return;
    const list = Array.isArray(bindings) ? bindings : [bindings];
    for (const action of list) await this.dispatchOne(action, ctx);
  }

  /** Whether an event's bindings request preventDefault (for `on()` compatibility). */
  static shouldPreventDefault(bindings: RawAction | RawAction[] | undefined): boolean {
    if (!bindings) return false;
    const list = Array.isArray(bindings) ? bindings : [bindings];
    return list.some((action) => action.preventDefault === true);
  }
}

export { REPEAT_RENDER_COST_BUDGET, isSafeJsonPointer };
