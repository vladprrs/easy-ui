import { canonicalStringify } from "../../src/capture/canonicalJson";
import type { JsonValue, PrototypeDoc } from "../../src/prototype/schema";
import type {
  CompositionDocV2,
  EventMigration,
  MigrationAdapter,
  PropMigration,
  SlotMigration,
} from "./migrationPlan";

/** A minimal authored spec accepted in addition to a full prototype/composition document. */
export interface MigrationSpec {
  root: string;
  elements: Record<string, MigrationElement>;
}

export interface MigrationElement {
  type: string;
  props: Record<string, unknown>;
  children?: string[];
  visible?: unknown;
  on?: Record<string, unknown>;
  repeat?: Record<string, unknown>;
  region?: string;
  slot?: string;
}

export type MigrationInput = PrototypeDoc | CompositionDocV2 | MigrationSpec;

export type AdapterChangeOperation = "add" | "remove" | "replace";

export interface AdapterChange {
  path: string;
  operation: AdapterChangeOperation;
}

export type AdapterRefusalCode =
  | "populated_prop_drop"
  | "populated_event_drop"
  | "populated_slot_drop"
  | "prop_rename_collision"
  | "event_rename_collision"
  | "payload_rename_collision"
  | "composition_id_missing"
  | "composition_prop_not_mapped"
  | "composition_event_not_supported"
  | "composition_slot_not_declared";

export interface AdapterRefusal {
  path: string;
  code: AdapterRefusalCode;
  message: string;
}

export interface AdapterApplicationOptions {
  /** Explicit audit approval for a declared populated drop. */
  allowPopulatedDrops?: boolean;
  /** Optional audit exception identifier retained by callers for their report. */
  documentedException?: string;
}

export interface AdapterApplicationSuccess<T> {
  ok: true;
  value: T;
  /** Alias for callers that use `doc` for the transformed authored document. */
  doc: T;
  changedPaths: string[];
  changes: AdapterChange[];
  refusals: [];
}

export interface AdapterApplicationRefused<T> {
  ok: false;
  /** The input is returned on refusal; no partially transformed value can escape. */
  value: T;
  doc: T;
  changedPaths: [];
  changes: [];
  refusals: AdapterRefusal[];
}

export type AdapterApplicationResult<T> = AdapterApplicationSuccess<T> | AdapterApplicationRefused<T>;

const COMPOSITION_TYPE = "@eui/Composition";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

const clone = <T>(value: T): T => structuredClone(value);

const equal = (left: unknown, right: unknown): boolean => {
  try { return canonicalStringify(left) === canonicalStringify(right); } catch { return Object.is(left, right); }
};

const pointerSegment = (segment: string | number): string => String(segment).replaceAll("~", "~0").replaceAll("/", "~1");
const childPath = (base: string, segment: string | number): string => `${base}/${pointerSegment(segment)}`;

const sortedKeys = (value: Record<string, unknown>): string[] => Object.keys(value).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);

const pathSegments = (value: string): string[] => {
  const source = value.startsWith("/") ? value.slice(1) : value;
  return source.split(/[./]/u).filter((segment) => segment.length > 0);
};

const readAt = (value: Record<string, unknown>, segments: readonly string[]): { parent: Record<string, unknown>; key: string; value: unknown } | undefined => {
  if (segments.length === 0) return undefined;
  let parent = value;
  for (const segment of segments.slice(0, -1)) {
    const next = parent[segment];
    if (!isRecord(next)) return undefined;
    parent = next;
  }
  const key = segments[segments.length - 1]!;
  if (!hasOwn(parent, key)) return undefined;
  return { parent, key, value: parent[key] };
};

const writeAt = (value: Record<string, unknown>, segments: readonly string[], next: unknown): void => {
  let parent = value;
  for (const segment of segments.slice(0, -1)) {
    const current = parent[segment];
    if (!isRecord(current)) parent[segment] = {};
    parent = parent[segment] as Record<string, unknown>;
  }
  parent[segments[segments.length - 1]!] = next;
};

const deleteAt = (value: Record<string, unknown>, segments: readonly string[]): void => {
  const found = readAt(value, segments);
  if (found !== undefined) delete found.parent[found.key];
};

class AdapterWork {
  readonly changes: AdapterChange[] = [];
  readonly refusals: AdapterRefusal[] = [];

  change(path: string, operation: AdapterChangeOperation): void {
    this.changes.push({ path, operation });
  }

  refuse(path: string, code: AdapterRefusalCode, message: string): void {
    this.refusals.push({ path, code, message });
  }
}

const canDrop = (options: AdapterApplicationOptions): boolean =>
  options.allowPopulatedDrops === true || options.documentedException !== undefined;

const refusalForDrop = (
  work: AdapterWork,
  path: string,
  kind: "prop" | "event" | "slot",
  name: string,
  options: AdapterApplicationOptions,
): boolean => {
  if (canDrop(options)) return true;
  const code = kind === "prop" ? "populated_prop_drop" : kind === "event" ? "populated_event_drop" : "populated_slot_drop";
  work.refuse(path, code, `cannot drop populated ${kind} "${name}" without an approved migration exception`);
  return false;
};

const setRecordValue = (record: Record<string, unknown>, key: string, next: unknown, path: string, work: AdapterWork): void => {
  const existed = hasOwn(record, key);
  const previous = record[key];
  if (existed && equal(previous, next)) return;
  record[key] = clone(next);
  work.change(path, existed ? "replace" : "add");
};

const deleteRecordValue = (record: Record<string, unknown>, key: string, path: string, work: AdapterWork): void => {
  if (!hasOwn(record, key)) return;
  delete record[key];
  work.change(path, "remove");
};

/**
 * Apply a rename map from one immutable snapshot of the record. In particular, mappings such
 * as `a -> b` and `b -> c` must move the original values to `b` and `c` in one pass; processing
 * the mutable record sequentially would cascade the first rename into the second one.
 */
const renameRecordValues = (
  record: Record<string, unknown>,
  mapping: Readonly<Record<string, string>> | undefined,
  path: string,
  collisionCode: "prop_rename_collision" | "event_rename_collision",
  work: AdapterWork,
): void => {
  if (mapping === undefined) return;
  const sources = Object.keys(mapping).sort().filter((from) => hasOwn(record, from) && mapping[from] !== from);
  if (sources.length === 0) return;
  const sourceSet = new Set(sources);
  const snapshot = new Map(sources.map((from) => [from, clone(record[from])] as const));
  const destinations = new Map<string, { from: string; value: unknown }>();
  for (const from of sources) {
    const to = mapping[from]!;
    const previous = destinations.get(to);
    if (previous !== undefined && !equal(previous.value, snapshot.get(from))) {
      work.refuse(childPath(path, from), collisionCode, `cannot rename "${from}" to "${to}" because another source maps there with a different value`);
      continue;
    }
    if (previous === undefined) destinations.set(to, { from, value: snapshot.get(from) });
    if (hasOwn(record, to) && !sourceSet.has(to) && !equal(record[to], snapshot.get(from))) {
      work.refuse(childPath(path, from), collisionCode, `cannot rename "${from}" to populated "${to}" with a different value`);
    }
  }
  if (work.refusals.length > 0) return;
  for (const from of sources) deleteRecordValue(record, from, childPath(path, from), work);
  for (const [to, entry] of [...destinations.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    setRecordValue(record, to, entry.value, childPath(path, to), work);
  }
};

const enumKey = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? undefined : encoded;
  } catch {
    return undefined;
  }
};

function applyPropMigration(
  props: Record<string, unknown>,
  rule: PropMigration | undefined,
  basePath: string,
  work: AdapterWork,
  options: AdapterApplicationOptions,
): void {
  if (rule === undefined) return;

  renameRecordValues(props, rule.rename, basePath, "prop_rename_collision", work);

  for (const name of Object.keys(rule.defaults ?? {}).sort()) {
    if (!hasOwn(props, name)) setRecordValue(props, name, rule.defaults![name], childPath(basePath, name), work);
  }

  for (const name of Object.keys(rule.enumMap ?? {}).sort()) {
    if (!hasOwn(props, name)) continue;
    const mapping = rule.enumMap![name]!;
    const current = props[name];
    const key = enumKey(current);
    if (key === undefined || !hasOwn(mapping, key)) continue;
    // Treat every mapped output as canonical. This prevents a map such as a→b, b→c
    // from changing b again on a second application.
    const mappedOutputs = Object.values(mapping).some((value) => equal(value, current));
    if (mappedOutputs) continue;
    setRecordValue(props, name, mapping[key], childPath(basePath, name), work);
  }

  for (const name of [...(rule.drop ?? [])].sort()) {
    if (!hasOwn(props, name)) continue;
    if (!refusalForDrop(work, childPath(basePath, name), "prop", name, options)) continue;
    deleteRecordValue(props, name, childPath(basePath, name), work);
  }
}

const applyPayloadMap = (
  action: unknown,
  mapping: Readonly<Record<string, string>> | undefined,
  basePath: string,
  work: AdapterWork,
): void => {
  if (!isRecord(action) || !isRecord(action.params) || mapping === undefined) return;
  const params = action.params;
  const snapshot = clone(params);
  const sourcePaths = new Set(Object.keys(mapping).map((name) => pathSegments(name).join("\u0000")));
  const operations: Array<{ from: string[]; to: string[]; fromName: string; toName: string; value: unknown }> = [];
  for (const from of Object.keys(mapping).sort()) {
    const to = mapping[from]!;
    const fromSegments = pathSegments(from);
    const toSegments = pathSegments(to);
    const source = readAt(snapshot, fromSegments);
    if (source === undefined || from === to) continue;
    const destination = readAt(snapshot, toSegments);
    if (destination !== undefined && !sourcePaths.has(toSegments.join("\u0000")) && !equal(destination.value, source.value)) {
      work.refuse(childPath(basePath, from), "payload_rename_collision", `cannot rename payload "${from}" to populated "${to}" with a different value`);
      continue;
    }
    operations.push({ from: fromSegments, to: toSegments, fromName: from, toName: to, value: clone(source.value) });
  }
  if (work.refusals.length > 0) return;
  for (const operation of operations) {
    deleteAt(params, operation.from);
    work.change(childPath(basePath, operation.fromName), "remove");
  }
  for (const operation of operations) {
    writeAt(params, operation.to, operation.value);
    work.change(childPath(basePath, operation.toName), "add");
  }
};

function applyEventMigration(
  element: MigrationElement,
  rule: EventMigration | undefined,
  basePath: string,
  work: AdapterWork,
  options: AdapterApplicationOptions,
): void {
  if (rule === undefined || !isRecord(element.on)) return;
  const events = element.on;
  const mapping = rule.rename ?? {};
  for (const from of [...sortedKeys(events)]) {
    if (rule.drop?.includes(from) === true) {
      if (!refusalForDrop(work, childPath(basePath, from), "event", from, options)) continue;
      deleteRecordValue(events, from, childPath(basePath, from), work);
      continue;
    }
  }

  renameRecordValues(events, mapping, childPath(basePath, "on"), "event_rename_collision", work);

  for (const event of sortedKeys(events)) {
    const binding = events[event];
    const actionPath = childPath(childPath(basePath, "on"), event);
    if (Array.isArray(binding)) {
      binding.forEach((action, index) => applyPayloadMap(action, rule.payloadMap, childPath(childPath(actionPath, index), "params"), work));
    } else {
      applyPayloadMap(binding, rule.payloadMap, childPath(actionPath, "params"), work);
    }
  }
}

const applySlotValue = (
  element: MigrationElement,
  slotRule: SlotMigration | undefined,
  basePath: string,
  work: AdapterWork,
  options: AdapterApplicationOptions,
): void => {
  if (slotRule === undefined || !hasOwn(element, "slot") || typeof element.slot !== "string") return;
  const from = element.slot;
  if (slotRule.drop?.includes(from) === true) {
    if (!refusalForDrop(work, childPath(basePath, "slot"), "slot", from, options)) return;
    deleteRecordValue(element as unknown as Record<string, unknown>, "slot", childPath(basePath, "slot"), work);
    return;
  }
  const to = slotRule.rename?.[from] ?? from;
  if (to !== from) setRecordValue(element as unknown as Record<string, unknown>, "slot", to, childPath(basePath, "slot"), work);
};

const compositionParamMap = (
  props: Record<string, unknown>,
  originalProps: Record<string, unknown>,
  config: NonNullable<MigrationAdapter["composition"]>,
  propRule: PropMigration | undefined,
  basePath: string,
  work: AdapterWork,
): Record<string, unknown> | undefined => {
  const params: Record<string, unknown> = {};
  const explicitMap = config.paramMap;
  const existingParams = isRecord(originalProps.params) ? originalProps.params : undefined;
  if (existingParams !== undefined) Object.assign(params, clone(existingParams));

  const sourceForCurrent = new Map<string, string>();
  for (const [source, target] of Object.entries(propRule?.rename ?? {}) as Array<[string, string]>) sourceForCurrent.set(target, source);

  for (const name of sortedKeys(props)) {
    if (name === "composition" || name === "params") continue;
    const sourceName = sourceForCurrent.get(name) ?? name;
    const target = explicitMap === undefined
      ? name
      : explicitMap[name] ?? explicitMap[sourceName];
    if (target === undefined) {
      work.refuse(childPath(basePath, name), "composition_prop_not_mapped", `component prop "${name}" is not mapped to a composition parameter`);
      continue;
    }
    if (hasOwn(params, target) && !equal(params[target], props[name])) {
      work.refuse(childPath(basePath, name), "composition_prop_not_mapped", `composition parameter "${target}" receives conflicting values`);
      continue;
    }
    params[target] = clone(props[name]);
  }
  return params;
};

function convertToComposition(
  element: MigrationElement,
  oldType: string,
  targetType: string,
  adapter: MigrationAdapter,
  basePath: string,
  work: AdapterWork,
): void {
  if (oldType === targetType || targetType !== COMPOSITION_TYPE) return;
  const config = adapter.composition;
  if (config === undefined || config.id.length === 0) {
    work.refuse(childPath(childPath(basePath, "props"), "composition"), "composition_id_missing", "component-to-composition adapters require a target composition id");
    return;
  }
  if (isRecord(element.on) && Object.keys(element.on).length > 0) {
    work.refuse(childPath(basePath, "on"), "composition_event_not_supported", "events on a component-to-composition host cannot be preserved; declare them inside the composition");
  }

  const originalProps = clone(element.props);
  const rule = adapter.props[oldType];
  const params = compositionParamMap(element.props, originalProps, config, rule, childPath(basePath, "props"), work);
  if (params === undefined) return;

  const nextProps: Record<string, unknown> = { composition: config.id };
  if (Object.keys(params).length > 0) nextProps.params = params;
  for (const name of sortedKeys(element.props)) {
    if (hasOwn(nextProps, name) && equal(element.props[name], nextProps[name])) continue;
    if (!hasOwn(nextProps, name)) deleteRecordValue(element.props, name, childPath(childPath(basePath, "props"), name), work);
  }
  for (const name of sortedKeys(nextProps)) setRecordValue(element.props, name, nextProps[name], childPath(childPath(basePath, "props"), name), work);
}

const routeChildren = (
  spec: MigrationSpec,
  element: MigrationElement,
  elementsPath: string,
  adapter: MigrationAdapter,
  work: AdapterWork,
  options: AdapterApplicationOptions,
  routedChildren: Set<string>,
): void => {
  if (element.type !== COMPOSITION_TYPE || adapter.composition === undefined) return;
  const composition = adapter.composition;
  for (const childKey of element.children ?? []) {
    const child = spec.elements[childKey];
    if (child === undefined) continue;
    const childRecord = child as unknown as Record<string, unknown>;
    const childBase = childPath(elementsPath, childKey);
    const hasSlot = hasOwn(childRecord, "slot") && typeof child.slot === "string";
    const sourceSlot = hasSlot ? child.slot! : undefined;
    if (sourceSlot !== undefined && adapter.slots?.drop?.includes(sourceSlot) === true) {
      if (!refusalForDrop(work, childPath(childBase, "slot"), "slot", sourceSlot, options)) continue;
      deleteRecordValue(childRecord, "slot", childPath(childBase, "slot"), work);
      routedChildren.add(childKey);
      continue;
    }
    const mappedSlot = sourceSlot === undefined ? undefined : composition.slotMap?.[sourceSlot] ?? adapter.slots?.rename?.[sourceSlot];
    const knownTarget = sourceSlot !== undefined && (
      composition.declaredSlots?.includes(sourceSlot) === true
      || Object.values(composition.slotMap ?? {}).includes(sourceSlot)
      || Object.values(adapter.slots?.rename ?? {}).includes(sourceSlot)
      || composition.defaultSlot === sourceSlot
      || adapter.slots?.defaultTarget === sourceSlot
    );
    const targetSlot = sourceSlot === undefined
      ? composition.defaultSlot ?? adapter.slots?.defaultTarget
      : mappedSlot ?? (knownTarget ? sourceSlot : composition.defaultSlot ?? adapter.slots?.defaultTarget ?? sourceSlot);
    const effectiveSlot = targetSlot ?? "default";
    if (composition.declaredSlots !== undefined && !composition.declaredSlots.includes(effectiveSlot)) {
      work.refuse(childPath(childBase, "slot"), "composition_slot_not_declared", `composition does not declare slot "${effectiveSlot}"`);
      continue;
    }
    if (targetSlot !== undefined) setRecordValue(childRecord, "slot", targetSlot, childPath(childBase, "slot"), work);
    routedChildren.add(childKey);
  }
};

const mutableSpec = (value: MigrationSpec): MigrationSpec => value;

function applySpec(
  spec: MigrationSpec,
  basePath: string,
  adapter: MigrationAdapter,
  work: AdapterWork,
  options: AdapterApplicationOptions,
): void {
  const routedChildren = new Set<string>();
  for (const key of sortedKeys(spec.elements)) {
    const element = spec.elements[key]!;
    const elementBase = childPath(childPath(basePath, "elements"), key);
    const oldType = element.type;
    const targetType = adapter.typeMap[oldType] ?? oldType;
    if (targetType !== oldType) setRecordValue(element as unknown as Record<string, unknown>, "type", targetType, childPath(elementBase, "type"), work);
    applyPropMigration(element.props, adapter.props[oldType], childPath(elementBase, "props"), work, options);
    applyEventMigration(element, adapter.events?.[oldType], elementBase, work, options);
    convertToComposition(element, oldType, targetType, adapter, elementBase, work);
  }

  // Composition routing is performed before generic slot remapping so the target slot is
  // never interpreted as another source slot on the same pass.
  for (const key of sortedKeys(spec.elements)) {
    const element = spec.elements[key]!;
    routeChildren(spec, element, childPath(basePath, "elements"), adapter, work, options, routedChildren);
  }

  for (const key of sortedKeys(spec.elements)) {
    if (routedChildren.has(key)) continue;
    const element = spec.elements[key]!;
    applySlotValue(element, adapter.slots, childPath(childPath(basePath, "elements"), key), work, options);
  }
}

const specsOf = (document: MigrationInput): Array<{ spec: MigrationSpec; basePath: string }> => {
  const value = document as unknown as Record<string, unknown>;
  if (Array.isArray(value.screens)) {
    return value.screens.flatMap((screen, index) => {
      if (!isRecord(screen) || !isRecord(screen.spec) || !isRecord(screen.spec.elements)) return [];
      return [{ spec: mutableSpec(screen.spec as unknown as MigrationSpec), basePath: childPath(childPath("", "screens"), index) }];
    });
  }
  if (isRecord(value.spec) && isRecord(value.spec.elements)) {
    return [{ spec: mutableSpec(value.spec as unknown as MigrationSpec), basePath: "" }];
  }
  if (isRecord(value.elements)) return [{ spec: mutableSpec(document as unknown as MigrationSpec), basePath: "" }];
  return [];
};

/**
 * Apply a declarative adapter without mutating the input. A refusal discards the working clone,
 * so callers can safely decide whether a documented exception is required before any write.
 */
export function applyMigrationAdapter<T extends MigrationInput>(
  document: T,
  adapter: MigrationAdapter,
  options: AdapterApplicationOptions = {},
): AdapterApplicationResult<T> {
  const output = clone(document);
  const work = new AdapterWork();
  for (const { spec, basePath } of specsOf(output)) applySpec(spec, basePath, adapter, work, options);
  const changes = [...work.changes].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : left.operation < right.operation ? -1 : left.operation > right.operation ? 1 : 0);
  const refusals = [...work.refusals].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : left.code < right.code ? -1 : left.code > right.code ? 1 : 0);
  if (refusals.length > 0) {
    return { ok: false, value: document, doc: document, changedPaths: [], changes: [], refusals };
  }
  return {
    ok: true,
    value: output,
    doc: output,
    changedPaths: [...new Set(changes.map((change) => change.path))],
    changes,
    refusals: [],
  };
}

export const applyAdapter = applyMigrationAdapter;

export class MigrationAdapterRefusalError extends Error {
  readonly refusals: AdapterRefusal[];

  constructor(refusals: AdapterRefusal[]) {
    super(refusals.map((refusal) => `${refusal.code} at ${refusal.path}: ${refusal.message}`).join("; "));
    this.name = "MigrationAdapterRefusalError";
    this.refusals = refusals;
  }
}

/** Convenience boundary for callers that cannot continue after a refusal. */
export function applyMigrationAdapterOrThrow<T extends MigrationInput>(
  document: T,
  adapter: MigrationAdapter,
  options: AdapterApplicationOptions = {},
): T {
  const result = applyMigrationAdapter(document, adapter, options);
  if (!result.ok) throw new MigrationAdapterRefusalError(result.refusals);
  return result.value;
}

export const applyAdapterOrThrow = applyMigrationAdapterOrThrow;

export type { EventMigration, MigrationAdapter, PropMigration, SlotMigration, JsonValue };
