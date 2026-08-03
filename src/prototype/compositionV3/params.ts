import { z } from "zod";
import { isAssetId, jsonValueSchema, type JsonValue } from "../schema";
import { actionValueMatches } from "./actions";

/**
 * Типизированные параметры композиций v3 (план 2026-08-03 §5 W8a, граница D7).
 *
 * **Всё разрешается на этапе раскрытия, от значений параметров в точке ссылки.**
 * Расширение аддитивно: плоские типы v1/v2 (`string|number|boolean|json|asset`) —
 * отдельная ветка объединения с той же формой, что и раньше, поэтому документы v1/v2
 * парсятся байт-в-байт как до правки.
 */

/** Плоские типы v1/v2 — ветка объединения без изменений формы. */
export const COMPOSITION_FLAT_PARAM_TYPES = ["string", "number", "boolean", "json", "asset"] as const;
export type CompositionFlatParamType = (typeof COMPOSITION_FLAT_PARAM_TYPES)[number];

/** Скалярные типы полей `object`-схемы и элементов `array` (вложенности нет — схема плоская). */
export const COMPOSITION_SCALAR_FIELD_TYPES = ["string", "number", "boolean"] as const;
export type CompositionScalarFieldType = (typeof COMPOSITION_SCALAR_FIELD_TYPES)[number];

export const COMPOSITION_ENUM_VALUES_LIMIT = 30;
export const COMPOSITION_OBJECT_FIELDS_LIMIT = 30;
export const COMPOSITION_ARRAY_MAX_ITEMS_LIMIT = 50;

/** Имя поля `object`-схемы: props-подобный идентификатор (не slug — камелкейс обычен). */
export const compositionFieldNameSchema = z.string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "must be a field name");

const descriptionSchema = z.string().trim().min(1).max(300).optional();

const scalarFieldSchema = z.strictObject({
  type: z.enum(COMPOSITION_SCALAR_FIELD_TYPES),
  required: z.boolean().optional(),
  default: jsonValueSchema.optional(),
});
export type CompositionScalarField = z.output<typeof scalarFieldSchema>;

export const compositionObjectShapeSchema = z.record(compositionFieldNameSchema, scalarFieldSchema)
  .refine((shape) => Object.keys(shape).length >= 1, "object schema must declare at least one field")
  .refine((shape) => Object.keys(shape).length <= COMPOSITION_OBJECT_FIELDS_LIMIT,
    `object schema exceeds ${COMPOSITION_OBJECT_FIELDS_LIMIT} fields`);

const flatParamSchema = z.strictObject({
  type: z.enum(COMPOSITION_FLAT_PARAM_TYPES),
  required: z.boolean().optional(),
  default: jsonValueSchema.optional(),
  description: descriptionSchema,
});

const enumParamSchema = z.strictObject({
  type: z.literal("enum"),
  values: z.array(z.string().min(1)).min(1).max(COMPOSITION_ENUM_VALUES_LIMIT),
  required: z.boolean().optional(),
  default: jsonValueSchema.optional(),
  description: descriptionSchema,
}).superRefine((param, context) => {
  if (new Set(param.values).size !== param.values.length) {
    context.addIssue({ code: "custom", path: ["values"], message: "enum values must be unique" });
  }
});

const objectParamSchema = z.strictObject({
  type: z.literal("object"),
  schema: compositionObjectShapeSchema,
  required: z.boolean().optional(),
  default: jsonValueSchema.optional(),
  description: descriptionSchema,
});

const arrayItemsSchema = z.union([
  z.strictObject({ type: z.enum(COMPOSITION_SCALAR_FIELD_TYPES) }),
  z.strictObject({ type: z.literal("object"), schema: compositionObjectShapeSchema }),
]);

const arrayParamSchema = z.strictObject({
  type: z.literal("array"),
  items: arrayItemsSchema,
  maxItems: z.number().int().min(1).max(COMPOSITION_ARRAY_MAX_ITEMS_LIMIT),
  required: z.boolean().optional(),
  default: jsonValueSchema.optional(),
  description: descriptionSchema,
});

/**
 * Параметр-действие (W8d): значение — биндинг обработчика формата `element.on`.
 * `default` не поддерживается: действие по умолчанию — это скрытое поведение, которого
 * в теле композиции не видно; незаполненный необязательный параметр просто снимает событие.
 */
const actionParamSchema = z.strictObject({
  type: z.literal("action"),
  required: z.boolean().optional(),
  description: descriptionSchema,
});

/** Параметр v3: плоские типы v1/v2 плюс `enum`/`object`/`array`/`action`. */
export const compositionParamV3Schema = z.union([
  flatParamSchema, enumParamSchema, objectParamSchema, arrayParamSchema, actionParamSchema,
]).superRefine((param, context) => {
  if (param.type === "action") return;
  if (param.default === undefined) return;
  if (!paramValueMatches(param, param.default)) {
    context.addIssue({ code: "custom", path: ["default"], message: `default does not match the declared ${param.type} parameter` });
  }
});

export type CompositionParamV3 = z.output<typeof compositionParamV3Schema>;
export type CompositionEnumParam = z.output<typeof enumParamSchema>;
export type CompositionObjectParam = z.output<typeof objectParamSchema>;
export type CompositionArrayParam = z.output<typeof arrayParamSchema>;
export type CompositionActionParam = z.output<typeof actionParamSchema>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const scalarMatches = (type: CompositionScalarFieldType, value: unknown): boolean =>
  type === "string" ? typeof value === "string"
    : type === "number" ? typeof value === "number"
      : typeof value === "boolean";

const flatMatches = (type: CompositionFlatParamType, value: unknown): boolean => {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number";
    case "boolean": return typeof value === "boolean";
    case "asset": return isObject(value) && Object.keys(value).length === 1 && isAssetId(value.$asset);
    case "json": return true;
  }
};

/** Плоский объект по `object`-схеме: объявленные поля обязательны/типизированы, чужих ключей нет. */
function objectMatches(shape: Record<string, CompositionScalarField>, value: unknown): boolean {
  if (!isObject(value)) return false;
  for (const key of Object.keys(value)) if (!Object.hasOwn(shape, key)) return false;
  for (const [key, field] of Object.entries(shape)) {
    if (!Object.hasOwn(value, key)) {
      if (field.required) return false;
      continue;
    }
    if (!scalarMatches(field.type, value[key])) return false;
  }
  return true;
}

/**
 * Значение параметра в точке ссылки соответствует объявлению.
 * Для плоских типов — ровно прежняя семантика `typeMatches`.
 */
export function paramValueMatches(declared: CompositionParamV3, value: unknown): boolean {
  switch (declared.type) {
    case "action": return actionValueMatches(value);
    case "enum": return typeof value === "string" && declared.values.includes(value);
    case "object": return objectMatches(declared.schema, value);
    case "array": {
      if (!Array.isArray(value)) return false;
      if (value.length > declared.maxItems) return false;
      const items = declared.items;
      return value.every((item) => (items.type === "object" ? objectMatches(items.schema, item) : scalarMatches(items.type, item)));
    }
    default: return flatMatches(declared.type, value);
  }
}

/** Пустышка для probe-раскрытия обязательного параметра без default (публикация композиции). */
export function paramPlaceholder(declared: CompositionParamV3): JsonValue | undefined {
  switch (declared.type) {
    // Безобидное терминальное действие: probe-раскрытие ничего не навигирует, но форма валидна.
    case "action": return { action: "back" };
    case "string": return "";
    case "number": return 0;
    case "boolean": return false;
    case "asset": return { $asset: `asset_${"0".repeat(64)}` };
    case "json": return null;
    case "enum": return declared.values[0]!;
    case "array": return [];
    case "object": return Object.fromEntries(Object.entries(declared.schema)
      .filter(([, field]) => field.required || field.default !== undefined)
      .map(([key, field]) => [key, field.default ?? (field.type === "string" ? "" : field.type === "number" ? 0 : false)]));
  }
}
