// Typed authoring builders for easy-ui prototype documents (plan 2026-07-27 §7.3, feedback §12).
//
// The builders are generic over a *catalog shape* — the `CatalogComponents` interface emitted by
// `scripts/generate-sdk.ts` into `sdk/catalog.<designSystem>.d.ts`. Bind them once per design
// system:
//
//   import type { CatalogComponents } from "./catalog.sdk-demo";
//   const { component, screen, doc, host, actions } = createAuthoring<CatalogComponents>();
//
//   const s = screen({ id: "success", name: "Success", root: screen.flowRoot({
//     header: component("DemoNavBar", { title: "Оплата", tone: "light" }),
//     content: component("DemoBadge", { text: "Готово" }),
//     footer: component("DemoActionFooter", { primaryLabel: "Готово" }, { on: { press: actions.back() } }),
//   }) });
//
//   const document = doc({ id: "demo", name: "Demo", designSystem: "sdk-demo", screens: [s] });
//
// `doc()` flattens the element tree into the `{root, elements}` spec shape of
// `src/prototype/schema.ts` and validates the result with `inputPrototypeDocSchema` before the
// caller ever sends it to the API.

import type { z } from "zod";
import { inputPrototypeDocSchema, type JsonValue, type PrototypeDoc, type RegionKind } from "../src/prototype/schema";

// --- Catalog shape --------------------------------------------------------------------------

/** Structural contract every generated catalog entry satisfies. */
export interface CatalogEntry {
  props: object;
  slots: string;
  events: string;
  eventPayloads: object;
}
/** Constraint for a generated catalog interface (interfaces lack an index signature, hence the mapped form). */
export type CatalogShape<C = unknown> = { [K in keyof C]: CatalogEntry };

/**
 * Handler map for an element. Components that declare no events accept no handlers at all
 * (`Record<string, never>` rather than `{}`, which would silently accept anything).
 */
export type EventHandlers<Events extends string> = [Events] extends [never]
  ? Record<string, never>
  : Partial<Record<Events, Handler>>;

// --- Elements -------------------------------------------------------------------------------

export interface ActionSpec {
  action: string;
  params?: Record<string, unknown>;
  preventDefault?: boolean;
  $if?: unknown;
}
export type Handler = ActionSpec | ActionSpec[];

export interface ElementNode {
  readonly type: string;
  readonly props: Record<string, unknown>;
  readonly children: readonly ElementNode[];
  readonly key?: string;
  readonly on?: Readonly<Record<string, Handler>>;
  readonly repeat?: { readonly statePath: string; readonly key?: string };
  readonly region?: RegionKind;
  readonly slot?: string;
  readonly visible?: unknown;
}

/** Options shared by every element builder; `events` narrows `on` to the component's own events. */
export interface ElementOptions<Events extends string = string> {
  /** Explicit element key. Must be unique in the screen and must not contain `$`. */
  key?: string;
  children?: readonly ElementNode[];
  on?: EventHandlers<Events>;
  repeat?: { statePath: string; key?: string };
  /** Screen region marker; only valid on direct children of `@eui/FlowRoot`. */
  region?: RegionKind;
  /** Named slot of the *parent* custom component this element is routed into. */
  slot?: string;
  visible?: unknown;
}

export const FLOW_ROOT_TYPE = "@eui/FlowRoot";

export class SdkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SdkError";
  }
}

export class SdkValidationError extends SdkError {
  readonly issues: { path: string; message: string }[];
  constructor(subject: string, issues: { path: string; message: string }[]) {
    super(`${subject} failed validation:\n${issues.map((issue) => `  ${issue.path}: ${issue.message}`).join("\n")}`);
    this.name = "SdkValidationError";
    this.issues = issues;
  }
}

const node = (type: string, props: Record<string, unknown>, options: ElementOptions = {}): ElementNode => {
  if (options.key !== undefined && (options.key.length === 0 || options.key.includes("$"))) {
    throw new SdkError(`Element key ${JSON.stringify(options.key)} is invalid: keys must be non-empty and must not contain "$"`);
  }
  return {
    type,
    props: { ...props },
    children: options.children ? [...options.children] : [],
    ...(options.key === undefined ? {} : { key: options.key }),
    ...(options.on === undefined ? {} : { on: { ...options.on } as Record<string, Handler> }),
    ...(options.repeat === undefined ? {} : { repeat: { ...options.repeat } }),
    ...(options.region === undefined ? {} : { region: options.region }),
    ...(options.slot === undefined ? {} : { slot: options.slot }),
    ...(options.visible === undefined ? {} : { visible: options.visible }),
  };
};

/** Returns a copy of `element` with the given region marker (used by `screen.flowRoot`). */
export const withRegion = (element: ElementNode, region: RegionKind): ElementNode =>
  element.region === region ? element : { ...element, region };

// --- Host primitives ------------------------------------------------------------------------

export interface ImageProps { src: unknown; alt: unknown; width?: unknown; height?: unknown; objectFit?: "contain" | "cover" | "fill" | "none" | "scale-down" }
export interface HotspotProps { x: unknown; y: unknown; width: unknown; height: unknown; ariaLabel: unknown }
export interface OverlayProps { placement: "top" | "bottom" | "center" | "top-left" | "top-right" | "bottom-left" | "bottom-right"; inset?: string; scrim?: boolean }

export const host = {
  image: (props: ImageProps, options: ElementOptions<never> = {}) => node("Image", props as unknown as Record<string, unknown>, options),
  hotspot: (props: HotspotProps, options: ElementOptions<"press"> = {}) => node("Hotspot", props as unknown as Record<string, unknown>, options),
  overlay: (props: OverlayProps, options: ElementOptions<never> = {}) => node("Overlay", props as unknown as Record<string, unknown>, options),
  flowRoot: (options: ElementOptions<never> = {}) => node(FLOW_ROOT_TYPE, {}, options),
} as const;

export interface FlowRootParts {
  statusBar?: ElementNode;
  header?: ElementNode;
  content: ElementNode | readonly ElementNode[];
  footer?: ElementNode;
  /** `Overlay` elements appended after the flow content (extracted into the stage layer). */
  overlays?: readonly ElementNode[];
  key?: string;
}

/** Builds the neutral `@eui/FlowRoot` screen root with region markers applied. */
export function flowRoot(parts: FlowRootParts): ElementNode {
  const content = Array.isArray(parts.content) ? [...parts.content] : [parts.content as ElementNode];
  const children: ElementNode[] = [
    ...(parts.statusBar ? [withRegion(parts.statusBar, "statusBar")] : []),
    ...(parts.header ? [withRegion(parts.header, "header")] : []),
    ...content,
    ...(parts.footer ? [withRegion(parts.footer, "footer")] : []),
    ...(parts.overlays ?? []),
  ];
  return node(FLOW_ROOT_TYPE, {}, { children, ...(parts.key === undefined ? {} : { key: parts.key }) });
}

// --- Actions --------------------------------------------------------------------------------

/** Typed constructors for the prototype action catalog (`src/catalog/actions.ts`). */
export const actions = {
  navigate: (screenId: string): ActionSpec => ({ action: "navigate", params: { screenId } }),
  back: (): ActionSpec => ({ action: "back" }),
  restart: (): ActionSpec => ({ action: "restart" }),
  openUrl: (url: string): ActionSpec => ({ action: "openUrl", params: { url } }),
  setState: (statePath: string, value: unknown): ActionSpec => ({ action: "setState", params: { statePath, value } }),
  pushState: (statePath: string, value: unknown, clearStatePath?: string): ActionSpec => ({
    action: "pushState",
    params: { statePath, value, ...(clearStatePath === undefined ? {} : { clearStatePath }) },
  }),
  removeState: (statePath: string, index: number): ActionSpec => ({ action: "removeState", params: { statePath, index } }),
} as const;

// --- Flattening -----------------------------------------------------------------------------

type DocInput = z.input<typeof inputPrototypeDocSchema>;
export type ScreenSpec = DocInput["screens"][number];
type ElementSpec = ScreenSpec["spec"]["elements"][string];

/** camelCases a component type into a key base: `@eui/FlowRoot` → `flowRoot`, `YpNavBar` → `ypNavBar`. */
export const keyBase = (type: string): string => {
  const cleaned = type.replace(/^.*\//, "").replace(/[^A-Za-z0-9]+/g, " ").trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  const joined = words.map((word, index) => (index === 0 ? word.charAt(0).toLowerCase() + word.slice(1) : word.charAt(0).toUpperCase() + word.slice(1))).join("");
  return joined || "element";
};

const walk = (element: ElementNode, visit: (element: ElementNode) => void): void => {
  visit(element);
  element.children.forEach((child) => walk(child, visit));
};

/**
 * Flattens an element tree into the `{root, elements}` spec shape. Keys are deterministic:
 * explicit keys are reserved first, generated keys are `<camelCasedType>` plus a `-2`, `-3`… suffix
 * on collision, assigned in depth-first order.
 */
export function toSpec(root: ElementNode): ScreenSpec["spec"] {
  const reserved = new Set<string>();
  walk(root, (element) => {
    if (element.key === undefined) return;
    if (reserved.has(element.key)) throw new SdkError(`Duplicate element key: ${element.key}`);
    reserved.add(element.key);
  });

  const used = new Set(reserved);
  const keys = new Map<ElementNode, string>();
  walk(root, (element) => {
    if (element.key !== undefined) { keys.set(element, element.key); return; }
    const base = keyBase(element.type);
    let key = base;
    for (let index = 2; used.has(key); index += 1) key = `${base}-${index}`;
    used.add(key);
    keys.set(element, key);
  });

  const elements: Record<string, ElementSpec> = {};
  walk(root, (element) => {
    const key = keys.get(element)!;
    elements[key] = {
      type: element.type,
      props: element.props,
      ...(element.children.length ? { children: element.children.map((child) => keys.get(child)!) } : {}),
      ...(element.on ? { on: element.on } : {}),
      ...(element.repeat ? { repeat: { ...element.repeat } } : {}),
      ...(element.region ? { region: element.region } : {}),
      ...(element.slot ? { slot: element.slot } : {}),
      ...(element.visible === undefined ? {} : { visible: element.visible }),
    };
  });

  return { root: keys.get(root)!, elements };
}

// --- Screens and documents ------------------------------------------------------------------

export interface ScreenInput {
  id: string;
  name: string;
  root: ElementNode;
  note?: string;
  canvas?: { width: number; height: number };
  stateOverrides?: Record<string, JsonValue>;
}

export function screen(input: ScreenInput): ScreenSpec {
  return {
    id: input.id,
    name: input.name,
    ...(input.note === undefined ? {} : { note: input.note }),
    ...(input.canvas === undefined ? {} : { canvas: input.canvas }),
    ...(input.stateOverrides === undefined ? {} : { stateOverrides: input.stateOverrides }),
    spec: toSpec(input.root),
  };
}

/** `screen()` plus the `screen.flowRoot({header, content, footer})` root helper from feedback §12. */
export const screenBuilder = Object.assign(screen, { flowRoot });

export type DocumentInput =
  Omit<DocInput, "version" | "screens" | "startScreen" | "state">
  & { version?: 1; screens: readonly ScreenSpec[]; startScreen?: string; state?: Record<string, JsonValue> };

const formatIssues = (error: z.ZodError): { path: string; message: string }[] =>
  error.issues.map((issue) => ({ path: `/${issue.path.map(String).join("/")}`, message: issue.message }));

/** Validates an already-assembled document against the server's strict input schema. */
export function validateDoc(candidate: unknown): PrototypeDoc {
  const parsed = inputPrototypeDocSchema.safeParse(candidate);
  if (!parsed.success) throw new SdkValidationError("Prototype document", formatIssues(parsed.error));
  return parsed.data as PrototypeDoc;
}

/** Assembles and validates a prototype document. Throws `SdkValidationError` listing every zod issue. */
export function doc(input: DocumentInput): PrototypeDoc {
  if (!input.screens.length) throw new SdkError("A prototype document needs at least one screen");
  const candidate = {
    ...input,
    version: input.version ?? 1,
    state: input.state ?? {},
    screens: [...input.screens],
    startScreen: input.startScreen ?? input.screens[0]!.id,
  };
  return validateDoc(candidate);
}

// --- Typed facade ---------------------------------------------------------------------------

export interface AuthoringOptions {
  /** Optional runtime guard: component names present in the catalog manifest. */
  knownComponents?: readonly string[];
}

export interface Authoring<C extends CatalogShape<C>> {
  component<N extends keyof C & string>(name: N, props: C[N]["props"], options?: ElementOptions<C[N]["events"]>): ElementNode;
  screen: typeof screenBuilder;
  flowRoot: typeof flowRoot;
  doc: typeof doc;
  validateDoc: typeof validateDoc;
  toSpec: typeof toSpec;
  host: typeof host;
  actions: typeof actions;
}

/**
 * Binds the builders to a generated catalog type. Pass `knownComponents` (e.g. the names from the
 * catalog snapshot) to also reject unknown component names at runtime.
 */
export function createAuthoring<C extends CatalogShape<C>>(options: AuthoringOptions = {}): Authoring<C> {
  const known = options.knownComponents ? new Set(options.knownComponents) : undefined;
  const component = <N extends keyof C & string>(name: N, props: C[N]["props"], elementOptions: ElementOptions<C[N]["events"]> = {}): ElementNode => {
    if (known && !known.has(name)) {
      throw new SdkError(`Unknown component ${JSON.stringify(name)}; the catalog has: ${[...known].sort().join(", ")}`);
    }
    return node(name, props as Record<string, unknown>, elementOptions as unknown as ElementOptions);
  };
  return { component, screen: screenBuilder, flowRoot, doc, validateDoc, toSpec, host, actions };
}
