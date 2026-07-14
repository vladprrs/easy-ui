import type { Spec } from "@json-render/core";
import type { PrototypeDoc } from "./schema";

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
    const meta: ElementMetadata = { type: element.type };
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

  return { spec: { root: spec.root, elements }, metadata };
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
  return { spec: { ...tree.spec, elements }, metadata };
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
  const contentMetadata = Object.fromEntries(Object.entries(tree.metadata).filter(([id]) => !hotspotIds.has(id)));
  const content = contentSpec ? { spec: contentSpec, metadata: contentMetadata } : null;
  const hotspots = [...hotspotIds].map((id) => ({
    spec: { root: id, elements: { [id]: spec.elements[id] } } as Spec,
    metadata: tree.metadata[id] ? { [id]: tree.metadata[id]! } : {},
  }));
  return { content, hotspots };
}
