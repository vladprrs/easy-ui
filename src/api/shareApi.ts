import { ApiError, type ApiErrorBody } from "./client";

export interface ShareGrant {
  id: string;
  prototypeId: string;
  version: number;
  createdAt: string;
  expiresAt: string;
  activeSessions: number;
}

export interface CreatedShareGrant extends ShareGrant { url: string }

async function request<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method,
    signal: options.signal,
    headers: options.body === undefined ? undefined : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) {
    let error: ApiErrorBody = { code: "http_error", message: `Не удалось выполнить запрос к API (${response.status})` };
    try {
      const value = await response.json() as { error?: ApiErrorBody };
      if (value.error?.code && value.error.message) error = value.error;
    } catch { /* Keep the HTTP fallback for non-JSON proxy/auth errors. */ }
    throw new ApiError(response.status, error);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

const pathFor = (prototypeId: string) => `/api/prototypes/${encodeURIComponent(prototypeId)}/share`;

export const createPrototypeShare = (prototypeId: string, version: number, ttlSeconds: number, signal?: AbortSignal) =>
  request<CreatedShareGrant>(pathFor(prototypeId), { method: "POST", body: { version, ttlSeconds }, signal });

export const listPrototypeShares = (prototypeId: string, signal?: AbortSignal) =>
  request<{ shares: ShareGrant[] }>(pathFor(prototypeId), { signal });

export const revokePrototypeShare = (prototypeId: string, shareId: string, signal?: AbortSignal) =>
  request<void>(`${pathFor(prototypeId)}/${encodeURIComponent(shareId)}`, { method: "DELETE", signal });
