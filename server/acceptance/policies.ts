/**
 * Реестр политик приёмки — **константы кода**, не таблица (RFC §3.4, амендмент A6).
 *
 * Таблица `policy_profiles` + CRUD сознательно не вводятся до появления профиля, который нужно
 * менять без деплоя. Профиль хешируется целиком (`policyProfileHash`), хэш пишется на кандидата и
 * на ран и сверяется на promote — так «вердикт получен по другой политике» ловится, даже если
 * профиль переименовали.
 *
 * `policyProfileHash` **не входит** в `build_fingerprint` (триаж V12: политика — вход вердикта,
 * а не сборки).
 */
import { canonicalStringify } from "../../src/capture/canonicalJson";
import { DEFAULT_READINESS_POLICY, type ReadinessPolicy } from "../../src/capture/readinessPolicy";

/**
 * Роль гейта в вердикте (свёртка D10):
 * - `required` — `fail`/`indeterminate` любого случая по этому гейту роняет ран;
 * - `advisory` — считается и показывается (`wouldBlock`), в вердикт не входит;
 * - `not-implemented` — гейт объявлен контрактом, но фазой не считается; в свёртке не участвует.
 */
export type GateMode = "required" | "advisory" | "not-implemented";

export type GateName =
  | "contract" | "defaults" | "render" | "determinism" | "audit"
  | "geometry" | "visual" | "readiness" | "regression" | "interactions";

export interface GeometryTolerances {
  /** Допуск переполнения контейнера, CSS px. */
  overflowPx: number;
  /** Допуск расхождения ожидаемых/фактических габаритов, CSS px. */
  sizeDeltaPx: number;
  /** Допуск на смещение бокса, CSS px. */
  offsetPx: number;
}

export interface AcceptancePolicy {
  id: string;
  /** Роль каждого гейта; ключи перечислены явно — новый гейт обязан появиться во всех профилях. */
  gates: Record<GateName, GateMode>;
  /** Потолок capture-джоб на один ран (ёмкость, план §4). */
  maxJobsPerRun: number;
  /** Дедлайн рана: `running` дольше него терминализуется watchdog'ом в `error` (D2). */
  runDeadlineMs: number;
  /** Размер выборки для гейта `determinism` (плюс все fail-случаи — план §4.2). */
  determinismSampleSize: number;
  /** Сколько раз ретраится случай, упавший по infra-классу `jobOutcome` (A3/D11). */
  maxInfraRetries: number;
  /** `pass_with_exceptions` возможен только при `true`; в фазе 1 выключено везде (RFC §2.1). */
  allowExceptions: boolean;
  geometry: GeometryTolerances;
  /**
   * Семантика будущего гейта `visual` (W5a): профиль требует reference из case-set и падает без
   * него. До W5a поле только описывает намерение — `gates.visual` остаётся `not-implemented`,
   * иначе профиль обещал бы проверку, которой в коде нет.
   */
  requireVisual: boolean;
  /**
   * Политика readiness капчура (W4, D5): её исполняет поверхность, её хэш входит в
   * `case_fingerprint`, и по её исходу гейт `readiness` решает, имеет ли кадр право на
   * визуальный вердикт. Профиль владеет ею целиком — «подождать подольше» перестаёт быть
   * решением клиента.
   */
  readiness: ReadinessPolicy;
}

const DEFAULT_V1: AcceptancePolicy = {
  id: "default-v1",
  gates: {
    contract: "required",
    defaults: "required",
    render: "required",
    determinism: "required",
    audit: "required",
    // W3: геометрия 2.0 (`probe:"paint"`, layout/paint/overflow) — боевой гейт. Advisory-фаза
    // закончилась вместе с v1-семантикой union-rect: вердикт теперь опирается на честный
    // `layoutBounds` и обязан называть виновника overflow, поэтому блокировать им можно.
    geometry: "required",
    visual: "not-implemented",
    // W4: readiness — обязательный гейт обоих профилей. Кадр, снятый до готовности шрифтов и
    // ассетов, не получает визуального вердикта (инвариант D5), а не «оценивается со скидкой».
    readiness: "required",
    regression: "not-implemented",
    interactions: "not-implemented",
  },
  maxJobsPerRun: 128,
  runDeadlineMs: 30 * 60 * 1000,
  determinismSampleSize: 3,
  maxInfraRetries: 2,
  allowExceptions: false,
  geometry: { overflowPx: 1, sizeDeltaPx: 2, offsetPx: 2 },
  requireVisual: false,
  readiness: DEFAULT_READINESS_POLICY,
};

/**
 * Второй профиль — реальный, а не витринный: pixel-perfect-приёмка Figma-семейств. Отличается
 * нулевыми геометрическими допусками, большей выборкой determinism и требованием визуального
 * гейта (вступит в силу вместе с W5a).
 */
const PIXEL_STRICT_V1: AcceptancePolicy = {
  ...DEFAULT_V1,
  id: "pixel-strict-v1",
  gates: { ...DEFAULT_V1.gates },
  determinismSampleSize: 5,
  geometry: { overflowPx: 0, sizeDeltaPx: 0, offsetPx: 0 },
  requireVisual: true,
};

export const ACCEPTANCE_POLICIES = {
  "default-v1": DEFAULT_V1,
  "pixel-strict-v1": PIXEL_STRICT_V1,
} as const satisfies Record<string, AcceptancePolicy>;

export type AcceptancePolicyId = keyof typeof ACCEPTANCE_POLICIES;

export const DEFAULT_ACCEPTANCE_POLICY_ID: AcceptancePolicyId = "default-v1";

export const isAcceptancePolicyId = (value: string): value is AcceptancePolicyId =>
  Object.prototype.hasOwnProperty.call(ACCEPTANCE_POLICIES, value);

export function acceptancePolicy(id: string): AcceptancePolicy | undefined {
  return isAcceptancePolicyId(id) ? ACCEPTANCE_POLICIES[id] : undefined;
}

/** sha256 канонизованного профиля целиком: переименование поля меняет хэш и инвалидирует вердикты. */
export function policyProfileHash(profile: AcceptancePolicy): string {
  return new Bun.CryptoHasher("sha256").update(canonicalStringify(profile)).digest("hex");
}

/** Обязательные гейты профиля — вход свёртки D10. */
export function requiredGates(profile: AcceptancePolicy): GateName[] {
  return (Object.keys(profile.gates) as GateName[]).filter(gate => profile.gates[gate] === "required").sort();
}

/** Потолок случаев на ран (план §4, мера 4). Проверяется на постановке, до дедупа алиасов. */
export const acceptanceMaxCasesPerRun = 64;

/** TTL строк `acceptance_case_results` (cross-run кэш): старше — кандидаты на GC в W1b. */
export const acceptanceCaseTtlHours = 24 * 14;

/** TTL живого кандидата: `expires_at` = created_at + это; свипер не трогает `promoted` (триаж V14). */
export const acceptanceCandidateTtlHours = 72;

/** Потолок байт evidence: ограничивает и CAS одного рана, и экспорт-zip (A4). */
export const evidenceMaxBytes = 256 * 1024 * 1024;
