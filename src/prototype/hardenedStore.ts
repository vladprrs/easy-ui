import type { StateModel, StateStore } from "@json-render/react";
import { parseJsonPointer } from "./pointer";
import { computedKeys, evaluateComputed, type ComputedSpecLike } from "./computed";

export interface HardenedStoreOptions {
  /**
   * Called with the prospective next state before a mutation is committed.
   * Return `false` to reject the mutation (it will not be applied).
   */
  guard?: (nextState: StateModel) => boolean;
  /** Reports a rejected or invalid mutation (unsafe pointer, budget, etc.). */
  onError?: (message: string) => void;
  /**
   * `doc.computed` — производные значения стейта (план
   * `docs/plans/2026-08-02-computed-state.md`). Сеются при конструировании и
   * пересчитываются в каждой коммитящейся мутации **до** `notify()`, поэтому
   * подписчик всегда видит согласованный снапшот. Записи в computed-ключи
   * отклоняются (read-only).
   */
  computed?: ComputedSpecLike;
}

const nullProtoObject = (): Record<string, unknown> => Object.create(null) as Record<string, unknown>;

/** Immutable set by safe, pre-parsed segments; intermediate objects are null-prototype. */
function safeSetBySegments(root: StateModel, segments: string[], value: unknown): StateModel {
  if (segments.length === 0) return root;
  const clone = (node: unknown): StateModel => {
    if (Array.isArray(node)) return [...node] as unknown as StateModel;
    if (node && typeof node === "object") return Object.assign(nullProtoObject(), node) as StateModel;
    return nullProtoObject() as StateModel;
  };
  const result = clone(root);
  let current: Record<string, unknown> | unknown[] = result as Record<string, unknown>;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    const nextSeg = segments[i + 1]!;
    const container = current as Record<string, unknown>;
    const child = container[seg];
    if (Array.isArray(child)) container[seg] = [...child];
    else if (child && typeof child === "object") container[seg] = Object.assign(nullProtoObject(), child);
    else container[seg] = /^\d+$/.test(nextSeg) ? [] : nullProtoObject();
    current = container[seg] as Record<string, unknown> | unknown[];
  }
  const last = segments[segments.length - 1]!;
  if (Array.isArray(current)) {
    if (last === "-") current.push(value);
    else current[parseInt(last, 10)] = value;
  } else {
    (current as Record<string, unknown>)[last] = value;
  }
  return result;
}

/**
 * A hardened {@link StateStore}. Rejects prototype-polluting pointers, builds
 * intermediate containers with a null prototype, and runs an optional cost
 * `guard` against the prospective state before committing each mutation.
 */
export function createHardenedStore(initialState: StateModel = {}, options: HardenedStoreOptions = {}): StateStore {
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  const { guard, onError, computed } = options;
  const derivedKeys = computedKeys(computed);

  /**
   * Пересчитывает computed поверх prospective-стейта. Запись — через
   * {@link safeSetBySegments}, чтобы сохранить null-prototype-инвариант
   * промежуточных контейнеров (спред в plain object его бы потерял).
   */
  const recompute = (next: StateModel): StateModel => {
    if (derivedKeys.length === 0) return next;
    const values = evaluateComputed(next, computed);
    let result = next;
    for (const key of derivedKeys) result = safeSetBySegments(result, [key], values[key]);
    return result;
  };

  let state: StateModel = recompute(Object.assign(nullProtoObject(), initialState) as StateModel);

  const getByPath = (path: string): unknown => {
    if (!path || path === "/") return state;
    const segments = parseJsonPointer(path);
    if (segments === null) return undefined;
    let current: unknown = state;
    for (const seg of segments) {
      if (Array.isArray(current)) {
        if (!/^\d+$/.test(seg)) return undefined;
        current = current[Number(seg)];
      } else if (current && typeof current === "object") {
        current = (current as Record<string, unknown>)[seg];
      } else return undefined;
    }
    return current;
  };

  const applyOne = (next: StateModel, path: string, value: unknown): StateModel | null => {
    const segments = parseJsonPointer(path);
    if (segments === null) { onError?.(`unsafe state path rejected: ${path}`); return null; }
    // computed — read-only: запись в ключ или под него отклоняется (D7-2).
    if (segments.length > 0 && derivedKeys.includes(segments[0]!)) {
      onError?.(`computed state path rejected: ${path}`);
      return null;
    }
    if (getByPath(path) === value) return next;
    return safeSetBySegments(next, segments, value);
  };

  return {
    get: getByPath,
    getSnapshot: () => state,
    getServerSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set(path, value) {
      const next = applyOne(state, path, value);
      if (next === null || next === state) return;
      if (guard && !guard(next)) { onError?.("mutation rejected: render-cost budget exceeded"); return; }
      state = recompute(next);
      notify();
    },
    update(updates) {
      let next: StateModel = state;
      let changed = false;
      for (const [path, value] of Object.entries(updates)) {
        const applied = applyOne(next, path, value);
        if (applied === null) continue;
        if (applied !== next) { next = applied; changed = true; }
      }
      if (!changed) return;
      if (guard && !guard(next)) { onError?.("mutation rejected: render-cost budget exceeded"); return; }
      state = recompute(next);
      notify();
    },
  };
}
