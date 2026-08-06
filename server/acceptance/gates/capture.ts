/**
 * Общий канал захвата для гейтов: постановка фоновой capture-джобы кандидата, ожидание её исхода
 * и **авто-retry только инфраструктурных сбоев** (амендмент A3, D11).
 *
 * Ключевое различие, ради которого заведена таксономия `jobOutcome`:
 * - `worker_crash|timeout|queue_full|subprocess_error` — исход джобы; случай ретраится до
 *   `maxInfraRetries` (у `queue_full` — с backoff, потолок ниже);
 * - `productErrors` завершившегося капчура (классификация `noise.ts`) — **не** повод для retry:
 *   это дефект компонента, его судит гейт `render`;
 * - доменные отказы постановки (422 `invalid_props`, 409 `candidate_evicted`) не ретраятся вовсе:
 *   повтор даст тот же ответ.
 */
import { ApiError } from "../../http";
import { isTerminalJobOutcome, jobOutcomeOfError, type JobOutcome } from "../../screenshot/service";
import type { CaptureQuality, CaptureReadinessOutcome, ScreenshotResult } from "../../screenshot/service";
import type { GateContext } from "./types";

/** Потолок backoff'а на `queue_full` (RFC §4.2 «backoff-ретрай», триаж V7). */
export const QUEUE_BACKOFF_BASE_MS = 250;
export const QUEUE_BACKOFF_MAX_MS = 5_000;
/** Потолок ожидания одной джобы; дальше — `timeout`-исход и retry по общему бюджету. */
export const CAPTURE_POLL_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 25;

/** Инфраструктурный отказ, исчерпавший бюджет ретраев: случай уходит в `error` (D10). */
export class CaptureInfraError extends Error {
  constructor(readonly outcome: JobOutcome, readonly attempts: number, message: string) {
    super(message);
    this.name = "CaptureInfraError";
  }
}

export interface CaptureOutcome {
  jobId: string;
  /** Сколько раз случай переснимался из-за инфраструктуры (0 — с первой попытки). */
  retries: number;
  quality: { captureClean: boolean; productErrors: string[]; runtimeWarnings: string[]; infraWarnings: string[] };
  image?: { bytes: Uint8Array; width: number; height: number };
  geometry?: Record<string, unknown>;
  /** Поле paint-режима, CSS px (W3): вход диагностики «увеличить маргин». */
  paintMargin?: number;
  browserVersion?: string;
  /**
   * Исход readiness кадра (W4). Отсутствует у режимов, которые его не несут (`probe:"geometry"`):
   * гейт `readiness` трактует отсутствие как `indeterminate`, а не как «готов».
   */
  readiness?: CaptureReadinessOutcome;
  /**
   * Адрес capture-receipt'а кадра (R5). Отсутствует, если receipt'ы выключены kill-switch'ем:
   * гейт `render` тогда просто не кладёт `receipt.json` в evidence — вердикт от этого не зависит.
   */
  receiptSha256?: string;
}

/** Достаёт readiness-поля из результата джобы, не полагаясь на конкретный `kind`. */
function readinessOf(result: ScreenshotResult): CaptureReadinessOutcome | undefined {
  return "readinessMet" in result
    ? {
      readinessMet: result.readinessMet,
      readinessReason: result.readinessReason,
      readinessCodes: result.readinessCodes,
      readinessPolicyHash: result.readinessPolicyHash,
      readinessEvidence: result.readinessEvidence,
      observedCaptureEnvFingerprint: result.observedCaptureEnvFingerprint,
      observedCaptureEnv: result.observedCaptureEnv,
    }
    : undefined;
}

/**
 * Ретраится инфраструктура — и только она. Терминальные исходы таксономии (`renderer_mismatch`,
 * R3) повтор в том же процессе воспроизведёт дословно, поэтому бюджет на них не тратится.
 */
const isRetryable = (outcome: JobOutcome): boolean => outcome !== "ok" && !isTerminalJobOutcome(outcome);

/** Доменный (не инфраструктурный) отказ постановки: ответ детерминирован, повтор бессмыслен. */
function isProductRefusal(error: unknown): boolean {
  return error instanceof ApiError && error.status < 500 && error.code !== "queue_full";
}

const qualityOf = (result: CaptureQuality): CaptureOutcome["quality"] => ({
  captureClean: result.captureClean,
  productErrors: [...result.productErrors],
  runtimeWarnings: [...result.runtimeWarnings],
  infraWarnings: [...result.infraNoise],
});

async function awaitJob(ctx: GateContext, jobId: string): Promise<{ result?: ScreenshotResult; error?: { code: string; message: string } }> {
  const deadline = ctx.now() + CAPTURE_POLL_TIMEOUT_MS;
  for (;;) {
    const status = ctx.service.get(jobId);
    if (status.status === "done") return { result: status.result };
    if (status.status === "error") return { error: status.error ?? { code: "capture_failed", message: "capture failed" } };
    if (ctx.now() > deadline) return { error: { code: "capture_failed", message: `capture timed out after ${CAPTURE_POLL_TIMEOUT_MS}ms` } };
    await ctx.sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Снимает случай. Три режима:
 * - без `probe` — кадр байтами (A4: acceptance-капчуры не ингестятся в asset-store);
 * - `probe:"geometry"` — измерительная джоба (PNG не отдаётся);
 * - `probe:"paint"` (W3) — **одна сессия** отдаёт и geometry-факты, и PNG прозрачной поверхности
 *   с маргин-полем; иначе `layoutBounds` и `paintBounds` относились бы к разным кадрам (R1-M3).
 */
export async function captureCase(
  ctx: GateContext,
  options: { probe?: "geometry" | "paint"; paintMargin?: number; geometryDetailKeys?: string[] } = {},
): Promise<CaptureOutcome> {
  const budget = ctx.policy.maxInfraRetries;
  let lastOutcome: JobOutcome = "subprocess_error";
  let lastMessage = "capture did not run";
  let attempts = 0;
  for (let attempt = 0; attempt <= budget; attempt++) {
    attempts = attempt + 1;
    if (attempt > 0) {
      const backoff = Math.min(QUEUE_BACKOFF_BASE_MS * 2 ** (attempt - 1), QUEUE_BACKOFF_MAX_MS);
      await ctx.sleep(lastOutcome === "queue_full" ? backoff : QUEUE_BACKOFF_BASE_MS);
    }
    // Резервирование очереди (план §4.7): фоновой джобе отказано — это тот же `queue_full`,
    // только без броска; ждём слот в рамках того же бюджета ретраев.
    if (!ctx.service.hasBackgroundCapacity()) {
      lastOutcome = "queue_full";
      lastMessage = "screenshot queue has no background capacity";
      continue;
    }
    let jobId: string;
    try {
      const enqueued = await ctx.service.enqueueComponentCandidate(
        ctx.candidate.componentId,
        { rev: ctx.candidate.rev, sourceHash: ctx.candidate.sourceHash },
        {
          props: ctx.case.props,
          viewport: ctx.surface.viewport,
          deviceScaleFactor: ctx.surface.dsf,
          theme: ctx.surface.theme,
          background: true,
          // W5 (§T5c.6): режим поверхности едет до браузера. Условным спредом — hug-джоба обязана
          // остаться байт-в-байт прежней вплоть до bootstrap'а.
          ...(ctx.surface.mode === undefined ? {} : { surface: ctx.surface.mode }),
          // W4: политику readiness приносит профиль приёмки — «подождать подольше» перестаёт
          // быть решением клиента, а её хэш обязан совпасть с тем, что войдёт в отпечаток случая.
          readinessPolicy: ctx.policy.readiness,
          // Слоты случая (план 2026-08-05 §A6). Условным спредом, а не `?? []`: отсутствие —
          // самостоятельный факт, и оно обязано оставлять постановку бесслотовой байт-в-байт.
          ...(ctx.case.slotBindings === undefined ? {} : { slotBindings: ctx.case.slotBindings }),
          ...(ctx.case.slotsHash === undefined ? {} : { slotsHash: ctx.case.slotsHash }),
          // Paint-джоба тоже отдаёт байты: кадр — половина её исхода, и он уезжает в CAS.
          ...(options.probe === undefined ? { deliver: "bytes" as const } : { probe: options.probe }),
          ...(options.probe === "paint"
            ? {
              deliver: "bytes" as const,
              ...(options.paintMargin === undefined ? {} : { paintMargin: options.paintMargin }),
              geometryDetailKeys: options.geometryDetailKeys ?? [],
            }
            : {}),
        },
      );
      jobId = enqueued.jobId;
    } catch (error) {
      if (isProductRefusal(error)) throw error;
      lastOutcome = jobOutcomeOfError(error);
      lastMessage = error instanceof Error ? error.message : String(error);
      if (!isRetryable(lastOutcome)) throw error;
      continue;
    }
    const finished = await awaitJob(ctx, jobId);
    if (finished.error) {
      lastOutcome = ctx.service.outcome(jobId) ?? jobOutcomeOfError(new Error(finished.error.message));
      lastMessage = finished.error.message;
      // Терминальный исход обрывает цикл сразу: следующая попытка не может дать другого ответа.
      if (!isRetryable(lastOutcome)) break;
      continue;
    }
    const result = finished.result;
    if (!result) {
      lastOutcome = "subprocess_error";
      lastMessage = "capture job produced no result";
      continue;
    }
    const quality = qualityOf(result);
    if (result.kind === "geometry") {
      const geometry: Record<string, unknown> = { ...result };
      delete geometry.kind;
      return { jobId, retries: attempt, quality, geometry, ...(result.receiptSha256 === undefined ? {} : { receiptSha256: result.receiptSha256 }) };
    }
    if (result.kind === "paint") {
      const geometry: Record<string, unknown> = { ...result };
      delete geometry.kind;
      delete geometry.bytes;
      return {
        jobId, retries: attempt, quality, geometry,
        image: { bytes: result.bytes, width: result.width, height: result.height },
        paintMargin: result.paintMargin,
        browserVersion: result.browserVersion,
        ...(result.receiptSha256 === undefined ? {} : { receiptSha256: result.receiptSha256 }),
        ...(readinessOf(result) ? { readiness: readinessOf(result)! } : {}),
      };
    }
    if (result.kind === "image-bytes") {
      return {
        jobId, retries: attempt, quality,
        image: { bytes: result.bytes, width: result.width, height: result.height },
        browserVersion: result.browserVersion,
        ...(result.receiptSha256 === undefined ? {} : { receiptSha256: result.receiptSha256 }),
        ...(readinessOf(result) ? { readiness: readinessOf(result)! } : {}),
      };
    }
    // `deliver:"asset"` в приёмке не используется: он ингестит кадр в asset-store (A4).
    lastOutcome = "subprocess_error";
    lastMessage = `unexpected capture result kind: ${result.kind}`;
  }
  // Число попыток — фактическое: терминальный исход обрывает цикл, и врать про исчерпанный
  // бюджет в диагностике нельзя.
  throw new CaptureInfraError(lastOutcome, attempts, `capture failed after ${attempts} attempts (${lastOutcome}): ${lastMessage}`);
}
