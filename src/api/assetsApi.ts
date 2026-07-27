/**
 * Local API client for the asset workbench (волна 7.4). Kept inside src/api as a separate
 * module (not client.ts) so the workbench owns its own transport; errors reuse the shared
 * ApiError class so the server `code` survives for formatApiError.
 *
 * Endpoints are the existing ones — GET /api/assets (cursor page + usage counts),
 * GET /api/assets/:id/usage (full pin graph). Shapes mirror server/contracts.ts
 * (listAssetsContract / assetUsageContract) exactly.
 */
import { ApiError, type ApiErrorBody } from "./client";

export interface AssetUsageCounts {
  prototypes: number;
  components: number;
  visualReferences: number;
  visualRuns: number;
}

/** Одна запись `GET /api/assets` (strictAssetMetadataSchema + usage-счётчики). */
export interface AssetListItem {
  id: string;
  sha256: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  originalName: string | null;
  createdAt: string;
  url: string;
  usage: AssetUsageCounts;
}

export interface AssetListPage {
  assets: AssetListItem[];
  nextCursor: string | null;
}

export interface AssetUsageGraph {
  asset: Omit<AssetListItem, "usage">;
  prototypes: { id: string; name: string; revCount: number; lastRev: number; pinnedAtHead: boolean }[];
  components: { id: string; name: string; versions: number[] }[];
  visualReferences: { id: string; deleted: boolean }[];
  visualRuns: { id: string; referenceId: string; role: "reference" | "candidate" | "diff" }[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  if (!response.ok) {
    let error: ApiErrorBody = { code: "http_error", message: `Не удалось выполнить запрос к API (${response.status})` };
    try {
      const body = await response.json() as { error?: Partial<ApiErrorBody> };
      if (body.error && typeof body.error.code === "string" && typeof body.error.message === "string") error = body.error as ApiErrorBody;
    } catch { /* keep fallback for non-JSON error responses */ }
    throw new ApiError(response.status, error);
  }
  return await response.json() as T;
}

export const ASSET_PAGE_LIMIT = 200; // серверный максимум listAssetsQuerySchema
export const ASSET_PAGE_BUDGET = 10; // не больше 2000 ассетов за один заход страницы

export const listAssetsPage = (cursor: string | null, signal?: AbortSignal) =>
  request<AssetListPage>(`/api/assets?limit=${ASSET_PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { signal });

/**
 * Собирает страницы курсором до бюджета. `truncated` честно сообщает, что на сервере
 * остались ещё ассеты и клиентские сводки (дубликаты, эвристики) считаются по срезу.
 */
export async function listAllAssets(signal?: AbortSignal): Promise<{ assets: AssetListItem[]; truncated: boolean }> {
  const assets: AssetListItem[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < ASSET_PAGE_BUDGET; page += 1) {
    const result: AssetListPage = await listAssetsPage(cursor, signal);
    assets.push(...result.assets);
    cursor = result.nextCursor;
    if (!cursor) return { assets, truncated: false };
  }
  return { assets, truncated: true };
}

export const getAssetUsage = (id: string, signal?: AbortSignal) =>
  request<AssetUsageGraph>(`/api/assets/${encodeURIComponent(id)}/usage`, { signal });
