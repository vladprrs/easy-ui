import { z } from "zod";
import { jsonValueSchema, slugSchema, type JsonValue } from "../schema";

/**
 * Варианты композиций v3 (план 2026-08-03 §5 W8f, граница D7).
 *
 * Вариант — **именованная комбинация значений параметров**, а не новая сущность:
 * `dimensions` объявляют оси семейства, `tuples` перечисляют легальные комбинации и
 * значения параметров для каждой, `defaults` дают неуказанные оси. Точка ссылки передаёт
 * `props.variant`, раскрытие резолвит его в параметры — всё статически, до рендера.
 *
 * Явный `params` **не перекрывает** параметр, заданный вариантом: это две записи одной
 * величины, и молчаливый приоритет любой из них скрывал бы расхождение между заявленным
 * вариантом и фактическим деревом. Пересечение ключей — issue
 * `composition/variant-param-conflict`.
 */

export const COMPOSITION_VARIANT_DIMENSIONS_LIMIT = 8;
export const COMPOSITION_VARIANT_VALUES_LIMIT = 30;
export const COMPOSITION_VARIANT_TUPLES_LIMIT = 200;

const dimensionValueSchema = z.string().trim().min(1).max(60);

export const compositionVariantsSchema = z.strictObject({
  dimensions: z.record(slugSchema, z.array(dimensionValueSchema).min(1).max(COMPOSITION_VARIANT_VALUES_LIMIT))
    .refine((dimensions) => Object.keys(dimensions).length >= 1, "variants must declare at least one dimension")
    .refine((dimensions) => Object.keys(dimensions).length <= COMPOSITION_VARIANT_DIMENSIONS_LIMIT,
      `variants exceed ${COMPOSITION_VARIANT_DIMENSIONS_LIMIT} dimensions`),
  /** Если перечислены — легальны **только** эти комбинации. */
  tuples: z.array(z.strictObject({
    dims: z.record(slugSchema, dimensionValueSchema),
    params: z.record(slugSchema, jsonValueSchema).optional(),
    description: z.string().trim().min(1).max(300).optional(),
  })).min(1).max(COMPOSITION_VARIANT_TUPLES_LIMIT).optional(),
  defaults: z.record(slugSchema, dimensionValueSchema).optional(),
});

export type CompositionVariants = z.output<typeof compositionVariantsSchema>;
export type CompositionVariantTuple = NonNullable<CompositionVariants["tuples"]>[number];

/** Значение `props.variant` в точке ссылки. */
export const compositionVariantSelectionSchema = z.record(z.string(), z.string());
export type CompositionVariantSelection = Record<string, string>;

/** Каноническая подпись комбинации: оси в алфавитном порядке. */
export const variantSignature = (dims: Record<string, string>): string =>
  Object.keys(dims).sort().map((name) => `${name}=${dims[name]!}`).join("|");

export interface VariantRefinementIssue {
  path: (string | number)[];
  message: string;
}

/**
 * Статические правила блока `variants` (внутренняя целостность; сверка `params` с
 * объявлениями параметров живёт в `refineCompositionDocV3`, где эти объявления видны).
 */
export function variantsIssues(variants: CompositionVariants): VariantRefinementIssue[] {
  const issues: VariantRefinementIssue[] = [];
  const dimensionNames = Object.keys(variants.dimensions);
  for (const [name, values] of Object.entries(variants.dimensions)) {
    if (new Set(values).size !== values.length) {
      issues.push({ path: ["variants", "dimensions", name], message: `variant dimension "${name}" has duplicate values` });
    }
  }
  const seen = new Map<string, number>();
  variants.tuples?.forEach((tuple, index) => {
    const at = ["variants", "tuples", index, "dims"];
    for (const [name, value] of Object.entries(tuple.dims)) {
      const values = variants.dimensions[name];
      if (!values) { issues.push({ path: at, message: `tuple references an undeclared variant dimension: ${name}` }); continue; }
      if (!values.includes(value)) issues.push({ path: at, message: `tuple value "${value}" is not declared by dimension "${name}"` });
    }
    for (const name of dimensionNames) {
      if (Object.hasOwn(tuple.dims, name)) continue;
      issues.push({ path: at, message: `tuple does not fix the "${name}" dimension; every tuple must be complete` });
    }
    const signature = variantSignature(tuple.dims);
    const previous = seen.get(signature);
    if (previous !== undefined) issues.push({ path: at, message: `duplicate variant tuple (same combination as tuple ${previous})` });
    else seen.set(signature, index);
  });
  if (variants.defaults) {
    for (const [name, value] of Object.entries(variants.defaults)) {
      const values = variants.dimensions[name];
      if (!values) { issues.push({ path: ["variants", "defaults", name], message: `defaults reference an undeclared variant dimension: ${name}` }); continue; }
      if (!values.includes(value)) issues.push({ path: ["variants", "defaults", name], message: `default value "${value}" is not declared by dimension "${name}"` });
    }
    // Полные defaults обязаны сами быть легальной комбинацией — иначе ссылка без
    // `variant` резолвилась бы в несуществующий tuple.
    const complete = dimensionNames.every((name) => Object.hasOwn(variants.defaults!, name));
    if (complete && variants.tuples && !seen.has(variantSignature(variants.defaults))) {
      issues.push({ path: ["variants", "defaults"], message: "the default combination is not one of the declared tuples" });
    }
  }
  return issues;
}

export type VariantResolution =
  | { ok: true; dims: Record<string, string>; params: Record<string, JsonValue> }
  | { ok: false; issues: { message: string; code: string }[] };

/**
 * Резолв `props.variant` в точке ссылки: оси → tuple → значения параметров.
 * `defaults` доопределяют неуказанные оси; при заданных `tuples` легальны только
 * перечисленные комбинации.
 */
export function resolveVariant(
  variants: CompositionVariants | undefined,
  selection: unknown,
): VariantResolution {
  const issues: { message: string; code: string }[] = [];
  const parsed = compositionVariantSelectionSchema.safeParse(selection);
  if (!parsed.success) {
    return { ok: false, issues: [{ message: "variant must be a map of dimension names to string values", code: "composition/variant-unknown" }] };
  }
  if (!variants) {
    return { ok: false, issues: [{ message: "composition declares no variants", code: "composition/variant-unknown" }] };
  }
  const dims: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed.data)) {
    const values = variants.dimensions[name];
    if (!values) { issues.push({ message: `unknown variant dimension: ${name}`, code: "composition/variant-unknown" }); continue; }
    if (!values.includes(value)) { issues.push({ message: `variant dimension "${name}" has no value "${value}"`, code: "composition/variant-unknown" }); continue; }
    dims[name] = value;
  }
  for (const name of Object.keys(variants.dimensions)) {
    if (Object.hasOwn(dims, name)) continue;
    const fallback = variants.defaults?.[name];
    if (fallback === undefined) {
      issues.push({ message: `variant does not fix the "${name}" dimension and it has no default`, code: "composition/variant-incomplete" });
      continue;
    }
    dims[name] = fallback;
  }
  if (issues.length) return { ok: false, issues };
  if (!variants.tuples) return { ok: true, dims, params: {} };
  const signature = variantSignature(dims);
  const tuple = variants.tuples.find((candidate) => variantSignature(candidate.dims) === signature);
  if (!tuple) {
    return { ok: false, issues: [{ message: `variant combination ${signature} is not one of the declared tuples`, code: "composition/variant-unknown-tuple" }] };
  }
  return { ok: true, dims, params: { ...(tuple.params ?? {}) } };
}

/**
 * Измерения вариантов документа — чистая проекция для потребителей за пределами
 * раскрытия (стык с case-set-измерениями W2: потребитель подключается отдельно).
 * Документ без вариантов (в том числе v1/v2) даёт пустую карту.
 */
export function variantDimensionsOf(doc: { version?: unknown; variants?: unknown }): Record<string, string[]> {
  if (doc.version !== 3) return {};
  const parsed = compositionVariantsSchema.safeParse(doc.variants);
  if (!parsed.success) return {};
  return Object.fromEntries(Object.entries(parsed.data.dimensions).map(([name, values]) => [name, [...values]]));
}
