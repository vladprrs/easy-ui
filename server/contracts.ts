import { z } from "zod";
import { ApiError } from "./http";

// Declarative route registry. Minimal by design: it is the single source of truth for
// request-shape validation today and the input for the OpenAPI generator (T9) later.
// Register a contract with `registerContract`, then validate incoming path/query/body
// against it inside the handler with the `parse*` helpers.

export interface RouteError {
  status: number;
  code: string;
  description?: string;
}

export interface RouteContract {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD";
  // OpenAPI-style templated path, e.g. /api/prototypes/{id}/screens/{screenId}/render-status
  path: string;
  summary?: string;
  params?: z.ZodType;
  query?: z.ZodType;
  requestSchema?: z.ZodType;
  responseSchema?: z.ZodType;
  errors: RouteError[];
}

const registry: RouteContract[] = [];

export function registerContract(contract: RouteContract): RouteContract {
  registry.push(contract);
  return contract;
}

export function listContracts(): readonly RouteContract[] {
  return registry;
}

function issuesFrom(error: z.ZodError): { path: (string | number)[]; message: string }[] {
  return error.issues.map((issue) => ({ path: issue.path.map((part) => (typeof part === "number" ? part : String(part))), message: issue.message }));
}

// Validate a value against a contract-attached schema, throwing a 422 with pointer-ready issues.
export function parseWith<T>(schema: z.ZodType<T>, value: unknown, message = "Request is invalid"): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(422, "validation_failed", message, { issues: issuesFrom(parsed.error) });
  return parsed.data;
}

// Parse URLSearchParams into a plain object (last value wins) for query-schema validation.
export function parseQuery<T>(schema: z.ZodType<T>, searchParams: URLSearchParams): T {
  const raw: Record<string, string> = {};
  for (const [key, value] of searchParams) raw[key] = value;
  return parseWith(schema, raw, "Query parameters are invalid");
}

// --- Contracts registered by this task (T1) ---

const positiveIntFromString = z.string().regex(/^[1-9][0-9]*$/, "must be a positive integer").transform(Number);

export const renderStatusQuerySchema = z
  .strictObject({ version: positiveIntFromString.optional(), rev: positiveIntFromString.optional() })
  .refine((value) => !(value.version !== undefined && value.rev !== undefined), { message: "version and rev are mutually exclusive" });

export const renderStatusResponseSchema = z.object({
  status: z.object({ document: z.boolean(), bundles: z.boolean(), route: z.boolean() }),
  renderable: z.boolean(),
  url: z.string(),
  revision: z.number(),
  publishedVersion: z.number().nullable(),
  resolvedPins: z.array(z.object({ id: z.string(), name: z.string(), version: z.number(), bundleUrl: z.string(), bundleHash: z.string(), status: z.string() })),
  bundleStatus: z.enum(["ready", "failed"]),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
  errors: z.array(z.object({ code: z.string(), message: z.string() })),
});

export const renderStatusContract = registerContract({
  method: "GET",
  path: "/api/prototypes/{id}/screens/{screenId}/render-status",
  summary: "Report whether a prototype screen is renderable (document, bundles, local route).",
  query: renderStatusQuerySchema,
  responseSchema: renderStatusResponseSchema,
  errors: [
    { status: 404, code: "prototype_not_found" },
    { status: 404, code: "screen_not_found" },
    { status: 404, code: "version_not_found" },
    { status: 404, code: "revision_not_found" },
  ],
});

// --- Asset registry (T2) ---

export const assetPublicSchema = z.object({
  id: z.string(),
  sha256: z.string(),
  mime: z.string(),
  size: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
});

export const assetUploadResponseSchema = assetPublicSchema.extend({
  url: z.string(),
  deduplicated: z.literal(true).optional(),
});

export const uploadAssetContract = registerContract({
  method: "POST",
  path: "/api/assets",
  summary: "Upload a content-addressed asset (raw body with Content-Type, or a single-file multipart form).",
  responseSchema: assetUploadResponseSchema,
  errors: [
    { status: 413, code: "asset_too_large" },
    { status: 422, code: "unsupported_asset_type" },
    { status: 422, code: "asset_type_mismatch" },
  ],
});

export const getAssetContract = registerContract({
  method: "GET",
  path: "/api/assets/{id}",
  summary: "Fetch asset bytes with immutable caching and hardened, inert delivery headers.",
  errors: [{ status: 404, code: "asset_not_found" }],
});

// --- Screenshots (T6) ---

const viewportSchema = z.object({ width: z.number().int(), height: z.number().int() });
const screenshotErrors = [
  { status: 422, code: "invalid_viewport", description: "viewport/dsf bounds violated" },
  { status: 429, code: "queue_full", description: "screenshot queue is full" },
  { status: 501, code: "screenshot_unavailable", description: "no SERVE_DIST or chromium" },
];

export const jobAcceptedSchema = z.object({ jobId: z.string() });

export const prototypeScreenshotContract = registerContract({
  method: "POST",
  path: "/api/prototypes/{id}/screens/{screenId}/screenshot",
  summary: "Enqueue a prototype-screen screenshot job; resolves the target snapshot atomically.",
  requestSchema: z.object({ rev: z.number().int().optional(), version: z.number().int().optional(), viewport: viewportSchema, deviceScaleFactor: z.number().int().optional(), theme: z.string().optional(), waitForFonts: z.boolean().optional() }),
  responseSchema: jobAcceptedSchema,
  errors: [{ status: 404, code: "prototype_not_found" }, { status: 404, code: "screen_not_found" }, ...screenshotErrors],
});

export const componentScreenshotContract = registerContract({
  method: "POST",
  path: "/api/components/{id}/versions/{version}/screenshot",
  summary: "Enqueue a published-component screenshot job with optional props.",
  requestSchema: z.object({ props: z.record(z.string(), z.unknown()).optional(), viewport: viewportSchema, deviceScaleFactor: z.number().int().optional(), theme: z.string().optional(), waitForFonts: z.boolean().optional() }),
  responseSchema: jobAcceptedSchema,
  errors: [{ status: 404, code: "not_found" }, { status: 422, code: "invalid_props" }, ...screenshotErrors],
});

export const screenshotJobResultSchema = z.object({
  imageUrl: z.string(), assetId: z.string(), width: z.number(), height: z.number(),
  consoleErrors: z.array(z.string()), pageErrors: z.array(z.string()),
  bundleHash: z.string().optional(),
  componentPins: z.array(z.object({ id: z.string(), version: z.number(), bundleHash: z.string() })).optional(),
  rendererBuild: z.string().nullable(), browserVersion: z.string(),
});

export const screenshotJobContract = registerContract({
  method: "GET",
  path: "/api/screenshot-jobs/{jobId}",
  summary: "Poll a screenshot job (queued|running|done|error) and read its result.",
  responseSchema: z.object({ status: z.enum(["queued", "running", "done", "error"]), result: screenshotJobResultSchema.optional(), error: z.object({ code: z.string(), message: z.string() }).optional() }),
  errors: [{ status: 404, code: "job_not_found" }],
});

// --- Visual regression (T7) ---

const viewportPositiveSchema = z.object({ width: z.number().int().positive(), height: z.number().int().positive() });
const deviceScaleSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
const hashSchema = z.string().regex(/^[0-9a-f]+$/);

export const fingerprintContractSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("prototype-screen"), prototypeId: z.string(), screenId: z.string(), refRevision: z.number().int().positive(), viewport: viewportPositiveSchema, deviceScaleFactor: deviceScaleSchema, theme: z.enum(["light", "dark"]), propsHash: hashSchema.optional(), stateHash: hashSchema.optional() }),
  z.object({ scope: z.literal("component"), componentId: z.string(), refVersion: z.number().int().positive(), viewport: viewportPositiveSchema, deviceScaleFactor: deviceScaleSchema, theme: z.enum(["light", "dark"]), propsHash: hashSchema.optional(), stateHash: hashSchema.optional() }),
]);

const metricResultSchema = z.object({ diffPixels: z.number(), totalPixels: z.number(), diffPercent: z.number() });
const evidenceAssetSchema = z.object({ assetId: z.string(), url: z.string(), sha256: z.string(), width: z.number().nullable(), height: z.number().nullable(), mime: z.string() });

export const runReportSchema = z.object({
  runId: z.string(), referenceId: z.string(),
  status: z.enum(["pass", "fail", "error", "reference_missing"]),
  createdAt: z.string(),
  metric: z.string().nullable(), metricOptions: z.record(z.string(), z.unknown()).nullable(),
  diffPixels: z.number().nullable(), totalPixels: z.number().nullable(), diffPercent: z.number().nullable(),
  metrics: z.object({ "exact-rgba": metricResultSchema.optional(), "pixelmatch-v1": metricResultSchema.optional() }),
  reference: evidenceAssetSchema.nullable(), candidate: evidenceAssetSchema.nullable(),
  diff: z.object({ assetId: z.string(), url: z.string() }).nullable(),
  candidateMeta: z.record(z.string(), z.unknown()).nullable(),
});

export const referencePublicSchema = z.object({
  id: z.string(), fingerprint: z.unknown(), note: z.string().nullable(), createdAt: z.string(),
  asset: assetPublicSchema.extend({ url: z.string() }).nullable(),
  lastRun: runReportSchema.nullable(),
});

export const putVisualReferenceContract = registerContract({
  method: "PUT",
  path: "/api/visual-references",
  summary: "Upsert a visual reference by canonical fingerprint (asset must exist and be a PNG).",
  requestSchema: z.object({ fingerprint: fingerprintContractSchema, assetId: z.string(), note: z.string().optional() }),
  responseSchema: referencePublicSchema,
  errors: [{ status: 422, code: "asset_not_found" }, { status: 422, code: "invalid_reference_asset" }, { status: 422, code: "validation_failed" }],
});

export const listVisualReferencesContract = registerContract({
  method: "GET",
  path: "/api/visual-references",
  summary: "List visual references (optionally filtered by scope/prototypeId/componentId) with the last run.",
  query: z.object({ scope: z.enum(["prototype-screen", "component"]).optional(), prototypeId: z.string().optional(), componentId: z.string().optional() }),
  responseSchema: z.object({ references: z.array(referencePublicSchema) }),
  errors: [],
});

export const getVisualReferenceContract = registerContract({
  method: "GET",
  path: "/api/visual-references/{id}",
  summary: "Fetch a visual reference with its full run history.",
  responseSchema: referencePublicSchema.extend({ runs: z.array(runReportSchema) }),
  errors: [{ status: 404, code: "reference_not_found" }],
});

export const checkVisualReferenceContract = registerContract({
  method: "POST",
  path: "/api/visual-references/{id}/check",
  summary: "Capture a candidate for the reference fingerprint and enqueue an honest diff run.",
  requestSchema: z.object({ threshold: z.number().min(0).max(100).optional() }),
  responseSchema: z.object({ runId: z.string(), jobId: z.string().optional() }),
  errors: [{ status: 404, code: "reference_not_found" }, { status: 422, code: "invalid_threshold" }, { status: 501, code: "screenshot_unavailable" }],
});

// --- Design-system theme versions (T8) ---

const tokenValueContractSchema = z.union([z.string(), z.number()]);
const themeTokensSchema = z.record(z.string(), tokenValueContractSchema);
const themeFontSchema = z.object({ family: z.string(), src: z.string(), weight: z.union([z.number(), z.string()]).optional(), style: z.string().optional() });
const themeIconSchema = z.object({ name: z.string(), assetId: z.string(), viewBox: z.string().optional(), themes: z.object({ light: z.string().optional(), dark: z.string().optional() }).optional() });
export const themeContentSchema = z.object({ tokens: themeTokensSchema, fonts: z.array(themeFontSchema), icons: z.array(themeIconSchema) });

export const patchDesignSystemThemeContract = registerContract({
  method: "PATCH",
  path: "/api/design-systems/{id}",
  summary: "Append an immutable theme version (tokens/fonts/icons) to a custom design system (CAS on baseVersion).",
  requestSchema: z.object({ tokens: themeTokensSchema.optional(), fonts: z.array(themeFontSchema).optional(), icons: z.array(themeIconSchema).optional(), baseVersion: z.number().int().min(0) }),
  responseSchema: z.object({ id: z.string(), latestMetaVersion: z.number().nullable() }).and(themeContentSchema),
  errors: [
    { status: 404, code: "not_found" },
    { status: 405, code: "method_not_allowed", description: "builtin themes are immutable" },
    { status: 409, code: "version_conflict" },
    { status: 422, code: "validation_failed" },
  ],
});

export const getDesignSystemVersionContract = registerContract({
  method: "GET",
  path: "/api/design-systems/{id}/versions/{version}",
  summary: "Read an immutable design-system theme version.",
  responseSchema: z.object({ systemId: z.string(), version: z.number(), createdAt: z.string() }).and(themeContentSchema),
  errors: [{ status: 404, code: "not_found" }],
});

export const getVisualRunContract = registerContract({
  method: "GET",
  path: "/api/visual-runs/{runId}",
  summary: "Poll a visual run: a running placeholder, or the terminal evidence report.",
  responseSchema: z.union([runReportSchema, z.object({ runId: z.string(), referenceId: z.string(), status: z.literal("running"), jobId: z.string() })]),
  errors: [{ status: 404, code: "run_not_found" }],
});
