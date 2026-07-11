import type { PrototypeDoc } from "../prototype/schema";

export interface ApiErrorBody {
  code: string;
  message: string;
  issues?: unknown[];
  warnings?: unknown[];
  currentRev?: number;
  currentVersion?: number;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues?: unknown[];
  readonly warnings?: unknown[];
  readonly currentRev?: number;
  readonly currentVersion?: number;

  constructor(status: number, error: ApiErrorBody) {
    super(error.message);
    this.name = "ApiError";
    this.status = status;
    this.code = error.code;
    this.issues = error.issues;
    this.warnings = error.warnings;
    this.currentRev = error.currentRev;
    this.currentVersion = error.currentVersion;
  }
}

export interface PrototypeSummary {
  id: string;
  name: string;
  description?: string;
  device: PrototypeDoc["device"];
  designSystem?: string;
  screenCount: number;
  headRev: number;
  latestVersion: number | null;
  updatedAt: string;
}

export interface PrototypeVersionSummary { version: number; rev: number; publishedAt: string }
export interface PrototypeMeta {
  id: string;
  name: string;
  designSystem: string;
  headRev: number;
  latestVersion: number | null;
  versions: PrototypeVersionSummary[];
  updatedAt: string;
}
export interface PrototypeComponentPin { id: string; name: string; version: number; bundleUrl: string; bundleHash: string }
export interface PrototypeDraft {
  doc: PrototypeDoc;
  rev: number;
  builtinCatalogHash: string;
  componentManifestHash: string;
  components: PrototypeComponentPin[];
}
export interface PrototypeVersion extends PrototypeDraft { version: number; publishedAt: string }
export interface PrototypeRevisionSummary { rev: number; message: string | null; createdAt: string }
export interface PrototypeRevision { rev: number; doc: PrototypeDoc; components: PrototypeComponentPin[]; message: string | null; createdAt: string }
export interface SavePrototypeResult { rev: number; warnings: unknown[] }

export type AtomicLevel = "atom" | "molecule" | "organism" | "template" | "page";
export interface ComponentSummary { id: string; name: string; designSystem: string; headRev: number; latestVersion: number | null; updatedAt: string }
export interface ComponentMeta { id: string; name: string; designSystem: string; headRev: number; versions: PrototypeVersionSummary[]; updatedAt: string }
export interface CatalogComponent { id: string; name: string; designSystem: string; version: number; bundleUrl: string; bundleHash: string; atomicLevel?: AtomicLevel; description: string; events: string[]; slots: string[]; hostAbiVersion: number }
export interface CatalogManifest { components: CatalogComponent[] }
export interface DesignSystemComponent { name: string; atomicLevel: AtomicLevel; layoutNeutral: boolean; description: string; events: string[]; slots: string[] }
export interface DesignSystemSummary { id: string; name: string; description: string; builtinCatalogHash: string; components: DesignSystemComponent[] }

type RequestOptions = Omit<RequestInit, "body"> & { body?: unknown };

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, headers, ...init } = options;
  const response = await fetch(path, {
    ...init,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    let error: ApiErrorBody = { code: "http_error", message: `API request failed (${response.status})` };
    try {
      const value = await response.json() as { error?: Partial<ApiErrorBody> };
      if (value.error && typeof value.error.code === "string" && typeof value.error.message === "string") error = value.error as ApiErrorBody;
    } catch { /* Preserve the fallback for a non-JSON error response. */ }
    throw new ApiError(response.status, error);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

const prototypePath = (id: string) => `/api/prototypes/${encodeURIComponent(id)}`;
const componentPath = (id: string) => `/api/components/${encodeURIComponent(id)}`;

export const listPrototypes = (signal?: AbortSignal) => request<PrototypeSummary[]>("/api/prototypes", { signal });
export const listDesignSystems = (signal?: AbortSignal) => request<{designSystems: DesignSystemSummary[]}>("/api/design-systems", { signal });
export const getCatalogManifest = (signal?: AbortSignal) => request<CatalogManifest>("/api/catalog/manifest", { signal });
export const getDesignSystemById = (id: string, signal?: AbortSignal) => request<DesignSystemSummary>(`/api/design-systems/${encodeURIComponent(id)}`, { signal });
export const createDesignSystem = (id: string, name: string, description: string, signal?: AbortSignal) => request<DesignSystemSummary>("/api/design-systems", { method: "POST", body: { id, name, description }, signal });
export const listComponents = (signal?: AbortSignal) => request<ComponentSummary[]>("/api/components", { signal });
export const getComponentMeta = (id: string, signal?: AbortSignal) => request<ComponentMeta>(componentPath(id), { signal });
export const createPrototype = (doc: PrototypeDoc, message?: string, signal?: AbortSignal) => request<{id: string; rev: 1; warnings: unknown[]}>("/api/prototypes", { method: "POST", body: { doc, message }, signal });
export const getPrototypeMeta = (id: string, signal?: AbortSignal) => request<PrototypeMeta>(prototypePath(id), { signal });
export const getPrototypeDraft = (id: string, signal?: AbortSignal) => request<PrototypeDraft>(`${prototypePath(id)}/draft`, { signal });
export const savePrototype = (id: string, doc: PrototypeDoc, baseRev: number, message?: string, signal?: AbortSignal) => request<SavePrototypeResult>(prototypePath(id), { method: "PUT", body: { doc, baseRev, message }, signal });
export const deletePrototype = (id: string, baseRev: number, signal?: AbortSignal) => request<void>(prototypePath(id), { method: "DELETE", body: { baseRev }, signal });
export const listPrototypeRevisions = (id: string, options: {limit?: number; before?: number; signal?: AbortSignal} = {}) => {
  const query = new URLSearchParams();
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  if (options.before !== undefined) query.set("before", String(options.before));
  const suffix = query.size ? `?${query}` : "";
  return request<PrototypeRevisionSummary[]>(`${prototypePath(id)}/revisions${suffix}`, { signal: options.signal });
};
export const getPrototypeRevision = (id: string, rev: number, signal?: AbortSignal) => request<PrototypeRevision>(`${prototypePath(id)}/revisions/${rev}`, { signal });
export const restorePrototype = (id: string, rev: number, baseRev: number, signal?: AbortSignal) => request<{rev: number}>(`${prototypePath(id)}/restore`, { method: "POST", body: { rev, baseRev }, signal });
export const publishPrototype = (id: string, baseRev: number, message?: string, signal?: AbortSignal) => request<{version: number; rev: number}>(`${prototypePath(id)}/publish`, { method: "POST", body: { baseRev, message }, signal });
export const listPrototypeVersions = (id: string, signal?: AbortSignal) => request<PrototypeVersionSummary[]>(`${prototypePath(id)}/versions`, { signal });
export const getPrototypeVersion = (id: string, version: number, signal?: AbortSignal) => request<PrototypeVersion>(`${prototypePath(id)}/versions/${version}`, { signal });
