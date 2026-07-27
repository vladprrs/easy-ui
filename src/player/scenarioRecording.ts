import { SCENARIO_STEPS_LIMIT, type ScenarioStep } from "../prototype/scenario";
import { EUI_KEY_ATTRIBUTE } from "../catalog/runtime";

/**
 * Чистая часть рекордера сценариев (волна 6): что именно попадает в шаги при
 * клике и при навигации. UI живёт в `scenarioPanel.tsx`, здесь — только правила,
 * чтобы их можно было проверить без DOM и без рантайма плеера.
 */

export const SCENARIO_LABEL_LIMIT = 120;

/** Ближайший вверх по composedPath элемент с `data-eui-key` (маркер ставит рантайм каталога). */
export function elementKeyFromPath(path: readonly EventTarget[]): { elementKey: string; label?: string } | null {
  for (const item of path) {
    if (!(item instanceof HTMLElement)) continue;
    const key = item.getAttribute(EUI_KEY_ATTRIBUTE);
    if (key === null) continue;
    const label = (item.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, SCENARIO_LABEL_LIMIT);
    return label ? { elementKey: key, label } : { elementKey: key };
  }
  return null;
}

const atLimit = (steps: readonly ScenarioStep[]): boolean => steps.length >= SCENARIO_STEPS_LIMIT;

/** Первый шаг записи — фиксация экрана входа: он же задаёт точку старта прогона. */
export function startRecording(screenId: string): ScenarioStep[] {
  return [{ type: "expectScreen", screenId }];
}

export function appendStep(steps: readonly ScenarioStep[], step: ScenarioStep): ScenarioStep[] {
  return atLimit(steps) ? [...steps] : [...steps, step];
}

/**
 * Навигация записывается как `expectScreen`. Повторная фиксация того же экрана
 * подряд бессмысленна (перерисовка, возврат на тот же экран) и отбрасывается.
 */
export function appendScreenStep(steps: readonly ScenarioStep[], screenId: string): ScenarioStep[] {
  const last = steps[steps.length - 1];
  if (last?.type === "expectScreen" && last.screenId === screenId) return [...steps];
  return appendStep(steps, { type: "expectScreen", screenId });
}

export function appendClickStep(steps: readonly ScenarioStep[], hit: { elementKey: string; label?: string }): ScenarioStep[] {
  return appendStep(steps, { type: "click", elementKey: hit.elementKey, ...(hit.label ? { label: hit.label } : {}) });
}

export function removeStep(steps: readonly ScenarioStep[], index: number): ScenarioStep[] {
  return steps.filter((_, position) => position !== index);
}

/** Слаг сценария из имени: используется, когда автор не задал id явно. */
export function scenarioIdFromName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return slug || `scenario-${Date.now().toString(36)}`;
}
