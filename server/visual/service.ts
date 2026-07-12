import type { Database } from "bun:sqlite";
import { ApiError } from "../http";
import type { ScreenshotService } from "../screenshot/service";
import { spawnDiffWorker, type RunDiff } from "./diff-runner";
import { parseFingerprint, type Fingerprint } from "./fingerprint";
import { VisualRepo, type CandidateMeta, type MetricResult, type RunReport, type VisualReferenceRow, type VisualRunRow } from "./repo";

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

export type RunView =
  | { kind: "running"; runId: string; referenceId: string; status: "running"; jobId: string }
  | { kind: "report"; report: RunReport };

interface MemoryRun { runId: string; referenceId: string; status: "running" | VisualRunRow["status"]; jobId?: string; report?: RunReport; expiresAt?: number }

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
  check(referenceId: string, opts: { threshold?: number }): { runId: string; jobId?: string } {
    const repo = this.repo();
    const reference = repo.getReference(referenceId);
    if (!reference) throw new ApiError(404, "reference_not_found", "Visual reference not found");
    const fingerprint = parseFingerprint(JSON.parse(reference.fingerprint_json));
    const passThreshold = normalizeThreshold(opts.threshold);
    const runId = `vrun_${crypto.randomUUID()}`;
    return this.beginCheck(repo, reference, fingerprint, passThreshold, runId);
  }

  private beginCheck(repo: VisualRepo, reference: VisualReferenceRow, fingerprint: Fingerprint, passThreshold: number, runId: string): { runId: string; jobId?: string } {
    const refAsset = repo.assetRepo().get(reference.asset_id);
    const refBytesPath = refAsset ? repo.assetRepo().bytesPath(refAsset.sha256) : null;
    // Reference asset missing (row gone or bytes gone) => reference_missing, no percentage.
    if (!refAsset || !refBytesPath || !Bun.file(refBytesPath).size) {
      const row = this.terminalRow(runId, reference.id, "reference_missing", { candidateAssetId: null, diffAssetId: null, metric: null, metricOptions: null, pixelmatch: null, candidateMeta: null });
      repo.insertRun(row);
      this.remember(runId, reference.id, repo.runReport(row, reference.asset_id));
      return { runId };
    }

    const screenshots = this.deps.screenshots;
    if (!screenshots) throw new ApiError(501, "screenshot_unavailable", "Screenshot capture is unavailable for candidate capture");
    const { jobId } = this.enqueue(screenshots, fingerprint);
    this.runs.set(runId, { runId, referenceId: reference.id, status: "running", jobId });
    void this.drive(runId, reference, fingerprint, passThreshold, jobId, refAsset.sha256);
    return { runId, jobId };
  }

  private enqueue(screenshots: ScreenshotService, fp: Fingerprint): { jobId: string } {
    if (fp.scope === "prototype-screen") {
      return screenshots.enqueuePrototype(fp.prototypeId, fp.screenId, { rev: fp.refRevision, viewport: fp.viewport, deviceScaleFactor: fp.deviceScaleFactor, theme: fp.theme, waitForFonts: true });
    }
    return screenshots.enqueueComponent(fp.componentId, fp.refVersion, { viewport: fp.viewport, deviceScaleFactor: fp.deviceScaleFactor, theme: fp.theme, waitForFonts: true });
  }

  private async drive(runId: string, reference: VisualReferenceRow, fingerprint: Fingerprint, passThreshold: number, jobId: string, refSha: string): Promise<void> {
    const screenshots = this.deps.screenshots!;
    const repo = this.repo();
    const deadline = this.now() + CHECK_DEADLINE_MS;
    try {
      let job = screenshots.get(jobId);
      while (job.status !== "done" && job.status !== "error") {
        if (this.now() > deadline) { this.finalizeError(repo, runId, reference, "candidate capture timed out"); return; }
        await Bun.sleep(POLL_INTERVAL_MS);
        job = screenshots.get(jobId);
      }
      if (job.status === "error" || !job.result) { this.finalizeError(repo, runId, reference, job.error?.message ?? "candidate capture failed"); return; }

      const result = job.result;
      const candidateAssetId = result.assetId;
      const candAsset = repo.assetRepo().get(candidateAssetId);
      if (!candAsset) { this.finalizeError(repo, runId, reference, "candidate asset missing after capture"); return; }

      const refBytes = Buffer.from(await Bun.file(repo.assetRepo().bytesPath(refSha)).arrayBuffer());
      const candBytes = Buffer.from(await Bun.file(repo.assetRepo().bytesPath(candAsset.sha256)).arrayBuffer());
      const diff = await this.runDiff({ referencePngBase64: refBytes.toString("base64"), candidatePngBase64: candBytes.toString("base64"), options: { threshold: PIXELMATCH_THRESHOLD, includeAA: false } });

      const candidateMeta = this.candidateMeta(fingerprint, result);
      if (!diff.ok) { this.finalizeCaptured(repo, runId, reference, "error", candidateAssetId, candidateMeta, null, null); return; }
      if (diff.dimensionMismatch) {
        // Honest: dimensions recorded via the asset rows; no numerator/denominator, no percentage.
        this.finalizeCaptured(repo, runId, reference, "error", candidateAssetId, candidateMeta, null, null);
        return;
      }
      const pm = diff.pixelmatch!;
      const exact = diff.exact!;
      const pmPercent = pm.totalPixels ? (pm.diffPixels / pm.totalPixels) * 100 : 0;
      const exactResult: MetricResult = { diffPixels: exact.diffPixels, totalPixels: exact.totalPixels, diffPercent: exact.totalPixels ? (exact.diffPixels / exact.totalPixels) * 100 : 0 };
      const ingest = diff.diffPngBase64 ? await repo.assetRepo().ingest(new Uint8Array(Buffer.from(diff.diffPngBase64, "base64")), "image/png", "diff.png") : null;
      const status: VisualRunRow["status"] = pmPercent <= passThreshold ? "pass" : "fail";
      this.finalizeCaptured(repo, runId, reference, status, candidateAssetId, { ...candidateMeta, exactRgba: exactResult } as CandidateMeta & { exactRgba: MetricResult }, ingest?.asset.id ?? null, { metric: "pixelmatch-v1", options: pm.options, diffPixels: pm.diffPixels, totalPixels: pm.totalPixels, diffPercent: pmPercent });
    } catch (error) {
      this.finalizeError(repo, runId, reference, error instanceof Error ? error.message : String(error));
    }
  }

  private candidateMeta(fp: Fingerprint, result: NonNullable<ReturnType<ScreenshotService["get"]>["result"]>): CandidateMeta {
    if (fp.scope === "prototype-screen") {
      return { rev: fp.refRevision, pins: result.componentPins, rendererBuild: result.rendererBuild, browserVersion: result.browserVersion };
    }
    return { version: fp.refVersion, bundleHash: result.bundleHash, rendererBuild: result.rendererBuild, browserVersion: result.browserVersion };
  }

  private finalizeError(repo: VisualRepo, runId: string, reference: VisualReferenceRow, message: string): void {
    const meta: CandidateMeta & { error?: string } = { };
    (meta as { error?: string }).error = message;
    const row = this.terminalRow(runId, reference.id, "error", { candidateAssetId: null, diffAssetId: null, metric: null, metricOptions: null, pixelmatch: null, candidateMeta: meta });
    repo.insertRun(row);
    this.remember(runId, reference.id, repo.runReport(row, reference.asset_id));
  }

  private finalizeCaptured(repo: VisualRepo, runId: string, reference: VisualReferenceRow, status: VisualRunRow["status"], candidateAssetId: string | null, candidateMeta: CandidateMeta | null, diffAssetId: string | null, pm: { metric: string; options: Record<string, unknown>; diffPixels: number; totalPixels: number; diffPercent: number } | null): void {
    const row = this.terminalRow(runId, reference.id, status, {
      candidateAssetId, diffAssetId,
      metric: pm?.metric ?? null, metricOptions: pm?.options ?? null,
      pixelmatch: pm ? { diffPixels: pm.diffPixels, totalPixels: pm.totalPixels, diffPercent: pm.diffPercent } : null,
      candidateMeta,
    });
    repo.insertRun(row);
    this.remember(runId, reference.id, repo.runReport(row, reference.asset_id));
  }

  private terminalRow(runId: string, referenceId: string, status: VisualRunRow["status"], parts: {
    candidateAssetId: string | null; diffAssetId: string | null; metric: string | null; metricOptions: Record<string, unknown> | null;
    pixelmatch: { diffPixels: number; totalPixels: number; diffPercent: number } | null; candidateMeta: CandidateMeta | null;
  }): VisualRunRow {
    return {
      id: runId, reference_id: referenceId,
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
    const reference = repo.getReference(row.reference_id);
    return { kind: "report", report: repo.runReport(row, reference?.asset_id ?? null) };
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
