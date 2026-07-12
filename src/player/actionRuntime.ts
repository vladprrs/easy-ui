import type { StateModel, StateStore } from "@json-render/react";
import type { Spec } from "@json-render/core";
import type { PlayerRuntimeDeps } from "../catalog/runtime";
import { createHardenedStore } from "../prototype/hardenedStore";
import { getAtPointer, isSafeJsonPointer } from "../prototype/pointer";
import { computeRenderCost, REPEAT_RENDER_COST_BUDGET } from "../prototype/renderCost";

export interface EmitContext {
  event: string;
  /** Deep-frozen payload delivered to actions via `$event`. */
  payload: unknown;
  elementId: string;
  itemIndex?: number;
  itemKey?: unknown;
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
}

/**
 * Hardened action runtime for custom-component events. Owns the state store
 * (safe pointers + render-cost budget), resolves terminal navigation against
 * the document's known screen ids, and executes state actions directly on the
 * store (never via the library's `execute`, which would re-resolve `$` keys).
 */
export class EasyUiActionRuntime {
  readonly store: StateStore;
  private readonly screenIds: ReadonlySet<string>;
  private readonly deps: PlayerRuntimeDeps;
  private readonly onError: (message: string, detail?: Record<string, unknown>) => void;
  private currentSpec: Spec | null = null;

  constructor(options: EasyUiActionRuntimeOptions) {
    this.screenIds = options.screenIds;
    this.deps = options.deps;
    this.onError = options.onError ?? (() => {});
    this.store = createHardenedStore(options.initialState, {
      guard: (next) => this.withinBudget(next),
      onError: (message) => this.onError(message),
    });
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
    if (action.$if !== undefined && !evaluateActionCondition(action.$if, ctx)) return;
    const params = action.params ? (resolveParamValue(action.params, ctx) as Record<string, unknown>) : {};
    switch (action.action) {
      case "setState": {
        if (typeof params.statePath === "string") this.store.set(params.statePath, params.value);
        return;
      }
      case "pushState": {
        if (typeof params.statePath === "string") {
          const arr = this.store.get(params.statePath);
          const base = Array.isArray(arr) ? arr : [];
          this.store.set(params.statePath, [...base, params.value]);
          if (typeof params.clearStatePath === "string") this.store.set(params.clearStatePath, "");
        }
        return;
      }
      case "removeState": {
        if (typeof params.statePath !== "string") return;
        const index = params.index;
        const arr = this.store.get(params.statePath);
        if (!Array.isArray(arr)) return;
        if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= arr.length) {
          this.onError(`removeState index out of range: ${String(index)}`, { statePath: params.statePath });
          return;
        }
        this.store.set(params.statePath, arr.filter((_, i) => i !== index));
        return;
      }
      case "navigate": {
        const screenId = params.screenId;
        if (typeof screenId !== "string" || !this.screenIds.has(screenId)) {
          this.onError(`navigate target does not exist: ${String(screenId)}`);
          return;
        }
        await this.deps.navigate(screenId);
        return;
      }
      case "back": return void (await this.deps.back());
      case "restart": return void (await this.deps.restart());
      case "openUrl": {
        if (typeof params.url === "string") await this.deps.openUrl(params.url);
        return;
      }
      default:
        this.onError(`unknown action: ${action.action}`);
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
