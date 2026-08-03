import { z } from "zod";
import { slugSchema } from "../schema";
import { COMPOSITION_ARRAY_MAX_ITEMS_LIMIT, compositionFieldNameSchema } from "./params";

/**
 * `repeatParam` — разворачивание элемента по параметру-массиву (план 2026-08-03 §5 W8b).
 *
 * Это **expansion-time** конструкция (граница D7): длина списка известна из значения
 * параметра в точке ссылки, поэтому раскрытие клонирует поддерево статически, а в
 * сохранённом документе никакого повторителя не остаётся. State-driven `repeat`
 * (`element.repeat` схемы прототипа) живёт параллельно и этой волной не затрагивается.
 *
 * Ключи клонов — в **авторском** пространстве композиции: `<innerKey>__r<suffix>`.
 * `$` зарезервирован за разделителем раскрытых ключей (`hostKey$innerKey`), поэтому
 * подстрока `__r` запрещена в авторских ключах тела v3 — коллизий не остаётся
 * по построению, а суффикс из `key` санитизируется до `[A-Za-z0-9-]`.
 */

export const COMPOSITION_REPEAT_SEPARATOR = "__r";

/** Авторский ключ элемента тела v3 не должен содержать зарезервированную подстроку. */
export const isReservedRepeatKey = (key: string): boolean => key.includes(COMPOSITION_REPEAT_SEPARATOR);

export const compositionRepeatParamSchema = z.strictObject({
  param: slugSchema,
  /** Поле item-объекта, дающее стабильный суффикс ключа вместо индекса. */
  key: compositionFieldNameSchema.optional(),
  /** Верхняя граница разворачивания; не больше `maxItems` самого параметра. */
  maxItems: z.number().int().min(1).max(COMPOSITION_ARRAY_MAX_ITEMS_LIMIT).optional(),
});

export type CompositionRepeatParam = z.output<typeof compositionRepeatParamSchema>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `{"$item": "field"}` / `{"$item": true}` — значение текущего элемента массива. */
export const isItemDirective = (value: unknown): value is { $item: unknown } =>
  isObject(value) && Object.keys(value).length === 1 && Object.hasOwn(value, "$item");

/** `{"$index": true}` — порядковый номер текущего элемента массива. */
export const isIndexDirective = (value: unknown): value is { $index: unknown } =>
  isObject(value) && Object.keys(value).length === 1 && Object.hasOwn(value, "$index");

export interface RepeatableElement {
  type: string;
  props: Record<string, unknown>;
  children?: string[];
  repeat?: unknown;
  repeatParam?: CompositionRepeatParam;
  [key: string]: unknown;
}

/** Значение `$item`/`$index` для клона. */
export interface RepeatScope {
  item: unknown;
  index: number;
}

export interface MaterializedRepeats<E extends RepeatableElement> {
  /** Тело без `repeatParam`: клоны уже развёрнуты, ссылки детей переписаны. */
  elements: Record<string, E>;
  /** Клонированный ключ → его item/index (подстановка `$item`/`$index` в props). */
  scopes: Map<string, RepeatScope>;
}

const sanitizeSuffix = (value: unknown): string | undefined => {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return undefined;
  const text = String(value).replace(/[^A-Za-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return text.length ? text : undefined;
};

/** Ключ клона: `<innerKey>__r<index|sanitized(item[key])>`. */
export const repeatCloneKey = (innerKey: string, suffix: string): string =>
  `${innerKey}${COMPOSITION_REPEAT_SEPARATOR}${suffix}`;

/** Ключи поддерева в **авторском** порядке объявления (детерминизм ключей и диагностик). */
export function subtreeKeys<E extends RepeatableElement>(elements: Record<string, E>, root: string): string[] {
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length) {
    const key = stack.pop()!;
    if (seen.has(key)) continue;
    if (!Object.hasOwn(elements, key)) continue;
    seen.add(key);
    for (const child of elements[key]!.children ?? []) stack.push(child);
  }
  return Object.keys(elements).filter((key) => seen.has(key));
}

/**
 * Разворачивает `repeatParam` в плоское тело композиции.
 *
 * Возвращённая карта уже не содержит `repeatParam`, поэтому весь дальнейший конвейер
 * раскрытия (условия `when`, подстановка props, маршрутизация слотов, бюджеты) работает
 * с обычным телом. Значение параметра, не являющееся массивом, элемент не разворачивает —
 * несоответствие типа уже отмечено `paramValueMatches` в точке ссылки.
 */
export function materializeRepeats<E extends RepeatableElement>(
  elements: Record<string, E>,
  valueOf: (param: string) => unknown,
  addIssue: (message: string, code?: string) => void,
  maxElements: number,
): MaterializedRepeats<E> {
  const repeatRoots = Object.keys(elements).filter((key) => elements[key]!.repeatParam !== undefined);
  if (!repeatRoots.length) return { elements, scopes: new Map() };

  const cloned = new Map<string, string[]>(); // repeatRoot → корневые ключи клонов
  const clonedElements = new Map<string, Array<[string, E]>>();
  const inRepeat = new Set<string>();
  const scopes = new Map<string, RepeatScope>();
  let budget = maxElements;

  const rewrite = (children: string[] | undefined, map?: Map<string, string>): string[] | undefined => {
    if (!children) return undefined;
    return children.flatMap((child) => {
      const mapped = map?.get(child);
      if (mapped !== undefined) return [mapped];
      const clones = cloned.get(child);
      return clones ? [...clones] : [child];
    });
  };

  for (const root of repeatRoots) {
    const directive = elements[root]!.repeatParam!;
    const keys = subtreeKeys(elements, root);
    for (const key of keys) inRepeat.add(key);

    const raw = valueOf(directive.param);
    const items = Array.isArray(raw) ? raw : [];
    const limit = directive.maxItems ?? items.length;
    if (items.length > limit) {
      addIssue(`repeatParam on "${root}" is capped at ${limit} items, got ${items.length}`, "composition/repeat-max-items");
    }
    const used = items.slice(0, limit);

    const roots: string[] = [];
    const entries: Array<[string, E]> = [];
    const usedSuffixes = new Set<string>();
    used.forEach((item, index) => {
      const suffix = (directive.key === undefined ? undefined : sanitizeSuffix(isObject(item) ? item[directive.key] : undefined))
        ?? String(index);
      if (usedSuffixes.has(suffix)) {
        addIssue(`repeatParam on "${root}" produced a duplicate key suffix "${suffix}"; the key field must be unique`, "composition/repeat-key-collision");
        return;
      }
      usedSuffixes.add(suffix);
      budget -= keys.length;
      if (budget < 0) {
        addIssue(`repeatParam expansion exceeds ${maxElements} elements`, "composition/expanded-elements");
        return;
      }
      const map = new Map(keys.map((key) => [key, repeatCloneKey(key, suffix)]));
      for (const key of keys) {
        const cloneKey = map.get(key)!;
        if (Object.hasOwn(elements, cloneKey)) {
          addIssue(`repeatParam key collides with an authored element key: ${cloneKey}`, "composition/repeat-key-collision");
          continue;
        }
        const children = rewrite(elements[key]!.children, map);
        const clone = { ...elements[key]!, ...(children ? { children } : {}) } as E;
        delete (clone as { repeatParam?: unknown }).repeatParam;
        entries.push([cloneKey, clone]);
        scopes.set(cloneKey, { item, index });
      }
      roots.push(map.get(root)!);
    });
    cloned.set(root, roots);
    clonedElements.set(root, entries);
  }

  // Авторский порядок сохраняется: клоны встают на место своего `repeatParam`-элемента.
  const result: Record<string, E> = {};
  for (const [key, element] of Object.entries(elements)) {
    const entries = clonedElements.get(key);
    if (entries) { for (const [cloneKey, clone] of entries) result[cloneKey] = clone; continue; }
    if (inRepeat.has(key)) continue;
    const children = rewrite(element.children);
    result[key] = { ...element, ...(children ? { children } : {}) } as E;
  }
  return { elements: result, scopes };
}
