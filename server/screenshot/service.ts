import type { Database } from "bun:sqlite";
import { canonicalStringify } from "../../src/capture/canonicalJson";
import type { CaptureExpected } from "../../src/capture/protocol";
import { getLatestDesignSystemContent } from "../designSystems";
import { ApiError } from "../http";
import { AssetRepo } from "../repos/assets";
import { ComponentRepo } from "../repos/components";
import { PrototypeRepo } from "../repos/prototypes";
import { buildStaticAllowedUrls, rendererBuildFrom } from "./allowedUrls";
import { CaptureSessionStore, JOB_DEADLINE_MS } from "./sessions";

export interface Viewport { width: number; height: number }
export interface JobStatus { status: "queued" | "running" | "done" | "error"; result?: ScreenshotResult; error?: { code: string; message: string } }
export interface ScreenshotResult {
  imageUrl: string; assetId: string; width: number; height: number;
  consoleErrors: string[]; pageErrors: string[];
  bundleHash?: string; componentPins?: { id: string; version: number; bundleHash: string }[];
  rendererBuild: string | null; browserVersion: string;
}

export interface WorkerJob {
  captureOrigin: string; captureUrl: string; token: string;
  bootstrap: { kind: "prototype" | "component"; target: Record<string, unknown>; props?: Record<string, unknown>; expected: CaptureExpected };
  allowedUrls: string[]; viewport: Viewport; deviceScaleFactor: number; colorScheme: "light" | "dark"; waitForFonts: boolean; expected: CaptureExpected;
}
export type WorkerOk = { ok: true; pngBase64: string; width: number; height: number; consoleErrors: string[]; pageErrors: string[]; browserVersion: string };
export type WorkerErr = { ok: false; error: string; consoleErrors?: string[]; pageErrors?: string[] };
export type WorkerResult = WorkerOk | WorkerErr;
export type RunJob = (job: WorkerJob, deadlineMs: number) => Promise<WorkerResult>;

interface InternalJob {
  id: string; status: JobStatus["status"]; kind: "prototype" | "component";
  expected: CaptureExpected; allowedUrls: string[]; props?: Record<string, unknown>;
  captureUrl: string; viewport: Viewport; dsf: number; theme: "light" | "dark"; waitForFonts: boolean;
  componentPins?: { id: string; version: number; bundleHash: string }[];
  result?: ScreenshotResult; error?: { code: string; message: string }; resultExpiresAt?: number;
}

export const MAX_QUEUE = 5;
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

export interface ScreenshotServiceDeps {
  db: Database; dataDir: string; serveDist?: string;
  captureOrigin: string; chromiumAvailable: boolean; runJob: RunJob;
  sessions?: CaptureSessionStore; now?: () => number;
}

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

  enqueuePrototype(id: string, screenId: string, opts: { rev?: number; version?: number; viewport: unknown; deviceScaleFactor?: unknown; theme?: string; waitForFonts?: boolean }): { jobId: string } {
    this.requireAvailable();
    const { viewport, dsf } = validateViewport(opts.viewport, opts.deviceScaleFactor);
    this.guardQueue();
    const repo = new PrototypeRepo(this.deps.db);
    // Atomic snapshot: resolve rev now so a later save cannot move the target.
    const snap = repo.screenRenderStatus(id, screenId, { rev: opts.rev, version: opts.version });
    const full = repo.revision(id, snap.rev);
    const componentPins = full.components.map((p) => ({ id: p.id, version: p.version, bundleHash: p.bundleHash }));
    const theme = opts.theme === "dark" ? "dark" : "light";
    const expected: CaptureExpected = { kind: "prototype", rev: snap.rev, componentManifestHash: full.componentManifestHash, builtinCatalogHash: full.builtinCatalogHash, dsMetaVersion: full.designSystemMetaVersion ?? null, rendererBuild: this.rendererBuild };
    const allowedUrls = this.prototypeAllowedUrls(id, screenId, full.components, full.assets.map((a) => a.id), (full.doc as { designSystem?: string }).designSystem);
    const query = new URLSearchParams();
    if (opts.version !== undefined) query.set("version", String(opts.version)); else query.set("rev", String(snap.rev));
    query.set("theme", theme); query.set("dsf", String(dsf));
    const captureUrl = `/capture/${encodeURIComponent(id)}/s/${encodeURIComponent(screenId)}?${query}`;
    return this.push({ kind: "prototype", expected, allowedUrls, captureUrl, viewport, dsf, theme, waitForFonts: opts.waitForFonts !== false, componentPins });
  }

  enqueueComponent(id: string, version: number, opts: { props?: Record<string, unknown>; viewport: unknown; deviceScaleFactor?: unknown; theme?: string; waitForFonts?: boolean }): { jobId: string } {
    this.requireAvailable();
    const { viewport, dsf } = validateViewport(opts.viewport, opts.deviceScaleFactor);
    this.guardQueue();
    const repo = new ComponentRepo(this.deps.db);
    const dto = repo.version(id, version) as { version: number; bundleHash: string; designSystem: string; propsJsonSchema?: unknown; assets: { id: string }[] };
    const props = opts.props ?? {};
    validatePropsAgainstSchema(props, dto.propsJsonSchema);
    const propsHash = propsHashOf(props);
    const theme = opts.theme === "dark" ? "dark" : "light";
    const expected: CaptureExpected = { kind: "component", componentId: id, version, bundleHash: dto.bundleHash, propsHash, dsMetaVersion: getLatestDesignSystemContent(this.deps.db, dto.designSystem).latestMetaVersion, rendererBuild: this.rendererBuild };
    const allowedUrls = this.componentAllowedUrls(id, version, dto.assets.map((a) => a.id), dto.designSystem);
    const query = new URLSearchParams({ theme, dsf: String(dsf) });
    const captureUrl = `/capture/component/${encodeURIComponent(id)}/${version}?${query}`;
    return this.push({ kind: "component", expected, allowedUrls, props, captureUrl, viewport, dsf, theme, waitForFonts: opts.waitForFonts !== false });
  }

  private prototypeAllowedUrls(id: string, screenId: string, pins: { id: string; version: number }[], docAssetIds: string[], designSystem?: string): string[] {
    const set = new Set<string>();
    set.add(`/capture/${id}/s/${screenId}`);
    if (designSystem) { set.add(`/api/design-systems/${designSystem}`); set.add(`/api/design-systems/${designSystem}/versions/`); }
    set.add(`/api/prototypes/${id}/draft`);
    set.add(`/api/prototypes/${id}/revisions`);
    // draft/revision/version endpoints (shell may hit any depending on selector)
    for (const p of pins) set.add(`/api/components/${p.id}/versions/${p.version}/bundle.js`);
    for (const assetId of docAssetIds) set.add(`/api/assets/${assetId}`);
    const componentRepo = new ComponentRepo(this.deps.db);
    for (const p of pins) for (const a of componentRepo.assets(p.id, p.version)) set.add(`/api/assets/${a.id}`);
    set.add("/api/prototypes/"); // revisions/:rev and versions/:v (GET-only, transitive read)
    set.add("/api/shims/");
    for (const s of buildStaticAllowedUrls(this.deps.serveDist)) set.add(s);
    return [...set];
  }
  private componentAllowedUrls(id: string, version: number, assetIds: string[], designSystem?: string): string[] {
    const set = new Set<string>();
    set.add(`/capture/component/${id}/${version}`);
    if (designSystem) { set.add(`/api/design-systems/${designSystem}`); set.add(`/api/design-systems/${designSystem}/versions/`); }
    set.add(`/api/components/${id}`);
    set.add(`/api/components/${id}/versions/${version}`);
    set.add(`/api/components/${id}/versions/${version}/bundle.js`);
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
        bootstrap: { kind: job.kind, target: this.targetOf(job), ...(job.props ? { props: job.props } : {}), expected: job.expected },
        allowedUrls: job.allowedUrls, viewport: job.viewport, deviceScaleFactor: job.dsf, colorScheme: job.theme, waitForFonts: job.waitForFonts, expected: job.expected,
      };
      const result = await this.deps.runJob(workerJob, JOB_DEADLINE_MS);
      if (!result.ok) { job.status = "error"; job.error = { code: "capture_failed", message: result.error }; this.expire(job); return; }
      const bytes = Buffer.from(result.pngBase64, "base64");
      const assetRepo = new AssetRepo(this.deps.db, this.deps.dataDir);
      const ingest = await assetRepo.ingest(new Uint8Array(bytes), "image/png", "screenshot.png");
      job.result = {
        imageUrl: `/api/assets/${ingest.asset.id}`, assetId: ingest.asset.id, width: result.width, height: result.height,
        consoleErrors: result.consoleErrors, pageErrors: result.pageErrors,
        ...(job.expected.kind === "component" ? { bundleHash: job.expected.bundleHash } : { componentPins: job.componentPins }),
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

  private targetOf(job: InternalJob): Record<string, unknown> {
    return job.expected.kind === "prototype"
      ? { kind: "prototype", rev: job.expected.rev }
      : { kind: "component", componentId: job.expected.componentId, version: job.expected.version };
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
