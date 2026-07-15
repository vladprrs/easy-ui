import type { PrototypeDoc } from "./schema";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type DiffValue = { value: Json } | { truncated: { preview: string; chars: number } } | { missing: true };

export interface PrototypeRevisionForDiff {
  rev: number;
  doc: PrototypeDoc;
  message?: string | null;
  createdAt?: string;
  builtinCatalogHash?: string | null;
  componentManifestHash?: string | null;
  designSystemMetaVersion?: number | null;
  components?: { id: string; version: number }[];
  assets?: { id: string }[];
}

export interface RevisionDiffOptions {
  leafBudget?: number;
  /** Intended for tests. The public endpoint never exceeds the hard 256 KiB cap. */
  byteBudget?: number;
}

export type DocDiff = Record<string, unknown>;

const VALUE_THRESHOLD = 160;
const VALUE_PREVIEW = 120;
const STRING_LIMIT = 160;
const SCREEN_ORDER_LIMIT = 100;
const DEFAULT_LEAF_BUDGET = 500;
const HARD_BYTE_BUDGET = 256 * 1024;
const OMIT_PRIORITY = ["props", "elements", "screens", "state", "doc", "pins", "renderInputs", "screenOrder"] as const;
const MISSING = Symbol("missing");
type MaybeValue = unknown | typeof MISSING;
// Optional response sections are assembled dynamically, then replaced by the
// omission cascade when a budget is exceeded.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MutableRecord = Record<string, any>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Canonicalize JSON without ever assigning attacker-controlled keys to a normal object. */
export function safeCanonicalize(value: unknown): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(safeCanonicalize);
  if (!isRecord(value)) return null;
  const result = Object.create(null) as { [key: string]: Json };
  for (const key of Object.keys(value).sort()) {
    if (Object.hasOwn(value, key)) Object.defineProperty(result, key, { value: safeCanonicalize(value[key]), enumerable: true, configurable: true, writable: true });
  }
  return result;
}

function canonicalJson(value: unknown): string { return JSON.stringify(safeCanonicalize(value)); }
function equal(a: MaybeValue, b: MaybeValue): boolean {
  if (a === MISSING || b === MISSING) return a === b;
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => equal(value, b[index]));
  if (!isRecord(a) || !isRecord(b)) return false;
  const aKeys = Object.keys(a), bKeys = Object.keys(b);
  return aKeys.length === bKeys.length && aKeys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
}

type BuildContext = { truncated: boolean; leafCounts: Map<string, number> };

function boundedString(input: string, ctx: BuildContext, limit = STRING_LIMIT): string {
  if (input.length <= limit) return input;
  ctx.truncated = true;
  const marker = "…[truncated]";
  return input.slice(0, Math.max(0, limit - marker.length)) + marker;
}

function valueUnion(value: MaybeValue, ctx: BuildContext): DiffValue {
  if (value === MISSING) return { missing: true };
  const canonical = canonicalJson(value);
  if (canonical.length <= VALUE_THRESHOLD) return { value: safeCanonicalize(value) };
  ctx.truncated = true;
  return { truncated: { preview: canonical.slice(0, VALUE_PREVIEW), chars: canonical.length } };
}

function own(record: unknown, key: string): MaybeValue {
  return isRecord(record) && Object.hasOwn(record, key) ? record[key] : MISSING;
}

function count(ctx: BuildContext, category: string, amount = 1): void {
  ctx.leafCounts.set(category, (ctx.leafCounts.get(category) ?? 0) + amount);
}

function sortedKeys(record: unknown): string[] { return isRecord(record) ? Object.keys(record).sort() : []; }
function orderedUnion(a: unknown, b: unknown): string[] { return [...new Set([...sortedKeys(a), ...sortedKeys(b)])].sort(); }

function mapDiff(from: unknown, to: unknown, ctx: BuildContext, category: string): MutableRecord | undefined {
  const added: MutableRecord[] = [], removed: string[] = [], changed: MutableRecord[] = [];
  for (const key of orderedUnion(from, to)) {
    const before = own(from, key), after = own(to, key);
    const outputKey = boundedString(key, ctx);
    if (before === MISSING) { added.push({ key: outputKey, value: valueUnion(after, ctx) }); count(ctx, category); }
    else if (after === MISSING) { removed.push(outputKey); count(ctx, category); }
    else if (!equal(before, after)) { changed.push({ key: outputKey, from: valueUnion(before, ctx), to: valueUnion(after, ctx) }); count(ctx, category); }
  }
  const result: MutableRecord = {};
  if (added.length) result.added = added;
  if (removed.length) result.removed = removed;
  if (changed.length) result.changed = changed;
  return Object.keys(result).length ? result : undefined;
}

function namedSetDiff(from: unknown, to: unknown, ctx: BuildContext, category: string): MutableRecord | undefined {
  const added: string[] = [], removed: string[] = [], changed: string[] = [];
  for (const key of orderedUnion(from, to)) {
    const before = own(from, key), after = own(to, key), output = boundedString(key, ctx);
    if (before === MISSING) { added.push(output); count(ctx, category); }
    else if (after === MISSING) { removed.push(output); count(ctx, category); }
    else if (!equal(before, after)) { changed.push(output); count(ctx, category); }
  }
  const result: MutableRecord = {};
  if (added.length) result.added = added;
  if (removed.length) result.removed = removed;
  if (changed.length) result.changed = changed;
  return Object.keys(result).length ? result : undefined;
}

function fieldDiff(from: unknown, to: unknown, keys: string[], ctx: BuildContext, category: string): MutableRecord[] {
  const result: MutableRecord[] = [];
  for (const key of keys) {
    const before = own(from, key), after = own(to, key);
    if (!equal(before, after)) { result.push({ key, from: valueUnion(before, ctx), to: valueUnion(after, ctx) }); count(ctx, category); }
  }
  return result;
}

function byId(values: unknown): Map<string, MutableRecord> {
  const map = new Map<string, MutableRecord>();
  if (Array.isArray(values)) for (const value of values) if (isRecord(value) && typeof value.id === "string") map.set(value.id, value);
  return map;
}

function elementsDiff(fromScreen: MutableRecord, toScreen: MutableRecord, ctx: BuildContext, summary: MutableRecord): MutableRecord | undefined {
  const fromElements = isRecord(fromScreen.spec) ? fromScreen.spec.elements : undefined;
  const toElements = isRecord(toScreen.spec) ? toScreen.spec.elements : undefined;
  const added: MutableRecord[] = [], removed: MutableRecord[] = [], changed: MutableRecord[] = [];
  for (const id of orderedUnion(fromElements, toElements)) {
    const before = own(fromElements, id), after = own(toElements, id), outputId = boundedString(id, ctx);
    if (before === MISSING) {
      const element = after as MutableRecord;
      added.push({ id: outputId, type: boundedString(String(element.type ?? ""), ctx) });
      summary.staticElementsAdded++; count(ctx, "elements"); continue;
    }
    if (after === MISSING) {
      const element = before as MutableRecord;
      removed.push({ id: outputId, type: boundedString(String(element.type ?? ""), ctx) });
      summary.staticElementsRemoved++; count(ctx, "elements"); continue;
    }
    const a = before as MutableRecord, b = after as MutableRecord, entry: MutableRecord = { id: outputId };
    if (!equal(own(a, "type"), own(b, "type"))) entry.type = { from: boundedString(String(a.type ?? ""), ctx), to: boundedString(String(b.type ?? ""), ctx) };
    const props = mapDiff(a.props, b.props, ctx, "props"); if (props) entry.props = props;
    for (const key of ["children", "visible", "repeat", "slot"] as const) {
      const av = own(a, key), bv = own(b, key);
      if (!equal(av, bv)) { entry[key] = { from: valueUnion(av, ctx), to: valueUnion(bv, ctx) }; count(ctx, "elements"); }
    }
    const on = namedSetDiff(a.on, b.on, ctx, "elements"); if (on) entry.on = on;
    if (Object.keys(entry).length > 1) { changed.push(entry); summary.staticElementsChanged++; count(ctx, "elements"); }
  }
  const result: MutableRecord = {};
  if (added.length) result.added = added;
  if (removed.length) result.removed = removed;
  if (changed.length) result.changed = changed;
  return Object.keys(result).length ? result : undefined;
}

function screensDiff(fromDoc: PrototypeDoc, toDoc: PrototypeDoc, ctx: BuildContext, summary: MutableRecord): MutableRecord | undefined {
  const from = byId(fromDoc.screens), to = byId(toDoc.screens);
  const added: MutableRecord[] = [], removed: MutableRecord[] = [], changed: MutableRecord[] = [];
  for (const screen of toDoc.screens) if (!from.has(screen.id)) {
    added.push({ id: boundedString(screen.id, ctx), name: boundedString(screen.name, ctx), elementCount: Object.keys(screen.spec.elements).length });
    summary.screensAdded++; summary.staticElementsAdded += Object.keys(screen.spec.elements).length; count(ctx, "screens");
  }
  for (const screen of fromDoc.screens) if (!to.has(screen.id)) {
    removed.push({ id: boundedString(screen.id, ctx), name: boundedString(screen.name, ctx) });
    summary.screensRemoved++; summary.staticElementsRemoved += Object.keys(screen.spec.elements).length; count(ctx, "screens");
  }
  for (const screen of toDoc.screens) {
    const before = from.get(screen.id); if (!before) continue;
    const entry: MutableRecord = { id: boundedString(screen.id, ctx) };
    const beforeMeta = { name: before.name, ...(Object.hasOwn(before, "note") ? { note: before.note } : {}), ...(Object.hasOwn(before, "canvas") ? { canvas: before.canvas } : {}), root: (before.spec as MutableRecord).root };
    const afterMeta = { name: screen.name, ...(Object.hasOwn(screen, "note") ? { note: screen.note } : {}), ...(Object.hasOwn(screen, "canvas") ? { canvas: screen.canvas } : {}), root: screen.spec.root };
    const meta = fieldDiff(beforeMeta, afterMeta, ["name", "note", "canvas", "root"], ctx, "screens"); if (meta.length) entry.meta = meta;
    const overrides = mapDiff(before.stateOverrides, screen.stateOverrides, ctx, "screens"); if (overrides) entry.stateOverrides = overrides;
    const elements = elementsDiff(before, screen as MutableRecord, ctx, summary); if (elements) entry.elements = elements;
    if (Object.keys(entry).length > 1) { changed.push(entry); summary.screensChanged++; count(ctx, "screens"); }
  }
  const result: MutableRecord = {};
  if (added.length) result.added = added;
  if (removed.length) result.removed = removed;
  if (changed.length) result.changed = changed;
  return Object.keys(result).length ? result : undefined;
}

function pinsDiff(from: PrototypeRevisionForDiff, to: PrototypeRevisionForDiff, ctx: BuildContext): MutableRecord | undefined {
  const components: MutableRecord = {}, a = byId(from.components), b = byId(to.components);
  const added: MutableRecord[] = [], removed: MutableRecord[] = [], changed: MutableRecord[] = [];
  for (const id of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const before = a.get(id), after = b.get(id), output = boundedString(id, ctx);
    if (!before) { added.push({ id: output, version: after!.version }); count(ctx, "pins"); }
    else if (!after) { removed.push({ id: output, version: before.version }); count(ctx, "pins"); }
    else if (before.version !== after.version) { changed.push({ id: output, from: before.version, to: after.version }); count(ctx, "pins"); }
  }
  if (added.length) components.added = added; if (removed.length) components.removed = removed; if (changed.length) components.changed = changed;
  const assetA = new Set((from.assets ?? []).map(x => x.id)), assetB = new Set((to.assets ?? []).map(x => x.id));
  const assetsAdded = [...assetB].filter(x => !assetA.has(x)).sort().map(x => boundedString(x, ctx));
  const assetsRemoved = [...assetA].filter(x => !assetB.has(x)).sort().map(x => boundedString(x, ctx));
  count(ctx, "pins", assetsAdded.length + assetsRemoved.length);
  const assets: MutableRecord = {}; if (assetsAdded.length) assets.added = assetsAdded; if (assetsRemoved.length) assets.removed = assetsRemoved;
  const result: MutableRecord = {}; if (Object.keys(components).length) result.components = components; if (Object.keys(assets).length) result.assets = assets;
  return Object.keys(result).length ? result : undefined;
}

function omitCategory(response: MutableRecord, category: typeof OMIT_PRIORITY[number]): boolean {
  let changed = false;
  if (category === "props" && isRecord(response.screens) && Array.isArray(response.screens.changed)) {
    for (const screen of response.screens.changed) if (isRecord(screen.elements) && Array.isArray(screen.elements.changed)) for (const element of screen.elements.changed) if (Object.hasOwn(element, "props")) { element.props = { omitted: true }; changed = true; }
  } else if (category === "elements" && isRecord(response.screens) && Array.isArray(response.screens.changed)) {
    for (const screen of response.screens.changed) if (Object.hasOwn(screen, "elements")) { screen.elements = { omitted: true }; changed = true; }
  } else if (category === "screens" && Object.hasOwn(response, "screens")) { response.screens = { omitted: true }; changed = true; }
  else if (Object.hasOwn(response, category)) { response[category] = { omitted: true }; changed = true; }
  return changed;
}

function serializedBytes(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }

export function diffPrototypeDocs(from: PrototypeRevisionForDiff, to: PrototypeRevisionForDiff, opts: RevisionDiffOptions = {}): DocDiff {
  const ctx: BuildContext = { truncated: false, leafCounts: new Map() };
  const docIdentical = equal(from.doc, to.doc);
  const pinsEqual = equal((from.components ?? []).map(x => ({ id: x.id, version: x.version })).sort((a,b)=>a.id.localeCompare(b.id)), (to.components ?? []).map(x => ({ id: x.id, version: x.version })).sort((a,b)=>a.id.localeCompare(b.id))) && equal((from.assets ?? []).map(x=>x.id).sort(), (to.assets ?? []).map(x=>x.id).sort());
  const renderKeys = ["builtinCatalogHash", "componentManifestHash", "designSystemMetaVersion"];
  const renderInputsEqual = renderKeys.every(key => equal(own(from, key), own(to, key)));
  const summary: MutableRecord = { screensAdded: 0, screensRemoved: 0, screensChanged: 0, staticElementsAdded: 0, staticElementsRemoved: 0, staticElementsChanged: 0, identical: docIdentical && pinsEqual && renderInputsEqual, docIdentical, truncated: false, omittedSections: [] };
  const response: MutableRecord = {
    prototypeId: boundedString(to.doc.id, ctx),
    from: { rev: from.rev, message: valueUnion(own(from, "message"), ctx), createdAt: boundedString(String(from.createdAt ?? ""), ctx) },
    to: { rev: to.rev, message: valueUnion(own(to, "message"), ctx), createdAt: boundedString(String(to.createdAt ?? ""), ctx) },
  };
  const doc = fieldDiff(from.doc, to.doc, ["name", "description", "device", "designSystem", "startScreen"], ctx, "doc"); if (doc.length) response.doc = doc;
  const state = mapDiff(from.doc.state, to.doc.state, ctx, "state"); if (state) response.state = state;
  const screens = screensDiff(from.doc, to.doc, ctx, summary); if (screens) response.screens = screens;
  const fromOrder = from.doc.screens.map(x => x.id), toOrder = to.doc.screens.map(x => x.id);
  if (!equal(fromOrder, toOrder)) {
    if (fromOrder.length > SCREEN_ORDER_LIMIT || toOrder.length > SCREEN_ORDER_LIMIT) { response.screenOrder = { omitted: true }; summary.omittedSections.push("screenOrder"); ctx.truncated = true; }
    else { response.screenOrder = { from: fromOrder.map(x=>boundedString(x,ctx)), to: toOrder.map(x=>boundedString(x,ctx)) }; count(ctx, "screenOrder"); }
  }
  const pins = pinsDiff(from, to, ctx); if (pins) response.pins = pins;
  const renderInputs = fieldDiff(from, to, renderKeys, ctx, "renderInputs"); if (renderInputs.length) response.renderInputs = renderInputs;
  response.summary = summary;

  const leafBudget = Math.max(0, Math.floor(opts.leafBudget ?? DEFAULT_LEAF_BUDGET));
  let leaves = [...ctx.leafCounts.values()].reduce((a,b)=>a+b,0);
  for (const category of OMIT_PRIORITY) {
    if (leaves <= leafBudget) break;
    if (omitCategory(response, category)) {
      if (!summary.omittedSections.includes(category)) summary.omittedSections.push(category);
      leaves -= ctx.leafCounts.get(category) ?? 0; ctx.truncated = true;
    }
  }
  const byteBudget = Math.min(HARD_BYTE_BUDGET, Math.max(1024, Math.floor(opts.byteBudget ?? HARD_BYTE_BUDGET)));
  for (const category of OMIT_PRIORITY) {
    if (serializedBytes(response) <= byteBudget) break;
    if (omitCategory(response, category)) { if (!summary.omittedSections.includes(category)) summary.omittedSections.push(category); ctx.truncated = true; }
  }
  summary.truncated = ctx.truncated;
  // The fixed envelope and summary are bounded; this is a last-resort guard for unusually tiny test budgets.
  if (serializedBytes(response) > byteBudget) {
    for (const key of Object.keys(response)) if (!["prototypeId", "from", "to", "summary"].includes(key)) { response[key] = { omitted: true }; if (!summary.omittedSections.includes(key)) summary.omittedSections.push(key); }
    summary.truncated = true;
  }
  return response;
}
