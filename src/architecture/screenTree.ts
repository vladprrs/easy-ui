import type { ComponentDefinition } from "../catalog/definitions";
import { hostPrimitiveNames } from "../catalog/hostPrimitives/definitions";
import { describePropsSchema, type PropField } from "../catalog/zodIntrospect";
import type { AtomicLevel } from "../designSystems/types";
import type { PrototypeDoc, RegionKind } from "../prototype/schema";
import type { ValidationIssue } from "../prototype/types";

/**
 * Аннотированное дерево архитектуры экрана (волна 1, план 2026-07-27 §«Волна 1»).
 *
 * Модуль — единственный источник правды для инспекторов редактора и плеера: он
 * обходит authored-спеку экрана (та же семантика, что у прежнего `buildForest`
 * в `editor/ElementTree.tsx`, включая сирот и защиту от циклов) и навешивает на
 * каждый узел метаданные определения компонента.
 *
 * Поля `scope`/`canonicalFor`/`sourceBounded`/`replacement`/`ownership` ещё не
 * объявлены в `ComponentDefinition` — их добавляет волна 2. Читаем их
 * защитно (optional access + проверка типа), поэтому модуль работает сейчас и
 * «загорается» после волны 2 без правок здесь.
 */

export type ScreenSpec = PrototypeDoc["screens"][number]["spec"];
export type ScreenElement = ScreenSpec["elements"][string];

export const COMPONENT_SCOPES = ["primitive", "section", "shell", "screen"] as const;
export type ComponentScope = (typeof COMPONENT_SCOPES)[number];

/** Пин компонента прототипа: структурно совместим с `PrototypeComponentPin`. */
export interface ComponentPinInfo {
  id?: string;
  name: string;
  version?: number;
  status?: string;
}

/**
 * Проп, явно заданный на элементе и отличающийся от **объявленного** zod-дефолта
 * определения. Renderer zod-дефолты не применяет, поэтому формулировка в UI —
 * «отличается от объявленного дефолта», а не «от применённого».
 */
export interface PropDiffEntry {
  name: string;
  value: unknown;
  /** Объявленный дефолт (undefined, когда его нет). */
  defaultValue: unknown;
  hasDeclaredDefault: boolean;
  /** Проп задан, но отсутствует в схеме определения. */
  unknownProp: boolean;
}

export interface NodeIssue {
  message: string;
  path?: string;
  code?: string;
  severity: "error" | "warning";
}

export interface ArchitectureNode {
  key: string;
  type: string;
  depth: number;
  /** Ключи предков от корня своего дерева (у сирот — от корня-сироты). */
  ancestors: string[];
  children: ArchitectureNode[];
  region?: RegionKind;
  slot?: string;
  atomicLevel?: AtomicLevel;
  scope?: ComponentScope;
  source: "host" | "custom";
  /** true, когда для типа не найдено определение (незагруженный/удалённый компонент). */
  unresolved: boolean;
  /** Идентификатор компонента из пина — для ссылки на `/library/c/:id`. */
  componentId?: string;
  version?: number;
  status?: string;
  canonicalFor?: string[];
  sourceBounded?: boolean;
  replacement?: string;
  propsDiff: PropDiffEntry[];
  issues: NodeIssue[];
}

export interface ScreenArchitectureTree {
  /** Корни дерева, достижимые из `spec.root` (обычно ровно один). */
  roots: ArchitectureNode[];
  /** Корни поддеревьев, недостижимых из `spec.root`. */
  orphans: ArchitectureNode[];
  byKey: Map<string, ArchitectureNode>;
}

export interface BuildScreenTreeOptions {
  definitions?: Record<string, ComponentDefinition>;
  pins?: readonly ComponentPinInfo[];
  /** Issue'ы валидации: адресуются по сегменту пути `…/elements/<key>/…`. */
  issues?: { errors?: readonly ValidationIssue[]; warnings?: readonly ValidationIssue[] };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function jsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => jsonEqual(item, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]));
  }
  return false;
}

/** Волна 2 добавит эти поля в `ComponentDefinition`; читаем их защитно. */
function readFutureMeta(definition: ComponentDefinition | undefined) {
  const raw = definition as Record<string, unknown> | undefined;
  const scope = raw?.scope;
  const canonicalFor = raw?.canonicalFor;
  const sourceBounded = raw?.sourceBounded;
  const replacement = raw?.replacement;
  return {
    ...(typeof scope === "string" && (COMPONENT_SCOPES as readonly string[]).includes(scope)
      ? { scope: scope as ComponentScope } : {}),
    ...(Array.isArray(canonicalFor) && canonicalFor.every((item) => typeof item === "string")
      ? { canonicalFor: [...canonicalFor] as string[] } : {}),
    ...(typeof sourceBounded === "boolean" ? { sourceBounded } : {}),
    ...(typeof replacement === "string" && replacement ? { replacement } : {}),
  };
}

// Интроспекция zod-схемы не бесплатна, а дерево строится на каждый рендер
// инспектора: кэшируем разбор по объекту определения.
const propFieldCache = new WeakMap<ComponentDefinition, Map<string, PropField> | null>();

/** Дефолты пропов определения по имени (объявленные, не применённые). */
function propFieldsOf(definition: ComponentDefinition | undefined): Map<string, PropField> | null {
  if (!definition) return null;
  const cached = propFieldCache.get(definition);
  if (cached !== undefined) return cached;
  const fields = describePropsSchema(definition.props);
  const map = fields ? new Map(fields.map((field) => [field.name, field])) : null;
  propFieldCache.set(definition, map);
  return map;
}

function buildPropsDiff(element: ScreenElement, definition: ComponentDefinition | undefined): PropDiffEntry[] {
  const fields = propFieldsOf(definition);
  const entries: PropDiffEntry[] = [];
  for (const [name, value] of Object.entries(element.props ?? {})) {
    if (value === undefined) continue;
    const field = fields?.get(name);
    const hasDeclaredDefault = field !== undefined && Object.hasOwn(field, "defaultValue");
    if (hasDeclaredDefault && jsonEqual(value, field!.defaultValue)) continue;
    entries.push({
      name,
      value,
      defaultValue: hasDeclaredDefault ? field!.defaultValue : undefined,
      hasDeclaredDefault,
      unknownProp: fields !== null && field === undefined,
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/** `/screens/0/spec/elements/<key>/props/title` → `<key>`. */
export function issueElementKey(path: string): string | null {
  const parts = path.split("/");
  const index = parts.lastIndexOf("elements");
  if (index === -1) return null;
  const key = parts[index + 1];
  return key === undefined || key === "" ? null : decodeURIComponent(key);
}

function collectIssues(options: BuildScreenTreeOptions["issues"]): Map<string, NodeIssue[]> {
  const byKey = new Map<string, NodeIssue[]>();
  const add = (issue: ValidationIssue, severity: NodeIssue["severity"]) => {
    const key = issueElementKey(issue.path);
    if (key === null) return;
    const list = byKey.get(key) ?? [];
    list.push({ message: issue.message, path: issue.path, severity, ...(issue.code ? { code: issue.code } : {}) });
    byKey.set(key, list);
  };
  for (const issue of options?.errors ?? []) add(issue, "error");
  for (const issue of options?.warnings ?? []) add(issue, "warning");
  return byKey;
}

export function buildScreenArchitectureTree(
  screen: { spec: ScreenSpec } | ScreenSpec,
  options: BuildScreenTreeOptions = {},
): ScreenArchitectureTree {
  const spec: ScreenSpec = "spec" in screen ? screen.spec : screen;
  const definitions = options.definitions;
  const pins = new Map((options.pins ?? []).map((pin) => [pin.name, pin]));
  const issues = collectIssues(options.issues);

  const byKey = new Map<string, ArchitectureNode>();
  const visited = new Set<string>();

  const makeNode = (key: string, depth: number, ancestors: string[]): ArchitectureNode => {
    const element = spec.elements[key]!;
    const definition = definitions?.[element.type];
    const pin = pins.get(element.type);
    return {
      key,
      type: element.type,
      depth,
      ancestors,
      children: [],
      ...(element.region ? { region: element.region } : {}),
      ...(element.slot ? { slot: element.slot } : {}),
      ...(definition?.atomicLevel ? { atomicLevel: definition.atomicLevel } : {}),
      ...readFutureMeta(definition),
      source: hostPrimitiveNames.has(element.type) ? "host" : "custom",
      unresolved: definition === undefined,
      ...(pin?.id ? { componentId: pin.id } : {}),
      ...(pin?.version !== undefined ? { version: pin.version } : {}),
      ...(pin?.status ? { status: pin.status } : {}),
      propsDiff: buildPropsDiff(element, definition),
      issues: issues.get(key) ?? [],
    };
  };

  const walk = (key: string, depth: number, ancestors: string[], target: ArchitectureNode[]) => {
    if (visited.has(key) || !spec.elements[key]) return;
    visited.add(key);
    const node = makeNode(key, depth, ancestors);
    byKey.set(key, node);
    target.push(node);
    for (const child of spec.elements[key]!.children ?? []) walk(child, depth + 1, [...ancestors, key], node.children);
  };

  const roots: ArchitectureNode[] = [];
  const orphans: ArchitectureNode[] = [];
  walk(spec.root, 0, [], roots);
  for (const key of Object.keys(spec.elements)) {
    if (!visited.has(key)) walk(key, 0, [], orphans);
  }
  return { roots, orphans, byKey };
}

/** Pre-order обход: строки списка в порядке отрисовки. */
export function flattenArchitectureNodes(nodes: readonly ArchitectureNode[]): ArchitectureNode[] {
  return nodes.flatMap((node) => [node, ...flattenArchitectureNodes(node.children)]);
}

/** Ключи от корня (или корня-сироты) до выбранного элемента включительно. */
export function getElementPath(spec: ScreenSpec, selectedKey: string): string[] {
  const node = buildScreenArchitectureTree(spec).byKey.get(selectedKey);
  return node ? [...node.ancestors, node.key] : [];
}
