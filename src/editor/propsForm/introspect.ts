import { z } from "zod";

export type SelectValue = string | number | boolean | bigint | null | undefined;
export type PropControl =
  | { kind: "text" }
  | { kind: "select"; options: SelectValue[] }
  | { kind: "switch" }
  | { kind: "number" }
  | { kind: "json" };

export type PropField = {
  name: string;
  required: boolean;
  nullable: boolean;
  defaultValue?: unknown;
  control: PropControl;
};

type SchemaInfo = {
  schema: z.ZodType;
  required: boolean;
  nullable: boolean;
  hasDefault: boolean;
  defaultValue?: unknown;
};

function unwrap(schema: z.ZodType): SchemaInfo {
  let current = schema;
  const required = !schema.safeParse(undefined).success;
  const nullable = schema.safeParse(null).success;
  let hasDefault = false;
  let defaultValue: unknown;

  while (true) {
    if (current instanceof z.ZodDefault || current instanceof z.ZodPrefault) {
      hasDefault = true;
      const parsed = current.safeParse(undefined);
      if (parsed.success) defaultValue = parsed.data;
    }
    if (
      current instanceof z.ZodOptional || current instanceof z.ZodNullable ||
      current instanceof z.ZodDefault || current instanceof z.ZodReadonly ||
      current instanceof z.ZodCatch || current instanceof z.ZodPrefault
    ) {
      current = current.unwrap() as z.ZodType;
      continue;
    }
    if (current instanceof z.ZodPipe) {
      current = current.in as z.ZodType;
      continue;
    }
    break;
  }
  return { schema: current, required, nullable, hasDefault, defaultValue };
}

function controlFor(schema: z.ZodType): PropControl {
  if (schema instanceof z.ZodString) return { kind: "text" };
  if (schema instanceof z.ZodEnum) return { kind: "select", options: [...schema.options] };
  if (schema instanceof z.ZodLiteral) return { kind: "select", options: [...schema.values] };
  if (schema instanceof z.ZodUnion) {
    const options: SelectValue[] = [];
    for (const option of schema.options) {
      const unwrapped = unwrap(option as z.ZodType).schema;
      if (!(unwrapped instanceof z.ZodLiteral)) return { kind: "json" };
      options.push(...unwrapped.values);
    }
    return { kind: "select", options };
  }
  if (schema instanceof z.ZodBoolean) return { kind: "switch" };
  if (schema instanceof z.ZodNumber) return { kind: "number" };
  return { kind: "json" };
}

export function describePropsSchema(schema: z.ZodType): PropField[] | null {
  const outer = unwrap(schema).schema;
  if (!(outer instanceof z.ZodObject)) return null;

  return Object.entries(outer.shape).map(([name, fieldSchema]) => {
    const info = unwrap(fieldSchema as z.ZodType);
    return {
      name,
      required: info.required,
      nullable: info.nullable,
      ...(info.hasDefault ? { defaultValue: info.defaultValue } : {}),
      control: controlFor(info.schema),
    };
  });
}
