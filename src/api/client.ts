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

// Figma provenance (plan §J): an immutable per-revision link back to the source Figma file.
export interface FigmaProvenance { fileKey: string; nodeIds: string[]; referenceScreenshots?: string[]; lastSyncedAt?: string }

export interface PrototypeVersionSummary { version: number; rev: number; publishedAt: string }
export interface PrototypeMeta {
  id: string;
  name: string;
  designSystem: string;
  headRev: number;
  latestVersion: number | null;
  versions: PrototypeVersionSummary[];
  updatedAt: string;
  figma?: FigmaProvenance | null;
}
export interface PrototypeComponentPin { id: string; name: string; version: number; bundleUrl: string; bundleHash: string }
export interface AssetPin { id: string; sha256: string; mime: string; size: number }
export interface PrototypeDraft {
  doc: PrototypeDoc;
  rev: number;
  builtinCatalogHash: string;
  componentManifestHash: string;
  components: PrototypeComponentPin[];
  designSystemMetaVersion?: number | null;
  // Asset pins and figma provenance of the revision (WF-5). Optional in the type because test
  // fixtures elide them, but the server always includes both (figma is null for legacy revisions).
  assets?: AssetPin[];
  figma?: FigmaProvenance | null;
}
export interface PrototypeVersion extends PrototypeDraft { version: number; publishedAt: string }
export interface PrototypeRevisionSummary { rev: number; message: string | null; createdAt: string }
export interface PrototypeRevision { rev: number; doc: PrototypeDoc; components: PrototypeComponentPin[]; message: string | null; createdAt: string; designSystemMetaVersion?: number | null }
export interface SavePrototypeResult { rev: number; warnings: unknown[] }
export interface PublishPrototypeResult { version: number; rev: number; screens: { id: string; url: string }[] }

export type AtomicLevel = "atom" | "molecule" | "organism" | "template" | "page";
export interface ComponentSummary { id: string; name: string; designSystem: string; headRev: number; latestVersion: number | null; updatedAt: string }
export type ComponentStatus = "staging" | "active" | "failed" | "rejected" | "deprecated" | "superseded" | "archived";
export interface ComponentVersionSummary { version: number; rev: number; status: ComponentStatus; statusReason: string | null; supersededBy: number | null; statusRev: number; designSystem: string; publishedAt: string }
export interface ComponentMeta { id: string; name: string; designSystem: string; headRev: number; versions: ComponentVersionSummary[]; updatedAt: string; figma?: FigmaProvenance | null }
export interface ComponentStatusResult { status: ComponentStatus; statusRev: number }
export const setComponentVersionStatus = (id: string, version: number, change: { status: ComponentStatus; reason?: string; supersededBy?: number; baseStatusRev: number }, signal?: AbortSignal) =>
  request<ComponentStatusResult>(`${componentPath(id)}/versions/${version}/status`, { method: "POST", body: change, signal });
export interface CatalogComponent { id: string; name: string; designSystem: string; version: number; bundleUrl: string; bundleHash: string; atomicLevel?: AtomicLevel; description: string; events: string[]; slots: string[]; hostAbiVersion: number; example?: Record<string, unknown> }
export interface CatalogManifest { components: CatalogComponent[] }
export interface DesignSystemComponent { name: string; atomicLevel: AtomicLevel; layoutNeutral: boolean; description: string; events: string[]; slots: string[] }
export interface ThemeFont { family: string; src: string; weight?: number | string; style?: string }
export interface ThemeIcon { name: string; assetId: string; viewBox?: string; themes?: { light?: string; dark?: string } }
export interface ThemeContent { tokens: Record<string, string | number>; fonts: ThemeFont[]; icons: ThemeIcon[] }
export interface DesignSystemSummary { id: string; name: string; description: string; builtinCatalogHash: string; components: DesignSystemComponent[]; latestMetaVersion?: number | null; tokens?: ThemeContent["tokens"]; fonts?: ThemeContent["fonts"]; icons?: ThemeContent["icons"] }
export interface DesignSystemVersion extends ThemeContent { systemId: string; version: number; createdAt: string }

type RequestOptions = Omit<RequestInit, "body"> & { body?: unknown };

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, headers, ...init } = options;
  const response = await fetch(path, {
    ...init,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    let error: ApiErrorBody = { code: "http_error", message: `Не удалось выполнить запрос к API (${response.status})` };
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
export const getDesignSystemVersion = (id: string, version: number, signal?: AbortSignal) => request<DesignSystemVersion>(`/api/design-systems/${encodeURIComponent(id)}/versions/${version}`, { signal });
export interface ThemePatch { tokens?: Record<string, string | number>; fonts?: ThemeFont[]; icons?: ThemeIcon[]; baseVersion: number }
export const patchDesignSystemTheme = (id: string, patch: ThemePatch, signal?: AbortSignal) => request<DesignSystemSummary>(`/api/design-systems/${encodeURIComponent(id)}`, { method: "PATCH", body: patch, signal });
// Visual regression references (plan §E.6). The Library reads these to mark a component version
// Verified when its last run passed.
export type VisualRunStatus = "pass" | "fail" | "error" | "reference_missing";
export interface VisualRunReport { runId: string; referenceId: string; status: VisualRunStatus; createdAt: string; diffPercent: number | null }
export interface VisualComponentFingerprint { scope: "component"; componentId: string; refVersion: number; [key: string]: unknown }
export interface VisualReference { id: string; fingerprint: VisualComponentFingerprint | { scope: string; [key: string]: unknown }; note: string | null; createdAt: string; lastRun: VisualRunReport | null }
export const listVisualReferences = (params: { scope?: "prototype-screen" | "component"; componentId?: string; prototypeId?: string } = {}, signal?: AbortSignal) => {
  const query = new URLSearchParams();
  if (params.scope) query.set("scope", params.scope);
  if (params.componentId) query.set("componentId", params.componentId);
  if (params.prototypeId) query.set("prototypeId", params.prototypeId);
  const suffix = query.size ? `?${query}` : "";
  return request<{ references: VisualReference[] }>(`/api/visual-references${suffix}`, { signal });
};
export const listComponents = (signal?: AbortSignal) => request<ComponentSummary[]>("/api/components", { signal });
export const getComponentMeta = (id: string, signal?: AbortSignal) => request<ComponentMeta>(componentPath(id), { signal });
export const createPrototype = (doc: PrototypeDoc, message?: string, signal?: AbortSignal) => request<{id: string; rev: 1; warnings: unknown[]}>("/api/prototypes", { method: "POST", body: { doc, message }, signal });
export const getPrototypeMeta = (id: string, signal?: AbortSignal) => request<PrototypeMeta>(prototypePath(id), { signal });
export const getPrototypeDraft = (id: string, signal?: AbortSignal) => request<PrototypeDraft>(`${prototypePath(id)}/draft`, { signal });
// `figma` is intentionally a required argument (WF-5): the caller must pass either the provenance
// loaded with the draft (pass-through so an editor save does not silently erase it) or an explicit
// null meaning "the document never had one". Null is never sent to the server — the contract only
// allows an optional object, and the server treats `figma: null` as a clear.
export const savePrototype = (id: string, doc: PrototypeDoc, baseRev: number, figma: FigmaProvenance | null, message?: string, signal?: AbortSignal) => request<SavePrototypeResult>(prototypePath(id), { method: "PUT", body: { doc, baseRev, message, ...(figma ? { figma } : {}) }, signal });
export const deletePrototype = (id: string, baseRev: number, signal?: AbortSignal) => request<void>(prototypePath(id), { method: "DELETE", body: { baseRev }, signal });
export const listPrototypeRevisions = (id: string, options: {limit?: number; before?: number; signal?: AbortSignal} = {}) => {
  const query = new URLSearchParams();
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  if (options.before !== undefined) query.set("before", String(options.before));
  const suffix = query.size ? `?${query}` : "";
  return request<PrototypeRevisionSummary[]>(`${prototypePath(id)}/revisions${suffix}`, { signal: options.signal });
};
export const getPrototypeRevision = (id: string, rev: number, signal?: AbortSignal) => request<PrototypeRevision>(`${prototypePath(id)}/revisions/${rev}`, { signal });
export interface PrototypeRevisionFull extends PrototypeRevision { builtinCatalogHash: string; componentManifestHash: string }
export const getPrototypeRevisionFull = (id: string, rev: number, signal?: AbortSignal) => request<PrototypeRevisionFull>(`${prototypePath(id)}/revisions/${rev}`, { signal });
export interface ComponentVersion { version: number; rev: number; status?: ComponentStatus; statusReason?: string | null; supersededBy?: number | null; statusRev?: number; name?: string; source: string; designSystem: string; bundleHash: string; hostAbiVersion: number; events: string[]; slots: string[]; description?: string; example?: Record<string, unknown>; propsJsonSchema?: unknown; assets: { id: string; sha256: string; mime: string; size: number }[]; figma?: FigmaProvenance | null; publishedAt: string }
export const getComponentVersion = (id: string, version: number, signal?: AbortSignal) => request<ComponentVersion>(`${componentPath(id)}/versions/${version}`, { signal });
export const restorePrototype = (id: string, rev: number, baseRev: number, signal?: AbortSignal) => request<{rev: number}>(`${prototypePath(id)}/restore`, { method: "POST", body: { rev, baseRev }, signal });
export const publishPrototype = (id: string, baseRev: number, message?: string, signal?: AbortSignal) => request<PublishPrototypeResult>(`${prototypePath(id)}/publish`, { method: "POST", body: { baseRev, message }, signal });
export const listPrototypeVersions = (id: string, signal?: AbortSignal) => request<PrototypeVersionSummary[]>(`${prototypePath(id)}/versions`, { signal });
export const getPrototypeVersion = (id: string, version: number, signal?: AbortSignal) => request<PrototypeVersion>(`${prototypePath(id)}/versions/${version}`, { signal });
