import { z } from "zod";
import { prototypeDocSchema } from "../src/prototype/schema";
import { ApiError } from "./http";
import { figmaSchema } from "./figma";

// Figma provenance (plan §J): optional on write, nullable on read-back.
const figmaResponseSchema = figmaSchema.nullable();

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
  /** Success status code for the OpenAPI document (default 200). */
  status?: number;
  /** Content type of a non-JSON success response (openapi: content key without schema). */
  contentType?: string;
  /**
   * true — the handler validates its input through this contract's schemas (parseWith/parseQuery).
   * false/omitted — the contract is documentation; the handler validates independently.
   */
  validated?: boolean;
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
  validated: true,
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
  status: 201,
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
  status: 202,
  requestSchema: z.object({ rev: z.number().int().optional(), version: z.number().int().optional(), viewport: viewportSchema, deviceScaleFactor: z.number().int().optional(), theme: z.string().optional(), waitForFonts: z.boolean().optional() }),
  responseSchema: jobAcceptedSchema,
  errors: [{ status: 404, code: "prototype_not_found" }, { status: 404, code: "screen_not_found" }, { status: 404, code: "version_not_found" }, { status: 404, code: "revision_not_found" }, ...screenshotErrors],
});

export const componentScreenshotContract = registerContract({
  method: "POST",
  path: "/api/components/{id}/versions/{version}/screenshot",
  summary: "Enqueue a published-component screenshot job with optional props.",
  status: 202,
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
  status: 202,
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

// --- T9: remaining endpoints. These contracts are documentation-first (validated: false):
// the handlers keep their existing hand-rolled validation; the schemas below describe the
// wire format for OpenAPI generation and the contract test. Complex DTOs list their main
// fields and stay loose (passthrough) on purpose.

const errorCatalog = {
  invalidRequest: { status: 400, code: "invalid_request" },
  baseRevRequired: { status: 400, code: "base_rev_required" },
  notFound: { status: 404, code: "not_found" },
  prototypeNotFound: { status: 404, code: "prototype_not_found" },
  versionNotFound: { status: 404, code: "version_not_found" },
  revisionNotFound: { status: 404, code: "revision_not_found" },
  methodNotAllowed: { status: 405, code: "method_not_allowed" },
  alreadyExists: { status: 409, code: "already_exists" },
  revConflict: { status: 409, code: "revision_conflict" },
  alreadyPublished: { status: 409, code: "already_published" },
  payloadTooLarge: { status: 413, code: "payload_too_large" },
  unsupportedMediaType: { status: 415, code: "unsupported_media_type" },
  validationFailed: { status: 422, code: "validation_failed" },
} as const;

const slugString = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const positiveInt = z.number().int().positive();
const isoDate = z.string();
const issueSchema = z.looseObject({ path: z.unknown(), message: z.string() });
const screenUrlSchema = z.object({ id: z.string(), url: z.string() });
const casBody = { baseRev: positiveInt, message: z.string().optional() };

// --- Prototypes CRUD / revisions / versions / publish / restore ---

const prototypeListItemSchema = z.looseObject({
  id: z.string(), name: z.string(), designSystem: z.string(), device: z.string(),
  screenCount: z.number(), headRev: z.number(), latestVersion: z.number().nullable(), updatedAt: isoDate,
});

export const listPrototypesContract = registerContract({
  method: "GET", path: "/api/prototypes",
  summary: "List prototypes with head revision and latest published version.",
  responseSchema: z.array(prototypeListItemSchema),
  errors: [errorCatalog.methodNotAllowed],
});

export const createPrototypeContract = registerContract({
  method: "POST", path: "/api/prototypes",
  summary: "Create a prototype from a document (revision 1); validates against the design-system catalog.",
  status: 201,
  requestSchema: z.object({ doc: prototypeDocSchema, message: z.string().optional(), figma: figmaSchema.optional() }),
  responseSchema: z.looseObject({ id: z.string(), rev: z.literal(1), warnings: z.array(issueSchema), screens: z.array(screenUrlSchema) }),
  errors: [errorCatalog.invalidRequest, errorCatalog.alreadyExists, errorCatalog.validationFailed, { status: 422, code: "asset_not_found" }],
});

const renderableSchema = z.object({ head: z.boolean(), published: z.boolean().nullable() });

export const getPrototypeContract = registerContract({
  method: "GET", path: "/api/prototypes/{id}",
  summary: "Prototype lifecycle meta: head/draft revision, validated revision, published versions, renderable.",
  responseSchema: z.looseObject({
    id: z.string(), name: z.string(), designSystem: z.string(), headRev: z.number(),
    latestVersion: z.number().nullable(), versions: z.array(z.looseObject({ version: z.number(), rev: z.number(), publishedAt: isoDate })),
    updatedAt: isoDate, draftRevision: z.number(), validatedRevision: z.number().nullable(),
    publishedVersion: z.number().nullable(), renderable: renderableSchema, figma: figmaResponseSchema,
  }),
  errors: [errorCatalog.prototypeNotFound],
});

export const savePrototypeContract = registerContract({
  method: "PUT", path: "/api/prototypes/{id}",
  summary: "Save a new head revision (CAS on baseRev); document id must match the path id.",
  requestSchema: z.object({ doc: prototypeDocSchema, figma: figmaSchema.optional(), ...casBody }),
  responseSchema: z.looseObject({ rev: z.number(), warnings: z.array(issueSchema), screens: z.array(screenUrlSchema) }),
  errors: [errorCatalog.invalidRequest, errorCatalog.baseRevRequired, errorCatalog.prototypeNotFound, errorCatalog.revConflict, errorCatalog.validationFailed],
});

export const deletePrototypeContract = registerContract({
  method: "DELETE", path: "/api/prototypes/{id}",
  summary: "Delete a prototype (CAS on baseRev). Responds 204 without a body.",
  status: 204,
  requestSchema: z.object({ baseRev: positiveInt }),
  errors: [errorCatalog.baseRevRequired, errorCatalog.prototypeNotFound, errorCatalog.revConflict],
});

const prototypeRevisionCoreSchema = z.looseObject({
  doc: z.looseObject({ id: z.string(), version: z.literal(1), screens: z.array(z.unknown()) }),
  rev: z.number(), builtinCatalogHash: z.string(), componentManifestHash: z.string(),
  components: z.array(z.looseObject({ id: z.string(), version: z.number() })),
  assets: z.array(assetPublicSchema.omit({ width: true, height: true })),
  designSystemMetaVersion: z.number().nullable(),
  figma: figmaResponseSchema,
});

export const getPrototypeDraftContract = registerContract({
  method: "GET", path: "/api/prototypes/{id}/draft",
  summary: "Read the head revision document with catalog hashes, component pins and asset pins.",
  responseSchema: prototypeRevisionCoreSchema,
  errors: [errorCatalog.prototypeNotFound],
});

export const listPrototypeRevisionsContract = registerContract({
  method: "GET", path: "/api/prototypes/{id}/revisions",
  summary: "List revisions (newest first) with cursor pagination.",
  query: z.object({ limit: z.string().optional(), before: z.string().optional() }),
  responseSchema: z.array(z.looseObject({ rev: z.number(), message: z.string().nullable(), createdAt: isoDate })),
  errors: [errorCatalog.invalidRequest, errorCatalog.prototypeNotFound],
});

export const getPrototypeRevisionContract = registerContract({
  method: "GET", path: "/api/prototypes/{id}/revisions/{rev}",
  summary: "Read a specific immutable revision.",
  responseSchema: prototypeRevisionCoreSchema.extend({ message: z.string().nullable(), createdAt: isoDate }),
  errors: [errorCatalog.invalidRequest, errorCatalog.prototypeNotFound, errorCatalog.revisionNotFound],
});

export const restorePrototypeContract = registerContract({
  method: "POST", path: "/api/prototypes/{id}/restore",
  summary: "Restore an older revision as a new head revision (copies component/asset pins).",
  requestSchema: z.object({ rev: positiveInt, ...casBody }),
  responseSchema: z.looseObject({ rev: z.number() }),
  errors: [errorCatalog.invalidRequest, errorCatalog.baseRevRequired, errorCatalog.prototypeNotFound, errorCatalog.revisionNotFound, errorCatalog.revConflict, errorCatalog.validationFailed],
});

export const publishPrototypeContract = registerContract({
  method: "POST", path: "/api/prototypes/{id}/publish",
  summary: "Publish the head revision as the next immutable version; returns canonical screen URLs.",
  status: 201,
  requestSchema: z.object(casBody),
  responseSchema: z.looseObject({ version: z.number(), rev: z.number(), screens: z.array(screenUrlSchema) }),
  errors: [errorCatalog.baseRevRequired, errorCatalog.prototypeNotFound, errorCatalog.revConflict, errorCatalog.alreadyPublished, errorCatalog.validationFailed],
});

export const listPrototypeVersionsContract = registerContract({
  method: "GET", path: "/api/prototypes/{id}/versions",
  summary: "List published versions.",
  responseSchema: z.array(z.looseObject({ version: z.number(), rev: z.number(), publishedAt: isoDate })),
  errors: [errorCatalog.prototypeNotFound],
});

export const getPrototypeVersionContract = registerContract({
  method: "GET", path: "/api/prototypes/{id}/versions/{version}",
  summary: "Read a published version (immutable cache headers).",
  responseSchema: prototypeRevisionCoreSchema.extend({ version: z.number(), publishedAt: isoDate }),
  errors: [errorCatalog.invalidRequest, errorCatalog.prototypeNotFound, errorCatalog.versionNotFound],
});

// --- Scoped prototype shares (W3-3) ---

export const createShareRequestSchema = z.strictObject({
  version: positiveInt,
  ttlSeconds: z.number().int().min(5 * 60).max(30 * 24 * 60 * 60),
});

export const shareGrantSchema = z.object({
  id: z.string(),
  prototypeId: z.string(),
  version: positiveInt,
  createdAt: isoDate,
  expiresAt: isoDate,
  activeSessions: z.number().int().nonnegative(),
});

export const createPrototypeShareContract = registerContract({
  method: "POST",
  path: "/api/prototypes/{id}/share",
  summary: "Create a time-limited public share grant pinned to an immutable published version.",
  status: 201,
  requestSchema: createShareRequestSchema,
  responseSchema: shareGrantSchema.extend({ url: z.string().url() }),
  validated: true,
  errors: [
    errorCatalog.prototypeNotFound,
    errorCatalog.versionNotFound,
    errorCatalog.validationFailed,
    { status: 422, code: "version_not_renderable" },
  ],
});

export const listPrototypeSharesContract = registerContract({
  method: "GET",
  path: "/api/prototypes/{id}/share",
  summary: "List active, unexpired share grants without disclosing their bearer tokens.",
  responseSchema: z.object({ shares: z.array(shareGrantSchema) }),
  errors: [],
});

export const revokePrototypeShareContract = registerContract({
  method: "DELETE",
  path: "/api/prototypes/{id}/share/{shareId}",
  summary: "Revoke a share grant and immediately invalidate all sessions minted from it.",
  status: 204,
  validated: true,
  errors: [errorCatalog.validationFailed, { status: 404, code: "share_not_found" }],
});

// --- Components CRUD / publish / versions / bundle ---

const componentListItemSchema = z.looseObject({
  id: z.string(), name: z.string(), designSystem: z.string(), headRev: z.number(),
  latestVersion: z.number().nullable(), updatedAt: isoDate,
});

export const listComponentsContract = registerContract({
  method: "GET", path: "/api/components",
  summary: "List custom components with head revision and latest active version.",
  responseSchema: z.array(componentListItemSchema),
  errors: [errorCatalog.methodNotAllowed],
});

export const createComponentContract = registerContract({
  method: "POST", path: "/api/components",
  summary: "Create a custom component from TSX source (syntax-checked and definition-extracted).",
  status: 201,
  requestSchema: z.object({ id: slugString, name: z.string().regex(/^[A-Z][A-Za-z0-9]*$/), source: z.string(), designSystem: slugString.optional(), message: z.string().optional(), figma: figmaSchema.optional() }),
  responseSchema: z.looseObject({ id: z.string(), rev: z.literal(1) }),
  errors: [errorCatalog.invalidRequest, errorCatalog.alreadyExists, errorCatalog.payloadTooLarge, errorCatalog.validationFailed],
});

export const getComponentContract = registerContract({
  method: "GET", path: "/api/components/{id}",
  summary: "Component lifecycle meta: head revision, versions, validated revision, renderable.",
  responseSchema: z.looseObject({
    id: z.string(), name: z.string(), designSystem: z.string(), headRev: z.number(),
    versions: z.array(z.unknown()), updatedAt: isoDate, draftRevision: z.number(), publishedVersion: z.number().nullable(),
    figma: figmaResponseSchema,
  }),
  errors: [errorCatalog.notFound],
});

export const saveComponentContract = registerContract({
  method: "PUT", path: "/api/components/{id}",
  summary: "Save a new head revision of source and/or move the component between design systems (CAS on baseRev).",
  requestSchema: z.object({ source: z.string().optional(), designSystem: slugString.optional(), figma: figmaSchema.optional(), ...casBody }),
  responseSchema: z.looseObject({ rev: z.number() }),
  errors: [errorCatalog.invalidRequest, errorCatalog.baseRevRequired, errorCatalog.notFound, errorCatalog.revConflict, errorCatalog.payloadTooLarge, errorCatalog.validationFailed],
});

export const deleteComponentContract = registerContract({
  method: "DELETE", path: "/api/components/{id}",
  summary: "Soft-delete a component (CAS on baseRev). Responds 204 without a body.",
  status: 204,
  requestSchema: z.object({ baseRev: positiveInt }),
  errors: [errorCatalog.baseRevRequired, errorCatalog.notFound, errorCatalog.revConflict],
});

const componentSourceSchema = z.looseObject({ rev: z.number(), source: z.string(), designSystem: z.string(), figma: figmaResponseSchema, message: z.string().nullable(), createdAt: isoDate });

export const getComponentSourceContract = registerContract({
  method: "GET", path: "/api/components/{id}/source",
  summary: "Read the head revision source.",
  responseSchema: componentSourceSchema,
  errors: [errorCatalog.notFound],
});

export const getComponentDraftContract = registerContract({
  method: "GET", path: "/api/components/{id}/draft",
  summary: "Alias of /source: read the head revision source.",
  responseSchema: componentSourceSchema,
  errors: [errorCatalog.notFound],
});

export const listComponentRevisionsContract = registerContract({
  method: "GET", path: "/api/components/{id}/revisions",
  summary: "List source revisions (newest first).",
  responseSchema: z.array(z.looseObject({ rev: z.number(), designSystem: z.string(), message: z.string().nullable(), createdAt: isoDate })),
  errors: [errorCatalog.notFound],
});

export const getComponentRevisionContract = registerContract({
  method: "GET", path: "/api/components/{id}/revisions/{rev}",
  summary: "Read a specific source revision.",
  responseSchema: componentSourceSchema,
  errors: [errorCatalog.invalidRequest, errorCatalog.notFound],
});

export const restoreComponentContract = registerContract({
  method: "POST", path: "/api/components/{id}/restore",
  summary: "Restore an older source revision as a new head revision.",
  requestSchema: z.object({ rev: positiveInt, ...casBody }),
  responseSchema: z.looseObject({ rev: z.number() }),
  errors: [errorCatalog.invalidRequest, errorCatalog.baseRevRequired, errorCatalog.notFound, errorCatalog.revConflict],
});

export const publishComponentContract = registerContract({
  method: "POST", path: "/api/components/{id}/publish",
  summary: "Publish the head revision: typecheck, compile, import-verify and activate the next version.",
  status: 201,
  requestSchema: z.object(casBody),
  responseSchema: z.looseObject({ version: z.number(), hostAbiVersion: z.number(), warnings: z.array(z.string()) }),
  errors: [errorCatalog.baseRevRequired, errorCatalog.notFound, errorCatalog.revConflict, errorCatalog.alreadyPublished, errorCatalog.validationFailed, { status: 422, code: "event_schema_not_serializable" }],
});

export const listComponentVersionsContract = registerContract({
  method: "GET", path: "/api/components/{id}/versions",
  summary: "List published versions with lifecycle status.",
  responseSchema: z.array(z.looseObject({ version: z.number(), rev: z.number(), status: z.string(), designSystem: z.string(), publishedAt: isoDate })),
  errors: [errorCatalog.notFound],
});

export const getComponentVersionContract = registerContract({
  method: "GET", path: "/api/components/{id}/versions/{version}",
  summary: "Read a published version: source, definition metadata, bundle hash, ABI, asset pins.",
  responseSchema: z.looseObject({
    version: z.number(), rev: z.number(), source: z.string(), designSystem: z.string(),
    events: z.array(z.string()), slots: z.array(z.string()), description: z.string(),
    bundleHash: z.string(), hostAbiVersion: z.number(),
    assets: z.array(assetPublicSchema.omit({ width: true, height: true })), figma: figmaResponseSchema, publishedAt: isoDate,
  }),
  errors: [errorCatalog.invalidRequest, errorCatalog.notFound],
});

export const setComponentVersionStatusContract = registerContract({
  method: "POST", path: "/api/components/{id}/versions/{version}/status",
  summary: "Transition a published version's lifecycle status (transition matrix, CAS by statusRev).",
  requestSchema: z.object({
    status: z.enum(["active", "rejected", "deprecated", "superseded", "archived"]),
    reason: z.string().optional(),
    supersededBy: positiveInt.optional(),
    baseStatusRev: positiveInt,
  }),
  responseSchema: z.looseObject({ status: z.string(), statusRev: z.number() }),
  errors: [errorCatalog.invalidRequest, errorCatalog.notFound, { status: 409, code: "status_conflict" }, { status: 422, code: "invalid_transition" }, errorCatalog.validationFailed],
});

export const getComponentBundleContract = registerContract({
  method: "GET", path: "/api/components/{id}/versions/{version}/bundle.js",
  summary: "Fetch the compiled ESM bundle of an active version (immutable cache headers).",
  contentType: "text/javascript",
  errors: [errorCatalog.invalidRequest, errorCatalog.notFound],
});

// --- Design systems ---

const designSystemSummarySchema = z.looseObject({
  id: z.string(), name: z.string(), description: z.string(), builtinCatalogHash: z.string(),
  components: z.array(z.looseObject({ name: z.string(), description: z.string(), events: z.array(z.string()), slots: z.array(z.string()) })),
  latestMetaVersion: z.number().nullable(),
  tokens: themeTokensSchema, fonts: z.array(themeFontSchema), icons: z.array(themeIconSchema),
});

export const listDesignSystemsContract = registerContract({
  method: "GET", path: "/api/design-systems",
  summary: "List registered design systems (builtin + custom) with catalogs and latest theme content.",
  responseSchema: z.object({ designSystems: z.array(designSystemSummarySchema) }),
  errors: [errorCatalog.methodNotAllowed],
});

export const getDesignSystemContract = registerContract({
  method: "GET", path: "/api/design-systems/{id}",
  summary: "Read one design system summary.",
  responseSchema: designSystemSummarySchema,
  errors: [errorCatalog.notFound],
});

export const createDesignSystemContract = registerContract({
  method: "POST", path: "/api/design-systems",
  summary: "Register a custom design system.",
  status: 201,
  requestSchema: z.strictObject({ id: slugString, name: z.string(), description: z.string() }),
  responseSchema: designSystemSummarySchema,
  errors: [errorCatalog.invalidRequest, errorCatalog.alreadyExists, errorCatalog.validationFailed],
});

// --- Catalog manifest / shims / health ---

export const catalogManifestContract = registerContract({
  method: "GET", path: "/api/catalog/manifest",
  summary: "Manifest of the latest active custom-component versions across design systems.",
  responseSchema: z.object({ components: z.array(z.looseObject({ id: z.string(), name: z.string(), designSystem: z.string(), version: z.number(), bundleUrl: z.string(), bundleHash: z.string(), hostAbiVersion: z.number() })) }),
  errors: [errorCatalog.methodNotAllowed],
});

export const getShimContract = registerContract({
  method: "GET", path: "/api/shims/{abi}/{file}",
  summary: "Host-provided ESM shims for published bundles (abi v1: react/zod/…; v2 additionally easy-ui/runtime).",
  contentType: "text/javascript",
  errors: [{ status: 404, code: "not_found" }, errorCatalog.methodNotAllowed],
});

export const healthContract = registerContract({
  method: "GET", path: "/api/health",
  summary: "Liveness/readiness: 200 ready, 503 while starting. Exempt from BasicAuth.",
  responseSchema: z.object({ status: z.enum(["ready", "starting"]) }),
  errors: [errorCatalog.methodNotAllowed],
});

// --- Discovery (T9: served by server/routes/meta.ts) ---

export const openapiContract = registerContract({
  method: "GET", path: "/api/openapi.json",
  summary: "OpenAPI 3.1 document generated from this contract registry (committed as server/openapi.json).",
  validated: true,
  responseSchema: z.looseObject({ openapi: z.string(), info: z.looseObject({ title: z.string(), version: z.string() }), paths: z.record(z.string(), z.unknown()) }),
  errors: [errorCatalog.methodNotAllowed],
});

export const prototypeDocumentSchemaContract = registerContract({
  method: "GET", path: "/api/schemas/prototype-document.json",
  summary: "JSON Schema of the prototype document format, with directive annotations ($state/$bindState/$template/$cond/$asset and event param sources).",
  validated: true,
  responseSchema: z.looseObject({ $schema: z.string(), type: z.literal("object"), properties: z.record(z.string(), z.unknown()) }),
  errors: [errorCatalog.methodNotAllowed],
});

export const componentDefinitionSchemaContract = registerContract({
  method: "GET", path: "/api/schemas/component-definition.json",
  summary: "JSON Schema of the exported custom-component `definition` contract.",
  validated: true,
  responseSchema: z.looseObject({ $schema: z.string(), type: z.literal("object"), properties: z.record(z.string(), z.unknown()) }),
  errors: [errorCatalog.methodNotAllowed],
});

export const capabilitiesResponseSchema = z.object({
  apiVersion: z.literal(1),
  documentVersion: z.literal(1),
  actions: z.array(z.string()),
  directives: z.array(z.string()),
  paramSources: z.array(z.string()),
  conditions: z.array(z.string()),
  limits: z.object({
    elements: z.number(), depth: z.number(), bodyMiB: z.number(), sourceKiB: z.number(),
    assetMiB: z.number(), repeatBudget: z.number(), repeatPerScreen: z.number(), screenshotQueue: z.number(),
  }),
  designSystems: z.array(z.string()),
  features: z.object({
    renderStatus: z.boolean(), screenshots: z.boolean(), visualRegression: z.boolean(), assets: z.boolean(),
    typedEvents: z.boolean(), repeat: z.boolean(), namedSlots: z.boolean(), themeVersions: z.boolean(),
  }),
});

export const capabilitiesContract = registerContract({
  method: "GET", path: "/api/capabilities",
  summary: "Machine-readable feature discovery: actions, directives, param sources, conditions, limits, design systems.",
  validated: true,
  responseSchema: capabilitiesResponseSchema,
  errors: [errorCatalog.methodNotAllowed],
});
