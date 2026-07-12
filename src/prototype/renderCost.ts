import type { Spec } from "@json-render/core";
import { getAtPointer, isSafeJsonPointer } from "./pointer";

export const REPEAT_RENDER_COST_BUDGET = 2000;

/**
 * Recursive render-cost of a spec tree against a concrete state:
 * `cost(el) = 1 + Σ cost(children)`, and for a repeat element
 * `cost(el) = 1 + len(stateArray) × Σ cost(children)`. Cycle-safe.
 */
export function computeRenderCost(spec: Spec, root: string, state: unknown): number {
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const cost = (key: string): number => {
    if (memo.has(key)) return memo.get(key)!;
    if (visiting.has(key)) return 0;
    visiting.add(key);
    const element = spec.elements[key];
    if (!element) { visiting.delete(key); memo.set(key, 0); return 0; }
    const childrenCost = (element.children ?? []).reduce((sum, child) => sum + cost(child), 0);
    let repeatLength = 0;
    const statePath = element.repeat?.statePath;
    if (element.repeat && typeof statePath === "string" && isSafeJsonPointer(statePath)) {
      const at = getAtPointer(state, statePath).value;
      repeatLength = Array.isArray(at) ? at.length : 0;
    }
    const total = element.repeat ? 1 + repeatLength * childrenCost : 1 + childrenCost;
    visiting.delete(key);
    memo.set(key, total);
    return total;
  };
  return cost(root);
}
