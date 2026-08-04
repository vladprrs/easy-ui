/**
 * Декларативная политика readiness капчура (план `docs/plans/2026-08-03-family-acceptance-and-composition-v3.md`
 * §3 D5, §5 W4).
 *
 * Смысл файла — **убрать задержки как способ добиться стабильного кадра**. Вместо «подождать
 * 500 мс и надеяться» поверхность получает объявленный набор условий (шрифты, декодированные
 * картинки, тишина сети по ресурсам компонента, N стабильных кадров, выключенные анимации) и
 * потолок ожидания. Политика **версионируется и хешируется**: её хэш входит в `case_fingerprint`
 * (D1), поэтому смена условий автоматически инвалидирует накопленный reuse — а результат капчура
 * несёт доказательство (`ready.readiness.evidence`), по которому гейт `readiness` судит, был ли
 * кадр вообще пригоден для визуального вердикта (инвариант D5).
 *
 * Модуль общий для клиента (капчур-поверхность), воркера и сервера, поэтому здесь нет ни
 * `Bun.*`, ни node-API: только `crypto.subtle`, который есть и в браузере, и в Bun.
 */
import { canonicalStringify } from "./canonicalJson";

/** Тишина сети считается только по ресурсам, которые тянет сам компонент (`/api/assets`, тема). */
export interface ReadinessNetworkPolicy {
  quietMs: number;
  scope: "component-owned";
}

/**
 * Стабилизация layout (план renderer-contract-2 §5 R4, P5): «rAF → мера → rAF → мера →
 * сравнение» до `attempts` попыток. Присутствует только в политике v2 — в v1 ключа нет вовсе,
 * иначе изменился бы `policyHash` доволновых политик и обнулился накопленный reuse (K-инвариант).
 */
export interface ReadinessLayoutPolicy {
  stabilize: boolean;
  /** Сколько раз пересмерять, прежде чем признать layout неустойчивым. */
  attempts: number;
}

export interface ReadinessPolicy {
  /**
   * `1` — доволновая политика (см. `DEFAULT_READINESS_POLICY`), `2` — строгая (R4,
   * `STRICT_READINESS_POLICY`). Версия — не украшение: она выбирает семантику каждого поля ниже,
   * и её валидирует `isReadinessPolicy`, потому что политика приезжает поверхности из bootstrap'а.
   */
  version: 1 | 2;
  /**
   * `used-faces` — ждать только те `@font-face`, которые реально применились к поверхности
   * (перечисление семейств через `getComputedStyle` выборки + `document.fonts`);
   * `document-ready` — деградация до `document.fonts.ready` целиком;
   * `required-faces` (v2) — **требовать** faces манифеста темы, чьё семейство наблюдено на
   * поверхности: отсутствие face'а — `font_face_missing`, отказ загрузки — `font_load_failed`.
   */
  fonts: "used-faces" | "document-ready" | "required-faces";
  /**
   * `decoded` — картинка считается годной, если у неё есть растр;
   * `decoded-strict` (v2) — `complete ∧ naturalWidth>0 ∧ naturalHeight>0 ∧ decode() resolved`,
   * иначе `image_load_failed`.
   */
  images: "decoded" | "decoded-strict";
  network: ReadinessNetworkPolicy;
  /** Сколько подряд стабильных rAF-кадров после layout считать доказательством покоя. */
  frames: number;
  /** `disabled` — инъекция `*{animation:none!important;transition:none!important}`. */
  animations: "disabled" | "allowed";
  /** Потолок ожидания: превышение — не бросок, а честный `readiness.met === false`. */
  timeoutMs: number;
  /** Только v2: перемера геометрии после frames-settle (`layout_unstable`). */
  layout?: ReadinessLayoutPolicy;
}

/**
 * Дефолт — он же политика интерактивных путей (галерея, библиотека, draft-preview): их поведение
 * этой волной не меняется, readiness для них advisory. Acceptance-путь передаёт политику профиля.
 */
export const DEFAULT_READINESS_POLICY: ReadinessPolicy = Object.freeze({
  version: 1,
  fonts: "used-faces",
  images: "decoded",
  network: Object.freeze({ quietMs: 200, scope: "component-owned" }) as ReadinessNetworkPolicy,
  frames: 2,
  animations: "disabled",
  timeoutMs: 15_000,
}) as ReadinessPolicy;

/**
 * Строгая политика v2 (план renderer-contract-2 §5 R4, N10): её носит профиль приёмки
 * `pixel-strict-v1`. Отличия от v1 — ровно три и все они про **доказательство**, а не про
 * ожидание подольше: обязательные faces манифеста темы, строгий критерий декода картинок и
 * перемера layout после frames-settle. Интерактивные пути остаются на v1: строгость включается
 * политикой профиля, а не env-флагом.
 *
 * `timeoutMs`/`frames`/`network`/`animations` намеренно совпадают с v1: цена волны — не ожидание,
 * а честность вердикта.
 */
export const STRICT_READINESS_POLICY: ReadinessPolicy = Object.freeze({
  version: 2,
  fonts: "required-faces",
  images: "decoded-strict",
  network: Object.freeze({ quietMs: 200, scope: "component-owned" }) as ReadinessNetworkPolicy,
  frames: 2,
  animations: "disabled",
  timeoutMs: 15_000,
  layout: Object.freeze({ stabilize: true, attempts: 3 }) as ReadinessLayoutPolicy,
}) as ReadinessPolicy;

/** Канонизованная форма политики — единственный вход хэша (порядок ключей не значим). */
export function canonicalReadinessPolicy(policy: ReadinessPolicy): string {
  return canonicalStringify(policy);
}

/** SHA-256 hex через WebCrypto: доступен и в браузере капчур-поверхности, и в Bun. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * `readinessPolicyHash = sha256(canonicalStringify(policy))`. Сервер считает тот же хэш
 * синхронно (`server/acceptance/ids.ts`, `Bun.CryptoHasher`) — вход и алгоритм общие, поэтому
 * значения совпадают побайтово; расхождение поймал бы гейт `readiness` (он сверяет хэш из
 * результата с хэшем политики джобы).
 */
export function readinessPolicyHash(policy: ReadinessPolicy): Promise<string> {
  return sha256Hex(canonicalReadinessPolicy(policy));
}

/**
 * Валидация политики, приехавшей из bootstrap'а воркера. Поверхность не доверяет форме объекта:
 * невалидная политика — не повод рендерить «как-нибудь», а повод молча вернуться к дефолту
 * (несовпадение хэшей будет видно серверу).
 */
export function isReadinessPolicy(value: unknown): value is ReadinessPolicy {
  if (value === null || typeof value !== "object") return false;
  const policy = value as Partial<ReadinessPolicy>;
  const network = policy.network as Partial<ReadinessNetworkPolicy> | undefined;
  const common = network !== undefined && typeof network.quietMs === "number" && network.scope === "component-owned"
    && typeof policy.frames === "number" && Number.isFinite(policy.frames) && policy.frames >= 0
    && (policy.animations === "disabled" || policy.animations === "allowed")
    && typeof policy.timeoutMs === "number" && policy.timeoutMs > 0;
  if (!common) return false;
  // Версия выбирает допустимые значения условий целиком: «v1 со строгими шрифтами» — не политика,
  // а испорченный bootstrap, и поверхность обязана вернуться к дефолту, а не гадать.
  if (policy.version === 1) {
    return (policy.fonts === "used-faces" || policy.fonts === "document-ready")
      && policy.images === "decoded" && policy.layout === undefined;
  }
  if (policy.version === 2) {
    const layout = policy.layout as Partial<ReadinessLayoutPolicy> | undefined;
    return (policy.fonts === "required-faces" || policy.fonts === "used-faces" || policy.fonts === "document-ready")
      && (policy.images === "decoded-strict" || policy.images === "decoded")
      && layout !== undefined && typeof layout.stabilize === "boolean"
      && typeof layout.attempts === "number" && Number.isInteger(layout.attempts) && layout.attempts >= 1;
  }
  return false;
}
