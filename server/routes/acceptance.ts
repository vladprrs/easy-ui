/**
 * HTTP-поверхность candidate acceptance (план `docs/plans/2026-08-03-family-acceptance-and-composition-v3.md`
 * §5 W1a, RFC `docs/plans/2026-08-02-candidate-acceptance-pipeline-rfc.md` §4.1–4.2).
 *
 * ```
 * POST /api/components/:id/candidates        — validate head + идемпотентная durable-строка
 * GET  /api/component-candidates/:candidateId
 * POST /api/acceptance-runs                  — постановка рана (202)
 * GET  /api/acceptance-runs/:runId           — статус + gates + progress + eta + failedCases
 * GET  /api/acceptance-runs/:runId/cases     — per-case вердикты + имена артефактов
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
import { ComponentRepo } from "../repos/components";
import { zipResponse } from "./bundles";
import type { AcceptanceOrchestrator, RefreshSpec } from "../acceptance/orchestrator";
import type { AcceptanceCaseRow, AcceptanceRunRow, CandidateRow } from "../acceptance/repo";
import { isCandidateId } from "../acceptance/ids";
import { isCaseSetId } from "../../src/acceptance/caseSetSchema";
import {
  ACCEPTANCE_POLICIES, DEFAULT_ACCEPTANCE_POLICY_ID, acceptanceMaxCasesPerRun, acceptancePolicy, evidenceMaxBytes, policyProfileHash,
} from "../acceptance/policies";
import { readArtifact, readRunManifest, sanitizeEvidenceName, sha256Sums, type RunManifest } from "../acceptance/evidence";

/** Опции §19.1 фидбэка, отклонённые триажем (A2: `manifestAssetId` не поддерживается никогда). */
const UNSUPPORTED_TOP_LEVEL = ["concurrency", "manifestAssetId"] as const;

const KNOWN_RUN_FIELDS = new Set(["candidateId", "idempotencyKey", "policy", "cases", "refresh", "caseSetId"]);

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

/** Публичное представление кандидата: durable-идентичность без внутренних полей строки. */
function candidateView(row: CandidateRow): Record<string, unknown> {
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
    acceptanceRunId: row.acceptance_run_id,
    promotedVersion: row.promoted_version,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

interface GateEntry { gate: string; status: string; detail?: string }

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
    })) as GateEntry[];
};

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

function runView(run: AcceptanceRunRow, cases: AcceptanceCaseRow[]): Record<string, unknown> {
  const progress = parseJson(run.progress_json);
  const eta = isObject(progress) && isObject(progress.eta) ? progress.eta : null;
  const failed = cases.filter(isFailedCase).sort(bySeverity).map((row) => ({
    caseId: row.case_id,
    caseKey: row.case_key,
    status: row.status,
    verdict: row.verdict,
    severity: severityOf(row),
    failedGates: gatesOf(row).filter((gate) => gate.status === "fail" || gate.status === "indeterminate"),
  }));
  return {
    runId: run.run_id,
    candidateId: run.candidate_id,
    componentId: run.component_id,
    status: run.status,
    policy: { id: run.policy_profile_id, hash: run.policy_profile_hash },
    caseSetId: run.case_set_id,
    idempotencyKey: run.idempotency_key,
    progress: isObject(progress) ? progress : {},
    eta,
    gates: parseJson(run.gates_json) ?? {},
    evidenceManifestHash: run.evidence_manifest_hash,
    createdAt: run.created_at,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    failedCases: failed,
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
  return json({ ...candidateView(created.candidate), cached: created.cached, warnings: receipt.warnings }, 200, noStore);
}

function getCandidate(request: Request, db: Database, candidateId: string, principal: Principal, orchestrator: AcceptanceOrchestrator): Response {
  if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Method not allowed");
  requireUser(principal);
  // Форма id проверяется до lookup'а: иначе произвольная строка отличала бы «нет строки» от
  // «не тот формат» и давала бы оракул по чужим кандидатам.
  if (!isCandidateId(candidateId)) throw new ApiError(404, "not_found", "Candidate not found");
  const row = orchestrator.repo.requireCandidate(candidateId);
  assertComponentOwner(db, row.component_id, principal);
  return json(candidateView(row), 200, noStore);
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
  }, 202, { ...noStore, location: `/api/acceptance-runs/${started.run.run_id}` });
}

/** Ран + проверка владения. Формат `runId` валидируется в `requireRun`-предшественнике (regex ниже). */
function requireOwnedRun(db: Database, runId: string, principal: Principal, orchestrator: AcceptanceOrchestrator): AcceptanceRunRow {
  requireUser(principal);
  const run = orchestrator.repo.requireRun(runId);
  assertComponentOwner(db, run.component_id, principal);
  return run;
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
    referenceAssetId: row.reference_asset_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    gates: gatesOf(row),
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
  const files: Zippable = {
    "manifest.json": strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
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
  const isCandidateRead = segments[0] === "component-candidates";
  const isRun = segments[0] === "acceptance-runs";
  if (!isCandidateCreate && !isCandidateRead && !isRun) return null;
  if (!orchestrator) throw new ApiError(404, "not_found", "Acceptance matrix is disabled");

  if (isCandidateCreate) return createCandidate(request, db, dataDir, segments[1]!, principal, orchestrator);
  if (isCandidateRead) {
    if (segments.length !== 2) throw new ApiError(404, "not_found", "API route not found");
    return getCandidate(request, db, segments[1]!, principal, orchestrator);
  }
  if (segments.length === 1) return startRun(request, db, principal, orchestrator);
  const runId = segments[1]!;
  if (segments.length === 2) {
    if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    const run = requireOwnedRun(db, runId, principal, orchestrator);
    return json(runView(run, orchestrator.repo.cases(runId)), 200, noStore);
  }
  if (segments.length === 3 && segments[2] === "cases") {
    if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    requireOwnedRun(db, runId, principal, orchestrator);
    const manifest = await readRunManifest(dataDir, runId);
    const cases = [...orchestrator.repo.cases(runId)].sort(bySeverity).map((row) => caseView(row, manifest));
    return json({ runId, cases }, 200, noStore);
  }
  if (segments.length === 3 && segments[2] === "evidence") {
    return runEvidence(request, db, dataDir, runId, principal, orchestrator);
  }
  if (segments.length === 3 && segments[2] === "cancel") {
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    requireOwnedRun(db, runId, principal, orchestrator);
    const cancelled = orchestrator.cancelQueuedRun(runId);
    return json(runView(cancelled, orchestrator.repo.cases(runId)), 200, noStore);
  }
  throw new ApiError(404, "not_found", "API route not found");
}
