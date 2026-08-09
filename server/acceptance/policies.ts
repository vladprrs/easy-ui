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
import { type ReadinessPolicy } from "../../src/capture/readinessPolicy";
import { barrierAwareReadinessPolicy } from "../capture/resourceBarrier";
import { rendererPolicyProfilesEnabled } from "./rendererProfiles";

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

/** Пороги визуального гейта (W5a). Per-case `maxRawDiffPct` манифеста перекрывает профильный. */
export interface VisualTolerances {
  /** Потолок `rawDiffPct` (pixelmatch, строгий порог, AA считается), % пикселей холста. */
  maxRawDiffPct: number;
  /**
   * Допуск расхождения габаритов после crop эталона, px. Больше — картинки несводимы, и гейт
   * отдаёт `indeterminate` с диагностикой, а не выдуманный процент (триаж R1-M4).
   */
  maxDimensionDeltaPx: number;
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
  /** Пороги гейта `visual` (W5a). */
  visual: VisualTolerances;
  /**
   * Профиль требует визуальный вердикт (W5a): гейт `visual` обязателен в свёртке, а случай без
   * эталона получает `indeterminate` («набор бессмысленен без эталона»), а не `skipped` — D10
   * допускает `skipped` только для необязательных гейтов. Тот же смысл включает `requireVisual`
   * case-set-манифеста для конкретного рана (см. `effectivePolicy` в оркестраторе).
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
    // W5a: визуальный гейт считается всегда (эталон есть — значит, есть и вердикт), но роняет ран
    // только там, где визуальная приёмка объявлена: профиль `pixel-strict-v1` или `requireVisual`
    // case-set-манифеста. В `default-v1` он advisory — набор без эталонов не обязан быть
    // пиксельно точным, а метрики всё равно попадают в evidence.
    visual: "advisory",
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
  visual: { maxRawDiffPct: 2.0, maxDimensionDeltaPx: 8 },
  requireVisual: false,
  // W2 (план 2026-08-07 §1.5): **точка включения барьера ресурсов** — здесь, а не в
  // `resolveCaptureMode`: acceptance-режим несёт лишь дефолт, реальную политику рана выдаёт
  // профиль. `default-v1`: v1 → v3 (kill-switch возвращает v1), `pixel-strict-v1`: v2 → v3
  // (kill-switch возвращает v2). Профили расходятся только тем, куда откатываются.
  readiness: barrierAwareReadinessPolicy("acceptance-default"),
};

/**
 * Второй профиль — реальный, а не витринный: pixel-perfect-приёмка Figma-семейств. Отличается
 * нулевыми геометрическими допусками, большей выборкой determinism и обязательным визуальным
 * гейтом (W5a): случай с эталоном обязан сойтись по пикселям, случай без эталона в таком наборе —
 * `indeterminate`, потому что пиксельная приёмка без эталона невозможна.
 */
const PIXEL_STRICT_V1: AcceptancePolicy = {
  ...DEFAULT_V1,
  id: "pixel-strict-v1",
  gates: { ...DEFAULT_V1.gates, visual: "required" },
  determinismSampleSize: 5,
  geometry: { overflowPx: 0, sizeDeltaPx: 0, offsetPx: 0 },
  // Полпроцента холста: pixel-perfect-приёмка Figma-семейств терпит субпиксельное сглаживание
  // рендерера, но не сдвиг элемента и не другой цвет.
  visual: { maxRawDiffPct: 0.5, maxDimensionDeltaPx: 4 },
  requireVisual: true,
  // R4 (план renderer-contract-2 §5): пиксельная приёмка судит только доказанно готовый кадр —
  // обязательные faces манифеста темы, строгий декод картинок, устоявшийся layout. W2 добавляет
  // к этому барьер ресурсов (v3); при включённом kill-switch профиль откатывается **в свою**
  // доволновую политику v2, а не в общую с `default-v1`.
  readiness: barrierAwareReadinessPolicy("acceptance-strict"),
};

/**
 * **Третий профиль — с исключениями** (EUI-BR-07, план 2026-08-08 §7, ревью M8).
 *
 * До волны `pass_with_exceptions` был недостижим: `exceptions[]` не писал никто, а `allowExceptions`
 * выключен в обоих профилях. Волна заводит первого продюсера исключений (профили политики
 * рендерера, `rendererProfiles.ts`) — и вместе с ним обязана завести профиль, под которым такой
 * ран что-то значит. Трогать существующие профили нельзя: их `policyProfileHash` — идентичность
 * политики, по которой сверяются уже полученные вердикты, и `allowExceptions: true` в `default-v1`
 * задним числом переопределил бы смысл всего накопленного корпуса.
 *
 * Дельта к `default-v1` ровно одна (`allowExceptions`) — намеренно: профиль отвечает на вопрос
 * «допускаются ли объяснённые исключения», а не «насколько строго мерить».
 */
const DEFAULT_V1_EXCEPTIONS: AcceptancePolicy = {
  ...DEFAULT_V1,
  id: "default-v1-exceptions",
  allowExceptions: true,
};

export const ACCEPTANCE_POLICIES = {
  "default-v1": DEFAULT_V1,
  "pixel-strict-v1": PIXEL_STRICT_V1,
  "default-v1-exceptions": DEFAULT_V1_EXCEPTIONS,
} as const satisfies Record<string, AcceptancePolicy>;

export type AcceptancePolicyId = keyof typeof ACCEPTANCE_POLICIES;

export const DEFAULT_ACCEPTANCE_POLICY_ID: AcceptancePolicyId = "default-v1";

/**
 * **Promotion policy** (план 2026-08-04, D-A/P0-2) — профили, под которыми полученный вердикт
 * допускает публикацию. Это отдельное понятие от «профиля, под которым ран можно поставить»:
 * идентичность кандидата политику не включает (RFC-инвариант), поэтому promote спрашивает не
 * «совпал ли хэш профиля с кандидатским» (эмерджентный отказ P0-2: кандидат всегда штампуется
 * `default-v1`, и любой `pixel-strict-v1`-ран падал `acceptance_run_mismatch`), а «принадлежит ли
 * профиль рана множеству допущенных к публикации».
 *
 * Сегодня предикат тавтологичен — реестр содержит ровно эти два профиля, и `startRun` отвергает
 * чужие (`422 unknown_policy_profile`). Он оставлен осознанно (триаж C3): это AC фидбэка и задел
 * под per-DS конфигурацию, а ветка отказа проверяется тестом через инъекцию профиля мимо роута.
 */
export const PROMOTION_POLICY_PROFILES: readonly AcceptancePolicyId[] =
  ["default-v1", "pixel-strict-v1", "default-v1-exceptions"];

/**
 * Профиль рана допускает публикацию под ним (см. `PROMOTION_POLICY_PROFILES`).
 *
 * BR-07: `default-v1-exceptions` промоутабелен **только при включённых профилях политики
 * рендерера**. Тумблер `EASYUI_RENDERER_POLICY_PROFILES_DISABLED=1` — своя ось именно потому, что
 * он меняет promote-eligibility: под ним исключений никто не производит, и профиль, чей
 * единственный смысл — их допускать, обязан перестать допускать публикацию, а не молча
 * превращаться во второй `default-v1`.
 */
export const isPromotionPolicyProfile = (id: string): boolean => {
  if (!(PROMOTION_POLICY_PROFILES as readonly string[]).includes(id)) return false;
  return id !== "default-v1-exceptions" || rendererPolicyProfilesEnabled();
};

/**
 * **Субъектная промоутабельность** (EUI-BR-08, план §8): предикат, который читает promote-гейт,
 * когда набор объявил `comparison.ownership: "subject-and-integration"`.
 *
 * Врезка в сагу promote этой волной **не делается** (зона пересекается с BR-01) — здесь живёт
 * готовый предикат и его тесты, чтобы врезка была одной строкой и не переизобретала правило.
 *
 * Правило: субъект промоутабелен, когда его собственный вердикт чист **и** ни один гейт вне
 * визуального не провален. Провальный интеграционный вердикт при этом сохраняется в квитанции и
 * не «прощается»: он остаётся вердиктом случая (`foldRunVerdict` не меняется вовсе).
 */
export interface SubjectPromotionInput {
  /** Случаи рана: вердикт случая + субъектный вердикт визуального гейта, если он посчитан. */
  cases: readonly {
    verdict: string | null;
    subjectFailed?: boolean | null;
    /** Провалы **не**визуальных гейтов случая: их субъектный вердикт не прощает никогда. */
    nonVisualFailed?: boolean;
  }[];
  /** Объявил ли набор владение (без объявления предикат не применим вовсе). */
  ownershipDeclared: boolean;
}

export function subjectPromotionEligible(input: SubjectPromotionInput): boolean {
  if (!input.ownershipDeclared) return false;
  if (input.cases.length === 0) return false;
  for (const item of input.cases) {
    if (item.nonVisualFailed === true) return false;
    // Субъектный вердикт не посчитан (кейс без карты элементов, re-diff без свежих фактов) —
    // «не измерено» не бывает «в допуске»: тогда решает обычный вердикт случая.
    if (item.subjectFailed === undefined || item.subjectFailed === null) {
      if (item.verdict !== "pass" && item.verdict !== "skipped") return false;
      continue;
    }
    if (item.subjectFailed) return false;
  }
  return true;
}

/**
 * Терминальные вердикты, с которыми ран допускает публикацию (RFC §4.3: `pass_with_exceptions` —
 * только через `allowExceptions` политики, решение принято при свёртке рана). Живёт здесь, а не в
 * саге promote: тот же предикат считает `promotionEligible` в candidate-view.
 */
export const PROMOTABLE_RUN_STATUSES: ReadonlySet<string> = new Set(["pass", "pass_with_exceptions"]);

export const isAcceptancePolicyId = (value: string): value is AcceptancePolicyId =>
  Object.prototype.hasOwnProperty.call(ACCEPTANCE_POLICIES, value);

export function acceptancePolicy(id: string): AcceptancePolicy | undefined {
  return isAcceptancePolicyId(id) ? ACCEPTANCE_POLICIES[id] : undefined;
}

/** sha256 канонизованного профиля целиком: переименование поля меняет хэш и инвалидирует вердикты. */
export function policyProfileHash(profile: AcceptancePolicy): string {
  return new Bun.CryptoHasher("sha256").update(canonicalStringify(profile)).digest("hex");
}

/**
 * Профиль с обязательным визуальным гейтом (W5a): `requireVisual: true` case-set-манифеста
 * поднимает `visual` до `required` **для этого рана**, не меняя реестр профилей.
 *
 * `policyProfileHash` рана остаётся хэшем базового профиля: он — идентичность политики, которую
 * сверяет promote, а «набор потребовал визуал» восстанавливается из `case_set_id` рана и входит в
 * `case_policy_hash` каждого случая (см. `casePolicyHashOf`), поэтому reuse инвалидируется честно.
 */
export function withRequiredVisual(profile: AcceptancePolicy): AcceptancePolicy {
  if (profile.gates.visual === "required" && profile.requireVisual) return profile;
  return { ...profile, requireVisual: true, gates: { ...profile.gates, visual: "required" } };
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
