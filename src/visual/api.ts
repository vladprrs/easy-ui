/**
 * Local API client for the visual-regression surface. Kept inside the feature
 * folder (not src/api/client.ts) so T7 owns its own transport; errors reuse the
 * shared ApiError class so the server `code` survives for formatApiError (W0-5).
 */
import { ApiError, type ApiErrorBody } from "../api/client";

export interface MetricResult { diffPixels: number; totalPixels: number; diffPercent: number }
export interface EvidenceAsset { assetId: string; url: string; sha256: string; width: number | null; height: number | null; mime: string }
export type RunStatus = "pass" | "fail" | "error" | "reference_missing" | "reference_unknown" | "running";

export interface RunReport {
  runId: string;
  referenceId: string;
  status: RunStatus;
  createdAt?: string;
  jobId?: string;
  metric?: string | null;
  metricOptions?: Record<string, unknown> | null;
  diffPixels?: number | null;
  totalPixels?: number | null;
  diffPercent?: number | null;
  metrics?: { "exact-rgba"?: MetricResult; "pixelmatch-v1"?: MetricResult };
  referenceStatus?: "known" | "unknown";
  reference?: EvidenceAsset | null;
  candidate?: EvidenceAsset | null;
  diff?: { assetId: string; url: string } | null;
  candidateMeta?: Record<string, unknown> | null;
}

export interface AssetPublic { id: string; url: string; sha256: string; mime: string; size: number; width?: number; height?: number }
export interface VisualReference {
  id: string;
  fingerprint: Record<string, unknown>;
  note: string | null;
  createdAt: string;
  asset: AssetPublic | null;
  lastRun: RunReport | null;
}
export interface VisualReferenceDetail extends VisualReference { runs: RunReport[] }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    // W0-5: сохраняем ApiError.code (раньше обёртка теряла его, оставляя только message).
    let error: ApiErrorBody = { code: "http_error", message: `Не удалось выполнить запрос к API (${response.status})` };
    try {
      const body = await response.json() as { error?: Partial<ApiErrorBody> };
      if (body.error && typeof body.error.code === "string" && typeof body.error.message === "string") error = body.error as ApiErrorBody;
    } catch { /* keep fallback for non-JSON error responses */ }
    throw new ApiError(response.status, error);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

export const listVisualReferences = (scope: string | null, signal?: AbortSignal) =>
  request<{ references: VisualReference[] }>(`/api/visual-references${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`, { signal });

export const getVisualReference = (id: string, signal?: AbortSignal) =>
  request<VisualReferenceDetail>(`/api/visual-references/${encodeURIComponent(id)}`, { signal });

export const putVisualReference = (fingerprint: Record<string, unknown>, assetId: string, note?: string) =>
  request<VisualReference>("/api/visual-references", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ fingerprint, assetId, ...(note ? { note } : {}) }) });

export const checkVisualReference = (id: string, threshold?: number) =>
  request<{ runId: string; jobId?: string }>(`/api/visual-references/${encodeURIComponent(id)}/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(threshold === undefined ? {} : { threshold }) });

export const getVisualRun = (runId: string, signal?: AbortSignal) =>
  request<RunReport>(`/api/visual-runs/${encodeURIComponent(runId)}`, { signal });

export const deleteVisualReference = (id: string) =>
  request<void>(`/api/visual-references/${encodeURIComponent(id)}`, { method: "DELETE" });

export interface ScreenshotJobResult {
  imageUrl: string;
  assetId: string;
  width: number;
  height: number;
  consoleErrors: string[];
  pageErrors: string[];
}

export interface ScreenshotJob {
  status: "queued" | "running" | "done" | "error";
  result?: ScreenshotJobResult;
  error?: { code: string; message: string };
}

interface CaptureOptions {
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  theme: "light" | "dark";
  waitForFonts: boolean;
}

export const enqueuePrototypeScreenshot = (prototypeId: string, screenId: string, target: { rev: number } | { version: number }, options: CaptureOptions) =>
  request<{ jobId: string }>(`/api/prototypes/${encodeURIComponent(prototypeId)}/screens/${encodeURIComponent(screenId)}/screenshot`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...target, ...options }),
  });

export const enqueueComponentScreenshot = (componentId: string, version: number, options: CaptureOptions) =>
  request<{ jobId: string }>(`/api/components/${encodeURIComponent(componentId)}/versions/${version}/screenshot`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(options),
  });

export const getScreenshotJob = (jobId: string, signal?: AbortSignal) =>
  request<ScreenshotJob>(`/api/screenshot-jobs/${encodeURIComponent(jobId)}`, { signal });
