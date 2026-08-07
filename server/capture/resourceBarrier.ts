/**
 * Точка включения детерминированного барьера ресурсов (план 2026-08-07 §W2, §1.5).
 *
 * Барьер включается **политикой профиля приёмки** (`ACCEPTANCE_POLICIES`) и пресетом режима
 * `reference` (`modes.ts`), а не флагом внутри `resolveCaptureMode`: acceptance-режим несёт лишь
 * дефолт, реальную политику рана выдаёт профиль, поэтому «включить барьер в modes.ts» не включило
 * бы его нигде, где он нужен (опровержение механизма v1, раунд 1 ревью).
 *
 * Kill-switch `EASYUI_RESOURCE_BARRIER_DISABLED=1` возвращает **доволновую политику каждого
 * профиля** (`default-v1` → v1, `pixel-strict-v1` → v2, `reference` → v2), а не «всем v2»: иначе
 * аварийное выключение барьера молча ужесточило бы дефолтный профиль до строгой readiness R4 и
 * поменяло бы вердикты там, где их никто не трогал.
 *
 * Флаг читается **один раз на процесс**: политика профиля входит в `policyProfileHash`,
 * `readinessPolicyHash` и `rendererFingerprint`, и «на середине жизни процесса стало другое
 * значение» означало бы два разных отпечатка у одного рана. Смена флага — рестарт сервера.
 */
import {
  BARRIER_READINESS_POLICY, DEFAULT_READINESS_POLICY, STRICT_READINESS_POLICY,
  type ReadinessPolicy,
} from "../../src/capture/readinessPolicy";

/**
 * Кому нужна политика: два профиля приёмки, пресет эталонной съёмки и **опт-ин галерейной
 * джобы** (`readiness:"barrier"` в screenshot-запросе, триаж O-M4: потеря registry-листов
 * воспроизводилась на интерактивном пути, который снимается по v1). Доволновое поведение опт-ина —
 * дефолт интерактивного режима, поэтому при включённом kill-switch параметр становится no-op'ом,
 * а не тихо включает строгую readiness R4 галерее.
 */
export type BarrierPolicyScope = "acceptance-default" | "acceptance-strict" | "reference" | "gallery";

/** Доволновая политика каждого потребителя — она же поведение при включённом kill-switch. */
const PRE_WAVE_POLICY: Readonly<Record<BarrierPolicyScope, ReadinessPolicy>> = Object.freeze({
  "acceptance-default": DEFAULT_READINESS_POLICY,
  "acceptance-strict": STRICT_READINESS_POLICY,
  reference: STRICT_READINESS_POLICY,
  gallery: DEFAULT_READINESS_POLICY,
});

/** Значение kill-switch'а на момент старта процесса (регистрация — `server/main.ts`). */
export const RESOURCE_BARRIER_DISABLED: boolean =
  typeof process !== "undefined" && process.env?.EASYUI_RESOURCE_BARRIER_DISABLED === "1";

/**
 * Политика readiness потребителя. Чистая функция от скоупа и состояния kill-switch'а — именно она,
 * а не сам флаг, проверяется тестом волны: «выключенный барьер возвращает по-профильную доволновую
 * политику», а не одну на всех.
 */
export function barrierAwareReadinessPolicy(
  scope: BarrierPolicyScope,
  disabled: boolean = RESOURCE_BARRIER_DISABLED,
): ReadinessPolicy {
  return disabled ? PRE_WAVE_POLICY[scope] : BARRIER_READINESS_POLICY;
}

/** Политика требует исполнения барьера (гейт `readiness` спрашивает именно это, а не версию). */
export const readinessRequiresBarrier = (policy: ReadinessPolicy): boolean => policy.resourceBarrier !== undefined;
