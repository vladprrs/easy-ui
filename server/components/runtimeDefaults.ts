/**
 * Серверная сторона runtime schema defaults (план `docs/plans/2026-08-07-migration-feedback-wave.md`
 * §1.6, §W9).
 *
 * Здесь живут ровно две вещи, которых нет на клиенте:
 *
 * 1. **Чтение аварийного kill-switch'а** `EASYUI_RUNTIME_DEFAULTS_DISABLED`. Env читается на
 *    каждый вызов, а не один раз при старте: переключатель аварийный, и «перезапустите процесс,
 *    чтобы откат подействовал» — не то свойство, которое от него нужно. Значение уезжает
 *    поверхности полем `bootstrap.runtimeDefaultsDisabled` (`server/screenshot/service.ts`).
 * 2. **Ответ на вопрос «объявляет ли семья флаг»** — из `CandidateEntry.extracted.meta.capabilities`
 *    (`server/components/candidates.ts`), то есть из того же результата извлечения, который видел
 *    publish. Другого источника у неопубликованной головы нет: `component_publishes.definition_meta`
 *    появляется только после promote.
 *
 * Почему предупреждение вообще нужно. Kill-switch **render-affecting**: он меняет пиксели, не
 * входя ни в один отпечаток (триаж O-m16). Значит ран, снятый при поднятом флаге, внешне
 * неотличим от честного, и его `pass` — это `pass` другого продукта. Отсюда правило §1.6: при
 * поднятом kill-switch приёмка флагнутых семей недействительна, и `accept-status` обязан сказать
 * это словами, а не оставить читателю догадываться.
 */
import { readCandidate } from "./candidates";

/** Аварийный kill-switch волны W9. Регистрация в compose/`main.ts` — задача §W11. */
export const runtimeDefaultsDisabled = (): boolean =>
  process.env.EASYUI_RUNTIME_DEFAULTS_DISABLED === "1";

/**
 * Объявляет ли исходник кандидата `capabilities.runtimeSchemaDefaults`. `false` и на «не
 * объявляет», и на «записи кандидата больше нет» (TTL/GC): предупреждение — advisory, и
 * выдумывать флаг там, где доказательства не осталось, нельзя.
 */
export async function candidateDeclaresRuntimeDefaults(dataDir: string, sourceHash: string): Promise<boolean> {
  const entry = await readCandidate(dataDir, sourceHash);
  return entry?.extracted?.meta?.capabilities?.runtimeSchemaDefaults === true;
}

/**
 * Предупреждение рана о поднятом kill-switch'е. Форма — та же, что у `policy_exception_stale`
 * (`server/acceptance/suggest.ts`): `code` + человекочитаемый `detail`, никакого влияния ни на
 * вердикт, ни на promote (гейтить promote этим значило бы завести второй, невидимый источник
 * отказа — а отказ обязан быть один и назван).
 */
export interface RuntimeDefaultsDisabledWarning {
  code: "runtime_defaults_disabled";
  candidateId: string;
  componentId: string;
  detail: string;
}

/**
 * Собирает предупреждение, если оба условия сошлись: флаг поднят **и** семья его объявляет.
 * Проверка порядком не случайна — при опущенном kill-switch (штатный режим) файл кандидата не
 * читается вовсе, и горячий путь `accept-status` остаётся без единого лишнего syscall'а.
 */
export async function runtimeDefaultsWarnings(
  dataDir: string,
  run: { candidate_id: string; component_id: string },
  candidateSourceHash: string | null,
): Promise<RuntimeDefaultsDisabledWarning[]> {
  if (!runtimeDefaultsDisabled() || candidateSourceHash === null) return [];
  if (!(await candidateDeclaresRuntimeDefaults(dataDir, candidateSourceHash))) return [];
  return [{
    code: "runtime_defaults_disabled",
    candidateId: run.candidate_id,
    componentId: run.component_id,
    detail: "EASYUI_RUNTIME_DEFAULTS_DISABLED is set: the host did not apply schema defaults declared by"
      + " capabilities.runtimeSchemaDefaults, so this run judged a render the product does not ship."
      + " Clear the kill-switch and re-run before promoting; the supported per-component rollback is"
      + " republishing the source without the capability.",
  }];
}
