import { z } from "zod";
import { inputPrototypeDocSchema, REGION_KINDS } from "../src/prototype/schema";
import { atomicLevels, layoutSpacingProps, spaceTokens } from "../src/designSystems/types";
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

// --- Named users and cookie sessions (A1-1) ---

export const userPublicSchema = z.strictObject({ id: z.string(), name: z.string(), isAdmin: z.boolean(), createdAt: z.string() });
export const authUserSchema = z.strictObject({ userId: z.string(), name: z.string(), isAdmin: z.boolean() });
export const loginRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
  next: z.string().max(2048).optional(),
});
export const createUserRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(64),
  password: z.string().min(8).max(256),
  isAdmin: z.boolean().optional().default(false),
});

export const loginContract = registerContract({ method: "POST", path: "/api/auth/login", summary: "Create a named-user cookie session.", requestSchema: loginRequestSchema, responseSchema: z.strictObject({ user: authUserSchema, next: z.string().optional() }), validated: true, errors: [{ status: 401, code: "invalid_credentials" }, { status: 429, code: "rate_limited" }, { status: 422, code: "validation_failed" }] });
export const logoutContract = registerContract({ method: "POST", path: "/api/auth/logout", summary: "Revoke the current cookie session.", status: 204, validated: true, errors: [] });
export const meContract = registerContract({ method: "GET", path: "/api/auth/me", summary: "Return the current named user.", responseSchema: authUserSchema, validated: true, errors: [{ status: 401, code: "unauthorized" }] });
export const createUserContract = registerContract({ method: "POST", path: "/api/users", summary: "Create a user (admin only).", status: 201, requestSchema: createUserRequestSchema, responseSchema: userPublicSchema, validated: true, errors: [{ status: 401, code: "unauthorized" }, { status: 403, code: "forbidden" }, { status: 409, code: "already_exists" }, { status: 422, code: "validation_failed" }] });
export const listUsersContract = registerContract({ method: "GET", path: "/api/users", summary: "List users (admin only).", responseSchema: z.strictObject({ users: z.array(userPublicSchema) }), validated: true, errors: [{ status: 401, code: "unauthorized" }, { status: 403, code: "forbidden" }] });

// --- Contracts registered by this task (T1) ---

const positiveIntFromString = z.string().regex(/^[1-9][0-9]*$/, "must be a positive integer").transform(Number);

const jsonScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const layoutDirectionSchema = z.union([
  z.enum(["vertical", "horizontal"]),
  z.strictObject({
    prop: z.string(),
    vertical: z.array(jsonScalarSchema).min(1),
    horizontal: z.array(jsonScalarSchema).min(1),
    none: z.array(jsonScalarSchema).min(1).optional(),
  }),
]);
export const componentLayoutSchema = z.strictObject({
  version: z.literal(1),
  spacing: z.array(z.enum(layoutSpacingProps)).optional(),
  spacer: z.literal(true).optional(),
  flow: z.strictObject({
    kind: z.literal("flex"),
    direction: layoutDirectionSchema,
    wrap: z.strictObject({ prop: z.string(), enabled: z.array(jsonScalarSchema).min(1) }).optional(),
    slot: z.string().optional(),
  }).optional(),
});
export const spaceScaleSchema = z.object(Object.fromEntries(spaceTokens.map((token) => [token, z.string()])) as Record<(typeof spaceTokens)[number], z.ZodString>);
export const validationIssueSchema = z.object({
  path: z.union([z.string(), z.array(z.union([z.string(), z.number()]))]),
  pointer: z.string().optional(),
  message: z.string(),
  code: z.string().optional(),
});

const componentExamplesSchema = z.record(
  z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  z.record(z.string(), z.unknown()),
);

const componentCapabilitiesSchema = z.object({ typedEvents: z.literal(true).optional(), namedSlots: z.literal(true).optional() });
const serializedDefinitionFields = {
  atomicLevel: z.enum(atomicLevels).optional(),
  layoutNeutral: z.boolean().optional(),
  layout: componentLayoutSchema.optional(),
  description: z.string(),
  events: z.array(z.string()),
  eventPayloads: z.record(z.string(), z.unknown()).optional(),
  capabilities: componentCapabilitiesSchema.optional(),
  slots: z.array(z.string()),
  example: z.record(z.string(), z.unknown()).optional(),
  examples: componentExamplesSchema.optional(),
  propsJsonSchema: z.unknown().optional(),
};

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

const assetIdString = z.string().regex(/^asset_[0-9a-f]{64}$/);
const assetCursorString = z.string().max(128).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z~asset_[0-9a-f]{64}$/);
const assetListLimit = z.string().regex(/^[1-9][0-9]*$/).default("50").transform(Number).refine((value) => value <= 200);

export const listAssetsQuerySchema = z.strictObject({
  limit: assetListLimit,
  cursor: assetCursorString.optional(),
});

const strictAssetMetadataSchema = z.strictObject({
  id: assetIdString,
  sha256: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  originalName: z.string().nullable(),
  createdAt: z.string(),
  url: z.string(),
});

const assetUsageCountsSchema = z.strictObject({
  prototypes: z.number().int().nonnegative(),
  components: z.number().int().nonnegative(),
  visualReferences: z.number().int().nonnegative(),
  visualRuns: z.number().int().nonnegative(),
});

export const listAssetsContract = registerContract({
  method: "GET",
  path: "/api/assets",
  summary: "List assets in reverse creation order with hard-pin usage counts and keyset pagination.",
  query: listAssetsQuerySchema,
  validated: true,
  responseSchema: z.strictObject({
    assets: z.array(strictAssetMetadataSchema.extend({ usage: assetUsageCountsSchema })),
    nextCursor: z.string().nullable(),
  }),
  errors: [{ status: 400, code: "invalid_cursor" }, { status: 422, code: "validation_failed" }],
});

export const assetUsageContract = registerContract({
  method: "GET",
  path: "/api/assets/{id}/usage",
  summary: "List every hard pin retaining an asset, including tombstoned visual references and visual-run roles.",
  params: z.strictObject({ id: assetIdString }),
  validated: true,
  responseSchema: z.strictObject({
    asset: strictAssetMetadataSchema,
    prototypes: z.array(z.strictObject({
      id: z.string(), name: z.string(), revCount: z.number().int().positive(), lastRev: z.number().int().positive(), pinnedAtHead: z.boolean(),
    })),
    components: z.array(z.strictObject({ id: z.string(), name: z.string(), versions: z.array(z.number().int().positive()) })),
    visualReferences: z.array(z.strictObject({ id: z.string(), deleted: z.boolean() })),
    visualRuns: z.array(z.strictObject({ id: z.string(), referenceId: z.string(), role: z.enum(["reference", "candidate", "diff"]) })),
  }),
  errors: [{ status: 404, code: "asset_not_found" }, { status: 422, code: "validation_failed" }],
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
  requestSchema: z.object({ rev: z.number().int().optional(), version: z.number().int().optional(), viewport: viewportSchema, deviceScaleFactor: z.number().int().optional(), theme: z.string().optional(), waitForFonts: z.boolean().optional(), probe: z.literal("geometry").optional() }),
  responseSchema: jobAcceptedSchema,
  errors: [{ status: 400, code: "invalid_request" }, { status: 404, code: "prototype_not_found" }, { status: 404, code: "screen_not_found" }, { status: 404, code: "version_not_found" }, { status: 404, code: "revision_not_found" }, ...screenshotErrors],
});

export const componentScreenshotContract = registerContract({
  method: "POST",
  path: "/api/components/{id}/versions/{version}/screenshot",
  summary: "Enqueue a published-component screenshot job with optional props or a named example.",
  status: 202,
  requestSchema: z.object({ props: z.record(z.string(), z.unknown()).optional(), exampleName: z.string().optional(), viewport: viewportSchema, deviceScaleFactor: z.number().int().optional(), theme: z.string().optional(), waitForFonts: z.boolean().optional() })
    .refine((value) => !(value.props !== undefined && value.exampleName !== undefined), { message: "props and exampleName are mutually exclusive" }),
  responseSchema: jobAcceptedSchema,
  errors: [{ status: 400, code: "invalid_request" }, { status: 404, code: "not_found" }, { status: 422, code: "invalid_props" }, { status: 422, code: "unknown_example" }, ...screenshotErrors],
});

const screenshotImageResultSchema = z.object({
  kind: z.literal("image"),
  imageUrl: z.string(), assetId: z.string(), width: z.number(), height: z.number(),
  consoleErrors: z.array(z.string()), pageErrors: z.array(z.string()),
  bundleHash: z.string().optional(),
  componentPins: z.array(z.object({ id: z.string(), version: z.number(), bundleHash: z.string() })).optional(),
  rendererBuild: z.string().nullable(), browserVersion: z.string(),
});
const geometryLayoutContextSchema = z.object({
  display: z.string(), flexDirection: z.string(), flexWrap: z.string(), rowGap: z.string(), columnGap: z.string(),
});
const geometryRectSchema = z.object({
  key: z.string(), instance: z.number().int().nonnegative(),
  parentKey: z.string().optional(), parentInstance: z.number().int().nonnegative().optional(),
  domIndex: z.number().int().nonnegative(), x: z.number(), y: z.number(), width: z.number(), height: z.number(),
  hidden: z.literal(true).optional(), layoutContext: geometryLayoutContextSchema.nullable(),
});
const screenshotGeometryResultSchema = z.object({
  kind: z.literal("geometry"), resolvedRev: z.number().int().positive(), prototypeInstanceId: z.string(),
  componentPins: z.array(z.object({ id: z.string(), version: z.number().int().positive(), bundleHash: z.string() })),
  designSystemMetaVersion: z.number().int().positive().nullable(), resolvedSpaceScale: spaceScaleSchema,
  viewport: viewportSchema, dpr: z.number(), rects: z.array(geometryRectSchema), truncated: z.boolean(), total: z.number().int().nonnegative(),
});
export const screenshotJobResultSchema = z.discriminatedUnion("kind", [screenshotImageResultSchema, screenshotGeometryResultSchema]);

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
  z.object({ scope: z.literal("prototype-screen"), prototypeId: z.string(), prototypeInstanceId:z.string().optional(), screenId: z.string(), refRevision: z.number().int().positive(), viewport: viewportPositiveSchema, deviceScaleFactor: deviceScaleSchema, theme: z.enum(["light", "dark"]), propsHash: hashSchema.optional(), stateHash: hashSchema.optional() }),
  z.object({ scope: z.literal("component"), componentId: z.string(), refVersion: z.number().int().positive(), viewport: viewportPositiveSchema, deviceScaleFactor: deviceScaleSchema, theme: z.enum(["light", "dark"]), propsHash: hashSchema.optional(), stateHash: hashSchema.optional() }),
]);

const metricResultSchema = z.object({ diffPixels: z.number(), totalPixels: z.number(), diffPercent: z.number() });
const evidenceAssetSchema = z.object({ assetId: z.string(), url: z.string(), sha256: z.string(), width: z.number().nullable(), height: z.number().nullable(), mime: z.string() });
const captureBrowserSchema=z.strictObject({browserVersion:z.string(),rendererBuild:z.string().nullable(),consoleErrors:z.array(z.string()),pageErrors:z.array(z.string())});
const prototypeExpectedSchema=z.strictObject({kind:z.literal("prototype"),prototypeInstanceId:z.string(),rev:z.number(),componentManifestHash:z.string(),builtinCatalogHash:z.string(),dsMetaVersion:z.number().nullable(),rendererBuild:z.string().nullable()});
const componentExpectedSchema=z.strictObject({kind:z.literal("component"),componentId:z.string(),version:z.number(),bundleHash:z.string(),propsHash:z.string(),dsMetaVersion:z.number().nullable(),rendererBuild:z.string().nullable()});
const candidateMetaSchema=z.union([
  z.strictObject({kind:z.literal("prototype"),outcome:z.enum(["captured","capture_failed"]),requestedTarget:z.strictObject({rev:z.number()}),resolvedTarget:z.strictObject({rev:z.number()}),expected:prototypeExpectedSchema,browser:captureBrowserSchema.nullable(),error:z.string().optional(),rev:z.number(),pins:z.array(z.strictObject({id:z.string(),version:z.number(),bundleHash:z.string()})).optional(),rendererBuild:z.string().nullable().optional(),browserVersion:z.string().optional()}),
  z.strictObject({kind:z.literal("component"),outcome:z.enum(["captured","capture_failed"]),requestedTarget:z.strictObject({version:z.number()}),resolvedTarget:z.strictObject({version:z.number()}),expected:componentExpectedSchema,browser:captureBrowserSchema.nullable(),error:z.string().optional(),version:z.number(),bundleHash:z.string().optional(),rendererBuild:z.string().nullable().optional(),browserVersion:z.string().optional()}),
]);

export const runReportSchema = z.object({
  runId: z.string(), referenceId: z.string(),
  status: z.enum(["pass", "fail", "error", "reference_missing", "reference_unknown"]),
  createdAt: z.string(),
  metric: z.string().nullable(), metricOptions: z.record(z.string(), z.unknown()).nullable(),
  diffPixels: z.number().nullable(), totalPixels: z.number().nullable(), diffPercent: z.number().nullable(),
  metrics: z.object({ "exact-rgba": metricResultSchema.optional(), "pixelmatch-v1": metricResultSchema.optional() }),
  referenceStatus: z.enum(["known", "unknown"]),
  reference: evidenceAssetSchema.nullable(), candidate: evidenceAssetSchema.nullable(),
  diff: z.object({ assetId: z.string(), url: z.string() }).nullable(),
  candidateMeta: candidateMetaSchema.nullable(),
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
  errors: [{status:409,code:"baseline_managed"},{ status: 422, code: "asset_not_found" }, { status: 422, code: "invalid_reference_asset" }, { status: 422, code: "validation_failed" }],
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

export const deleteVisualReferenceContract = registerContract({
  method: "DELETE",
  path: "/api/visual-references/{id}",
  summary: "Tombstone an active visual reference while retaining its runs and evidence.",
  status: 204,
  errors: [{ status: 404, code: "reference_not_found" },{status:409,code:"baseline_managed"}],
});

export const checkVisualReferenceContract = registerContract({
  method: "POST",
  path: "/api/visual-references/{id}/check",
  summary: "Capture a candidate for the reference fingerprint and enqueue an honest diff run.",
  status: 202,
  requestSchema: z.strictObject({ threshold: z.number().min(0).max(100).optional(),rev:z.number().int().positive().optional(),version:z.number().int().positive().optional() }),
  responseSchema: z.object({ runId: z.string(), jobId: z.string().optional() }),
  errors: [
    { status: 404, code: "reference_not_found" },{status:404,code:"prototype_not_found"},{status:404,code:"screen_not_found"},{status:404,code:"revision_not_found"},{status:404,code:"version_not_found"},
    {status:409,code:"instance_conflict"},{status:422,code:"invalid_candidate_target"},{ status: 422, code: "invalid_threshold" },{status:422,code:"invalid_viewport"},{status:429,code:"queue_full"},{ status: 501, code: "screenshot_unavailable" },
  ],
});

const baselineViewportSchema=z.strictObject({width:z.number().int(),height:z.number().int()});
const baselineMemberSchema=z.strictObject({screenId:z.string(),viewport:baselineViewportSchema,deviceScaleFactor:deviceScaleSchema,theme:z.enum(["light","dark"]),referenceId:z.string()});
const baselineResponseCore=z.strictObject({generation:z.number().int().positive(),rev:z.number().int().positive(),members:z.array(baselineMemberSchema)});
export const putVisualBaselineContract=registerContract({
  method:"PUT",path:"/api/visual-baselines/prototypes/{id}",summary:"Atomically replace the complete committed visual baseline set for a prototype (generation CAS).",
  requestSchema:z.strictObject({rev:z.number().int().positive(),prototypeInstanceId:z.string(),baseGeneration:z.number().int().positive().nullable(),members:z.array(z.strictObject({screenId:z.string(),viewport:baselineViewportSchema,deviceScaleFactor:deviceScaleSchema,theme:z.enum(["light","dark"]),assetId:z.string()}))}),
  responseSchema:baselineResponseCore,validated:true,
  errors:[{status:404,code:"prototype_not_found"},{status:404,code:"revision_not_found"},{status:409,code:"instance_conflict"},{status:409,code:"generation_conflict"},{status:422,code:"incomplete_baseline"},{status:422,code:"invalid_viewport"},{status:422,code:"asset_not_found"},{status:422,code:"invalid_reference_asset"},{status:422,code:"validation_failed"}],
});
export const getVisualBaselineContract=registerContract({
  method:"GET",path:"/api/visual-baselines/prototypes/{id}",summary:"Read the latest committed visual baseline set for a prototype.",
  responseSchema:baselineResponseCore.extend({prototypeInstanceId:z.string(),createdAt:z.string()}),
  errors:[{status:404,code:"prototype_not_found"},{status:404,code:"baseline_not_found"}],
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
    { status: 409, code: "design_system_retired" },
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
const issueSchema = validationIssueSchema.loose();
const screenUrlSchema = z.object({ id: z.string(), url: z.string() });
const casBody = { baseRev: positiveInt, message: z.string().optional() };

// --- Prototypes CRUD / revisions / versions / publish / restore ---

const prototypeListItemSchema = z.looseObject({
  id: z.string(), name: z.string(), designSystem: z.string(), device: z.string(),
  screenCount: z.number(), headRev: z.number(), latestVersion: z.number().nullable(), updatedAt: isoDate,
  status:z.enum(["private","published","archived"]),owner:z.strictObject({id:z.string(),name:z.string()}),
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
  requestSchema: z.object({ doc: inputPrototypeDocSchema, message: z.string().optional(), figma: figmaSchema.optional() }),
  responseSchema: z.looseObject({ id: z.string(), rev: z.literal(1), warnings: z.array(issueSchema), screens: z.array(screenUrlSchema) }),
  errors: [errorCatalog.invalidRequest, errorCatalog.alreadyExists, errorCatalog.validationFailed, { status: 422, code: "asset_not_found" }],
});

const renderableSchema = z.object({ head: z.boolean(), published: z.boolean().nullable() });
const prototypeRenderErrorSchema=z.object({code:z.literal("prototype_not_renderable"),message:z.string(),issues:z.array(z.object({path:z.string(),message:z.string()}))});

export const getPrototypeContract = registerContract({
  method: "GET", path: "/api/prototypes/{id}",
  summary: "Prototype lifecycle meta: head/draft revision, validated revision, published versions, renderable.",
  responseSchema: z.looseObject({
    id: z.string(), prototypeInstanceId:z.string(), name: z.string(), designSystem: z.string(), headRev: z.number(),
    latestVersion: z.number().nullable(), versions: z.array(z.looseObject({ version: z.number(), rev: z.number(), publishedAt: isoDate })),
    updatedAt: isoDate, draftRevision: z.number(), validatedRevision: z.number().nullable(),
    publishedVersion: z.number().nullable(), renderable: renderableSchema,
    renderErrors:z.object({head:prototypeRenderErrorSchema.nullable(),published:prototypeRenderErrorSchema.nullable()}), figma: figmaResponseSchema.optional(),
    status:z.enum(["private","published","archived"]),owner:z.strictObject({id:z.string(),name:z.string()}),
  }),
  errors: [errorCatalog.prototypeNotFound],
});

export const savePrototypeContract = registerContract({
  method: "PUT", path: "/api/prototypes/{id}",
  summary: "Save a new head revision (CAS on baseRev); document id must match the path id.",
  requestSchema: z.object({ doc: inputPrototypeDocSchema, figma: figmaSchema.optional(), ...casBody }),
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
  prototypeInstanceId:z.string(),
  components: z.array(z.looseObject({ id: z.string(), version: z.number() })),
  assets: z.array(assetPublicSchema.omit({ width: true, height: true })),
  designSystemMetaVersion: z.number().nullable(),
  figma: figmaResponseSchema.optional(),
  renderable:z.boolean(),renderError:prototypeRenderErrorSchema.nullable(),
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

const diffJsonSchema = z.json();
const boundedDiffString = z.string().max(160);
const diffValueSchema = z.union([
  z.strictObject({ value: diffJsonSchema }),
  z.strictObject({ truncated: z.strictObject({ preview: z.string().max(120), chars: z.number().int().positive() }) }),
  z.strictObject({ missing: z.literal(true) }),
]);
const omittedSchema = z.strictObject({ omitted: z.literal(true) });
const diffFieldSchema = z.strictObject({ key: boundedDiffString, from: diffValueSchema, to: diffValueSchema });
const docDiffFieldSchema = diffFieldSchema.extend({ key: z.enum(["name", "description", "device", "designSystem", "startScreen"]) });
const screenMetaDiffFieldSchema = diffFieldSchema.extend({ key: z.enum(["name", "note", "canvas", "root"]) });
const renderInputDiffFieldSchema = diffFieldSchema.extend({ key: z.enum(["builtinCatalogHash", "componentManifestHash", "designSystemMetaVersion"]) });
const diffMapSchema = z.strictObject({
  added: z.array(z.strictObject({ key: boundedDiffString, value: diffValueSchema })).optional(),
  removed: z.array(boundedDiffString).optional(),
  changed: z.array(diffFieldSchema).optional(),
});
const namedSetDiffSchema = z.strictObject({
  added: z.array(boundedDiffString).optional(),
  removed: z.array(boundedDiffString).optional(),
  changed: z.array(boundedDiffString).optional(),
});
const elementValueDiffSchema = z.strictObject({ from: diffValueSchema, to: diffValueSchema });
const elementChangedSchema = z.strictObject({
  id: boundedDiffString,
  type: z.strictObject({ from: boundedDiffString, to: boundedDiffString }).optional(),
  props: z.union([diffMapSchema, omittedSchema]).optional(),
  children: elementValueDiffSchema.optional(),
  on: namedSetDiffSchema.optional(),
  visible: elementValueDiffSchema.optional(),
  repeat: elementValueDiffSchema.optional(),
  slot: elementValueDiffSchema.optional(),
  region: elementValueDiffSchema.optional(),
});
const elementsDiffSchema = z.union([
  z.strictObject({
    added: z.array(z.strictObject({ id: boundedDiffString, type: boundedDiffString })).optional(),
    removed: z.array(z.strictObject({ id: boundedDiffString, type: boundedDiffString })).optional(),
    changed: z.array(elementChangedSchema).optional(),
  }),
  omittedSchema,
]);
const screensDiffSchema = z.union([
  z.strictObject({
    added: z.array(z.strictObject({ id: boundedDiffString, name: boundedDiffString, elementCount: z.number().int().nonnegative() })).optional(),
    removed: z.array(z.strictObject({ id: boundedDiffString, name: boundedDiffString })).optional(),
    changed: z.array(z.strictObject({
      id: boundedDiffString,
      meta: z.array(screenMetaDiffFieldSchema).optional(),
      stateOverrides: diffMapSchema.optional(),
      elements: elementsDiffSchema.optional(),
    })).optional(),
  }),
  omittedSchema,
]);
const pinsDiffSchema = z.strictObject({
  components: z.strictObject({
    added: z.array(z.strictObject({ id: boundedDiffString, version: z.number().int().positive() })).optional(),
    removed: z.array(z.strictObject({ id: boundedDiffString, version: z.number().int().positive() })).optional(),
    changed: z.array(z.strictObject({ id: boundedDiffString, from: z.number().int().positive(), to: z.number().int().positive() })).optional(),
  }).optional(),
  assets: z.strictObject({ added: z.array(boundedDiffString).optional(), removed: z.array(boundedDiffString).optional() }).optional(),
});

export const prototypeRevisionDiffQuerySchema = z.strictObject({ against: positiveIntFromString.optional() });

export const prototypeRevisionDiffContract = registerContract({
  method: "GET",
  path: "/api/prototypes/{id}/revisions/{rev}/diff",
  summary: "Compare two immutable prototype revisions, including document, pin and render-input changes.",
  query: prototypeRevisionDiffQuerySchema,
  responseSchema: z.strictObject({
    prototypeId: boundedDiffString,
    from: z.strictObject({ rev: z.number().int().positive(), message: diffValueSchema, createdAt: z.string() }),
    to: z.strictObject({ rev: z.number().int().positive(), message: diffValueSchema, createdAt: z.string() }),
    doc: z.union([z.array(docDiffFieldSchema), omittedSchema]).optional(),
    state: z.union([diffMapSchema, omittedSchema]).optional(),
    screens: screensDiffSchema.optional(),
    flows: z.union([elementValueDiffSchema, omittedSchema]).optional(),
    screenOrder: z.union([z.strictObject({ from: z.array(boundedDiffString).max(100), to: z.array(boundedDiffString).max(100) }), omittedSchema]).optional(),
    pins: z.union([pinsDiffSchema, omittedSchema]).optional(),
    renderInputs: z.union([z.array(renderInputDiffFieldSchema), omittedSchema]).optional(),
    summary: z.strictObject({
      screensAdded: z.number().int().nonnegative(), screensRemoved: z.number().int().nonnegative(), screensChanged: z.number().int().nonnegative(),
      staticElementsAdded: z.number().int().nonnegative(), staticElementsRemoved: z.number().int().nonnegative(), staticElementsChanged: z.number().int().nonnegative(),
      identical: z.boolean(), docIdentical: z.boolean(), truncated: z.boolean(),
      omittedSections: z.array(z.enum(["props", "elements", "screens", "flows", "state", "doc", "pins", "renderInputs", "screenOrder"])),
    }),
  }),
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

export const setPrototypeStatusContract = registerContract({
  method:"POST",path:"/api/prototypes/{id}/status",summary:"Change prototype visibility using the server-enforced lifecycle graph.",
  requestSchema:z.strictObject({status:z.enum(["private","published","archived"])}),responseSchema:z.strictObject({status:z.enum(["private","published","archived"])}),
  errors:[{status:403,code:"forbidden"},{status:404,code:"prototype_not_found"},{status:409,code:"prototype_not_renderable"},{status:422,code:"invalid_transition"}],
});

export const listPrototypeVersionsContract = registerContract({
  method: "GET", path: "/api/prototypes/{id}/versions",
  summary: "List published versions.",
  responseSchema: z.array(z.looseObject({ version: z.number(), rev: z.number(), publishedAt: isoDate, renderable:z.boolean(), renderError:prototypeRenderErrorSchema.nullable() })),
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
    ...serializedDefinitionFields,
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

// --- Bundle export (ZIP) ---

const exportUnauthorized = { status: 401, code: "unauthorized" } as const;
const exportForbidden = { status: 403, code: "forbidden" } as const;
const exportTooLarge = { status: 413, code: "export_too_large" } as const;

export const exportPrototypeContract = registerContract({
  method: "GET", path: "/api/prototypes/{id}/export",
  summary: "Export a prototype revision (owner draft or a published version) with its full dependency closure as a ZIP bundle.",
  contentType: "application/zip",
  errors: [exportUnauthorized, exportForbidden, errorCatalog.prototypeNotFound, errorCatalog.versionNotFound, exportTooLarge],
});

export const exportComponentContract = registerContract({
  method: "GET", path: "/api/components/{id}/export",
  summary: "Export a custom component (latest active version, or head draft when unpublished) as a ZIP bundle.",
  contentType: "application/zip",
  errors: [exportUnauthorized, exportForbidden, errorCatalog.notFound, exportTooLarge],
});

export const exportBundlesContract = registerContract({
  method: "GET", path: "/api/bundles/export",
  summary: "Export every prototype and component owned by the caller as a single ZIP bundle.",
  contentType: "application/zip",
  errors: [exportUnauthorized, exportForbidden, exportTooLarge],
});

// --- Design systems ---

const designSystemSummarySchema = z.looseObject({
  id: z.string(), name: z.string(), description: z.string(), builtinCatalogHash: z.string(),
  resolvedSpaceScale: spaceScaleSchema,
  components: z.array(z.looseObject({ name: z.string(), ...serializedDefinitionFields })),
  hostPrimitives: z.array(z.looseObject({ name: z.string(), ...serializedDefinitionFields })),
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

export const catalogManifestQuerySchema = z.strictObject({ designSystem: slugString.optional() });

export const catalogManifestContract = registerContract({
  method: "GET", path: "/api/catalog/manifest",
  summary: "Manifest of the latest active custom-component versions across design systems.",
  query: catalogManifestQuerySchema,
  validated: true,
  responseSchema: z.object({ components: z.array(z.looseObject({
    id: z.string(), name: z.string(), designSystem: z.string(), version: z.number(), bundleUrl: z.string(),
    bundleHash: z.string(), hostAbiVersion: z.number(), ...serializedDefinitionFields,
  })) }),
  errors: [errorCatalog.notFound, errorCatalog.methodNotAllowed, errorCatalog.validationFailed],
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
  layoutContractVersion: z.literal(1),
  actions: z.array(z.string()),
  directives: z.array(z.string()),
  paramSources: z.array(z.string()),
  conditions: z.array(z.string()),
  limits: z.object({
    elements: z.number(), depth: z.number(), bodyMiB: z.number(), sourceKiB: z.number(),
    assetMiB: z.number(), repeatBudget: z.number(), repeatPerScreen: z.number(), screenshotQueue: z.number(), geometryRects: z.number(),
    flows: z.number(), flowSteps: z.number(), flowTotalSteps: z.number(),
  }),
  designSystems: z.array(z.string()),
  resolvedSpaceScales: z.record(z.string(), spaceScaleSchema),
  regions: z.array(z.enum(REGION_KINDS)),
  features: z.object({
    renderStatus: z.boolean(), screenshots: z.boolean(), visualRegression: z.boolean(), assets: z.boolean(),
    typedEvents: z.boolean(), repeat: z.boolean(), namedSlots: z.boolean(), themeVersions: z.boolean(), layoutContract: z.boolean(),
    flows: z.boolean(), screenRegions: z.boolean(), bundleExport: z.boolean(),
  }),
});

export const capabilitiesContract = registerContract({
  method: "GET", path: "/api/capabilities",
  summary: "Machine-readable feature discovery: actions, directives, param sources, conditions, limits, design systems.",
  validated: true,
  responseSchema: capabilitiesResponseSchema,
  errors: [errorCatalog.methodNotAllowed],
});
