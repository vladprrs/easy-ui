import { z } from "zod";
import { inputPrototypeDocSchema, REGION_KINDS } from "../src/prototype/schema";
import { compositionDocSchema } from "../src/prototype/composition";
import { COMPONENT_SCOPES } from "../src/designSystems/scope";
import { PROTOTYPE_KINDS, READINESS_GATE_IDS } from "../src/api/client";
import { atomicLevels, layoutSpacingProps, spaceTokens } from "../src/designSystems/types";
import { importReportSchema } from "../src/bundle/schema";
import { scenarioInputSchema, scenarioStepsSchema } from "../src/prototype/scenario";
import { ApiError } from "./http";
import { figmaSchema } from "./figma";
import { tokenize } from "../src/library/text";
import { reuseOverrideSchema as componentReuseOverrideSchema } from "./catalog/reuseOverride";

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
  /** Optional status-specific error bodies for OpenAPI; unspecified statuses use ErrorEnvelope. */
  errorResponseSchemas?: Readonly<Partial<Record<number, z.ZodType>>>;
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
export const updateUserRequestSchema = z.strictObject({
  isAdmin: z.boolean(),
});

export const loginContract = registerContract({ method: "POST", path: "/api/auth/login", summary: "Create a named-user cookie session.", requestSchema: loginRequestSchema, responseSchema: z.strictObject({ user: authUserSchema, next: z.string().optional() }), validated: true, errors: [{ status: 401, code: "invalid_credentials" }, { status: 429, code: "rate_limited" }, { status: 422, code: "validation_failed" }] });
export const logoutContract = registerContract({ method: "POST", path: "/api/auth/logout", summary: "Revoke the current cookie session.", status: 204, validated: true, errors: [] });
export const meContract = registerContract({ method: "GET", path: "/api/auth/me", summary: "Return the current named user.", responseSchema: authUserSchema, validated: true, errors: [{ status: 401, code: "unauthorized" }] });
export const createUserContract = registerContract({ method: "POST", path: "/api/users", summary: "Create a user (admin only).", status: 201, requestSchema: createUserRequestSchema, responseSchema: userPublicSchema, validated: true, errors: [{ status: 401, code: "unauthorized" }, { status: 403, code: "forbidden" }, { status: 409, code: "already_exists" }, { status: 422, code: "validation_failed" }] });
export const updateUserContract = registerContract({ method: "PATCH", path: "/api/users/{id}", summary: "Update a user's admin flag (admin only).", requestSchema: updateUserRequestSchema, responseSchema: userPublicSchema, validated: true, errors: [{ status: 401, code: "unauthorized" }, { status: 403, code: "forbidden" }, { status: 404, code: "user_not_found" }, { status: 409, code: "bootstrap_admin_protected" }, { status: 422, code: "validation_failed" }] });
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
  // Architecture metadata (волна 2 §2.1) — additive, все поля опциональны.
  scope: z.enum(COMPONENT_SCOPES).optional(),
  allowedAsRoot: z.boolean().optional(),
  canonicalFor: z.array(z.string()).optional(),
  sourceBounded: z.boolean().optional(),
  ownership: z.object({ reason: z.string(), provenance: z.string().optional() }).optional(),
  replacement: z.string().optional(),
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
  // P2.3: постановка отдаёт разрешённые пины — для track:head-дока это единственный момент,
  // когда клиент узнаёт, какие версии компонентов реально пойдут в кадр.
  responseSchema: jobAcceptedSchema.extend({ components: z.array(z.object({ id: z.string(), name: z.string(), version: z.number().int().positive(), bundleHash: z.string() })) }),
  errors: [{ status: 400, code: "invalid_request" }, { status: 404, code: "prototype_not_found" }, { status: 404, code: "screen_not_found" }, { status: 404, code: "version_not_found" }, { status: 404, code: "revision_not_found" }, ...screenshotErrors],
});

// P1b (план 2026-08-02): тело компонентной съёмки едино для published и draft вариантов;
// probe=geometry переводит джобу в geometry-результат компонентной поверхности.
const componentScreenshotRequestSchema = z.object({ props: z.record(z.string(), z.unknown()).optional(), exampleName: z.string().optional(), viewport: viewportSchema, deviceScaleFactor: z.number().int().optional(), theme: z.string().optional(), waitForFonts: z.boolean().optional(), probe: z.literal("geometry").optional() })
  .refine((value) => !(value.props !== undefined && value.exampleName !== undefined), { message: "props and exampleName are mutually exclusive" });

export const componentScreenshotContract = registerContract({
  method: "POST",
  path: "/api/components/{id}/versions/{version}/screenshot",
  summary: "Enqueue a published-component screenshot job with optional props or a named example; probe=geometry returns a component-surface geometry result.",
  status: 202,
  requestSchema: componentScreenshotRequestSchema,
  responseSchema: jobAcceptedSchema,
  errors: [{ status: 400, code: "invalid_request" }, { status: 404, code: "not_found" }, { status: 422, code: "invalid_props" }, { status: 422, code: "unknown_example" }, ...screenshotErrors],
});

// P1b: draft-вариант — съёмка сохранённой, но не опубликованной head-ревизии через эфемерный
// candidate-bundle префлайта P8 (при холодном кэше собирается под его же троттлингом).
export const componentHeadScreenshotContract = registerContract({
  method: "POST",
  path: "/api/components/{id}/head/screenshot",
  summary: "Enqueue a draft (saved, unpublished head revision) component screenshot job rendered from the ephemeral validate candidate bundle.",
  status: 202,
  requestSchema: componentScreenshotRequestSchema,
  responseSchema: jobAcceptedSchema,
  errors: [
    { status: 400, code: "invalid_request" }, { status: 404, code: "not_found" },
    { status: 422, code: "invalid_props" }, { status: 422, code: "unknown_example" },
    { status: 422, code: "validation_failed", description: "the draft failed the validate preflight checks" },
    { status: 422, code: "asset_not_found", description: "the draft source references an unknown asset" },
    { status: 429, code: "validate_in_flight", description: "a candidate build is already in flight for this user" },
    ...screenshotErrors,
  ],
});

const screenshotImageResultSchema = z.object({
  kind: z.literal("image"),
  imageUrl: z.string(), assetId: z.string(), width: z.number(), height: z.number(),
  consoleErrors: z.array(z.string()), pageErrors: z.array(z.string()),
  bundleHash: z.string().optional(),
  // Draft-цель (P1b): отрендеренная head-ревизия — клиент печатает «draft rev N».
  draftRev: z.number().int().positive().optional(),
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
// Geometry-результат дискриминирован по поверхности (P1b добавил компонентную к прототипной).
const geometryMeasurementFields = {
  viewport: viewportSchema, dpr: z.number(), rects: z.array(geometryRectSchema), truncated: z.boolean(), total: z.number().int().nonnegative(),
};
const screenshotPrototypeGeometryResultSchema = z.object({
  kind: z.literal("geometry"), surface: z.literal("prototype"),
  resolvedRev: z.number().int().positive(), prototypeInstanceId: z.string(),
  componentPins: z.array(z.object({ id: z.string(), version: z.number().int().positive(), bundleHash: z.string() })),
  designSystemMetaVersion: z.number().int().positive().nullable(), resolvedSpaceScale: spaceScaleSchema,
  ...geometryMeasurementFields,
});
const screenshotComponentGeometryResultSchema = z.object({
  kind: z.literal("geometry"), surface: z.literal("component"),
  componentId: z.string(),
  // Ровно одна из двух форм цели: опубликованная версия или draft head-ревизия (P1b).
  version: z.number().int().positive().optional(),
  draftRev: z.number().int().positive().optional(),
  bundleHash: z.string(),
  designSystemMetaVersion: z.number().int().positive().nullable(), resolvedSpaceScale: spaceScaleSchema,
  ...geometryMeasurementFields,
});
const screenshotGeometryResultSchema = z.discriminatedUnion("surface", [screenshotPrototypeGeometryResultSchema, screenshotComponentGeometryResultSchema]);
export const screenshotJobResultSchema = z.union([screenshotImageResultSchema, screenshotGeometryResultSchema]);

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

/** 422-набор head-tracking'а: publish/share/visual-baseline/bundle-export трекающего дока. */
const headTrackingError = { status: 422, code: "prototype_head_tracking", description: "The prototype tracks component heads (track: head); the operation requires an immutable pin snapshot." } as const;
/** Kill-switch D16 (план 2026-08-02 multi-surface-flows): запись `doc.surfaces` требует EASYUI_SURFACES=1. */
const surfacesDisabledError = { status: 422, code: "surfaces_disabled", description: "The document declares doc.surfaces, but multi-surface writes are disabled on this server (EASYUI_SURFACES=1 enables them). Discovery: capabilities.features.surfacesWrite." } as const;
/** W3 (multi-surface §4): композиции допустимы только на экранах ДС документа; per-screen резолв — v2. */
const compositionForeignDesignSystemError = { status: 422, code: "composition_foreign_design_system", description: "A composition is placed on a screen whose surface uses a design system other than doc.designSystem; compositions are single-design-system in v1." } as const;
/** W3 (multi-surface §4): формат бандла скалярен по ДС, мульти-поверхностный документ не экспортируется. */
const surfacesNotExportableError = { status: 422, code: "surfaces_not_exportable", description: "The prototype declares doc.surfaces; the v1 bundle manifest cannot carry multi-surface documents (multi-design-system manifest is v2)." } as const;

const baselineViewportSchema=z.strictObject({width:z.number().int(),height:z.number().int()});
const baselineMemberSchema=z.strictObject({screenId:z.string(),viewport:baselineViewportSchema,deviceScaleFactor:deviceScaleSchema,theme:z.enum(["light","dark"]),referenceId:z.string()});
const baselineResponseCore=z.strictObject({generation:z.number().int().positive(),rev:z.number().int().positive(),members:z.array(baselineMemberSchema)});
export const putVisualBaselineContract=registerContract({
  method:"PUT",path:"/api/visual-baselines/prototypes/{id}",summary:"Atomically replace the complete committed visual baseline set for a prototype (generation CAS).",
  requestSchema:z.strictObject({rev:z.number().int().positive(),prototypeInstanceId:z.string(),baseGeneration:z.number().int().positive().nullable(),members:z.array(z.strictObject({screenId:z.string(),viewport:baselineViewportSchema,deviceScaleFactor:deviceScaleSchema,theme:z.enum(["light","dark"]),assetId:z.string()}))}),
  responseSchema:baselineResponseCore,validated:true,
  errors:[{status:404,code:"prototype_not_found"},{status:404,code:"revision_not_found"},{status:409,code:"instance_conflict"},{status:409,code:"generation_conflict"},{status:422,code:"incomplete_baseline"},{status:422,code:"invalid_viewport"},{status:422,code:"asset_not_found"},{status:422,code:"invalid_reference_asset"},{status:422,code:"validation_failed"},headTrackingError],
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

/**
 * Версия алгоритма резолва spacing-шкалы, записанная в строке версии темы (миграция v23,
 * план 2026-08-02 P6.3): `1` — legacy (оверрайды и фолбэк на канонической шкале), `2` — фикшеный
 * мердж на базовую шкалу DS. Существующие версии остаются на `1` байт-в-байт.
 */
const spacingResolverSchema = z.union([z.literal(1), z.literal(2)]);
const themeDiffSchema = z.object({
  tokens: z.object({
    added: themeTokensSchema,
    changed: z.record(z.string(), z.object({ from: tokenValueContractSchema, to: tokenValueContractSchema })),
    removed: z.array(z.string()),
  }),
  fonts: z.object({ added: z.array(themeFontSchema), removed: z.array(themeFontSchema) }),
  icons: z.object({ added: z.array(themeIconSchema), removed: z.array(themeIconSchema) }),
  changed: z.boolean(),
});

export const patchDesignSystemThemeContract = registerContract({
  method: "PATCH",
  path: "/api/design-systems/{id}",
  summary:
    "Append an immutable theme version (tokens/fonts/icons) to a custom design system (CAS on baseVersion). " +
    "`tokens`/`fonts`/`icons` replace a collection; `addTokens`/`addFonts`/`addIcons` are append-only operations resolved against baseVersion " +
    "(existing entry with a different value → 409 theme_append_conflict; deletion is impossible — use the full PATCH) and are mutually exclusive with their full counterparts. " +
    "`dryRun: true` validates and returns the diff plus the resulting resolvedSpaceScale without writing a version. " +
    "A patch whose result equals baseVersion creates no version (`noop: true`, `nextVersion: null`). " +
    "New versions are written with spacingResolver 2 (spacing overrides merge onto the design system's own base scale, and a full token patch that drops `space.*` inherits the base version's scale — reported in `inheritedSpaceTokens`); " +
    "EASYUI_THEME_RESOLVER_V2_DISABLED=1 keeps writing resolver 1. `stalePins` lists prototypes whose head revision pins an older theme version.",
  requestSchema: z.object({
    tokens: themeTokensSchema.optional(), fonts: z.array(themeFontSchema).optional(), icons: z.array(themeIconSchema).optional(),
    addTokens: themeTokensSchema.optional(), addFonts: z.array(themeFontSchema).optional(), addIcons: z.array(themeIconSchema).optional(),
    dryRun: z.boolean().optional(),
    baseVersion: z.number().int().min(0),
  }),
  responseSchema: z.object({
    id: z.string(), latestMetaVersion: z.number().nullable(),
    resolvedSpaceScale: spaceScaleSchema,
    dryRun: z.boolean(), noop: z.boolean(), nextVersion: z.number().nullable(),
    spacingResolver: spacingResolverSchema,
    diff: themeDiffSchema,
    inheritedSpaceTokens: z.array(z.string()),
    stalePins: z.object({
      total: z.number(), limit: z.number(),
      prototypes: z.array(z.object({ id: z.string(), name: z.string(), pinnedVersion: z.number().nullable() })),
    }),
  }).and(themeContentSchema),
  errors: [
    { status: 404, code: "not_found" },
    { status: 405, code: "method_not_allowed", description: "builtin themes are immutable" },
    { status: 409, code: "version_conflict" },
    { status: 409, code: "theme_append_conflict", description: "append-only operation hit an existing entry with a different value" },
    { status: 409, code: "design_system_retired" },
    { status: 422, code: "validation_failed" },
  ],
});

export const getDesignSystemVersionContract = registerContract({
  method: "GET",
  path: "/api/design-systems/{id}/versions/{version}",
  summary: "Read an immutable design-system theme version, including the spacing resolver it was written with and the scale it resolves to.",
  responseSchema: z.object({
    systemId: z.string(), version: z.number(), createdAt: z.string(),
    spacingResolver: spacingResolverSchema, resolvedSpaceScale: spaceScaleSchema,
  }).and(themeContentSchema),
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

/** Versioned with the public create/discovery contract: generic labels alone are not intent. */
export const REUSE_INTENT_STOP_SET: readonly string[] = ["component", "компонент", "element", "элемент", "ui"];
/** 8..500 characters after trim, with at least one product-specific token. */
export const reuseIntentSchema = z.string().trim().min(8).max(500)
  .refine((value) => tokenize(value).some((token) => !REUSE_INTENT_STOP_SET.includes(token)),
    `intent must contain at least one token outside the generic stop set: ${REUSE_INTENT_STOP_SET.join(", ")}`);

// --- Prototype lifecycle metadata (миграция v16) ---
// Таксономия `kind` живёт в одном месте (src/api/client.ts) и здесь превращается в zod-enum:
// столбец `prototypes.kind` намеренно без CHECK, поэтому именно контракт — точка контроля.
export const prototypeKindSchema = z.enum(PROTOTYPE_KINDS);
export const prototypeTagSchema = slugString.max(32);
export const PROTOTYPE_TAGS_LIMIT = 16;
/**
 * `track` — head-tracking служебных прототипов (миграция v22, план 2026-08-02 P2):
 * `head` резолвит компонентные пины на последние active-публикации прямо на read-пути.
 * Ставится только lifecycle-роутом и только на служебный `kind` непубликованного дока;
 * поэтому в теле создания прототипа его нет (см. `createPrototypeContract`).
 */
export const prototypeTrackSchema = z.enum(["pinned", "head"]);
export const prototypeLifecycleSchema = z.strictObject({
  kind: prototypeKindSchema.optional(),
  tags: z.array(prototypeTagSchema).max(PROTOTYPE_TAGS_LIMIT).optional(),
  derivedFrom: z.string().min(1).max(128).nullable().optional(),
  track: prototypeTrackSchema.optional(),
});
const prototypeLifecycleResponseSchema = z.strictObject({
  kind: prototypeKindSchema, tags: z.array(z.string()), derivedFrom: z.string().nullable(), track: prototypeTrackSchema,
});

// --- Prototypes CRUD / revisions / versions / publish / restore ---

const prototypeListItemSchema = z.looseObject({
  id: z.string(), name: z.string(), designSystem: z.string(), device: z.string(),
  screenCount: z.number(), flowCount: z.number(), headRev: z.number(), latestVersion: z.number().nullable(), updatedAt: isoDate,
  status:z.enum(["private","published","archived"]),owner:z.strictObject({id:z.string(),name:z.string()}),
  kind: prototypeKindSchema, tags: z.array(z.string()), derivedFrom: z.string().nullable(), track: prototypeTrackSchema,
});

export const listPrototypesContract = registerContract({
  method: "GET", path: "/api/prototypes",
  summary: "List prototypes with head revision and latest published version; optional CSV lifecycle-kind filter.",
  query: z.object({ kind: z.string().optional() }),
  responseSchema: z.array(prototypeListItemSchema),
  errors: [errorCatalog.validationFailed, errorCatalog.methodNotAllowed],
});

export const createPrototypeContract = registerContract({
  method: "POST", path: "/api/prototypes",
  summary: "Create a prototype from a document (revision 1); validates against the design-system catalog.",
  status: 201,
  requestSchema: z.object({ doc: inputPrototypeDocSchema, message: z.string().optional(), figma: figmaSchema.optional(), ...prototypeLifecycleSchema.omit({ track: true }).shape }),
  responseSchema: z.looseObject({ id: z.string(), rev: z.literal(1), warnings: z.array(issueSchema), screens: z.array(screenUrlSchema) }),
  errors: [errorCatalog.invalidRequest, errorCatalog.alreadyExists, errorCatalog.validationFailed, { status: 422, code: "asset_not_found" }, surfacesDisabledError, compositionForeignDesignSystemError],
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
    kind: prototypeKindSchema, tags: z.array(z.string()), derivedFrom: z.string().nullable(), track: prototypeTrackSchema,
  }),
  errors: [errorCatalog.prototypeNotFound],
});

export const setPrototypeLifecycleContract = registerContract({
  method: "POST", path: "/api/prototypes/{id}/lifecycle",
  summary: "Patch prototype lifecycle metadata (kind/tags/derivedFrom/track); owner or admin only. track:head requires a service kind on an unpublished prototype.",
  validated: true,
  requestSchema: prototypeLifecycleSchema,
  responseSchema: prototypeLifecycleResponseSchema,
  errors: [errorCatalog.invalidRequest, { status: 403, code: "forbidden" }, errorCatalog.prototypeNotFound, errorCatalog.validationFailed,
    { status: 422, code: "track_requires_service_kind", description: "track:head is only allowed for service prototype kinds." },
    { status: 422, code: "track_requires_unpublished", description: "track:head is not allowed on a prototype with published versions." },
    { status: 422, code: "service_kind_requires_unpublished", description: "A published prototype cannot be switched to a service kind." }],
});

export const savePrototypeContract = registerContract({
  method: "PUT", path: "/api/prototypes/{id}",
  summary: "Save a new head revision (CAS on baseRev); document id must match the path id.",
  requestSchema: z.object({ doc: inputPrototypeDocSchema, figma: figmaSchema.optional(), ...casBody }),
  responseSchema: z.looseObject({ rev: z.number(), warnings: z.array(issueSchema), screens: z.array(screenUrlSchema) }),
  errors: [errorCatalog.invalidRequest, errorCatalog.baseRevRequired, errorCatalog.prototypeNotFound, errorCatalog.revConflict, errorCatalog.validationFailed, surfacesDisabledError, compositionForeignDesignSystemError],
});

export const deletePrototypeContract = registerContract({
  method: "DELETE", path: "/api/prototypes/{id}",
  summary: "Delete a prototype (CAS on baseRev). Responds 204 without a body.",
  status: 204,
  requestSchema: z.object({ baseRev: positiveInt }),
  errors: [errorCatalog.baseRevRequired, errorCatalog.prototypeNotFound, errorCatalog.revConflict],
});

// Пин компонента ревизии; `status` добавлен волной 3 и опционален для старых ответов.
const componentPinSchema = z.looseObject({ id: z.string(), name: z.string(), version: z.number(), bundleUrl: z.string(), bundleHash: z.string(), status: z.string().optional() });
const compositionPinSchema = z.looseObject({
  id: z.string(), name: z.string(), version: z.number(), sourceHash: z.string(), doc: compositionDocSchema,
  designSystem: z.string().optional(), status: z.string().optional(),
});

const prototypeRevisionCoreSchema = z.looseObject({
  doc: z.looseObject({ id: z.string(), version: z.literal(1), screens: z.array(z.unknown()) }),
  rev: z.number(), builtinCatalogHash: z.string(), componentManifestHash: z.string(),
  prototypeInstanceId:z.string(),
  components: z.array(z.looseObject({ id: z.string(), version: z.number() })),
  compositions: z.array(compositionPinSchema).optional(),
  assets: z.array(assetPublicSchema.omit({ width: true, height: true })),
  designSystemMetaVersion: z.number().nullable(),
  /**
   * Пины тем ревизии: `дизайн-система → версия темы` (миграция v24, план multi-surface §4).
   * `designSystemMetaVersion` остаётся значением **primary**-ДС. Read-правило без бэкфила:
   * ревизия без строк отдаёт `{ <primary ДС>: designSystemMetaVersion }`.
   */
  designSystemMetaVersions: z.record(z.string(), z.number().nullable()),
  figma: figmaResponseSchema.optional(),
  renderable:z.boolean(),renderError:prototypeRenderErrorSchema.nullable(),
  // P2.3: `track` ревизии и момент резолва head-пинов (`null` у обычных, pinned-доков).
  track: prototypeTrackSchema.optional(), resolvedAt: isoDate.nullable().optional(),
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
    /** Производные значения стейта (`doc.computed`) — та же map-форма, что у `state`. */
    computed: z.union([diffMapSchema, omittedSchema]).optional(),
    /**
     * Поверхности документа (`doc.surfaces`, план multi-surface D13) — map-форма по `id`
     * поверхности: правка устройства/стартового экрана панели видна в истории ревизий.
     */
    surfaces: z.union([diffMapSchema, omittedSchema]).optional(),
    screens: screensDiffSchema.optional(),
    flows: z.union([elementValueDiffSchema, omittedSchema]).optional(),
    screenOrder: z.union([z.strictObject({ from: z.array(boundedDiffString).max(100), to: z.array(boundedDiffString).max(100) }), omittedSchema]).optional(),
    pins: z.union([pinsDiffSchema, omittedSchema]).optional(),
    renderInputs: z.union([z.array(renderInputDiffFieldSchema), omittedSchema]).optional(),
    summary: z.strictObject({
      screensAdded: z.number().int().nonnegative(), screensRemoved: z.number().int().nonnegative(), screensChanged: z.number().int().nonnegative(),
      staticElementsAdded: z.number().int().nonnegative(), staticElementsRemoved: z.number().int().nonnegative(), staticElementsChanged: z.number().int().nonnegative(),
      identical: z.boolean(), docIdentical: z.boolean(), truncated: z.boolean(),
      omittedSections: z.array(z.enum(["props", "elements", "screens", "flows", "state", "computed", "doc", "pins", "surfaces", "renderInputs", "screenOrder"])),
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

// --- Ready-to-publish report (волна 4) ---
// Детали гейта разложены в тот же объект (форма зависит от гейта), поэтому looseObject.
export const readinessGateSchema = z.looseObject({
  id: z.enum(READINESS_GATE_IDS),
  status: z.enum(["pass", "warn", "fail", "unknown"]),
  summary: z.string(),
});

export const readinessReportSchema = z.strictObject({
  prototypeId: z.string(),
  rev: positiveInt,
  generatedAt: isoDate,
  // P9: профиль отчёта; у `service` предупреждения не поднимают статус до блокирующего.
  profile: z.enum(["product", "service"]),
  gates: z.array(readinessGateSchema),
  blocking: z.array(z.enum(READINESS_GATE_IDS)),
  publishable: z.boolean(),
  enabledGates: z.record(z.string(), z.enum(["fail", "warn"])),
});

export const getPrototypeReadinessContract = registerContract({
  method: "GET", path: "/api/prototypes/{id}/readiness",
  summary: "Ready-to-publish report for the head revision: one row per gate, plus the blocking set. Read-only — it never enqueues screenshot or visual jobs.",
  responseSchema: readinessReportSchema,
  errors: [errorCatalog.prototypeNotFound, errorCatalog.revisionNotFound],
});

// --- Сценарии взаимодействия (волна 6) ---
// Шаги валидируются схемой из `src/prototype/scenario.ts` — единый источник для рекордера,
// клиентского раннера и сервера. Прогонов на сервере нет: раннер живёт в браузере.
const scenarioResponseSchema = z.strictObject({
  id: z.string(), prototypeId: z.string(), name: z.string(),
  steps: scenarioStepsSchema, author: z.string().nullable(),
  createdAt: isoDate, updatedAt: isoDate,
});

export const listPrototypeScenariosContract = registerContract({
  method: "GET", path: "/api/prototypes/{id}/scenarios",
  summary: "List recorded interaction scenarios of a prototype (readable by anyone who can read the prototype).",
  responseSchema: z.strictObject({ scenarios: z.array(scenarioResponseSchema) }),
  errors: [errorCatalog.prototypeNotFound, errorCatalog.methodNotAllowed],
});

export const createPrototypeScenarioContract = registerContract({
  method: "POST", path: "/api/prototypes/{id}/scenarios",
  summary: "Create an interaction scenario (owner or admin); `id` is an optional slug, generated when omitted.",
  status: 201,
  requestSchema: z.object({ id: slugString.max(64).optional(), ...scenarioInputSchema.shape }),
  responseSchema: scenarioResponseSchema,
  errors: [errorCatalog.invalidRequest, { status: 403, code: "forbidden" }, errorCatalog.prototypeNotFound, errorCatalog.alreadyExists, errorCatalog.validationFailed],
});

export const getPrototypeScenarioContract = registerContract({
  method: "GET", path: "/api/prototypes/{id}/scenarios/{scenarioId}",
  summary: "Read one interaction scenario.",
  responseSchema: scenarioResponseSchema,
  errors: [errorCatalog.prototypeNotFound, { status: 404, code: "scenario_not_found" }],
});

export const savePrototypeScenarioContract = registerContract({
  method: "PUT", path: "/api/prototypes/{id}/scenarios/{scenarioId}",
  summary: "Replace an interaction scenario's name and steps (owner or admin).",
  requestSchema: scenarioInputSchema,
  responseSchema: scenarioResponseSchema,
  errors: [errorCatalog.invalidRequest, { status: 403, code: "forbidden" }, errorCatalog.prototypeNotFound, { status: 404, code: "scenario_not_found" }, errorCatalog.validationFailed],
});

export const deletePrototypeScenarioContract = registerContract({
  method: "DELETE", path: "/api/prototypes/{id}/scenarios/{scenarioId}",
  summary: "Delete an interaction scenario (owner or admin). Responds 204 without a body.",
  status: 204,
  errors: [{ status: 403, code: "forbidden" }, errorCatalog.prototypeNotFound, { status: 404, code: "scenario_not_found" }],
});

export const repinPrototypeQuerySchema = z.strictObject({ dryRun: z.enum(["1"]).optional() });

export const repinPrototypeContract = registerContract({
  method: "POST", path: "/api/prototypes/{id}/repin",
  summary: "Re-save the head document so component pins move to the latest active publishes; ?dryRun=1 returns the diff without writing.",
  query: repinPrototypeQuerySchema,
  requestSchema: z.looseObject({}),
  responseSchema: z.strictObject({
    dryRun: z.boolean(),
    rev: positiveInt,
    before: z.array(componentPinSchema),
    after: z.array(componentPinSchema),
    changed: z.array(z.strictObject({ component: z.string(), from: z.number().nullable(), to: z.number().nullable() })),
  }),
  errors: [errorCatalog.invalidRequest, { status: 403, code: "forbidden" }, errorCatalog.prototypeNotFound, errorCatalog.revConflict, errorCatalog.validationFailed],
});

export const publishPrototypeContract = registerContract({
  method: "POST", path: "/api/prototypes/{id}/publish",
  summary: "Publish the head revision as the next immutable version; returns canonical screen URLs. Blocked gates (EASYUI_PUBLISH_GATES) answer 409 publish_blocked unless force:true.",
  status: 201,
  requestSchema: z.object({ ...casBody, force: z.boolean().optional() }),
  responseSchema: z.looseObject({ version: z.number(), rev: z.number(), screens: z.array(screenUrlSchema) }),
  errors: [errorCatalog.baseRevRequired, errorCatalog.prototypeNotFound, errorCatalog.revConflict, errorCatalog.alreadyPublished, { status: 409, code: "publish_blocked", description: "One or more enabled readiness gates block publication; the report is in error.details.report." }, errorCatalog.validationFailed, headTrackingError],
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
    headTrackingError,
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

// Надгробия (волна 3 §3.2) видны только под `?includeDeleted=1`; голый GET остаётся 404.
export const includeDeletedQuerySchema = z.strictObject({ includeDeleted: z.literal("1").optional() });

export const listComponentsContract = registerContract({
  method: "GET", path: "/api/components",
  summary: "List custom components with head revision and latest active version. `includeDeleted=1` additionally returns tombstones {deleted,deletedAt,reason,replacement}.",
  query: includeDeletedQuerySchema,
  responseSchema: z.array(componentListItemSchema),
  errors: [errorCatalog.methodNotAllowed],
});

const componentReuseCandidateSchema = z.looseObject({
  kind: z.literal("component"), key: z.string(), id: z.string(), name: z.string(), designSystem: z.string(),
  version: z.number().int().nonnegative(), draft: z.boolean(), description: z.string(),
  atomicLevel: z.string().optional(), scope: z.string().optional(), canonicalFor: z.array(z.string()),
  replacement: z.string().optional(), deprecated: z.boolean(), recommendable: z.boolean(),
  headUsageCount: z.number().int().nonnegative(), score: z.number(), blocking: z.boolean(), reasons: z.array(z.string()),
  propsDelta: z.strictObject({ added: z.array(z.string()), removed: z.array(z.string()), typeChanged: z.array(z.string()) }).optional(),
});

const componentReuseErrorFields = {
  message: z.string(), catalogRevision: z.string(), policyVersion: z.number().int().nonnegative(),
  candidates: z.array(componentReuseCandidateSchema), retryable: z.literal(false), resolution: z.enum(["reuse", "escalate"]),
  nextSteps: z.array(z.string()),
  overrideTemplate: z.strictObject({ catalogRevision: z.string(), candidateKeys: z.array(z.string()) }),
  decisionId: z.string().nullable(), repeatedAttempts: z.number().int().nonnegative().nullable(),
  conflictingRoles: z.array(z.string()).optional(),
};

const componentReuseErrorSchema = z.looseObject({
  code: z.enum(["component_reuse_required", "catalog_changed", "canonical_role_conflict"]),
  ...componentReuseErrorFields,
});

const componentPublishReuseErrorSchema = z.looseObject({
  code: z.enum(["catalog_changed", "canonical_role_conflict"]),
  ...componentReuseErrorFields,
});

const componentCreateConflictEnvelopeSchema = z.strictObject({
  error: z.union([
    z.looseObject({ code: z.literal("already_exists"), message: z.string() }),
    componentReuseErrorSchema,
  ]),
});

const componentPublishConflictEnvelopeSchema = z.strictObject({
  error: z.union([
    z.looseObject({ code: z.enum(["revision_conflict", "already_published"]), message: z.string() }),
    componentPublishReuseErrorSchema,
  ]),
});

export const createComponentContract = registerContract({
  method: "POST", path: "/api/components",
  summary: "Create a custom component from TSX source (syntax-checked and definition-extracted). In enforce mode, intent is required; reuse conflicts return a terminal 409 with candidates and a human-confirmed override template.",
  status: 201,
  requestSchema: z.strictObject({ id: slugString, name: z.string().regex(/^[A-Z][A-Za-z0-9]*$/), source: z.string(), designSystem: slugString, message: z.string().optional(), figma: figmaSchema.optional(), intent: reuseIntentSchema.optional(), reuseOverride: componentReuseOverrideSchema.optional() }),
  responseSchema: z.looseObject({ id: z.string(), rev: z.literal(1), warnings: z.array(z.string()).optional() }),
  errors: [errorCatalog.invalidRequest, errorCatalog.alreadyExists, errorCatalog.payloadTooLarge, errorCatalog.validationFailed, { status: 403, code: "admin_required", description: "reuseOverride is admin-only" }, { status: 409, code: "component_reuse_required" }, { status: 409, code: "catalog_changed" }, { status: 409, code: "canonical_role_conflict" }],
  errorResponseSchemas: { 409: componentCreateConflictEnvelopeSchema },
});

export const getComponentContract = registerContract({
  method: "GET", path: "/api/components/{id}",
  summary: "Component lifecycle meta: head revision, versions, validated revision, renderable. Soft-deleted components stay 404 unless `includeDeleted=1`, which adds the tombstone {deleted,deletedAt,reason,replacement}.",
  query: includeDeletedQuerySchema,
  responseSchema: z.looseObject({
    id: z.string(), name: z.string(), designSystem: z.string(), headRev: z.number(),
    versions: z.array(z.unknown()), updatedAt: isoDate, draftRevision: z.number(), publishedVersion: z.number().nullable(),
    figma: figmaResponseSchema,
  }),
  errors: [errorCatalog.notFound],
});

export const saveComponentContract = registerContract({
  method: "PUT", path: "/api/components/{id}",
  summary: "Save a new head revision of source and/or move the component between design systems (CAS on baseRev). A figma-only no-op (source and figma byte-identical to head) does not create a revision and answers {unchanged:true, rev:<head>}; a changed figma still creates a revision.",
  requestSchema: z.object({ source: z.string().optional(), designSystem: slugString.optional(), figma: figmaSchema.optional(), ...casBody }),
  responseSchema: z.looseObject({ rev: z.number(), unchanged: z.literal(true).optional() }),
  errors: [errorCatalog.invalidRequest, errorCatalog.baseRevRequired, errorCatalog.notFound, errorCatalog.revConflict, errorCatalog.payloadTooLarge, errorCatalog.validationFailed],
});

export const deleteComponentContract = registerContract({
  method: "DELETE", path: "/api/components/{id}",
  summary: "Soft-delete a component with an optional tombstone (CAS on baseRev). 409 component_in_use while head revisions still pin it; an admin may pass force:true. Responds 204 without a body.",
  status: 204,
  requestSchema: z.object({ baseRev: positiveInt, reason: z.string().optional(), replacement: slugString.optional(), force: z.boolean().optional() }),
  errors: [errorCatalog.invalidRequest, errorCatalog.baseRevRequired, errorCatalog.notFound, errorCatalog.revConflict, { status: 403, code: "admin_required" }, { status: 409, code: "component_in_use" }, errorCatalog.validationFailed],
});

// --- Usage graph (волна 3 §3.1) ---

const usageScreenSchema = z.looseObject({ screenId: z.string(), screenName: z.string(), elementKeys: z.array(z.string()) });
const immutableUsageSchema = z.looseObject({ prototypeId: z.string(), name: z.string(), version: z.number(), componentVersion: z.number() });
const usageTreeNodeSchema: z.ZodType = z.lazy(() => z.looseObject({
  kind: z.enum(["prototype", "screen", "element"]), id: z.string(), label: z.string(), children: z.array(usageTreeNodeSchema).optional(),
}));

export const componentUsagesQuerySchema = z.strictObject({ format: z.enum(["flat", "tree"]).optional() });

export const componentUsagesContract = registerContract({
  method: "GET", path: "/api/components/{id}/usages",
  summary: "Usage graph of a component: head-revision usages with exact screen/element keys, immutable usages pinned by prototype publications, versions in use and a safe-to-remove verdict. `format=tree` groups head usages as prototype → screen → element.",
  query: componentUsagesQuerySchema,
  validated: true,
  responseSchema: z.union([
    z.looseObject({
      componentId: z.string(), name: z.string(),
      currentHeadUsages: z.array(z.looseObject({
        prototypeId: z.string(), name: z.string(), kind: z.string(), rev: z.number(), componentVersion: z.number(),
        screens: z.array(usageScreenSchema),
      })),
      immutableUsages: z.array(immutableUsageSchema),
      versionsInUse: z.array(z.number()), safeToRemove: z.boolean(),
    }),
    z.looseObject({
      format: z.literal("tree"), componentId: z.string(), name: z.string(),
      nodes: z.array(usageTreeNodeSchema), immutableUsages: z.array(immutableUsageSchema),
      versionsInUse: z.array(z.number()), safeToRemove: z.boolean(),
    }),
  ]),
  errors: [errorCatalog.notFound, errorCatalog.methodNotAllowed, errorCatalog.validationFailed],
});

export const catalogUsagesQuerySchema = z.strictObject({ designSystem: slugString.optional() });

export const catalogUsagesContract = registerContract({
  method: "GET", path: "/api/catalog/usages",
  summary: "Aggregate usage index: every live component with the head-revision prototypes that pin it. Cached against MAX(prototypes.updated_at).",
  query: catalogUsagesQuerySchema,
  validated: true,
  responseSchema: z.object({ components: z.array(z.looseObject({
    componentId: z.string(), name: z.string(), designSystem: z.string(), headUsageCount: z.number(),
    prototypes: z.array(z.looseObject({ prototypeId: z.string(), name: z.string(), kind: z.string(), rev: z.number() })),
  })) }),
  errors: [errorCatalog.notFound, errorCatalog.methodNotAllowed, errorCatalog.validationFailed],
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
  summary: "Publish the head revision: typecheck, compile, import-verify and activate the next version. Canonical-role conflicts return a terminal 409 with a human-confirmed admin override template. Reuses a successful validate extraction of the same source when present.",
  status: 201,
  requestSchema: z.strictObject({ ...casBody, reuseOverride: componentReuseOverrideSchema.optional() }),
  responseSchema: z.looseObject({ version: z.number(), hostAbiVersion: z.number(), warnings: z.array(z.string()) }),
  errors: [errorCatalog.baseRevRequired, errorCatalog.notFound, errorCatalog.revConflict, errorCatalog.alreadyPublished, { status: 403, code: "admin_required", description: "reuseOverride is admin-only" }, { status: 409, code: "catalog_changed" }, { status: 409, code: "canonical_role_conflict" }, errorCatalog.validationFailed, { status: 422, code: "atomic_policy_violation" }, { status: 422, code: "event_schema_not_serializable" }],
  errorResponseSchemas: { 409: componentPublishConflictEnvelopeSchema },
});

/**
 * Конверт 409 у promote: к publish-набору добавлены `source_hash_mismatch` (receipt описывает
 * другой исходник) и `candidate_unavailable` (кэш кандидата исчез между сборкой и чтением).
 */
const componentPromoteConflictEnvelopeSchema = z.strictObject({
  error: z.union([
    z.looseObject({ code: z.enum(["revision_conflict", "already_published", "source_hash_mismatch", "candidate_unavailable"]), message: z.string() }),
    componentPublishReuseErrorSchema,
  ]),
});

/**
 * RFC candidate-acceptance-pipeline §4.3 (волна R1): приёмка провалидированной head-ревизии
 * одной командой. Receipt-based — durable-таблиц кандидатов в R1 нет, идентификация входа —
 * пара `{baseRev, sourceHash}` из validate-receipt.
 */
export const promoteComponentContract = registerContract({
  method: "POST", path: "/api/components/{id}/promote",
  summary: "Promote the validated head revision to a public version in one call: reruns the catalog-time publish checks (host primitive name, canonical role, atomic policy, asset refs), stages the candidate artifacts WITHOUT re-running typecheck/compile, import-verifies, then activates, pins assets, records validation and auto-supersedes the other active versions in one short transaction. `sourceHash` must match the head source; `expectedCatalogRevision` is an opt-in catalog CAS; `supersede: \"none\"` leaves parallel active versions alone. Disabled via EASYUI_ACCEPTANCE_DISABLED=1 (404).",
  status: 201,
  requestSchema: z.strictObject({
    ...casBody,
    sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
    expectedCatalogRevision: z.string().optional(),
    supersede: z.enum(["auto", "none"]).optional(),
    reuseOverride: componentReuseOverrideSchema.optional(),
    /** W1a: принимаются формой, но требуют EASYUI_ACCEPTANCE_MATRIX=1 и приезжают в сагу в W1c. */
    candidateId: z.string().optional(),
    acceptanceRunId: z.string().optional(),
  }),
  responseSchema: z.looseObject({
    version: z.number(), rev: z.number(), hostAbiVersion: z.number(),
    sourceHash: z.string(), bundleHash: z.string(),
    themeVersion: z.number().nullable(), catalogRevision: z.string(),
    superseded: z.array(z.number()), cached: z.boolean(), warnings: z.array(z.string()),
  }),
  errors: [
    errorCatalog.invalidRequest, errorCatalog.baseRevRequired, errorCatalog.notFound,
    { status: 403, code: "admin_required", description: "reuseOverride is admin-only" },
    errorCatalog.revConflict, errorCatalog.alreadyPublished,
    { status: 409, code: "source_hash_mismatch", description: "sourceHash does not describe the current head revision" },
    { status: 409, code: "candidate_unavailable", description: "the candidate bundle vanished between build and read; validate again" },
    { status: 409, code: "catalog_changed" }, { status: 409, code: "canonical_role_conflict" },
    errorCatalog.payloadTooLarge, errorCatalog.validationFailed,
    { status: 422, code: "asset_not_found" },
    { status: 422, code: "atomic_policy_violation" },
    { status: 422, code: "event_schema_not_serializable" },
    { status: 422, code: "acceptance_matrix_disabled", description: "candidateId/acceptanceRunId were sent while EASYUI_ACCEPTANCE_MATRIX is off" },
    { status: 422, code: "unsupported_option", description: "candidateId/acceptanceRunId are wired into the promote saga from wave W1c" },
    { status: 429, code: "validate_in_flight", description: "a validate/promote build is already in flight for this user" },
    { status: 429, code: "queue_full", description: "global validate concurrency cap reached" },
  ],
  errorResponseSchemas: { 409: componentPromoteConflictEnvelopeSchema },
});

/**
 * P8 (план 2026-08-02): validate-префлайт head-ревизии. Гарантия «publish не упадёт на 422»
 * ОГРАНИЧЕНА перечисленным набором проверок — canonical-role, reuse-гейт и прочие
 * каталого-временные проверки receipt не покрывает (они остаются на publish).
 */
export const validateComponentContract = registerContract({
  method: "POST", path: "/api/components/{id}/validate",
  summary: "Preflight the head revision without creating a version or changing public state: stored figma provenance (unsupported fields fail with the field in issues), asset refs, definition extraction with smoke render, typecheck, compile and import verification, plus schema-default/render-fallback parity warnings. The receipt (sourceHash/bundleHash/themeVersion/catalogRevision) covers only this check set — canonical-role, reuse-gate and other catalog-time publish checks are NOT covered. Heavy results are cached by sourceHash (24h TTL, byte-capped, GC on start and on write); throttled to 1 concurrent run per user and a global cap. Disabled via EASYUI_VALIDATE_DISABLED=1 (404).",
  responseSchema: z.looseObject({
    ok: z.literal(true), cached: z.boolean(),
    sourceHash: z.string(), bundleHash: z.string(), hostAbiVersion: z.number(),
    themeVersion: z.number().nullable(), catalogRevision: z.string(),
    warnings: z.array(z.string()),
  }),
  errors: [
    errorCatalog.notFound,
    errorCatalog.invalidRequest,
    errorCatalog.payloadTooLarge,
    errorCatalog.validationFailed,
    { status: 422, code: "asset_not_found" },
    { status: 422, code: "event_schema_not_serializable" },
    { status: 429, code: "validate_in_flight", description: "a validate run is already in flight for this user" },
    { status: 429, code: "queue_full", description: "global validate concurrency cap reached" },
  ],
});

/**
 * Матричная приёмка кандидата (план 2026-08-03 §5 W1a, RFC §4.1–4.2). Весь набор существует
 * только при `EASYUI_ACCEPTANCE_MATRIX=1` — иначе 404 (`features.acceptanceMatrix=false`).
 * Авторизация одна на все ручки: `requireUser` + владелец компонента по денормализованному
 * `component_id` (или админ); `share`/`capture`-принципалы получают 403 всегда.
 */
const acceptanceCandidateFields = {
  candidateId: z.string(), componentId: z.string(), designSystem: z.string(), rev: z.number(),
  sourceHash: z.string(), bundleHash: z.string(), hostAbiVersion: z.number(), themeVersion: z.number().nullable(),
  buildFingerprint: z.string(), policyProfileHash: z.string(), catalogRevision: z.string(),
  status: z.enum(["validated", "promoted"]), statusReason: z.string().nullable(),
  acceptanceRunId: z.string().nullable(), promotedVersion: z.number().nullable(),
  createdAt: isoDate, expiresAt: isoDate,
};

const acceptanceRunStatusSchema = z.enum(["queued", "running", "pass", "pass_with_exceptions", "fail", "error", "cancelled"]);
const acceptanceProgressSchema = z.looseObject({
  total: z.number(), completed: z.number(), reused: z.number(), failed: z.number(), running: z.number(),
  eta: z.looseObject({ secondsRemaining: z.number(), basis: z.enum(["measured", "estimate"]) }).optional(),
});
const acceptanceGateResultSchema = z.looseObject({ gate: z.string(), status: z.string(), detail: z.string().optional() });
const acceptanceSeveritySchema = z.looseObject({ rank: z.number(), class: z.string(), score: z.number() }).nullable();

const acceptanceRunViewSchema = z.looseObject({
  runId: z.string(), candidateId: z.string(), componentId: z.string(), status: acceptanceRunStatusSchema,
  policy: z.looseObject({ id: z.string(), hash: z.string() }),
  caseSetId: z.string().nullable(), idempotencyKey: z.string().nullable(),
  progress: acceptanceProgressSchema, eta: z.looseObject({}).nullable(),
  gates: z.unknown(), evidenceManifestHash: z.string().nullable(),
  createdAt: isoDate, startedAt: isoDate.nullable(), finishedAt: isoDate.nullable(),
  failedCases: z.array(z.looseObject({
    caseId: z.string(), caseKey: z.string(), status: z.string(), verdict: z.string().nullable(),
    severity: acceptanceSeveritySchema, failedGates: z.array(acceptanceGateResultSchema),
  })),
});

/** Общие отказы владения: чужой компонент — 403, несуществующий кандидат/ран — 404. */
const acceptanceAuthErrors = [
  { status: 403, code: "forbidden", description: "not the component owner, or a share/capture principal" },
  errorCatalog.notFound,
  errorCatalog.methodNotAllowed,
] as const;

export const createComponentCandidateContract = registerContract({
  method: "POST", path: "/api/components/{id}/candidates",
  summary: "Freeze the validated head revision into an immutable acceptance candidate: runs the same head validate preflight (and therefore materializes the candidate bundle that acceptance runs capture by revision), then writes an idempotent durable row keyed by {componentId, designSystem, rev, buildFingerprint}. Repeating the call on an unchanged build returns the same candidateId with cached:true and does NOT reset its status. The candidate bundle is pinned against the candidate-cache GC while a non-terminal run references it. Requires EASYUI_ACCEPTANCE_MATRIX=1 (404 otherwise).",
  requestSchema: z.strictObject({}),
  responseSchema: z.looseObject({ ...acceptanceCandidateFields, cached: z.boolean(), warnings: z.array(z.string()) }),
  errors: [
    ...acceptanceAuthErrors, errorCatalog.invalidRequest,
    { status: 409, code: "revision_conflict", description: "the component head moved while the candidate was being built" },
    errorCatalog.payloadTooLarge, errorCatalog.validationFailed,
    { status: 422, code: "asset_not_found" },
    { status: 429, code: "validate_in_flight", description: "a validate/candidate build is already in flight for this user" },
    { status: 429, code: "queue_full", description: "global validate concurrency cap reached" },
  ],
});

export const getComponentCandidateContract = registerContract({
  method: "GET", path: "/api/component-candidates/{candidateId}",
  summary: "Read an acceptance candidate by id (global namespace; it does not overlap /api/catalog/candidates). Owner or admin only. Requires EASYUI_ACCEPTANCE_MATRIX=1.",
  responseSchema: z.looseObject(acceptanceCandidateFields),
  errors: [...acceptanceAuthErrors],
});

export const createAcceptanceRunContract = registerContract({
  method: "POST", path: "/api/acceptance-runs",
  summary: "Queue a matrix acceptance run over the candidate's cases (wave W1a source: the candidate's named examples). The run executes outside the screenshot pump, one capture job at a time, with per-case verdicts folded into pass/fail/error/cancelled. `idempotencyKey` deduplicates the queueing itself ((candidate_id, idempotency_key) is unique); a candidate may hold at most one non-terminal run (409 acceptance_run_in_flight). `refresh` controls reuse: `\"none\"` (default) reuses every cached case result, `\"failed\"` recaptures only the cases whose previous result for the same fingerprint was fail/indeterminate, `\"all\"` recaptures everything, and `{caseIds:[…]}` recaptures the listed cases (unknown id → 422 unknown_case_id; a listed alias forces its target). The forcing reason is recorded per case in `reuseReason` (`refresh:<mode>`) and in the evidence manifest. Requires EASYUI_ACCEPTANCE_MATRIX=1.",
  status: 202,
  requestSchema: z.strictObject({
    candidateId: z.string(),
    idempotencyKey: z.string().min(1).max(200).optional(),
    policy: z.enum(["default-v1", "pixel-strict-v1"]).optional(),
    cases: z.array(z.strictObject({ key: z.string(), props: z.record(z.string(), z.unknown()) })).optional(),
    refresh: z.union([
      z.enum(["none", "failed", "all"]),
      z.strictObject({ caseIds: z.array(z.string()).min(1).max(64) }),
    ]).optional(),
  }),
  responseSchema: z.looseObject({
    runId: z.string(), status: acceptanceRunStatusSchema, candidateId: z.string(), componentId: z.string(),
    policy: z.looseObject({ id: z.string(), hash: z.string() }),
    progress: acceptanceProgressSchema, cases: z.number(), cached: z.boolean(),
  }),
  errors: [
    ...acceptanceAuthErrors, errorCatalog.invalidRequest,
    { status: 409, code: "acceptance_run_in_flight", description: "the candidate already has a queued/running run" },
    { status: 409, code: "candidate_evicted", description: "the candidate bundle is gone from the cache; re-create the candidate" },
    { status: 409, code: "candidate_stale", description: "the candidate {rev, sourceHash} pair no longer describes that revision" },
    errorCatalog.payloadTooLarge,
    { status: 422, code: "empty_case_set" },
    { status: 422, code: "case_set_too_large" },
    { status: 422, code: "duplicate_case_id" },
    { status: 422, code: "unknown_policy_profile" },
    { status: 422, code: "unknown_case_id", description: "refresh.caseIds names a case that is not part of this run's case set" },
    { status: 422, code: "unsupported_option", description: "cases.concurrency / manifestAssetId / caseSetId are not supported in this phase" },
    { status: 503, code: "maintenance_in_progress", description: "a catalog migration holds the maintenance lock" },
  ],
});

export const getAcceptanceRunContract = registerContract({
  method: "GET", path: "/api/acceptance-runs/{runId}",
  summary: "Poll an acceptance run: status, per-gate roll-up, progress {total, completed, reused, failed, running}, ETA and failedCases sorted by severity. Owner or admin only. Requires EASYUI_ACCEPTANCE_MATRIX=1.",
  responseSchema: acceptanceRunViewSchema,
  errors: [...acceptanceAuthErrors],
});

export const getAcceptanceRunCasesContract = registerContract({
  method: "GET", path: "/api/acceptance-runs/{runId}/cases",
  summary: "Per-case verdicts of a run with gate results, severity, reuse reason and the evidence artifact names/digests (never bytes: artifact content is served only inside the runId-scoped evidence archive). Requires EASYUI_ACCEPTANCE_MATRIX=1.",
  responseSchema: z.looseObject({
    runId: z.string(),
    cases: z.array(z.looseObject({
      caseId: z.string(), caseKey: z.string(), status: z.string(), verdict: z.string().nullable(),
      severity: acceptanceSeveritySchema, propsHash: z.string(), caseFingerprint: z.string(),
      aliasOfCaseId: z.string().nullable(), reuseReason: z.string().nullable(), reused: z.boolean(),
      referenceAssetId: z.string().nullable(), startedAt: isoDate.nullable(), finishedAt: isoDate.nullable(),
      gates: z.array(acceptanceGateResultSchema),
      artifacts: z.array(z.looseObject({ name: z.string(), sha256: z.string(), bytes: z.number() })),
    })),
  }),
  errors: [...acceptanceAuthErrors],
});

export const getAcceptanceRunEvidenceContract = registerContract({
  method: "GET", path: "/api/acceptance-runs/{runId}/evidence",
  summary: "Download the run evidence archive (ZIP): manifest.json, SHA256SUMS and every CAS artifact under <caseId>/<name>. The manifest is written when the run terminalizes (409 evidence_not_ready before that); artifacts already reclaimed by the evidence GC stay listed in SHA256SUMS but are absent from the archive. Owner or admin only.",
  contentType: "application/zip",
  errors: [
    ...acceptanceAuthErrors,
    { status: 409, code: "evidence_not_ready", description: "the run has not terminalized yet" },
    { status: 413, code: "evidence_too_large", description: "raw evidence exceeds limits.evidenceMaxBytes" },
  ],
});

export const cancelAcceptanceRunContract = registerContract({
  method: "POST", path: "/api/acceptance-runs/{runId}/cancel",
  summary: "Cancel a run that is still queued. A running run is not cancellable (409 run_not_cancellable) — it terminalizes on its own or via the watchdog. Requires EASYUI_ACCEPTANCE_MATRIX=1.",
  responseSchema: acceptanceRunViewSchema,
  errors: [
    ...acceptanceAuthErrors,
    { status: 409, code: "run_not_cancellable", description: "only queued runs can be cancelled" },
  ],
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
  errors: [exportUnauthorized, exportForbidden, errorCatalog.prototypeNotFound, errorCatalog.versionNotFound, exportTooLarge, headTrackingError, surfacesNotExportableError],
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
  errors: [exportUnauthorized, exportForbidden, exportTooLarge, headTrackingError, surfacesNotExportableError],
});

// --- Bundle import (ZIP) ---

export const importBundleQuerySchema = z.strictObject({ mode: z.enum(["dry-run", "apply"]).optional() });

export const importBundleContract = registerContract({
  method: "POST", path: "/api/bundles/import",
  summary: "Import a ZIP bundle (multipart file or raw application/zip); dry-run predicts, apply writes. Returns a per-item report. A multipart `reuseOverride` field carries the admin-confirmed second phase of a reuse-gate override; items blocked by the gate report `reuseCode` with the candidate keys.",
  query: importBundleQuerySchema,
  responseSchema: importReportSchema,
  errors: [
    { status: 400, code: "invalid_bundle" },
    { status: 400, code: "invalid_request", description: "the multipart reuseOverride field is not a valid override object" },
    { status: 403, code: "admin_required", description: "only an admin may pass reuseOverride" },
    { status: 413, code: "payload_too_large" },
    { status: 415, code: "unsupported_media_type" },
    { status: 422, code: "validation_failed" },
  ],
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

export const retireDesignSystemContract = registerContract({
  method: "DELETE", path: "/api/design-systems/{id}",
  summary: "Retire (soft-archive) a custom design system: sets retired=1 without deleting anything. Owner or admin only; builtin systems answer 405; a system that still owns live components/prototypes/compositions answers 409 design_system_in_use with per-kind counts; an already retired one answers 409 design_system_retired. Responds 204 without a body.",
  status: 204,
  errors: [{ status: 403, code: "forbidden" }, errorCatalog.notFound, errorCatalog.methodNotAllowed, { status: 409, code: "design_system_in_use" }, { status: 409, code: "design_system_retired" }],
});


// --- Compositions (волна 5 §5.4): версионированные фрагменты экрана ---

const compositionParamSchema = z.looseObject({
  type: z.enum(["string", "number", "boolean", "json", "asset"]),
  required: z.boolean().optional(), default: z.json().optional(), description: z.string().optional(),
});
const compositionDocumentCommonSchema = {
  name: z.string(), description: z.string().optional(),
  scope: z.enum(["section", "shell", "screen"]).optional(),
  canonicalFor: z.array(z.string()).optional(),
  ownership: z.object({ reason: z.string(), provenance: z.string().optional() }).optional(),
  replacement: z.string().optional(),
  params: z.record(z.string(), compositionParamSchema), slots: z.array(z.string()),
  spec: z.looseObject({ root: z.string(), elements: z.record(z.string(), z.unknown()) }),
  provenance: z.looseObject({ source: z.string().optional(), figmaNodeId: z.string().optional() }).optional(),
} as const;
const compositionDocumentSchema = z.discriminatedUnion("version", [
  z.looseObject({ version: z.literal(1), ...compositionDocumentCommonSchema }),
  z.looseObject({ version: z.literal(2), atomicLevel: z.enum(["molecule", "organism", "template", "page"]), ...compositionDocumentCommonSchema }),
]);
const compositionVersionSchema = z.looseObject({
  version: positiveInt, rev: positiveInt, status: z.string(), statusReason: z.string().nullable(),
  supersededBy: z.number().nullable(), statusRev: z.number(), sourceHash: z.string(), publishedAt: isoDate,
});
const compositionUsagesSchema = z.looseObject({
  currentHeadUsages: z.array(z.looseObject({ prototypeId: z.string(), name: z.string(), kind: z.string(), rev: z.number(), version: z.number() })),
  immutableUsages: z.array(z.looseObject({ prototypeId: z.string(), version: z.number(), compositionVersion: z.number() })),
  safeToRemove: z.boolean(),
});

export const listCompositionsContract = registerContract({
  method: "GET", path: "/api/compositions",
  summary: "List compositions with head revision, latest active version, declared params and slots. `includeDeleted=1` additionally returns tombstones.",
  query: includeDeletedQuerySchema,
  responseSchema: z.array(z.looseObject({
    id: z.string(), name: z.string(), designSystem: z.string(), headRev: z.number(),
    latestVersion: z.number().nullable(), updatedAt: isoDate, params: z.array(z.string()), slots: z.array(z.string()),
  })),
  errors: [errorCatalog.methodNotAllowed],
});

export const createCompositionContract = registerContract({
  method: "POST", path: "/api/compositions",
  summary: "Create a composition from a composition document (params, slots and a spec whose element types must be published components of the design system).",
  status: 201,
  requestSchema: z.object({ id: slugString, doc: compositionDocumentSchema, designSystem: slugString, message: z.string().optional() }),
  responseSchema: z.looseObject({ id: z.string(), rev: z.literal(1) }),
  errors: [errorCatalog.invalidRequest, errorCatalog.alreadyExists, errorCatalog.validationFailed, errorCatalog.notFound],
});

export const getCompositionContract = registerContract({
  method: "GET", path: "/api/compositions/{id}",
  summary: "Composition meta: head revision, its document, versions and the latest active version. Soft-deleted compositions stay 404 unless `includeDeleted=1`.",
  query: includeDeletedQuerySchema,
  responseSchema: z.looseObject({
    id: z.string(), name: z.string(), designSystem: z.string(), headRev: z.number(),
    versions: z.array(compositionVersionSchema), updatedAt: isoDate, publishedVersion: z.number().nullable(),
    doc: compositionDocumentSchema,
  }),
  errors: [errorCatalog.notFound],
});

export const saveCompositionContract = registerContract({
  method: "PUT", path: "/api/compositions/{id}",
  summary: "Save a new head revision of the composition document (CAS on baseRev).",
  requestSchema: z.object({ doc: compositionDocumentSchema, ...casBody }),
  responseSchema: z.looseObject({ rev: z.number() }),
  errors: [errorCatalog.invalidRequest, errorCatalog.baseRevRequired, errorCatalog.notFound, errorCatalog.revConflict, errorCatalog.alreadyExists, errorCatalog.validationFailed],
});

export const deleteCompositionContract = registerContract({
  method: "DELETE", path: "/api/compositions/{id}",
  summary: "Soft-delete a composition (CAS on baseRev). 409 composition_in_use while head revisions still pin it; an admin may pass force:true. Responds 204 without a body.",
  status: 204,
  requestSchema: z.object({ baseRev: positiveInt, reason: z.string().optional(), force: z.boolean().optional() }),
  errors: [errorCatalog.invalidRequest, errorCatalog.baseRevRequired, errorCatalog.notFound, errorCatalog.revConflict, { status: 403, code: "admin_required" }, { status: 409, code: "composition_in_use" }],
});

export const listCompositionRevisionsContract = registerContract({
  method: "GET", path: "/api/compositions/{id}/revisions",
  summary: "List composition revisions (newest first).",
  responseSchema: z.array(z.looseObject({ rev: z.number(), message: z.string().nullable(), createdAt: isoDate })),
  errors: [errorCatalog.notFound, errorCatalog.methodNotAllowed],
});

export const getCompositionRevisionContract = registerContract({
  method: "GET", path: "/api/compositions/{id}/revisions/{rev}",
  summary: "Read one composition revision document.",
  responseSchema: z.looseObject({ rev: z.number(), doc: compositionDocumentSchema, designSystem: z.string(), message: z.string().nullable(), createdAt: isoDate }),
  errors: [errorCatalog.invalidRequest, errorCatalog.notFound, errorCatalog.revisionNotFound],
});

export const publishCompositionContract = registerContract({
  method: "POST", path: "/api/compositions/{id}/publish",
  summary: "Publish the head revision as an immutable composition version (CAS on baseRev).",
  status: 201,
  requestSchema: z.object(casBody),
  responseSchema: z.looseObject({ version: positiveInt, rev: positiveInt }),
  errors: [errorCatalog.invalidRequest, errorCatalog.baseRevRequired, errorCatalog.notFound, errorCatalog.revConflict, errorCatalog.alreadyPublished],
});

export const listCompositionVersionsContract = registerContract({
  method: "GET", path: "/api/compositions/{id}/versions",
  summary: "List immutable composition versions with their statuses.",
  responseSchema: z.array(compositionVersionSchema),
  errors: [errorCatalog.notFound, errorCatalog.methodNotAllowed],
});

export const getCompositionVersionContract = registerContract({
  method: "GET", path: "/api/compositions/{id}/versions/{version}",
  summary: "Read one immutable composition version, including its frozen document.",
  responseSchema: compositionVersionSchema.extend({ doc: compositionDocumentSchema, designSystem: z.string() }),
  errors: [errorCatalog.invalidRequest, errorCatalog.notFound, errorCatalog.versionNotFound],
});

export const setCompositionVersionStatusContract = registerContract({
  method: "POST", path: "/api/compositions/{id}/versions/{version}/status",
  summary: "Manual status transition of a composition version (CAS on baseStatusRev).",
  // `supersededBy` обязателен для перехода в `superseded` (проверяется в репозитории, как у компонентов).
  requestSchema: z.object({ status: z.enum(["active", "deprecated", "superseded", "archived"]), reason: z.string().optional(), supersededBy: positiveInt.optional(), baseStatusRev: positiveInt }),
  responseSchema: z.looseObject({ status: z.string(), statusRev: z.number() }),
  errors: [errorCatalog.invalidRequest, errorCatalog.notFound, errorCatalog.versionNotFound, { status: 409, code: "status_conflict" }, { status: 422, code: "invalid_transition" }],
});

export const compositionUsagesContract = registerContract({
  method: "GET", path: "/api/compositions/{id}/usages",
  summary: "Where a composition is used: head revisions of prototypes and immutable prototype publications that pin it.",
  responseSchema: compositionUsagesSchema,
  errors: [errorCatalog.notFound, errorCatalog.methodNotAllowed],
});

// --- Catalog manifest / shims / health ---

export const catalogManifestQuerySchema = z.strictObject({ designSystem: slugString.optional() });

export const catalogManifestContract = registerContract({
  method: "GET", path: "/api/catalog/manifest",
  summary: "Manifest of the latest active custom-component versions across design systems, with head-usage counts and a deprecated flag for discovery.",
  query: catalogManifestQuerySchema,
  validated: true,
  responseSchema: z.object({ components: z.array(z.looseObject({
    id: z.string(), name: z.string(), designSystem: z.string(), version: z.number(), bundleUrl: z.string(),
    bundleHash: z.string(), hostAbiVersion: z.number(), ...serializedDefinitionFields,
    // Волна 3: сколько головных ревизий прототипов пинуют компонент и устарел ли он
    // (последняя публикация в статусе deprecated/superseded).
    headUsageCount: z.number(), deprecated: z.boolean(),
  })) }),
  errors: [errorCatalog.notFound, errorCatalog.methodNotAllowed, errorCatalog.validationFailed],
});

// --- Catalog audit and protected migration control ---

const migrationArtifactKeySchema = z.looseObject({ kind: z.enum(["component", "composition"]), id: z.string(), designSystem: z.string(), version: z.number().int().positive().optional() });
const migrationAdapterSchema = z.looseObject({ typeMap: z.record(z.string(), z.string()), props: z.record(z.string(), z.unknown()), events: z.record(z.string(), z.unknown()).optional(), slots: z.unknown().optional(), composition: z.unknown().optional() });
const migrationPlanSchema = z.looseObject({
  version: z.literal(1), generatedAt: z.string(), catalogRevision: z.string(), dataFingerprint: z.string(),
  groups: z.array(z.looseObject({ canonical: migrationArtifactKeySchema, retired: z.array(migrationArtifactKeySchema), confidence: z.number(), reasons: z.array(z.string()), adapter: migrationAdapterSchema, affectedPrototypeHeads: z.array(z.string()), affectedCompositionHeads: z.array(z.string()), immutableUsages: z.array(z.looseObject({ resourceId: z.string(), version: z.number() })) })),
  compositionConversions: z.array(z.unknown()), metadataRevisions: z.array(z.unknown()), documentedExceptions: z.array(z.unknown()),
});

export const catalogMigrationAuditContract = registerContract({
  method: "GET", path: "/api/catalog/migrations/audit",
  summary: "Read-only consistent catalog audit and deterministic migration plan. Administrator only.",
  responseSchema: z.looseObject({ generatedAt: z.string(), catalogRevision: z.string(), dataFingerprint: z.string(), artifacts: z.array(z.unknown()), duplicateGroups: z.array(z.unknown()), plan: migrationPlanSchema }),
  errors: [{ status: 401, code: "unauthorized" }, { status: 403, code: "admin_required" }, errorCatalog.methodNotAllowed],
});

export const listCatalogMigrationsContract = registerContract({
  method: "GET", path: "/api/catalog/migrations",
  summary: "List catalog migration runs and their cutover status. Administrator only.",
  responseSchema: z.looseObject({ runs: z.array(z.unknown()) }),
  errors: [{ status: 401, code: "unauthorized" }, { status: 403, code: "admin_required" }, errorCatalog.methodNotAllowed],
});

export const prepareCatalogMigrationContract = registerContract({
  method: "POST", path: "/api/catalog/migrations/prepare",
  summary: "Stage a read-only audit plan after verifying its catalog and data fingerprints.",
  status: 201,
  requestSchema: migrationPlanSchema,
  responseSchema: z.looseObject({ runId: z.string(), planHash: z.string(), status: z.enum(["prepared", "applied"]) }),
  errors: [{ status: 401, code: "unauthorized" }, { status: 403, code: "admin_required" }, { status: 409, code: "migration_plan_stale" }, errorCatalog.validationFailed],
});

export const applyCatalogMigrationContract = registerContract({
  method: "POST", path: "/api/catalog/migrations/{runId}/apply",
  summary: "Perform the protected atomic migration cutover for a prepared plan.",
  requestSchema: migrationPlanSchema,
  // `backupId` идентифицирует удержанный образ cutover: он нужен для rollback из другого
  // процесса (рестарт, редеплой), где in-process кэш бэкапов пуст.
  responseSchema: z.looseObject({ runId: z.string(), status: z.literal("applied"), backupId: z.string() }),
  errors: [{ status: 401, code: "unauthorized" }, { status: 403, code: "admin_required" }, { status: 409, code: "migration_plan_stale" }, { status: 503, code: "maintenance_in_progress" }, errorCatalog.validationFailed],
});

export const rollbackCatalogMigrationContract = registerContract({
  method: "POST", path: "/api/catalog/migrations/{runId}/rollback",
  summary: "Restore the cutover backup and mark a committed catalog migration rolled back. Administrator only.",
  requestSchema: z.looseObject({ backupId: z.string().min(1).optional(), reason: z.string().trim().min(1).max(500).optional() }),
  responseSchema: z.looseObject({ runId: z.string(), backupId: z.string(), backupSha256: z.string(), bytes: z.number(), status: z.literal("rolled_back") }),
  errors: [{ status: 401, code: "unauthorized" }, { status: 403, code: "admin_required" }, { status: 404, code: "migration_backup_not_found" }, { status: 409, code: "migration_backup_mismatch" }, { status: 503, code: "maintenance_in_progress" }, errorCatalog.validationFailed],
});

// --- Library read model (проект 1 «Library Performance», §3.1–3.2) ---
// Целенаправленный read-model библиотеки: он не заменяет `/api/catalog/manifest` и намеренно
// не отдаёт `source`, `propsJsonSchema`, примеры и историю версий.

export const catalogLibraryQuerySchema = z.strictObject({ designSystem: slugString.optional() });

const libraryCatalogStatusSchema = z.strictObject({
  published: z.boolean(), verified: z.boolean(), visualPending: z.boolean(), blocked: z.boolean(), rejected: z.boolean(),
});

const componentPreviewSelectorSchema = z.union([
  z.strictObject({ selector: z.literal("legacy") }),
  z.strictObject({ selector: z.literal("named"), name: z.string() }),
]);

export const libraryCatalogEntrySchema = z.strictObject({
  kind: z.literal("component"),
  id: z.string(), name: z.string(), designSystem: z.string(), version: positiveInt,
  bundleUrl: z.string(), bundleHash: z.string(), hostAbiVersion: z.number(),
  description: z.string(),
  atomicLevel: z.enum(atomicLevels).optional(),
  layoutNeutral: z.boolean(),
  scope: z.enum(COMPONENT_SCOPES).optional(),
  canonicalFor: z.array(z.string()),
  replacement: z.string().optional(),
  deprecated: z.boolean(),
  headUsageCount: z.number().int().nonnegative(),
  status: libraryCatalogStatusSchema,
  figma: z.strictObject({ fileKey: z.string(), nodeCount: z.number().int().nonnegative() }).nullable(),
  preview: componentPreviewSelectorSchema.nullable(),
});

export const catalogLibraryContract = registerContract({
  method: "GET", path: "/api/catalog/library",
  summary: "Library read model: latest active component versions with resolved status (published/verified/visualPending/blocked/rejected), head usage, Figma summary and the preview selector. Identity is (componentId, designSystem). Never returns source, props schemas or examples.",
  query: catalogLibraryQuerySchema,
  validated: true,
  responseSchema: z.strictObject({
    // sha256 канонического JSON **нефильтрованного** каталога: два клиента с разными
    // `?designSystem=` обязаны видеть одну ревизию на одном состоянии БД.
    catalogRevision: z.string(),
    components: z.array(libraryCatalogEntrySchema),
    systems: z.array(z.strictObject({ id: z.string(), name: z.string(), count: z.number().int().positive() })),
  }),
  errors: [errorCatalog.notFound, errorCatalog.methodNotAllowed, errorCatalog.validationFailed],
});

// --- Discovery кандидатов на переиспользование (проект 2, спека §2, план 2026-07-31 §4 T4) ---

/** 1..20, default 8 (спека §2). Дефолт подставляет хендлер — один на оба метода. */
const reuseLimitSchema = z.number().int().min(1).max(20);

export const catalogCandidateProposedSchema = z.strictObject({
  kind: z.enum(["component", "composition"]),
  id: slugString.max(64).optional(),
  name: z.string().max(64).optional(),
  description: z.string().max(2000).optional(),
  atomicLevel: z.enum(atomicLevels).optional(),
  scope: z.enum(COMPONENT_SCOPES).optional(),
  canonicalFor: z.array(z.string()).max(16).optional(),
  propsJsonSchema: z.unknown().optional(),
  events: z.array(z.string()).max(64).optional(),
  slots: z.array(z.string()).max(64).optional(),
  // Byte ceiling and typed 413 are authoritative in `checkSource`; JSON-body limits apply first.
  source: z.string().optional(),
  // Спека §2 объявляет поле; сегодня оно приходит только с `kind:"composition"`, а тот
  // отвергается кодом `unsupported_kind` (отступление D6).
  compositionDoc: z.unknown().optional(),
});

export const catalogCandidatesRequestSchema = z.strictObject({
  designSystem: slugString,
  intent: reuseIntentSchema,
  proposed: catalogCandidateProposedSchema.optional(),
  limit: reuseLimitSchema.optional(),
});
export type CatalogCandidatesRequest = z.infer<typeof catalogCandidatesRequestSchema>;

/**
 * GET-форма: частый случай без `proposed`. Существует ради обхода `enforceOrigin`
 * (`server/main.ts:78` — он срабатывает только на unsafe-методах). Лимит длины `intent`
 * назван явно и совпадает с телом: 500 символов.
 */
export const catalogCandidatesQuerySchema = z.strictObject({
  designSystem: slugString,
  intent: reuseIntentSchema,
  limit: z.string().regex(/^([1-9]|1[0-9]|20)$/, "limit must be an integer between 1 and 20").transform(Number).optional(),
});

export const catalogCandidateSchema = z.strictObject({
  kind: z.literal("component"),
  id: z.string(), name: z.string(), designSystem: z.string(),
  /** Версия активной публикации; `0` у head-драфта. */
  version: z.number().int().nonnegative(),
  draft: z.boolean(),
  description: z.string(),
  atomicLevel: z.enum(atomicLevels).optional(),
  scope: z.enum(COMPONENT_SCOPES).optional(),
  canonicalFor: z.array(z.string()),
  replacement: z.string().optional(),
  deprecated: z.boolean(),
  /** Deprecated-кандидат возвращается ради объяснения, но не как цель переиспользования. */
  recommendable: z.boolean(),
  headUsageCount: z.number().int().nonnegative(),
  score: z.number(), blocking: z.boolean(), reasons: z.array(z.string()),
});

const catalogCandidatesResponseSchema = z.strictObject({
  designSystem: z.string(),
  catalogRevision: z.string(),
  /** Версия политики матчинга: без неё score невоспроизводим задним числом (§3.3). */
  policyVersion: z.number().int().nonnegative(),
  candidates: z.array(catalogCandidateSchema),
});

const catalogCandidatesPostResponseSchema = catalogCandidatesResponseSchema.extend({
  /** Present only when POST included source and the server extracted authoritative metadata. */
  overrideTemplate: z.strictObject({
    catalogRevision: z.string(),
    candidateKeys: z.array(z.string()),
  }).optional(),
});

const catalogCandidatesErrors: RouteError[] = [
  { status: 403, code: "forbidden", description: "share/capture principals may not read the catalog index" },
  errorCatalog.notFound,
  errorCatalog.methodNotAllowed,
  errorCatalog.validationFailed,
  { status: 422, code: "unsupported_kind", description: "composition candidates are not supported yet" },
];

const catalogCandidatesSummary = "Compact reuse-candidate search over the requested design system: active publications and head drafts scored by the deterministic matcher. Never returns source or props schemas. `catalogRevision` pins the catalog snapshot the scores were computed on.";

export const catalogCandidatesContract = registerContract({
  method: "POST", path: "/api/catalog/candidates",
  summary: `${catalogCandidatesSummary} POST is the full form and accepts \`proposed\` (including source).`,
  requestSchema: catalogCandidatesRequestSchema,
  responseSchema: catalogCandidatesPostResponseSchema,
  validated: true,
  errors: [
    ...catalogCandidatesErrors,
    errorCatalog.invalidRequest,
    errorCatalog.payloadTooLarge,
    errorCatalog.unsupportedMediaType,
    { status: 422, code: "event_schema_not_serializable", description: "a typed event payload schema in proposed source cannot be serialized" },
  ],
});

export const catalogCandidatesGetContract = registerContract({
  method: "GET", path: "/api/catalog/candidates",
  summary: `${catalogCandidatesSummary} GET covers the frequent intent-only case without an Origin header.`,
  query: catalogCandidatesQuerySchema,
  responseSchema: catalogCandidatesResponseSchema,
  validated: true,
  errors: catalogCandidatesErrors,
});

// --- Админское чтение аудита переиспользования (спека §5, план §4 T10) ---

/** Значения `decision` таблицы `catalog_reuse_decisions` (миграция v20). */
export const reuseDecisionKindSchema = z.enum(["accepted_no_match", "blocked", "would_block", "force_new", "intent_missing"]);

export const reuseAuditQuerySchema = z.strictObject({
  /** ISO-момент; отдаются решения строго новее. Окно наблюдения shadow-фазы (§5.4). */
  since: z.string().min(1).max(64).optional(),
  designSystem: slugString.optional(),
  actorId: z.string().min(1).max(64).optional(),
  /** Потолок каждой секции по отдельности, не всего ответа. */
  limit: z.string().regex(/^([1-9]\d{0,2}|1000)$/, "limit must be an integer between 1 and 1000").transform(Number).optional(),
  /** Сколько попыток по одному actor/artifact считается «повторяющимися» (§5 b). */
  minAttempts: z.string().regex(/^([2-9]|[1-4]\d|50)$/, "minAttempts must be an integer between 2 and 50").transform(Number).optional(),
});

const reuseDecisionCandidateSchema = z.looseObject({
  id: z.string(), score: z.number(), blocking: z.boolean(), reasons: z.array(z.string()),
  propsDelta: z.looseObject({ added: z.array(z.string()).optional(), removed: z.array(z.string()).optional(), typeChanged: z.array(z.string()).optional() }).optional(),
});

const reuseDecisionSchema = z.strictObject({
  id: z.string(), actorId: z.string(),
  artifactKind: z.enum(["component", "composition", "prototype"]),
  artifactId: z.string(), designSystem: z.string(),
  sourceOrDocHash: z.string(), catalogRevision: z.string(),
  policyVersion: z.number().int().nonnegative(),
  gateMode: z.enum(["shadow", "enforce"]),
  intent: z.string().nullable(),
  candidates: z.array(reuseDecisionCandidateSchema),
  decision: reuseDecisionKindSchema,
  reason: z.string().nullable(),
  createdAt: isoDate,
});

export const reuseAuditResponseSchema = z.strictObject({
  generatedAt: isoDate,
  /** Первый записанный гейтом момент: раньше него reuse-review не существовало. */
  gateActiveSince: isoDate.nullable(),
  filter: z.strictObject({
    since: z.string().optional(), designSystem: z.string().optional(), actorId: z.string().optional(),
    limit: z.number().int().positive(), minAttempts: z.number().int().min(2),
  }),
  totals: z.strictObject({
    decisions: z.number().int().nonnegative(),
    actors: z.number().int().nonnegative(),
    byDecision: z.record(z.string(), z.number().int().nonnegative()),
    byGateMode: z.record(z.string(), z.number().int().nonnegative()),
  }),
  /** (a) Админские обходы гейта: каждый обязан быть атрибутируемым. */
  forceNew: z.array(reuseDecisionSchema),
  /** (b) Повторяющиеся блокировки, агрегированные по актору и артефакту. */
  repeatedBlocked: z.array(z.strictObject({
    actorId: z.string(), artifactKind: z.enum(["component", "composition", "prototype"]),
    artifactId: z.string(), designSystem: z.string(),
    attempts: z.number().int().positive(), blocked: z.number().int().nonnegative(), wouldBlock: z.number().int().nonnegative(),
    firstAt: isoDate, lastAt: isoDate,
    lastDecisionId: z.string().nullable(), lastReason: z.string().nullable(),
    candidateIds: z.array(z.string()),
  })),
  /** (c) Конфликты канонической роли: `blocked` с префиксом `canonical_role_conflict:`. */
  canonicalRoleConflicts: z.array(reuseDecisionSchema.extend({ roles: z.array(z.string()) })),
  /** Наблюдаемость shadow-фазы и вход критерия §5.4 выхода из неё. */
  wouldBlock: z.strictObject({
    total: z.number().int().nonnegative(),
    actors: z.number().int().nonnegative(),
    byActor: z.array(z.strictObject({ actorId: z.string(), count: z.number().int().positive() })),
    decisions: z.array(reuseDecisionSchema),
  }),
  /** (d) Артефакты каталога, ни разу не проходившие reuse-review. */
  unreviewed: z.strictObject({
    total: z.number().int().nonnegative(),
    artifacts: z.array(z.strictObject({
      kind: z.enum(["component", "composition", "prototype"]),
      id: z.string(), name: z.string(), designSystem: z.string(), createdAt: isoDate,
      createdBeforeGate: z.boolean(),
    })),
  }),
});

/**
 * Контрактная дельта T10, внесённая терминальной T4′ (план §4). Хендлер
 * (`server/routes/reuseDecisions.ts`) валидирует вход этими же схемами.
 */
export const reuseAuditContract = registerContract({
  method: "GET", path: "/api/catalog/reuse-decisions",
  summary: "Admin-only read model over the append-only reuse-decision audit: force-new overrides, repeated blocked attempts aggregated by actor/artifact, canonical-role conflicts, shadow-phase would-block counters, and catalog artifacts that never went through a reuse review. Read-only: the table is append-only in the database.",
  query: reuseAuditQuerySchema,
  responseSchema: reuseAuditResponseSchema,
  validated: true,
  errors: [
    { status: 401, code: "unauthorized", description: "authentication is required" },
    { status: 403, code: "forbidden", description: "administrator access required; share/capture principals are rejected" },
    errorCatalog.methodNotAllowed,
    errorCatalog.validationFailed,
  ],
});

export const componentPreviewContract = registerContract({
  method: "GET", path: "/api/components/{id}/versions/{version}/preview",
  summary: "Preview data for one published component version: the resolved example props plus bundle coordinates, slots and capabilities. `selector=legacy` uses definition.example, `selector=named&name=` a named example. Never returns source or props schemas.",
  query: z.strictObject({ selector: z.enum(["legacy", "named"]), name: z.string().optional() }),
  responseSchema: z.strictObject({
    componentId: z.string(), name: z.string(), version: positiveInt, designSystem: z.string(),
    bundleUrl: z.string(), bundleHash: z.string(), hostAbiVersion: z.number(),
    props: z.record(z.string(), z.unknown()),
    // slots/capabilities нужны построителю дерева превью для слот-плейсхолдеров.
    slots: z.array(z.string()), capabilities: componentCapabilitiesSchema.optional(),
  }),
  errors: [
    errorCatalog.invalidRequest,
    errorCatalog.notFound,
    { status: 404, code: "bundle_unavailable" },
    { status: 422, code: "unknown_example" },
    { status: 422, code: "example_unavailable" },
  ],
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
  /** Закрытый набор операций `doc.computed` v1 (план 2026-08-02, D12). */
  computedOps: z.array(z.string()),
  limits: z.object({
    elements: z.number(), depth: z.number(), bodyMiB: z.number(), sourceKiB: z.number(),
    assetMiB: z.number(), repeatBudget: z.number(), repeatPerScreen: z.number(), screenshotQueue: z.number(), geometryRects: z.number(),
    flows: z.number(), flowSteps: z.number(), flowTotalSteps: z.number(), flowDepth: z.number(),
    compositionDepth: z.number(),
    // P8: троттлинг и гигиена validate-префлайта (`POST /api/components/{id}/validate`).
    validateUserConcurrent: z.number(), validateGlobalConcurrent: z.number(),
    validateCacheTtlHours: z.number(), validateCacheMiB: z.number(),
    /** `doc.computed` (план 2026-08-02): записей в объекте, полей в `sumProduct`, термов в `add`. */
    computedEntries: z.number(), computedFields: z.number(), computedTerms: z.number(),
    /** Матричная приёмка (план 2026-08-03 §5 W1a): ёмкость рана, TTL кэша случаев, потолок байт evidence. */
    acceptanceMaxCasesPerRun: z.number(), acceptanceMaxJobsPerRun: z.number(),
    acceptanceCaseTtlHours: z.number(), evidenceMaxBytes: z.number(),
    /** `doc.surfaces` (план 2026-08-02 multi-surface-flows, D1): число поверхностей документа (v1 — ровно две). */
    surfaces: z.number(),
  }),
  designSystems: z.array(z.string()),
  resolvedSpaceScales: z.record(z.string(), spaceScaleSchema),
  regions: z.array(z.enum(REGION_KINDS)),
  features: z.object({
    renderStatus: z.boolean(), screenshots: z.boolean(), visualRegression: z.boolean(), assets: z.boolean(),
    typedEvents: z.boolean(), repeat: z.boolean(), namedSlots: z.boolean(), themeVersions: z.boolean(), layoutContract: z.boolean(),
    flows: z.boolean(), screenRegions: z.boolean(), bundleExport: z.boolean(), bundleImport: z.boolean(),
    /** Гейт переиспользования компонентов присутствует в этой сборке (план 2026-07-31 §3.5). */
    componentReuseGate: z.boolean(), compositionV2: z.boolean(), catalogMigration: z.boolean(),
    /** Validate-префлайт head-ревизии (план 2026-08-02 P8); false при EASYUI_VALIDATE_DISABLED=1. */
    componentValidate: z.boolean(),
    /** Geometry-probe компонентной поверхности (план 2026-08-02 P1b): probe=geometry на component-screenshot ручках. */
    componentGeometry: z.boolean(),
    /** Draft-preview сохранённой head-ревизии (план 2026-08-02 P1b); false при EASYUI_VALIDATE_DISABLED=1. */
    componentDraftPreview: z.boolean(),
    /** Head-tracking служебных прототипов (план 2026-08-02 P2): `track` в lifecycle-роуте. */
    prototypeHeadTracking: z.boolean(),
    /** Readiness-отчёт несёт `profile` (product|service) — план 2026-08-02 P9. */
    readinessProfile: z.boolean(),
    /** PATCH темы умеет `dryRun` и no-op-детекцию (план 2026-08-02 P6.1). */
    themeDryRun: z.boolean(),
    /** Sparse-операции темы `addTokens`/`addFonts`/`addIcons` (план 2026-08-02 P6.2). */
    themeSparseOps: z.boolean(),
    /** Новые версии темы пишутся с резолвером spacing-шкалы 2; false при EASYUI_THEME_RESOLVER_V2_DISABLED=1 (P6.3). */
    themeSpacingResolverV2: z.boolean(),
    /** `POST /api/components/:id/promote` — receipt-based promote кандидата (RFC 2026-08-02 R1); false при EASYUI_ACCEPTANCE_DISABLED=1. */
    acceptancePromote: z.boolean(),
    /** Top-level `doc.computed` — производные значения стейта (план 2026-08-02). */
    computed: z.boolean(),
    /** Формат `doc.surfaces`/`screen.surface`/`step.companions` поддержан кодом (план 2026-08-02 multi-surface-flows). */
    surfaces: z.boolean(),
    /** Запись документов с `doc.surfaces` разрешена (kill-switch D16, `EASYUI_SURFACES=1`); иначе `422 surfaces_disabled`. */
    surfacesWrite: z.boolean(),
    /**
     * Матричная приёмка (план 2026-08-03 §5 W1a, `EASYUI_ACCEPTANCE_MATRIX=1`). Три флага —
     * один kill-switch, но разные подсистемы: кандидаты (`POST /api/components/:id/candidates`,
     * `GET /api/component-candidates/:id`), раны (`/api/acceptance-runs*`) и матрица целиком
     * (включая ссылки `candidateId`/`acceptanceRunId` в promote). Все false — ручек нет (404).
     */
    acceptanceMatrix: z.boolean(), acceptanceCandidates: z.boolean(), acceptanceRuns: z.boolean(),
  }),
  /**
   * Фаза гейта переиспользования. Читается агентом **до** `POST /api/components`: в `shadow`
   * запрос без `intent` проходит с предупреждением, в `enforce` — падает `400 invalid_request`.
   * `policyVersion` совпадает с `/api/catalog/candidates` и с записями аудита.
   */
  reuseGate: z.object({
    mode: z.enum(["shadow", "enforce"]),
    intentRequired: z.boolean(),
    policyVersion: z.number().int().nonnegative(),
  }),
});

export const capabilitiesContract = registerContract({
  method: "GET", path: "/api/capabilities",
  summary: "Machine-readable feature discovery: actions, directives, param sources, conditions, limits, design systems.",
  validated: true,
  responseSchema: capabilitiesResponseSchema,
  errors: [errorCatalog.methodNotAllowed],
});
