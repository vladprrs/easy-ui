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

const sha256 = (value: string): string => new Bun.CryptoHasher("sha256").update(value).digest("hex");

const hashOf = (payload: unknown): string => sha256(canonicalStringify(payload));

/**
 * Версия схемы `case_fingerprint`. Каждая волна, меняющая смысл входов (W2 — case-set-политики,
 * W3 — geometry 2.0, W4 — readiness/env, W5a — визуальный гейт), **обязана** её поднять: это
 * единственный механизм автоматической инвалидации накопленного reuse. Признанная плата за
 * поэтапность (план §3 D1).
 */
export const CASE_FINGERPRINT_ALGO_VERSION = 1;

/** Заглушка readiness-политики до W4 (`docs/plans/2026-08-03-…` §5 W4). */
export const READINESS_POLICY_HASH_V0 = "readiness-policy-v0";
/** Заглушка отпечатка окружения капчура до W4. */
export const CAPTURE_ENV_FINGERPRINT_V0 = "capture-env-v0";
/** Заглушка per-case политики до W2 (case-set-манифест). */
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
  captureEnvFingerprint: string;
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
    captureEnvFingerprint: input.captureEnvFingerprint,
    casePolicyHash: input.casePolicyHash,
    referenceAssetId: input.referenceAssetId,
  });
}

/**
 * Значения-заглушки фаз W2/W4 подставляются здесь, а не у вызывающих: когда волна их заменит,
 * правка будет ровно в одном месте вместе с bump'ом `CASE_FINGERPRINT_ALGO_VERSION`.
 */
export function caseFingerprintV0(input: {
  candidateId: string;
  caseKey: string;
  propsHash: string;
  surface: CaseSurface;
  referenceAssetId?: string | null;
}): string {
  return caseFingerprint({
    algoVersion: CASE_FINGERPRINT_ALGO_VERSION,
    candidateId: input.candidateId,
    caseKey: input.caseKey,
    propsHash: input.propsHash,
    surface: input.surface,
    readinessPolicyHash: READINESS_POLICY_HASH_V0,
    captureEnvFingerprint: CAPTURE_ENV_FINGERPRINT_V0,
    casePolicyHash: CASE_POLICY_HASH_V0,
    referenceAssetId: input.referenceAssetId ?? null,
  });
}

/** `"acc_" + uuid` (RFC §3.3). Формат валидируется на чтении — из `runId` выводится путь evidence (D4). */
export const runId = (): string => `acc_${crypto.randomUUID()}`;

export const RUN_ID_PATTERN = /^acc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isRunId = (value: string): boolean => RUN_ID_PATTERN.test(value);
