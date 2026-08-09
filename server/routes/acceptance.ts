/**
 * HTTP-поверхность candidate acceptance (план `docs/plans/2026-08-03-family-acceptance-and-composition-v3.md`
 * §5 W1a, RFC `docs/plans/2026-08-02-candidate-acceptance-pipeline-rfc.md` §4.1–4.2).
 *
 * ```
 * POST /api/components/:id/candidates        — validate head + идемпотентная durable-строка
 * POST /api/components/:id/impact            — dry-run импакта кандидата к baseline-рану (W6)
 * GET  /api/component-candidates/:candidateId
 * POST /api/component-candidates/:candidateId/reject — отклонение человеком (R3b, надгробие)
 * POST /api/acceptance-runs                  — постановка рана (202)
 * GET  /api/acceptance-runs/:runId           — статус + gates + progress + eta + failedCases
 *                                              (`?view=summary` — компактная сводка, W8)
 * GET  /api/acceptance-runs/:runId/cases     — per-case вердикты + имена артефактов (`?case=<id>`)
 * GET  /api/acceptance-runs/:runId/evidence  — zip (manifest + SHA256SUMS + артефакты CAS)
 * POST /api/acceptance-runs/:runId/cancel    — только из `queued` (триаж A6)
 * ```
 *
 * Границы, которые держит именно этот модуль:
 *
 * - **Гейт всего набора** — наличие оркестратора (`EASYUI_ACCEPTANCE_MATRIX=1`, резолвится один
 *   раз в `startServer`). Флаг выключен → ручек нет вовсе (404 `not_found`), как `promote` при
 *   `EASYUI_ACCEPTANCE_DISABLED` (`routes/components.ts`). Ветвление по env внутри роута
 *   запрещено тем же аргументом, что и в `capabilities`: два источника истины.
 * - **Авторизация** (план §5 W1a): `requireUser` + владелец компонента по денормализованному
 *   `component_id` (или админ — short-circuit внутри `requireResourceOwner`). `share`/`capture`-
 *   принципалы получают 403 всегда: они проходят анонимный барьер `createHandler` и иначе читали
 *   бы чужие раны (инвариант `catalogCandidates.ts`).
 * - **Артефакты CAS отдаются только внутри `runId`-scoped zip'а.** Ручки «по sha» нет by design:
 *   адрес артефакта не несёт владельца, и роут по нему был бы cross-owner-каналом.
 * - **Отказы не изобретаются здесь**: 422 `empty_case_set`/`case_set_too_large`/
 *   `unknown_policy_profile`, 409 `acceptance_run_in_flight`/`candidate_evicted`/`candidate_stale`
 *   поднимает доменный слой (`orchestrator`/`repo`/`validate`), роут отдаёт их как есть.
 */
import type { Database } from "bun:sqlite";
import { strToU8, zipSync, type Zippable } from "fflate";
import type { Principal } from "../auth";
import { requireResourceOwner, requireUser } from "../authorization";
import { sha256 } from "../components/pipeline";
import { validateComponentHead } from "../components/validate";
import { ApiError, json, noStore, readJson } from "../http";
import { maintenanceLockHeld } from "../maintenance";
import { writeAuditEvent } from "../audit";
import { ComponentRepo } from "../repos/components";
import { zipResponse } from "./bundles";
import { acceptanceResumeEnabled } from "../acceptance/orchestrator";
import { blockerFingerprintEnabled, blockerFingerprintOf, retryDispositionOf } from "../acceptance/disposition";
import type { AcceptanceOrchestrator, RefreshSpec } from "../acceptance/orchestrator";
import type { AcceptanceCaseRow, AcceptanceRunRow, CandidateDecisionRow, CandidateRow } from "../acceptance/repo";
import { isCandidateId, isRunId } from "../acceptance/ids";
import { computeImpact } from "../acceptance/impact";
import { isCaseSetId } from "../../src/acceptance/caseSetSchema";
import {
  ACCEPTANCE_POLICIES, DEFAULT_ACCEPTANCE_POLICY_ID, PROMOTABLE_RUN_STATUSES, acceptanceMaxCasesPerRun, acceptancePolicy,
  evidenceMaxBytes, isPromotionPolicyProfile, policyProfileHash,
} from "../acceptance/policies";
import { isTerminalRunStatus } from "../acceptance/repo";
import { readArtifact, readRunManifest, sanitizeEvidenceName, sha256Sums, type RunManifest } from "../acceptance/evidence";
import {
  groupSuggestion, policyExceptionWarnings, suggestedPolicyEnabled,
  type PolicyExceptionWarning, type SuggestGate, type SuggestedPolicy,
} from "../acceptance/suggest";
import { runtimeDefaultsWarnings, type RuntimeDefaultsDisabledWarning } from "../components/runtimeDefaults";

/** Опции §19.1 фидбэка, отклонённые триажем (A2: `manifestAssetId` не поддерживается никогда). */
const UNSUPPORTED_TOP_LEVEL = ["concurrency", "manifestAssetId"] as const;

const KNOWN_RUN_FIELDS = new Set(["candidateId", "idempotencyKey", "policy", "cases", "refresh", "recapture", "caseSetId", "baselineRunId"]);

const KNOWN_IMPACT_FIELDS = new Set(["candidateId", "baselineRunId"]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJson = (raw: string | null): unknown => {
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return null; }
};

/**
 * `refresh` запроса → `RefreshSpec` оркестратора (план §5 W1b). Здесь только форма: принадлежность
 * `caseIds` набору случаев знает `startRun` (набор строится там же), он и отдаёт `422 unknown_case_id`.
 */
function parseRefresh(value: unknown): RefreshSpec {
  if (value === undefined) return "none";
  if (value === "none" || value === "failed" || value === "all") return value;
  if (isObject(value) && Array.isArray(value.caseIds)) {
    for (const key of Object.keys(value)) {
      if (key !== "caseIds") throw new ApiError(400, "invalid_request", `refresh has an unknown field: ${key}`);
    }
    const caseIds = value.caseIds;
    if (caseIds.length === 0) throw new ApiError(400, "invalid_request", "refresh.caseIds must not be empty");
    if (caseIds.length > acceptanceMaxCasesPerRun) {
      throw new ApiError(400, "invalid_request", `refresh.caseIds exceeds the per-run case limit of ${acceptanceMaxCasesPerRun}`);
    }
    if (!caseIds.every((item) => typeof item === "string" && item.length > 0)) {
      throw new ApiError(400, "invalid_request", "refresh.caseIds must be an array of case ids");
    }
    return { caseIds: caseIds as string[] };
  }
  throw new ApiError(400, "invalid_request", 'refresh must be "none", "failed", "all" or {caseIds: string[]}');
}

/**
 * Публичное представление кандидата: durable-идентичность без внутренних полей строки.
 *
 * `rejected` — **вычисляемый** статус (§3.2а): хранимый enum `status` не расширяется, решение
 * человека живёт отдельной append-only строкой `candidate_decisions`. Поэтому в DTO они и разведены:
 * `status` остаётся `validated|promoted`, а надгробие приезжает парой `rejected` + `decision`.
 *
 * **`runs[]` (план 2026-08-04 W3)** — все раны кандидата в порядке постановки с готовым
 * `promotionEligible` (терминальный `pass|pass_with_exceptions` под допущенным к публикации
 * профилем). Это источник автовыбора связки promote (W2b) и ответ на вопрос «каким раном
 * публиковать», который скалярный `acceptanceRunId` не отвечает: он — **последний поставленный**
 * ран кандидата (`attachRun`), а не принятый и не промоутабельный.
 */
function candidateView(row: CandidateRow, decision?: CandidateDecisionRow, runs: AcceptanceRunRow[] = []): Record<string, unknown> {
  return {
    candidateId: row.candidate_id,
    componentId: row.component_id,
    designSystem: row.design_system,
    rev: row.rev,
    sourceHash: row.source_hash,
    bundleHash: row.bundle_hash,
    hostAbiVersion: row.host_abi_version,
    themeVersion: row.theme_version,
    buildFingerprint: row.build_fingerprint,
    policyProfileHash: row.policy_profile_hash,
    catalogRevision: row.observed_catalog_revision,
    status: row.status,
    statusReason: row.status_reason,
    rejected: decision !== undefined,
    decision: decision === undefined
      ? null
      : { reason: decision.reason, actor: decision.actor, createdAt: decision.created_at },
    acceptanceRunId: row.acceptance_run_id,
    runs: runs.map((run) => ({
      runId: run.run_id,
      status: run.status,
      policyProfileId: run.policy_profile_id,
      caseSetId: run.case_set_id,
      finishedAt: run.finished_at,
      promotionEligible: isTerminalRunStatus(run.status)
        && PROMOTABLE_RUN_STATUSES.has(run.status)
        && isPromotionPolicyProfile(run.policy_profile_id),
    })),
    promotedVersion: row.promoted_version,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

interface GateEntry {
  gate: string; status: string; detail?: string; metrics?: Record<string, unknown>;
  causes?: unknown[]; suggestedPolicy?: Record<string, unknown>;
}

const gatesOf = (row: AcceptanceCaseRow): GateEntry[] => {
  const parsed = parseJson(row.gates_json);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(isObject)
    .map((gate) => ({
      gate: String(gate.gate ?? ""),
      status: String(gate.status ?? ""),
      ...(typeof gate.detail === "string" ? { detail: gate.detail } : {}),
      ...(isObject(gate.metrics) ? { metrics: gate.metrics } : {}),
      // W5b: классифицированные причины расхождения — диагностика поверх статуса гейта.
      ...(Array.isArray(gate.causes) ? { causes: gate.causes } : {}),
      // W7: предложение минимальной правки бюджета — тот же слой, report-only.
      ...(isObject(gate.suggestedPolicy) && suggestedPolicyEnabled() ? { suggestedPolicy: gate.suggestedPolicy } : {}),
    })) as GateEntry[];
};

/** Причины случая (W5b): их несёт визуальный гейт; на уровень случая они поднимаются для читателя. */
const causesOf = (row: AcceptanceCaseRow): unknown[] =>
  gatesOf(row).find((gate) => gate.gate === "visual")?.causes ?? [];

/**
 * Предложение случая (W7): как и причины, его несёт визуальный гейт, а читателю оно нужно на
 * уровне случая. `null` — предложения нет (структурная причина, недоказанный остаток, факт выше
 * потолка); это **не** «случай в порядке».
 */
const suggestedPolicyOf = (row: AcceptanceCaseRow): Record<string, unknown> | null =>
  // Kill-switch гасит и **эхо** уже сохранённых предложений: иначе выключенная фича продолжала бы
  // отвечать полями из строк, записанных до выключения.
  (suggestedPolicyEnabled() ? gatesOf(row).find((gate) => gate.gate === "visual")?.suggestedPolicy : undefined) ?? null;

/** Гейты случая в форме, которую читает `suggest.ts` (метрики + причины, без артефактов). */
const suggestGatesOf = (row: { gates_json: string | null }): SuggestGate[] => {
  const parsed = parseJson(row.gates_json);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isObject).map((gate) => ({
    gate: String(gate.gate ?? ""), status: String(gate.status ?? ""),
    ...(isObject(gate.metrics) ? { metrics: gate.metrics } : {}),
  }));
};

/**
 * Предупреждения рана (W7, AC §9.3): принятое исключение (`textAaBudget`/per-case бюджет)
 * пережило смену рендерера и подлежит перепроверке. Advisory: ни на вердикт, ни на promote не
 * влияет. Считается на чтении, а не на терминализации: сравнивать нужно с **историей**, которая
 * после терминализации продолжает пополняться.
 */
function runWarnings(run: AcceptanceRunRow, cases: AcceptanceCaseRow[], orchestrator: AcceptanceOrchestrator): PolicyExceptionWarning[] {
  if (!suggestedPolicyEnabled() || !isTerminalRunStatus(run.status)) return [];
  const history = orchestrator.repo.passedCaseHistory(run).map((row) => ({
    runId: row.run_id, createdAt: row.created_at, rendererFingerprint: row.renderer_fingerprint,
    policyProfileId: row.policy_profile_id, policyProfileHash: row.policy_profile_hash,
    caseId: row.case_id, gates: suggestGatesOf(row),
  }));
  return policyExceptionWarnings({
    run: {
      runId: run.run_id, rendererFingerprint: run.renderer_fingerprint,
      policyProfileId: run.policy_profile_id, policyProfileHash: run.policy_profile_hash,
    },
    cases: cases.map((row) => ({ caseId: row.case_id, verdict: row.verdict, gates: suggestGatesOf(row) })),
    history,
  });
}

/**
 * Предупреждения рана, посчитанные **вне** `runWarnings`, потому что требуют I/O (чтение записи
 * кандидата) и потому асинхронны. Сегодня их ровно одно — `runtime_defaults_disabled` (§W9).
 */
type RunExtraWarning = RuntimeDefaultsDisabledWarning;

/**
 * Предупреждения волны W9: kill-switch runtime-дефолтов поднят, а семья флаг объявляет ⇒ вердикты
 * этого рана относятся к рендеру, которого продукт не поставляет. При опущенном флаге (штатный
 * режим) не делается ни одного обращения к диску — см. `runtimeDefaultsWarnings`.
 */
const extraRunWarnings = (
  dataDir: string,
  run: AcceptanceRunRow,
  orchestrator: AcceptanceOrchestrator,
): Promise<RunExtraWarning[]> =>
  runtimeDefaultsWarnings(dataDir, run, orchestrator.repo.candidate(run.candidate_id)?.source_hash ?? null);

/**
 * Предложение на группу ремедиаций (W7): у группы, все участники которой предлагают правку одного
 * вида, — одна правка на всех. Считается на чтении из уже сохранённых предложений случаев: группы
 * персистятся терминализацией, предложения живут в гейтах, и склейка не добавляет ни того, ни
 * другого в хранилище.
 */
function groupsWithSuggestions(groups: unknown[], cases: AcceptanceCaseRow[]): Record<string, unknown>[] {
  const byCaseId = new Map(cases.map((row) => [row.case_id, suggestedPolicyOf(row)] as const));
  return groups.filter(isObject).map((group) => {
    const members = (Array.isArray(group.cases) ? group.cases.map(String) : [])
      .map((caseId) => byCaseId.get(caseId) ?? null)
      .filter((item): item is Record<string, unknown> => item !== null) as unknown as SuggestedPolicy[];
    const key = typeof group.key === "string" ? group.key : "";
    const suggestion = members.length === (Array.isArray(group.cases) ? group.cases.length : 0)
      ? groupSuggestion(key, members)
      : null;
    return { ...group, ...(suggestion === null ? {} : { suggestedPolicy: suggestion }) };
  });
}

const severityOf = (row: AcceptanceCaseRow): { rank: number; class: string; score: number } | null => {
  const parsed = parseJson(row.severity_json);
  return isObject(parsed) && typeof parsed.rank === "number"
    ? { rank: parsed.rank, class: String(parsed.class), score: Number(parsed.score) }
    : null;
};

/** Провалившийся случай — `fail`/`indeterminate` по обязательному гейту либо инфраструктурный `error` (D10). */
const isFailedCase = (row: AcceptanceCaseRow): boolean =>
  row.verdict === "fail" || row.verdict === "indeterminate" || row.status === "error";

/** Сортировка репорта (D10): сначала самые «структурные» провалы, внутри класса — по весу. */
function bySeverity(left: AcceptanceCaseRow, right: AcceptanceCaseRow): number {
  const l = severityOf(left), r = severityOf(right);
  const leftRank = l?.rank ?? Number.MAX_SAFE_INTEGER, rightRank = r?.rank ?? Number.MAX_SAFE_INTEGER;
  if (leftRank !== rightRank) return leftRank - rightRank;
  const leftScore = l?.score ?? 0, rightScore = r?.score ?? 0;
  if (leftScore !== rightScore) return rightScore - leftScore;
  return left.case_id < right.case_id ? -1 : left.case_id > right.case_id ? 1 : 0;
}

function runView(
  run: AcceptanceRunRow,
  cases: AcceptanceCaseRow[],
  orchestrator: AcceptanceOrchestrator,
  extraWarnings: RunExtraWarning[] = [],
): Record<string, unknown> {
  const stored = parseJson(run.progress_json);
  // `remediationGroups` хранятся внутри `progress_json` (там их пишет терминализация), но в ответе
  // это самостоятельный раздел отчёта: смешивать группы причин со счётчиками прогресса нельзя.
  const { remediationGroups, ...progress } = isObject(stored)
    ? stored as Record<string, unknown>
    : {} as Record<string, unknown>;
  const eta = isObject(progress.eta) ? progress.eta : null;
  const failed = cases.filter(isFailedCase).sort(bySeverity).map((row) => ({
    caseId: row.case_id,
    caseKey: row.case_key,
    status: row.status,
    verdict: row.verdict,
    severity: severityOf(row),
    causes: causesOf(row),
    // W7: предложение по случаю — рядом с причинами, из которых оно и выведено.
    suggestedPolicy: suggestedPolicyOf(row),
    failedGates: gatesOf(row).filter((gate) => gate.status === "fail" || gate.status === "indeterminate"),
  }));
  return {
    runId: run.run_id,
    candidateId: run.candidate_id,
    componentId: run.component_id,
    status: run.status,
    // Названная причина терминального статуса (D2): сегодня это `refresh_scope_empty` — форс был
    // задан, но ни один случай не переоценён. `null` у обычного исхода, а не пустая строка.
    // BR-06 добавил к словарю `interrupted` (ран убила стартовая уборка после рестарта),
    // `phase_timeout`, `renderer_unavailable`, `capture_budget_exhausted`, `queue_starvation`.
    statusReason: run.status_reason,
    // BR-06: происхождение и продолжаемость рана. Все три поля — аддитивные и опциональные по
    // контракту; `resumedFromRunId: null` у самостоятельного рана, `attempt: 1` у первой попытки.
    resumedFromRunId: run.resumed_from_run_id,
    attempt: run.attempt,
    // Отчёт об остановке: `{resumable, phase, lastCompletedPhase, elapsedMs, resumeFrom, jobIds}`
    // либо lineage продолжения (`resumedFrom`). `null` — ран остановки не описывал.
    resume: orchestrator.repo.runResume(run),
    // BR-10a: отпечаток блокера — `blk_<sha256>` канонизованного basis и сортированных терминальных
    // кодов. `null` — блокера нет (ран прошёл либо отменён); **ключа нет вовсе** при поднятом
    // `EASYUI_BLOCKER_FINGERPRINT_DISABLED=1`, потому что вместе с ним исчезает и ручка, по которой
    // отпечаток можно расшифровать. Считается на лету из сохранённых данных той же функцией, что
    // и в `retry-disposition`: два разных значения были бы хуже отсутствия отпечатка.
    ...(blockerFingerprintEnabled()
      ? { blockerFingerprint: blockerFingerprintOf(run, cases, orchestrator.repo.candidate(run.candidate_id)) }
      : {}),
    policy: { id: run.policy_profile_id, hash: run.policy_profile_hash },
    caseSetId: run.case_set_id,
    idempotencyKey: run.idempotency_key,
    progress,
    eta,
    gates: parseJson(run.gates_json) ?? {},
    // W6: план частичной пересъёмки, применённый к этому рану. `null` — импакт не считался
    // (ран поставлен без `baselineRunId`), а не «ничего не затронуто».
    impact: parseJson(run.impact_json),
    // Алгебра refresh (C1): `{requested, impact, effective}` со скоупами `frame`/`verdict`.
    // Тройка, а не одно поле: «что попросили» и «что применилось» расходятся законно (импакт
    // добавляет случаи), и различить их обязан читатель, а не догадка.
    refresh: parseJson(run.refresh_json),
    // Сортировка задана группировкой: сначала самые массовые группы (одна правка чинит больше всего
    // случаев). Пустой массив у ещё не терминализованного рана — не «причин нет», а «отчёт не собран».
    remediationGroups: Array.isArray(remediationGroups) ? groupsWithSuggestions(remediationGroups, cases) : [],
    // W7 (AC §9.3): advisory-предупреждения рана. Пустой массив — «нечего перепроверять».
    // W9: сюда же приходит `runtime_defaults_disabled` — предупреждение о поднятом аварийном
    // kill-switch'е, из-за которого приёмка флагнутой семьи недействительна (§1.6).
    warnings: [...runWarnings(run, cases, orchestrator), ...extraWarnings],
    evidenceManifestHash: run.evidence_manifest_hash,
    createdAt: run.created_at,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    failedCases: failed,
  };
}

// ------------------------------------------------------------------ summary-view (W8, P1-9)

/** Метрики визуального гейта случая — источник `raw`/`aa` сводки. */
function visualMetricsOf(row: AcceptanceCaseRow): { raw: number | null; aa: number | null } {
  const visual = gatesOf(row).find((gate) => gate.gate === "visual") as { metrics?: Record<string, unknown> } | undefined;
  const metrics = visual?.metrics;
  const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
  return isObject(metrics)
    ? { raw: number(metrics.rawDiffPct), aa: number(metrics.aaDiffPct) }
    : { raw: null, aa: null };
}

/** Обрезка причины: сводка обязана быть короткой, полный текст лежит в `view=full` и в evidence. */
const CAUSE_MAX_CHARS = 160;
const shorten = (value: string): string =>
  (value.length <= CAUSE_MAX_CHARS ? value : `${value.slice(0, CAUSE_MAX_CHARS - 1)}…`).replace(/\s+/g, " ").trim();

/**
 * Одна строка провала в сводке: `{caseId, gate, raw, aa, cause}` (форма §P1 фидбэка).
 *
 * `gate` — **главный** провал случая (первый из упавших в порядке гейтов), `cause` — самая
 * доказательная причина: классифицированный код визуального расхождения, если он есть, иначе
 * `detail` гейта. Оба поля усечены намеренно: `metrics`/`regions` каждого случая и были тем, что
 * раздувало ответ до 1800 строк.
 */
function summaryFailedCase(row: AcceptanceCaseRow): Record<string, unknown> {
  const failedGates = gatesOf(row).filter((gate) => gate.status === "fail" || gate.status === "indeterminate");
  const primary = failedGates[0] ?? null;
  const cause = causesOf(row).find(isObject) as { code?: unknown; detail?: unknown } | undefined;
  const { raw, aa } = visualMetricsOf(row);
  const text = cause !== undefined && typeof cause.code === "string"
    ? shorten(typeof cause.detail === "string" && cause.detail.length > 0 ? `${cause.code}: ${cause.detail}` : cause.code)
    : primary?.detail !== undefined
      ? shorten(primary.detail)
      : shorten(row.status === "error" ? "case errored before a verdict" : `verdict ${row.verdict ?? row.status}`);
  // W7: предложение в сводке — одной строкой («что предложено», не «почему»): полная форма с
  // evidence и expiry живёт в `view=full` и в `?case=<id>`.
  const suggestion = suggestedPolicyOf(row);
  const suggest = suggestion === null
    ? null
    : suggestion.kind === "textAaBudget"
      ? `textAaBudget=${String(suggestion.textAaBudget)}`
      : `maxRawDiffPct=${String(suggestion.maxRawDiffPct)}`;
  return {
    caseId: row.case_id,
    gate: primary?.gate ?? (row.status === "error" ? "error" : "-"),
    raw, aa,
    cause: text,
    ...(suggest === null ? {} : { suggest }),
  };
}

/** Сводка гейтов рана: `{gate: "pass:17 fail:8"}` — одна строка на гейт вместо вложенной карты. */
function summaryGates(run: AcceptanceRunRow): Record<string, string> {
  const parsed = parseJson(run.gates_json);
  if (!isObject(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [gate, counts] of Object.entries(parsed)) {
    out[gate] = isObject(counts)
      ? Object.entries(counts).map(([status, count]) => `${status}:${String(count)}`).join(" ")
      : String(counts);
  }
  return out;
}

/** План refresh одной строкой: `frame:all`, `verdict:failed`, `frame:3 case(s)`, `none`. */
function summaryRefreshPlan(plan: unknown): string {
  if (!isObject(plan)) return "none";
  const parts: string[] = [];
  for (const scope of ["frame", "verdict"] as const) {
    const target = plan[scope];
    if (!isObject(target)) continue;
    if (target.all === true) parts.push(`${scope}:all`);
    else if (target.failed === true) parts.push(`${scope}:failed`);
    if (Array.isArray(target.caseIds) && target.caseIds.length > 0) parts.push(`${scope}:${target.caseIds.length} case(s)`);
  }
  return parts.length === 0 ? "none" : parts.join(" ");
}

/**
 * Компактное представление рана (`?view=summary`, план 2026-08-04 §W8, фидбэк P1-9).
 *
 * Три решения формы, без которых сводка не решает свою задачу:
 *
 * 1. **Маркер `view:"summary"` в теле обязателен** (C23): сервер до этой волны молча игнорирует
 *    незнакомый query и отдаёт полный ран — клиент отличает одно от другого только по маркеру,
 *    а не по коду ответа.
 * 2. **`gates` и `remediationGroups` — карты «ключ → строка»**, а не вложенные объекты: сводка
 *    живёт под бюджетом «failed-ран на 25 случаев < 100 строк», и каждая вложенность стоит строк.
 *    Полные формы никуда не делись — они в `view=full` (default) и в evidence-манифесте.
 * 3. **Метрики случая не повторяются**: `raw`/`aa` — два числа визуального гейта, всё остальное
 *    (regions, bestOffset, thresholds) берётся точечно через `/cases?case=<id>`.
 */
/**
 * Отчёт об остановке одной строкой (BR-06) для компактной сводки: `phase_timeout@capture
 * last=validate resumable` — фаза, докуда ран дошёл, и продолжаем ли он. `null` — останавливаться
 * рану было не на чем (обычный терминальный исход).
 */
function resumeSummaryOf(run: AcceptanceRunRow, orchestrator: AcceptanceOrchestrator): string | null {
  const resume = orchestrator.repo.runResume(run);
  if (resume === null) return null;
  const phase = typeof resume.phase === "string" ? resume.phase : "-";
  const last = typeof resume.lastCompletedPhase === "string" ? resume.lastCompletedPhase : "-";
  return `${run.status_reason ?? "stopped"}@${phase} last=${last}${resume.resumable === true ? " resumable" : ""}`;
}

function runSummaryView(
  run: AcceptanceRunRow,
  cases: AcceptanceCaseRow[],
  orchestrator: AcceptanceOrchestrator,
  extraWarnings: RunExtraWarning[] = [],
): Record<string, unknown> {
  const stored = parseJson(run.progress_json);
  // `eta` в сводке не нужен (ран терминален чаще, чем нет), `remediationGroups` едут отдельным
  // разделом — как и в полном виде.
  const { remediationGroups, eta, ...progress } = isObject(stored)
    ? stored as Record<string, unknown>
    : {} as Record<string, unknown>;
  void eta;
  const refresh = parseJson(run.refresh_json);
  const groups: Record<string, string> = {};
  if (Array.isArray(remediationGroups)) {
    for (const group of remediationGroups) {
      if (!isObject(group) || typeof group.key !== "string") continue;
      const code = isObject(group.cause) ? String(group.cause.code) : "unclassified";
      const members = Array.isArray(group.cases) ? group.cases.map(String) : [];
      groups[group.key.slice(0, 12)] = shorten(`${code} ×${members.length}: ${members.join(", ")}`);
    }
  }
  return {
    // Маркер версии контракта, а не украшение (C23) — см. §1 доклада выше.
    view: "summary",
    runId: run.run_id,
    status: run.status,
    statusReason: run.status_reason,
    // BR-06: сводка называет попытку и точку продолжения одной строкой — «где ран встал» обязано
    // читаться и в компактном отчёте, ради которого она заводилась.
    ...(run.resumed_from_run_id === null && run.attempt <= 1
      ? {}
      : { lineage: `attempt ${run.attempt}${run.resumed_from_run_id ? ` after ${run.resumed_from_run_id}` : ""}` }),
    ...(resumeSummaryOf(run, orchestrator) === null ? {} : { resume: resumeSummaryOf(run, orchestrator)! }),
    // BR-10a: тот же отпечаток, что в полном виде — сводка и есть основной вид для агента, и
    // «тот же блокер, что вчера» обязано читаться из неё.
    ...(blockerFingerprintEnabled()
      ? { blockerFingerprint: blockerFingerprintOf(run, cases, orchestrator.repo.candidate(run.candidate_id)) }
      : {}),
    progress,
    gates: summaryGates(run),
    refresh: isObject(refresh)
      ? {
        requested: summaryRefreshPlan(refresh.requested),
        impact: summaryRefreshPlan(refresh.impact),
        effective: summaryRefreshPlan(refresh.effective),
      }
      : null,
    failedCases: cases.filter(isFailedCase).sort(bySeverity).map(summaryFailedCase),
    remediationGroups: groups,
    // W7: предупреждения — по строке на случай, как и всё остальное в сводке.
    warnings: [
      ...runWarnings(run, cases, orchestrator).map((item) => `${item.code}: ${item.caseId} (${item.exceptions.join(", ")})`),
      // W9: у kill-switch-предупреждения нет случая — оно про весь ран, поэтому строка иная.
      ...extraWarnings.map((item) => `${item.code}: ${item.componentId} (${item.candidateId})`),
    ],
    evidenceUrl: `/api/acceptance-runs/${run.run_id}/evidence`,
  };
}

/** Владелец компонента (или админ). Один вход для всех acceptance-роутов — контракт §5 W1a. */
const assertComponentOwner = (db: Database, componentId: string, principal: Principal) =>
  requireResourceOwner(db, "components", componentId, principal);

async function createCandidate(request: Request, db: Database, dataDir: string, id: string, principal: Principal, orchestrator: AcceptanceOrchestrator): Promise<Response> {
  if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Method not allowed");
  const actor = assertComponentOwner(db, id, principal);
  // Тело — `{}` по контракту; читается только чтобы отвергнуть чужие поля (промах агента не должен
  // молча игнорироваться), но пустое/отсутствующее тело допустимо.
  if (request.headers.get("content-length") !== null && request.headers.get("content-length") !== "0") {
    const body = await readJson(request);
    if (!isObject(body) || Object.keys(body).length > 0) {
      throw new ApiError(400, "invalid_request", "Candidate creation takes no fields; the body must be {}");
    }
  }
  // Validate head'а — тот же префлайт, что у `POST /validate`; он же материализует бандл кандидата
  // в candidate-кэше (его потом пинует `candidatePins`). Слот — **системный** (план §5 W1c):
  // приёмка конкурирует за общий cap `VALIDATE_GLOBAL_CONCURRENT`, но per-user слот владельца не
  // занимает, иначе его собственный интерактивный validate получал бы 429 на всё время приёмки.
  const receipt = await validateComponentHead(db, dataDir, id, actor.userId, { system: true });
  const head = new ComponentRepo(db).source(id);
  if (sha256(head.source) !== receipt.sourceHash) {
    // Голова уехала между префлайтом и чтением: кандидат обязан описывать один билд.
    throw new ApiError(409, "revision_conflict", "Component head changed while the candidate was being built", { currentRev: head.rev });
  }
  const policy = ACCEPTANCE_POLICIES[DEFAULT_ACCEPTANCE_POLICY_ID];
  const created = orchestrator.repo.createCandidate({
    componentId: id,
    designSystem: head.designSystem,
    rev: head.rev,
    sourceHash: receipt.sourceHash,
    bundleHash: receipt.bundleHash,
    hostAbiVersion: receipt.hostAbiVersion,
    themeVersion: receipt.themeVersion,
    observedCatalogRevision: receipt.catalogRevision,
    policyProfileHash: policyProfileHash(policy),
    createdBy: actor.userId,
  });
  // R3b (§3.2а, анти-воскрешение): повтор той же сборки возвращает **ту же** строку — включая
  // отклонённую. POST не пересоздаёт кандидата и не снимает решение человека.
  const decision = orchestrator.repo.decision(created.candidate.candidate_id);
  return json({ ...candidateView(created.candidate, decision, orchestrator.repo.runsForCandidate(created.candidate.candidate_id)), cached: created.cached, warnings: receipt.warnings }, 200, noStore);
}

function getCandidate(request: Request, db: Database, candidateId: string, principal: Principal, orchestrator: AcceptanceOrchestrator): Response {
  if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Method not allowed");
  requireUser(principal);
  // Форма id проверяется до lookup'а: иначе произвольная строка отличала бы «нет строки» от
  // «не тот формат» и давала бы оракул по чужим кандидатам.
  if (!isCandidateId(candidateId)) throw new ApiError(404, "not_found", "Candidate not found");
  const row = orchestrator.repo.requireCandidate(candidateId);
  assertComponentOwner(db, row.component_id, principal);
  return json(candidateView(row, orchestrator.repo.decision(candidateId), orchestrator.repo.runsForCandidate(candidateId)), 200, noStore);
}

/**
 * `POST /api/component-candidates/:candidateId/reject` (RFC §4.1, R3b) — отклонение человеком.
 *
 * Ручка ничего не мутирует в `component_candidates` и не трогает раны: это надгробие для UI и для
 * promote-предиката (§4.3.1). Следствие, фиксируемое явно: отклонённый кандидат с живым раном
 * продолжает занимать in-flight-слот до терминализации рана — reject **не** отменяет ран (для
 * этого есть `POST /acceptance-runs/:runId/cancel`).
 *
 * Отмены нет: выход из отклонения — новая ревизия компонента, а не `unreject`.
 */
async function rejectCandidate(request: Request, db: Database, candidateId: string, principal: Principal, orchestrator: AcceptanceOrchestrator): Promise<Response> {
  if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Method not allowed");
  requireUser(principal);
  if (!isCandidateId(candidateId)) throw new ApiError(404, "not_found", "Candidate not found");
  const row = orchestrator.repo.requireCandidate(candidateId);
  const actor = assertComponentOwner(db, row.component_id, principal);
  const body = await readJson(request);
  if (!isObject(body)) throw new ApiError(400, "invalid_request", "Request body must be an object");
  for (const key of Object.keys(body)) {
    if (key !== "reason") throw new ApiError(400, "invalid_request", `Unknown field: ${key}`);
  }
  const reason = body.reason;
  // Причина обязательна: надгробие без неё бесполезно и UI, и следующему автору.
  if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > 2000) {
    throw new ApiError(400, "invalid_request", "reason is required and must be a non-empty string of at most 2000 characters");
  }
  const rejected = orchestrator.repo.rejectCandidate({ candidateId, reason: reason.trim(), actor: actor.userId });
  writeAuditEvent(db, {
    actorId: actor.userId, action: "candidate.rejected", subjectType: "component", subjectId: row.component_id,
    detail: { candidateId, componentId: row.component_id, rev: row.rev, reason: rejected.decision.reason },
  });
  return json(candidateView(rejected.candidate, rejected.decision, orchestrator.repo.runsForCandidate(rejected.candidate.candidate_id)), 200, noStore);
}

async function startRun(request: Request, db: Database, principal: Principal, orchestrator: AcceptanceOrchestrator): Promise<Response> {
  if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Method not allowed");
  const actor = requireUser(principal);
  const body = await readJson(request);
  if (!isObject(body)) throw new ApiError(400, "invalid_request", "Request body must be an object");
  for (const key of UNSUPPORTED_TOP_LEVEL) {
    if (body[key] !== undefined) {
      throw new ApiError(422, "unsupported_option", `Option is not supported by this server: ${key}`);
    }
  }
  for (const key of Object.keys(body)) {
    if (!KNOWN_RUN_FIELDS.has(key)) throw new ApiError(400, "invalid_request", `Unknown field: ${key}`);
  }
  const candidateId = body.candidateId;
  if (typeof candidateId !== "string" || !isCandidateId(candidateId)) {
    throw new ApiError(400, "invalid_request", "candidateId is required and must be a candidate id");
  }
  // Case-set-путь (W2): набор случаев, поверхность и per-case политики приходят из манифеста.
  // Форма id проверяется **до** lookup'а кандидата (иначе битый id выглядел бы как «нет
  // кандидата»); принадлежность набора кандидату сверяет `startRun` (422 case_set_mismatch).
  const caseSetId = body.caseSetId;
  if (caseSetId !== undefined && (typeof caseSetId !== "string" || !isCaseSetId(caseSetId))) {
    throw new ApiError(400, "invalid_request", "caseSetId must be a case set id");
  }
  if (caseSetId !== undefined && body.cases !== undefined) {
    throw new ApiError(400, "invalid_request", "cases and caseSetId are mutually exclusive sources of the case set");
  }
  const candidate = orchestrator.repo.requireCandidate(candidateId);
  assertComponentOwner(db, candidate.component_id, principal);

  // §4.8: постановка рана не начинается под maintenance-lock'ом — миграция каталога переписала бы
  // каталог под уже снятыми кадрами. Обратная сторона (`acquireMaintenanceLock`) живёт в maintenance.ts.
  if (maintenanceLockHeld(db)) {
    throw new ApiError(503, "maintenance_in_progress", "Writes are temporarily paused for a catalog migration", { retryAfterSeconds: 5 });
  }

  const policyId = body.policy === undefined ? DEFAULT_ACCEPTANCE_POLICY_ID : body.policy;
  if (typeof policyId !== "string") throw new ApiError(400, "invalid_request", "policy must be a string");
  if (!acceptancePolicy(policyId)) throw new ApiError(422, "unknown_policy_profile", `Unknown acceptance policy profile: ${policyId}`);

  const idempotencyKey = body.idempotencyKey;
  if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || idempotencyKey.length === 0 || idempotencyKey.length > 200)) {
    throw new ApiError(400, "invalid_request", "idempotencyKey must be a non-empty string of at most 200 characters");
  }

  // `refresh` (W1b): `none|failed|all|{caseIds}`. Молча деградировать один режим в другой нельзя —
  // это меняет стоимость рана; неизвестный `caseId` отвергает `startRun` (422 unknown_case_id).
  const refresh = parseRefresh(body.refresh);
  // `recapture` (D5, CLI `--recapture`): поднимает verdict-скоуп `refresh:"failed"` до пересъёмки.
  // На `all`/`{caseIds}` не влияет — они и так frame-скоуп.
  if (body.recapture !== undefined && typeof body.recapture !== "boolean") {
    throw new ApiError(400, "invalid_request", "recapture must be a boolean");
  }
  const recapture = body.recapture === true;

  // `baselineRunId` (W6): режим частичной пересъёмки. Форма проверяется здесь, владение — ниже
  // (baseline обязан принадлежать тому же компоненту, иначе это канал чтения чужих вердиктов).
  const baselineRunId = body.baselineRunId;
  if (baselineRunId !== undefined && (typeof baselineRunId !== "string" || !isRunId(baselineRunId))) {
    throw new ApiError(400, "invalid_request", "baselineRunId must be an acceptance run id");
  }
  if (typeof baselineRunId === "string") {
    const baseline = orchestrator.repo.requireRun(baselineRunId);
    if (baseline.component_id !== candidate.component_id) {
      throw new ApiError(422, "baseline_run_mismatch",
        `Baseline run belongs to component ${baseline.component_id}, not the candidate's ${candidate.component_id}`);
    }
  }

  let cases: { key: string; props: Record<string, unknown> }[] | undefined;
  if (body.cases !== undefined) {
    if (isObject(body.cases) && body.cases.concurrency !== undefined) {
      throw new ApiError(422, "unsupported_option", "Option is not supported by this server: cases.concurrency");
    }
    if (!Array.isArray(body.cases)) throw new ApiError(400, "invalid_request", "cases must be an array of {key, props}");
    cases = body.cases.map((item, index) => {
      if (!isObject(item) || typeof item.key !== "string" || !isObject(item.props)) {
        throw new ApiError(400, "invalid_request", `cases[${index}] must be {key: string, props: object}`);
      }
      return { key: item.key, props: item.props };
    });
  }

  const started = await orchestrator.startRun({
    candidateId,
    createdBy: actor.userId,
    policyId,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(caseSetId === undefined ? {} : { caseSetId: caseSetId as string }),
    ...(cases === undefined ? {} : { cases }),
    ...(refresh === "none" ? {} : { refresh }),
    ...(recapture ? { recapture } : {}),
    ...(typeof baselineRunId === "string" ? { baselineRunId } : {}),
  });
  return json({
    runId: started.run.run_id,
    status: started.run.status,
    candidateId: started.run.candidate_id,
    componentId: started.run.component_id,
    policy: { id: started.run.policy_profile_id, hash: started.run.policy_profile_hash },
    progress: parseJson(started.run.progress_json) ?? {},
    cases: started.cases.length,
    cached: started.cached,
    // Отчёт импакта возвращается сразу на постановке (W6): агент видит стоимость рана до того,
    // как тот начал снимать, и может отказаться от него.
    ...(started.impact ? { impact: started.impact } : {}),
    // Алгебра refresh (C1) печатается тройкой уже на постановке: «что попросили / что потребовал
    // импакт / что применится» — до того, как ран потратил первую минуту.
    refresh: started.refresh,
  }, 202, { ...noStore, location: `/api/acceptance-runs/${started.run.run_id}` });
}

/**
 * `POST /api/components/:id/impact` — dry-run импакта (W6, D6): что изменилось между кандидатом и
 * кандидатом baseline-рана и какие случаи придётся снять заново. Ничего не пишет и ничего не
 * снимает; авторизация и гейт — те же, что у остальных acceptance-ручек.
 */
async function componentImpact(request: Request, db: Database, dataDir: string, id: string, principal: Principal, orchestrator: AcceptanceOrchestrator): Promise<Response> {
  if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Method not allowed");
  assertComponentOwner(db, id, principal);
  const body = await readJson(request);
  if (!isObject(body)) throw new ApiError(400, "invalid_request", "Request body must be an object");
  for (const key of Object.keys(body)) {
    if (!KNOWN_IMPACT_FIELDS.has(key)) throw new ApiError(400, "invalid_request", `Unknown field: ${key}`);
  }
  const candidateId = body.candidateId;
  if (typeof candidateId !== "string" || !isCandidateId(candidateId)) {
    throw new ApiError(400, "invalid_request", "candidateId is required and must be a candidate id");
  }
  const baselineRunId = body.baselineRunId;
  if (typeof baselineRunId !== "string" || !isRunId(baselineRunId)) {
    throw new ApiError(400, "invalid_request", "baselineRunId is required and must be an acceptance run id");
  }
  const candidate = orchestrator.repo.requireCandidate(candidateId);
  // Обе стороны обязаны принадлежать компоненту из пути: иначе владелец одного компонента читал бы
  // вердикты чужого через ручку своего.
  if (candidate.component_id !== id) throw new ApiError(404, "not_found", "Candidate not found");
  const baselineRun = orchestrator.repo.requireRun(baselineRunId);
  if (baselineRun.component_id !== id) {
    throw new ApiError(422, "baseline_run_mismatch", `Baseline run belongs to component ${baselineRun.component_id}, not ${id}`);
  }
  const impact = await computeImpact({ db, dataDir, repo: orchestrator.repo, candidate, baselineRun });
  return json(impact, 200, noStore);
}

/** Ран + проверка владения. Формат `runId` валидируется в `requireRun`-предшественнике (regex ниже). */
function requireOwnedRun(db: Database, runId: string, principal: Principal, orchestrator: AcceptanceOrchestrator): AcceptanceRunRow {
  requireUser(principal);
  const run = orchestrator.repo.requireRun(runId);
  assertComponentOwner(db, run.component_id, principal);
  return run;
}

/**
 * `POST /api/acceptance-runs/:runId/resume` (BR-06, план 2026-08-08 §6) — продолжение
 * остановленного рана.
 *
 * Врезка стоит рядом с `cancel` и по той же причине: обе ручки — про **жизненный цикл** рана, а
 * не про его содержимое. Отличие принципиальное и видно уже по ответу: `cancel` возвращает тот же
 * ран, `resume` — **новый** (202 + `Location`), потому что терминальный ран неизменяем.
 *
 * Тело — `{}`: набор, поверхность, профиль и кандидат берутся у предка. Разрешить их переопределять
 * значило бы разрешить «продолжить другой ран», а это постановка нового, а не продолжение.
 */
async function resumeRun(request: Request, db: Database, runId: string, principal: Principal, orchestrator: AcceptanceOrchestrator): Promise<Response> {
  if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Method not allowed");
  const run = requireOwnedRun(db, runId, principal, orchestrator);
  // Kill-switch — **до** любых проверок состояния: агент обязан получить один и тот же
  // типизированный отказ независимо от того, продолжаем ли мы вообще что-то способное.
  if (!acceptanceResumeEnabled()) {
    throw new ApiError(409, "acceptance_resume_disabled",
      "Resumable acceptance is disabled on this server (EASYUI_ACCEPTANCE_RESUME_DISABLED=1); queue a new run instead",
      { runId: run.run_id });
  }
  // Тело читается **по факту**, а не по `content-length`: прокси и клиенты его не всегда шлют, а
  // молча проигнорированное `{"policy": …}` выглядело бы как «сервер меня понял».
  const raw = (await request.text()).trim();
  if (raw.length > 0) {
    let body: unknown;
    try { body = JSON.parse(raw); }
    catch { throw new ApiError(400, "invalid_request", "Request body must be valid JSON"); }
    if (!isObject(body) || Object.keys(body).length > 0) {
      throw new ApiError(400, "invalid_request", "Resume takes no fields; the body must be {}");
    }
  }
  const actor = requireUser(principal);
  const started = await orchestrator.resumeRun(runId, { createdBy: actor.userId });
  const lineage = orchestrator.repo.runResume(started.run);
  return json({
    runId: started.run.run_id,
    status: started.run.status,
    candidateId: started.run.candidate_id,
    componentId: started.run.component_id,
    policy: { id: started.run.policy_profile_id, hash: started.run.policy_profile_hash },
    progress: parseJson(started.run.progress_json) ?? {},
    cases: started.cases.length,
    cached: started.cached,
    refresh: started.refresh,
    // Lineage — часть ответа, а не только строки: агент, получивший 202, обязан видеть, чей это
    // повтор и какой попыткой, не делая второго запроса.
    resumedFromRunId: started.run.resumed_from_run_id,
    attempt: started.run.attempt,
    resumedFrom: isObject(lineage?.resumedFrom) ? lineage.resumedFrom : null,
  }, 202, { ...noStore, location: `/api/acceptance-runs/${started.run.run_id}` });
}

/**
 * `GET /api/acceptance-runs/:runId/retry-disposition` (BR-10a, план 2026-08-08 §10) — read-only
 * ответ на вопрос «имеет ли смысл повторять этот ран и насколько глубоко».
 *
 * Врезка стоит рядом с `cases`/`evidence`, а не с `resume`, и это по существу: ручка **ничего не
 * создаёт и ничего не меняет** — ни рана, ни строки кэша, ни артефакта. Вся логика живёт в
 * `acceptance/disposition.ts`; здесь только форма запроса, авторизация и `no-store`.
 *
 * `candidateId`/`caseSetId` в query — необязательные **утверждения вызывающего** о ране, а не
 * фильтры: агент, который спрашивает disposition по ране, обычно держит в руках id кандидата и
 * набора, и молчаливое согласие сервера с ошибочной парой было бы худшим из ответов (он получил бы
 * disposition чужого рана). Расхождение — типизированный 409, битая форма — 400.
 */
function retryDisposition(request: Request, db: Database, runId: string, principal: Principal, orchestrator: AcceptanceOrchestrator): Response {
  if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Method not allowed");
  // Kill-switch — **до** авторизации и до чтения рана: выключенная фича обязана выглядеть как
  // отсутствующий роут, а не как «есть, но не отвечает» (канон `EASYUI_IMPACTED_SNAP_DISABLED`).
  if (!blockerFingerprintEnabled()) throw new ApiError(404, "not_found", "Blocker fingerprint is disabled");
  const run = requireOwnedRun(db, runId, principal, orchestrator);
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) {
    if (key !== "candidateId" && key !== "caseSetId") {
      throw new ApiError(400, "invalid_request", `Unknown query parameter: ${key}`);
    }
  }
  const candidateId = params.get("candidateId");
  if (candidateId !== null) {
    if (!isCandidateId(candidateId)) throw new ApiError(400, "invalid_request", "candidateId must be a candidate id");
    if (candidateId !== run.candidate_id) {
      throw new ApiError(409, "candidate_mismatch",
        `Run ${run.run_id} was queued for candidate ${run.candidate_id}, not ${candidateId}`);
    }
  }
  const caseSetId = params.get("caseSetId");
  if (caseSetId !== null) {
    if (!isCaseSetId(caseSetId)) throw new ApiError(400, "invalid_request", "caseSetId must be a case set id");
    if (caseSetId !== run.case_set_id) {
      throw new ApiError(409, "case_set_mismatch",
        `Run ${run.run_id} was queued for case set ${run.case_set_id ?? "none"}, not ${caseSetId}`);
    }
  }
  return json(retryDispositionOf({
    db, repo: orchestrator.repo, run, cases: orchestrator.repo.cases(run.run_id),
  }), 200, noStore);
}

function caseView(row: AcceptanceCaseRow, manifest: RunManifest | null): Record<string, unknown> {
  const entry = manifest?.cases.find((item) => item.caseId === row.case_id);
  return {
    caseId: row.case_id,
    caseKey: row.case_key,
    status: row.status,
    verdict: row.verdict,
    severity: severityOf(row),
    propsHash: row.props_hash,
    caseFingerprint: row.case_fingerprint,
    aliasOfCaseId: row.alias_of_case_id,
    reuseReason: row.reuse_reason,
    reused: row.reuse_reason === "case_fingerprint",
    // BR-06: причина инфраструктурного падения случая (`{outcome, message, attempts, elapsedMs,
    // phase}`). `null` — случай инфраструктурно не падал; до волны это поле не существовало
    // вовсе, и «почему кейс не дал кадра» не отвечалось нигде.
    error: parseJson(row.error_json),
    // Квитанция reuse по уровням (P2-10): `{reuse:{candidate,frame,readiness,geometry,
    // visualMetrics,verdict}, fingerprints:{frame,comparison,verdictPolicy,case}}`. `reuseReason`
    // остаётся производной сводкой одной строкой; квитанция отвечает уровень за уровнем — иначе
    // «reused=25» не отличимо от «вердикт пересчитан» при смене порога. `null` — строка рана
    // старше v29 (квитанции тогда не писались), а не «ничего не переиспользовано».
    reuseReceipt: parseJson(row.reuse_receipt_json),
    referenceAssetId: row.reference_asset_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    gates: gatesOf(row),
    causes: causesOf(row),
    // W7: предложение минимальной правки бюджета; `null` — предложения нет (см. `suggest.ts`).
    suggestedPolicy: suggestedPolicyOf(row),
    captureQuality: parseJson(row.capture_quality_json),
    // Имена и адреса — да, байты — нет: содержимое CAS уезжает только в `runId`-scoped zip.
    artifacts: (entry?.artifacts ?? []).map((artifact) => ({ name: artifact.name, sha256: artifact.sha256, bytes: artifact.bytes })),
  };
}

/**
 * Evidence-архив: `manifest.json` + `SHA256SUMS` + артефакты под `<caseId>/<name>`.
 *
 * Манифест пишется при терминализации рана — до неё отдавать нечего (`409 evidence_not_ready`).
 * Потолок `evidenceMaxBytes` считается по записанным в манифесте размерам, **до** чтения байтов:
 * канон `BundleClosure.buildZip` (413 до материализации архива).
 */
async function runEvidence(request: Request, db: Database, dataDir: string, runId: string, principal: Principal, orchestrator: AcceptanceOrchestrator): Promise<Response> {
  if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Method not allowed");
  const run = requireOwnedRun(db, runId, principal, orchestrator);
  const manifest = await readRunManifest(dataDir, runId);
  if (!manifest) {
    throw new ApiError(409, "evidence_not_ready", `Acceptance run is ${run.status}; evidence is written when the run terminalizes`);
  }
  const total = manifest.cases.reduce((sum, item) => sum + item.artifacts.reduce((inner, artifact) => inner + artifact.bytes, 0), 0);
  if (total > evidenceMaxBytes) {
    throw new ApiError(413, "evidence_too_large", `Evidence exceeds ${evidenceMaxBytes} bytes of raw content`);
  }
  // BR-10a: отпечаток блокера едет в манифест архива — доказательство провала без ответа «тот же
  // это блокер или новый» заставляет читателя сравнивать вердикты глазами. Поле **вычисляется на
  // чтении** и потому объявлено вне `RunManifest`: персистированный манифест (и его
  // `evidence_manifest_hash`, на который ссылается promote) остаётся байт-в-байт прежним, а
  // kill-switch убирает поле из архива так же, как из представления рана.
  const fingerprint = blockerFingerprintEnabled()
    ? blockerFingerprintOf(run, orchestrator.repo.cases(runId), orchestrator.repo.candidate(run.candidate_id))
    : null;
  const document: Record<string, unknown> = fingerprint === null
    ? manifest as unknown as Record<string, unknown>
    : { ...manifest, blockerFingerprint: fingerprint };
  const files: Zippable = {
    "manifest.json": strToU8(`${JSON.stringify(document, null, 2)}\n`),
    SHA256SUMS: strToU8(sha256Sums(manifest)),
  };
  for (const item of manifest.cases) {
    const caseId = sanitizeEvidenceName(item.caseId);
    for (const artifact of item.artifacts) {
      const bytes = await readArtifact(dataDir, artifact.sha256);
      // Вычищенный GC артефакт не отменяет архив: манифест и SHA256SUMS остаются полными,
      // и внешняя проверка `sha256sum -c` покажет ровно то, чего не хватает.
      if (bytes) files[`${caseId}/${sanitizeEvidenceName(artifact.name)}`] = [bytes, { level: 0 }];
    }
  }
  return zipResponse(zipSync(files, { mtime: new Date("2020-01-01T00:00:00Z") }), `easy-ui-acceptance-${runId}.zip`);
}

/**
 * Диспетчер acceptance-роутов. `segments` — путь после `/api`. Возвращает `null` для чужих путей.
 * `orchestrator === undefined` означает выключенный `EASYUI_ACCEPTANCE_MATRIX`: ручек нет (404).
 */
export async function routeAcceptance(
  request: Request,
  db: Database,
  segments: string[],
  principal: Principal,
  dataDir: string,
  orchestrator?: AcceptanceOrchestrator,
): Promise<Response | null> {
  const isCandidateCreate = segments[0] === "components" && segments[2] === "candidates" && segments.length === 3;
  const isImpact = segments[0] === "components" && segments[2] === "impact" && segments.length === 3;
  const isCandidateRead = segments[0] === "component-candidates";
  const isRun = segments[0] === "acceptance-runs";
  if (!isCandidateCreate && !isImpact && !isCandidateRead && !isRun) return null;
  if (!orchestrator) throw new ApiError(404, "not_found", "Acceptance matrix is disabled");

  if (isCandidateCreate) return createCandidate(request, db, dataDir, segments[1]!, principal, orchestrator);
  if (isImpact) return componentImpact(request, db, dataDir, segments[1]!, principal, orchestrator);
  if (isCandidateRead) {
    if (segments.length === 3 && segments[2] === "reject") {
      return rejectCandidate(request, db, segments[1]!, principal, orchestrator);
    }
    if (segments.length !== 2) throw new ApiError(404, "not_found", "API route not found");
    return getCandidate(request, db, segments[1]!, principal, orchestrator);
  }
  if (segments.length === 1) return startRun(request, db, principal, orchestrator);
  const runId = segments[1]!;
  if (segments.length === 2) {
    if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    // `view` (W8): `full` — исторический ответ по умолчанию, `summary` — компактная сводка.
    // Неизвестное значение отвергается, а не деградирует в default: молчаливый полный ответ на
    // опечатку и есть тот случай, ради которого сводка заводилась.
    const view = new URL(request.url).searchParams.get("view") ?? "full";
    if (view !== "full" && view !== "summary") {
      throw new ApiError(400, "invalid_request", 'view must be "full" or "summary"');
    }
    const run = requireOwnedRun(db, runId, principal, orchestrator);
    const cases = orchestrator.repo.cases(runId);
    const extra = await extraRunWarnings(dataDir, run, orchestrator);
    return json(view === "summary"
      ? runSummaryView(run, cases, orchestrator, extra)
      : runView(run, cases, orchestrator, extra), 200, noStore);
  }
  if (segments.length === 3 && segments[2] === "cases") {
    if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    requireOwnedRun(db, runId, principal, orchestrator);
    const manifest = await readRunManifest(dataDir, runId);
    // `?case=<id>` (W8) — drill-down одного случая после сводки. Неизвестный id — 404, а не
    // пустой список: «случая нет в наборе» и «случай ещё не исполнен» — разные ответы, и молча
    // отдать пустоту на опечатку значило бы соврать про покрытие рана.
    const only = new URL(request.url).searchParams.get("case");
    const rows = [...orchestrator.repo.cases(runId)].sort(bySeverity);
    if (only !== null && !rows.some((row) => row.case_id === only)) {
      throw new ApiError(404, "not_found", `Acceptance run ${runId} has no case ${only}`);
    }
    const cases = rows.filter((row) => only === null || row.case_id === only).map((row) => caseView(row, manifest));
    return json({ runId, cases }, 200, noStore);
  }
  if (segments.length === 3 && segments[2] === "evidence") {
    return runEvidence(request, db, dataDir, runId, principal, orchestrator);
  }
  if (segments.length === 3 && segments[2] === "cancel") {
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    requireOwnedRun(db, runId, principal, orchestrator);
    const cancelled = orchestrator.cancelQueuedRun(runId);
    return json(runView(cancelled, orchestrator.repo.cases(runId), orchestrator,
      await extraRunWarnings(dataDir, cancelled, orchestrator)), 200, noStore);
  }
  if (segments.length === 3 && segments[2] === "resume") {
    return resumeRun(request, db, runId, principal, orchestrator);
  }
  if (segments.length === 3 && segments[2] === "retry-disposition") {
    return retryDisposition(request, db, runId, principal, orchestrator);
  }
  throw new ApiError(404, "not_found", "API route not found");
}
