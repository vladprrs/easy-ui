import { z } from "zod";
import { jsonValueSchema, slugSchema, type JsonValue } from "../schema";

/**
 * Параметрические условия композиций v3 (план 2026-08-03 §5 W8a, граница D7).
 *
 * **Обе конструкции статически разрешимы от значений параметров в точке ссылки**
 * и полностью исчезают при раскрытии:
 * - `element.when` — элемент и всё его поддерево не материализуются, если условие ложно
 *   (optional branch = отсутствие элемента; ветки `else` нет);
 * - `{"$switch": {...}}` в значении props — подстановка значения по значению параметра.
 *
 * Рантайм-ветвление остаётся за `$cond`/`doc.state`: они проходят раскрытие как есть.
 */

export const COMPOSITION_WHEN_IN_LIMIT = 30;
export const COMPOSITION_SWITCH_CASES_LIMIT = 30;

export const compositionWhenSchema = z.strictObject({
  param: slugSchema,
  eq: jsonValueSchema.optional(),
  neq: jsonValueSchema.optional(),
  in: z.array(jsonValueSchema).min(1).max(COMPOSITION_WHEN_IN_LIMIT).optional(),
}).superRefine((when, context) => {
  const operators = (["eq", "neq", "in"] as const).filter((key) => Object.hasOwn(when, key) && when[key] !== undefined);
  if (operators.length !== 1) {
    context.addIssue({ code: "custom", message: "when requires exactly one of eq, neq or in" });
  }
});

export type CompositionWhen = z.output<typeof compositionWhenSchema>;

export const compositionSwitchSchema = z.strictObject({
  param: slugSchema,
  cases: z.record(z.string().min(1), jsonValueSchema),
  default: jsonValueSchema.optional(),
}).superRefine((directive, context) => {
  const size = Object.keys(directive.cases).length;
  if (size < 1) context.addIssue({ code: "custom", path: ["cases"], message: "$switch requires at least one case" });
  if (size > COMPOSITION_SWITCH_CASES_LIMIT) {
    context.addIssue({ code: "custom", path: ["cases"], message: `$switch exceeds ${COMPOSITION_SWITCH_CASES_LIMIT} cases` });
  }
});

export type CompositionSwitch = z.output<typeof compositionSwitchSchema>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `{"$switch": {...}}` — единственный ключ, как и у `$param`/`$asset`. */
export const isSwitchDirective = (value: unknown): value is { $switch: unknown } =>
  isObject(value) && Object.keys(value).length === 1 && Object.hasOwn(value, "$switch");

const jsonEquals = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => jsonEquals(item, b[index]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => Object.hasOwn(b, key) && jsonEquals(a[key], b[key]));
  }
  return false;
};

/**
 * Значение условия. Незаполненный необязательный параметр (`undefined`) не равен никакому
 * JSON-значению: `eq`/`in` дают `false`, `neq` — `true`.
 */
export function evaluateWhen(when: CompositionWhen, value: unknown): boolean {
  if (Object.hasOwn(when, "eq") && when.eq !== undefined) return jsonEquals(value, when.eq);
  if (Object.hasOwn(when, "neq") && when.neq !== undefined) return !jsonEquals(value, when.neq);
  return (when.in ?? []).some((candidate) => jsonEquals(value, candidate));
}

/** Ключ case'а по значению параметра: строки — как есть, числа/булевы — их каноническая запись. */
export function switchCaseKey(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

export type SwitchResolution =
  | { ok: true; value: JsonValue }
  | { ok: false; message: string };

/** Разрешение `$switch` от значения параметра. Нет case'а и нет `default` — ошибка раскрытия. */
export function resolveSwitch(directive: CompositionSwitch, value: unknown): SwitchResolution {
  const key = switchCaseKey(value);
  if (key !== undefined && Object.hasOwn(directive.cases, key)) return { ok: true, value: directive.cases[key]! };
  if (Object.hasOwn(directive, "default") && directive.default !== undefined) return { ok: true, value: directive.default };
  return {
    ok: false,
    message: key === undefined
      ? `$switch on param "${directive.param}" has no default and the parameter has no value`
      : `$switch on param "${directive.param}" has no case for "${key}" and no default`,
  };
}

/**
 * Ключи, не материализуемые при раскрытии: элементы с ложным `when` и **всё их поддерево**.
 * Каждый элемент композиции имеет не более одного родителя (правило схемы), поэтому обход
 * детей достаточен.
 */
export function hiddenElementKeys(
  elements: Record<string, { children?: string[]; when?: CompositionWhen }>,
  visible: (when: CompositionWhen) => boolean,
): Set<string> {
  const hidden = new Set<string>();
  for (const [key, element] of Object.entries(elements)) {
    if (element.when !== undefined && !visible(element.when)) hidden.add(key);
  }
  const stack = [...hidden];
  while (stack.length) {
    const key = stack.pop()!;
    for (const child of elements[key]?.children ?? []) {
      if (hidden.has(child)) continue;
      hidden.add(child);
      stack.push(child);
    }
  }
  return hidden;
}
