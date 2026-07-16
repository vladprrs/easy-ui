import type { ReactNode } from "react";
import { RawJson } from "./RawJson";
import { componentDocsStrings as strings } from "./strings";

type JsonObject = Record<string, unknown>;
type PrimitiveType = "string" | "number" | "integer" | "boolean";

const primitiveTypes = new Set<PrimitiveType>(["string", "number", "integer", "boolean"]);
const MAX_SCHEMA_PROPERTIES = 200;
const unsupportedKeywords = ["anyOf", "oneOf", "allOf", "$ref", "$defs", "prefixItems", "not", "if", "then", "else"] as const;

const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const hasUnsupportedKeyword = (schema: JsonObject) => unsupportedKeywords.some((key) => key in schema);

function jsonInline(value: unknown): string {
  try { return JSON.stringify(value) ?? String(value); }
  catch { return String(value); }
}

function primitiveType(schema: JsonObject): PrimitiveType | null {
  return typeof schema.type === "string" && primitiveTypes.has(schema.type as PrimitiveType)
    ? schema.type as PrimitiveType
    : null;
}

type SupportedProperty = {
  typeLabel: string;
  defaultValue?: unknown;
  description?: string;
  constraints: string[];
};

function valueConstraints(schema: JsonObject): string[] {
  const result: string[] = [];
  if (Array.isArray(schema.enum)) result.push(`enum: ${schema.enum.map(jsonInline).join(", ")}`);
  if (Object.hasOwn(schema, "const")) result.push(`const: ${jsonInline(schema.const)}`);
  const labels: Record<string, string> = {
    minLength: "минимальная длина", maxLength: "максимальная длина", pattern: "шаблон", format: "формат",
    minimum: "минимум", maximum: "максимум", exclusiveMinimum: "строго больше",
    exclusiveMaximum: "строго меньше", multipleOf: "кратно", minItems: "минимум элементов",
    maxItems: "максимум элементов", uniqueItems: "уникальные элементы",
  };
  for (const [key, label] of Object.entries(labels)) {
    if (Object.hasOwn(schema, key)) result.push(`${label}: ${jsonInline(schema[key])}`);
  }
  return result;
}

function parsePrimitive(schema: JsonObject): SupportedProperty | null {
  if (hasUnsupportedKeyword(schema)) return null;
  const type = primitiveType(schema);
  if (!type) return null;
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) return null;
  return {
    typeLabel: type,
    ...(Object.hasOwn(schema, "default") ? { defaultValue: schema.default } : {}),
    ...(typeof schema.description === "string" ? { description: schema.description } : {}),
    constraints: valueConstraints(schema),
  };
}

function parseProperty(schema: unknown): SupportedProperty | null {
  if (!isObject(schema)) return null;
  const primitive = parsePrimitive(schema);
  if (primitive) return primitive;
  if (hasUnsupportedKeyword(schema) || schema.type !== "array" || !isObject(schema.items)) return null;
  const items = parsePrimitive(schema.items);
  if (!items) return null;
  return {
    typeLabel: `array<${items.typeLabel}>`,
    ...(Object.hasOwn(schema, "default") ? { defaultValue: schema.default } : {}),
    ...(typeof schema.description === "string" ? { description: schema.description } : {}),
    constraints: [...valueConstraints(schema), ...items.constraints.map((constraint) => `элементы — ${constraint}`)],
  };
}

function Description({ property }: { property: SupportedProperty }) {
  const content: ReactNode[] = [];
  if (property.description) content.push(<span key="description">{property.description}</span>);
  for (const [index, constraint] of property.constraints.entries()) {
    content.push(<span key={`constraint-${index}`} className="block text-eui-slate-500">{constraint}</span>);
  }
  return content.length ? content : strings.notSet;
}

function Fallback({ value }: { value: unknown }) {
  return <div>
    <span className="block">{strings.unsupportedSchema}</span>
    <RawJson value={value} />
  </div>;
}

export function PropsTable({ schema }: { schema?: unknown }) {
  if (schema === undefined) return <section aria-labelledby="component-props-title">
    <h2 id="component-props-title">{strings.propsTitle}</h2>
    <p>{strings.schemaUnavailable}</p>
  </section>;

  const rootSupported = isObject(schema)
    && !hasUnsupportedKeyword(schema)
    && schema.type === "object"
    && isObject(schema.properties)
    && Object.keys(schema.properties).length <= MAX_SCHEMA_PROPERTIES
    && (schema.required === undefined || (Array.isArray(schema.required) && schema.required.every((item) => typeof item === "string")));

  if (!rootSupported) return <section aria-labelledby="component-props-title">
    <h2 id="component-props-title">{strings.propsTitle}</h2>
    <Fallback value={schema} />
  </section>;

  const required = new Set(schema.required as string[] | undefined);
  const properties = schema.properties as JsonObject;
  return <section aria-labelledby="component-props-title">
    <h2 id="component-props-title">{strings.propsTitle}</h2>
    <div className="overflow-x-auto">
      <table className="min-w-full text-left">
        <caption className="sr-only">{strings.propsTitle}</caption>
        <thead><tr>
          <th scope="col">{strings.propName}</th>
          <th scope="col">{strings.propType}</th>
          <th scope="col">{strings.propRequired}</th>
          <th scope="col">{strings.propDefault}</th>
          <th scope="col">{strings.propDescription}</th>
        </tr></thead>
        <tbody>{Object.entries(properties).map(([name, rawProperty]) => {
          const property = parseProperty(rawProperty);
          return <tr key={name}>
            <th scope="row">{name}</th>
            {property ? <>
              <td>{property.typeLabel}</td>
              <td>{required.has(name) ? strings.yes : strings.no}</td>
              <td>{Object.hasOwn(property, "defaultValue") ? jsonInline(property.defaultValue) : strings.notSet}</td>
              <td><Description property={property} /></td>
            </> : <td colSpan={4}><Fallback value={rawProperty} /></td>}
          </tr>;
        })}</tbody>
      </table>
    </div>
  </section>;
}
