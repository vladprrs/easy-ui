import type { Database } from "bun:sqlite";
import { ApiError } from "../http";
import type { ScreenshotService } from "../screenshot/service";
import type { CaptureExpected } from "../../src/capture/protocol";
import {
  spawnDiffWorker, spawnSignalsDiffWorker,
  type RunDiff, type RunSignalsDiff, type SignalsDiffIndeterminate, type SignalsDiffMeasured,
} from "./diff-runner";
import { parseFingerprint, type Fingerprint } from "./fingerprint";
import {
  parseReferenceRenderer, rendererRecordFromReceipt, VisualRepo,
  type CandidateMeta, type MetricResult, type ReferenceRendererRecord, type RendererGuardRecord,
  type RunClass, type RunOutcomeCode, type RunReport, type RunSignals, type VisualReferenceRow, type VisualRunRow,
} from "./repo";
import { CAUSE_THRESHOLDS, classifyVisualCauses } from "./causes";
import { rendererDeclaration, rendererFlagsEnabled } from "../capture/renderer";
import { readReceipt } from "../capture/receiptStore";
import { sanitizeEvidenceName } from "../acceptance/evidence";
import { evidenceMaxBytes } from "../acceptance/policies";

export interface VisualServiceDeps {
  db: Database;
  dataDir: string;
  screenshots?: ScreenshotService;
  runDiff?: RunDiff;
  /** R7a: воркер в режиме `signals`. Используется только при `EASYUI_VISUAL_SIGNALS_V2=1`. */
  runSignalsDiff?: RunSignalsDiff;
  now?: () => number;
}

/** Per-pixel color tolerance for pixelmatch-v1 (options recorded on every run). */
const PIXELMATCH_THRESHOLD = 0.1;
const RUN_TTL_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 25;
const CHECK_DEADLINE_MS = 90_000;

/**
 * Аварийный kill-switch guard'а (§5 R6). Выключенный guard **не** делает вид, что рендереры
 * совпали: он записывает `state:"disabled"` и не влияет на вердикт.
 */
export const rendererGuardDisabled = (): boolean => process.env.EASYUI_RENDERER_GUARD_DISABLED === "1";

/**
 * Эпоха рендерера (N11). По умолчанию — `rendererVersion` объявления; `EASYUI_RENDERER_EPOCH` —
 * **только** override для нештатных случаев, поэтому забытая переменная не может уронить прод.
 * Осмыслена только вместе с `EASYUI_RENDERER_FLAGS=1` (self-check пишет warning на старте).
 */
export const currentRendererEpoch = (): string =>
  (process.env.EASYUI_RENDERER_EPOCH || rendererDeclaration().rendererVersion);

/**
 * Снапшот флагов, взятый на `beginCheck` (N11): ран, стартовавший до флипа флага, доигрывается по
 * старой семантике. Иначе включение флагов на середине рана меняло бы правила его судейства.
 */
export interface RendererGuardFlags { rendererFlags: boolean; epoch: string; disabled: boolean }
export const rendererGuardFlags = (): RendererGuardFlags =>
  ({ rendererFlags: rendererFlagsEnabled(), epoch: currentRendererEpoch(), disabled: rendererGuardDisabled() });

/**
 * Разделение метрик (§3 **E6**, §5 **R7a**) — opt-in. Выключенный флаг даёт доволновое поведение
 * буквально: тот же `compare`-режим воркера, тот же вердикт по проценту pixelmatch, `class`/
 * `signals` в отчёте — `null`.
 */
export const visualSignalsV2Enabled = (): boolean => process.env.EASYUI_VISUAL_SIGNALS_V2 === "1";

/** Снапшот всех флагов рана, взятый на `beginCheck` (N11) — включая R7a. */
export interface VisualRunFlags extends RendererGuardFlags { signalsV2: boolean }
export const visualRunFlags = (): VisualRunFlags => ({ ...rendererGuardFlags(), signalsV2: visualSignalsV2Enabled() });

/** Вердикт E6: статус, класс, типизированный исход и сигналы, из которых всё это получено. */
export interface SignalsVerdict {
  status: VisualRunRow["status"];
  runClass: RunClass;
  outcomeCode: RunOutcomeCode | null;
  signals: RunSignals;
}

/**
 * Вердикт визуального рана из четырёх сигналов (**E6**). Чистая функция: вход — то, что измерил
 * воркер, выход — статус и его объяснение. Порядок решений и причина каждого:
 *
 * 1. **`irreconcilable` → `indeterminate`.** Кадры несводимы даже нормализацией; процент здесь
 *    был бы мерой разного холста, а не разницы. Типизированный исход `dimensions_irreconcilable`
 *    делает диагноз выводимым из ответа («эталон снят в другом масштабе»), а не из догадок.
 * 2. **`exact = 0` → `pass, identical`.** Ни одного отличающегося байта — сравнивать нечего.
 * 3. **`exact > 0` ∧ перцептивная метрика в бюджете ∧ доля остатка внутри edge-маски ≥ T →
 *    `pass, renderer_residual`.** Остаток лежит на контурах самого эталона: так выглядит другой
 *    растеризатор, а не другой продукт. Оба условия обязательны: без бюджета «растровым» стал бы
 *    любой сдвиг на 1 px (факт калибровки: плашка, сдвинутая на 1 px, даёт 100 % остатка внутри
 *    маски — её ловит именно перцептивный порог).
 * 4. **иначе `fail, regression`** с названными причинами (`causes.ts`). Сюда попадает и случай,
 *    который доволновая семантика пропускала: перцептивная метрика в бюджете, но остаток лежит
 *    **вне** контуров (факт калибровки: смена заливки половины холста даёт 0 % по pixelmatch и
 *    52 % по exact-rgba). Это и есть смысл волны — и ровно поэтому она opt-in.
 */
export function evaluateSignalsVerdict(
  diff: SignalsDiffMeasured | SignalsDiffIndeterminate,
  passThreshold: number,
  deviceScaleFactor: number,
): SignalsVerdict {
  const thresholds = { passPct: passThreshold, edgeInsidePct: CAUSE_THRESHOLDS.edgeResidualInsidePct };
  if (diff.indeterminate) {
    return {
      status: "error", runClass: "indeterminate", outcomeCode: "dimensions_irreconcilable",
      signals: { dims: "irreconcilable", exact: null, perceptual: null, edgeResidual: null, thresholds, reason: diff.reason },
    };
  }
  const exact: MetricResult = {
    diffPixels: diff.exact.diffPixels, totalPixels: diff.exact.totalPixels,
    diffPercent: diff.exact.totalPixels ? (diff.exact.diffPixels / diff.exact.totalPixels) * 100 : 0,
  };
  const perceptual: MetricResult = {
    diffPixels: diff.pixelmatch.diffPixels, totalPixels: diff.pixelmatch.totalPixels,
    diffPercent: diff.pixelmatch.totalPixels ? (diff.pixelmatch.diffPixels / diff.pixelmatch.totalPixels) * 100 : 0,
  };
  const base = { dims: diff.dims, exact, perceptual, edgeResidual: diff.edgeResidual, thresholds };

  if (exact.diffPixels === 0) return { status: "pass", runClass: "identical", outcomeCode: null, signals: base };

  const insidePct = diff.edgeResidual.insidePct;
  if (perceptual.diffPercent <= passThreshold && insidePct !== null && insidePct >= thresholds.edgeInsidePct) {
    return { status: "pass", runClass: "renderer_residual", outcomeCode: null, signals: base };
  }

  const causes = classifyVisualCauses({
    visual: {
      rawDiffPct: diff.metrics.rawDiffPct,
      aaDiffPct: diff.metrics.aaDiffPct,
      maxChannelDelta: diff.metrics.maxChannelDelta,
      regions: diff.metrics.regions,
      totalRegions: diff.metrics.totalRegions,
      bestOffset: diff.metrics.bestOffset,
      canvas: diff.canvas,
      channelStats: diff.metrics.channelStats ?? null,
      edgeResidual: diff.edgeResidual,
    },
    deviceScaleFactor,
  });
  return { status: "fail", runClass: "regression", outcomeCode: null, signals: { ...base, causes } };
}

/** Сторона сравнения: рендерер, которым нарисован кадр (эталона или кандидата). */
export type GuardSide = Pick<ReferenceRendererRecord, "fingerprint" | "fontManifestHash" | "readinessPolicyHash" | "epoch"> | null;

export interface RendererGuardVerdict {
  record: RendererGuardRecord;
  /** Терминальный код — или `null`, если ран судится метриками как раньше. */
  outcomeCode: RunOutcomeCode | null;
  warnings: string[];
}

/**
 * Cross-renderer guard (§3 **E5**, §5 **R6**). Живёт между кадром кандидата и `runDiff` —
 * `beginCheck` синхронный и кадром не располагает (C-B2).
 *
 * Три состояния и ровно одна причина у каждого:
 * - `mismatch` — обе стороны известны и разошлись. Сравнивать такие кадры нельзя: процент был бы
 *   мерой разницы рендереров, а не регрессии. `status='error'`, `outcome_code='renderer_mismatch'`,
 *   `differing[]` — чтобы ремедиация («переснять эталон») была выводима из ответа, а не из догадок;
 * - `unknown` — происхождение эталона (или кандидата) неизвестно. **До** включения
 *   детерминизм-флагов это advisory `renderer_unknown`: вердикт выносится по метрикам ровно как до
 *   волны (нулевой регресс на легаси-эталонах). При `EASYUI_RENDERER_FLAGS=1` — `stale_renderer`:
 *   новые пиксели против эталона неизвестного происхождения дали бы массовый ложный fail по
 *   проценту, а не честное «переснимите» (N11);
 * - `matched` — сравнение легитимно.
 *
 * Приоритет кодов (N11): разошлись и отпечаток, и эпоха ⇒ `renderer_mismatch` (более специфичный).
 */
export function evaluateRendererGuard(reference: GuardSide, candidate: GuardSide, flags: RendererGuardFlags): RendererGuardVerdict {
  const side = (value: GuardSide): RendererGuardRecord["reference"] => ({
    fingerprint: value?.fingerprint ?? null,
    fontManifestHash: value?.fontManifestHash ?? null,
    readinessPolicyHash: value?.readinessPolicyHash ?? null,
    epoch: value?.epoch ?? null,
  });
  const base = { reference: side(reference), candidate: side(candidate), flags: { rendererFlags: flags.rendererFlags, epoch: flags.rendererFlags ? flags.epoch : null } };
  if (flags.disabled) return { record: { state: "disabled", differing: [], ...base }, outcomeCode: null, warnings: [] };

  if (reference === null || candidate === null) {
    // Неизвестно ≠ совпало: до флагов — предупреждение, после — отказ сравнивать.
    return flags.rendererFlags
      ? { record: { state: "unknown", differing: [], ...base }, outcomeCode: "stale_renderer", warnings: [] }
      : { record: { state: "unknown", differing: [], ...base }, outcomeCode: null, warnings: ["renderer_unknown"] };
  }

  const differing: string[] = [];
  if (reference.fingerprint !== candidate.fingerprint) differing.push("rendererFingerprint");
  // `null` с любой стороны — «доказательство не принесло», а не «разошлось»: сравниваем только
  // когда обе стороны что-то заявили (иначе легаси-receipt без темы валил бы каждый ран).
  if (reference.fontManifestHash !== null && candidate.fontManifestHash !== null && reference.fontManifestHash !== candidate.fontManifestHash) differing.push("fontManifestHash");
  if (reference.readinessPolicyHash !== null && candidate.readinessPolicyHash !== null && reference.readinessPolicyHash !== candidate.readinessPolicyHash) differing.push("readinessPolicyHash");
  if (differing.length > 0) return { record: { state: "mismatch", differing, ...base }, outcomeCode: "renderer_mismatch", warnings: [] };

  // Эпоха проверяется только при включённых флагах: без новых пикселей она не осмыслена (V-N5d).
  if (flags.rendererFlags && reference.epoch !== null && reference.epoch !== flags.epoch) {
    return { record: { state: "mismatch", differing: ["rendererEpoch"], ...base }, outcomeCode: "stale_renderer", warnings: [] };
  }
  return { record: { state: "matched", differing: [], ...base }, outcomeCode: null, warnings: [] };
}

/** Хвост терминальной строки рана, добавленный R6: исход guard'а и обе evidence-ссылки. */
export interface RendererTrailer {
  guard: RendererGuardRecord;
  outcomeCode: RunOutcomeCode | null;
  candidateReceiptSha256: string | null;
  referenceReceiptSha256: string | null;
}

export type RunView =
  | { kind: "running"; runId: string; referenceId: string; status: "running"; jobId: string }
  | { kind: "report"; report: RunReport };

interface MemoryRun { runId: string; referenceId: string; status: "running" | RunReport["status"]; jobId?: string; report?: RunReport; expiresAt?: number }

/**
 * Orchestrates a visual-regression check: capture a candidate through the
 * screenshot job pipeline (parameters derived from the reference fingerprint),
 * diff it against the pinned baseline in a node subprocess, and persist an
 * honest evidence run. The evidence guard is enforced here — no percentage is
 * ever produced without both physical files, both sha256, both dimensions, a
 * numerator and a denominator.
 */
export class VisualService {
  private readonly runs = new Map<string, MemoryRun>();
  private readonly runDiff: RunDiff;
  private readonly runSignalsDiff: RunSignalsDiff;
  private readonly now: () => number;

  constructor(private readonly deps: VisualServiceDeps) {
    this.runDiff = deps.runDiff ?? spawnDiffWorker;
    this.runSignalsDiff = deps.runSignalsDiff ?? spawnSignalsDiffWorker;
    this.now = deps.now ?? Date.now;
  }

  private repo(): VisualRepo { return new VisualRepo(this.deps.db, this.deps.dataDir); }

  /** POST /api/visual-references/:id/check — resolve target from the fingerprint and enqueue. */
  check(referenceId: string, opts: { threshold?: number; rev?:number; version?:number }): { runId: string; jobId?: string } {
    const repo = this.repo();
    const reference = repo.getReference(referenceId);
    if (!reference) throw new ApiError(404, "reference_not_found", "Visual reference not found");
    const fingerprint = parseFingerprint(JSON.parse(reference.fingerprint_json));
    if(fingerprint.propsHash!==undefined||fingerprint.stateHash!==undefined) throw new ApiError(422,"invalid_candidate_target","References with propsHash/stateHash do not have a reproducible candidate recipe");
    if((fingerprint.scope==="prototype-screen"&&opts.version!==undefined)||(fingerprint.scope==="component"&&opts.rev!==undefined)||(opts.rev!==undefined&&opts.version!==undefined)) {
      throw new ApiError(422,"invalid_candidate_target","rev is valid only for prototype references and version only for component references");
    }
    if(fingerprint.scope==="prototype-screen"&&fingerprint.prototypeInstanceId!==undefined) {
      const proto=this.deps.db.query("SELECT instance_id FROM prototypes WHERE id=?").get(fingerprint.prototypeId) as {instance_id:string}|null;
      if(!proto) throw new ApiError(404,"prototype_not_found","Prototype not found");
      if(proto.instance_id!==fingerprint.prototypeInstanceId) throw new ApiError(409,"instance_conflict","Prototype instance has changed");
    }
    const passThreshold = normalizeThreshold(opts.threshold);
    const runId = `vrun_${crypto.randomUUID()}`;
    return this.beginCheck(repo, reference, fingerprint, passThreshold, runId,opts);
  }

  private beginCheck(repo: VisualRepo, reference: VisualReferenceRow, fingerprint: Fingerprint, passThreshold: number, runId: string,candidate:{rev?:number;version?:number}): { runId: string; jobId?: string } {
    const refAsset = repo.assetRepo().get(reference.asset_id);
    const refBytesPath = refAsset ? repo.assetRepo().bytesPath(refAsset.sha256) : null;
    // Reference asset missing (row gone or bytes gone) => reference_missing, no percentage.
    if (!refAsset || !refBytesPath || !Bun.file(refBytesPath).size) {
      const row = this.terminalRow(runId, reference.id, reference.asset_id, "reference_missing", { candidateAssetId: null, diffAssetId: null, metric: null, metricOptions: null, pixelmatch: null, candidateMeta: null });
      repo.insertRun(row);
      this.remember(runId, reference.id, repo.runReport(row));
      return { runId };
    }

    const screenshots = this.deps.screenshots;
    if (!screenshots) throw new ApiError(501, "screenshot_unavailable", "Screenshot capture is unavailable for candidate capture");
    const frozen = this.enqueue(screenshots, fingerprint,candidate);
    const {jobId}=frozen;
    const context=this.metaContext(fingerprint,candidate,frozen.expected);
    this.runs.set(runId, { runId, referenceId: reference.id, status: "running", jobId });
    // Снапшот флагов берётся здесь, на постановке (N11): ран, стартовавший до флипа
    // `EASYUI_RENDERER_FLAGS`, доигрывается по семантике своего старта.
    void this.drive(runId, reference, fingerprint, passThreshold, jobId, refAsset.sha256,context,visualRunFlags());
    return { runId, jobId };
  }

  private enqueue(screenshots: ScreenshotService, fp: Fingerprint,candidate:{rev?:number;version?:number}): { jobId: string;expected:CaptureExpected } {
    if (fp.scope === "prototype-screen") {
      return screenshots.enqueueWithExpected({kind:"prototype",id:fp.prototypeId,screenId:fp.screenId,rev:candidate.rev??fp.refRevision}, {viewport: fp.viewport, deviceScaleFactor: fp.deviceScaleFactor, theme: fp.theme, waitForFonts: true });
    }
    return screenshots.enqueueWithExpected({kind:"component",id:fp.componentId,version:candidate.version??fp.refVersion}, { viewport: fp.viewport, deviceScaleFactor: fp.deviceScaleFactor, theme: fp.theme, waitForFonts: true });
  }

  private metaContext(fp:Fingerprint,candidate:{rev?:number;version?:number},expected:CaptureExpected) {
    return fp.scope==="prototype-screen"
      ? {kind:"prototype" as const,requestedTarget:{rev:candidate.rev??fp.refRevision},resolvedTarget:{rev:expected.kind==="prototype"?expected.rev:candidate.rev??fp.refRevision},expected}
      : {kind:"component" as const,requestedTarget:{version:candidate.version??fp.refVersion},resolvedTarget:{version:expected.kind==="component"?expected.version:candidate.version??fp.refVersion},expected};
  }

  private async drive(runId: string, reference: VisualReferenceRow, fingerprint: Fingerprint, passThreshold: number, jobId: string, refSha: string,context:ReturnType<VisualService["metaContext"]>,flags:VisualRunFlags): Promise<void> {
    const screenshots = this.deps.screenshots!;
    const repo = this.repo();
    const deadline = this.now() + CHECK_DEADLINE_MS;
    let capturedBrowser:CandidateMeta["browser"]=null;
    let capturedMeta:CandidateMeta|null=null;
    let capturedAssetId:string|null=null;
    try {
      let job = screenshots.get(jobId);
      while (job.status !== "done" && job.status !== "error") {
        if (this.now() > deadline) { this.finalizeError(repo, runId, reference, "candidate capture timed out",context,null); return; }
        await Bun.sleep(POLL_INTERVAL_MS);
        job = screenshots.get(jobId);
      }
      if (job.status === "error" || !job.result || job.result.kind !== "image") { this.finalizeError(repo, runId, reference, job.error?.message ?? "candidate capture failed",context,null); return; }

      const result = job.result;
      const candidateAssetId = result.assetId;
      capturedAssetId=candidateAssetId;
      const candAsset = repo.assetRepo().get(candidateAssetId);
      const browser={browserVersion:result.browserVersion,rendererBuild:result.rendererBuild,consoleErrors:boundDiagnostics(result.consoleErrors),pageErrors:boundDiagnostics(result.pageErrors)};
      capturedBrowser=browser;
      const candidateMeta = this.candidateMeta(fingerprint, result,context,browser);
      capturedMeta=candidateMeta;
      // ── Cross-renderer guard (§5 R6, E5) ─────────────────────────────────────────────────────
      // Стоит между кадром кандидата и диффом: раньше кадра ещё нет, позже процент уже посчитан.
      //
      // Порядок относительно продуктовых ошибок кадра (console/pageErrors) выбран так: guard
      // считается **первым**, и его отказ терминализует ран раньше. Причина не в приоритете
      // «важности», а в разной ремедиации: «эталон снят другим рендерером — переснимите эталон»
      // и «компонент бросил ошибку в консоль — почините компонент» лечатся по-разному, и первый
      // диагноз не выводится из второго. Консольные ошибки при этом не теряются: они целиком
      // лежат в `candidateMeta.browser` того же рана.
      const referenceRenderer = parseReferenceRenderer(reference);
      const candidateRenderer = await this.candidateRenderer(result);
      const guard = evaluateRendererGuard(referenceRenderer, candidateRenderer, flags);
      const trailer: RendererTrailer = {
        guard: guard.record,
        outcomeCode: guard.outcomeCode,
        candidateReceiptSha256: candidateRenderer?.receiptSha256 ?? null,
        referenceReceiptSha256: referenceRenderer?.receiptSha256 ?? null,
      };
      if (guard.outcomeCode !== null) {
        // Без процента: `pm`-часть терминальной строки остаётся `null`, как у любого исхода,
        // которому нечего измерять честно (канон evidence-гарда).
        this.finalizeCaptured(repo, runId, reference, "error", candidateAssetId, candidateMeta, null, null, trailer);
        return;
      }
      if(result.consoleErrors.length||result.pageErrors.length) { this.finalizeCaptured(repo,runId,reference,"error",candidateAssetId,candidateMeta,null,null,trailer); return; }
      if (!candAsset) { this.finalizeCaptured(repo,runId,reference,"error",candidateAssetId,{...candidateMeta,error:"candidate asset missing after capture"},null,null,trailer); return; }

      const refBytes = Buffer.from(await Bun.file(repo.assetRepo().bytesPath(refSha)).arrayBuffer());
      const candBytes = Buffer.from(await Bun.file(repo.assetRepo().bytesPath(candAsset.sha256)).arrayBuffer());
      if (flags.signalsV2) {
        await this.finalizeSignals(repo, runId, reference, fingerprint, passThreshold, candidateAssetId, candidateMeta, trailer, refBytes, candBytes);
        return;
      }
      const diff = await this.runDiff({ referencePngBase64: refBytes.toString("base64"), candidatePngBase64: candBytes.toString("base64"), options: { threshold: PIXELMATCH_THRESHOLD, includeAA: false } });

      if (!diff.ok) { this.finalizeCaptured(repo, runId, reference, "error", candidateAssetId, candidateMeta, null, null, trailer); return; }
      if (diff.dimensionMismatch) {
        // Honest: dimensions recorded via the asset rows; no numerator/denominator, no percentage.
        this.finalizeCaptured(repo, runId, reference, "error", candidateAssetId, candidateMeta, null, null, trailer);
        return;
      }
      const pm = diff.pixelmatch!;
      const exact = diff.exact!;
      const pmPercent = pm.totalPixels ? (pm.diffPixels / pm.totalPixels) * 100 : 0;
      const exactResult: MetricResult = { diffPixels: exact.diffPixels, totalPixels: exact.totalPixels, diffPercent: exact.totalPixels ? (exact.diffPixels / exact.totalPixels) * 100 : 0 };
      const ingest = diff.diffPngBase64 ? await repo.assetRepo().ingest(new Uint8Array(Buffer.from(diff.diffPngBase64, "base64")), "image/png", "diff.png") : null;
      const status: VisualRunRow["status"] = pmPercent <= passThreshold ? "pass" : "fail";
      this.finalizeCaptured(repo, runId, reference, status, candidateAssetId, { ...candidateMeta, exactRgba: exactResult } as CandidateMeta & { exactRgba: MetricResult }, ingest?.asset.id ?? null, { metric: "pixelmatch-v1", options: pm.options, diffPixels: pm.diffPixels, totalPixels: pm.totalPixels, diffPercent: pmPercent }, trailer);
    } catch (error) {
      const message=bounded(error instanceof Error ? error.message : String(error));
      if(capturedMeta) this.finalizeCaptured(repo,runId,reference,"error",capturedAssetId,{...capturedMeta,error:message},null,null);
      else this.finalizeError(repo, runId, reference, message,context,capturedBrowser);
    }
  }

  /**
   * Ветка R7a: тот же подпроцесс в режиме `signals`, вердикт — {@link evaluateSignalsVerdict}.
   *
   * Строка рана остаётся прежней формы: `metric`/`diff_percent` продолжают нести **перцептивную**
   * метрику (`pixelmatch-v1`), потому что её читают существующие потребители и сравнивают между
   * ранами. Новое — `class` и `signals`, и они едут в той же колонке `candidate_meta_json`, что и
   * `exactRgba`: миграции у этой волны нет (единственная миграция пакета была в R6), а честный
   * отчёт важнее красивой схемы. `indeterminate` не получает процента вовсе.
   */
  private async finalizeSignals(
    repo: VisualRepo, runId: string, reference: VisualReferenceRow, fingerprint: Fingerprint, passThreshold: number,
    candidateAssetId: string, candidateMeta: CandidateMeta, trailer: RendererTrailer,
    refBytes: Buffer, candBytes: Buffer,
  ): Promise<void> {
    const diff = await this.runSignalsDiff({
      mode: "signals",
      referencePngBase64: refBytes.toString("base64"),
      candidatePngBase64: candBytes.toString("base64"),
      options: { threshold: PIXELMATCH_THRESHOLD, includeAA: false },
    });
    if (diff.ok === false) { this.finalizeCaptured(repo, runId, reference, "error", candidateAssetId, candidateMeta, null, null, trailer); return; }

    const verdict = evaluateSignalsVerdict(diff, passThreshold, fingerprint.deviceScaleFactor);
    const meta = { ...candidateMeta, signalsV2: { class: verdict.runClass, signals: verdict.signals } } as CandidateMeta;
    if (diff.indeterminate) {
      this.finalizeCaptured(repo, runId, reference, verdict.status, candidateAssetId, meta, null, null, { ...trailer, outcomeCode: verdict.outcomeCode });
      return;
    }
    const withExact = { ...meta, exactRgba: verdict.signals.exact } as CandidateMeta & { exactRgba: MetricResult };
    const ingest = diff.diffPngBase64 ? await repo.assetRepo().ingest(new Uint8Array(Buffer.from(diff.diffPngBase64, "base64")), "image/png", "diff.png") : null;
    this.finalizeCaptured(repo, runId, reference, verdict.status, candidateAssetId, withExact, ingest?.asset.id ?? null, {
      metric: "pixelmatch-v1", options: diff.pixelmatch.options,
      diffPixels: diff.pixelmatch.diffPixels, totalPixels: diff.pixelmatch.totalPixels,
      diffPercent: verdict.signals.perceptual!.diffPercent,
    }, trailer);
  }

  private candidateMeta(fp: Fingerprint, result: Extract<NonNullable<ReturnType<ScreenshotService["get"]>["result"]>, {kind:"image"}>,context:ReturnType<VisualService["metaContext"]>,browser:NonNullable<CandidateMeta["browser"]>): CandidateMeta {
    if (fp.scope === "prototype-screen") {
      return { ...context,outcome:"captured",browser,rev: context.resolvedTarget.rev, pins: result.componentPins, rendererBuild: result.rendererBuild, browserVersion: result.browserVersion };
    }
    return { ...context,outcome:"captured",browser,version: context.resolvedTarget.version, bundleHash: result.bundleHash, rendererBuild: result.rendererBuild, browserVersion: result.browserVersion };
  }

  /**
   * Рендерер кандидата — из его же receipt'а (R5): кадр снят секунду назад, поэтому запись в
   * сторе заведомо есть. Фолбэк на объявление джобы нужен для `EASYUI_CAPTURE_RECEIPTS_DISABLED=1`:
   * отпечаток известен и без receipt'а, а `fontManifestHash` в этом режиме честно `null`.
   */
  private async candidateRenderer(result: { receiptSha256?: string; renderer?: { fingerprint: string; rendererVersion: string } }): Promise<(ReferenceRendererRecord) | null> {
    if (result.receiptSha256) {
      const record = rendererRecordFromReceipt(await readReceipt(this.deps.dataDir, result.receiptSha256), result.receiptSha256);
      if (record !== null) return record;
    }
    if (!result.renderer) return null;
    return {
      fingerprint: result.renderer.fingerprint,
      fontManifestHash: null,
      readinessPolicyHash: null,
      epoch: result.renderer.rendererVersion,
      browserVersion: null, launchedExecutable: null, browserExecutableSha256: null, source: null,
      receiptSha256: result.receiptSha256 ?? null,
      recordedAt: new Date().toISOString(),
    };
  }

  private finalizeError(repo: VisualRepo, runId: string, reference: VisualReferenceRow, message: string,context:ReturnType<VisualService["metaContext"]>,browser:CandidateMeta["browser"]): void {
    const common={rendererBuild:context.expected.rendererBuild,...(browser?{browserVersion:browser.browserVersion}:{})};
    const aliases=context.kind==="prototype"?{...common,rev:context.resolvedTarget.rev}:{...common,version:context.resolvedTarget.version,bundleHash:context.expected.kind==="component"?context.expected.bundleHash:undefined};
    const meta: CandidateMeta = { ...context,...aliases,outcome:"capture_failed",browser,error:bounded(message) };
    const row = this.terminalRow(runId, reference.id, reference.asset_id, "error", { candidateAssetId: null, diffAssetId: null, metric: null, metricOptions: null, pixelmatch: null, candidateMeta: meta });
    repo.insertRun(row);
    this.remember(runId, reference.id, repo.runReport(row));
  }

  private finalizeCaptured(repo: VisualRepo, runId: string, reference: VisualReferenceRow, status: VisualRunRow["status"], candidateAssetId: string | null, candidateMeta: CandidateMeta | null, diffAssetId: string | null, pm: { metric: string; options: Record<string, unknown>; diffPixels: number; totalPixels: number; diffPercent: number } | null, renderer: RendererTrailer | null = null): void {
    const row = this.terminalRow(runId, reference.id, reference.asset_id, status, {
      candidateAssetId, diffAssetId,
      metric: pm?.metric ?? null, metricOptions: pm?.options ?? null,
      pixelmatch: pm ? { diffPixels: pm.diffPixels, totalPixels: pm.totalPixels, diffPercent: pm.diffPercent } : null,
      candidateMeta, renderer,
    });
    repo.insertRun(row);
    this.remember(runId, reference.id, repo.runReport(row));
  }

  private terminalRow(runId: string, referenceId: string, referenceAssetId: string, status: VisualRunRow["status"], parts: {
    candidateAssetId: string | null; diffAssetId: string | null; metric: string | null; metricOptions: Record<string, unknown> | null;
    pixelmatch: { diffPixels: number; totalPixels: number; diffPercent: number } | null; candidateMeta: CandidateMeta | null;
    renderer?: RendererTrailer | null;
  }): VisualRunRow {
    const renderer = parts.renderer ?? null;
    return {
      renderer_guard: renderer ? JSON.stringify(renderer.guard) : null,
      outcome_code: renderer?.outcomeCode ?? null,
      candidate_receipt_sha256: renderer?.candidateReceiptSha256 ?? null,
      reference_receipt_sha256: renderer?.referenceReceiptSha256 ?? null,
      id: runId, reference_id: referenceId,
      reference_asset_id: referenceAssetId,
      candidate_asset_id: parts.candidateAssetId, diff_asset_id: parts.diffAssetId,
      metric: parts.metric, metric_options_json: parts.metricOptions ? JSON.stringify(parts.metricOptions) : null,
      diff_pixels: parts.pixelmatch?.diffPixels ?? null, total_pixels: parts.pixelmatch?.totalPixels ?? null, diff_percent: parts.pixelmatch?.diffPercent ?? null,
      status, candidate_meta_json: parts.candidateMeta ? JSON.stringify(parts.candidateMeta) : null,
      created_at: new Date().toISOString(),
    };
  }

  private remember(runId: string, referenceId: string, report: RunReport): void {
    this.runs.set(runId, { runId, referenceId, status: report.status, report, expiresAt: this.now() + RUN_TTL_MS });
  }

  /** GET /api/visual-runs/:runId — in-memory non-terminal state, else the persisted report. */
  get(runId: string): RunView | null {
    this.reap();
    const mem = this.runs.get(runId);
    if (mem?.report) return { kind: "report", report: mem.report };
    if (mem && mem.status === "running") return { kind: "running", runId: mem.runId, referenceId: mem.referenceId, status: "running", jobId: mem.jobId! };
    const repo = this.repo();
    const row = repo.getRun(runId);
    if (!row) return null;
    return { kind: "report", report: repo.runReport(row) };
  }

  private reap(): void {
    const t = this.now();
    for (const [id, run] of this.runs) if (run.expiresAt !== undefined && run.expiresAt <= t) this.runs.delete(id);
  }
}

function normalizeThreshold(value: number | undefined): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new ApiError(422, "invalid_threshold", "threshold must be a number between 0 and 100 (percent)");
  }
  return value;
}

const bounded=(value:string)=>value.length<=500?value:`${value.slice(0,497)}...`;
const boundDiagnostics=(values:string[])=>values.slice(0,20).map(bounded);

// ---------------------------------------------------------------------------
// R7b — Diagnostic bundle визуального рана (§5 R7b, P1.5).
//
// Один архив на ран: оба кадра, три производных картинки, оба receipt'а, отчёт и `SHA256SUMS`.
// Смысл — снять с человека сборку доказательств руками: сегодня, чтобы понять «почему fail»,
// нужно вручную вытащить три ассета по трём URL, найти receipt'ы по двум sha и сопоставить их с
// отчётом рана. Bundle делает это одним GET и — главное — **самопроверяемым**: `sha256sum -c
// SHA256SUMS` снаружи говорит, что архив не подменён и не обрезан.
//
// Три решения, которые видно в коде:
//
// 1. **`diff-exact.png` и `edge-mask.png` пересчитываются на запросе, а не хранятся.** Хранение
//    потребовало бы двух новых ассетов на каждый ран в сторе, у которого **нет GC** (§4: `assets/`
//    копит orphan-PNG), — за диагностику, которую смотрят у единиц ранов. Пересчёт детерминирован:
//    те же чистые функции того же воркера (`padPng`/`exactDiffMaskOf`/`edgeMaskOf`), которыми ран
//    судился, и происхождение каждого файла названо в `report.json` (`source`).
// 2. **`diff-perceptual.png` не пересчитывается никогда.** Это артефакт, произведённый самим раном
//    (ассет `diff_asset_id`); подменять его свежим рендером значило бы показывать не то, по чему
//    вынесен вердикт. Нет ассета — файла в архиве нет, а в `report.json` честное `null` с причиной.
// 3. **Отсутствующее не выдумывается.** Вытесненный receipt эталона, удалённый кадр кандидата,
//    несводимые размеры — всё это записывается в `report.json` как `null` + `reason` (канон
//    acceptance-evidence: манифест остаётся полным, отсутствие видно). Пин receipt'ов эталона
//    (R6) делает первый случай редким, но не невозможным — врать об этом нельзя.
// ---------------------------------------------------------------------------

/** Версия формата архива. Читатель обязан уметь отличить будущий формат от этого. */
export const VISUAL_BUNDLE_VERSION = 1;

/** Файл архива: имя (санитизировано), байты и их адрес. */
export interface VisualBundleEntry { name: string; bytes: Uint8Array; sha256: string; compress: boolean }

/** Строка `report.json` про один файл: либо он есть (с адресом и происхождением), либо его нет — и почему. */
type BundleArtifactNote =
  | { name: string; present: true; sha256: string; bytes: number; source: string }
  | { name: string; present: false; reason: string };

const sha256Hex = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

async function readAssetBytes(repo: VisualRepo, assetId: string | null | undefined, sha256: string | null): Promise<Uint8Array | null> {
  if (!assetId) return null;
  const sha = sha256 ?? repo.assetRepo().get(assetId)?.sha256 ?? null;
  if (!sha) return null;
  const file = Bun.file(repo.assetRepo().bytesPath(sha));
  if (!(await file.exists()) || file.size === 0) return null;
  return new Uint8Array(await file.arrayBuffer());
}

/**
 * Две однобитные картинки поверх общего холста: «где кадры отличаются хоть чем-то» (exact-rgba) и
 * «где у эталона контур» (Sobel + дилатация 1 px — ровно та маска, по которой считается сигнал
 * `edgeResidual`). Цвета выбраны за читаемость глазом, а не за смысл: чёрное на белом.
 *
 * Кадры разных габаритов сводятся тем же `padPng`, что и в воркере; за допуском — `null`, потому
 * что маска разного холста описывала бы не разницу кадров, а разницу их размеров.
 */
/**
 * Пиксельная работа bundle'а идёт синхронно в процессе API (сам ран судит кадры в подпроцессе —
 * канон spawnDiffWorker; здесь подпроцесс не заводим ради простоты read-only ручки). На кадрах у
 * потолка MAX_ASSET_PIXELS один вызов держит event loop ~секунды, поэтому конкуренция — 1:
 * параллельные bundle-запросы выстраиваются в очередь, а не душат API хором (приёмка R7b).
 */
let derivedMasksChain: Promise<unknown> = Promise.resolve();

async function derivedMasks(referencePng: Uint8Array, candidatePng: Uint8Array): Promise<{ exact: Uint8Array; edge: Uint8Array } | { reason: string }> {
  const run = derivedMasksChain.then(() => derivedMasksInner(referencePng, candidatePng));
  derivedMasksChain = run.catch(() => undefined);
  return run;
}

async function derivedMasksInner(referencePng: Uint8Array, candidatePng: Uint8Array): Promise<{ exact: Uint8Array; edge: Uint8Array } | { reason: string }> {
  const worker = await import("../../scripts/visual-diff-worker.mjs");
  const { PNG } = await import("pngjs");
  const padded = (png: unknown, width: number, height: number): { data: Buffer } => worker.padPng(png, width, height) as { data: Buffer };
  const reference = PNG.sync.read(Buffer.from(referencePng));
  const candidate = PNG.sync.read(Buffer.from(candidatePng));
  const tolerance = worker.DEFAULT_MAX_DIMENSION_DELTA_PX;
  const deltaWidth = Math.abs(reference.width - candidate.width);
  const deltaHeight = Math.abs(reference.height - candidate.height);
  if (deltaWidth > tolerance || deltaHeight > tolerance) {
    return { reason: `dimensions_irreconcilable: ${reference.width}×${reference.height} vs ${candidate.width}×${candidate.height}, beyond the ${tolerance}px pad tolerance` };
  }
  const width = Math.max(reference.width, candidate.width);
  const height = Math.max(reference.height, candidate.height);
  const paddedRef = padded(reference, width, height);
  const paddedCand = padded(candidate, width, height);
  const total = width * height;
  const exactMask = worker.exactDiffMaskOf(paddedRef.data, paddedCand.data, total).mask;
  const edgeMask = worker.edgeMaskOf(paddedRef.data, width, height).mask;
  const paint = (mask: Uint8Array): Uint8Array => {
    const png = new PNG({ width, height });
    for (let index = 0; index < total; index += 1) {
      const offset = index * 4;
      const value = mask[index] === 1 ? 0 : 255;
      png.data[offset] = value; png.data[offset + 1] = value; png.data[offset + 2] = value; png.data[offset + 3] = 255;
    }
    return new Uint8Array(PNG.sync.write(png));
  };
  return { exact: paint(exactMask), edge: paint(edgeMask) };
}

/**
 * Собирает содержимое `bundle.zip` терминального рана. Возвращает файлы в порядке записи; zip'ует
 * и отдаёт вызывающий роут (канон acceptance-evidence: сборка — в домене, транспорт — в роуте).
 *
 * Потолок `evidenceMaxBytes` проверяется по размерам ассетов **до** чтения байтов — канон
 * `BundleClosure.buildZip`/`runEvidence`: 413 обязан приходить раньше материализации архива.
 */
export async function buildVisualRunBundle(db: Database, dataDir: string, report: RunReport): Promise<VisualBundleEntry[]> {
  const repo = new VisualRepo(db, dataDir);
  const assets = repo.assetRepo();
  const diffAssetId = report.diff?.assetId ?? null;
  const diffSha = diffAssetId ? assets.get(diffAssetId)?.sha256 ?? null : null;
  const sources: { name: string; assetId: string | null; sha256: string | null }[] = [
    { name: "reference.png", assetId: report.reference?.assetId ?? null, sha256: report.reference?.sha256 ?? null },
    { name: "candidate.png", assetId: report.candidate?.assetId ?? null, sha256: report.candidate?.sha256 ?? null },
    { name: "diff-perceptual.png", assetId: diffAssetId, sha256: diffSha },
  ];
  const declaredBytes = sources.reduce((sum, item) => sum + (item.sha256 ? Bun.file(assets.bytesPath(item.sha256)).size : 0), 0);
  // Производные маски ограничены тем же холстом, что и кадры, поэтому потолок по входам —
  // достаточная (и единственная дешёвая) оценка до чтения байтов.
  if (declaredBytes * 2 > evidenceMaxBytes) {
    throw new ApiError(413, "evidence_too_large", `Bundle exceeds ${evidenceMaxBytes} bytes of raw content`);
  }

  const entries: VisualBundleEntry[] = [];
  const notes: BundleArtifactNote[] = [];
  const push = (name: string, bytes: Uint8Array, source: string, compress: boolean): void => {
    const entryName = sanitizeEvidenceName(name);
    const sha = sha256Hex(bytes);
    entries.push({ name: entryName, bytes, sha256: sha, compress });
    notes.push({ name: entryName, present: true, sha256: sha, bytes: bytes.byteLength, source });
  };
  const skip = (name: string, reason: string): void => { notes.push({ name: sanitizeEvidenceName(name), present: false, reason }); };

  const frames: Record<string, Uint8Array | null> = {};
  for (const item of sources) {
    const bytes = await readAssetBytes(repo, item.assetId, item.sha256);
    frames[item.name] = bytes;
    if (bytes) push(item.name, bytes, `asset:${item.assetId}`, false);
    else skip(item.name, item.assetId ? `asset_bytes_missing:${item.assetId}` : "asset_not_recorded");
  }

  const referenceBytes = frames["reference.png"];
  const candidateBytes = frames["candidate.png"];
  if (referenceBytes && candidateBytes) {
    const derived = await derivedMasks(referenceBytes, candidateBytes);
    if ("reason" in derived) { skip("diff-exact.png", derived.reason); skip("edge-mask.png", derived.reason); }
    else {
      push("diff-exact.png", derived.exact, "derived:exact-rgba", true);
      push("edge-mask.png", derived.edge, "derived:sobel-edge-mask", true);
    }
  } else {
    const reason = "requires both reference.png and candidate.png";
    skip("diff-exact.png", reason); skip("edge-mask.png", reason);
  }

  const receipts: Record<string, { sha256: string; present: boolean; reason?: string } | null> = {};
  for (const [name, sha] of [["reference-receipt.json", report.referenceReceiptSha256], ["candidate-receipt.json", report.candidateReceiptSha256]] as const) {
    if (!sha) {
      // Честный `null` (§5 R7b): у эталона, снятого до R5/R6 или залитого извне, receipt'а нет вовсе.
      receipts[name] = null; skip(name, "no_receipt_recorded"); continue;
    }
    const receipt = await readReceipt(dataDir, sha);
    if (!receipt) {
      // Пин R6 держит receipt'ы эталонов, но TTL/вытеснение кандидатского — возможны.
      receipts[name] = { sha256: sha, present: false, reason: "receipt_unavailable" };
      skip(name, `receipt_unavailable:${sha}`); continue;
    }
    receipts[name] = { sha256: sha, present: true };
    push(name, new TextEncoder().encode(`${JSON.stringify(receipt, null, 2)}\n`), `receipt:${sha}`, true);
  }

  const reportJson = {
    bundleVersion: VISUAL_BUNDLE_VERSION,
    runId: report.runId,
    referenceId: report.referenceId,
    status: report.status,
    outcomeCode: report.outcomeCode,
    class: report.class,
    run: report,
    receipts,
    artifacts: notes,
  };
  push("report.json", new TextEncoder().encode(`${JSON.stringify(reportJson, null, 2)}\n`), "generated", true);

  const sums = entries.map((entry) => `${entry.sha256}  ${entry.name}`).join("\n");
  const sumsBytes = new TextEncoder().encode(entries.length === 0 ? "" : `${sums}\n`);
  entries.push({ name: "SHA256SUMS", bytes: sumsBytes, sha256: sha256Hex(sumsBytes), compress: true });
  return entries;
}
