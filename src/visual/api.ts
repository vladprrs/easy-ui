/**
 * Local API client for the visual-regression surface. Kept inside the feature
 * folder (not src/api/client.ts) so T7 owns its own transport.
 */

export interface MetricResult { diffPixels: number; totalPixels: number; diffPercent: number }
export interface EvidenceAsset { assetId: string; url: string; sha256: string; width: number | null; height: number | null; mime: string }
export type RunStatus = "pass" | "fail" | "error" | "reference_missing" | "running";

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
    let message = `Request failed (${response.status})`;
    try { const body = await response.json() as { error?: { message?: string } }; if (body.error?.message) message = body.error.message; } catch { /* keep fallback */ }
    throw new Error(message);
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

export async function uploadPngAsset(file: File): Promise<AssetPublic> {
  const form = new FormData();
  form.append("file", file);
  return request<AssetPublic>("/api/assets", { method: "POST", body: form });
}
