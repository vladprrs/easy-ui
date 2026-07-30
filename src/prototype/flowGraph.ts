// Иерархия сценариев: дерево по `flow.parentId` и обратный индекс «экран → сценарии».
// План `docs/plans/2026-07-29-scrn-gallery-ux.md` §7/T1. Чистые функции без React:
// их потребляют вид «Сценарии» (`src/cjm/`) и дерево сценариев в плеере.
//
// Инварианты авторской схемы (`refineFlowHierarchy` в schema.ts) здесь **не**
// предполагаются: функции обязаны быть тотальными и на stored-документах, прочитанных
// без авторских правил (§4). Поэтому висячий и «забегающий вперёд» `parentId`
// трактуются как корень — иерархия деградирует к плоскому списку, а не ломается.

import type { PrototypeDoc } from "./schema";

/** Флоу так, как он лежит в разобранном документе (stored-ветка — надмножество input'а). */
export type DocFlow = NonNullable<PrototypeDoc["flows"]>[number];

export interface FlowTreeNode {
  flow: DocFlow;
  /** Индекс флоу в `doc.flows` — адрес для issue-путей и для стабильной сортировки. */
  index: number;
  /** Корень = **1** (та же семантика, что у `FLOW_DEPTH_LIMIT`). */
  depth: number;
  /** Идентификаторы от корня до самого узла включительно. */
  path: string[];
  children: FlowTreeNode[];
}

/** Первое вхождение каждого `id`: дубликаты репортит схема, здесь они не должны ветвить дерево. */
const firstIndexById = (flows: readonly DocFlow[]): Map<string, number> => {
  const index = new Map<string, number>();
  flows.forEach((flow, position) => { if (!index.has(flow.id)) index.set(flow.id, position); });
  return index;
};

/**
 * Родитель по правилу схемы «родитель раньше ребёнка»: только строго меньший индекс.
 * Всё остальное (висячая ссылка, самоссылка, ссылка вперёд) — корень.
 */
const parentIndexOf = (flows: readonly DocFlow[], position: number, byId: ReadonlyMap<string, number>): number | undefined => {
  const parentId = flows[position]!.parentId;
  if (parentId === undefined) return undefined;
  const parentIndex = byId.get(parentId);
  return parentIndex !== undefined && parentIndex < position ? parentIndex : undefined;
};

/**
 * Лес сценариев. Возвращает **корни** в порядке массива; дети каждого узла — тоже в
 * порядке массива. Обход дерева читателем — явный DFS (`flattenFlowTree`).
 */
export function buildFlowTree(flows: readonly DocFlow[] | undefined): FlowTreeNode[] {
  if (!flows || flows.length === 0) return [];
  const byId = firstIndexById(flows);
  const nodes = flows.map<FlowTreeNode>((flow, index) => ({ flow, index, depth: 1, path: [flow.id], children: [] }));
  const roots: FlowTreeNode[] = [];
  nodes.forEach((node, index) => {
    const parentIndex = parentIndexOf(flows, index, byId);
    if (parentIndex === undefined) { roots.push(node); return; }
    nodes[parentIndex]!.children.push(node);
  });
  // Глубина и путь одним проходом по возрастанию индекса: родитель всегда левее ребёнка.
  nodes.forEach((node, index) => {
    const parentIndex = parentIndexOf(flows, index, byId);
    if (parentIndex === undefined) return;
    const parent = nodes[parentIndex]!;
    node.depth = parent.depth + 1;
    node.path = [...parent.path, node.flow.id];
  });
  return roots;
}

/** Явный DFS по лесу: порядок секций в виде «Сценарии». */
export function flattenFlowTree(roots: readonly FlowTreeNode[]): FlowTreeNode[] {
  const result: FlowTreeNode[] = [];
  const visit = (node: FlowTreeNode) => { result.push(node); node.children.forEach(visit); };
  roots.forEach(visit);
  return result;
}

/**
 * Цепочка от корня до `flowId` включительно. Пустой массив, если флоу нет в документе.
 * Основа breadcrumb'а в плеере и в лайтбоксе.
 */
export function flowBreadcrumb(flows: readonly DocFlow[] | undefined, flowId: string): DocFlow[] {
  if (!flows) return [];
  const byId = firstIndexById(flows);
  const start = byId.get(flowId);
  if (start === undefined) return [];
  const chain: DocFlow[] = [];
  // Родитель строго левее ребёнка (см. parentIndexOf), поэтому цикл конечен по построению.
  for (let index: number | undefined = start; index !== undefined; index = parentIndexOf(flows, index, byId)) {
    chain.push(flows[index]!);
  }
  return chain.reverse();
}

export interface FlowParticipation {
  flowId: string;
  stepIndex: number;
}

/**
 * Обратный индекс «экран → в каких сценариях и на каком шаге он участвует».
 * Работает и на плоских флоу (сегодняшние документы), и на дереве. Порядок значений —
 * порядок `doc.flows`, затем порядок шагов. Экраны вне сценариев в карте отсутствуют.
 */
export function screenFlowIndex(doc: Pick<PrototypeDoc, "flows">): Map<string, FlowParticipation[]> {
  const index = new Map<string, FlowParticipation[]>();
  for (const flow of doc.flows ?? []) {
    flow.steps.forEach((step, stepIndex) => {
      const entries = index.get(step.screenId);
      const entry: FlowParticipation = { flowId: flow.id, stepIndex };
      if (entries) entries.push(entry);
      else index.set(step.screenId, [entry]);
    });
  }
  return index;
}
