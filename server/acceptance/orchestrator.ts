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
import { buildCasesFromManifest, casesOfRun, CaseSetRepo, manifestOfRow, surfaceOfManifest } from "./caseSets";
import { writeRunManifest, type EvidenceCaseEntry, type RunManifest } from "./evidence";
import type { RunInkBbox } from "./inkBbox";
import type { RunNormalizedDiff } from "../visual/diff-runner";
import type { CaseSetManifest } from "../../src/acceptance/caseSetSchema";
import { CASE_POLICY_HASH_V0, readinessPolicyHashOf, verdictPolicySnapshotOf, type CaseSurface, type VerdictPolicySnapshot } from "./ids";
import { rendererFingerprint } from "../capture/renderer";
import type { AcceptanceCaptureService, CandidateSubject, GateContext } from "./gates/types";
import {
  bySeverity, carryBaselineCase, caseFingerprintsFor, causesOfGates, executeCase, fingerprintOf, foldRunVerdict,
  progressOf, reuseReceiptOf,
  type CaseExecution, type CaseRunnerDeps,
} from "./runner";
import { baselineCaseIndex, computeImpact, type ImpactReport } from "./impact";
import { groupRemediations, type RemediationGroup } from "./grouping";
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

/**
 * Скоуп форса (C1). Различие — не косметика, а ответ на вопрос «сколько стоит переоценка»:
 * `verdict` требует пересмотреть вердикт (кадр при совпавшем `frameFingerprint` берётся из CAS),
 * `frame` требует новых пикселей.
 */
export type RefreshScope = "frame" | "verdict";

/** Кого форсим внутри одного скоупа. Объединение — покомпонентное «или»/конкатенация. */
export interface RefreshTarget { all: boolean; failed: boolean; caseIds: string[] }
export interface RefreshPlan { frame: RefreshTarget; verdict: RefreshTarget }
/** Тройка алгебры: что попросил автор, что потребовал импакт, что применяется (C1). */
export interface RefreshAlgebra { requested: RefreshPlan; impact: RefreshPlan; effective: RefreshPlan }

const emptyTarget = (): RefreshTarget => ({ all: false, failed: false, caseIds: [] });
export const emptyRefreshPlan = (): RefreshPlan => ({ frame: emptyTarget(), verdict: emptyTarget() });
export const refreshTargetEmpty = (target: RefreshTarget): boolean =>
  !target.all && !target.failed && target.caseIds.length === 0;
export const refreshPlanEmpty = (plan: RefreshPlan): boolean =>
  refreshTargetEmpty(plan.frame) && refreshTargetEmpty(plan.verdict);

const unionTarget = (left: RefreshTarget, right: RefreshTarget): RefreshTarget => ({
  all: left.all || right.all,
  failed: left.failed || right.failed,
  caseIds: [...new Set([...left.caseIds, ...right.caseIds])].sort(),
});
export const unionRefreshPlans = (left: RefreshPlan, right: RefreshPlan): RefreshPlan => ({
  frame: unionTarget(left.frame, right.frame),
  verdict: unionTarget(left.verdict, right.verdict),
});

/**
 * Запрошенный план (D5, половина CLI — в W2a).
 *
 * `--refresh failed` — **verdict-скоуп**: автор говорит «пересмотри упавшее», а не «пересними
 * упавшее». Кадр при совпавшем `frameFingerprint` переиспользуется, и именно это делает
 * достижимым `recapture = 0` из AC фидбэка. Пересъёмка возвращается флагом `--recapture`
 * (`recapture: true` в теле) — эскалация до frame-скоупа.
 *
 * `--refresh all` и `--refresh <ids>` остаются frame-скоупом: их смысл всегда был «переснять».
 */
export function requestedRefreshPlan(refresh: RefreshSpec, recapture = false): RefreshPlan {
  const plan = emptyRefreshPlan();
  if (refresh === "none") return plan;
  if (refresh === "all") { plan.frame.all = true; return plan; }
  if (refresh === "failed") {
    if (recapture) plan.frame.failed = true; else plan.verdict.failed = true;
    return plan;
  }
  plan.frame.caseIds = [...new Set(refresh.caseIds)].sort();
  return plan;
}

/**
 * Алгебра рана из персистентного `refresh_json`. До-миграционный ран (NULL) читается как пустой
 * план — это честно: он и не мог быть поставлен с гранулярным скоупом.
 */
export function refreshAlgebraOfRun(run: AcceptanceRunRow): RefreshAlgebra {
  const empty: RefreshAlgebra = { requested: emptyRefreshPlan(), impact: emptyRefreshPlan(), effective: emptyRefreshPlan() };
  if (run.refresh_json === null) return empty;
  try {
    const parsed = JSON.parse(run.refresh_json) as Partial<RefreshAlgebra>;
    if (parsed === null || typeof parsed !== "object") return empty;
    const plan = (value: RefreshPlan | undefined): RefreshPlan => {
      if (!value || typeof value !== "object") return emptyRefreshPlan();
      const target = (item: RefreshTarget | undefined): RefreshTarget => ({
        all: item?.all === true,
        failed: item?.failed === true,
        caseIds: Array.isArray(item?.caseIds) ? item.caseIds : [],
      });
      return { frame: target(value.frame), verdict: target(value.verdict) };
    };
    return { requested: plan(parsed.requested), impact: plan(parsed.impact), effective: plan(parsed.effective) };
  } catch { return empty; }
}

/**
 * План, вытекающий из импакта: случаи, про которые доказано, что они могли измениться.
 *
 * **Он не форсит пересъёмку** — он запрещает перенос вердикта baseline. Разница принципиальна:
 * отпечаток доказывает строго больше, чем импакт («входы случая те же»), поэтому reuse по
 * совпавшим слоям остаётся законным даже для затронутого случая, а вот перенос чужого вердикта —
 * нет. Печатается план всё равно: «почему ран стоил столько» обязано читаться из тройки.
 */
export function impactRefreshPlan(impact: ImpactReport | null): RefreshPlan {
  const plan = emptyRefreshPlan();
  if (impact === null) return plan;
  if (impact.basis === "conservative") { plan.frame.all = true; return plan; }
  plan.frame.caseIds = [...impact.affectedCases].sort();
  return plan;
}

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
  /**
   * Эскалация `--refresh failed` до пересъёмки (`--recapture` CLI, D5). На `all`/`{caseIds}` не
   * влияет — они и так frame-скоуп.
   */
  recapture?: boolean;
  /**
   * Частичная пересъёмка (W6, D6): терминальный ран того же компонента, относительно которого
   * считается импакт. Незатронутые случаи получают вердикт baseline без съёмки, затронутые
   * снимаются как обычно. Недоказуемый импакт (`conservative`) означает полный ран — режим
   * никогда не «экономит» молча.
   */
  baselineRunId?: string;
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
  /** Отчёт импакта, если ран поставлен с `baselineRunId` (W6). */
  impact?: ImpactReport;
  /** Алгебра refresh рана (C1): `{requested, impact, effective}`. */
  refresh: RefreshAlgebra;
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

/**
 * Группы ремедиаций рана (W5b): классифицированные причины случаев, схлопнутые в «одну правку»
 * (§19.6 фидбэка). Алиасы участвуют наравне с целями — их вердикт и причины унаследованы от цели,
 * и в отчёте автору важно видеть все затронутые состояния семьи, а не только снятые.
 */
export function remediationGroupsOf(executions: CaseExecution[], cases: AcceptanceCase[]): RemediationGroup[] {
  const dimsByCaseId = new Map(cases.map((item) => [item.caseId, item.dims ?? null]));
  return groupRemediations(executions.flatMap((execution) => {
    const causes = causesOfGates(execution.gates);
    if (causes.length === 0) return [];
    return [{ caseId: execution.caseId, causes, dims: dimsByCaseId.get(execution.caseId) ?? null }];
  }));
}

export class AcceptanceOrchestrator {
  readonly repo: AcceptanceRepo;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly autoDrain: boolean;
  private readonly resolve: (row: CandidateRow) => Promise<CandidateSubject>;
  private readonly caseSets = new Map<string, AcceptanceCase[]>();
  private readonly surfaces = new Map<string, CaseSurface>();
  /**
   * Планы частичной пересъёмки (W6), по `runId`. Живут в памяти процесса — как и props случаев:
   * ран, переживший рестарт, всё равно убивает стартовая уборка, а потеря плана деградирует
   * безопасно (полная съёмка), а не в молчаливый reuse.
   */
  private readonly impacts = new Map<string, ImpactReport>();
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
    // Слот-пины разрешаются **здесь** и в режиме `"gating"` (§A5): постановка — единственный
    // момент, когда голова кандидата зафиксирована и ещё ничего не снято, поэтому именно она
    // отвечает за `slot_unknown`/`slot_bindings_unsupported`/`slot_component_not_published`.
    const cases = manifest
      ? casesOfRun({
        db: this.deps.db,
        componentId: candidateRow.component_id,
        designSystem: candidateRow.design_system,
        candidateEntry: subject.entry,
        manifest,
        mode: "gating",
      })
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
    // Частичная пересъёмка (W6): импакт считается **до** создания рана — недоступный/чужой
    // baseline обязан отказать постановке, а не всплыть посреди съёмки.
    const impact = input.baselineRunId === undefined
      ? null
      : await computeImpact({
        db: this.deps.db,
        dataDir: this.deps.dataDir,
        repo: this.repo,
        candidate: candidateRow,
        baselineRun: this.repo.requireRun(input.baselineRunId),
      });
    // Алгебра refresh (C1) считается **на старте** и персистится: без неё «почему этот ран ничего
    // не переснял» невосстановимо, а после рестарта процесса — тем более.
    const requested = requestedRefreshPlan(refresh, input.recapture === true);
    const impactPlan = impactRefreshPlan(impact);
    const algebra: RefreshAlgebra = {
      requested,
      impact: impactPlan,
      effective: unionRefreshPlans(requested, impactPlan),
    };
    // D7: отпечатки случая считает одна функция — та же, что в раннере. Политика — эффективная
    // (с `requireVisual` набора), иначе слой вердикта разошёлся бы между постановкой и съёмкой.
    const runPolicy = effectivePolicy(policy, manifest);
    const created = this.repo.createRun({
      candidateId: candidateRow.candidate_id,
      componentId: candidateRow.component_id,
      policyProfileId: policy.id,
      policyProfileHash: policyProfileHash(policy),
      idempotencyKey: input.idempotencyKey ?? null,
      caseSetId: caseSet?.case_set_id ?? null,
      createdBy: input.createdBy,
      // v30 (W7): объявленный рендерер рана персистится на постановке — тем же значением, что
      // входит в `frame_fingerprint` случаев. Multi-run promote сверяет его у всех ранов набора:
      // покрытие, снятое разными рендерерами, склеивать в одну доказательную базу нельзя.
      rendererFingerprint: rendererFingerprint(readinessPolicyHashOf(runPolicy.readiness)),
      progress: progressOf([], cases.length, null),
      // Роли гейтов рана — по эффективной политике (W5a): `requireVisual` набора видно в
      // `gates_json` сразу на постановке, а не только в свёртке.
      gates: runPolicy.gates,
      refresh: algebra,
      cases: cases.map((item) => {
        const fps = caseFingerprintsFor({ candidate: subject, surface, policy: runPolicy }, item);
        return {
          caseId: item.caseId,
          caseKey: item.caseKey,
          propsHash: item.propsHash,
          caseFingerprint: fps.case,
          frameFingerprint: fps.frame,
          comparisonFingerprint: fps.comparison,
          verdictPolicyHash: fps.verdictPolicy,
          casePolicyHash: item.casePolicyHash ?? CASE_POLICY_HASH_V0,
          referenceAssetId: item.referenceAssetId ?? null,
          expectedGeometry: item.expectedGeometry ?? null,
          aliasOfCaseId: item.aliasOfCaseId,
          // `slots_hash` (миграция v31, T2.3) — ключ покрытия и рукопожатия капчура. Пишется
          // условным спредом: инвариант «отсутствует, а не пусто» доезжает до колонки как NULL,
          // и slot-free строки остаются побайтово прежними.
          ...(item.slotsHash === undefined ? {} : { slotsHash: item.slotsHash }),
        };
      }),
    });
    if (!created.cached) {
      this.caseSets.set(created.run.run_id, cases);
      this.surfaces.set(created.run.run_id, surface);
      if (impact) this.impacts.set(created.run.run_id, impact);
      if (this.autoDrain) void this.drain();
    }
    return { run: created.run, cases, cached: created.cached, refresh: algebra, ...(impact ? { impact } : {}) };
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
      this.impacts.delete(runId);
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
    // Реконструкция набора (§A5): слот-пины разрешаются в режиме `"reconstruction"` — статус- и
    // надгробие-слепом. Ран уже поставлен, его отпечатки персистированы, и «ребёнка заархивировали
    // пока мы снимали» обязано ронять **съёмку** названным отказом капчура, а не подменять набор
    // (и уж тем более не давать другой `frame_fingerprint`, чем лежит в `acceptance_cases`).
    let cases: AcceptanceCase[];
    try {
      cases = this.caseSets.get(run.run_id)
        ?? (storedManifest
          ? casesOfRun({
            db: this.deps.db,
            componentId: run.component_id,
            designSystem: candidateRow.design_system,
            candidateEntry: subject.entry,
            manifest: storedManifest,
            mode: "reconstruction",
          })
          : buildCases(subject.entry));
    } catch (error) {
      // Отказ реконструкции — терминал с **названной** причиной, а не голая строка в `gates.error`:
      // «набор рана больше не восстановим» обязано читаться из `status_reason` отчёта.
      if (error instanceof ApiError && error.code.startsWith("slot_")) {
        return this.repo.terminalizeRun(run.run_id, {
          status: "error", statusReason: error.code, gates: { error: error.message },
        });
      }
      throw error;
    }
    // Алгебра refresh персистентна (v29): план рана переживает рестарт процесса и читается
    // отчётом, а не восстанавливается из памяти «как получится».
    const algebra = refreshAlgebraOfRun(run);
    // План частичной пересъёмки (W6). Он же — источник `impact_json` рана; `conservative`-план
    // пишется в ран наравне с узким, потому что «доказать сужение не удалось» — это тоже отчёт.
    const impact = this.impacts.get(run.run_id) ?? null;
    const carryable = impact === null || impact.basis === "conservative"
      ? new Set<string>()
      : new Set(impact.unaffectedCases);
    const baselineRows = impact === null ? [] : this.repo.cases(impact.baselineRunId);
    const baselineCases = baselineCaseIndex(baselineRows);
    // Вердикты baseline — первый источник для `forceOf("failed")` (C19): именно они, а не кэш по
    // новому отпечатку, знают, какие случаи падали в прошлый раз.
    const baselineVerdicts = new Map(baselineRows.map((row) => [row.case_id, row.verdict]));
    // Реконструкция вердиктной политики baseline-рана (D0/D14): профиль его строки + манифест его
    // набора. Валидацию по `verdict_policy_hash` делает сам `carryBaselineCase`.
    const baselinePolicies = impact === null
      ? new Map<string, VerdictPolicySnapshot>()
      : this.baselineVerdictPolicies(impact.baselineRunId);

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
    // Алиас не снимается — форс уезжает на его цель (D10). Разворот делается один раз, для обоих
    // скоупов сразу: список случаев в плане может прийти и из `--refresh <ids>`, и из импакта.
    const resolveTargets = (caseIds: string[]): Set<string> =>
      new Set(caseIds.map((caseId) => cases.find((item) => item.caseId === caseId)?.aliasOfCaseId ?? caseId));
    // Разворачивается **запрошенный** план: импакт-часть `effective` печатается в отчёте, но
    // форсом не является (см. `impactRefreshPlan`).
    const forcedFrame = resolveTargets(algebra.requested.frame.caseIds);
    const forcedVerdict = resolveTargets(algebra.requested.verdict.caseIds);
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
      const fps = caseFingerprintsFor(deps, item);
      // Форс применяется по **запрошенному** плану: импакт-часть алгебры запрещает перенос
      // вердикта baseline (ниже), но не форсит пересъёмку — отпечаток доказывает строго больше.
      const force = this.forceOf(algebra.requested, { frame: forcedFrame, verdict: forcedVerdict }, item.caseId, fps.frame, subject.componentId, baselineVerdicts);
      // Приоритет за `refresh`: явный форс дороже, но он — прямое указание автора, и импакт не
      // вправе его отменить. Перенос вердикта baseline пробуется только для незатронутых случаев
      // и молча уступает съёмке, если доказательства baseline больше нет (артефакт вычищен).
      const carried = force !== null || !carryable.has(item.caseId)
        ? null
        : await carryBaselineCase(
          deps, item,
          baselineCases.get(item.caseId) ?? {
            verdict: null, status: "pending", gates_json: null, capture_quality_json: null,
            frame_fingerprint: null, comparison_fingerprint: null, verdict_policy_hash: null,
          },
          impact!.basis,
          { baselinePolicy: baselinePolicies.get(item.caseId) ?? null },
        );
      const execution = carried ?? await executeCase(deps, item, {
        determinismSampled: sampled.has(item.caseId),
        ...(force === null ? {} : { scope: force.scope, refreshReason: force.reason }),
      });
      this.persistCase(run.run_id, execution);
      executions.push(execution);
      byCaseId.set(item.caseId, execution);
      // EMA считает **оплаченную** работу (D9): съёмка и re-diff стоят времени, полный reuse и
      // чистый пересчёт по метрикам — нет, и включать их значило бы занижать ETA остатка.
      const paid = !execution.reused && (execution.rediffed === true || execution.frameReused !== true);
      if (paid) ema = ema === null ? execution.durationMs : Math.round(ema * 0.7 + execution.durationMs * 0.3);
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

    // `refresh_scope_empty` (C10/D2): предикат **по факту reuse**, а не по форме запроса. Явный
    // непустой скоуп, хотя бы один случай отдан из кэша/переносом — и при этом ни один не был
    // переснят, пере-диффнут или пересчитан: форс не сделал ничего, и молча отдать «pass» здесь
    // значило бы соврать про стоимость приёмки. Первый ран с пустым кэшем через предикат проходит:
    // там всё снято заново, `reused` пуст.
    const scopeEmpty = !refreshPlanEmpty(algebra.requested)
      && executions.some((item) => item.reused)
      && !executions.some((item) => item.frameReused !== true || item.rediffed === true || item.verdictRecomputed === true);
    const verdict = scopeEmpty ? "error" as const : foldRunVerdict(executions, policy);
    // Эффективная вердиктная политика каждого случая — в манифест (критерий P0-3, W8). Считается
    // тем же вызовом, что и отпечатки рана (`caseFingerprintsFor`), поэтому снимок в evidence и
    // хэш в строке случая совпадают по построению, а не по совпадению.
    const verdictPolicies = new Map(cases.map((item) => {
      const fps = caseFingerprintsFor(deps, item);
      return [item.caseId, { hash: fps.verdictPolicy, snapshot: fps.verdictPolicySnapshot }] as const;
    }));
    const manifest = this.manifestOf(run, subject, verdict, executions, verdictPolicies);
    const { manifestHash } = await writeRunManifest(this.deps.dataDir, run.run_id, manifest);
    return this.repo.terminalizeRun(run.run_id, {
      status: verdict,
      ...(scopeEmpty ? { statusReason: "refresh_scope_empty" } : {}),
      gates: this.gatesSummary(executions),
      // Группы ремедиаций живут в `progress_json` рядом с прогрессом: это run-level **отчёт**, а
      // `gates_json` — сводка статусов по гейтам, и смешивать в ней счётчики с диагностикой значило
      // бы завести в одном поле две формы. Роут поднимает их на верхний уровень ответа.
      progress: { ...progressOf(executions, cases.length, ema, 0), remediationGroups: remediationGroupsOf(executions, cases) },
      // `impact_json` (W6): план частичной пересъёмки как он был применён. Пишется только когда
      // ран действительно поставлен с baseline — иначе поле остаётся `null` («импакт не считался»),
      // а не пустым отчётом.
      ...(impact === null ? {} : { impact }),
      evidenceManifestHash: manifestHash,
    });
  }

  /**
   * Решение по одному целевому случаю: форсить — и в каком скоупе — или дать раннеру попробовать
   * полный каскад reuse.
   *
   * `"failed"` — тот самый узел P0-3/P0-4. Раньше он искал провальный вердикт по **новому**
   * `case_fingerprint`: после смены порога кэш по этому ключу пуст, форс молча снимался, и следом
   * переносился вердикт baseline, посчитанный по старой политике. Теперь источников два, в
   * порядке доказательности:
   *
   * 1. **вердикты baseline-рана** (C19) — прямой ответ «что падало в прошлый раз», не зависящий
   *    ни от какой политики;
   * 2. **frame-lookup** (`caseResultForFrame`) — «этот кадр в прошлый раз давал провал»; он
   *    переживает смену порога и эталона, потому что кадровый слой их не содержит.
   */
  private forceOf(
    requested: RefreshPlan,
    forced: { frame: Set<string>; verdict: Set<string> },
    caseId: string,
    frameFingerprint: string,
    componentId: string,
    baselineVerdicts: Map<string, string | null>,
  ): { scope: RefreshScope; reason: string } | null {
    if (requested.frame.all) return { scope: "frame", reason: "refresh:all" };
    if (forced.frame.has(caseId)) return { scope: "frame", reason: "refresh:cases" };
    const failedScope: RefreshScope | null = requested.frame.failed ? "frame" : requested.verdict.failed ? "verdict" : null;
    if (failedScope !== null && this.previouslyFailed(caseId, frameFingerprint, componentId, baselineVerdicts)) {
      return { scope: failedScope, reason: "refresh:failed" };
    }
    if (forced.verdict.has(caseId)) return { scope: "verdict", reason: "refresh:cases" };
    return null;
  }

  private previouslyFailed(
    caseId: string,
    frameFingerprint: string,
    componentId: string,
    baselineVerdicts: Map<string, string | null>,
  ): boolean {
    const baseline = baselineVerdicts.get(caseId);
    if (baseline === "fail" || baseline === "indeterminate") return true;
    if (baseline === "pass" || baseline === "skipped") return false;
    const row = this.repo.caseResultForFrame(frameFingerprint, componentId);
    return row !== undefined && (row.verdict === "fail" || row.verdict === "indeterminate");
  }

  /**
   * Вердиктные политики случаев baseline-рана, реконструированные из **живого** рана: его профиль
   * (`policy_profile_id`) и манифест его набора (`case_set_id`). Реконструкция, а не хранение:
   * снимок политики лежит на строке кэша результатов, а строка `acceptance_cases` несёт только
   * хэш — им и проверяется, что реконструкция попала (`carryBaselineCase`).
   */
  private baselineVerdictPolicies(baselineRunId: string): Map<string, VerdictPolicySnapshot> {
    const out = new Map<string, VerdictPolicySnapshot>();
    const run = this.repo.run(baselineRunId);
    if (!run) return out;
    const profile = acceptancePolicy(run.policy_profile_id);
    if (!profile) return out;
    const manifest = run.case_set_id === null
      ? null
      : manifestOfRow(new CaseSetRepo(this.deps.db).require(run.case_set_id));
    const policy = effectivePolicy(profile, manifest);
    // **Единственный легальный вызов `buildCasesFromManifest` мимо `casesOfRun`** (§A5), и он
    // осознан: снимок вердиктной политики (`verdictPolicySnapshotOf`) не читает ни `slotBindings`,
    // ни `slotsHash` — только props-независимые допуски, `expectedGeometry` и профиль. Разрешать
    // здесь пины значило бы ходить в БД за фактами, которые никуда не войдут, и получать отказ по
    // чужому, давно завершённому baseline-рану — то есть ронять живой ран из-за истории.
    const cases = manifest ? buildCasesFromManifest(manifest) : null;
    if (cases === null) {
      // Examples-путь: у случая нет ни эталона, ни допусков — снимок политики одинаков для всех.
      for (const row of this.repo.cases(baselineRunId)) {
        out.set(row.case_id, verdictPolicySnapshotOf(policy, { caseKey: row.case_key, propsHash: row.props_hash }));
      }
      return out;
    }
    for (const item of cases) out.set(item.caseId, verdictPolicySnapshotOf(policy, item));
    return out;
  }

  private persistCase(runId: string, execution: CaseExecution): void {
    this.repo.updateCase(runId, execution.caseId, {
      status: execution.status,
      verdict: execution.verdict,
      gates: execution.gates,
      severity: execution.severity,
      captureQuality: execution.captureQuality,
      reuseReason: execution.reuseReason,
      // Квитанция reuse (W8-форма): собирается уже сейчас — данные, которых не собрали во время
      // рана, задним числом не появятся, а выдача в evidence приезжает волной W8.
      reuseReceipt: reuseReceiptOf(execution),
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

  private manifestOf(
    run: AcceptanceRunRow,
    subject: CandidateSubject,
    verdict: string,
    executions: CaseExecution[],
    verdictPolicies: ReadonlyMap<string, { hash: string; snapshot: VerdictPolicySnapshot }> = new Map(),
  ): RunManifest {
    const cases: EvidenceCaseEntry[] = [...executions].sort(bySeverity).map((execution) => ({
      caseId: execution.caseId,
      caseKey: execution.caseKey,
      verdict: execution.verdict,
      status: execution.status,
      reused: execution.reused,
      ...(execution.reuseReason?.startsWith("refresh:") ? { refreshReason: execution.reuseReason } : {}),
      ...(execution.reused && execution.reuseReason !== null ? { reuseReason: execution.reuseReason } : {}),
      aliasOfCaseId: execution.aliasOfCaseId,
      // Квитанция уровней reuse (P2-10) и эффективная политика случая (P0-3) — часть
      // доказательства, а не украшение отчёта: без них манифест не отвечает ни «что пересчитали»,
      // ни «каким порогом мерили».
      reuseReceipt: reuseReceiptOf(execution),
      ...(verdictPolicies.has(execution.caseId) ? { verdictPolicy: verdictPolicies.get(execution.caseId)! } : {}),
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
