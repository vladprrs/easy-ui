import type { Database } from "bun:sqlite";
import { canonicalStringify } from "../../src/capture/canonicalJson";
import type { CaptureExpected } from "../../src/capture/protocol";
import type { GeometryCollection, GeometryRect, GeometryRole } from "../../src/capture/geometry.mjs";
import { resolveSpacingScale } from "../../src/designSystems/spacingScale";
import type { SpaceToken } from "../../src/designSystems/types";
import { analyzeScreenRegions } from "../../src/prototype/runtimeSpec";
import { REPEAT_RENDER_COST_BUDGET } from "../../src/prototype/validate";
import { getDesignSystemVersion, getLatestDesignSystemContent } from "../designSystems";
import type { ThemeContent } from "../designSystemsMeta";
import { ApiError } from "../http";
import { ensureDraftCandidate } from "../components/validate";
import { AssetRepo } from "../repos/assets";
import { ComponentRepo } from "../repos/components";
import { PrototypeRepo } from "../repos/prototypes";
import { buildStaticAllowedUrls, rendererBuildFrom } from "./allowedUrls";
import { classifyCaptureErrors } from "./noise";
import { CaptureSessionStore, JOB_DEADLINE_MS } from "./sessions";

export interface Viewport { width: number; height: number }
/** Пин компонента, замороженный на enqueue и отданный поверхности через `bootstrap.target`. */
export interface CapturePin { id: string; name: string; version: number; bundleUrl: string; bundleHash: string; status: string }
/**
 * Additive capture-quality contract (wave 7.1): `consoleErrors`/`pageErrors`
 * stay populated verbatim for backward compatibility, while `productErrors` /
 * `infraNoise` / `captureClean` say whether the *prototype* misbehaved.
 */
export interface CaptureQuality {
  captureClean: boolean;
  productErrors: string[];
  infraNoise: string[];
  runtimeWarnings: string[];
}
export interface JobStatus { status: "queued" | "running" | "done" | "error"; result?: ScreenshotResult; error?: { code: string; message: string } }
export interface ScreenshotImageResult extends CaptureQuality {
  kind: "image";
  imageUrl: string; assetId: string; width: number; height: number;
  imageProduced: boolean;
  consoleErrors: string[]; pageErrors: string[];
  bundleHash?: string;
  /** Draft head-revision target (P1b): the rendered rev, so clients can report "draft rev N". */
  draftRev?: number;
  componentPins?: { id: string; version: number; bundleHash: string }[];
  rendererBuild: string | null; browserVersion: string;
}
/** Geometry measurements shared by both capture surfaces (additive wave-7.1 shape). */
interface GeometryMeasurement {
  rects: GeometryRect[];
  truncated: boolean;
  total: number;
  safeArea: GeometryCollection["safeArea"];
  roleRects: GeometryCollection["roleRects"];
  frame: GeometryCollection["frame"];
  content: GeometryCollection["content"];
  scroll: GeometryCollection["scroll"];
  viewportOwnership: GeometryCollection["viewportOwnership"];
  issues: GeometryCollection["issues"];
}
export interface ScreenshotPrototypeGeometryResult extends CaptureQuality, GeometryMeasurement {
  kind: "geometry";
  surface: "prototype";
  resolvedRev: number;
  prototypeInstanceId: string;
  componentPins: { id: string; version: number; bundleHash: string }[];
  designSystemMetaVersion: number | null;
  resolvedSpaceScale: Record<SpaceToken, string>;
  viewport: Viewport;
  dpr: number;
}
/** Component-surface geometry probe (P1b): published version or draft head revision. */
export interface ScreenshotComponentGeometryResult extends CaptureQuality, GeometryMeasurement {
  kind: "geometry";
  surface: "component";
  componentId: string;
  /** Published target — mutually exclusive with `draftRev`. */
  version?: number;
  /** Draft head-revision target — mutually exclusive with `version`. */
  draftRev?: number;
  bundleHash: string;
  designSystemMetaVersion: number | null;
  resolvedSpaceScale: Record<SpaceToken, string>;
  viewport: Viewport;
  dpr: number;
}
/** Geometry probe result, discriminated by `surface` (P1b добавил компонентную поверхность). */
export type ScreenshotGeometryResult = ScreenshotPrototypeGeometryResult | ScreenshotComponentGeometryResult;
export type ScreenshotResult = ScreenshotImageResult | ScreenshotGeometryResult;

export interface WorkerJob {
  captureOrigin: string; captureUrl: string; token: string;
  bootstrap: { kind: "prototype" | "component" | "component-draft"; target: Record<string, unknown>; props?: Record<string, unknown>; propsJsonSchema?: unknown; examples?: Record<string, Record<string, unknown>>; expected: CaptureExpected };
  allowedUrls: string[]; viewport: Viewport; deviceScaleFactor: number; colorScheme: "light" | "dark"; waitForFonts: boolean; expected: CaptureExpected;
  probe?: "geometry"; geometryLimit?: number; geometryRoleKeys?: Partial<Record<GeometryRole, string>>;
}
export type WorkerImageOk = { ok: true; pngBase64: string; width: number; height: number; consoleErrors: string[]; consoleWarnings?: string[]; pageErrors: string[]; browserVersion: string };
export type WorkerGeometryOk = { ok: true; geometry: GeometryCollection; consoleErrors: string[]; consoleWarnings?: string[]; pageErrors: string[]; browserVersion: string };
export type WorkerOk = WorkerImageOk | WorkerGeometryOk;
export type WorkerErr = { ok: false; error: string; consoleErrors?: string[]; consoleWarnings?: string[]; pageErrors?: string[] };
export type WorkerResult = WorkerOk | WorkerErr;
export type RunJob = (job: WorkerJob, deadlineMs: number) => Promise<WorkerResult>;

interface InternalJob {
  id: string; status: JobStatus["status"]; kind: "prototype" | "component";
  expected: CaptureExpected; allowedUrls: string[]; props?: Record<string, unknown>;
  captureUrl: string; viewport: Viewport; dsf: number; theme: "light" | "dark"; waitForFonts: boolean;
  componentPins?: { id: string; version: number; bundleHash: string }[];
  /**
   * Полные пины, замороженные на enqueue, и их manifest-hash (план 2026-08-02, P2.3).
   * Едут в `bootstrap.target`, и поверхность рендерит именно их: для track:head-дока
   * публикация новой версии компонента между enqueue и рендером иначе увела бы DTO
   * и уронила бы exact-match handshake.
   */
  capturePins?: CapturePin[];
  captureManifestHash?: string;
  /** Draft-capture extras (P1b): what the bootstrap carries instead of a published DTO. */
  draft?: { name: string; designSystem: string; bundleUrl: string; propsJsonSchema?: unknown; examples?: Record<string, Record<string, unknown>> };
  probe?: "geometry"; resolvedSpaceScale?: Record<SpaceToken, string>; geometryRoleKeys?: Partial<Record<GeometryRole, string>>;
  result?: ScreenshotResult; error?: { code: string; message: string }; resultExpiresAt?: number;
}

/**
 * Region/panel roles a geometry probe reports rects for. Regions come from the
 * authored spec (the capture surface renders them inline, without the player's
 * `data-eui-region` slots), the panel is the screen root subtree.
 */
export function geometryRoleKeysOf(doc: unknown, screenId: string): Partial<Record<GeometryRole, string>> {
  const screens = (doc as { screens?: { id: string; canvas?: { width: number; height: number }; spec: { root: string; elements: Record<string, unknown> } }[] }).screens ?? [];
  const screen = screens.find((item) => item.id === screenId);
  if (!screen) return {};
  const roleKeys: Partial<Record<GeometryRole, string>> = { panel: screen.spec.root };
  const analysis = analyzeScreenRegions(screen as Parameters<typeof analyzeScreenRegions>[0]);
  for (const [kind, key] of Object.entries(analysis.regionElements)) {
    if (typeof key === "string") roleKeys[`region:${kind}` as GeometryRole] = key;
  }
  return roleKeys;
}

/** Defaults for pre-7.1 worker payloads: the geometry shape stays additive-only. */
function emptyGeometryShape(): Pick<GeometryMeasurement, "safeArea" | "roleRects" | "frame" | "content" | "scroll" | "viewportOwnership" | "issues"> {
  const zero = { x: 0, y: 0, width: 0, height: 0 };
  return {
    safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
    roleRects: {},
    frame: { ...zero, source: "surface" },
    content: zero,
    scroll: { width: 0, height: 0 },
    viewportOwnership: { frame: null, content: null, scroll: null, scrollable: false, owners: [], unownedPct: 0 },
    issues: [],
  };
}

export const MAX_QUEUE = 5;
export const GEOMETRY_RECT_LIMIT = REPEAT_RENDER_COST_BUDGET;
const RESULT_TTL_MS = 10 * 60_000;

function validateViewport(viewport: unknown, dsf: unknown): { viewport: Viewport; dsf: number } {
  const vp = viewport as { width?: unknown; height?: unknown } | undefined;
  const width = vp?.width, height = vp?.height;
  const scale = dsf === undefined ? 1 : dsf;
  const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
  if (!isInt(width) || width < 64 || width > 2000) throw new ApiError(422, "invalid_viewport", "viewport.width must be an integer in [64, 2000]");
  if (!isInt(height) || height < 64 || height > 4000) throw new ApiError(422, "invalid_viewport", "viewport.height must be an integer in [64, 4000]");
  if (!isInt(scale) || ![1, 2, 3].includes(scale)) throw new ApiError(422, "invalid_viewport", "deviceScaleFactor must be 1, 2, or 3");
  if (width * height * scale * scale > 20_000_000) throw new ApiError(422, "invalid_viewport", "width × height × dsf² must not exceed 20 megapixels");
  return { viewport: { width, height }, dsf: scale };
}

function propsHashOf(props: unknown): string {
  return new Bun.CryptoHasher("sha256").update(canonicalStringify(props ?? {})).digest("hex");
}

/**
 * Theme assets are fetched at render time by injected @font-face rules and the
 * shared icon registry. They are not part of a prototype document or component
 * bundle, so screenshot capture must allowlist them explicitly.
 */
export function themeAssetIds(content: ThemeContent | null): string[] {
  if (!content) return [];
  const ids = new Set<string>();
  for (const font of content.fonts) ids.add(font.src);
  for (const icon of content.icons) {
    ids.add(icon.assetId);
    if (icon.themes?.light) ids.add(icon.themes.light);
    if (icon.themes?.dark) ids.add(icon.themes.dark);
  }
  return [...ids];
}

export interface ScreenshotServiceDeps {
  db: Database; dataDir: string; serveDist?: string;
  captureOrigin: string; chromiumAvailable: boolean; runJob: RunJob;
  sessions?: CaptureSessionStore; now?: () => number;
}
export type FrozenEnqueue = { jobId:string; expected:CaptureExpected; components?:CapturePin[] };
export type FrozenTarget =
  | {kind:"prototype";id:string;screenId:string;rev?:number;version?:number}
  | {kind:"component";id:string;version:number;props?:Record<string,unknown>};

/**
 * In-memory screenshot job pipeline: bounds-validated enqueue with an atomic
 * target snapshot (expected + allowedUrls), a concurrency-1 pump with a bounded
 * queue, per-job capture-session mint/revoke around the worker run, and PNG
 * ingestion into the content-addressed asset registry.
 */
export class ScreenshotService {
  readonly sessions: CaptureSessionStore;
  private readonly jobs = new Map<string, InternalJob>();
  private readonly queue: string[] = [];
  private running = 0;
  private readonly now: () => number;
  private readonly rendererBuild: string | null;

  constructor(private readonly deps: ScreenshotServiceDeps) {
    this.sessions = deps.sessions ?? new CaptureSessionStore(deps.now);
    this.now = deps.now ?? Date.now;
    this.rendererBuild = rendererBuildFrom(deps.serveDist);
  }

  available(): boolean { return Boolean(this.deps.serveDist) && this.deps.chromiumAvailable; }

  private requireAvailable(): void {
    if (!this.available()) throw new ApiError(501, "screenshot_unavailable", "Screenshot capture requires SERVE_DIST and an installed chromium");
  }
  private guardQueue(): void {
    this.reapExpired();
    if (this.queue.length >= MAX_QUEUE) throw new ApiError(429, "queue_full", "Screenshot queue is full; retry later");
  }

  /**
   * Ответ enqueue отдаёт разрешённые пины (P2.3/P5.2): для track:head-дока это единственный
   * момент, когда клиент узнаёт, какие версии компонентов реально пойдут в кадр.
   */
  enqueuePrototype(id: string, screenId: string, opts: { rev?: number; version?: number; viewport: unknown; deviceScaleFactor?: unknown; theme?: string; waitForFonts?: boolean; probe?: "geometry" }): { jobId: string; components: { id: string; name: string; version: number; bundleHash: string }[] } {
    const {jobId,components}=this.enqueuePrototypeFrozen(id,screenId,opts);
    return {jobId,components:(components??[]).map((pin)=>({id:pin.id,name:pin.name,version:pin.version,bundleHash:pin.bundleHash}))};
  }

  enqueueWithExpected(target:FrozenTarget,opts:{viewport:unknown;deviceScaleFactor?:unknown;theme?:string;waitForFonts?:boolean}):FrozenEnqueue {
    return target.kind==="prototype"
      ? this.enqueuePrototypeFrozen(target.id,target.screenId,{...opts,rev:target.rev,version:target.version})
      : this.enqueueComponentFrozen(target.id,target.version,{...opts,props:target.props});
  }

  private enqueuePrototypeFrozen(id: string, screenId: string, opts: { rev?: number; version?: number; viewport: unknown; deviceScaleFactor?: unknown; theme?: string; waitForFonts?: boolean; probe?: "geometry" }): FrozenEnqueue {
    this.requireAvailable();
    const { viewport, dsf } = validateViewport(opts.viewport, opts.deviceScaleFactor);
    this.guardQueue();
    const repo = new PrototypeRepo(this.deps.db);
    // Atomic snapshot: resolve rev now so a later save cannot move the target.
    const snap = repo.screenRenderStatus(id, screenId, { rev: opts.rev, version: opts.version });
    const full = repo.revision(id, snap.rev);
    const componentPins = full.components.map((p) => ({ id: p.id, version: p.version, bundleHash: p.bundleHash }));
    const resolvedSpaceScale = opts.probe ? (() => {
      const designSystem = (full.doc as { designSystem: string }).designSystem;
      const themeContent = full.designSystemMetaVersion == null
        ? getLatestDesignSystemContent(this.deps.db, designSystem)
        : getDesignSystemVersion(this.deps.db, designSystem, full.designSystemMetaVersion);
      // Резолвер — свойство пиннутой версии темы (миграция v23): старые версии остаются на legacy-пути.
      return resolveSpacingScale(designSystem, themeContent?.tokens ?? {}, themeContent?.spacingResolver);
    })() : undefined;
    const geometryRoleKeys = opts.probe === "geometry" ? geometryRoleKeysOf(full.doc, screenId) : undefined;
    const theme = opts.theme === "dark" ? "dark" : "light";
    const expected: CaptureExpected = { kind: "prototype", prototypeInstanceId:full.prototypeInstanceId, rev: snap.rev, componentManifestHash: full.componentManifestHash, builtinCatalogHash: full.builtinCatalogHash, dsMetaVersion: full.designSystemMetaVersion ?? null, rendererBuild: this.rendererBuild };
    const allowedUrls = this.prototypeAllowedUrls(
      id,
      screenId,
      full.components,
      full.assets.map((a) => a.id),
      (full.doc as { designSystem?: string }).designSystem,
      full.designSystemMetaVersion ?? null,
      opts.version !== undefined ? `/api/prototypes/${id}/versions/${opts.version}` : `/api/prototypes/${id}/revisions/${snap.rev}`,
    );
    const query = new URLSearchParams();
    if (opts.version !== undefined) query.set("version", String(opts.version)); else query.set("rev", String(snap.rev));
    query.set("theme", theme); query.set("dsf", String(dsf));
    const captureUrl = `/capture/${encodeURIComponent(id)}/s/${encodeURIComponent(screenId)}?${query}`;
    const capturePins: CapturePin[] = full.components.map((p) => ({ id: p.id, name: p.name, version: p.version, bundleUrl: p.bundleUrl, bundleHash: p.bundleHash, status: p.status }));
    const {jobId}=this.push({ kind: "prototype", expected, allowedUrls, captureUrl, viewport, dsf, theme, waitForFonts: opts.waitForFonts !== false, componentPins, capturePins, captureManifestHash: full.componentManifestHash, ...(opts.probe ? { probe: opts.probe, resolvedSpaceScale, geometryRoleKeys } : {}) });
    return {jobId,expected,components:capturePins};
  }

  enqueueComponent(id: string, version: number, opts: { props?: Record<string, unknown>; exampleName?: string; viewport: unknown; deviceScaleFactor?: unknown; theme?: string; waitForFonts?: boolean; probe?: "geometry" }): { jobId: string } {
    const {jobId}=this.enqueueComponentFrozen(id,version,opts); return {jobId};
  }

  private enqueueComponentFrozen(id: string, version: number, opts: { props?: Record<string, unknown>; exampleName?: string; viewport: unknown; deviceScaleFactor?: unknown; theme?: string; waitForFonts?: boolean; probe?: "geometry" }): FrozenEnqueue {
    this.requireAvailable();
    const { viewport, dsf } = validateViewport(opts.viewport, opts.deviceScaleFactor);
    this.guardQueue();
    const repo = new ComponentRepo(this.deps.db);
    const dto = repo.version(id, version) as { version: number; bundleHash: string; designSystem: string; propsJsonSchema?: unknown; examples?: Record<string,Record<string,unknown>>; assets: { id: string }[] };
    let props=opts.props??{};
    if(opts.exampleName!==undefined){const examples=dto.examples??Object.create(null) as Record<string,Record<string,unknown>>;if(!Object.hasOwn(examples,opts.exampleName))throw new ApiError(422,"unknown_example",`Unknown component example: ${opts.exampleName}`);props=examples[opts.exampleName]!;}
    validatePropsAgainstSchema(props, dto.propsJsonSchema);
    const propsHash = propsHashOf(props);
    const theme = opts.theme === "dark" ? "dark" : "light";
    const themeContent = getLatestDesignSystemContent(this.deps.db, dto.designSystem);
    const expected: CaptureExpected = { kind: "component", componentId: id, version, bundleHash: dto.bundleHash, propsHash, dsMetaVersion: themeContent.latestMetaVersion, rendererBuild: this.rendererBuild };
    const allowedUrls = this.componentAllowedUrls(id, version, dto.assets.map((a) => a.id), dto.designSystem);
    const query = new URLSearchParams({ theme, dsf: String(dsf) });
    const captureUrl = `/capture/component/${encodeURIComponent(id)}/${version}?${query}`;
    // Компонентная геометрия (P1b): шкала — из последней темы, ролей экрана у одиночного компонента нет.
    const resolvedSpaceScale = opts.probe ? resolveSpacingScale(dto.designSystem, themeContent.tokens, themeContent.spacingResolver) : undefined;
    const {jobId}=this.push({ kind: "component", expected, allowedUrls, props, captureUrl, viewport, dsf, theme, waitForFonts: opts.waitForFonts !== false, ...(opts.probe ? { probe: opts.probe, resolvedSpaceScale } : {}) });
    return {jobId,expected};
  }

  /**
   * Draft-preview сохранённой, но не опубликованной head-ревизии (план 2026-08-02, P1b).
   * Бандл — эфемерный candidate-bundle префлайта P8: при холодном кэше собирается здесь же
   * под троттлингом validate (`ensureDraftCandidate`), поэтому метод асинхронный, в отличие
   * от published-ветки. Allowlist пинует asset-ссылки, извлечённые из исходника драфта
   * (пиннинга ассетов у драфта нет — он появляется только при publish).
   */
  async enqueueComponentDraft(id: string, userId: string, opts: { props?: Record<string, unknown>; exampleName?: string; viewport: unknown; deviceScaleFactor?: unknown; theme?: string; waitForFonts?: boolean; probe?: "geometry" }): Promise<{ jobId: string }> {
    this.requireAvailable();
    const { viewport, dsf } = validateViewport(opts.viewport, opts.deviceScaleFactor);
    this.guardQueue();
    const draft = await ensureDraftCandidate(this.deps.db, this.deps.dataDir, id, userId);
    // Сборка кандидата ждала своей очереди — cap мог заполниться, пока мы компилировали.
    this.guardQueue();
    const repo = new ComponentRepo(this.deps.db);
    const meta = draft.entry.extracted!.meta!;
    let props = opts.props ?? {};
    if (opts.exampleName !== undefined) {
      const examples = meta.examples ?? Object.create(null) as Record<string, Record<string, unknown>>;
      if (!Object.hasOwn(examples, opts.exampleName)) throw new ApiError(422, "unknown_example", `Unknown component example: ${opts.exampleName}`);
      props = examples[opts.exampleName]!;
    }
    validatePropsAgainstSchema(props, meta.propsJsonSchema);
    const propsHash = propsHashOf(props);
    const theme = opts.theme === "dark" ? "dark" : "light";
    const themeContent = getLatestDesignSystemContent(this.deps.db, draft.designSystem);
    const expected: CaptureExpected = { kind: "component-draft", componentId: id, rev: draft.rev, sourceHash: draft.sourceHash, bundleHash: draft.entry.bundleHash!, propsHash, dsMetaVersion: themeContent.latestMetaVersion, rendererBuild: this.rendererBuild };
    const bundleUrl = `/api/components/${encodeURIComponent(id)}/draft/${draft.sourceHash}/bundle.js`;
    const allowedUrls = this.draftComponentAllowedUrls(id, draft.sourceHash, draft.assetIds, draft.designSystem);
    const query = new URLSearchParams({ theme, dsf: String(dsf) });
    const captureUrl = `/capture/component/${encodeURIComponent(id)}/draft?${query}`;
    const resolvedSpaceScale = opts.probe ? resolveSpacingScale(draft.designSystem, themeContent.tokens, themeContent.spacingResolver) : undefined;
    const { jobId } = this.push({
      kind: "component", expected, allowedUrls, props, captureUrl, viewport, dsf, theme, waitForFonts: opts.waitForFonts !== false,
      draft: { name: repo.row(id).name, designSystem: draft.designSystem, bundleUrl, ...(meta.propsJsonSchema !== undefined ? { propsJsonSchema: meta.propsJsonSchema } : {}), ...(meta.examples !== undefined ? { examples: meta.examples } : {}) },
      ...(opts.probe ? { probe: opts.probe, resolvedSpaceScale } : {}),
    });
    return { jobId };
  }

  private prototypeAllowedUrls(
    id: string,
    screenId: string,
    pins: { id: string; version: number }[],
    docAssetIds: string[],
    designSystem?: string,
    designSystemMetaVersion?: number | null,
    snapshotUrl?: string,
  ): string[] {
    const set = new Set<string>();
    set.add(`/capture/${id}/s/${screenId}`);
    if (designSystem) {
      set.add(`/api/design-systems/${designSystem}`);
      set.add(`/api/design-systems/${designSystem}/versions/`);
      const content = designSystemMetaVersion == null
        ? getLatestDesignSystemContent(this.deps.db, designSystem)
        : getDesignSystemVersion(this.deps.db, designSystem, designSystemMetaVersion);
      for (const assetId of themeAssetIds(content)) set.add(`/api/assets/${assetId}`);
    }
    // enqueuePrototype always freezes the selector into the capture URL, so the shell
    // needs exactly one immutable DTO endpoint rather than broad prototype read access.
    if(snapshotUrl) set.add(snapshotUrl);
    for (const p of pins) set.add(`/api/components/${p.id}/versions/${p.version}/bundle.js`);
    for (const assetId of docAssetIds) set.add(`/api/assets/${assetId}`);
    const componentRepo = new ComponentRepo(this.deps.db);
    for (const p of pins) for (const a of componentRepo.assets(p.id, p.version)) set.add(`/api/assets/${a.id}`);
    set.add("/api/shims/");
    for (const s of buildStaticAllowedUrls(this.deps.serveDist)) set.add(s);
    return [...set];
  }
  private componentAllowedUrls(id: string, version: number, assetIds: string[], designSystem?: string): string[] {
    const set = new Set<string>();
    set.add(`/capture/component/${id}/${version}`);
    if (designSystem) {
      set.add(`/api/design-systems/${designSystem}`);
      set.add(`/api/design-systems/${designSystem}/versions/`);
      for (const assetId of themeAssetIds(getLatestDesignSystemContent(this.deps.db, designSystem))) {
        set.add(`/api/assets/${assetId}`);
      }
    }
    set.add(`/api/components/${id}`);
    set.add(`/api/components/${id}/versions/${version}`);
    set.add(`/api/components/${id}/versions/${version}/bundle.js`);
    for (const assetId of assetIds) set.add(`/api/assets/${assetId}`);
    set.add("/api/shims/");
    for (const s of buildStaticAllowedUrls(this.deps.serveDist)) set.add(s);
    return [...set];
  }

  /**
   * Draft-allowlist (P1b): candidate-bundle идёт точным content-addressed путём (sourceHash
   * в path), поэтому в allowlist он попадает только у enqueue'нувшей джобы — чужие джобы
   * (другой компонент, другой sourceHash, published-съёмка) этот URL не получают. В
   * catalog/latest-active resolution и в bundle-export он не попадает никогда: те читают
   * только publishes. Asset-ссылки — из исходника драфта; published-DTO (`/api/components/:id`,
   * `/versions/:v`) драфту не нужны: meta/props-схема едут в bootstrap.
   */
  private draftComponentAllowedUrls(id: string, sourceHash: string, assetIds: string[], designSystem: string): string[] {
    const set = new Set<string>();
    set.add(`/capture/component/${id}/draft`);
    set.add(`/api/design-systems/${designSystem}`);
    set.add(`/api/design-systems/${designSystem}/versions/`);
    for (const assetId of themeAssetIds(getLatestDesignSystemContent(this.deps.db, designSystem))) {
      set.add(`/api/assets/${assetId}`);
    }
    set.add(`/api/components/${id}/draft/${sourceHash}/bundle.js`);
    for (const assetId of assetIds) set.add(`/api/assets/${assetId}`);
    set.add("/api/shims/");
    for (const s of buildStaticAllowedUrls(this.deps.serveDist)) set.add(s);
    return [...set];
  }

  private push(job: Omit<InternalJob, "id" | "status">): { jobId: string } {
    const id = `job_${crypto.randomUUID()}`;
    this.jobs.set(id, { ...job, id, status: "queued" });
    this.queue.push(id);
    queueMicrotask(() => this.pump());
    return { jobId: id };
  }

  get(jobId: string): JobStatus {
    this.reapExpired();
    const job = this.jobs.get(jobId);
    if (!job) throw new ApiError(404, "job_not_found", "Screenshot job not found");
    return { status: job.status, ...(job.result ? { result: job.result } : {}), ...(job.error ? { error: job.error } : {}) };
  }
  /** Test-only introspection of the frozen enqueue snapshot. */
  peek(jobId: string): InternalJob | undefined { return this.jobs.get(jobId); }

  private reapExpired(): void {
    const t = this.now();
    for (const [id, job] of this.jobs) if (job.resultExpiresAt !== undefined && job.resultExpiresAt <= t) this.jobs.delete(id);
    this.sessions.sweep();
  }

  private pump(): void {
    if (this.running >= 1) return;
    const id = this.queue.shift();
    if (id === undefined) return;
    const job = this.jobs.get(id);
    if (!job) { this.pump(); return; }
    this.running += 1;
    job.status = "running";
    void this.execute(job).finally(() => { this.running -= 1; this.pump(); });
  }

  private async execute(job: InternalJob): Promise<void> {
    const session = this.sessions.mint({ kind: job.kind, allowedUrls: job.allowedUrls, expected: job.expected, props: job.props });
    try {
      const workerJob: WorkerJob = {
        captureOrigin: this.deps.captureOrigin, captureUrl: job.captureUrl, token: session.token,
        bootstrap: {
          kind: job.expected.kind === "component-draft" ? "component-draft" : job.kind,
          target: this.targetOf(job),
          ...(job.props ? { props: job.props } : {}),
          // Драфт: published-DTO не существует, поэтому схема/examples едут в bootstrap (P1b).
          ...(job.draft?.propsJsonSchema !== undefined ? { propsJsonSchema: job.draft.propsJsonSchema } : {}),
          ...(job.draft?.examples !== undefined ? { examples: job.draft.examples } : {}),
          expected: job.expected,
        },
        allowedUrls: job.allowedUrls, viewport: job.viewport, deviceScaleFactor: job.dsf, colorScheme: job.theme, waitForFonts: job.waitForFonts, expected: job.expected,
        ...(job.probe ? { probe: job.probe, geometryLimit: GEOMETRY_RECT_LIMIT, ...(job.geometryRoleKeys ? { geometryRoleKeys: job.geometryRoleKeys } : {}) } : {}),
      };
      const result = await this.deps.runJob(workerJob, JOB_DEADLINE_MS);
      if (!result.ok) { job.status = "error"; job.error = { code: "capture_failed", message: result.error }; this.expire(job); return; }
      const quality = this.qualityOf(result);
      if (job.probe === "geometry") {
        if (!("geometry" in result)) throw new Error("geometry worker result mismatch");
        const measurement = { ...emptyGeometryShape(), ...result.geometry };
        if (job.expected.kind === "prototype") {
          job.result = {
            kind: "geometry",
            surface: "prototype",
            ...quality,
            resolvedRev: job.expected.rev,
            prototypeInstanceId: job.expected.prototypeInstanceId,
            componentPins: job.componentPins ?? [],
            designSystemMetaVersion: job.expected.dsMetaVersion,
            resolvedSpaceScale: job.resolvedSpaceScale!,
            viewport: job.viewport,
            dpr: job.dsf,
            ...measurement,
          };
        } else {
          job.result = {
            kind: "geometry",
            surface: "component",
            ...quality,
            componentId: job.expected.componentId,
            ...(job.expected.kind === "component-draft" ? { draftRev: job.expected.rev } : { version: job.expected.version }),
            bundleHash: job.expected.bundleHash,
            designSystemMetaVersion: job.expected.dsMetaVersion,
            resolvedSpaceScale: job.resolvedSpaceScale!,
            viewport: job.viewport,
            dpr: job.dsf,
            ...measurement,
          };
        }
        job.status = "done";
        this.expire(job);
        return;
      }
      if (!("pngBase64" in result)) throw new Error("image worker result mismatch");
      const bytes = Buffer.from(result.pngBase64, "base64");
      const assetRepo = new AssetRepo(this.deps.db, this.deps.dataDir);
      const ingest = await assetRepo.ingest(new Uint8Array(bytes), "image/png", "screenshot.png");
      job.result = {
        kind: "image",
        ...quality,
        imageProduced: true,
        imageUrl: `/api/assets/${ingest.asset.id}`, assetId: ingest.asset.id, width: result.width, height: result.height,
        consoleErrors: result.consoleErrors, pageErrors: result.pageErrors,
        ...(job.expected.kind === "component" ? { bundleHash: job.expected.bundleHash }
          : job.expected.kind === "component-draft" ? { bundleHash: job.expected.bundleHash, draftRev: job.expected.rev }
          : { componentPins: job.componentPins }),
        rendererBuild: job.expected.rendererBuild, browserVersion: result.browserVersion,
      };
      job.status = "done";
      this.expire(job);
    } catch (error) {
      job.status = "error";
      job.error = { code: error instanceof ApiError ? error.code : "capture_failed", message: error instanceof Error ? error.message : String(error) };
      this.expire(job);
    } finally {
      this.sessions.revoke(session.token);
    }
  }

  /** Classify browser output once per job; capture-clean means no product errors. */
  private qualityOf(result: WorkerOk): CaptureQuality {
    const messages = [...(result.consoleErrors ?? []), ...(result.pageErrors ?? [])];
    const { productErrors, infraNoise } = classifyCaptureErrors(messages, { captureOrigin: this.deps.captureOrigin });
    return { captureClean: productErrors.length === 0, productErrors, infraNoise, runtimeWarnings: [...(result.consoleWarnings ?? [])] };
  }

  private targetOf(job: InternalJob): Record<string, unknown> {
    if (job.expected.kind === "prototype") {
      // P2.3: пины и их manifest-hash заморожены на enqueue. Поверхность рендерит их вместо
      // DTO-пинов, поэтому publish компонента между enqueue и рендером не меняет ни кадр,
      // ни публикуемый handshake — это существующий канал, allowlist остаётся path-only.
      return { kind: "prototype", rev: job.expected.rev,
        ...(job.capturePins ? { components: job.capturePins } : {}),
        ...(job.captureManifestHash !== undefined ? { componentManifestHash: job.captureManifestHash } : {}) };
    }
    if (job.expected.kind === "component-draft") {
      // Драфт (P1b): поверхность читает name/designSystem/bundleUrl отсюда — published-DTO нет.
      return { kind: "component-draft", componentId: job.expected.componentId, rev: job.expected.rev, ...(job.draft ? { name: job.draft.name, designSystem: job.draft.designSystem, bundleUrl: job.draft.bundleUrl } : {}) };
    }
    return { kind: "component", componentId: job.expected.componentId, version: job.expected.version };
  }
  private expire(job: InternalJob): void { job.resultExpiresAt = this.now() + RESULT_TTL_MS; }
}

/**
 * Conservative subset validation of props against a `z.toJSONSchema` document:
 * enforces object-ness, declared `required` presence, and top-level primitive
 * `type` mismatches. Lenient beyond that (avoids false rejects on the full
 * JSON-Schema surface); the trusted-code model is the real boundary.
 */
export function validatePropsAgainstSchema(props: unknown, schema: unknown): void {
  if (props === null || typeof props !== "object" || Array.isArray(props)) throw new ApiError(422, "invalid_props", "props must be a JSON object");
  const record = props as Record<string, unknown>;
  const walk = (node: unknown): boolean => {
    if (node === null) return true;
    const t = typeof node;
    if (t === "string" || t === "boolean") return true;
    if (t === "number") return Number.isFinite(node as number);
    if (Array.isArray(node)) return node.every(walk);
    if (t === "object") { for (const [k, v] of Object.entries(node as Record<string, unknown>)) { if (k.startsWith("$")) return false; if (!walk(v)) return false; } return true; }
    return false;
  };
  if (!walk(record)) throw new ApiError(422, "invalid_props", "props must be JSON-safe and free of $-prefixed keys");
  if (!schema || typeof schema !== "object") return;
  const s = schema as { required?: unknown; properties?: Record<string, { type?: unknown }> };
  if (Array.isArray(s.required)) for (const key of s.required) if (typeof key === "string" && !(key in record)) throw new ApiError(422, "invalid_props", `missing required prop: ${key}`);
  if (s.properties) for (const [key, def] of Object.entries(s.properties)) {
    if (!(key in record) || def?.type === undefined) continue;
    const expected = def.type;
    const value = record[key];
    if (typeof expected === "string" && !primitiveMatches(expected, value)) throw new ApiError(422, "invalid_props", `prop ${key} must be of type ${expected}`);
  }
}

function primitiveMatches(type: string, value: unknown): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": case "integer": return typeof value === "number";
    case "boolean": return typeof value === "boolean";
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array": return Array.isArray(value);
    case "null": return value === null;
    default: return true;
  }
}
