import type { PrototypeDoc, RegionKind } from "../prototype/schema";
import type { CompositionDoc, ExpandedOrigin } from "../prototype/composition";
import { collectCompositionRefs, expandCompositions } from "../prototype/composition";
import type { ComponentLayout, SpaceToken } from "../designSystems/types";
import type { ComponentScope } from "../designSystems/scope";
import type { PrototypeScenario, ScenarioInput } from "../prototype/scenario";

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
  /** 409 publish_blocked (волна 4): полный readiness-отчёт заблокированной публикации. */
  report?: unknown;
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
  readonly report?: unknown;

  constructor(status: number, error: ApiErrorBody) {
    super(error.message);
    this.name = "ApiError";
    this.status = status;
    this.code = error.code;
    this.issues = error.issues;
    this.warnings = error.warnings;
    this.currentRev = error.currentRev;
    this.currentVersion = error.currentVersion;
    this.report = error.report;
  }
}

// Lifecycle taxonomy (волна 0). Единственный источник правды и для сервера
// (`server/contracts.ts` строит из него zod-enum), и для галереи.
export const PROTOTYPE_KINDS = [
  "product-flow",
  "composition-fixture",
  "component-gallery",
  "evidence",
  "visual-reference",
  "experiment",
] as const;
export type PrototypeKind = (typeof PROTOTYPE_KINDS)[number];
export const DEFAULT_PROTOTYPE_KIND: PrototypeKind = "product-flow";
/** Служебные виды: скрыты из основной витрины галереи за отдельным табом. */
export const SERVICE_PROTOTYPE_KINDS = ["composition-fixture", "component-gallery", "evidence", "visual-reference"] as const;
export type ServicePrototypeKind = (typeof SERVICE_PROTOTYPE_KINDS)[number];
export const PRODUCT_PROTOTYPE_KINDS = PROTOTYPE_KINDS.filter((kind) => !(SERVICE_PROTOTYPE_KINDS as readonly string[]).includes(kind));
export const isServicePrototypeKind = (kind: string | undefined): kind is ServicePrototypeKind =>
  (SERVICE_PROTOTYPE_KINDS as readonly string[]).includes(kind ?? "");
/** Прототип без явного `kind` (старый клиент/старая строка) читается как product-flow. */
export const prototypeKindOf = (prototype: { kind?: string | null }): PrototypeKind =>
  (PROTOTYPE_KINDS as readonly string[]).includes(prototype.kind ?? "") ? prototype.kind as PrototypeKind : DEFAULT_PROTOTYPE_KIND;

/** Патч lifecycle-метаданных: `derivedFrom: null` очищает связь. */
export interface PrototypeLifecycleInput { kind?: PrototypeKind; tags?: string[]; derivedFrom?: string | null }
export interface PrototypeLifecycle { kind: PrototypeKind; tags: string[]; derivedFrom: string | null }

export interface PrototypeSummary {
  id: string;
  name: string;
  description?: string;
  device: PrototypeDoc["device"];
  designSystem?: string;
  screenCount: number;
  /** Сценарии головной ревизии. Опционально в типе: фикстуры тестов его опускают, сервер всегда шлёт. */
  flowCount?: number;
  headRev: number;
  latestVersion: number | null;
  updatedAt: string;
  status: PrototypeStatus;
  owner: ResourceOwner;
  // Lifecycle (волна 0). Опциональны в типе: фикстуры тестов их опускают, сервер всегда шлёт.
  kind?: PrototypeKind;
  tags?: string[];
  derivedFrom?: string | null;
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
  kind?: PrototypeKind;
  tags?: string[];
  derivedFrom?: string | null;
}
// `status` — статус публикации закреплённой версии компонента (волна 3). Опционален:
// старые ответы/фикстуры его не несут, инспектор рисует бейдж «устарел» только когда он есть.
// `designSystem` — ДС компонента (план multi-surface, D8). Опционален: имена компонентов
// глобально уникальны (`components.name UNIQUE`), поэтому плоские name-keyed карты корректны и
// без него, а per-surface реестр без этого поля просто не сужается (см. `surfaceRegistries`).
export interface PrototypeComponentPin { id: string; name: string; version: number; bundleUrl: string; bundleHash: string; status?: ComponentStatus; designSystem?: string }
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
  /** Закреплённые композиции ревизии с их документами (волна 5); отсутствуют в старых фикстурах. */
  compositions?: PrototypeCompositionPin[];
  /** Авторский документ до раскрытия композиций — заполняет `src/prototype/loader.ts`. */
  authoredDoc?: PrototypeDoc;
  /** Раскрытый ключ → происхождение из композиции (для дерева компонентов). */
  compositionRefs?: Record<string, ExpandedOrigin>;
  designSystemMetaVersion?: number | null;
  /**
   * Пины тем ревизии `дизайн-система → версия темы` (миграция v24, план multi-surface §4).
   * `designSystemMetaVersion` остаётся значением **primary**-ДС; карта покрывает все ДС
   * документа. Поле опционально: старые ответы и фикстуры его не несут — читатель тогда
   * пользуется скаляром (read-правило без бэкфила).
   */
  designSystemMetaVersions?: Record<string, number | null>;
  // Asset pins and figma provenance of the revision (WF-5). Optional in the type because test
  // fixtures elide them, but the server always includes both (figma is null for legacy revisions).
  assets?: AssetPin[];
  figma?: FigmaProvenance | null;
  renderable?: boolean;
  renderError?: PrototypeRenderError | null;
}
export interface PrototypeVersion extends PrototypeDraft { version: number; publishedAt: string }

// --- Композиции (волна 5) ---
export type CompositionStatus = "active" | "deprecated" | "superseded" | "archived";
export interface CompositionSummary {
  id: string; name: string; designSystem: string; headRev: number;
  latestVersion: number | null; updatedAt: string; description?: string;
  params: string[]; slots: string[];
  deleted?: true; deletedAt?: string; reason?: string | null;
}
export interface CompositionVersionSummary {
  version: number; rev: number; status: CompositionStatus; statusReason: string | null;
  supersededBy: number | null; statusRev: number; sourceHash: string; publishedAt: string;
}
export interface CompositionMeta {
  id: string; name: string; designSystem: string; headRev: number; updatedAt: string;
  publishedVersion: number | null; versions: CompositionVersionSummary[]; doc: CompositionDoc;
}
export interface CompositionRevisionSummary { rev: number; message: string | null; createdAt: string }
export interface CompositionUsageReport {
  currentHeadUsages: { prototypeId: string; name: string; kind: string; rev: number; version: number }[];
  immutableUsages: { prototypeId: string; version: number; compositionVersion: number }[];
  safeToRemove: boolean;
}
/** Пин композиции в ревизии прототипа: документ приезжает вместе с пином для раскрытия на клиенте. */
export interface PrototypeCompositionPin { id: string; name: string; version: number; sourceHash: string; doc: CompositionDoc; designSystem?: string; status?: string }

const compositionPath = (id: string) => `/api/compositions/${encodeURIComponent(id)}`;
export const listCompositions = (signal?: AbortSignal) => request<CompositionSummary[]>("/api/compositions", { signal });
export const getComposition = (id: string, signal?: AbortSignal) => request<CompositionMeta>(compositionPath(id), { signal });
export const createComposition = (id: string, doc: CompositionDoc, designSystem: string, message?: string, signal?: AbortSignal) =>
  request<{ id: string; rev: 1 }>("/api/compositions", { method: "POST", body: { id, doc, designSystem, message }, signal });
export const saveComposition = (id: string, doc: CompositionDoc, baseRev: number, message?: string, signal?: AbortSignal) =>
  request<{ rev: number }>(compositionPath(id), { method: "PUT", body: { doc, baseRev, message }, signal });
export const publishComposition = (id: string, baseRev: number, message?: string, signal?: AbortSignal) =>
  request<{ version: number; rev: number }>(`${compositionPath(id)}/publish`, { method: "POST", body: { baseRev, message }, signal });
export const deleteComposition = (id: string, baseRev: number, options: { reason?: string; force?: boolean } = {}, signal?: AbortSignal) =>
  request<void>(compositionPath(id), { method: "DELETE", body: { baseRev, ...options }, signal });
/**
 * Рекомендательный поиск кандидатов для композиции (план 2026-08-03 W9). Ответ ничего не
 * запрещает: `409 component_reuse_required` на композиции сервер не выдаёт.
 */
export interface CompositionCandidatesResult {
  outcome: "build-composition" | "extend-component" | "new-ownership-component";
  explanation: string;
  matches: { kind: "component" | "composition"; id: string; name: string; version: number; score: number; blocking: boolean; recommendable: boolean; why: string }[];
  analyzerVerdict?: "composition" | "extend-component" | "needs-ownership-component";
}
export const searchCompositionCandidates = (
  input: { designSystem: string; intent: string; id?: string; name?: string; compositionDoc?: unknown; limit?: number },
  signal?: AbortSignal,
) => request<CompositionCandidatesResult>("/api/catalog/candidates", {
  method: "POST",
  body: {
    designSystem: input.designSystem, intent: input.intent,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    proposed: {
      kind: "composition",
      ...(input.id === undefined ? {} : { id: input.id }),
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.compositionDoc === undefined ? {} : { compositionDoc: input.compositionDoc }),
    },
  },
  signal,
});

export const listCompositionRevisions = (id: string, signal?: AbortSignal) =>
  request<CompositionRevisionSummary[]>(`${compositionPath(id)}/revisions`, { signal });
export const listCompositionVersions = (id: string, signal?: AbortSignal) =>
  request<CompositionVersionSummary[]>(`${compositionPath(id)}/versions`, { signal });
export const getCompositionVersion = (id: string, version: number, signal?: AbortSignal) =>
  request<CompositionVersionSummary & { doc: CompositionDoc; designSystem: string }>(`${compositionPath(id)}/versions/${version}`, { signal });
export const getCompositionUsages = (id: string, signal?: AbortSignal) =>
  request<CompositionUsageReport>(`${compositionPath(id)}/usages`, { signal });
export interface PrototypeRevisionSummary { rev: number; message: string | null; createdAt: string }
export interface PrototypeRevision extends PrototypeDraft { message: string | null; createdAt: string }
export interface SavePrototypeResult { rev: number; warnings: unknown[] }
export interface PublishPrototypeResult { version: number; rev: number; screens: { id: string; url: string }[] }

export type AtomicLevel = "atom" | "molecule" | "organism" | "template" | "page";
export interface ComponentSummary { id: string; name: string; designSystem: string; headRev: number; latestVersion: number | null; updatedAt: string }
export type ComponentStatus = "staging" | "active" | "failed" | "rejected" | "deprecated" | "superseded" | "archived";
/**
 * `candidateId`/`acceptanceRunId` — плоские receipt-ссылки acceptance (RFC §7 A9): непусты только
 * у версий, опубликованных `promote` с терминальным (pass) раном. У всего остального — `null`,
 * и это нормальное состояние каталога, а не пробел в данных.
 */
export interface ComponentVersionSummary { version: number; rev: number; status: ComponentStatus; statusReason: string | null; supersededBy: number | null; statusRev: number; designSystem: string; publishedAt: string; candidateId?: string | null; acceptanceRunId?: string | null }
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
  /** Архитектурные метаданные (волна 2): владение и допустимая позиция компонента. */
  scope?: ComponentScope;
  allowedAsRoot?: boolean;
  canonicalFor?: string[];
  sourceBounded?: boolean;
  ownership?: { reason: string; provenance?: string };
  replacement?: string;
}
export interface CatalogComponent extends SerializedComponentDefinition {
  id: string; name: string; designSystem: string; version: number; bundleUrl: string; bundleHash: string; hostAbiVersion: number; description: string;
  /** Волна 3: сколько головных ревизий прототипов пинуют компонент (кэш по MAX(prototypes.updated_at)). */
  headUsageCount?: number;
  /** Волна 3: последняя публикация компонента в статусе deprecated/superseded. */
  deprecated?: boolean;
}
export interface CatalogManifest { components: CatalogComponent[] }

// --- Library read-model (план 2026-07-31 §3.1–3.2) ---
//
// Идентичность записи — пара `(designSystem, id)`: один компонент может быть активен в двух
// системах, и статусы у него в них разные (`server/routes/libraryCatalog.ts:23`).
/**
 * `accepted` — независимый от visual-`verified` признак (RFC candidate-acceptance §7, волна R3c):
 * у активной версии непустой `acceptanceRunId`. Смысл `verified` он не меняет и в проекцию
 * `catalogRevision` не входит.
 */
export interface LibraryCatalogStatus { published: boolean; verified: boolean; visualPending: boolean; blocked: boolean; rejected: boolean; accepted: boolean }
export interface LibraryCatalogEntry {
  kind: "component";
  id: string; name: string; designSystem: string; version: number;
  bundleUrl: string; bundleHash: string; hostAbiVersion: number; description: string;
  atomicLevel?: AtomicLevel; layoutNeutral: boolean; scope?: ComponentScope; canonicalFor: string[]; replacement?: string;
  deprecated: boolean; headUsageCount: number; status: LibraryCatalogStatus;
  figma: null | { fileKey: string; nodeCount: number };
  preview: ComponentPreviewSelector | null;
}
export interface LibraryCatalogResponse {
  /** sha256 канонического JSON **нефильтрованного** каталога — одинаков при любом `?designSystem=`. */
  catalogRevision: string;
  components: LibraryCatalogEntry[];
  systems: { id: string; name: string; count: number }[];
}
/** Какой пример рендерить в превью; сервер решает это правилом карточки и отдаёт в `entry.preview`. */
export type ComponentPreviewSelector = { selector: "legacy" } | { selector: "named"; name: string };
export interface ComponentPreviewData {
  componentId: string; name: string; version: number; designSystem: string;
  bundleUrl: string; bundleHash: string; hostAbiVersion: number;
  props: Record<string, unknown>;
  /** `slots`/`capabilities` нужны построителю дерева превью для слот-плейсхолдеров. */
  slots: string[];
  capabilities?: { typedEvents?: true; namedSlots?: true };
}

// --- Граф использования компонентов (волна 3 §3.1) ---
export interface ComponentScreenUsage { screenId: string; screenName: string; elementKeys: string[] }
export interface ComponentHeadUsage { prototypeId: string; name: string; kind: string; rev: number; componentVersion: number; screens: ComponentScreenUsage[] }
export interface ComponentImmutableUsage { prototypeId: string; name: string; version: number; componentVersion: number }
export interface ComponentUsageReport {
  componentId: string; name: string;
  currentHeadUsages: ComponentHeadUsage[];
  immutableUsages: ComponentImmutableUsage[];
  versionsInUse: number[];
  safeToRemove: boolean;
}
export interface UsageTreeNode { kind: "prototype" | "screen" | "element"; id: string; label: string; children?: UsageTreeNode[] }
export interface ComponentUsageTree extends Omit<ComponentUsageReport, "currentHeadUsages"> { format: "tree"; nodes: UsageTreeNode[] }
export interface CatalogUsagePrototype { prototypeId: string; name: string; kind: string; rev: number }
export interface CatalogUsageEntry { componentId: string; name: string; designSystem: string; headUsageCount: number; prototypes: CatalogUsagePrototype[] }
export interface CatalogUsageIndex { components: CatalogUsageEntry[] }
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

/**
 * `kinds` сериализуется в CSV-параметр `?kind=` (см. docs/server-api.md).
 * `scope: "all"` — админская выдача (чужие private/archived и прототипы без владельца);
 * не-админу сервер отвечает 403 `admin_required`, поэтому параметр шлёт только вкладка «Все».
 */
export const listPrototypes = (signal?: AbortSignal, kinds?: readonly PrototypeKind[], options?: { scope?: "all" }) => {
  const query = new URLSearchParams();
  if (kinds?.length) query.set("kind", kinds.join(","));
  if (options?.scope) query.set("scope", options.scope);
  const suffix = query.size ? `?${query.toString()}` : "";
  return request<PrototypeSummary[]>(`/api/prototypes${suffix}`, { signal });
};
export const listDesignSystems = (signal?: AbortSignal) => request<{designSystems: DesignSystemSummary[]}>("/api/design-systems", { signal });
export const getCapabilities = (signal?: AbortSignal) => request<Capabilities>("/api/capabilities", { signal });
export const getCatalogManifest = (signal?: AbortSignal) => request<CatalogManifest>("/api/catalog/manifest", { signal });
export const getLibraryCatalog = (params: { designSystem?: string } = {}, signal?: AbortSignal) =>
  request<LibraryCatalogResponse>(params.designSystem ? `/api/catalog/library?designSystem=${encodeURIComponent(params.designSystem)}` : "/api/catalog/library", { signal });
/**
 * Грамматика запроса строгая (`server/components/previewSelector.ts:22`): ровно один `selector`,
 * `name` — только при `selector=named` и обязателен там. Любое отклонение — 400, поэтому строку
 * собираем из размеченного объединения, а не из свободных полей.
 */
export const getComponentPreview = (id: string, version: number, selector: ComponentPreviewSelector, signal?: AbortSignal) => {
  const query = new URLSearchParams({ selector: selector.selector });
  if (selector.selector === "named") query.set("name", selector.name);
  return request<ComponentPreviewData>(`${componentPath(id)}/versions/${version}/preview?${query}`, { signal });
};
export const getCatalogUsages = (signal?: AbortSignal, designSystem?: string) =>
  request<CatalogUsageIndex>(designSystem ? `/api/catalog/usages?designSystem=${encodeURIComponent(designSystem)}` : "/api/catalog/usages", { signal });
export const getComponentUsages = (id: string, signal?: AbortSignal) => request<ComponentUsageReport>(`${componentPath(id)}/usages`, { signal });
export const getComponentUsageTree = (id: string, signal?: AbortSignal) => request<ComponentUsageTree>(`${componentPath(id)}/usages?format=tree`, { signal });
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
export const createPrototype = (doc: PrototypeDoc, message?: string, signal?: AbortSignal, lifecycle?: PrototypeLifecycleInput) =>
  request<{id: string; rev: 1; warnings: unknown[]}>("/api/prototypes", { method: "POST", body: { doc, message, ...(lifecycle ?? {}) }, signal });
/** Owner/admin-патч lifecycle-метаданных; пустой патч возвращает текущее состояние. */
export const setPrototypeLifecycle = (id: string, patch: PrototypeLifecycleInput, signal?: AbortSignal) =>
  request<PrototypeLifecycle>(`${prototypePath(id)}/lifecycle`, { method: "POST", body: patch, signal });
export const getPrototypeMeta = (id: string, signal?: AbortSignal) => request<PrototypeMeta>(prototypePath(id), { signal });
/**
 * Раскрывает композиции ревизии тем же кодом, что и save-путь сервера (волна 5).
 * `doc` становится раскрытым — плеер, галерея, CJM и capture рендерят его без изменений;
 * авторский документ (с `@eui/Composition`) остаётся в `authoredDoc` для редактора.
 * Ревизия без композиций возвращается как есть.
 */
function expandRevisionResponse<T extends { doc: PrototypeDoc; compositions?: PrototypeCompositionPin[] }>(response: T): T {
  // Keep the transport helper tolerant of legacy/test DTOs that are validated by a
  // higher-level loader. Composition expansion only applies to a prototype-shaped document.
  if (!response.doc || !Array.isArray((response.doc as { screens?: unknown }).screens)) return response;
  const refs = collectCompositionRefs(response.doc);
  if (!refs.length) return response;
  if (!response.compositions?.length) {
    throw new ApiError(422, {
      code: "composition_expansion_failed",
      message: "Prototype response is missing the pinned composition closure",
      issues: refs.map((ref) => ({ path: `/screens/${ref.screenIndex}/spec/elements/${ref.elementKey}/props/composition`, message: `missing composition pin: ${ref.compositionId}` })),
    });
  }
  const compositions = Object.fromEntries(response.compositions.map((pin) => [pin.id, {
    doc: pin.doc,
    version: pin.version,
    designSystem: pin.designSystem ?? response.doc.designSystem,
    status: pin.status ?? "active",
  }]));
  // A revision response carries exact immutable composition pins. Their publication may later
  // be deprecated by a catalog migration, but playback/editor expansion must remain stable.
  const expanded = expandCompositions(response.doc, { compositions, designSystem: response.doc.designSystem, allowInactivePins: true });
  if (expanded.issues.length) {
    throw new ApiError(422, {
      code: "composition_expansion_failed",
      message: "Pinned composition closure cannot be expanded",
      issues: expanded.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    });
  }
  return { ...response, doc: expanded.doc, authoredDoc: response.doc, compositionRefs: expanded.expandedFrom };
}

export const getPrototypeDraft = async (id: string, signal?: AbortSignal) => rememberDraftAssets(id, expandRevisionResponse(await request<PrototypeDraft>(`${prototypePath(id)}/draft`, { signal })));
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
export const getPrototypeRevision = async (id: string, rev: number, signal?: AbortSignal) => expandRevisionResponse(await request<PrototypeRevision>(`${prototypePath(id)}/revisions/${rev}`, { signal }));
export type PrototypeRevisionFull = PrototypeRevision;
export const getPrototypeRevisionFull = async (id: string, rev: number, signal?: AbortSignal) => {
  const revision = expandRevisionResponse(await request<PrototypeRevisionFull>(`${prototypePath(id)}/revisions/${rev}`, { signal }));
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
// --- Ready-to-publish report (волна 4) ---
export const READINESS_GATE_IDS = ["architecture", "schema", "screens", "assets", "pins", "deprecated", "visual", "capture", "interactions", "publishDiff"] as const;
export type ReadinessGateId = (typeof READINESS_GATE_IDS)[number];
export type ReadinessGateStatus = "pass" | "warn" | "fail" | "unknown";
/** Ссылка на проблемное место отчёта: JSON-pointer + разрешённые экран/элемент. */
export interface ReadinessLocation { path: string; message: string; screenId?: string; elementKey?: string; code?: string }
/** Детали гейта разложены в тот же объект — форма зависит от гейта, поэтому индексная сигнатура. */
export interface ReadinessGate { id: ReadinessGateId; status: ReadinessGateStatus; summary: string; [detail: string]: unknown }
export interface ReadinessReport {
  prototypeId: string;
  rev: number;
  generatedAt: string;
  gates: ReadinessGate[];
  blocking: ReadinessGateId[];
  publishable: boolean;
  enabledGates: Record<string, "fail" | "warn">;
}
export const getPrototypeReadiness = (id: string, signal?: AbortSignal) =>
  request<ReadinessReport>(`${prototypePath(id)}/readiness`, { signal });

// --- Сценарии взаимодействия (волна 6) ---
const scenariosPath = (id: string) => `${prototypePath(id)}/scenarios`;
const scenarioPath = (id: string, scenarioId: string) => `${scenariosPath(id)}/${encodeURIComponent(scenarioId)}`;
export const listPrototypeScenarios = (id: string, signal?: AbortSignal) =>
  request<{ scenarios: PrototypeScenario[] }>(scenariosPath(id), { signal }).then((response) => response.scenarios);
export const createPrototypeScenario = (id: string, input: ScenarioInput & { id?: string }, signal?: AbortSignal) =>
  request<PrototypeScenario>(scenariosPath(id), { method: "POST", body: input, signal });
export const savePrototypeScenario = (id: string, scenarioId: string, input: ScenarioInput, signal?: AbortSignal) =>
  request<PrototypeScenario>(scenarioPath(id, scenarioId), { method: "PUT", body: input, signal });
export const deletePrototypeScenario = (id: string, scenarioId: string, signal?: AbortSignal) =>
  request<void>(scenarioPath(id, scenarioId), { method: "DELETE", signal });

/** Перепин головного документа на актуальные active-публикации (волна 3). */
export interface RepinChange { component: string; from: number | null; to: number | null }
export interface RepinResult { dryRun: boolean; rev: number; before: PrototypeComponentPin[]; after: PrototypeComponentPin[]; changed: RepinChange[] }
export const repinPrototype = (id: string, options: { dryRun?: boolean } = {}, signal?: AbortSignal) =>
  request<RepinResult>(`${prototypePath(id)}/repin${options.dryRun ? "?dryRun=1" : ""}`, { method: "POST", body: {}, signal });

export const setPrototypeStatus = (id: string, status: PrototypeStatus, signal?: AbortSignal) =>
  request<{ status: PrototypeStatus }>(`${prototypePath(id)}/status`, { method: "POST", body: { status }, signal });
export const listPrototypeVersions = (id: string, signal?: AbortSignal) => request<PrototypeVersionSummary[]>(`${prototypePath(id)}/versions`, { signal });
export const getPrototypeVersion = async (id: string, version: number, signal?: AbortSignal) => expandRevisionResponse(await request<PrototypeVersion>(`${prototypePath(id)}/versions/${version}`, { signal }));
