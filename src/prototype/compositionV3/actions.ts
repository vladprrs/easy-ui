import { z } from "zod";
import { elementActionSchema, elementHandlerSchema, type ElementAction } from "../schema";

/**
 * Параметры-действия композиций v3 (план 2026-08-03 §5 W8d, триаж T-M6).
 *
 * §19.4.5 просил «typed event → composition output». Такой конструкции не существует:
 * host-элемент `@eui/Composition` **исчезает** при раскрытии, рантайм-границы композиции
 * нет, и событию композиции просто негде родиться. Вместо этого точка ссылки передаёт
 * **готовый биндинг обработчика** — ровно ту же грамматику, что `element.on.<event>` —
 * а раскрытие вписывает его в `on` целевых элементов тела. Это по-прежнему
 * expansion-time: после раскрытия остаётся обычный `on`, который проверяет обычный
 * `validatePrototype` (в том числе навигационные цели против экранов документа).
 */

/** Значение параметра типа `action`: одно действие или непустой массив действий. */
export const compositionActionValueSchema = elementHandlerSchema;
export type CompositionActionValue = z.output<typeof compositionActionValueSchema>;

/** Значение в точке ссылки — валидный биндинг обработчика. */
export const actionValueMatches = (value: unknown): boolean =>
  compositionActionValueSchema.safeParse(value).success;

/** Нормализованный список действий (одиночное действие — массив из одного). */
export const actionList = (value: CompositionActionValue): ElementAction[] =>
  Array.isArray(value) ? value : [value];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `{"$param": "name"}` — та же директива, что в props, но в позиции обработчика. */
export const isActionParamDirective = (value: unknown): value is { $param: string } =>
  isObject(value) && Object.keys(value).length === 1 && typeof value.$param === "string";

/** Директива в позиции действия (только тело v3). */
const actionParamDirectiveSchema = z.strictObject({ $param: z.string().min(1) });

/**
 * `element.on.<event>` тела v3: обычное действие/массив действий, как в прототипе, плюс
 * `{"$param": …}` — целиком вместо обработчика или отдельным элементом массива.
 * Глубже директива не допускается (подстановка туда не ходит) — правило статическое,
 * см. `refineCompositionDocV3`.
 */
export const compositionHandlerV3Schema = z.union([
  actionParamDirectiveSchema,
  elementActionSchema,
  z.array(z.union([actionParamDirectiveSchema, elementActionSchema])).min(1),
]);

export interface HandlerSubstitutionContext {
  /** Объявленный тип параметра (или `undefined`, если параметр не объявлен). */
  paramType: (name: string) => string | undefined;
  /** Значение параметра в точке ссылки — с учётом default'а. */
  paramValue: (name: string) => unknown;
  addIssue: (message: string, code?: string) => void;
}

/**
 * Подставляет `{"$param": …}` в `element.on` тела v3.
 *
 * Директива допустима **только** как значение всего обработчика или как элемент его
 * массива (глубже подстановка не ходит — это запрещено статически, см.
 * `refineCompositionDocV3`). Незаполненный необязательный параметр удаляет свои
 * действия; событие без оставшихся действий исчезает вместе с ключом.
 */
export function substituteHandlers(
  on: Record<string, unknown> | undefined,
  elementKey: string,
  context: HandlerSubstitutionContext,
): Record<string, unknown> | undefined {
  if (!on || !Object.keys(on).length) return on;

  const resolve = (name: string, event: string): ElementAction[] => {
    const declared = context.paramType(name);
    const where = `${elementKey}/on/${event}`;
    if (declared === undefined) {
      context.addIssue(`references an undeclared param "${name}" at ${where}`, "composition/action-param-undeclared");
      return [];
    }
    if (declared !== "action") {
      context.addIssue(`param "${name}" is ${declared}, not an action, and cannot be bound to ${where}`, "composition/action-param-type");
      return [];
    }
    const value = context.paramValue(name);
    if (value === undefined) return [];
    const parsed = compositionActionValueSchema.safeParse(value);
    if (!parsed.success) {
      context.addIssue(`action param "${name}" is not a valid handler binding at ${where}`, "composition/action-invalid");
      return [];
    }
    return actionList(parsed.data);
  };

  const result: Record<string, unknown> = {};
  for (const [event, binding] of Object.entries(on)) {
    let actions: unknown[];
    if (isActionParamDirective(binding)) actions = resolve(binding.$param, event);
    else if (Array.isArray(binding)) {
      actions = binding.flatMap((item) => (isActionParamDirective(item) ? resolve(item.$param, event) : [item]));
    } else actions = [binding];
    if (!actions.length) continue;
    result[event] = actions.length === 1 ? actions[0] : actions;
  }
  return Object.keys(result).length ? result : undefined;
}
