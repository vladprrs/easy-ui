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
import {
  caseFingerprintsOf, readinessPolicyHashOf, verdictPolicyHashOf,
  type CaseFingerprints, type CaseSurface, type VerdictPolicySnapshot,
} from "./ids";
import { reevaluateGates, rewriteDerivedArtifacts, verdictRecomputeEnabled } from "./recompute";
import { suggestPolicy, suggestedPolicyEnabled } from "./suggest";
import { CaptureInfraError, type RunPhase } from "./gates/capture";
import { GATE_ORDER, IMPLEMENTED_GATES, RESUMABLE_GATES, phaseOfGate } from "./gates";
import { readinessBlocksVisual } from "./gates/readiness";
import { renderQualityKey } from "./gates/render";
import { rediffCase } from "./gates/visual";
import type { CandidateSubject, GateArtifactRef, GateContext, GateResult } from "./gates/types";
import { requiredGates, type AcceptancePolicy, type GateName } from "./policies";
import type {
  AcceptanceCaseResultRow, AcceptanceCaseRow, AcceptanceCaseStatus, AcceptanceCaseVerdict, AcceptanceRepo, TerminalRunStatus,
} from "./repo";

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
  /** Слои отпечатка (D-B): их же пишет `acceptance_cases` и квитанция reuse. */
  frameFingerprint?: string;
  comparisonFingerprint?: string;
  verdictPolicyHash?: string;
  status: AcceptanceCaseStatus;
  verdict: AcceptanceCaseVerdict | null;
  gates: GateResult[];
  severity: CaseSeverity | null;
  captureQuality: CaptureQualityRecord | null;
  artifacts: GateArtifactRef[];
  aliasOfCaseId: string | null;
  /** **Полный** reuse по `case_fingerprint` (или перенос baseline без дельты) — и только он. */
  reused: boolean;
  /** Кадр не снимался: он пришёл из CAS (полный reuse, recompute или re-diff). */
  frameReused?: boolean;
  /** Вердикт пересчитан по сохранённым метрикам под новой политикой. */
  verdictRecomputed?: boolean;
  /** Кадр пересравнён с новым эталоном без съёмки. */
  rediffed?: boolean;
  reuseReason: string | null;
  durationMs: number;
  /**
   * Причина инфраструктурного падения (BR-06). До волны здесь были только `outcome`/`message`, и
   * они **никуда не персистились** — после рестарта процесса причина исчезала вовсе. Теперь это
   * содержимое колонки `acceptance_cases.error_json` (v37): `attempts` отвечает «сколько раз
   * пробовали», `elapsedMs` — «сколько это стоило», `phase` — «на какой фазе шкалы».
   */
  error?: { outcome: string; message: string; attempts?: number; elapsedMs?: number; phase?: RunPhase };
}

/**
 * Результат гейта с его учётной обвязкой (BR-06): отпечаток и границы исполнения.
 *
 * Тип объявлен здесь, а не в `gates/types.ts`, намеренно: гейты этих полей не считают и знать о
 * них не обязаны — их пишет раннер вокруг вызова, как и `causes`/`suggestedPolicy`. Для
 * сериализации это те же `GateResult`, лежащие в `gates_json`.
 */
export interface GateEnvelope extends GateResult {
  /**
   * Отпечаток гейта: доказательство того, что завершённый результат относится к тем же входам.
   * Единственный ключ, по которому resume имеет право переиспользовать чужой (прежнего рана)
   * результат гейта — без него это был бы «молчаливый reuse», запрещённый §3 фидбэка.
   */
  fingerprint?: string;
  startedAt?: string;
  finishedAt?: string;
  /** Гейт переехал из рана-предка (resume): его id — часть квитанции продолжения. */
  reusedFromRunId?: string;
}

/** Версия алгоритма per-gate отпечатка: смена делает прежние гейты непереиспользуемыми. */
export const GATE_FINGERPRINT_ALGO_VERSION = 1;

/**
 * Отпечаток одного гейта случая (BR-06).
 *
 * Считается из **всех трёх слоёв** отпечатка случая, а не из «своего» слоя каждого гейта. Это
 * осознанно консервативно: точная привязка (`contract` зависит только от схемы и props) сделала бы
 * reuse шире, но потребовала бы объявлять слои per-gate — то есть завести вторую карту слоёв рядом
 * с `FIELD_LAYERS`, разъезд которых никто бы не заметил. Здесь цена промаха — лишнее исполнение
 * трёх дешёвых structural-гейтов, цена ложного попадания — переиспользованный вердикт по чужим
 * входам, поэтому асимметрия выбрана в пользу пересчёта.
 *
 * Живёт в раннере, **не** в `ids.ts`: это ключ reuse внутри `gates_json`, а не слой идентичности
 * случая, и в `FIELD_LAYERS` ему места нет.
 */
export function gateFingerprintOf(gate: GateName, fps: CaseFingerprints): string {
  return new Bun.CryptoHasher("sha256").update(canonicalStringify({
    v: GATE_FINGERPRINT_ALGO_VERSION,
    gate,
    frame: fps.frame,
    comparison: fps.comparison,
    verdictPolicy: fps.verdictPolicy,
  })).digest("hex");
}

/**
 * Завершённые гейты рана-предка, годные к переносу в продолжение (BR-06).
 *
 * Три условия, и все три обязательны: гейт из фазы `validate` (`RESUMABLE_GATES` — кадра он не
 * трогает), он **завершён** (`finishedAt`), и его отпечаток совпал с сегодняшним. Частично
 * исполненный случай отдаёт ровно свои завершённые structural-гейты; всё от `capture` и дальше
 * снимается заново — кадр прошлого рана мог не существовать вовсе.
 */
export function resumableGatesOf(stored: readonly GateResult[], fps: CaseFingerprints): Map<GateName, GateEnvelope> {
  const out = new Map<GateName, GateEnvelope>();
  for (const gate of stored) {
    const envelope = gate as GateEnvelope;
    if (!RESUMABLE_GATES.includes(gate.gate)) continue;
    if (typeof envelope.finishedAt !== "string") continue;
    if (envelope.fingerprint !== gateFingerprintOf(gate.gate, fps)) continue;
    out.set(gate.gate, envelope);
  }
  return out;
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

/**
 * Отпечатки случая — все четыре сразу (D-B, D7).
 *
 * Один вызов на обоих сторонах контракта: постановка (`createRun`) и раннер считают их **этой**
 * функцией, поэтому `case_fingerprint` строки рана и строки результата совпадают по построению, а
 * не по совпадению (тест на это есть). Политика приходит из `deps.policy` — эффективной политики
 * рана, а не из дефолтов: до этой волны strict-ран получал `DEFAULT_READINESS_POLICY_HASH` и
 * переиспользовал кадры, снятые по мягкой readiness.
 */
export function caseFingerprintsFor(
  deps: Pick<CaseRunnerDeps, "candidate" | "surface" | "policy">,
  item: AcceptanceCase,
): CaseFingerprints {
  return caseFingerprintsOf({
    candidateId: deps.candidate.candidateId,
    surface: deps.surface,
    policy: deps.policy,
    case: item,
  });
}

/** Итоговый отпечаток случая: ключ полного reuse и дедупа. */
export function fingerprintOf(
  deps: Pick<CaseRunnerDeps, "candidate" | "surface" | "policy">,
  item: AcceptanceCase,
): string {
  return caseFingerprintsFor(deps, item).case;
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

/**
 * Прогресс рана (D9). Контракт счётчиков — не косметика, он и был предметом P2-10 фидбэка
 * («`reused` двусмысленен»):
 *
 * - `reused` — **только полный** reuse по `case_fingerprint` (плюс перенос baseline без дельты):
 *   вердикт не пересчитывался вовсе;
 * - `frameReused` — кадр не снимался (надмножество `reused`: сюда входят recompute и re-diff);
 * - `verdictRecomputed` — вердикт пересчитан по сохранённым метрикам;
 * - `rediffed` — кадр пересравнён с новым эталоном без съёмки.
 *
 * Случай может считаться и в `verdictRecomputed`, и в `rediffed` (сменился и эталон, и порог) —
 * счётчики независимы и в сумме не обязаны давать `completed`.
 */
export interface RunProgress {
  total: number;
  completed: number;
  reused: number;
  frameReused: number;
  verdictRecomputed: number;
  rediffed: number;
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
    frameReused: executions.filter((item) => item.frameReused === true).length,
    verdictRecomputed: executions.filter((item) => item.verdictRecomputed === true).length,
    rediffed: executions.filter((item) => item.rediffed === true).length,
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
/**
 * Статистика маски для классификаторов, с одной поправкой (§W4-4).
 *
 * Матированный случай (`matteApplied`) сравнивается **над непрозрачным цветом**: альфа обеих
 * картинок после matte ≡ 255, поэтому «расхождение по альфе» в нём не событие, а невозможность.
 * Оставить `alphaDominantPct`/`semiTransparentPct` как есть значило бы позволить классификатору
 * `alpha-compositing` назвать причину, которой по построению нет. Обнуляем ровно эти две доли —
 * остальная статистика (`meanMaxDelta`/`stdMaxDelta`, вход `surface-tint`) остаётся честной, и
 * причина «залили другим цветом» на matte-кейсе по-прежнему называется.
 *
 * Правка живёт здесь, а не в `server/visual/causes.ts`: таксономия причин — не место для знания о
 * том, как готовился вход сравнения.
 */
function channelStatsForCauses(visualMetrics: Record<string, unknown>): CauseVisualMetrics["channelStats"] {
  if (!isObject(visualMetrics.channelStats)) return null;
  const stats = visualMetrics.channelStats as unknown as NonNullable<CauseVisualMetrics["channelStats"]>;
  if (typeof visualMetrics.matteApplied !== "string") return stats;
  return { ...stats, alphaDominantPct: 0, semiTransparentPct: 0 };
}

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
      // W4: остаток по edge-маске эталона — вход `text-raster-residual`. Гейт просит его у воркера
      // всегда (`options.edge`), но метрики доволновых строк его не несут: поле остаётся условным.
      ...(isObject(visualMetrics.edgeResidual)
        ? { edgeResidual: visualMetrics.edgeResidual as unknown as NonNullable<CauseVisualMetrics["edgeResidual"]> }
        : {}),
      channelStats: channelStatsForCauses(visualMetrics),
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
export function annotateCauses(
  gates: GateResult[],
  deviceScaleFactor: number,
  context?: { caseId: string; rendererFingerprint?: string | null },
): GateResult[] {
  const visual = gateOf(gates, "visual");
  if (!isDiagnosable(visual)) return gates;
  visual!.causes = classifyVisualCauses(causeInputOf(gates, deviceScaleFactor));
  // W7: предложение считается **после** причин и из них же — тот же слой диагностики поверх уже
  // вынесенного вердикта. Отсутствие предложения выражается отсутствием поля, а не `null`:
  // «предложения нет» и «предложение пустое» не должны различаться в сериализации.
  delete visual!.suggestedPolicy;
  if (context === undefined || !suggestedPolicyEnabled()) return gates;
  const suggestion = suggestPolicy(gates, context);
  if (suggestion !== null) visual!.suggestedPolicy = suggestion;
  return gates;
}

/** Контекст предложения (W7): случай и объявленный рендерер рана — оба входят в его evidence. */
const suggestContextOf = (deps: CaseRunnerDeps, caseId: string): { caseId: string; rendererFingerprint: string } => ({
  caseId,
  rendererFingerprint: rendererFingerprint(readinessPolicyHashOf(deps.policy.readiness)),
});

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

/** Разобранная строка кэша: гейты, качество съёмки и **физически существующие** артефакты (A4). */
interface CachedResult {
  row: AcceptanceCaseResultRow;
  gates: GateResult[];
  captureQuality: CaptureQualityRecord | null;
  artifacts: GateArtifactRef[];
}

async function loadCached(deps: CaseRunnerDeps, row: AcceptanceCaseResultRow): Promise<CachedResult | null> {
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
  return { row, gates: stored.gates, captureQuality: stored.captureQuality ?? null, artifacts };
}

/** Reuse: тот же отпечаток, тот же компонент и физически существующие артефакты (A4). */
async function reusableResult(deps: CaseRunnerDeps, fingerprint: string): Promise<{ verdict: AcceptanceCaseVerdict; stored: StoredResult } | null> {
  const row = deps.repo.caseResultForComponent(fingerprint, deps.candidate.componentId);
  if (!row) return null;
  const cached = await loadCached(deps, row);
  return cached ? { verdict: row.verdict as AcceptanceCaseVerdict, stored: { gates: cached.gates, captureQuality: cached.captureQuality } } : null;
}

/**
 * Снимок вердиктной политики строки кэша — **только валидный** (D0/D14).
 *
 * `verdict_policy_hash` здесь не украшение: снимок и хэш пишутся вместе, поэтому расхождение
 * означает либо ручную правку БД, либо смену алгоритма канонизации, — и в обоих случаях дельту
 * считать не по чему. `null` у вызывающего значит ровно одно: переснять.
 */
export function verdictPolicyOfRow(row: Pick<AcceptanceCaseResultRow, "verdict_policy_json" | "verdict_policy_hash">): VerdictPolicySnapshot | null {
  if (row.verdict_policy_json === null || row.verdict_policy_hash === null) return null;
  let snapshot: VerdictPolicySnapshot;
  try { snapshot = JSON.parse(row.verdict_policy_json) as VerdictPolicySnapshot; }
  catch { return null; }
  if (snapshot === null || typeof snapshot !== "object") return null;
  return verdictPolicyHashOf(snapshot) === row.verdict_policy_hash ? snapshot : null;
}

/** Скоуп форса (C1): «переоценить вердикт» и «переснять кадр» — разные по цене вещи. */
export type RefreshScope = "frame" | "verdict";

export interface ExecuteCaseOptions {
  /** Случай попал в выборку гейта `determinism` (план §4.2). */
  determinismSampled?: boolean;
  /**
   * Скоуп форса (C1). `undefined` — форса нет, работает полный каскад reuse.
   * `"verdict"` запрещает **полный** reuse (вердикт обязан быть переоценён), но кадр из CAS
   * переиспользовать разрешает — ровно это делает достижимым «recapture = 0» из фидбэка.
   * `"frame"` — безусловная пересъёмка.
   */
  scope?: RefreshScope | null;
  /**
   * Причина форса (`refresh:all|failed|cases`, A3): пишется в `reuse_reason` случая и в evidence —
   * иначе «снят заново» неотличим от «кэша не было», и стоимость рана нечем объяснить.
   */
  refreshReason?: string | null;
  /**
   * Завершённые гейты рана-предка (BR-06, resume): карта `gate → результат`, уже отфильтрованная
   * по фазе и отпечатку (`resumableGatesOf`). Такой гейт **не исполняется заново** — его результат
   * переезжает как есть, с пометкой `reusedFromRunId`.
   */
  resumeGates?: ReadonlyMap<GateName, GateEnvelope>;
  /**
   * Персист по ходу случая (BR-06). Вызывается после **группы** дешёвых structural-гейтов
   * (`contract`/`defaults`/`audit` — одной записью, group-commit) и затем после каждого дорогого
   * гейта. Двухрежимность здесь не украшение: три записи вместо одной на каждом из 64 случаев —
   * это трёхкратная write-амплификация ради данных, которые всё равно появляются за миллисекунды,
   * тогда как после капчура (десятки секунд) запись обязана быть немедленной — иначе рестарт
   * процесса снова теряет всё, ради чего заводился resume.
   */
  onGateProgress?: (gates: GateResult[], phase: RunPhase) => void;
}

/** Часть исполнения, которую отдаёт каскад reuse (остальное дописывает `executeCase`). */
type ReusedExecution = Pick<CaseExecution,
  "status" | "verdict" | "gates" | "severity" | "captureQuality" | "artifacts" | "reused"
  | "frameReused" | "verdictRecomputed" | "rediffed" | "reuseReason">;

interface CascadeOutcome {
  execution?: ReusedExecution;
  /** Причина пересъёмки, если каскад её выбрал осознанно (а не «кэша просто не было»). */
  recaptureReason?: string;
}

/** Кадр случая в строке кэша — вход re-diff (D10/D15). */
const paintArtifactOf = (artifacts: GateArtifactRef[]): GateArtifactRef | undefined =>
  artifacts.find((artifact) => artifact.name === "paint.png");

/**
 * Кадр, не прошедший readiness, визуального вердикта не получает **никогда** (инвариант D5) —
 * в том числе и на re-diff: сравнить с новым эталоном можно только кадр, про который доказано,
 * что он готов. Такой случай уходит в пересъёмку.
 */
function frameCarriesVisualVerdict(gates: GateResult[]): boolean {
  const readiness = gates.find((gate) => gate.gate === "readiness");
  if (readiness && readiness.status !== "pass" && readiness.status !== "skipped" && readiness.status !== "not-implemented") return false;
  return gates.every((gate) => gate.metrics?.skippedByReadiness !== true);
}

/**
 * Каскад reuse (D-B) — четыре пути, по месту первого промаха:
 *
 * 1. совпал `case_fingerprint` → **полный reuse**;
 * 2. совпали кадр и сравнение, разошёлся вердикт → **recompute** по сохранённым метрикам;
 * 3. совпал кадр → **re-diff**: новое сравнение того же кадра с новым эталоном, без chromium;
 * 4. иначе → **recapture**.
 *
 * Каждый шаг вниз честно дороже предыдущего и честно дешевле пересъёмки. Ни один из них не
 * переносит вердикт «на глаз»: отсутствие доказательства (снимка политики, кадра в CAS,
 * пересчитываемости гейта) — всегда пересъёмка, никогда stale-carry.
 *
 * Шаги **не** короткозамыкаются друг на друга (план 2026-08-06 §W4, W4-2): отказ пересчёта на
 * шаге 2 откладывает свою причину и пропускает случай на шаг 3 — «пересчитать нельзя» и «сравнить
 * заново нельзя» это разные утверждения, и первое из них не доказывает второго.
 */
async function attemptReuse(
  deps: CaseRunnerDeps,
  item: AcceptanceCase,
  fps: CaseFingerprints,
  scope: RefreshScope | null,
  determinismSampled: boolean,
): Promise<CascadeOutcome> {
  const componentId = deps.candidate.componentId;

  // 1. Полный reuse. Verdict-скоуп его запрещает: «переоценить» и «оставить как было» — не одно
  //    и то же (D4 — сохранение флейк-ретрая: пересчитывать нечего ⇒ снимаем заново).
  if (scope === null) {
    const reused = await reusableResult(deps, fps.case);
    if (reused) {
      deps.repo.touchCaseResult(fps.case);
      return {
        execution: {
          status: "done",
          verdict: reused.verdict,
          gates: reused.stored.gates,
          severity: severityOf(reused.stored.gates, deps.policy),
          captureQuality: reused.stored.captureQuality,
          artifacts: artifactsOf(reused.stored.gates),
          reused: true,
          frameReused: true,
          reuseReason: "case_fingerprint",
        },
      };
    }
  }

  if (!verdictRecomputeEnabled()) return {};

  /**
   * Причина пересъёмки, **отложенная** до исчерпания более дешёвых шагов (план 2026-08-06 §W4,
   * находки W4-1/W4-2). До волны отказ пересчёта на шаге 2 возвращался сразу — и кадр, который
   * шаг 3 законно пересравнил бы без chromium, уезжал в пересъёмку. Это било ровно по тем полям,
   * чей отказ **означает** «измерь заново» (`textAaBudget` без `edgeResidual` в старых метриках).
   */
  let deferredRecapture: string | null = null;

  // 2. Recompute: кадр и сравнение те же, политика другая.
  const comparisonRow = deps.repo.caseResultForFrameComparison(fps.frame, fps.comparison, componentId);
  if (comparisonRow && comparisonRow.case_fingerprint !== fps.case) {
    const oldPolicy = verdictPolicyOfRow(comparisonRow);
    // D0: снимка нет или он не про эту строку — дельта неизвестна. Переснять, не переносить.
    if (oldPolicy === null) return { recaptureReason: "recapture:policy_snapshot_missing" };
    const cached = await loadCached(deps, comparisonRow);
    if (cached) {
      const result = reevaluateGates(cached.gates, oldPolicy, fps.verdictPolicySnapshot);
      // Отказ пересчёта — не приговор кадру: сначала шаг 3 (re-diff того же кадра, где метрики
      // считаются заново), и только если он невозможен — эта причина становится пересъёмкой.
      if (!result.reevaluable) deferredRecapture = "recapture:policy_delta";
      else {
        // Verdict-скоуп без дельты — эскалация до пересъёмки (D4).
        if (scope === "verdict" && result.delta.length === 0) return { recaptureReason: "recapture:no_verdict_delta" };
        const gates = result.changed
          ? await rewriteDerivedArtifacts(deps.context.dataDir, result.gates, result.recomputedGates)
          : result.gates;
        return { execution: finishReused(deps, item, fps, gates, cached.captureQuality, { verdictRecomputed: true, reuseReason: "recompute:policy" }) };
      }
    }
  }

  /**
   * Выход из каскада без reuse. Своя причина шага 3 (она про сам кадр) сильнее отложенной причины
   * шага 2; отсутствие обеих — это «кэша просто не было», а не осознанная пересъёмка.
   */
  const giveUp = (reason?: string): CascadeOutcome =>
    reason !== undefined ? { recaptureReason: reason }
      : deferredRecapture !== null ? { recaptureReason: deferredRecapture }
        : {};

  // 3. Re-diff: кадр тот же, сравнение другое.
  const frameRow = deps.repo.caseResultForFrame(fps.frame, componentId);
  if (!frameRow || frameRow.case_fingerprint === fps.case) return giveUp();
  const oldPolicy = verdictPolicyOfRow(frameRow);
  if (oldPolicy === null) return giveUp("recapture:policy_snapshot_missing");
  const cached = await loadCached(deps, frameRow);
  if (!cached) return giveUp("recapture:frame_missing");
  const paint = paintArtifactOf(cached.artifacts);
  if (!paint || !(await artifactPresent(deps.context.dataDir, paint.sha256))) {
    return giveUp("recapture:frame_missing");
  }
  if (!frameCarriesVisualVerdict(cached.gates)) return giveUp("recapture:frame_not_ready");

  // Остальные гейты переезжают через ту же дельта-карту: сменившийся `expectedGeometry` — это и
  // comparison-промах (re-diff), и вердиктная дельта геометрии (пересчёт), и оба обязаны сойтись.
  const carried = reevaluateGates(cached.gates.filter((gate) => gate.gate !== "visual"), oldPolicy, fps.verdictPolicySnapshot);
  if (!carried.reevaluable) return giveUp("recapture:policy_delta");

  const ctx = gateContextOf(deps, item, determinismSampled);
  const visual = await rediffCase(ctx, paint.sha256);
  const gates = [...carried.gates, visual].sort((left, right) => GATE_ORDER.indexOf(left.gate) - GATE_ORDER.indexOf(right.gate));
  const rewritten = carried.changed
    ? await rewriteDerivedArtifacts(deps.context.dataDir, gates, carried.recomputedGates)
    : gates;
  return {
    execution: finishReused(deps, item, fps, rewritten, cached.captureQuality, {
      rediffed: true,
      ...(carried.changed ? { verdictRecomputed: true } : {}),
      reuseReason: "rediff:comparison",
    }),
  };
}

/**
 * Общий хвост recompute/re-diff: вердикт по новой политике, причины, запись результата под
 * **новым** `case_fingerprint`. Побочный эффект намеренный (тот же, что у переноса baseline):
 * следующий ран той же политики переиспользует случай уже обычным путём, за один lookup.
 */
function finishReused(
  deps: CaseRunnerDeps,
  item: AcceptanceCase,
  fps: CaseFingerprints,
  gates: GateResult[],
  captureQuality: CaptureQualityRecord | null,
  marks: { verdictRecomputed?: boolean; rediffed?: boolean; reuseReason: string },
): ReusedExecution {
  // Классификация причин относится к вердикту, а не к строке кэша: старые причины снимаются, новые
  // считаются от новых метрик (иначе прошедший после пересчёта случай унёс бы объяснение провала).
  // W7: предложение — производная причин, поэтому снимается ровно там же и пересчитывается тем же
  // вызовом: reused-строка обязана нести предложение, согласованное с **пересчитанными** причинами.
  for (const gate of gates) { delete gate.causes; delete gate.suggestedPolicy; }
  const verdict = caseVerdictOf(gates, deps.policy);
  annotateCauses(gates, deps.surface.dsf, suggestContextOf(deps, item.caseId));
  const stored: StoredResult = { gates, captureQuality };
  deps.repo.putCaseResult({
    caseFingerprint: fps.case,
    componentId: deps.candidate.componentId,
    artifacts: artifactsOf(gates),
    metrics: JSON.parse(canonicalStringify(stored)) as StoredResult,
    verdict,
    producedRunId: deps.runId,
    frameFingerprint: fps.frame,
    comparisonFingerprint: fps.comparison,
    verdictPolicyHash: fps.verdictPolicy,
    verdictPolicy: fps.verdictPolicySnapshot,
  });
  return {
    status: "done",
    verdict,
    gates,
    severity: severityOf(gates, deps.policy),
    captureQuality,
    artifacts: artifactsOf(gates),
    reused: false,
    frameReused: true,
    ...marks,
  };
}

/** Контекст гейтов случая — общий для съёмки и для re-diff. */
function gateContextOf(deps: CaseRunnerDeps, item: AcceptanceCase, determinismSampled: boolean): GateContext {
  return {
    ...deps.context,
    policy: deps.policy,
    runId: deps.runId,
    candidate: deps.candidate,
    case: item,
    surface: deps.surface,
    determinismSampled,
    shared: deps.shared,
  };
}

/**
 * Квитанция reuse случая (форма W8, пишется с W1): что именно переиспользовано и на каких
 * отпечатках. `reuseReason` остаётся производной сводкой — квитанция отвечает на вопрос «почему
 * ран стоил столько» полем за полем, а не одной строкой.
 */
export function reuseReceiptOf(execution: CaseExecution): Record<string, unknown> {
  return {
    reuse: {
      candidate: execution.frameReused === true,
      frame: execution.frameReused === true,
      readiness: execution.frameReused === true,
      geometry: execution.frameReused === true && execution.verdictRecomputed !== true,
      visualMetrics: execution.frameReused === true && execution.rediffed !== true,
      verdict: execution.reused,
    },
    fingerprints: {
      frame: execution.frameFingerprint ?? null,
      comparison: execution.comparisonFingerprint ?? null,
      verdictPolicy: execution.verdictPolicyHash ?? null,
      case: execution.caseFingerprint,
    },
    ...(execution.reuseReason === null ? {} : { reuseReason: execution.reuseReason }),
  };
}

/**
 * Прогоняет один случай: reuse → гейты по политике → вердикт → upsert результата.
 * Инфраструктурный провал, исчерпавший `maxInfraRetries`, даёт `status:"error"` **без вердикта** —
 * такой случай роняет ран в `error`, но только если ни один другой случай не дал `fail` (D10).
 */
export async function executeCase(deps: CaseRunnerDeps, item: AcceptanceCase, options: ExecuteCaseOptions = {}): Promise<CaseExecution> {
  const startedAt = deps.context.now();
  const fps = caseFingerprintsFor(deps, item);
  const base = {
    caseId: item.caseId, caseKey: item.caseKey, caseFingerprint: fps.case,
    frameFingerprint: fps.frame, comparisonFingerprint: fps.comparison, verdictPolicyHash: fps.verdictPolicy,
    aliasOfCaseId: item.aliasOfCaseId,
  };

  const scope = options.scope ?? null;
  const forcedReason = scope === null ? null : options.refreshReason ?? `refresh:${scope}`;

  // Frame-скоуп минует каскад целиком: пересъёмка — это и есть прямое указание автора.
  const cascade = scope === "frame" ? {} as CascadeOutcome : await attemptReuse(deps, item, fps, scope, options.determinismSampled === true);
  if (cascade.execution) {
    return { ...base, ...cascade.execution, durationMs: deps.context.now() - startedAt };
  }
  const refreshReason = forcedReason ?? cascade.recaptureReason ?? null;

  const ctx: GateContext = gateContextOf(deps, item, options.determinismSampled === true);
  const gates: GateResult[] = [];
  const modes = deps.policy.gates;
  const resumeGates = options.resumeGates;
  const iso = (): string => new Date(ctx.now()).toISOString();
  /**
   * Group-commit фазы `validate` (BR-06): три дешёвых гейта персистятся одной записью — она
   * ставится на границе фазы, а не после каждого из них. Дальше каждый гейт пишет сам за себя.
   */
  let validateCommitted = false;
  const commitProgress = (phase: RunPhase): void => {
    // Фаза `validate` своей записи не делает: её группа уезжает одним коммитом на границе фазы
    // (см. ниже, перед первым дорогим гейтом).
    if (phase !== "validate") options.onGateProgress?.(gates, phase);
  };
  for (const name of GATE_ORDER) {
    const gate = IMPLEMENTED_GATES[name];
    if (!gate || modes[name] === "not-implemented") continue;
    const phase = phaseOfGate(name);
    // Граница фазы `validate` → всё остальное: структурные гейты уезжают одной записью.
    if (phase !== "validate" && !validateCommitted && gates.length > 0) {
      validateCommitted = true;
      options.onGateProgress?.(gates, "validate");
    }
    const gateFingerprint = gateFingerprintOf(name, fps);
    // Resume (BR-06): завершённый structural-гейт предка с тем же отпечатком переезжает как есть.
    // Это единственный путь, которым результат чужого рана попадает в этот; он и есть ответ AC
    // «resume не переисполняет contract/defaults/audit без fingerprint change».
    const carried = resumeGates?.get(name);
    if (carried !== undefined) {
      gates.push({ ...carried, fingerprint: gateFingerprint } as GateResult);
      continue;
    }
    const gateStartedAt = iso();
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
        fingerprint: gateFingerprint, startedAt: gateStartedAt, finishedAt: iso(),
      } as GateResult);
      commitProgress(phase);
      continue;
    }
    try {
      const result = await gate.run(ctx);
      gates.push({ ...result, fingerprint: gateFingerprint, startedAt: gateStartedAt, finishedAt: iso() } as GateResult);
      commitProgress(phase);
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
          // BR-06: полная причина — она уезжает в `error_json` строки случая и переживает рестарт.
          error: {
            outcome: error.outcome, message: error.message,
            attempts: error.attempts, elapsedMs: ctx.now() - startedAt, phase: error.phase,
          },
        };
      }
      // Доменный отказ (невалидные props, вытесненный бандл) — продуктовый провал случая.
      gates.push({
        gate: name, status: "fail", detail: error instanceof Error ? error.message : String(error),
        fingerprint: gateFingerprint, startedAt: gateStartedAt, finishedAt: iso(),
      } as GateResult);
      commitProgress(phase);
    }
  }

  const verdict = caseVerdictOf(gates, deps.policy);
  // W5b: причины считаются **после** вердикта — и по построению, и по порядку вызова, чтобы
  // «классификация не влияет на pass/fail» держалось кодом, а не обещанием (§2/§10 плана).
  annotateCauses(gates, deps.surface.dsf, suggestContextOf(deps, item.caseId));
  const captureQuality =(deps.shared.get(renderQualityKey(item.caseId)) as CaptureQualityRecord | undefined) ?? null;
  const stored: StoredResult = { gates, captureQuality };
  deps.repo.putCaseResult({
    caseFingerprint: fps.case,
    componentId: deps.candidate.componentId,
    artifacts: artifactsOf(gates),
    metrics: JSON.parse(canonicalStringify(stored)) as StoredResult,
    verdict,
    producedRunId: deps.runId,
    frameFingerprint: fps.frame,
    comparisonFingerprint: fps.comparison,
    verdictPolicyHash: fps.verdictPolicy,
    verdictPolicy: fps.verdictPolicySnapshot,
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
/**
 * Снимок baseline-случая. `props_hash`/`slots_hash` — **входы кадра**, по которым идёт per-case
 * guard переноса (§A5a): импакт рассуждает только о кандидате (исходник/тема), а props и слот-пины
 * приходят из набора, и без явного сравнения перенос протащил бы вердикт чужого кадра.
 *
 * Оба поля объявлены необязательными (а не просто nullable) намеренно: у настоящей строки
 * `AcceptanceCaseRow` они есть всегда, но вызывающая сторона имеет право подставить «пустой»
 * снимок отсутствующего baseline-случая, не перечисляя входы кадра. Отсутствие читается как
 * `null` — то есть «неизвестно», и guard в этом случае честно отказывает в переносе.
 */
export type BaselineCaseSnapshot = Pick<AcceptanceCaseRow,
  "verdict" | "status" | "gates_json" | "capture_quality_json"
  | "frame_fingerprint" | "comparison_fingerprint" | "verdict_policy_hash">
  & { props_hash?: string | null; slots_hash?: string | null };

export interface CarryBaselineOptions {
  /**
   * Вердиктная политика **baseline-случая**, реконструированная из живого baseline-рана
   * (`policy_profile_id` + манифест его набора) и провалидированная по `verdict_policy_hash`
   * строки случая. `null` — реконструкция недоступна или хэш не сошёлся: перенос через границу
   * политики запрещён (D0/D14), случай снимается заново.
   */
  baselinePolicy?: VerdictPolicySnapshot | null;
}

export async function carryBaselineCase(
  deps: CaseRunnerDeps,
  item: AcceptanceCase,
  baseline: BaselineCaseSnapshot,
  basis: string,
  options: CarryBaselineOptions = {},
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

  const fps = caseFingerprintsFor(deps, item);
  const base = {
    caseId: item.caseId,
    caseKey: item.caseKey,
    caseFingerprint: fps.case,
    frameFingerprint: fps.frame,
    comparisonFingerprint: fps.comparison,
    verdictPolicyHash: fps.verdictPolicy,
    aliasOfCaseId: item.aliasOfCaseId,
    durationMs: 0,
  };

  // NULL-слой = «неизвестно» (D17): до-миграционная строка не доказывает ни сравнения, ни
  // политики, под которыми считался её вердикт. Такой случай снимается, а не переносится.
  if (baseline.frame_fingerprint === null || baseline.comparison_fingerprint === null || baseline.verdict_policy_hash === null) {
    return null;
  }
  // Per-case guard входов кадра (§A5a). Кадровый слой целиком сравнить нельзя (см. ниже), но его
  // **входы из набора** — props и разрешённые слот-пины — импакт не анализирует вовсе: он
  // рассуждает только о кандидате (исходник, ассеты, тема). Набор же между ранами меняется
  // независимо от кандидата: тот же `case_id` может прийти с другими props или с другой версией
  // ребёнка слота, и перенос молча выдал бы вердикт baseline за вердикт другого кадра, записав его
  // в кэш под новым отпечатком. Сравнение — с явным `?? null` с обеих сторон: в строке это NULL,
  // в случае — `undefined` (инвариант «отсутствует, а не пусто»). Guard пер-случайный: разошедшийся
  // случай уходит на честную съёмку, остальная семья набора переносится как прежде.
  const sameFrameInputs = (baseline.props_hash ?? null) === (item.propsHash ?? null)
    && (baseline.slots_hash ?? null) === (item.slotsHash ?? null);
  if (!sameFrameInputs) return null;
  // Кадровый слой здесь **намеренно не сравнивается**: он содержит `candidateId`, а перенос
  // существует ровно потому, что кандидат сменился (D6). Доказательством эквивалентности кадра
  // тут служит импакт-анализ («этот случай не мог измениться»), а не отпечаток; сравниваются
  // те слои, про которые импакт ничего не знает, — сравнение и вердиктная политика.
  const sameComparison = baseline.comparison_fingerprint === fps.comparison;
  const samePolicy = baseline.verdict_policy_hash === fps.verdictPolicy;

  // 1. Все три слоя совпали — перенос как есть (исторический путь W6).
  if (sameComparison && samePolicy) {
    const stored: StoredResult = { gates, captureQuality };
    deps.repo.putCaseResult({
      caseFingerprint: fps.case,
      componentId: deps.candidate.componentId,
      artifacts,
      metrics: JSON.parse(canonicalStringify(stored)) as StoredResult,
      verdict: baseline.verdict,
      producedRunId: deps.runId,
      frameFingerprint: fps.frame,
      comparisonFingerprint: fps.comparison,
      verdictPolicyHash: fps.verdictPolicy,
      verdictPolicy: fps.verdictPolicySnapshot,
    });
    return {
      ...base,
      status: "done",
      verdict: baseline.verdict,
      gates,
      severity: severityOf(gates, deps.policy),
      captureQuality,
      artifacts,
      reused: true,
      frameReused: true,
      reuseReason: `impact:${basis}`,
    };
  }

  if (!verdictRecomputeEnabled()) return null;
  // Дельта считается только по снимку политики baseline-рана; его нет — переснять (D0/D14).
  const oldPolicy = options.baselinePolicy ?? null;
  if (oldPolicy === null || verdictPolicyHashOf(oldPolicy) !== baseline.verdict_policy_hash) return null;

  // 2. Кадр и сравнение те же, политика другая — пересчёт по сохранённым метрикам.
  if (sameComparison) {
    const result = reevaluateGates(gates, oldPolicy, fps.verdictPolicySnapshot);
    if (!result.reevaluable) return null;
    const next = result.changed
      ? await rewriteDerivedArtifacts(deps.context.dataDir, result.gates, result.recomputedGates)
      : result.gates;
    return {
      ...base,
      ...finishReused(deps, item, fps, next, captureQuality, {
        verdictRecomputed: true,
        reuseReason: `impact:${basis}+recompute:policy`,
      }),
    };
  }

  // 3. Сменилось сравнение — re-diff кадра baseline с новым эталоном.
  const paint = paintArtifactOf(artifacts);
  if (!paint || !frameCarriesVisualVerdict(gates)) return null;
  const carried = reevaluateGates(gates.filter((gate) => gate.gate !== "visual"), oldPolicy, fps.verdictPolicySnapshot);
  if (!carried.reevaluable) return null;
  const ctx = gateContextOf(deps, item, false);
  const visual = await rediffCase(ctx, paint.sha256);
  const merged = [...carried.gates, visual].sort((left, right) => GATE_ORDER.indexOf(left.gate) - GATE_ORDER.indexOf(right.gate));
  const rewritten = carried.changed
    ? await rewriteDerivedArtifacts(deps.context.dataDir, merged, carried.recomputedGates)
    : merged;
  return {
    ...base,
    ...finishReused(deps, item, fps, rewritten, captureQuality, {
      rediffed: true,
      ...(carried.changed ? { verdictRecomputed: true } : {}),
      reuseReason: `impact:${basis}+rediff:comparison`,
    }),
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
