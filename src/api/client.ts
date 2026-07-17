import type { PrototypeDoc, RegionKind } from "../prototype/schema";
import type { ComponentLayout, SpaceToken } from "../designSystems/types";

export interface ValidationIssue {
  path: string | (string | number)[];
  pointer?: string;
  message: string;
  code?: string;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  issues?: ValidationIssue[];
  warnings?: unknown[];
  currentRev?: number;
  currentVersion?: number;
}

export interface AuthUser {
  userId: string;
  name: string;
  isAdmin: boolean;
}

export interface UserSummary {
  id: string;
  name: string;
  isAdmin: boolean;
  createdAt: string;
}

export interface LoginInput { name: string; password: string; next?: string }
export interface LoginResult { user: AuthUser; next?: string }
export interface CreateUserInput { name: string; password: string; isAdmin?: boolean }

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues?: ValidationIssue[];
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
  status: PrototypeStatus;
  owner: ResourceOwner;
}

export interface ResourceOwner { id: string; name: string }
export type PrototypeStatus = "private" | "published" | "archived";

// Figma provenance (plan §J): an immutable per-revision link back to the source Figma file.
export interface FigmaProvenance { fileKey: string; nodeIds: string[]; referenceScreenshots?: string[]; lastSyncedAt?: string }

export interface PrototypeRenderError { code: "prototype_not_renderable"; message: string; issues: { path: string; message: string }[] }
export interface PrototypeVersionSummary { version: number; rev: number; publishedAt: string; renderable?: boolean; renderError?: PrototypeRenderError | null }
export interface PrototypeMeta {
  id: string;
  prototypeInstanceId?: string;
  name: string;
  designSystem: string;
  headRev: number;
  latestVersion: number | null;
  versions: PrototypeVersionSummary[];
  updatedAt: string;
  figma?: FigmaProvenance | null;
  status: PrototypeStatus;
  owner: ResourceOwner;
}
export interface PrototypeComponentPin { id: string; name: string; version: number; bundleUrl: string; bundleHash: string }
export interface AssetPin { id: string; sha256: string; mime: string; size: number }
export interface UploadedAsset extends AssetPin { url: string; width?: number; height?: number; deduplicated?: true }
export interface EditorAsset extends AssetPin { name?: string }
export interface PrototypeDraft {
  doc: PrototypeDoc;
  rev: number;
  prototypeInstanceId?: string;
  builtinCatalogHash: string;
  componentManifestHash: string;
  components: PrototypeComponentPin[];
  designSystemMetaVersion?: number | null;
  // Asset pins and figma provenance of the revision (WF-5). Optional in the type because test
  // fixtures elide them, but the server always includes both (figma is null for legacy revisions).
  assets?: AssetPin[];
  figma?: FigmaProvenance | null;
  renderable?: boolean;
  renderError?: PrototypeRenderError | null;
}
export interface PrototypeVersion extends PrototypeDraft { version: number; publishedAt: string }
export interface PrototypeRevisionSummary { rev: number; message: string | null; createdAt: string }
export interface PrototypeRevision extends PrototypeDraft { message: string | null; createdAt: string }
export interface SavePrototypeResult { rev: number; warnings: unknown[] }
export interface PublishPrototypeResult { version: number; rev: number; screens: { id: string; url: string }[] }

export type AtomicLevel = "atom" | "molecule" | "organism" | "template" | "page";
export interface ComponentSummary { id: string; name: string; designSystem: string; headRev: number; latestVersion: number | null; updatedAt: string }
export type ComponentStatus = "staging" | "active" | "failed" | "rejected" | "deprecated" | "superseded" | "archived";
export interface ComponentVersionSummary { version: number; rev: number; status: ComponentStatus; statusReason: string | null; supersededBy: number | null; statusRev: number; designSystem: string; publishedAt: string }
export interface ComponentMeta { id: string; name: string; designSystem: string; headRev: number; publishedVersion?: number | null; versions: ComponentVersionSummary[]; updatedAt: string; figma?: FigmaProvenance | null }
export interface ComponentStatusResult { status: ComponentStatus; statusRev: number }
export const setComponentVersionStatus = (id: string, version: number, change: { status: ComponentStatus; reason?: string; supersededBy?: number; baseStatusRev: number }, signal?: AbortSignal) =>
  request<ComponentStatusResult>(`${componentPath(id)}/versions/${version}/status`, { method: "POST", body: change, signal });
export interface SerializedComponentDefinition {
  atomicLevel?: AtomicLevel;
  layoutNeutral?: boolean;
  layout?: ComponentLayout;
  description?: string;
  events: string[];
  eventPayloads?: Record<string, unknown>;
  capabilities?: { typedEvents?: true; namedSlots?: true };
  slots: string[];
  example?: Record<string, unknown>;
  examples?: Record<string, Record<string, unknown>>;
  propsJsonSchema?: unknown;
}
export interface CatalogComponent extends SerializedComponentDefinition { id: string; name: string; designSystem: string; version: number; bundleUrl: string; bundleHash: string; hostAbiVersion: number; description: string }
export interface CatalogManifest { components: CatalogComponent[] }
export interface DesignSystemComponent extends SerializedComponentDefinition { name: string; layoutNeutral: boolean; description: string }
export interface HostPrimitiveDescriptor extends SerializedComponentDefinition { name: string; description: string }
export interface ThemeFont { family: string; src: string; weight?: number | string; style?: string }
export interface ThemeIcon { name: string; assetId: string; viewBox?: string; themes?: { light?: string; dark?: string } }
export interface ThemeContent { tokens: Record<string, string | number>; fonts: ThemeFont[]; icons: ThemeIcon[] }
export interface DesignSystemSummary { id: string; name: string; description: string; builtinCatalogHash: string; resolvedSpaceScale?: Record<SpaceToken, string>; components: DesignSystemComponent[]; hostPrimitives?: HostPrimitiveDescriptor[]; latestMetaVersion?: number | null; tokens?: ThemeContent["tokens"]; fonts?: ThemeContent["fonts"]; icons?: ThemeContent["icons"] }
export interface DesignSystemVersion extends ThemeContent { systemId: string; version: number; createdAt: string }
export interface Capabilities {
  apiVersion: 1;
  documentVersion: 1;
  layoutContractVersion: 1;
  actions: string[];
  directives: string[];
  paramSources: string[];
  conditions: string[];
  limits: Record<string, number>;
  designSystems: string[];
  resolvedSpaceScales: Record<string, Record<SpaceToken, string>>;
  regions: RegionKind[];
  features: Record<string, boolean> & { layoutContract: true; screenRegions: true };
}

type RequestOptions = Omit<RequestInit, "body"> & { body?: unknown; redirectOnUnauthorized?: boolean };

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, headers, redirectOnUnauthorized = true, ...init } = options;
  const response = await fetch(path, {
    ...init,
    credentials: init.credentials ?? "same-origin",
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return undefined as T;
  return responseJson<T>(response, redirectOnUnauthorized);
}

async function responseJson<T>(response: Response, redirectOnUnauthorized = true): Promise<T> {
  if (!response.ok) {
    let error: ApiErrorBody = { code: "http_error", message: `Не удалось выполнить запрос к API (${response.status})` };
    try {
      const value = await response.json() as { error?: Partial<ApiErrorBody> };
      if (value.error && typeof value.error.code === "string" && typeof value.error.message === "string") error = value.error as ApiErrorBody;
    } catch { /* Preserve the fallback for a non-JSON error response. */ }
    if (response.status === 401 && redirectOnUnauthorized) redirectUnauthorizedRequest();
    throw new ApiError(response.status, error);
  }
  return await response.json() as T;
}

/** Нормализует только same-origin relative path, пригодный для auth redirect. */
export function validateNextPath(next: string | null | undefined, origin = globalThis.location?.origin): string | null {
  if (!next || !origin || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return null;
  try {
    const resolved = new URL(next, origin);
    return resolved.origin === origin ? `${resolved.pathname}${resolved.search}${resolved.hash}` : null;
  } catch {
    return null;
  }
}

export function loginRedirectForLocation(location: Pick<Location, "origin" | "pathname" | "search" | "hash">): string | null {
  if (location.pathname === "/login" || location.pathname === "/share" || location.pathname.startsWith("/share/")) return null;
  const next = validateNextPath(`${location.pathname}${location.search}${location.hash}`, location.origin);
  return next ? `/login?${new URLSearchParams({ next }).toString()}` : "/login";
}

function redirectUnauthorizedRequest(): void {
  if (typeof globalThis.location === "undefined") return;
  const target = loginRedirectForLocation(globalThis.location);
  if (target) globalThis.location.assign(target);
}

export const login = (input: LoginInput, signal?: AbortSignal) => request<LoginResult>("/api/auth/login", { method: "POST", body: input, signal });
export const logout = (signal?: AbortSignal) => request<void>("/api/auth/logout", { method: "POST", signal });
export const getMe = (signal?: AbortSignal) => request<AuthUser>("/api/auth/me", { signal, redirectOnUnauthorized: false });
export const listUsers = (signal?: AbortSignal) => request<{ users: UserSummary[] }>("/api/users", { signal });
export const createUser = (input: CreateUserInput, signal?: AbortSignal) => request<UserSummary>("/api/users", { method: "POST", body: input, signal });

type EditorAssetSet = { draft: EditorAsset[]; local: EditorAsset[]; snapshot: EditorAsset[] };
const editorAssetsByPrototype = new Map<string, EditorAssetSet>();
const revisionAssetsByPrototype = new Map<string, Map<number, EditorAsset[]>>();
const editorAssetListeners = new Set<() => void>();
let activeEditorPrototypeId: string | null = null;
const EMPTY_EDITOR_ASSETS: EditorAsset[] = [];

function mergeEditorAssets(draft: EditorAsset[], local: EditorAsset[]): EditorAsset[] {
  const merged = new Map(draft.map((asset) => [asset.id, asset]));
  for (const asset of local) merged.set(asset.id, { ...merged.get(asset.id), ...asset });
  return [...merged.values()];
}

function updateEditorAssets(prototypeId: string, patch: Partial<Pick<EditorAssetSet, "draft" | "local">>) {
  const current = editorAssetsByPrototype.get(prototypeId) ?? { draft: [], local: [], snapshot: [] };
  const draft = patch.draft ?? current.draft;
  const local = patch.local ?? current.local;
  editorAssetsByPrototype.set(prototypeId, { draft, local, snapshot: mergeEditorAssets(draft, local) });
  editorAssetListeners.forEach((listener) => listener());
}

/** Текущий union пинов ревизии и загрузок этой SPA-сессии редактора (W5-6). */
export const getEditorAssetsSnapshot = (): EditorAsset[] => activeEditorPrototypeId === null
  ? EMPTY_EDITOR_ASSETS
  : editorAssetsByPrototype.get(activeEditorPrototypeId)?.snapshot ?? EMPTY_EDITOR_ASSETS;
export const subscribeEditorAssets = (listener: () => void) => { editorAssetListeners.add(listener); return () => editorAssetListeners.delete(listener); };

function rememberDraftAssets(prototypeId: string, draft: PrototypeDraft): PrototypeDraft {
  activeEditorPrototypeId = prototypeId;
  updateEditorAssets(prototypeId, { draft: draft.assets ?? [] });
  return draft;
}

/** POST-only upload: the server intentionally has no asset-collection GET endpoint. */
export async function uploadAsset(file: File, signal?: AbortSignal): Promise<UploadedAsset> {
  const form = new FormData();
  form.append("file", file);
  const uploaded = await responseJson<UploadedAsset>(await fetch("/api/assets", { method: "POST", body: form, signal }));
  if (activeEditorPrototypeId !== null) {
    const current = editorAssetsByPrototype.get(activeEditorPrototypeId) ?? { draft: [], local: [], snapshot: [] };
    updateEditorAssets(activeEditorPrototypeId, { local: [...current.local.filter((asset) => asset.id !== uploaded.id), { id: uploaded.id, sha256: uploaded.sha256, mime: uploaded.mime, size: uploaded.size, name: file.name }] });
  }
  return uploaded;
}

const prototypePath = (id: string) => `/api/prototypes/${encodeURIComponent(id)}`;
const componentPath = (id: string) => `/api/components/${encodeURIComponent(id)}`;

export const listPrototypes = (signal?: AbortSignal) => request<PrototypeSummary[]>("/api/prototypes", { signal });
export const listDesignSystems = (signal?: AbortSignal) => request<{designSystems: DesignSystemSummary[]}>("/api/design-systems", { signal });
export const getCapabilities = (signal?: AbortSignal) => request<Capabilities>("/api/capabilities", { signal });
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
export const getPrototypeDraft = async (id: string, signal?: AbortSignal) => rememberDraftAssets(id, await request<PrototypeDraft>(`${prototypePath(id)}/draft`, { signal }));
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
export type PrototypeRevisionFull = PrototypeRevision;
export const getPrototypeRevisionFull = async (id: string, rev: number, signal?: AbortSignal) => {
  const revision = await request<PrototypeRevisionFull>(`${prototypePath(id)}/revisions/${rev}`, { signal });
  const cached = revisionAssetsByPrototype.get(id) ?? new Map<number, EditorAsset[]>();
  cached.set(rev, revision.assets ?? []);
  revisionAssetsByPrototype.set(id, cached);
  return revision;
};
export interface ComponentVersion extends SerializedComponentDefinition { version: number; rev: number; status?: ComponentStatus; statusReason?: string | null; supersededBy?: number | null; statusRev?: number; name?: string; source: string; designSystem: string; bundleHash: string; hostAbiVersion: number; assets: { id: string; sha256: string; mime: string; size: number }[]; figma?: FigmaProvenance | null; publishedAt: string }
export const getComponentVersion = (id: string, version: number, signal?: AbortSignal) => request<ComponentVersion>(`${componentPath(id)}/versions/${version}`, { signal });
export const restorePrototype = async (id: string, rev: number, baseRev: number, signal?: AbortSignal) => {
  const restored = await request<{rev: number}>(`${prototypePath(id)}/restore`, { method: "POST", body: { rev, baseRev }, signal });
  const assets = revisionAssetsByPrototype.get(id)?.get(rev);
  if (assets) { activeEditorPrototypeId = id; updateEditorAssets(id, { draft: assets }); }
  return restored;
};
export const publishPrototype = (id: string, baseRev: number, message?: string, signal?: AbortSignal) => request<PublishPrototypeResult>(`${prototypePath(id)}/publish`, { method: "POST", body: { baseRev, message }, signal });
export const setPrototypeStatus = (id: string, status: PrototypeStatus, signal?: AbortSignal) =>
  request<{ status: PrototypeStatus }>(`${prototypePath(id)}/status`, { method: "POST", body: { status }, signal });
export const listPrototypeVersions = (id: string, signal?: AbortSignal) => request<PrototypeVersionSummary[]>(`${prototypePath(id)}/versions`, { signal });
export const getPrototypeVersion = (id: string, version: number, signal?: AbortSignal) => request<PrototypeVersion>(`${prototypePath(id)}/versions/${version}`, { signal });
