import type { Database } from "bun:sqlite";
import { ApiError } from "../http";
import type { ScreenshotService } from "../screenshot/service";
import type { CaptureExpected } from "../../src/capture/protocol";
import { spawnDiffWorker, type RunDiff } from "./diff-runner";
import { parseFingerprint, type Fingerprint } from "./fingerprint";
import {
  parseReferenceRenderer, rendererRecordFromReceipt, VisualRepo,
  type CandidateMeta, type MetricResult, type ReferenceRendererRecord, type RendererGuardRecord,
  type RunOutcomeCode, type RunReport, type VisualReferenceRow, type VisualRunRow,
} from "./repo";
import { rendererDeclaration, rendererFlagsEnabled } from "../capture/renderer";
import { readReceipt } from "../capture/receiptStore";

export interface VisualServiceDeps {
  db: Database;
  dataDir: string;
  screenshots?: ScreenshotService;
  runDiff?: RunDiff;
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
  private readonly now: () => number;

  constructor(private readonly deps: VisualServiceDeps) {
    this.runDiff = deps.runDiff ?? spawnDiffWorker;
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
    void this.drive(runId, reference, fingerprint, passThreshold, jobId, refAsset.sha256,context,rendererGuardFlags());
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

  private async drive(runId: string, reference: VisualReferenceRow, fingerprint: Fingerprint, passThreshold: number, jobId: string, refSha: string,context:ReturnType<VisualService["metaContext"]>,flags:RendererGuardFlags): Promise<void> {
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
