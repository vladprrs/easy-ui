/**
 * Исполнение одного случая приёмки и свёртка вердикта рана (план §3 D10/D11, §5 W1a).
 *
 * Раннер отвечает за три вещи и ни за что больше (очередь ранов, watchdog и терминализация —
 * в `orchestrator.ts`):
 *
 * 1. **Reuse (A3/D1).** Перед съёмкой считается `case_fingerprint`; если в `acceptance_case_results`
 *    есть строка с этим отпечатком, **тем же `component_id`** и физически существующими
 *    артефактами — вердикт переиспользуется. Проверка физического существования обязательна
 *    (триаж R1-B5): CAS мог быть вычищен, и «reuse» указывал бы в пустоту. Форс (`refresh`,
 *    режимы `all|failed|{caseIds}` — решение принимает оркестратор) снимает случай заново и
 *    записывает причину в `reuse_reason` (`refresh:<mode>`).
 * 2. **Гейты по политике.** Обязательные и advisory гейты профиля; `not-implemented` не считается.
 * 3. **Свёртка D10.** `fail` при `fail`/`indeterminate` обязательного гейта; `error` — только если
 *    нет ни одного `fail`; алиасы наследуют вердикт цели; `reused` эквивалентен свежему;
 *    `skipped` и `reused` не могут замаскировать `fail`.
 */
import { canonicalStringify } from "../../src/capture/canonicalJson";
import {
  classifyVisualCauses,
  type CauseGeometryFacts, type CauseInput, type CauseReadinessFacts, type CauseVisualMetrics, type VisualCause,
} from "../visual/causes";
import type { AcceptanceCase } from "./cases";
import { artifactPresent, readArtifact } from "./evidence";
import { rendererFingerprint } from "../capture/renderer";
import { caseFingerprintV0, readinessPolicyHashOf, type CaseSurface } from "./ids";
import { CaptureInfraError } from "./gates/capture";
import { GATE_ORDER, IMPLEMENTED_GATES } from "./gates";
import { readinessBlocksVisual } from "./gates/readiness";
import { renderQualityKey } from "./gates/render";
import type { CandidateSubject, GateArtifactRef, GateContext, GateResult } from "./gates/types";
import { requiredGates, type AcceptancePolicy, type GateName } from "./policies";
import type { AcceptanceCaseStatus, AcceptanceCaseVerdict, AcceptanceRepo, TerminalRunStatus } from "./repo";

export type SeverityClass = "structural" | "geometry" | "aa" | "raw" | "indeterminate";
export interface CaseSeverity { rank: number; class: SeverityClass; score: number }

export interface CaptureQualityRecord {
  captureClean: boolean;
  productErrors: string[];
  runtimeWarnings: string[];
  infraWarnings: string[];
}

export interface CaseExecution {
  caseId: string;
  caseKey: string;
  caseFingerprint: string;
  status: AcceptanceCaseStatus;
  verdict: AcceptanceCaseVerdict | null;
  gates: GateResult[];
  severity: CaseSeverity | null;
  captureQuality: CaptureQualityRecord | null;
  artifacts: GateArtifactRef[];
  aliasOfCaseId: string | null;
  reused: boolean;
  reuseReason: string | null;
  durationMs: number;
  error?: { outcome: string; message: string };
}

export interface CaseRunnerDeps {
  repo: AcceptanceRepo;
  policy: AcceptancePolicy;
  runId: string;
  candidate: CandidateSubject;
  surface: CaseSurface;
  /** Мемо на ран (аудит каталога, sha кадров) — общее для всех случаев. */
  shared: Map<string, unknown>;
  context: Omit<GateContext, "case" | "determinismSampled" | "shared" | "policy" | "runId" | "candidate" | "surface">;
}

/** Отпечаток случая (D1): единственный ключ reuse и дедупа. */
export function fingerprintOf(deps: Pick<CaseRunnerDeps, "candidate" | "surface">, item: AcceptanceCase): string {
  return caseFingerprintV0({
    candidateId: deps.candidate.candidateId,
    caseKey: item.caseKey,
    propsHash: item.propsHash,
    surface: deps.surface,
    // Case-set-путь (W2): эталон и per-case политика — входы вердикта, поэтому их смена обязана
    // инвалидировать reuse. Examples-путь оставляет заглушки `ids.ts`.
    referenceAssetId: item.referenceAssetId ?? null,
    ...(item.casePolicyHash === undefined ? {} : { casePolicyHash: item.casePolicyHash }),
  });
}

/**
 * Гейты, чей вердикт — **сравнение кадра** (с контуром, с самим собой, с эталоном). Ровно они
 * запрещены на не-ready кадре (D5); структурные гейты (`contract`/`defaults`/`audit`) кадра не
 * касаются и считаются как обычно.
 */
const COMPARING_GATES = new Set<GateName>(["geometry", "determinism", "visual"]);

const SEVERITY_RANK: Record<SeverityClass, number> = { structural: 0, geometry: 1, raw: 2, aa: 3, indeterminate: 4 };

/**
 * Класс провалившегося гейта. У `visual` (W5a) он вычисляется из метрик самого гейта: расхождение,
 * объяснимое сглаживанием, — это `aa` (легче по рангу), структурное — `raw`. Метрику кладёт гейт
 * (`severityClass`), а не раннер: только гейт знает, с каким бюджетом сравнивался случай.
 */
const classOfGate = (result: GateResult): SeverityClass => {
  if (result.status === "indeterminate") return "indeterminate";
  if (result.gate === "geometry") return "geometry";
  if (result.gate === "visual") return result.metrics?.severityClass === "aa" ? "aa" : "raw";
  return "structural";
};

/**
 * Severity падшего случая (D10): класс — от самого «структурного» провалившегося гейта, `rank` —
 * порядок сортировки в `GET /cases` и run-репорте, `score` — вес внутри класса (чем больше
 * провалившихся гейтов и продуктовых ошибок, тем выше).
 */
export function severityOf(gates: GateResult[], policy: AcceptancePolicy): CaseSeverity | null {
  const required = new Set(requiredGates(policy));
  const bad = gates.filter((gate) => required.has(gate.gate) && (gate.status === "fail" || gate.status === "indeterminate"));
  if (bad.length === 0) return null;
  let worst: SeverityClass = "indeterminate";
  for (const gate of bad) {
    const candidate = classOfGate(gate);
    if (SEVERITY_RANK[candidate] < SEVERITY_RANK[worst]) worst = candidate;
  }
  const productErrors = gates.reduce((sum, gate) => sum + ((gate.metrics?.productErrors as unknown[] | undefined)?.length ?? 0), 0);
  return { rank: SEVERITY_RANK[worst], class: worst, score: bad.length * 10 + productErrors };
}

/**
 * Вердикт случая из его гейтов. `skipped` — только когда обязательные гейты не дали ни одного
 * вердикта (например, весь набор advisory): маскировать им провал нельзя, поэтому `fail` и
 * `indeterminate` проверяются первыми.
 */
export function caseVerdictOf(gates: GateResult[], policy: AcceptancePolicy): AcceptanceCaseVerdict {
  const required = new Set(requiredGates(policy));
  const relevant = gates.filter((gate) => required.has(gate.gate));
  if (relevant.some((gate) => gate.status === "fail")) return "fail";
  if (relevant.some((gate) => gate.status === "indeterminate")) return "indeterminate";
  return relevant.some((gate) => gate.status === "pass") ? "pass" : "skipped";
}

/**
 * Свёртка вердикта рана (D10, полная):
 * - `fail` — хотя бы один случай `fail` **или `indeterminate`** по обязательному гейту;
 * - `error` — есть случай `error` (исчерпан `maxInfraRetries`) и нет ни одного `fail`;
 * - `pass_with_exceptions` — только при `allowExceptions` профиля (в фазе 1 выключено везде);
 * - `pass` — всё остальное.
 * `reused`/`skipped`/alias в свёртке не имеют привилегий: у алиаса вердикт цели, у reused —
 * вердикт, посчитанный в прошлый раз.
 */
export function foldRunVerdict(executions: CaseExecution[], policy: AcceptancePolicy): TerminalRunStatus {
  if (executions.some((item) => item.verdict === "fail" || item.verdict === "indeterminate")) return "fail";
  if (executions.some((item) => item.status === "error")) return "error";
  const exceptions = executions.flatMap((item) => item.gates.flatMap((gate) => gate.exceptions ?? []));
  if (exceptions.length > 0) return policy.allowExceptions ? "pass_with_exceptions" : "fail";
  return "pass";
}

export interface RunProgress {
  total: number;
  completed: number;
  reused: number;
  failed: number;
  running: number;
  eta: { secondsRemaining: number; basis: "measured" | "estimate" };
}

/** Оценка на входе (план §4): 4–8 с на случай до объединения сессий W3. */
export const ESTIMATED_CASE_MS = 6_000;

export function progressOf(executions: CaseExecution[], total: number, emaMs: number | null, running = 0): RunProgress {
  const completed = executions.length;
  const remaining = Math.max(total - completed - running, 0);
  const perCase = emaMs ?? ESTIMATED_CASE_MS;
  return {
    total,
    completed,
    reused: executions.filter((item) => item.reused).length,
    failed: executions.filter((item) => item.verdict === "fail" || item.verdict === "indeterminate" || item.status === "error").length,
    running,
    eta: {
      secondsRemaining: Math.round((remaining * perCase) / 1000),
      basis: emaMs === null ? "estimate" : "measured",
    },
  };
}

interface StoredResult {
  gates: GateResult[];
  captureQuality: CaptureQualityRecord | null;
}

// ------------------------------------------------- таксономия причин (W5b)

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const gateOf = (gates: GateResult[], name: GateName): GateResult | undefined =>
  gates.find((gate) => gate.gate === name);

/** Визуальный исход, который вообще подлежит объяснению: вердикт не выдан либо выдан провальный. */
const isDiagnosable = (gate: GateResult | undefined): boolean =>
  gate !== undefined && (gate.status === "fail" || gate.status === "indeterminate");

/**
 * Вход классификаторов, собранный из метрик уже посчитанных гейтов случая. Ничего не читает с
 * диска: `visual` (W5a) кладёт полный набор метрик расхождения, `geometry` v2 (W3) — контуры и
 * источники эффектов, `readiness` (W4) — доказательство готовности кадра. Отдельного чтения
 * `diff.png` из CAS не требуется: статистика маски (`channelStats`) приходит из того же
 * подпроцесса, который маску и построил.
 */
export function causeInputOf(gates: GateResult[], deviceScaleFactor: number): CauseInput {
  const visualMetrics = gateOf(gates, "visual")?.metrics ?? {};
  const geometryMetrics = gateOf(gates, "geometry")?.metrics ?? {};
  const readinessMetrics = gateOf(gates, "readiness")?.metrics ?? {};

  const visual: CauseVisualMetrics | null = typeof visualMetrics.rawDiffPct === "number"
    ? {
      rawDiffPct: visualMetrics.rawDiffPct,
      aaDiffPct: typeof visualMetrics.aaDiffPct === "number" ? visualMetrics.aaDiffPct : 0,
      maxChannelDelta: typeof visualMetrics.maxChannelDelta === "number" ? visualMetrics.maxChannelDelta : 0,
      regions: Array.isArray(visualMetrics.regions) ? visualMetrics.regions as CauseVisualMetrics["regions"] : [],
      totalRegions: typeof visualMetrics.totalRegions === "number" ? visualMetrics.totalRegions : 0,
      bestOffset: isObject(visualMetrics.bestOffset)
        ? visualMetrics.bestOffset as unknown as CauseVisualMetrics["bestOffset"]
        : { dx: 0, dy: 0, residualPct: 0 },
      canvas: isObject(visualMetrics.canvas) ? visualMetrics.canvas as unknown as { width: number; height: number } : null,
      channelStats: isObject(visualMetrics.channelStats)
        ? visualMetrics.channelStats as unknown as NonNullable<CauseVisualMetrics["channelStats"]>
        : null,
    }
    : null;

  const geometry: CauseGeometryFacts = {
    layoutBounds: isObject(geometryMetrics.layoutBounds) ? geometryMetrics.layoutBounds as unknown as CauseGeometryFacts["layoutBounds"] : null,
    paintBounds: isObject(geometryMetrics.paintBounds) ? geometryMetrics.paintBounds as unknown as CauseGeometryFacts["paintBounds"] : null,
    effectSources: Array.isArray(geometryMetrics.effectSources)
      ? geometryMetrics.effectSources as NonNullable<CauseGeometryFacts["effectSources"]>
      : [],
  };

  const readiness: CauseReadinessFacts = {
    images: isObject(readinessMetrics.images) ? readinessMetrics.images as CauseReadinessFacts["images"] : null,
    pendingRequests: Array.isArray(readinessMetrics.pendingRequests) ? readinessMetrics.pendingRequests as string[] : [],
  };

  return {
    visual,
    geometry,
    readiness,
    deviceScaleFactor,
    visualReason: typeof visualMetrics.reason === "string" ? visualMetrics.reason : null,
  };
}

/**
 * Дописывает классифицированные причины в результат визуального гейта случая (W5b).
 *
 * **Мутация ограничена полем `causes`**: статусы гейтов уже посчитаны, и свёртка вердикта (D10)
 * их больше не пересматривает — классификация не может ни уронить, ни спасти случай. Вызывается
 * только для `fail`/`indeterminate` визуального исхода: у прошедшего случая объяснять нечего.
 */
export function annotateCauses(gates: GateResult[], deviceScaleFactor: number): GateResult[] {
  const visual = gateOf(gates, "visual");
  if (!isDiagnosable(visual)) return gates;
  visual!.causes = classifyVisualCauses(causeInputOf(gates, deviceScaleFactor));
  return gates;
}

/** Причины случая для отчётов (run-репорт, `GET /cases`): их несёт визуальный гейт. */
export const causesOfGates = (gates: GateResult[]): VisualCause[] => gateOf(gates, "visual")?.causes ?? [];

const artifactsOf = (gates: GateResult[]): GateArtifactRef[] => gates.flatMap((gate) => gate.artifacts ?? []);

/**
 * Сверка рендерера переиспользуемого случая с рендерером **этого** процесса (R6, T-m20).
 *
 * Зачем она нужна, если `rendererFingerprint` и так входит в `case_fingerprint` (R1): отпечаток —
 * ключ **lookup'а**, то есть утверждение о том, каким рендерером случай *должен* был сниматься.
 * Эта проверка смотрит на доказательство — receipt артефакта — и отвечает, каким он снят на самом
 * деле. Расхождение возможно при откате образа на БД, где кэш уже писался новым рендерером.
 *
 * Отсутствие `receipt.json` среди артефактов **не** отменяет reuse: receipt'ы могли быть выключены
 * kill-switch'ем (R5), а вытесненный `gcEvidence`-ом артефакт уже отсечён проверкой
 * `artifactPresent` выше. Итог сверки — «переснять», а не «уронить ран» (T-m20).
 */
export async function reusableRendererMatches(deps: CaseRunnerDeps, artifacts: GateArtifactRef[]): Promise<boolean> {
  const ref = artifacts.find((artifact) => artifact.name === "receipt.json");
  if (!ref) return true;
  const bytes = await readArtifact(deps.context.dataDir, ref.sha256);
  if (bytes === null) return false;
  try {
    const receipt = JSON.parse(new TextDecoder().decode(bytes)) as { renderer?: { fingerprint?: unknown } };
    const stored = receipt.renderer?.fingerprint;
    if (typeof stored !== "string") return true;
    return stored === rendererFingerprint(readinessPolicyHashOf(deps.policy.readiness));
  } catch { return false; }
}

/** Reuse: тот же отпечаток, тот же компонент и **физически существующие** артефакты (A4). */
async function reusableResult(deps: CaseRunnerDeps, fingerprint: string): Promise<{ verdict: AcceptanceCaseVerdict; stored: StoredResult } | null> {
  const row = deps.repo.caseResultForComponent(fingerprint, deps.candidate.componentId);
  if (!row) return null;
  let artifacts: GateArtifactRef[];
  let stored: StoredResult;
  try {
    artifacts = JSON.parse(row.artifacts_json) as GateArtifactRef[];
    stored = JSON.parse(row.metrics_json) as StoredResult;
  } catch { return null; }
  if (!Array.isArray(artifacts) || !Array.isArray(stored?.gates)) return null;
  for (const artifact of artifacts) {
    if (!(await artifactPresent(deps.context.dataDir, artifact.sha256))) return null;
  }
  if (!(await reusableRendererMatches(deps, artifacts))) return null;
  return { verdict: row.verdict as AcceptanceCaseVerdict, stored };
}

export interface ExecuteCaseOptions {
  /** Случай попал в выборку гейта `determinism` (план §4.2). */
  determinismSampled?: boolean;
  /** `refresh` (A3): пересъёмка даже при годном кэше. */
  refresh?: boolean;
  /**
   * Причина форса (`refresh:all|failed|cases`, A3): пишется в `reuse_reason` случая и в evidence —
   * иначе «снят заново» неотличим от «кэша не было», и стоимость рана нечем объяснить.
   */
  refreshReason?: string | null;
}

/**
 * Прогоняет один случай: reuse → гейты по политике → вердикт → upsert результата.
 * Инфраструктурный провал, исчерпавший `maxInfraRetries`, даёт `status:"error"` **без вердикта** —
 * такой случай роняет ран в `error`, но только если ни один другой случай не дал `fail` (D10).
 */
export async function executeCase(deps: CaseRunnerDeps, item: AcceptanceCase, options: ExecuteCaseOptions = {}): Promise<CaseExecution> {
  const startedAt = deps.context.now();
  const fingerprint = fingerprintOf(deps, item);
  const base = {
    caseId: item.caseId, caseKey: item.caseKey, caseFingerprint: fingerprint,
    aliasOfCaseId: item.aliasOfCaseId,
  };

  const refreshReason = options.refresh === true ? options.refreshReason ?? "refresh" : null;

  if (options.refresh !== true) {
    const reused = await reusableResult(deps, fingerprint);
    if (reused) {
      deps.repo.touchCaseResult(fingerprint);
      return {
        ...base,
        status: "done",
        verdict: reused.verdict,
        gates: reused.stored.gates,
        severity: severityOf(reused.stored.gates, deps.policy),
        captureQuality: reused.stored.captureQuality,
        artifacts: artifactsOf(reused.stored.gates),
        reused: true,
        reuseReason: "case_fingerprint",
        durationMs: deps.context.now() - startedAt,
      };
    }
  }

  const ctx: GateContext = {
    ...deps.context,
    policy: deps.policy,
    runId: deps.runId,
    candidate: deps.candidate,
    case: item,
    surface: deps.surface,
    determinismSampled: options.determinismSampled === true,
    shared: deps.shared,
  };
  const gates: GateResult[] = [];
  const modes = deps.policy.gates;
  for (const name of GATE_ORDER) {
    const gate = IMPLEMENTED_GATES[name];
    if (!gate || modes[name] === "not-implemented") continue;
    // **Инвариант D5**: кадр, не прошедший readiness, не получает визуального вердикта. Сравнения
    // (геометрия, детерминизм, визуал W5a) не считаются вовсе — их результат относился бы к
    // кадру, снятому до готовности шрифтов/ассетов, и обвинял бы компонент за чужой дефект.
    // Это `indeterminate`, а не `fail`: вердикт не выдан, диагностика названа (D10 всё равно не
    // даст такому случаю `pass`, а сам `fail` уже пришёл от гейта `readiness`).
    if (COMPARING_GATES.has(name) && readinessBlocksVisual(ctx)) {
      gates.push({
        gate: name, status: "indeterminate",
        detail: "Skipped: capture readiness was not met, so the frame gets no visual verdict (D5)",
        metrics: { skippedByReadiness: true },
      });
      continue;
    }
    try {
      gates.push(await gate.run(ctx));
    } catch (error) {
      if (error instanceof CaptureInfraError) {
        // Инфраструктура: бюджет ретраев исчерпан внутри `captureCase`. Случай — `error`,
        // не `fail`: продуктовый вердикт не выдан.
        return {
          ...base,
          status: "error",
          verdict: null,
          gates,
          severity: null,
          captureQuality: (deps.shared.get(renderQualityKey(item.caseId)) as CaptureQualityRecord | undefined) ?? null,
          artifacts: artifactsOf(gates),
          reused: false,
          reuseReason: refreshReason,
          durationMs: ctx.now() - startedAt,
          error: { outcome: error.outcome, message: error.message },
        };
      }
      // Доменный отказ (невалидные props, вытесненный бандл) — продуктовый провал случая.
      gates.push({ gate: name, status: "fail", detail: error instanceof Error ? error.message : String(error) });
    }
  }

  const verdict = caseVerdictOf(gates, deps.policy);
  // W5b: причины считаются **после** вердикта — и по построению, и по порядку вызова, чтобы
  // «классификация не влияет на pass/fail» держалось кодом, а не обещанием (§2/§10 плана).
  annotateCauses(gates, deps.surface.dsf);
  const captureQuality =(deps.shared.get(renderQualityKey(item.caseId)) as CaptureQualityRecord | undefined) ?? null;
  const stored: StoredResult = { gates, captureQuality };
  deps.repo.putCaseResult({
    caseFingerprint: fingerprint,
    componentId: deps.candidate.componentId,
    artifacts: artifactsOf(gates),
    metrics: JSON.parse(canonicalStringify(stored)) as StoredResult,
    verdict,
    producedRunId: deps.runId,
  });
  return {
    ...base,
    status: "done",
    verdict,
    gates,
    severity: severityOf(gates, deps.policy),
    captureQuality,
    artifacts: artifactsOf(gates),
    reused: false,
    reuseReason: refreshReason,
    durationMs: ctx.now() - startedAt,
  };
}

/**
 * Перенос вердикта baseline-случая в частичный ран (W6, D6).
 *
 * Почему не обычный reuse: `case_fingerprint` содержит `candidateId` (D1), а у нового кандидата он
 * другой — строка кэша по новому отпечатку попросту не существует, и `reusableResult` честно
 * промахивается. Импакт даёт **другое** доказательство: «этот случай не мог измениться», — и оно
 * позволяет записать вердикт baseline под новым отпечатком.
 *
 * Три условия, без которых перенос не делается (возвращается `null`, случай снимается как обычно):
 * 1. baseline-случай завершён с вердиктом (не `error`, не `pending`);
 * 2. его гейты читаются;
 * 3. **все** его артефакты физически есть в CAS — ровно та же проверка, что у обычного reuse
 *    (R1-B5): иначе evidence нового рана указывал бы в пустоту.
 *
 * Побочный эффект намеренный: результат upsert'ится в `acceptance_case_results` под **новым**
 * отпечатком, поэтому следующий ран того же кандидата переиспользует его уже обычным путём, без
 * импакта. Артефакты при этом не осиротеют — union-refcount GC (`artifactStillReferenced`) видит
 * и строки `acceptance_cases` нового рана, и строку кэша.
 */
export async function carryBaselineCase(
  deps: CaseRunnerDeps,
  item: AcceptanceCase,
  baseline: { verdict: AcceptanceCaseVerdict | null; status: AcceptanceCaseStatus; gates_json: string | null; capture_quality_json: string | null },
  basis: string,
): Promise<CaseExecution | null> {
  if (baseline.verdict === null || baseline.status !== "done") return null;
  let gates: GateResult[];
  try { gates = JSON.parse(baseline.gates_json ?? "null") as GateResult[]; }
  catch { return null; }
  if (!Array.isArray(gates)) return null;
  const artifacts = artifactsOf(gates);
  for (const artifact of artifacts) {
    if (!(await artifactPresent(deps.context.dataDir, artifact.sha256))) return null;
  }
  let captureQuality: CaptureQualityRecord | null = null;
  try { captureQuality = JSON.parse(baseline.capture_quality_json ?? "null") as CaptureQualityRecord | null; }
  catch { captureQuality = null; }

  const fingerprint = fingerprintOf(deps, item);
  const stored: StoredResult = { gates, captureQuality };
  deps.repo.putCaseResult({
    caseFingerprint: fingerprint,
    componentId: deps.candidate.componentId,
    artifacts,
    metrics: JSON.parse(canonicalStringify(stored)) as StoredResult,
    verdict: baseline.verdict,
    producedRunId: deps.runId,
  });
  return {
    caseId: item.caseId,
    caseKey: item.caseKey,
    caseFingerprint: fingerprint,
    aliasOfCaseId: item.aliasOfCaseId,
    status: "done",
    verdict: baseline.verdict,
    gates,
    severity: severityOf(gates, deps.policy),
    captureQuality,
    artifacts,
    reused: true,
    reuseReason: `impact:${basis}`,
    durationMs: 0,
  };
}

/** Сортировка случаев для репорта: сначала самые тяжёлые провалы (D10). */
export function bySeverity(left: CaseExecution, right: CaseExecution): number {
  const leftRank = left.severity?.rank ?? Number.MAX_SAFE_INTEGER;
  const rightRank = right.severity?.rank ?? Number.MAX_SAFE_INTEGER;
  if (leftRank !== rightRank) return leftRank - rightRank;
  const leftScore = left.severity?.score ?? 0;
  const rightScore = right.severity?.score ?? 0;
  if (leftScore !== rightScore) return rightScore - leftScore;
  return left.caseId < right.caseId ? -1 : left.caseId > right.caseId ? 1 : 0;
}
