/**
 * Доступ к durable-слою candidate acceptance (миграция v25).
 *
 * Источники: RFC `docs/plans/2026-08-02-candidate-acceptance-pipeline-rfc.md` §3.2–3.4 (амендменты
 * A1/A4/A9) и план `docs/plans/2026-08-03-family-acceptance-and-composition-v3.md` §3 (D1/D2/D10),
 * §5 W1a.
 *
 * Правила, которые репозиторий держит вместо вызывающих:
 *
 * - **Кандидат иммутабелен** кроме `status/status_reason/acceptance_run_id/promoted_version`;
 *   `candidate_id` считается здесь же из `ids.ts`, чтобы одна и та же сборка не получила два PK.
 * - **Ран иммутабелен, мутируются только случаи** (D2). Терминализация — одна короткая синхронная
 *   транзакция: bun:sqlite коммитит транзакцию на любом `await` внутри неё (см. комментарий в
 *   `server/repos/componentFingerprints.ts:16`), поэтому в теле `db.transaction(...)` тут нет и не
 *   должно появиться ни одного `await`.
 * - **≤1 нетерминальный ран на кандидата** — partial unique index `acceptance_runs_one_in_flight`.
 *   Предпроверка внутри той же транзакции даёт детерминированную доменную ошибку, а маппинг
 *   `SQLITE_CONSTRAINT_UNIQUE` остаётся race-safe подстраховкой (два процесса).
 * - **GC ничего не рвёт молча**: свипер кандидатов не трогает `promoted` (триаж V14), а раны,
 *   на которые ссылается `component_publishes` (плоские TEXT-колонки A9, без FK), защищены
 *   запросом — FK бы этого не сделал.
 *
 * Доменные ошибки поднимаются как `ApiError` с кодами, которые роуты (T4) отдают как есть.
 */
import type { Database } from "bun:sqlite";
import { ApiError } from "../http";
import { buildFingerprint, candidateId as computeCandidateId, runId as newRunId } from "./ids";
import { acceptanceCandidateTtlHours } from "./policies";

const now = (): string => new Date().toISOString();

export type CandidateStatus = "validated" | "promoted";
export type AcceptanceRunStatus =
  | "queued" | "running" | "pass" | "pass_with_exceptions" | "fail" | "error" | "cancelled";
export type AcceptanceCaseStatus = "pending" | "running" | "done" | "error" | "skipped";
export type AcceptanceCaseVerdict = "pass" | "fail" | "indeterminate" | "skipped";

/** Нетерминальные статусы — ровно те, что перечислены в partial unique index миграции v25. */
export const NON_TERMINAL_RUN_STATUSES = ["queued", "running"] as const satisfies readonly AcceptanceRunStatus[];
export const TERMINAL_RUN_STATUSES = ["pass", "pass_with_exceptions", "fail", "error", "cancelled"] as const;
export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];
export const isTerminalRunStatus = (status: string): status is TerminalRunStatus =>
  (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);

export interface CandidateRow {
  candidate_id: string;
  component_id: string;
  design_system: string;
  rev: number;
  source_hash: string;
  bundle_hash: string;
  host_abi_version: number;
  theme_version: number | null;
  build_fingerprint: string;
  observed_catalog_revision: string;
  policy_profile_hash: string;
  status: CandidateStatus;
  status_reason: string | null;
  acceptance_run_id: string | null;
  promoted_version: number | null;
  created_by: string;
  created_at: string;
  expires_at: string;
}

export interface AcceptanceRunRow {
  run_id: string;
  candidate_id: string;
  component_id: string;
  idempotency_key: string | null;
  status: AcceptanceRunStatus;
  policy_profile_hash: string;
  case_set_id: string | null;
  policy_profile_id: string;
  progress_json: string;
  impact_json: string | null;
  gates_json: string;
  evidence_manifest_hash: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_by: string;
  created_at: string;
}

export interface AcceptanceCaseRow {
  run_id: string;
  case_id: string;
  case_key: string;
  props_hash: string;
  case_fingerprint: string;
  case_policy_hash: string;
  reference_asset_id: string | null;
  expected_geometry_json: string | null;
  status: AcceptanceCaseStatus;
  verdict: AcceptanceCaseVerdict | null;
  gates_json: string | null;
  severity_json: string | null;
  capture_quality_json: string | null;
  alias_of_case_id: string | null;
  reuse_reason: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface AcceptanceCaseResultRow {
  case_fingerprint: string;
  component_id: string;
  artifacts_json: string;
  metrics_json: string;
  verdict: string;
  produced_run_id: string;
  created_at: string;
  last_used_at: string;
}

export interface CreateCandidateInput {
  componentId: string;
  designSystem: string;
  rev: number;
  sourceHash: string;
  bundleHash: string;
  hostAbiVersion: number;
  themeVersion: number | null;
  observedCatalogRevision: string;
  policyProfileHash: string;
  createdBy: string;
  /** По умолчанию — `acceptanceCandidateTtlHours` из реестра политик. */
  ttlHours?: number;
}

export interface CreateRunInput {
  candidateId: string;
  componentId: string;
  policyProfileId: string;
  policyProfileHash: string;
  idempotencyKey?: string | null;
  caseSetId?: string | null;
  createdBy: string;
  progress?: unknown;
  gates?: unknown;
  cases?: NewCaseInput[];
}

export interface NewCaseInput {
  caseId: string;
  caseKey: string;
  propsHash: string;
  caseFingerprint: string;
  casePolicyHash: string;
  referenceAssetId?: string | null;
  expectedGeometry?: unknown;
  aliasOfCaseId?: string | null;
}

export interface CasePatch {
  status?: AcceptanceCaseStatus;
  verdict?: AcceptanceCaseVerdict | null;
  gates?: unknown;
  severity?: unknown;
  captureQuality?: unknown;
  reuseReason?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface TerminalizeRunInput {
  status: TerminalRunStatus;
  gates?: unknown;
  progress?: unknown;
  impact?: unknown;
  evidenceManifestHash?: string | null;
  finishedAt?: string;
}

export interface PutCaseResultInput {
  caseFingerprint: string;
  componentId: string;
  artifacts: unknown;
  metrics: unknown;
  verdict: string;
  producedRunId: string;
}

const json = (value: unknown): string => JSON.stringify(value ?? null);
const jsonOrNull = (value: unknown): string | null => (value === undefined || value === null ? null : JSON.stringify(value));

/**
 * `SQLITE_CONSTRAINT_UNIQUE` от bun:sqlite несёт в сообщении список колонок нарушенного индекса
 * (`UNIQUE constraint failed: acceptance_runs.candidate_id`), а не его имя. Partial index стоит
 * ровно на одной колонке `candidate_id`, поэтому он отличим от `UNIQUE (candidate_id, idempotency_key)`
 * по отсутствию второй колонки в сообщении.
 */
function isInFlightConstraint(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== "string" || !code.startsWith("SQLITE_CONSTRAINT")) return false;
  const message = String((error as { message?: unknown }).message ?? "");
  return message.includes("acceptance_runs.candidate_id") && !message.includes("idempotency_key");
}

export class AcceptanceRepo {
  constructor(private db: Database) {}

  // ---------------------------------------------------------------- кандидаты

  /**
   * Идемпотентно по вычисленному `candidate_id`: та же сборка того же компонента даёт ту же строку
   * и `cached: true`. Повтор **не** перезаписывает строку — кандидат иммутабелен, а `status`
   * (например, уже `promoted`) обязан пережить повторный POST.
   */
  createCandidate(input: CreateCandidateInput): { candidate: CandidateRow; cached: boolean } {
    const fingerprint = buildFingerprint({
      sourceHash: input.sourceHash,
      bundleHash: input.bundleHash,
      hostAbiVersion: input.hostAbiVersion,
      themeVersion: input.themeVersion,
    });
    const id = computeCandidateId({
      componentId: input.componentId,
      designSystem: input.designSystem,
      rev: input.rev,
      buildFingerprint: fingerprint,
    });
    const createdAt = now();
    const ttlHours = input.ttlHours ?? acceptanceCandidateTtlHours;
    const expiresAt = new Date(Date.parse(createdAt) + ttlHours * 3600_000).toISOString();
    return this.db.transaction(() => {
      const existing = this.candidate(id);
      if (existing) return { candidate: existing, cached: true };
      this.db.query(`INSERT INTO component_candidates
        (candidate_id,component_id,design_system,rev,source_hash,bundle_hash,host_abi_version,theme_version,
         build_fingerprint,observed_catalog_revision,policy_profile_hash,status,status_reason,acceptance_run_id,
         promoted_version,created_by,created_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'validated',NULL,NULL,NULL,?,?,?)`)
        .run(id, input.componentId, input.designSystem, input.rev, input.sourceHash, input.bundleHash,
          input.hostAbiVersion, input.themeVersion, fingerprint, input.observedCatalogRevision,
          input.policyProfileHash, input.createdBy, createdAt, expiresAt);
      return { candidate: this.requireCandidate(id), cached: false };
    })();
  }

  candidate(id: string): CandidateRow | undefined {
    return (this.db.query("SELECT * FROM component_candidates WHERE candidate_id=?").get(id) as CandidateRow | null) ?? undefined;
  }

  requireCandidate(id: string): CandidateRow {
    const row = this.candidate(id);
    if (!row) throw new ApiError(404, "not_found", "Candidate not found");
    return row;
  }

  /** Последний созданный кандидат компонента — вход для «покажи текущего кандидата» и тестов. */
  latestCandidateFor(componentId: string): CandidateRow | undefined {
    return (this.db.query("SELECT * FROM component_candidates WHERE component_id=? ORDER BY created_at DESC, candidate_id DESC LIMIT 1")
      .get(componentId) as CandidateRow | null) ?? undefined;
  }

  /** Ссылка кандидата на последний ран (мутируемое поле; не идентичность). */
  attachRun(candidateId: string, runId: string): void {
    this.db.query("UPDATE component_candidates SET acceptance_run_id=? WHERE candidate_id=?").run(runId, candidateId);
  }

  /**
   * `validated → promoted`. Повтор с тем же номером версии идемпотентен (сага promote может
   * ретраиться), с другим — конфликт: одна версия на кандидата.
   */
  markPromoted(candidateId: string, version: number, runId?: string | null): CandidateRow {
    return this.db.transaction(() => {
      const row = this.requireCandidate(candidateId);
      if (row.status === "promoted") {
        if (row.promoted_version === version) return row;
        throw new ApiError(409, "candidate_already_promoted", "Candidate is already promoted to another version",
          { currentVersion: row.promoted_version ?? undefined });
      }
      this.db.query("UPDATE component_candidates SET status='promoted', promoted_version=?, acceptance_run_id=COALESCE(?,acceptance_run_id), status_reason=? WHERE candidate_id=?")
        .run(version, runId ?? null, `promoted v${version}`, candidateId);
      return this.requireCandidate(candidateId);
    })();
  }

  // --------------------------------------------------------------------- раны

  /**
   * Постановка рана. Идемпотентность — по `(candidate_id, idempotency_key)`; при живом ране того
   * же кандидата — доменный `acceptance_run_in_flight` (409). Случаи вставляются в той же
   * транзакции: ран без случаев не должен существовать даже мгновение.
   */
  createRun(input: CreateRunInput): { run: AcceptanceRunRow; cached: boolean } {
    const id = newRunId();
    const createdAt = now();
    const key = input.idempotencyKey ?? null;
    try {
      return this.db.transaction(() => {
        if (key !== null) {
          const existing = this.db.query("SELECT * FROM acceptance_runs WHERE candidate_id=? AND idempotency_key=?")
            .get(input.candidateId, key) as AcceptanceRunRow | null;
          if (existing) return { run: existing, cached: true };
        }
        const inFlight = this.inFlightRun(input.candidateId);
        if (inFlight) throw new ApiError(409, "acceptance_run_in_flight", "Candidate already has a non-terminal acceptance run",
          { runId: inFlight.run_id });
        this.db.query(`INSERT INTO acceptance_runs
          (run_id,candidate_id,component_id,idempotency_key,status,policy_profile_hash,case_set_id,policy_profile_id,
           progress_json,impact_json,gates_json,evidence_manifest_hash,started_at,finished_at,created_by,created_at)
          VALUES (?,?,?,?,'queued',?,?,?,?,NULL,?,NULL,NULL,NULL,?,?)`)
          .run(id, input.candidateId, input.componentId, key, input.policyProfileHash, input.caseSetId ?? null,
            input.policyProfileId, json(input.progress ?? {}), json(input.gates ?? {}), input.createdBy, createdAt);
        for (const item of input.cases ?? []) this.insertCase(id, item);
        this.attachRun(input.candidateId, id);
        return { run: this.requireRun(id), cached: false };
      })();
    } catch (error) {
      // Гонка двух процессов: предпроверка выше прошла у обоих, индекс отсеял второго.
      // Детали намеренно пустые: id живого рана в этой ветке не читался, а гадать нельзя.
      if (isInFlightConstraint(error)) {
        throw new ApiError(409, "acceptance_run_in_flight", "Candidate already has a non-terminal acceptance run");
      }
      throw error;
    }
  }

  run(id: string): AcceptanceRunRow | undefined {
    return (this.db.query("SELECT * FROM acceptance_runs WHERE run_id=?").get(id) as AcceptanceRunRow | null) ?? undefined;
  }

  requireRun(id: string): AcceptanceRunRow {
    const row = this.run(id);
    if (!row) throw new ApiError(404, "not_found", "Acceptance run not found");
    return row;
  }

  inFlightRun(candidateId: string): AcceptanceRunRow | undefined {
    return (this.db.query("SELECT * FROM acceptance_runs WHERE candidate_id=? AND status IN ('queued','running') LIMIT 1")
      .get(candidateId) as AcceptanceRunRow | null) ?? undefined;
  }

  runsForCandidate(candidateId: string): AcceptanceRunRow[] {
    return this.db.query("SELECT * FROM acceptance_runs WHERE candidate_id=? ORDER BY created_at, run_id").all(candidateId) as AcceptanceRunRow[];
  }

  /** `queued → running`. Возвращает `false`, если ран уже ушёл из очереди (гонка с cancel/watchdog). */
  startRun(id: string, at = now()): boolean {
    return this.db.query("UPDATE acceptance_runs SET status='running', started_at=? WHERE run_id=? AND status='queued'")
      .run(at, id).changes > 0;
  }

  /** Прогресс/ETA — единственное, что мутируется на живом ране помимо случаев. */
  updateRunProgress(id: string, progress: unknown): void {
    this.db.query("UPDATE acceptance_runs SET progress_json=? WHERE run_id=? AND status IN ('queued','running')")
      .run(json(progress), id);
  }

  /**
   * Терминализация — **одна короткая синхронная транзакция без `await` внутри** (D2, канон
   * bun:sqlite). Из терминального статуса переход не делается: повторный вызов возвращает
   * текущую строку, а не переписывает вердикт.
   */
  terminalizeRun(id: string, input: TerminalizeRunInput): AcceptanceRunRow {
    return this.db.transaction(() => {
      const row = this.requireRun(id);
      if (isTerminalRunStatus(row.status)) return row;
      this.db.query(`UPDATE acceptance_runs SET status=?, finished_at=?,
          gates_json=COALESCE(?,gates_json), progress_json=COALESCE(?,progress_json),
          impact_json=COALESCE(?,impact_json), evidence_manifest_hash=COALESCE(?,evidence_manifest_hash)
        WHERE run_id=? AND status IN ('queued','running')`)
        .run(input.status, input.finishedAt ?? now(), jsonOrNull(input.gates), jsonOrNull(input.progress),
          jsonOrNull(input.impact), input.evidenceManifestHash ?? null, id);
      return this.requireRun(id);
    })();
  }

  /**
   * Стартовая уборка (RFC §2.1, прецедент `failStagingPublishes`): переживший рестарт `queued|running`
   * ран некому двигать — он вечно держал бы кандидата partial-индексом. A3 делает потерю дешёвой:
   * повтор переиспользует результаты случаев по `case_fingerprint`.
   */
  sweepNonTerminalRuns(at = now()): number {
    return this.db.query("UPDATE acceptance_runs SET status='error', finished_at=? WHERE status IN ('queued','running')")
      .run(at).changes;
  }

  /**
   * Watchdog (D2): раны в `running` дольше дедлайна политики. Возвращает строки — решение
   * терминализовать принимает вызывающий (ему же писать evidence/аудит).
   */
  runningRunsOlderThan(deadlineMs: number, at = Date.now()): AcceptanceRunRow[] {
    const cutoff = new Date(at - deadlineMs).toISOString();
    return this.db.query("SELECT * FROM acceptance_runs WHERE status='running' AND COALESCE(started_at,created_at)<? ORDER BY started_at")
      .all(cutoff) as AcceptanceRunRow[];
  }

  // ------------------------------------------------------------------ случаи

  insertCase(runId: string, item: NewCaseInput): void {
    this.db.query(`INSERT INTO acceptance_cases
      (run_id,case_id,case_key,props_hash,case_fingerprint,case_policy_hash,reference_asset_id,expected_geometry_json,
       status,verdict,gates_json,severity_json,capture_quality_json,alias_of_case_id,reuse_reason,started_at,finished_at)
      VALUES (?,?,?,?,?,?,?,?,'pending',NULL,NULL,NULL,NULL,?,NULL,NULL,NULL)`)
      .run(runId, item.caseId, item.caseKey, item.propsHash, item.caseFingerprint, item.casePolicyHash,
        item.referenceAssetId ?? null, jsonOrNull(item.expectedGeometry), item.aliasOfCaseId ?? null);
  }

  cases(runId: string): AcceptanceCaseRow[] {
    return this.db.query("SELECT * FROM acceptance_cases WHERE run_id=? ORDER BY case_id").all(runId) as AcceptanceCaseRow[];
  }

  case(runId: string, caseId: string): AcceptanceCaseRow | undefined {
    return (this.db.query("SELECT * FROM acceptance_cases WHERE run_id=? AND case_id=?").get(runId, caseId) as AcceptanceCaseRow | null) ?? undefined;
  }

  /** Частичный апдейт: не переданные поля не трогаются (COALESCE по значению-заглушке `undefined`). */
  updateCase(runId: string, caseId: string, patch: CasePatch): AcceptanceCaseRow {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    const push = (column: string, value: string | number | null): void => { sets.push(`${column}=?`); values.push(value); };
    if (patch.status !== undefined) push("status", patch.status);
    if (patch.verdict !== undefined) push("verdict", patch.verdict);
    if (patch.gates !== undefined) push("gates_json", jsonOrNull(patch.gates));
    if (patch.severity !== undefined) push("severity_json", jsonOrNull(patch.severity));
    if (patch.captureQuality !== undefined) push("capture_quality_json", jsonOrNull(patch.captureQuality));
    if (patch.reuseReason !== undefined) push("reuse_reason", patch.reuseReason);
    if (patch.startedAt !== undefined) push("started_at", patch.startedAt);
    if (patch.finishedAt !== undefined) push("finished_at", patch.finishedAt);
    if (sets.length) {
      values.push(runId, caseId);
      this.db.query(`UPDATE acceptance_cases SET ${sets.join(",")} WHERE run_id=? AND case_id=?`).run(...values);
    }
    const row = this.case(runId, caseId);
    if (!row) throw new ApiError(404, "not_found", "Acceptance case not found");
    return row;
  }

  // ---------------------------------------------------- cross-run кэш случаев

  /**
   * Upsert результата случая. `component_id` денормализован намеренно: reuse обязан проверять
   * владение, а не только совпадение отпечатка.
   */
  putCaseResult(input: PutCaseResultInput, at = now()): void {
    this.db.query(`INSERT INTO acceptance_case_results
      (case_fingerprint,component_id,artifacts_json,metrics_json,verdict,produced_run_id,created_at,last_used_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT (case_fingerprint) DO UPDATE SET
        artifacts_json=excluded.artifacts_json, metrics_json=excluded.metrics_json,
        verdict=excluded.verdict, produced_run_id=excluded.produced_run_id, last_used_at=excluded.last_used_at`)
      .run(input.caseFingerprint, input.componentId, json(input.artifacts), json(input.metrics),
        input.verdict, input.producedRunId, at, at);
  }

  caseResult(caseFingerprint: string): AcceptanceCaseResultRow | undefined {
    return (this.db.query("SELECT * FROM acceptance_case_results WHERE case_fingerprint=?")
      .get(caseFingerprint) as AcceptanceCaseResultRow | null) ?? undefined;
  }

  /**
   * Кандидат на reuse: отпечаток совпал **и** результат принадлежит тому же компоненту. Второе
   * условие — защита от cross-owner reuse, если `algoVersion` когда-нибудь потеряет `candidateId`.
   */
  caseResultForComponent(caseFingerprint: string, componentId: string): AcceptanceCaseResultRow | undefined {
    const row = this.caseResult(caseFingerprint);
    return row && row.component_id === componentId ? row : undefined;
  }

  /** Удаление строки кэша — вместе с её артефактами это делает `gcEvidence` (A4). */
  deleteCaseResult(caseFingerprint: string): boolean {
    return this.db.query("DELETE FROM acceptance_case_results WHERE case_fingerprint=?").run(caseFingerprint).changes > 0;
  }

  allCaseResults(): AcceptanceCaseResultRow[] {
    return this.db.query("SELECT * FROM acceptance_case_results").all() as AcceptanceCaseResultRow[];
  }

  /** JSON-поля случаев, в которых живут ссылки на CAS — вход union-refcount'а GC. */
  allCaseGates(): { gates_json: string | null; capture_quality_json: string | null }[] {
    return this.db.query("SELECT gates_json,capture_quality_json FROM acceptance_cases")
      .all() as { gates_json: string | null; capture_quality_json: string | null }[];
  }

  /**
   * Кандидаты на вытеснение по потолку `evidenceMaxBytes`: результаты **терминальных fail/error**
   * ранов, давно не использованные. Доказательства прошедшей приёмки (`pass`) не вытесняются —
   * их пересъёмка не восстановит provenance.
   */
  evictableCaseResults(limit = 500): AcceptanceCaseResultRow[] {
    return this.db.query(`SELECT r.* FROM acceptance_case_results r
      JOIN acceptance_runs u ON u.run_id = r.produced_run_id
      WHERE u.status IN ('fail','error') ORDER BY r.last_used_at LIMIT ?`).all(limit) as AcceptanceCaseResultRow[];
  }

  /** Жив ли адрес артефакта хоть по одной ссылке (union `acceptance_case_results` ∪ `acceptance_cases`). */
  artifactStillReferenced(sha: string): boolean {
    const inResults = this.db.query("SELECT 1 FROM acceptance_case_results WHERE artifacts_json LIKE '%' || ? || '%' LIMIT 1").get(sha);
    if (inResults !== null) return true;
    return this.db.query("SELECT 1 FROM acceptance_cases WHERE COALESCE(gates_json,'') || COALESCE(capture_quality_json,'') LIKE '%' || ? || '%' LIMIT 1").get(sha) !== null;
  }

  /** Очередь оркестратора: раны, поставленные и ещё не начатые, в порядке постановки. */
  queuedRuns(limit = 20): AcceptanceRunRow[] {
    return this.db.query("SELECT * FROM acceptance_runs WHERE status='queued' ORDER BY created_at, run_id LIMIT ?").all(limit) as AcceptanceRunRow[];
  }

  /**
   * Провайдер пинов для `gcCandidates` (A10): `source_hash` кандидатов всех нетерминальных ранов.
   * Бандл такого кандидата вытеснять нельзя — пересборки по произвольному rev нет.
   */
  pinnedSourceHashes(): Set<string> {
    const rows = this.db.query(`SELECT DISTINCT c.source_hash hash FROM acceptance_runs r
      JOIN component_candidates c ON c.candidate_id = r.candidate_id
      WHERE r.status IN ('queued','running')`).all() as { hash: string }[];
    return new Set(rows.map((row) => row.hash));
  }

  touchCaseResult(caseFingerprint: string, at = now()): void {
    this.db.query("UPDATE acceptance_case_results SET last_used_at=? WHERE case_fingerprint=?").run(at, caseFingerprint);
  }

  /**
   * Union-refcount для GC артефактов (A4): отпечаток жив, если на него ссылается хотя бы одна
   * строка `acceptance_cases` (историческая или живая) либо строка кэша результатов.
   */
  caseFingerprintRefcount(caseFingerprint: string): { cases: number; results: number; total: number } {
    const cases = (this.db.query("SELECT COUNT(*) n FROM acceptance_cases WHERE case_fingerprint=?")
      .get(caseFingerprint) as { n: number }).n;
    const results = (this.db.query("SELECT COUNT(*) n FROM acceptance_case_results WHERE case_fingerprint=?")
      .get(caseFingerprint) as { n: number }).n;
    return { cases, results, total: cases + results };
  }

  /** Кандидаты на GC кэша: не использовались дольше TTL и на них не ссылается ни один случай. */
  unreferencedCaseResults(olderThanIso: string, limit = 500): AcceptanceCaseResultRow[] {
    return this.db.query(`SELECT r.* FROM acceptance_case_results r
      WHERE r.last_used_at < ?
        AND NOT EXISTS (SELECT 1 FROM acceptance_cases c WHERE c.case_fingerprint=r.case_fingerprint)
      ORDER BY r.last_used_at LIMIT ?`).all(olderThanIso, limit) as AcceptanceCaseResultRow[];
  }

  // ------------------------------------------------------------- защита и GC

  /**
   * Раны, на которые ссылается опубликованная версия. FK тут нет by design (A9), поэтому GC ранов
   * **обязан** спрашивать это сам — иначе TTL молча снесёт provenance активной версии.
   */
  runIdsReferencedByPublishes(): Set<string> {
    const rows = this.db.query("SELECT DISTINCT acceptance_run_id id FROM component_publishes WHERE acceptance_run_id IS NOT NULL")
      .all() as { id: string }[];
    return new Set(rows.map(row => row.id));
  }

  isRunReferencedByPublish(runId: string): boolean {
    return this.db.query("SELECT 1 FROM component_publishes WHERE acceptance_run_id=? LIMIT 1").get(runId) !== null;
  }

  candidateIdsReferencedByPublishes(): Set<string> {
    const rows = this.db.query("SELECT DISTINCT candidate_id id FROM component_publishes WHERE candidate_id IS NOT NULL")
      .all() as { id: string }[];
    return new Set(rows.map(row => row.id));
  }

  /**
   * Свипер кандидатов по `expires_at`.
   *
   * Пропускаются: `promoted` (триаж V14 — provenance версии), кандидаты с живым раном и кандидаты,
   * чьи раны или сами они упомянуты в `component_publishes`. Удаление идёт вместе с ранами
   * кандидата (случаи уходят каскадом v25) — иначе FK `acceptance_runs.candidate_id` не даст
   * удалить строку, и свипер вечно возвращал бы ошибку.
   */
  sweepExpiredCandidates(atIso = now(), limit = 200): { deleted: number; skipped: number } {
    const expired = this.db.query(`SELECT * FROM component_candidates
      WHERE expires_at < ? AND status <> 'promoted' ORDER BY expires_at LIMIT ?`).all(atIso, limit) as CandidateRow[];
    if (!expired.length) return { deleted: 0, skipped: 0 };
    const publishedRuns = this.runIdsReferencedByPublishes();
    const publishedCandidates = this.candidateIdsReferencedByPublishes();
    return this.db.transaction(() => {
      let deleted = 0, skipped = 0;
      for (const row of expired) {
        const runs = this.runsForCandidate(row.candidate_id);
        const blocked = publishedCandidates.has(row.candidate_id)
          || runs.some(run => publishedRuns.has(run.run_id) || !isTerminalRunStatus(run.status));
        if (blocked) { skipped += 1; continue; }
        for (const run of runs) this.db.query("DELETE FROM acceptance_runs WHERE run_id=?").run(run.run_id);
        this.db.query("DELETE FROM component_candidates WHERE candidate_id=?").run(row.candidate_id);
        deleted += 1;
      }
      return { deleted, skipped };
    })();
  }
}
