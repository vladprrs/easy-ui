import { shadcnComponentDefinitions } from "@json-render/shadcn";
import { z } from "zod";
import { hotspotDefinition } from "./hotspot";

type Definition = {
  props: z.ZodType;
  slots?: string[];
  events?: string[];
  description: string;
  example?: Record<string, unknown>;
};

function normalizeSchema(schema: z.ZodType): z.ZodType {
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

export function normalizeDefinitions<T extends Record<string, Definition>>(definitions: T): T {
  return Object.fromEntries(
    Object.entries(definitions).map(([name, definition]) => [
      name,
      { ...definition, props: normalizeSchema(definition.props) },
    ]),
  ) as T;
}

export const sourceComponentDefinitions = {
  ...shadcnComponentDefinitions,
  Hotspot: hotspotDefinition,
};

export const componentDefinitions = normalizeDefinitions(sourceComponentDefinitions);
