/**
 * Идентичность candidate acceptance: build fingerprint, candidate id, case fingerprint, run id.
 *
 * Источники: RFC `docs/plans/2026-08-02-candidate-acceptance-pipeline-rfc.md` §5 (+амендмент D1)
 * и план `docs/plans/2026-08-03-family-acceptance-and-composition-v3.md` §3 D1.
 *
 * Два инварианта, которые здесь нельзя нарушать:
 *
 * 1. **Всё component-scoped.** `candidate_id` содержит `componentId`+`designSystem`+`rev`, а
 *    `case_fingerprint` — `candidateId`. Один `source_hash` законно принадлежит нескольким
 *    компонентам (`server/components/candidates.ts`, `componentIds` — множество), поэтому ключ
 *    без `componentId` коллидировал бы между компонентами и давал cross-owner disclosure через
 *    reuse (триаж E1/B1).
 * 2. **Политика вне сборочного отпечатка.** `policyProfileHash` в `build_fingerprint` не входит
 *    (триаж V12: политика — вход вердикта, не сборки); он живёт на ране. `catalogRevision` вне
 *    идентичности по той же причине — это глобальный хэш каталога.
 *
 * Канонизация — общая `canonicalStringify` (та же, что для propsHash/bundleHash), поэтому порядок
 * ключей во входном объекте на хэш не влияет.
 */
import { canonicalStringify } from "../../src/capture/canonicalJson";
import { canonicalReadinessPolicy, DEFAULT_READINESS_POLICY, type ReadinessPolicy } from "../../src/capture/readinessPolicy";
import { rendererFingerprint } from "../capture/renderer";

const sha256 = (value: string): string => new Bun.CryptoHasher("sha256").update(value).digest("hex");

const hashOf = (payload: unknown): string => sha256(canonicalStringify(payload));

/**
 * Версия схемы `case_fingerprint`. Каждая волна, меняющая смысл входов (W2 — case-set-политики,
 * W3 — geometry 2.0, W4 — readiness/env, W5a — визуальный гейт), **обязана** её поднять: это
 * единственный механизм автоматической инвалидации накопленного reuse. Признанная плата за
 * поэтапность (план §3 D1).
 *
 * **Версия 5 — последняя запланированная (W5a).** С неё отпечатки стабильны, и reuse-KPI §1
 * замеряется на сценарии W6 уже без принудительной инвалидации.
 *
 * Пакет renderer-contract-2 (§2.2 N5) объявляет **ровно один** bump — в R1, где меняется схема
 * входа: `captureEnvFingerprint` → `rendererFingerprint`. К моменту исполнения R1 значение уже
 * было 5 (его подняла W5a family-плана, план же исходил из 4), поэтому номер не двигается:
 * инвалидация накопленного reuse всё равно происходит — сам вход поменял и имя ключа, и
 * значение (chromium/шрифты/флаги теперь внутри). Инвариант «bump'ов в пакете больше нет»
 * закреплён тестом `server/capture/renderer.test.ts`.
 */
export const CASE_FINGERPRINT_ALGO_VERSION = 5;

/**
 * Хэш readiness-политики (W4) — тот же алгоритм, что у клиента
 * (`src/capture/readinessPolicy.ts#readinessPolicyHash`): sha256 канонизованной политики. Здесь
 * он синхронный (Bun), там — через WebCrypto; вход общий, поэтому значения совпадают, и гейт
 * `readiness` сверяет опубликованный поверхностью хэш именно с этим.
 */
export function readinessPolicyHashOf(policy: ReadinessPolicy): string {
  return sha256(canonicalReadinessPolicy(policy));
}

export const DEFAULT_READINESS_POLICY_HASH = readinessPolicyHashOf(DEFAULT_READINESS_POLICY);

/**
 * Отпечаток рендерера (план 2026-08-03 renderer-contract-2 §3 E1, §5 R1).
 *
 * Снятый `captureEnvFingerprintOf` был `sha256({platform, arch, readinessPolicyHash})` — то есть
 * **не менялся от апгрейда chromium**, и reuse `acceptance_case_results` переживал смену
 * рендерера (дыра §1.3 того плана). Теперь на его месте `rendererFingerprint`: объявленный,
 * серверный, до-капчурный отпечаток фактически запускаемого бинаря, шрифтового стека образа,
 * детерминизм-флагов запуска и той же readiness-политики (`server/capture/renderer.ts`).
 *
 * Наблюдённая проба окружения (`src/capture/env.ts#observedCaptureEnvFingerprint`) осталась
 * наблюдением: она снимается **в странице**, приезжает в evidence и метрики гейта `readiness`,
 * но ключом reuse быть не может — `case_fingerprint` считается до съёмки.
 */
export const DEFAULT_RENDERER_FINGERPRINT = rendererFingerprint(DEFAULT_READINESS_POLICY_HASH);
/**
 * Заглушка per-case политики для examples-пути: у именованного example манифеста нет, а значит
 * нет ни профиля, ни допусков. Case-set-путь (W2) подставляет вместо неё `casePolicyHashOf`
 * (`caseSets.ts`), поэтому смена допуска одного случая инвалидирует reuse ровно его.
 */
export const CASE_POLICY_HASH_V0 = "case-policy-v0";

export interface BuildFingerprintInput {
  sourceHash: string;
  bundleHash: string;
  hostAbiVersion: number;
  /** `= designSystemMetaVersion` (факт receipt); `null` для ДС без темы. */
  themeVersion: number | null;
}

export function buildFingerprint(input: BuildFingerprintInput): string {
  return hashOf({
    sourceHash: input.sourceHash,
    bundleHash: input.bundleHash,
    hostAbiVersion: input.hostAbiVersion,
    themeVersion: input.themeVersion,
  });
}

export interface CandidateIdInput {
  componentId: string;
  designSystem: string;
  rev: number;
  buildFingerprint: string;
}

export function candidateId(input: CandidateIdInput): string {
  return `cand_${hashOf({
    componentId: input.componentId,
    designSystem: input.designSystem,
    rev: input.rev,
    buildFingerprint: input.buildFingerprint,
  })}`;
}

export const CANDIDATE_ID_PATTERN = /^cand_[0-9a-f]{64}$/;
export const isCandidateId = (value: string): boolean => CANDIDATE_ID_PATTERN.test(value);

export interface CaseSurface {
  viewport: { width: number; height: number };
  dsf: number;
  theme: string;
}

export interface CaseFingerprintInput {
  algoVersion: number;
  candidateId: string;
  caseKey: string;
  propsHash: string;
  surface: CaseSurface;
  readinessPolicyHash: string;
  rendererFingerprint: string;
  casePolicyHash: string;
  referenceAssetId: string | null;
}

export function caseFingerprint(input: CaseFingerprintInput): string {
  return hashOf({
    algoVersion: input.algoVersion,
    candidateId: input.candidateId,
    caseKey: input.caseKey,
    propsHash: input.propsHash,
    surface: input.surface,
    readinessPolicyHash: input.readinessPolicyHash,
    rendererFingerprint: input.rendererFingerprint,
    casePolicyHash: input.casePolicyHash,
    referenceAssetId: input.referenceAssetId,
  });
}

/**
 * Значения readiness/env и заглушка case-политики подставляются здесь, а не у вызывающих: смысл
 * входов меняется ровно в одном месте вместе с bump'ом `CASE_FINGERPRINT_ALGO_VERSION`.
 */
export function caseFingerprintV0(input: {
  candidateId: string;
  caseKey: string;
  propsHash: string;
  surface: CaseSurface;
  referenceAssetId?: string | null;
  /** Case-set-путь (W2) передаёт реальный хэш политики случая; examples-путь — заглушку. */
  casePolicyHash?: string;
  /** Политика readiness случая (W4); по умолчанию — дефолтная политика профиля. */
  readinessPolicy?: ReadinessPolicy;
}): string {
  const readinessHash = input.readinessPolicy === undefined
    ? DEFAULT_READINESS_POLICY_HASH
    : readinessPolicyHashOf(input.readinessPolicy);
  return caseFingerprint({
    algoVersion: CASE_FINGERPRINT_ALGO_VERSION,
    candidateId: input.candidateId,
    caseKey: input.caseKey,
    propsHash: input.propsHash,
    surface: input.surface,
    readinessPolicyHash: readinessHash,
    rendererFingerprint: rendererFingerprint(readinessHash),
    casePolicyHash: input.casePolicyHash ?? CASE_POLICY_HASH_V0,
    referenceAssetId: input.referenceAssetId ?? null,
  });
}

/** `"acc_" + uuid` (RFC §3.3). Формат валидируется на чтении — из `runId` выводится путь evidence (D4). */
export const runId = (): string => `acc_${crypto.randomUUID()}`;

export const RUN_ID_PATTERN = /^acc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isRunId = (value: string): boolean => RUN_ID_PATTERN.test(value);
