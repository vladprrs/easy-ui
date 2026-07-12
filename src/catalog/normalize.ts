import { z } from "zod";
import type { AtomicLevel } from "../designSystems/types";

/** Capabilities a custom definition may opt into. Both require host ABI v2. */
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
    Object.entries(definitions).map(([name, definition]) => [
      name,
      { ...definition, props: normalizeSchema(definition.props) },
    ]),
  ) as T;
}
