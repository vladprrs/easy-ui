import type { PrototypeDoc } from "./schema";

export interface NavigationGraph {
  edges: ReadonlyMap<string, ReadonlySet<string>>;
  dynamicSources: ReadonlySet<string>;
}

export type EdgeVerification = "static" | "dynamic" | "missing";

const isObjectDirective = (value: unknown): boolean =>
  typeof value === "object"
  && value !== null
  && !Array.isArray(value)
  && Object.keys(value).some((key) => key.startsWith("$"));

/**
 * Статически выведенный navigate-граф. `back`, `restart` и динамические таргеты
 * не входят в рёбра; их экраны-источники отдельно отмечаются в `dynamicSources`.
 */
export function buildNavigationGraph(doc: PrototypeDoc): NavigationGraph {
  const edges = new Map<string, Set<string>>();
  const dynamicSources = new Set<string>();
  for (const screen of doc.screens) {
    for (const element of Object.values(screen.spec.elements)) {
      for (const bindings of Object.values(element.on ?? {})) {
        const actions = Array.isArray(bindings) ? bindings : [bindings];
        for (const action of actions) {
          if (action.action !== "navigate") continue;
          const target = action.params?.screenId;
          if (typeof target === "string") {
            const targets = edges.get(screen.id) ?? new Set<string>();
            targets.add(target);
            edges.set(screen.id, targets);
          } else if (isObjectDirective(target)) {
            dynamicSources.add(screen.id);
          }
        }
      }
    }
  }
  return { edges, dynamicSources };
}

export function verifyEdge(graph: NavigationGraph, from: string, to: string): EdgeVerification {
  if (graph.edges.get(from)?.has(to)) return "static";
  if (graph.dynamicSources.has(from)) return "dynamic";
  return "missing";
}
