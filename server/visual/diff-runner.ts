import { spawn } from "node:child_process";
import { resolve } from "node:path";

const WORKER_PATH = resolve(import.meta.dir, "../../scripts/visual-diff-worker.mjs");

export interface DiffJob {
  referencePngBase64: string;
  candidatePngBase64: string;
  options: { threshold: number; includeAA: boolean };
}
export type DiffOk = {
  ok: true;
  dimensionMismatch: boolean;
  refDims: { width: number; height: number };
  candDims: { width: number; height: number };
  exact?: { diffPixels: number; totalPixels: number };
  pixelmatch?: { diffPixels: number; totalPixels: number; options: { threshold: number; includeAA: boolean } };
  diffPngBase64?: string;
};
export type DiffErr = { ok: false; error: string };
export type DiffResult = DiffOk | DiffErr;
export type RunDiff = (job: DiffJob) => Promise<DiffResult>;

/**
 * Режим `normalize` (план 2026-08-03 §2 A5, §5 W5a; триаж R1-M4) — **аддитивно** к контракту выше.
 *
 * Тот же воркер и тот же spawn: отличается только поле `mode` в задании и форма результата. Здесь
 * два исхода вместо одного, и это принципиально: `indeterminate` («несводимые размеры») не несёт
 * метрик вовсе, потому что выдуманный процент расхождения хуже отсутствующего.
 */
export interface NormalizedDiffJob {
  mode: "normalize";
  referencePngBase64: string;
  candidatePngBase64: string;
  options?: {
    /** `cropLineage.rect` эталона: `[x, y, width, height]` в его собственных пикселях. */
    cropRect?: number[];
    /** Допуск расхождения габаритов после crop, px; больше — `indeterminate`. */
    maxDimensionDeltaPx?: number;
    rawThreshold?: number;
    aaThreshold?: number;
    maxRegions?: number;
    offsetWindow?: number;
  };
}
export interface DiffRegion { bbox: { x: number; y: number; width: number; height: number }; areaPct: number; meanDelta: number }
/**
 * Статистика расхождения внутри diff-маски (W5b): по ней классификаторы `server/visual/causes.ts`
 * отличают равномерную заливку от локального дефекта и цветовое расхождение от альфа-композитинга.
 * Поле аддитивно: результаты случаев, снятых до W5b, его не несут, и классификаторы это учитывают.
 */
export interface DiffChannelStats {
  pixels: number;
  meanDelta: { r: number; g: number; b: number; a: number };
  meanMaxDelta: number;
  stdMaxDelta: number;
  alphaDominantPct: number;
  semiTransparentPct: number;
}
export interface NormalizedDiffMetrics {
  rawDiffPct: number; aaDiffPct: number;
  /** R7a: остаток относительно edge-маски эталона. Аддитивно и **только** под `EASYUI_VISUAL_SIGNALS_V2=1`. */
  edgeResidual?: EdgeResidual;
  rawDiffPixels: number; aaDiffPixels: number; totalPixels: number;
  maxChannelDelta: number;
  channelStats?: DiffChannelStats;
  regions: DiffRegion[]; totalRegions: number;
  bestOffset: { dx: number; dy: number; residualPct: number; sampledPixels: number; step: number };
  thresholds: { raw: number; aa: number };
}
export interface Dims { width: number; height: number }
export type NormalizedDiffIndeterminate = {
  ok: true; mode: "normalize"; indeterminate: true; reason: string;
  sourceDims: Dims; refDims: Dims; candDims: Dims; cropApplied: boolean;
  dimensionDelta?: { width: number; height: number; tolerancePx: number };
};
export type NormalizedDiffMeasured = {
  ok: true; mode: "normalize"; indeterminate: false;
  sourceDims: Dims; refDims: Dims; candDims: Dims; cropApplied: boolean;
  canvas: Dims; padded: { reference: boolean; candidate: boolean };
  metrics: NormalizedDiffMetrics;
  diffPngBase64: string;
  normalizedCandidatePngBase64: string;
};
export type NormalizedDiffResult = NormalizedDiffIndeterminate | NormalizedDiffMeasured | DiffErr;
export type RunNormalizedDiff = (job: NormalizedDiffJob) => Promise<NormalizedDiffResult>;

// ---------------------------------------------------------------------------
// Режим `signals` (план renderer-contract-2 §3 **E6**, §5 **R7a**) — третий контракт того же
// воркера. Отдельный тип, а не расширение `DiffOk`, по той же причине, что и у `normalize`:
// вызывающий обязан видеть на месте вызова, что метрик может не быть вовсе (`irreconcilable`).
// ---------------------------------------------------------------------------

/**
 * Разбиение остатка по edge-маске эталона. `insidePct === null` — остатка нет вовсе (кадры
 * совпали побайтно): доли у пустого множества не бывает, и «100 %» здесь было бы выдумкой.
 */
export interface EdgeResidual {
  residualPixels: number;
  insidePixels: number;
  outsidePixels: number;
  insidePct: number | null;
  edgePixels: number;
  edgeCoveragePct: number;
  sobelThreshold: number;
  dilationPx: number;
}
export interface SignalsDiffJob {
  mode: "signals";
  referencePngBase64: string;
  candidatePngBase64: string;
  options?: {
    threshold?: number;
    includeAA?: boolean;
    maxDimensionDeltaPx?: number;
    maxRegions?: number;
    offsetWindow?: number;
    edgeOptions?: { sobelThreshold?: number; dilation?: number };
  };
}
export type SignalsDiffIndeterminate = {
  ok: true; mode: "signals"; dims: "irreconcilable"; indeterminate: true; reason: string;
  refDims: Dims; candDims: Dims;
  dimensionDelta: { width: number; height: number; tolerancePx: number };
};
export type SignalsDiffMeasured = {
  ok: true; mode: "signals"; dims: "equal" | "normalized"; indeterminate: false;
  refDims: Dims; candDims: Dims; canvas: Dims; padded: { reference: boolean; candidate: boolean };
  exact: { diffPixels: number; totalPixels: number };
  pixelmatch: { diffPixels: number; totalPixels: number; options: { threshold: number; includeAA: boolean } };
  edgeResidual: EdgeResidual;
  /** Метрики для классификатора причин; маска здесь — exact-rgba (см. воркер). */
  metrics: NormalizedDiffMetrics;
  diffPngBase64: string;
};
export type SignalsDiffResult = SignalsDiffIndeterminate | SignalsDiffMeasured | DiffErr;
export type RunSignalsDiff = (job: SignalsDiffJob) => Promise<SignalsDiffResult>;

const DIFF_DEADLINE_MS = 30_000;

/** Resolves the node binary; the diff worker uses node (pngjs/pixelmatch), not bun. */
function nodeBinary(): string { return process.execPath.includes("bun") ? "node" : process.execPath; }

/**
 * Общий спавн воркера: node-подпроцесс в своей группе, задание JSON'ом через stdin, единственная
 * JSON-строка на stdout, жёсткий дедлайн с убийством группы. Форму результата задаёт режим
 * задания (`compare` по умолчанию, `mode:"normalize"` — W5a), поэтому спавн параметризован типом.
 */
function spawnWorker<T>(job: unknown): Promise<T | DiffErr> {
  return new Promise<T | DiffErr>((resolvePromise) => {
    const child = spawn(nodeBinary(), [WORKER_PATH], { stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = ""; let stderr = ""; let settled = false;
    const finish = (result: T | DiffErr) => { if (settled) return; settled = true; clearTimeout(timer); resolvePromise(result); };
    const killGroup = () => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } };
    const timer = setTimeout(() => { killGroup(); finish({ ok: false, error: `visual diff timed out after ${DIFF_DEADLINE_MS}ms` }); }, DIFF_DEADLINE_MS);

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish({ ok: false, error: `diff worker spawn failed: ${error.message}` }));
    child.on("close", () => {
      const line = stdout.trim().split("\n").filter(Boolean).at(-1);
      if (!line) { finish({ ok: false, error: `diff worker produced no result${stderr ? `: ${stderr.slice(0, 500)}` : ""}` }); return; }
      try { finish(JSON.parse(line) as T); }
      catch { finish({ ok: false, error: `diff worker result was not JSON: ${line.slice(0, 300)}` }); }
    });

    child.stdin.on("error", () => { /* closed before write completes */ });
    child.stdin.write(JSON.stringify(job));
    child.stdin.end();
  });
}

/** Production {@link RunDiff}: сравнение кадр-в-кадр (VDC v1). */
export const spawnDiffWorker: RunDiff = (job: DiffJob): Promise<DiffResult> => spawnWorker<DiffOk>(job);

/**
 * Production {@link RunNormalizedDiff} (W5a): тот же воркер в режиме нормализации. Отдельная
 * функция, а не флаг у `spawnDiffWorker`, чтобы тип результата был точным на месте вызова —
 * приёмке нужны метрики или названная причина `indeterminate`, и промежуточных состояний нет.
 */
export const spawnNormalizedDiffWorker: RunNormalizedDiff = (job: NormalizedDiffJob): Promise<NormalizedDiffResult> =>
  spawnWorker<NormalizedDiffIndeterminate | NormalizedDiffMeasured>(job);

/**
 * Production {@link RunSignalsDiff} (R7a): четыре сигнала визуального рана в том же подпроцессе.
 * Отдельная функция по канону выше — тип результата точен на месте вызова.
 */
export const spawnSignalsDiffWorker: RunSignalsDiff = (job: SignalsDiffJob): Promise<SignalsDiffResult> =>
  spawnWorker<SignalsDiffIndeterminate | SignalsDiffMeasured>(job);
