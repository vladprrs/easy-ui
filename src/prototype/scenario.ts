import { z } from "zod";
import { isSafeJsonPointer } from "./pointer";
import { jsonValueSchema, slugSchema } from "./schema";

/**
 * Сценарий взаимодействия (волна 6, план 2026-07-27 §«Волна 6», фидбэк §7).
 *
 * Сценарий — записанная в плеере последовательность кликов и ожиданий, которая
 * хранится рядом с прототипом (таблица `prototype_scenarios`, миграция v19) и
 * переигрывается клиентом для черновика и для неизменяемой версии.
 *
 * Жёсткие рамки (урезание по триажу ревью):
 * - серверного headless-прогона нет, таблицы прогонов нет — раннер живёт в браузере;
 * - гейт `interactions` в readiness информационный и никогда не блокирует публикацию.
 *
 * Ключи элементов **ревизионно-скоупные**: `elementKey` — ключ уже раскрытого
 * документа (`expandCompositions` даёт `<hostKey>$<innerKey>`), поэтому в схеме
 * `$` разрешён, в отличие от авторских ключей (`authoredElementKeySchema`).
 * Пропавший ключ — это дрейф ревизии, и раннер помечает шаг `stale`, а не `fail`.
 */

export const SCENARIO_STEPS_LIMIT = 200;
export const SCENARIOS_PER_PROTOTYPE_LIMIT = 50;
export const SCENARIO_NAME_LIMIT = 120;
export const SCENARIO_TEXT_LIMIT = 300;
export const SCENARIO_ELEMENT_KEY_LIMIT = 300;

/** Раскрытый ключ элемента: `$` допустим (разделитель раскрытия композиции). */
const elementKeySchema = z.string().min(1).max(SCENARIO_ELEMENT_KEY_LIMIT);

/**
 * Абсолютный RFC 6901 указатель состояния. Проверка та же, что у действий рантайма
 * (`isSafeJsonPointer`): сегменты `__proto__`/`prototype`/`constructor` отвергаются.
 */
const statePointerSchema = z.string().min(1).max(200).refine(isSafeJsonPointer, "must be a safe absolute JSON Pointer");

export const SCENARIO_STEP_TYPES = ["click", "expectScreen", "expectText", "setState", "expectState", "expectDisabled"] as const;
export type ScenarioStepType = (typeof SCENARIO_STEP_TYPES)[number];

export const scenarioStepSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("click"), elementKey: elementKeySchema, label: z.string().max(SCENARIO_NAME_LIMIT).optional() }),
  z.strictObject({ type: z.literal("expectScreen"), screenId: slugSchema }),
  z.strictObject({ type: z.literal("expectText"), text: z.string().trim().min(1).max(SCENARIO_TEXT_LIMIT) }),
  z.strictObject({ type: z.literal("setState"), pointer: statePointerSchema, value: jsonValueSchema }),
  z.strictObject({ type: z.literal("expectState"), pointer: statePointerSchema, value: jsonValueSchema }),
  z.strictObject({ type: z.literal("expectDisabled"), elementKey: elementKeySchema }),
]);
export type ScenarioStep = z.infer<typeof scenarioStepSchema>;

export const scenarioStepsSchema = z.array(scenarioStepSchema).min(1).max(SCENARIO_STEPS_LIMIT);

/** Тело записи/обновления сценария. Шаги — единственный носитель семантики. */
export const scenarioInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(SCENARIO_NAME_LIMIT),
  steps: scenarioStepsSchema,
});
export type ScenarioInput = z.infer<typeof scenarioInputSchema>;

/** Сценарий, как его отдаёт API. */
export interface PrototypeScenario extends ScenarioInput {
  id: string;
  prototypeId: string;
  author: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Экран входа прогона: ведущий `expectScreen` задаёт точку старта записи (рекордер
 * всегда пишет его первым шагом), иначе прогон начинается со `startScreen` документа.
 */
export function scenarioEntryScreen(steps: readonly ScenarioStep[], startScreen: string): string {
  const first = steps[0];
  return first?.type === "expectScreen" ? first.screenId : startScreen;
}

/** Идентификатор сценария: slug, генерируется клиентом или сервером. */
export const scenarioIdSchema = slugSchema.max(64);
