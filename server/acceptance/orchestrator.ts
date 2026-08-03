/**
 * Оркестратор приёмки (RFC §4.2 «Оркестрация», план §3 D2/D10, §5 W1a).
 *
 * Живёт **вне** screenshot-помпы: собственный цикл, который ставит capture-джобы по одной и
 * держит инварианты, которых у помпы нет:
 *
 * - **≤1 running acceptance-run на процесс** (in-memory флаг). Durable-инвариант «≤1
 *   нетерминальный ран на кандидата» держит partial unique index (миграция v25) — это разные
 *   вещи: индекс защищает кандидата, флаг — 1-CPU прод.
 * - **Стартовая уборка** (триаж V8): переживший рестарт `queued|running` ран некому двигать, он
 *   вечно держал бы кандидата индексом. Все такие раны → `error` при создании оркестратора;
 *   потеря дешёвая благодаря reuse (A3).
 * - **Watchdog** (D2): `running` дольше `runDeadlineMs` политики терминализуется `error` живым
 *   процессом — иначе исключение в цикле блокирует кандидата навсегда.
 * - **Пин кандидатов** (A10): провайдер `sourceHash` нетерминальных ранов для `gcCandidates`.
 *
 * Props случаев живут в памяти процесса (в `acceptance_cases` durable только `props_hash`).
 * Это осознанно: пережившие рестарт раны всё равно убивает стартовая уборка, а для набора из
 * examples кандидата props восстанавливаются детерминированно (`buildCases`).
 */
import type { Database } from "bun:sqlite";
import { ApiError } from "../http";
import { ComponentRepo } from "../repos/components";
import { getCandidateForRev } from "../components/validate";
import { buildCases, DEFAULT_CASE_SURFACE, type AcceptanceCase } from "./cases";
import { buildCasesFromManifest, CaseSetRepo, manifestOfRow, surfaceOfManifest } from "./caseSets";
import { writeRunManifest, type EvidenceCaseEntry, type RunManifest } from "./evidence";
import type { RunInkBbox } from "./inkBbox";
import type { RunNormalizedDiff } from "../visual/diff-runner";
import type { CaseSetManifest } from "../../src/acceptance/caseSetSchema";
import { CASE_POLICY_HASH_V0, type CaseSurface } from "./ids";
import type { AcceptanceCaptureService, CandidateSubject, GateContext } from "./gates/types";
import {
  bySeverity, executeCase, fingerprintOf, foldRunVerdict, progressOf,
  type CaseExecution, type CaseRunnerDeps,
} from "./runner";
import {
  acceptancePolicy, DEFAULT_ACCEPTANCE_POLICY_ID, policyProfileHash, withRequiredVisual,
  type AcceptancePolicy,
} from "./policies";
import { AcceptanceRepo, isTerminalRunStatus, type AcceptanceRunRow, type CandidateRow } from "./repo";

const sleepDefault = (ms: number): Promise<void> => Bun.sleep(ms);

export interface AcceptanceOrchestratorDeps {
  db: Database;
  dataDir: string;
  service: AcceptanceCaptureService;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Стартовая уборка нетерминальных ранов; выключается только в тестах самой уборки. */
  sweepOnStart?: boolean;
  /** Автозапуск цикла после постановки; в тестах удобно гонять `executeRun` вручную. */
  autoDrain?: boolean;
  /** Разрешение кандидата в субъект приёмки; по умолчанию — candidate-кэш по явной ревизии (A10). */
  resolveCandidate?: (row: CandidateRow) => Promise<CandidateSubject>;
  /** Измеритель ink-bbox гейта `geometry` v2 (W3); по умолчанию — node-подпроцесс. */
  inkBbox?: RunInkBbox;
  /** Нормализующий visual-diff гейта `visual` (W5a); по умолчанию — node-подпроцесс. */
  runDiff?: RunNormalizedDiff;
}

/**
 * Форс пересъёмки (A3, план §5 W1b). Четыре режима, и все они — про **стоимость рана**, поэтому
 * молча деградировать один в другой нельзя:
 *
 * - `"none"` (дефолт) — reuse по `case_fingerprint` везде, где кэш годен;
 * - `"failed"` — форс только там, где прошлый результат по тому же отпечатку был провальным
 *   (`fail`/`indeterminate`); всё остальное переиспользуется. `error`-случаи результата не пишут
 *   вовсе, поэтому и без форса снимаются заново;
 * - `"all"` — форс всех целевых случаев;
 * - `{caseIds}` — форс перечисленных; неизвестный id — `422 unknown_case_id` (а не тихий no-op:
 *   иначе опечатка в id выглядела бы как успешная пересъёмка).
 *
 * Алиасы своей съёмки не имеют (D10): указанный в `caseIds` алиас форсит свою цель.
 */
export type RefreshSpec = "none" | "failed" | "all" | { caseIds: string[] };

export interface StartRunInput {
  candidateId: string;
  createdBy: string;
  policyId?: string;
  idempotencyKey?: string | null;
  surface?: CaseSurface;
  /**
   * Case-set-манифест как источник случаев (W2). Взаимоисключим с `cases`: два источника набора
   * в одном ране означали бы, что часть матрицы снята по другой политике.
   */
  caseSetId?: string;
  /** Явный набор случаев; по умолчанию — examples кандидата (A2). */
  cases?: { key: string; props: Record<string, unknown> }[];
  /** Пересъёмка вместо reuse (A3); `true` — синоним `"all"` (совместимость W1a). */
  refresh?: RefreshSpec | boolean;
}

const normalizeRefresh = (refresh: StartRunInput["refresh"]): RefreshSpec => {
  if (refresh === undefined || refresh === false) return "none";
  if (refresh === true) return "all";
  return refresh;
};

export interface StartRunResult {
  run: AcceptanceRunRow;
  cases: AcceptanceCase[];
  cached: boolean;
}

/**
 * Политика рана с учётом намерения набора (W5a): `requireVisual: true` манифеста поднимает гейт
 * `visual` до обязательного. Идентичность профиля (`policy_profile_id`/`policy_profile_hash` рана)
 * при этом не меняется — она сверяется на promote, а «набор потребовал визуал» восстанавливается
 * из `case_set_id` и входит в `case_policy_hash` каждого случая.
 */
export function effectivePolicy(policy: AcceptancePolicy, manifest: CaseSetManifest | null): AcceptancePolicy {
  return manifest?.requireVisual === true ? withRequiredVisual(policy) : policy;
}

/** Кандидат → субъект приёмки: бандл берётся из candidate-кэша **по rev кандидата**, не по head. */
export async function resolveCandidateSubject(db: Database, dataDir: string, row: CandidateRow): Promise<CandidateSubject> {
  const draft = await getCandidateForRev(db, dataDir, row.component_id, row.rev, row.source_hash);
  const head = new ComponentRepo(db).source(row.component_id);
  return {
    candidateId: row.candidate_id,
    componentId: row.component_id,
    designSystem: row.design_system,
    rev: row.rev,
    sourceHash: row.source_hash,
    bundleHash: row.bundle_hash,
    hostAbiVersion: row.host_abi_version,
    themeVersion: row.theme_version,
    entry: draft.entry,
    // N1: расхождение с head — advisory-метка evidence, а не причина отказа (иначе resume при
    // активной правке автором был бы невозможен).
    headDiverged: head.rev !== row.rev,
  };
}

export class AcceptanceOrchestrator {
  readonly repo: AcceptanceRepo;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly autoDrain: boolean;
  private readonly resolve: (row: CandidateRow) => Promise<CandidateSubject>;
  private readonly caseSets = new Map<string, AcceptanceCase[]>();
  private readonly surfaces = new Map<string, CaseSurface>();
  private readonly refreshes = new Map<string, RefreshSpec>();
  private active: string | null = null;
  private draining: Promise<void> | null = null;

  constructor(private readonly deps: AcceptanceOrchestratorDeps) {
    this.repo = new AcceptanceRepo(deps.db);
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? sleepDefault;
    this.autoDrain = deps.autoDrain !== false;
    this.resolve = deps.resolveCandidate ?? ((row) => resolveCandidateSubject(deps.db, deps.dataDir, row));
    if (deps.sweepOnStart !== false) this.repo.sweepNonTerminalRuns();
  }

  /** Идёт ли ран прямо сейчас в этом процессе (инвариант «≤1 running run»). */
  activeRunId(): string | null { return this.active; }

  /** Провайдер пинов для `gcCandidates` (A10). */
  candidatePins = (): Set<string> => this.repo.pinnedSourceHashes();

  /**
   * Постановка рана: набор случаев строится **до** записи (пустой/переполненный набор — 422 ещё
   * до создания строки), случаи вставляются в одной транзакции с раном.
   */
  async startRun(input: StartRunInput): Promise<StartRunResult> {
    const candidateRow = this.repo.requireCandidate(input.candidateId);
    const policy = acceptancePolicy(input.policyId ?? DEFAULT_ACCEPTANCE_POLICY_ID);
    if (!policy) throw new ApiError(422, "unknown_policy_profile", `Unknown acceptance policy profile: ${input.policyId}`);
    const subject = await this.resolve(candidateRow);
    // Case-set-путь (W2): набор, поверхность и per-case политики приходят из манифеста. Сверка
    // владения — здесь: набор чужого компонента не должен даже начать ран (`case_set_mismatch`).
    const caseSet = input.caseSetId === undefined ? null : new CaseSetRepo(this.deps.db).require(input.caseSetId);
    if (caseSet && caseSet.component_id !== candidateRow.component_id) {
      throw new ApiError(422, "case_set_mismatch",
        `Case set describes component ${caseSet.component_id}, not the candidate's ${candidateRow.component_id}`);
    }
    if (caseSet && input.cases !== undefined) {
      throw new ApiError(400, "invalid_request", "cases and caseSetId are mutually exclusive sources of the case set");
    }
    const manifest = caseSet ? manifestOfRow(caseSet) : null;
    const surface = input.surface ?? (manifest ? surfaceOfManifest(manifest) : DEFAULT_CASE_SURFACE);
    const cases = manifest
      ? buildCasesFromManifest(manifest)
      : buildCases(subject.entry, input.cases ? { cases: input.cases } : {});
    const refresh = normalizeRefresh(input.refresh);
    // Валидация `{caseIds}` — до создания строки рана: неизвестный id обязан отказать постановке,
    // а не тихо снять «ничего».
    if (typeof refresh === "object") {
      const known = new Set(cases.map((item) => item.caseId));
      for (const caseId of refresh.caseIds) {
        if (!known.has(caseId)) {
          throw new ApiError(422, "unknown_case_id", `Case is not part of this run's case set: ${caseId}`);
        }
      }
    }
    const created = this.repo.createRun({
      candidateId: candidateRow.candidate_id,
      componentId: candidateRow.component_id,
      policyProfileId: policy.id,
      policyProfileHash: policyProfileHash(policy),
      idempotencyKey: input.idempotencyKey ?? null,
      caseSetId: caseSet?.case_set_id ?? null,
      createdBy: input.createdBy,
      progress: progressOf([], cases.length, null),
      // Роли гейтов рана — по эффективной политике (W5a): `requireVisual` набора видно в
      // `gates_json` сразу на постановке, а не только в свёртке.
      gates: effectivePolicy(policy, manifest).gates,
      cases: cases.map((item) => ({
        caseId: item.caseId,
        caseKey: item.caseKey,
        propsHash: item.propsHash,
        caseFingerprint: fingerprintOf({ candidate: subject, surface }, item),
        casePolicyHash: item.casePolicyHash ?? CASE_POLICY_HASH_V0,
        referenceAssetId: item.referenceAssetId ?? null,
        expectedGeometry: item.expectedGeometry ?? null,
        aliasOfCaseId: item.aliasOfCaseId,
      })),
    });
    if (!created.cached) {
      this.caseSets.set(created.run.run_id, cases);
      this.surfaces.set(created.run.run_id, surface);
      if (refresh !== "none") this.refreshes.set(created.run.run_id, refresh);
      if (this.autoDrain) void this.drain();
    }
    return { run: created.run, cases, cached: created.cached };
  }

  /** Cancel допустим только из `queued` (триаж A6): бегущий ран не отменяется. */
  cancelQueuedRun(runId: string): AcceptanceRunRow {
    const row = this.repo.requireRun(runId);
    if (row.status !== "queued") {
      throw new ApiError(409, "run_not_cancellable", `Acceptance run is ${row.status}; only queued runs can be cancelled`);
    }
    this.caseSets.delete(runId);
    return this.repo.terminalizeRun(runId, { status: "cancelled" });
  }

  /**
   * Watchdog (D2): раны, висящие в `running` дольше дедлайна своей политики, терминализуются
   * `error`. Дедлайн берётся из профиля рана, а не из глобальной константы.
   */
  sweepStaleRuns(): number {
    let closed = 0;
    // Максимальный дедлайн среди профилей — грубый фильтр запросом; точный порог проверяется ниже.
    const rows = this.repo.runningRunsOlderThan(0, this.now());
    for (const row of rows) {
      const policy = acceptancePolicy(row.policy_profile_id);
      const deadline = policy?.runDeadlineMs ?? 30 * 60_000;
      const startedAt = Date.parse(row.started_at ?? row.created_at);
      if (Number.isNaN(startedAt) || this.now() - startedAt < deadline) continue;
      this.repo.terminalizeRun(row.run_id, { status: "error" });
      this.caseSets.delete(row.run_id);
      closed += 1;
    }
    return closed;
  }

  /** Цикл: пока есть `queued` раны — исполнять по одному. Повторный вызов присоединяется к текущему. */
  drain(): Promise<void> {
    if (this.draining) return this.draining;
    const loop = (async () => {
      try {
        for (;;) {
          this.sweepStaleRuns();
          const next = this.repo.queuedRuns(1)[0];
          if (!next) return;
          await this.executeRun(next.run_id);
        }
      } finally { this.draining = null; }
    })();
    this.draining = loop;
    return loop;
  }

  /** Ждать завершения текущего цикла (тестовый шов и graceful shutdown). */
  settled(): Promise<void> { return this.draining ?? Promise.resolve(); }

  /**
   * Исполнение одного рана. Возвращает терминальную строку (или текущую, если ран уже ушёл в
   * терминал — cancel/watchdog выиграли гонку).
   */
  async executeRun(runId: string): Promise<AcceptanceRunRow> {
    if (this.active !== null && this.active !== runId) {
      throw new ApiError(409, "acceptance_run_in_flight", "Another acceptance run is already executing in this process", { runId: this.active });
    }
    const row = this.repo.requireRun(runId);
    if (isTerminalRunStatus(row.status)) return row;
    if (!this.repo.startRun(runId)) return this.repo.requireRun(runId);
    this.active = runId;
    try {
      return await this.runCases(this.repo.requireRun(runId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.repo.terminalizeRun(runId, { status: "error", gates: { error: message } });
    } finally {
      this.active = null;
      this.caseSets.delete(runId);
      this.surfaces.delete(runId);
      this.refreshes.delete(runId);
    }
  }

  private async runCases(run: AcceptanceRunRow): Promise<AcceptanceRunRow> {
    const profile = acceptancePolicy(run.policy_profile_id);
    if (!profile) throw new Error(`Run references an unknown policy profile: ${run.policy_profile_id}`);
    const candidateRow = this.repo.requireCandidate(run.candidate_id);
    const subject = await this.resolve(candidateRow);
    // Набор восстановим и без памяти процесса, если ран стоит на case-set'е: манифест durable
    // (`component_case_sets`), поэтому props/эталоны/политики берутся из него, а не из examples.
    const storedManifest = run.case_set_id === null ? null : manifestOfRow(new CaseSetRepo(this.deps.db).require(run.case_set_id));
    const policy = effectivePolicy(profile, storedManifest);
    const surface = this.surfaces.get(run.run_id) ?? (storedManifest ? surfaceOfManifest(storedManifest) : DEFAULT_CASE_SURFACE);
    const cases = this.caseSets.get(run.run_id)
      ?? (storedManifest ? buildCasesFromManifest(storedManifest) : buildCases(subject.entry));
    const refresh = this.refreshes.get(run.run_id) ?? "none";

    const shared = new Map<string, unknown>();
    const context: CaseRunnerDeps["context"] = {
      db: this.deps.db,
      dataDir: this.deps.dataDir,
      service: this.deps.service,
      sleep: this.sleep,
      now: this.now,
      ...(this.deps.inkBbox ? { inkBbox: this.deps.inkBbox } : {}),
      ...(this.deps.runDiff ? { runDiff: this.deps.runDiff } : {}),
    } as Omit<GateContext, "case" | "determinismSampled" | "shared" | "policy" | "runId" | "candidate" | "surface">;
    const deps: CaseRunnerDeps = { repo: this.repo, policy, runId: run.run_id, candidate: subject, surface, shared, context };

    const targets = cases.filter((item) => item.aliasOfCaseId === null);
    // `{caseIds}`: алиас не снимается — форс уезжает на его цель (D10).
    const forced = typeof refresh === "object"
      ? new Set(refresh.caseIds.map((caseId) => cases.find((item) => item.caseId === caseId)?.aliasOfCaseId ?? caseId))
      : null;
    const aliases = cases.filter((item) => item.aliasOfCaseId !== null);
    // Выборка determinism: первые N целевых случаев (плюс fail-случаи — они добираются ниже).
    const sampled = new Set(targets.slice(0, policy.determinismSampleSize).map((item) => item.caseId));

    const executions: CaseExecution[] = [];
    const byCaseId = new Map<string, CaseExecution>();
    let ema: number | null = null;

    for (const item of targets) {
      // Cancel/watchdog могли терминализовать ран, пока шла съёмка предыдущего случая.
      const current = this.repo.run(run.run_id);
      if (!current || isTerminalRunStatus(current.status)) return this.repo.requireRun(run.run_id);
      this.repo.updateCase(run.run_id, item.caseId, { status: "running", startedAt: new Date(this.now()).toISOString() });
      const force = this.forceOf(refresh, forced, item.caseId, fingerprintOf(deps, item), subject.componentId);
      const execution = await executeCase(deps, item, {
        determinismSampled: sampled.has(item.caseId),
        refresh: force !== null,
        ...(force === null ? {} : { refreshReason: force }),
      });
      this.persistCase(run.run_id, execution);
      executions.push(execution);
      byCaseId.set(item.caseId, execution);
      if (!execution.reused) ema = ema === null ? execution.durationMs : Math.round(ema * 0.7 + execution.durationMs * 0.3);
      this.repo.updateRunProgress(run.run_id, progressOf(executions, cases.length, ema));
    }

    for (const item of aliases) {
      // Алиас наследует вердикт цели (D10): своей съёмки у него нет по построению набора.
      const target = byCaseId.get(item.aliasOfCaseId!);
      const execution: CaseExecution = target
        ? { ...target, caseId: item.caseId, caseKey: item.caseKey, caseFingerprint: fingerprintOf(deps, item), aliasOfCaseId: item.aliasOfCaseId, reused: false, reuseReason: `alias_of:${item.aliasOfCaseId}`, durationMs: 0 }
        : { caseId: item.caseId, caseKey: item.caseKey, caseFingerprint: fingerprintOf(deps, item), status: "error", verdict: null, gates: [], severity: null, captureQuality: null, artifacts: [], aliasOfCaseId: item.aliasOfCaseId, reused: false, reuseReason: null, durationMs: 0, error: { outcome: "subprocess_error", message: "alias target was not executed" } };
      this.persistCase(run.run_id, execution);
      executions.push(execution);
      this.repo.updateRunProgress(run.run_id, progressOf(executions, cases.length, ema));
    }

    const verdict = foldRunVerdict(executions, policy);
    const manifest = this.manifestOf(run, subject, verdict, executions);
    const { manifestHash } = await writeRunManifest(this.deps.dataDir, run.run_id, manifest);
    return this.repo.terminalizeRun(run.run_id, {
      status: verdict,
      gates: this.gatesSummary(executions),
      progress: progressOf(executions, cases.length, ema, 0),
      evidenceManifestHash: manifestHash,
    });
  }

  /**
   * Решение по одному целевому случаю: форсить съёмку или дать раннеру попробовать reuse.
   * Возвращает причину форса (`refresh:<mode>` — она уедет в `reuse_reason` и в evidence) либо
   * `null`. `"failed"` смотрит **тот же кэш результатов**, что и reuse: провальный прошлый
   * вердикт по этому же отпечатку — единственный признак «этот случай надо переснять».
   */
  private forceOf(
    refresh: RefreshSpec,
    forced: Set<string> | null,
    caseId: string,
    fingerprint: string,
    componentId: string,
  ): string | null {
    if (refresh === "none") return null;
    if (refresh === "all") return "refresh:all";
    if (refresh === "failed") {
      const row = this.repo.caseResultForComponent(fingerprint, componentId);
      return row && (row.verdict === "fail" || row.verdict === "indeterminate") ? "refresh:failed" : null;
    }
    return forced?.has(caseId) ? "refresh:cases" : null;
  }

  private persistCase(runId: string, execution: CaseExecution): void {
    this.repo.updateCase(runId, execution.caseId, {
      status: execution.status,
      verdict: execution.verdict,
      gates: execution.gates,
      severity: execution.severity,
      captureQuality: execution.captureQuality,
      reuseReason: execution.reuseReason,
      finishedAt: new Date(this.now()).toISOString(),
    });
  }

  /** Run-level агрегат `gates_json`: по каждому гейту — сколько случаев в каком статусе. */
  private gatesSummary(executions: CaseExecution[]): Record<string, Record<string, number>> {
    const summary: Record<string, Record<string, number>> = {};
    for (const execution of executions) {
      for (const gate of execution.gates) {
        const bucket = summary[gate.gate] ?? (summary[gate.gate] = {});
        bucket[gate.status] = (bucket[gate.status] ?? 0) + 1;
      }
    }
    return summary;
  }

  private manifestOf(run: AcceptanceRunRow, subject: CandidateSubject, verdict: string, executions: CaseExecution[]): RunManifest {
    const cases: EvidenceCaseEntry[] = [...executions].sort(bySeverity).map((execution) => ({
      caseId: execution.caseId,
      caseKey: execution.caseKey,
      verdict: execution.verdict,
      status: execution.status,
      reused: execution.reused,
      ...(execution.reuseReason?.startsWith("refresh:") ? { refreshReason: execution.reuseReason } : {}),
      aliasOfCaseId: execution.aliasOfCaseId,
      artifacts: execution.artifacts.map((artifact) => ({ name: artifact.name, sha256: artifact.sha256, bytes: artifact.bytes })),
    }));
    return {
      version: 1,
      runId: run.run_id,
      candidateId: run.candidate_id,
      componentId: run.component_id,
      policyProfileId: run.policy_profile_id,
      policyProfileHash: run.policy_profile_hash,
      verdict,
      createdAt: run.created_at,
      finishedAt: new Date(this.now()).toISOString(),
      ...(subject.headDiverged ? { headDiverged: true } : {}),
      cases,
    };
  }
}

export type { AcceptancePolicy, AcceptanceCaptureService };
