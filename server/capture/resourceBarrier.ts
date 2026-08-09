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
  barrierPolicyIsV4,
  BARRIER_READINESS_POLICY_V3, BARRIER_READINESS_POLICY_V4, DEFAULT_READINESS_POLICY, STRICT_READINESS_POLICY,
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
 * **Второй этаж иерархии** (BR-03, план 2026-08-08 §3): `EASYUI_RESOURCE_BARRIER_V4_DISABLED=1`
 * оставляет барьер включённым, но исполняемым по политике v3 **byte-for-byte** — тот же пре-образ
 * `readinessPolicyHash`, те же кадры, те же отпечатки, что до волны.
 *
 * Приоритет отдан старому свитчу: `EASYUI_RESOURCE_BARRIER_DISABLED=1` гасит барьер целиком, и
 * значение v4-свитча при нём не читается вовсе — иначе «выключено» имело бы два разных смысла.
 *
 * Читается **один раз на процесс** по той же причине, что и старший свитч: политика питает
 * `policyProfileHash`, `readinessPolicyHash` и `rendererFingerprint`, и смена значения на середине
 * жизни процесса дала бы два разных отпечатка у одного рана. Смена — рестарт сервера.
 */
export const RESOURCE_BARRIER_V4_DISABLED: boolean =
  typeof process !== "undefined" && process.env?.EASYUI_RESOURCE_BARRIER_V4_DISABLED === "1";

/**
 * Политика readiness потребителя. Чистая функция от скоупа и состояния обоих kill-switch'ей —
 * именно она, а не сами флаги, проверяется тестами волны: «выключенный барьер возвращает
 * по-профильную доволновую политику» и «выключенная v4 возвращает v3 байт-в-байт».
 */
export function barrierAwareReadinessPolicy(
  scope: BarrierPolicyScope,
  disabled: boolean = RESOURCE_BARRIER_DISABLED,
  v4Disabled: boolean = RESOURCE_BARRIER_V4_DISABLED,
): ReadinessPolicy {
  if (disabled) return PRE_WAVE_POLICY[scope];
  return v4Disabled ? BARRIER_READINESS_POLICY_V3 : BARRIER_READINESS_POLICY_V4;
}

/**
 * Активен ли барьер волны BR-03 (`features.resourceBarrierV4`). Гаснет под **обоими** свитчами:
 * без барьера нет и его четвёртой версии.
 */
export const resourceBarrierV4Enabled = (): boolean => !RESOURCE_BARRIER_DISABLED && !RESOURCE_BARRIER_V4_DISABLED;

/**
 * Фактическая версия политики барьера, объявляемая capability (`resourceBarrierPolicyVersion`):
 * `4` — волна активна, `3` — v4 выключена свитчём, доволновое значение дефолтного профиля — при
 * выключенном барьере целиком (там у каждого профиля своя, см. `PRE_WAVE_POLICY`).
 */
export const resourceBarrierPolicyVersion = (scope: BarrierPolicyScope = "acceptance-default"): number =>
  barrierAwareReadinessPolicy(scope).version;

/** Политика требует исполнения барьера (гейт `readiness` спрашивает именно это, а не версию). */
export const readinessRequiresBarrier = (policy: ReadinessPolicy): boolean => policy.resourceBarrier !== undefined;

/**
 * Политика джобы — барьер волны BR-03. Спрашивается **у политики случая**, а не у env: гейт судит
 * кадр, снятый под той политикой, которая уехала в его bootstrap, и env к моменту разбора мог
 * успеть смениться рестартом.
 */
export const readinessRequiresBarrierV4 = (policy: ReadinessPolicy): boolean =>
  barrierPolicyIsV4(policy.resourceBarrier);
