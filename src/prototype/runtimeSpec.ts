import type { Spec } from "@json-render/core";
import { FLOW_ROOT_TYPE } from "../catalog/hostPrimitives/flowRoot.definition";
import { extractionPrimitiveNames } from "../catalog/hostPrimitives/definitions";
import { REGION_KINDS, type PrototypeDoc, type RegionKind } from "./schema";

type PrototypeSpec = PrototypeDoc["screens"][number]["spec"];
type JsonObject = Record<string, unknown>;

/** Raw action binding (or list) as authored in `element.on`, kept unresolved. */
export type RawActionBinding = unknown;

export interface ElementMetadata {
  /** Component type of the element. */
  type: string;
  /** Raw (unresolved) authored `on` bindings. */
  on?: Record<string, RawActionBinding>;
  /** `repeat.key` of the nearest repeat ancestor, when any (for `$itemKey`). */
  repeatKey?: string;
  /** Named-slot child index map (`{slot: [childIndex...]}`); populated by T5. */
  slotIndices?: Record<string, number[]>;
  /** Authored screen-region marker, stripped from the runtime spec. */
  region?: RegionKind;
}

/**
 * A runtime tree is the atomic pairing of the library `spec` (with custom
 * `on` bindings and the `$eui*` side-channel stripped out of props except
 * the string `__euiKey`) and a `metadata` map keyed by element key. All structural
 * transforms operate on the whole tree so spec and metadata never drift.
 */
export interface RuntimeTree {
  spec: Spec;
  metadata: Record<string, ElementMetadata>;
  /** Original authored spec retained for region preflight after structural splits. */
  authoredSpec?: PrototypeSpec;
}

export type RegionDisposition = "inline" | "drop" | "extract";
export type RegionPolicy = Partial<Record<RegionKind, RegionDisposition>>;

export interface ScreenRegionIssue {
  path: (string | number)[];
  message: string;
}

export interface ScreenRegionAnalysis {
  valid: boolean;
  hasRegions: boolean;
  issues: ScreenRegionIssue[];
  regionElements: Partial<Record<RegionKind, string>>;
}

type RegionScreen = Pick<PrototypeDoc["screens"][number], "spec"> & Partial<Pick<PrototypeDoc["screens"][number], "canvas">>;

/**
 * Authored-spec preflight shared by validation and the runtime fail-closed gate.
 * It deliberately scans every element, including orphans, before side-channel
 * fields or extracted host subtrees can disappear.
 */
export function analyzeScreenRegions(screen: RegionScreen): ScreenRegionAnalysis {
  const { elements, root } = screen.spec;
  const issues: ScreenRegionIssue[] = [];
  const issueKeys = new Set<string>();
  const add = (path: (string | number)[], message: string) => {
    const key = `${path.join("/")}\0${message}`;
    if (issueKeys.has(key)) return;
    issueKeys.add(key);
    issues.push({ path, message });
  };
  const parents = new Map<string, string[]>();
  for (const [parentId, element] of Object.entries(elements)) {
    for (const childId of element.children ?? []) {
      const list = parents.get(childId) ?? [];
      list.push(parentId);
      parents.set(childId, list);
    }
  }

  const marked = Object.entries(elements).filter((entry): entry is [string, (typeof elements)[string] & { region: RegionKind }] =>
    REGION_KINDS.includes(entry[1].region as RegionKind));
  const regionElements: Partial<Record<RegionKind, string>> = {};
  const structurallyValid = marked.filter(([id]) => {
    const elementParents = parents.get(id) ?? [];
    if (elementParents.length !== 1 || elementParents[0] !== root) {
      add(["elements", id, "region"], "region element must be a direct child of the screen root with exactly one parent");
      return false;
    }
    return true;
  });
  for (const [id, element] of structurallyValid) {
    const existing = regionElements[element.region];
    if (existing !== undefined) {
      add(["elements", id, "region"], `screen may contain at most one ${element.region} region`);
      add(["elements", existing, "region"], `screen may contain at most one ${element.region} region`);
    } else {
      regionElements[element.region] = id;
    }
  }

  const rootElement = elements[root];
  const eligibleRoot = rootElement?.type === FLOW_ROOT_TYPE;
  for (const [id, element] of marked) {
    if (screen.canvas) add(["elements", id, "region"], "region is not allowed on a canvas screen");
    if (!eligibleRoot) add(["elements", id, "region"], `region requires the screen root to be ${FLOW_ROOT_TYPE}`);
    if (element.repeat) add(["elements", id, "repeat"], "region element cannot repeat");
    if (element.slot !== undefined) add(["elements", id, "slot"], "region element cannot use a named slot");
    if (element.type === "Overlay" || element.type === "Hotspot") {
      add(["elements", id, "region"], `region is not allowed on ${element.type}`);
    }

    const ancestorQueue = [...(parents.get(id) ?? [])];
    const seenAncestors = new Set<string>();
    while (ancestorQueue.length) {
      const ancestorId = ancestorQueue.shift()!;
      if (seenAncestors.has(ancestorId)) continue;
      seenAncestors.add(ancestorId);
      const ancestor = elements[ancestorId];
      if (ancestor?.type === "Overlay") add(["elements", id, "region"], "region is not allowed inside Overlay");
      if (ancestor?.region !== undefined) add(["elements", id, "region"], "region cannot be nested inside another region subtree");
      ancestorQueue.push(...(parents.get(ancestorId) ?? []));
    }

    const queue = [...(element.children ?? [])];
    const descendants = new Set<string>();
    while (queue.length) {
      const descendantId = queue.shift()!;
      if (descendants.has(descendantId)) continue;
      descendants.add(descendantId);
      const descendant = elements[descendantId];
      if (!descendant) continue;
      if (descendant.type === "Hotspot") add(["elements", descendantId], "Hotspot is not allowed inside a region subtree");
      if (descendant.region !== undefined) add(["elements", descendantId, "region"], "region cannot be nested inside another region subtree");
      queue.push(...(descendant.children ?? []));
    }
  }

  for (const [id, element] of Object.entries(elements)) {
    if (element.type !== FLOW_ROOT_TYPE) continue;
    if (id !== root) add(["elements", id, "type"], `${FLOW_ROOT_TYPE} is only allowed as the screen root`);
    if (id === root) {
      if (element.repeat) add(["elements", id, "repeat"], `${FLOW_ROOT_TYPE} cannot repeat`);
      if (element.visible !== undefined) add(["elements", id, "visible"], `${FLOW_ROOT_TYPE} cannot be conditional`);
      if (element.on !== undefined) add(["elements", id, "on"], `${FLOW_ROOT_TYPE} cannot declare events`);
    }
  }

  return { valid: issues.length === 0, hasRegions: marked.length > 0, issues, regionElements };
}

export interface ToRuntimeSpecOptions {
  /** Element types treated as custom components (their `on` is removed from the runtime spec). */
  customTypes?: ReadonlySet<string>;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function adaptProp(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(adaptProp);
  if (!isObject(value)) return value;

  if (Object.hasOwn(value, "$asset") && Object.keys(value).length === 1 && typeof value.$asset === "string") {
    return `/api/assets/${value.$asset}`;
  }

  if (Object.hasOwn(value, "$cond")) {
    const keys = Object.keys(value);
    const condition = value.$cond;
    if (
      keys.length === 1
      && isObject(condition)
      && Object.keys(condition).length === 3
      && Object.hasOwn(condition, "if")
      && Object.hasOwn(condition, "then")
      && Object.hasOwn(condition, "else")
    ) {
      return { $cond: condition.if, $then: condition.then, $else: condition.else };
    }
    return value;
  }

  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, adaptProp(item)]));
}

/** String key injected into every element's props for runtime metadata and DOM correlation. */
export const EUI_KEY_PROP = "__euiKey";

/**
 * Builds the runtime tree from a prototype screen spec. Every element receives
 * a string `__euiKey` and keeps its authored `on` in metadata so player-only
 * features can correlate RuntimeTree semantics with the production DOM.
 * Custom elements (types in `options.customTypes`) additionally have `on`
 * removed from the spec and dispatched by the custom runtime adapter; builtin
 * elements keep `on` in the spec for native (payloadless) handling.
 */
export function toRuntimeSpec(spec: PrototypeSpec, options: ToRuntimeSpecOptions = {}): RuntimeTree {
  const customTypes = options.customTypes ?? new Set<string>();
  const metadata: Record<string, ElementMetadata> = {};

  // Nearest repeat.key per element, resolved by a downward walk from root.
  const repeatKeyOf = new Map<string, string | undefined>();
  {
    const seen = new Set<string>();
    const walk = (key: string, inheritedKey: string | undefined) => {
      if (seen.has(key)) return;
      seen.add(key);
      const element = spec.elements[key];
      if (!element) return;
      repeatKeyOf.set(key, inheritedKey);
      const ownKey = element.repeat && typeof element.repeat.key === "string" ? element.repeat.key : undefined;
      const childKey = ownKey ?? inheritedKey;
      for (const child of element.children ?? []) walk(child, childKey);
    };
    walk(spec.root, undefined);
  }

  // Slot name of each child element (side-channel `slot` field), for building the parent's slot map.
  const slotOf = (childKey: string): string | undefined => {
    const value = (spec.elements[childKey] as { slot?: unknown } | undefined)?.slot;
    return typeof value === "string" ? value : undefined;
  };

  const elements = Object.fromEntries(Object.entries(spec.elements).map(([key, element]) => {
    const isCustom = customTypes.has(element.type);
    const props = adaptProp(element.props) as Record<string, unknown>;
    const bare = { ...element };
    delete (bare as { slot?: unknown }).slot;
    delete (bare as { region?: unknown }).region;
    const meta: ElementMetadata = { type: element.type };
    if (element.region !== undefined) meta.region = element.region;
    if (element.on && Object.keys(element.on).length) meta.on = element.on as Record<string, RawActionBinding>;
    const repeatKey = repeatKeyOf.get(key);
    if (isCustom && repeatKey !== undefined) meta.repeatKey = repeatKey;
    // Named-slot child map: index-of-position in element.children per slot ("default" when no slot).
    const children = element.children ?? [];
    if (isCustom && children.some((childKey) => slotOf(childKey) !== undefined)) {
      const slotIndices: Record<string, number[]> = {};
      children.forEach((childKey, index) => {
        const slotName = slotOf(childKey) ?? "default";
        (slotIndices[slotName] ??= []).push(index);
      });
      meta.slotIndices = slotIndices;
    }
    metadata[key] = meta;
    const runtimeElement = { ...bare, props: { ...props, [EUI_KEY_PROP]: key } };
    if (isCustom) delete (runtimeElement as { on?: unknown }).on;
    return [key, runtimeElement];
  })) as Spec["elements"];

  return { spec: { root: spec.root, elements }, metadata, authoredSpec: spec };
}

/**
 * Removes all `on` bindings from both the spec and metadata, yielding an inert
 * tree that cannot dispatch actions (used by the editor's non-interactive
 * canvas). Authored `on` lives in metadata; builtin `on` additionally lives in the spec.
 */
export function stripEvents(tree: RuntimeTree): RuntimeTree {
  const elements = Object.fromEntries(Object.entries(tree.spec.elements).map(([key, element]) => {
    if (!("on" in element)) return [key, element];
    const withoutEvents = { ...element };
    delete (withoutEvents as { on?: unknown }).on;
    return [key, withoutEvents];
  })) as Spec["elements"];
  const metadata = Object.fromEntries(Object.entries(tree.metadata).map(([key, meta]) => {
    if (!meta.on) return [key, meta];
    const next = { ...meta };
    delete next.on;
    return [key, next];
  }));
  return { spec: { ...tree.spec, elements }, metadata, authoredSpec: tree.authoredSpec };
}

function remapMetadata(originalSpec: Spec, filteredSpec: Spec, metadata: Record<string, ElementMetadata>): Record<string, ElementMetadata> {
  return Object.fromEntries(Object.keys(filteredSpec.elements).flatMap((id) => {
    const meta = metadata[id];
    if (!meta) return [];
    if (!meta.slotIndices) return [[id, meta]];
    const originalChildren = originalSpec.elements[id]?.children ?? [];
    const filteredChildren = filteredSpec.elements[id]?.children ?? [];
    const remappedIndex = new Map<number, number>();
    let nextFiltered = 0;
    originalChildren.forEach((childId, originalIndex) => {
      if (filteredChildren[nextFiltered] === childId) remappedIndex.set(originalIndex, nextFiltered++);
    });
    const slotIndices = Object.fromEntries(Object.entries(meta.slotIndices).map(([slot, indices]) =>
      [slot, indices.flatMap((index) => remappedIndex.has(index) ? [remappedIndex.get(index)!] : [])]));
    return [[id, { ...meta, slotIndices }]];
  }));
}

function runtimeTreeWithSpec(tree: RuntimeTree, spec: Spec): RuntimeTree {
  return { spec, metadata: remapMetadata(tree.spec, spec, tree.metadata), authoredSpec: tree.authoredSpec };
}

/**
 * Splits a canvas runtime tree into a content tree (Hotspots removed) and one
 * single-element tree per Hotspot, rebuilding the metadata map for each so the
 * side-channel stays consistent with the trimmed spec.
 */
export function splitCanvas(tree: RuntimeTree): { content: RuntimeTree | null; hotspots: RuntimeTree[] } {
  const spec = tree.spec;
  const hotspotIds = new Set(Object.entries(spec.elements).filter(([, element]) => element.type === "Hotspot").map(([id]) => id));
  const contentElements = Object.fromEntries(Object.entries(spec.elements)
    .filter(([id]) => !hotspotIds.has(id))
    .map(([id, element]) => [id, element.children ? { ...element, children: element.children.filter((child) => !hotspotIds.has(child)) } : element]));
  const contentSpec = contentElements[spec.root] ? { ...spec, elements: contentElements } as Spec : null;
  const content = contentSpec ? runtimeTreeWithSpec(tree, contentSpec) : null;
  const hotspots = [...hotspotIds].map((id) => ({
    spec: { root: id, elements: { [id]: spec.elements[id] } } as Spec,
    metadata: tree.metadata[id] ? { [id]: tree.metadata[id]! } : {},
    authoredSpec: tree.authoredSpec,
  }));
  return { content, hotspots };
}

function descendantsOf(spec: Spec, root: string): Set<string> {
  const descendants = new Set<string>();
  const walk = (key: string): void => {
    if (descendants.has(key)) return;
    const element = spec.elements[key];
    if (!element) return;
    descendants.add(key);
    for (const child of element.children ?? []) walk(child);
  };
  walk(root);
  return descendants;
}

/** Extracts host subtrees while keeping every descendant's runtime metadata. */
export function splitHostPrimitives(tree: RuntimeTree): { content: RuntimeTree | null; hostPrimitives: RuntimeTree[] } {
  const spec = tree.spec;
  const roots: string[] = [];
  const visited = new Set<string>();
  const findRoots = (key: string): void => {
    if (visited.has(key)) return;
    visited.add(key);
    const element = spec.elements[key];
    if (!element) return;
    if (extractionPrimitiveNames.has(element.type)) { roots.push(key); return; }
    for (const child of element.children ?? []) findRoots(child);
  };
  findRoots(spec.root);
  for (const key of Object.keys(spec.elements)) findRoots(key);
  const extractedIds = new Set(roots.flatMap((root) => [...descendantsOf(spec, root)]));
  const contentElements = Object.fromEntries(Object.entries(spec.elements)
    .filter(([id]) => !extractedIds.has(id))
    .map(([id, element]) => [id, element.children ? { ...element, children: element.children.filter((child) => !extractedIds.has(child)) } : element]));
  const content = contentElements[spec.root]
    ? runtimeTreeWithSpec(tree, { ...spec, elements: contentElements } as Spec)
    : null;
  const hostPrimitives = roots.map((root) => {
    const ids = descendantsOf(spec, root);
    return runtimeTreeWithSpec(tree, { root, elements: Object.fromEntries(Object.entries(spec.elements).filter(([id]) => ids.has(id))) } as Spec);
  });
  return { content, hostPrimitives };
}

/** Applies region disposition only after a successful authored-spec preflight. */
export function applyRegionPolicy(tree: RuntimeTree, policy: RegionPolicy): {
  content: RuntimeTree | null;
  regions: Partial<Record<RegionKind, RuntimeTree>>;
} {
  const marked = Object.values(tree.metadata).some((meta) => meta.region !== undefined);
  if (!marked) return { content: tree, regions: {} };
  if (!tree.authoredSpec) return { content: tree, regions: {} };
  const analysis = analyzeScreenRegions({ spec: tree.authoredSpec });
  if (!analysis.valid) return { content: tree, regions: {} };

  const affectedRoots = new Set<string>();
  const regions: Partial<Record<RegionKind, RuntimeTree>> = {};
  for (const kind of REGION_KINDS) {
    const root = analysis.regionElements[kind];
    const disposition = policy[kind] ?? "inline";
    if (!root || disposition === "inline") continue;
    affectedRoots.add(root);
    if (disposition === "extract") {
      const ids = descendantsOf(tree.spec, root);
      regions[kind] = runtimeTreeWithSpec(tree, {
        root,
        elements: Object.fromEntries(Object.entries(tree.spec.elements).filter(([id]) => ids.has(id))),
      } as Spec);
    }
  }
  if (!affectedRoots.size) return { content: tree, regions: {} };
  const removed = new Set([...affectedRoots].flatMap((root) => [...descendantsOf(tree.spec, root)]));
  const elements = Object.fromEntries(Object.entries(tree.spec.elements)
    .filter(([id]) => !removed.has(id))
    .map(([id, element]) => [id, element.children
      ? { ...element, children: element.children.filter((child) => !removed.has(child)) }
      : element]));
  const contentSpec = elements[tree.spec.root] ? { ...tree.spec, elements } as Spec : null;
  return { content: contentSpec ? runtimeTreeWithSpec(tree, contentSpec) : null, regions };
}

export interface ScreenRenderPlan {
  content: Spec | null;
  overlays: Spec[];
  hotspots: Spec[];
  regions: Partial<Record<RegionKind, Spec>>;
  metadata: Record<string, ElementMetadata>;
  hasBlockedHostPrimitives: boolean;
}

function mergeTerminalMetadata(trees: (RuntimeTree | null | undefined)[]): Record<string, ElementMetadata> {
  const metadata: Record<string, ElementMetadata> = {};
  for (const tree of trees) {
    if (!tree) continue;
    for (const [id, meta] of Object.entries(tree.metadata)) {
      if (Object.hasOwn(metadata, id)) throw new Error(`ScreenRenderPlan metadata collision for element ${id}`);
      metadata[id] = meta;
    }
  }
  return metadata;
}

/** Builds all terminal render branches and their single remapped metadata map. */
export function buildScreenRenderPlan(tree: RuntimeTree, options: {
  canvas?: { width: number; height: number } | undefined;
  regionPolicy?: RegionPolicy;
  renderHostPrimitives?: boolean;
  renderHotspots?: boolean;
} = {}): ScreenRenderPlan {
  const regionPreflight = tree.authoredSpec
    ? analyzeScreenRegions({ spec: tree.authoredSpec, ...(options.canvas ? { canvas: options.canvas } : {}) })
    : undefined;
  const hostSplit = splitHostPrimitives(tree);
  const renderHostPrimitives = options.renderHostPrimitives ?? true;
  const overlays = renderHostPrimitives ? hostSplit.hostPrimitives : [];
  let content: RuntimeTree | null = hostSplit.content;
  let hotspots: RuntimeTree[] = [];
  let regions: Partial<Record<RegionKind, RuntimeTree>> = {};
  if (options.canvas) {
    const canvasSplit = content ? splitCanvas(content) : { content: null, hotspots: [] };
    content = canvasSplit.content;
    hotspots = options.renderHotspots === false ? [] : canvasSplit.hotspots;
  } else if (content && regionPreflight?.valid !== false) {
    const regionSplit = applyRegionPolicy(content, options.regionPolicy ?? {});
    content = regionSplit.content;
    regions = regionSplit.regions;
  }
  const regionTrees = REGION_KINDS.map((kind) => regions[kind]);
  const metadata = mergeTerminalMetadata([content, ...hotspots, ...overlays, ...regionTrees]);
  return {
    content: content?.spec ?? null,
    hotspots: hotspots.map((item) => item.spec),
    overlays: overlays.map((item) => item.spec),
    regions: Object.fromEntries(REGION_KINDS.flatMap((kind) => regions[kind] ? [[kind, regions[kind]!.spec]] : [])),
    metadata,
    hasBlockedHostPrimitives: !renderHostPrimitives && hostSplit.hostPrimitives.length > 0,
  };
}
