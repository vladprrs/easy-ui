import { z } from "zod";
import { layoutSpacingProps, spaceTokens, type AtomicLevel, type ComponentLayout, type LayoutJsonScalar } from "../designSystems/types";
import { isJsonScalar, zodObjectShape, zodScalarValues } from "./zodIntrospect";

/** Capabilities a custom definition may opt into. Both require host ABI v2 or newer. */
export type ComponentCapabilities = {
  typedEvents?: true;
  namedSlots?: true;
};

/**
 * Raw event declaration on a definition. Either the legacy `string[]` list of
 * payloadless event names, or a `Record<name, ZodSchema>` declaring a typed
 * payload per event.
 */
export type RawEvents = readonly string[] | Record<string, z.ZodType>;

export type ComponentDefinition = {
  props: z.ZodType;
  slots?: string[];
  /** Normalized event names (legacy-compatible, always a string list). */
  events?: string[];
  /** Zod payload schema per event, for runtime payload validation (typed events). */
  eventPayloadSchemas?: Record<string, z.ZodType>;
  /** Canonical JSON Schema per event payload (server-side / manifest form). */
  eventPayloads?: Record<string, unknown>;
  capabilities?: ComponentCapabilities;
  description: string;
  example?: Record<string, unknown>;
  atomicLevel?: AtomicLevel;
  layoutNeutral?: boolean;
  layout?: ComponentLayout;
  /**
   * Semantic-validation metadata (additive; drives `validatePrototype` warnings).
   * Custom definitions declare these; builtin values live in `builtinSemantics.ts`.
   */
  /** The element is interactive (a control the user acts on). */
  interactive?: boolean;
  /** Prop names that carry an accessible label for the control. */
  accessibleLabelProps?: string[];
  /** Prop names whose value is a URL (checked for local-path availability). */
  urlProps?: string[];
};

const isZodType = (value: unknown): value is z.ZodType => value instanceof z.ZodType;

/**
 * Normalizes a raw `events` declaration to `{name, payloadSchema?}` form.
 * Accepts a legacy `string[]` (payloadless) or a `Record<name, ZodSchema>`
 * (typed payload). Returns the outward-facing `events: string[]` list plus a
 * `eventPayloadSchemas` map when any event declares a payload schema.
 */
export function normalizeEvents(raw: RawEvents | undefined): {
  events: string[];
  eventPayloadSchemas?: Record<string, z.ZodType>;
} {
  if (raw === undefined) return { events: [] };
  if (Array.isArray(raw)) {
    if (!raw.every((name) => typeof name === "string")) throw new Error("events must be strings");
    return { events: [...raw] };
  }
  if (typeof raw !== "object" || raw === null) throw new Error("events must be a string[] or a Record<name, ZodSchema>");
  const entries = Object.entries(raw as Record<string, unknown>);
  const schemas: Record<string, z.ZodType> = {};
  for (const [name, schema] of entries) {
    if (!isZodType(schema)) throw new Error(`event "${name}" payload must be a host zod schema`);
    schemas[name] = schema;
  }
  return { events: entries.map(([name]) => name), ...(entries.length ? { eventPayloadSchemas: schemas } : {}) };
}

export function normalizeSchema(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodNullable) {
    return normalizeSchema(schema.unwrap() as z.ZodType).nullable().optional();
  }
  if (schema instanceof z.ZodOptional) {
    return normalizeSchema(schema.unwrap() as z.ZodType).optional();
  }
  if (schema instanceof z.ZodObject) {
    const shape = Object.fromEntries(
      Object.entries(schema.shape).map(([key, value]) => [
        key,
        normalizeSchema(value as z.ZodType),
      ]),
    );
    return z.strictObject(shape);
  }
  if (schema instanceof z.ZodArray) {
    return z.array(normalizeSchema(schema.element as z.ZodType));
  }
  if (schema instanceof z.ZodRecord) {
    return z.record(
      normalizeSchema(schema.keyType as z.ZodType) as z.ZodString,
      normalizeSchema(schema.valueType as z.ZodType),
    );
  }
  return schema.clone();
}

export function normalizeDefinitions<T extends Record<string, ComponentDefinition>>(definitions: T): T {
  return Object.fromEntries(
    Object.entries(definitions).map(([name, definition]) => {
      if (definition.layout) validateLayout(name, definition);
      return [name, { ...definition, props: normalizeSchema(definition.props) }];
    }),
  ) as T;
}

const scalarKey = (value: LayoutJsonScalar) => `${value === null ? "null" : typeof value}:${String(value)}`;

function validateDomain(name: string, label: string, values: unknown, schema: z.ZodType): LayoutJsonScalar[] {
  if (!Array.isArray(values) || values.length === 0) throw new Error(`${name}.layout ${label} must be a non-empty array`);
  if (!values.every(isJsonScalar)) throw new Error(`${name}.layout ${label} must contain JSON-safe scalars`);
  const typed = values as LayoutJsonScalar[];
  if (new Set(typed.map(scalarKey)).size !== typed.length) throw new Error(`${name}.layout ${label} must contain unique values`);
  for (const value of typed) if (!schema.safeParse(value).success) throw new Error(`${name}.layout ${label} value ${JSON.stringify(value)} is not accepted by its prop schema`);
  return typed;
}

function validateLayout(name: string, definition: ComponentDefinition): void {
  const layout = definition.layout!;
  if (layout.version !== 1) throw new Error(`${name}.layout version must be 1`);
  const spacing = layout.spacing ?? [];
  if (!layout.spacer && spacing.length === 0) throw new Error(`${name}.layout requires spacing or spacer`);
  if (new Set(spacing).size !== spacing.length) throw new Error(`${name}.layout spacing contains duplicates`);
  if (spacing.some((prop) => !(layoutSpacingProps as readonly string[]).includes(prop))) throw new Error(`${name}.layout spacing contains an unknown prop`);
  if (layout.spacer && ((definition.slots?.length ?? 0) > 0 || spacing.length > 0)) throw new Error(`${name}.layout spacer is incompatible with slots and spacing`);
  if (layout.spacer) return;

  const shape = zodObjectShape(definition.props);
  if (!shape) throw new Error(`${name}.layout requires an object props schema`);
  for (const prop of spacing) {
    const schema = shape[prop];
    if (!schema) throw new Error(`${name}.layout spacing prop ${prop} is missing from props`);
    const values = zodScalarValues(schema);
    if (!values || values.some((value) => typeof value !== "string" || !(spaceTokens as readonly string[]).includes(value))) {
      throw new Error(`${name}.layout spacing prop ${prop} must be an enum subset of the canonical space scale`);
    }
  }

  const flow = layout.flow;
  if (!flow) return;
  if (flow.kind !== "flex") throw new Error(`${name}.layout flow kind must be flex`);
  if (!spacing.includes("gap")) throw new Error(`${name}.layout flow requires gap spacing`);
  const slot = flow.slot ?? "default";
  if (slot !== "default" && !definition.slots?.includes(slot)) throw new Error(`${name}.layout flow slot ${slot} is not declared`);
  if (typeof flow.direction === "object") {
    const directionSchema = shape[flow.direction.prop];
    if (!directionSchema) throw new Error(`${name}.layout direction prop ${flow.direction.prop} is missing from props`);
    const groups = [
      validateDomain(name, "direction.vertical", flow.direction.vertical, directionSchema),
      validateDomain(name, "direction.horizontal", flow.direction.horizontal, directionSchema),
      ...(flow.direction.none === undefined ? [] : [validateDomain(name, "direction.none", flow.direction.none, directionSchema)]),
    ];
    const seen = new Set<string>();
    for (const group of groups) for (const value of group) {
      const key = scalarKey(value);
      if (seen.has(key)) throw new Error(`${name}.layout direction domains must be pairwise disjoint`);
      seen.add(key);
    }
    if (flow.wrap) {
      if (flow.direction.prop === flow.wrap.prop) throw new Error(`${name}.layout direction and wrap props must differ`);
      const wrapSchema = shape[flow.wrap.prop];
      if (!wrapSchema) throw new Error(`${name}.layout wrap prop ${flow.wrap.prop} is missing from props`);
      validateDomain(name, "wrap.enabled", flow.wrap.enabled, wrapSchema);
    }
  } else if (flow.wrap) {
    const wrapSchema = shape[flow.wrap.prop];
    if (!wrapSchema) throw new Error(`${name}.layout wrap prop ${flow.wrap.prop} is missing from props`);
    validateDomain(name, "wrap.enabled", flow.wrap.enabled, wrapSchema);
  }
}
