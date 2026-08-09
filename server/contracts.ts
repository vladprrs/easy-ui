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
import { sourcePackageManifestSchema } from "./figma/sourcePackage";
import { tokenize } from "../src/library/text";
import { reuseOverrideSchema as componentReuseOverrideSchema } from "./catalog/reuseOverride";
import { GEOMETRY_SURFACES } from "../src/acceptance/surfaces";

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

const componentCapabilitiesSchema = z.object({
  typedEvents: z.literal(true).optional(), namedSlots: z.literal(true).optional(),
  /** W9: runtime-дефолты схемы props (флаг объявляется в исходнике, ABI не поднимает). */
  runtimeSchemaDefaults: z.literal(true).optional(),
});
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
  .strictObject({
    version: positiveIntFromString.optional(), rev: positiveIntFromString.optional(),
    /**
     * Диагностический candidate dependency overlay (план 2026-08-07 §W3): повторяемый параметр
     * `candidateOverlay=<componentId>:<candidateId>`. Резолв уезжает в ответ **эхом** и ничего не
     * подменяет: prototype-путь остаётся swap-only (`candidateOverrides`). В `parseQuery` строка
     * приезжает последней из повторов (URLSearchParams-итерация), поэтому сам разбор пар делает
     * роут через `getAll` — здесь ключ объявлен только чтобы strictObject его не отверг.
     */
    candidateOverlay: z.string().optional(),
  })
  .refine((value) => !(value.version !== undefined && value.rev !== undefined), { message: "version and rev are mutually exclusive" });

export const renderStatusResponseSchema = z.looseObject({
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
  summary: "Report whether a prototype screen is renderable (document, bundles, local route). DIAGNOSTIC CANDIDATE OVERLAY (plan 2026-08-07 §W3): the repeatable query parameter `candidateOverlay=<componentId>:<candidateId>` resolves the same map a case-set manifest would declare and ECHOES the resolution back as `candidateOverlay: [{componentId, candidateId, rev, sourceHash, bundleHash}]`. Nothing is stored and nothing is substituted — the durable acceptance surface for a dependency graph is the component case set only, the prototype path stays swap-only (`candidateOverrides` of the screenshot route), and an expired/evicted candidate answers 409 candidate_overlay_expired / candidate_overlay_evicted.",
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
  summary: "List every hard pin retaining an asset, including tombstoned visual references, visual-run roles and the component provenance revisions that reference it as a Figma reference screenshot.",
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
    /** RFC candidate-acceptance §6 (R3a): ссылки из append-only provenance компонентов. */
    provenance: z.array(z.strictObject({ componentId: z.string(), name: z.string(), revs: z.array(z.number().int().positive()) })),
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
  summary: "Enqueue a prototype-screen screenshot job; resolves the target snapshot atomically. CANDIDATE OVERLAY (plan 2026-08-05 §B, `capabilities.features.prototypeCandidateOverlay`): `candidateOverrides: [{candidateId}]` (at most `limits.prototypeCandidateOverlayMax`) substitutes the component pins of the resolved revision with the candidate bundles of those acceptance candidates, so a new revision of an ALREADY PUBLISHED component can be checked inside a composite screen before it is published. It is a pin SWAP, not an insertion: a component with no pin in that revision is 422 candidate_component_not_in_prototype, and a never-published component cannot be overlaid at all (use case-set `slotBindings` for first publishes). An overlay job is delivered as BYTES ONLY — its result is `{kind:\"image-bytes\", width, height, byteLength, pngSha256}` with no assetId and no imageUrl, the PNG is read from GET /api/screenshot-jobs/{jobId}/bytes while the result lives (10 min), nothing is written to the asset registry, no capture receipt is stored and the prototype document is untouched. Unknown and foreign candidates map to ONE identical 404 not_found (no existence oracle); two overrides of the same component are 400 invalid_request; reading the job status and its bytes requires prototype read access AND ownership of every overridden component. The response pins carry `status:\"candidate\"`, `candidate {candidateId, rev, sourceHash}` and the CANDIDATE bundleHash — a pin whose bundleHash still equals the published one means the override did not apply and the client must fail loudly. With the feature off, sending `candidateOverrides` is 404 not_found. RESOURCE BARRIER (plan 2026-08-07 §W2): the optional `readiness: \"barrier\"` runs this job under readiness policy v3 — the page builds a manifest of every resource it declares (CSS background/mask/border images, inline-SVG <image>, <img>), preloads and decodes all of them, awaits document.fonts.ready and two stable frames, then re-diffs the manifest, so a resource that arrives late is reported as `resource_late_after_barrier` instead of silently missing from the frame. Meant for service captures (galleries); the interactive default is unchanged (v1) because the barrier costs up to 8s per frame. With EASYUI_RESOURCE_BARRIER_DISABLED=1 the parameter stays valid and becomes a no-op.",
  status: 202,
  requestSchema: z.object({
    rev: z.number().int().optional(), version: z.number().int().optional(), viewport: viewportSchema,
    deviceScaleFactor: z.number().int().optional(), theme: z.string().optional(), waitForFonts: z.boolean().optional(),
    probe: z.literal("geometry").optional(),
    /** W2: опт-ин детерминированного барьера ресурсов для этой джобы (дефолт пути не меняется). */
    readiness: z.literal("barrier").optional(),
    /** §B1: подмены пинов кандидатами; ≤ `limits.prototypeCandidateOverlayMax`, по одному на компонент. */
    candidateOverrides: z.array(z.strictObject({ candidateId: z.string().min(1) })).optional(),
  }),
  // P2.3: постановка отдаёт разрешённые пины — для track:head-дока это единственный момент,
  // когда клиент узнаёт, какие версии компонентов реально пойдут в кадр.
  // §B2.3: подменённый пин дополнительно несёт `status`/`candidate` — это и есть объявленный
  // сигнал детекции overlay'я (совпал bundleHash с опубликованным ⇒ подмена не применилась).
  responseSchema: jobAcceptedSchema.extend({
    components: z.array(z.object({
      id: z.string(), name: z.string(), version: z.number().int().positive(), bundleHash: z.string(),
      status: z.string().optional(),
      candidate: z.object({ candidateId: z.string(), rev: z.number().int().positive(), sourceHash: z.string() }).optional(),
    })),
  }),
  errors: [
    { status: 400, code: "invalid_request", description: "malformed body, readiness that is not \"barrier\", or candidateOverrides that is not an array / exceeds limits.prototypeCandidateOverlayMax / targets the same component twice" },
    { status: 404, code: "prototype_not_found" }, { status: 404, code: "screen_not_found" },
    { status: 404, code: "version_not_found" }, { status: 404, code: "revision_not_found" },
    { status: 404, code: "not_found", description: "candidate overlay: an unknown OR foreign candidateId (one identical refusal by design), or the feature is disabled" },
    { status: 409, code: "candidate_evicted", description: "the candidate bundle is gone from the cache; re-create the candidate" },
    { status: 409, code: "candidate_stale", description: "the candidate {rev, sourceHash} pair no longer describes that revision" },
    { status: 422, code: "candidate_component_not_in_prototype", description: "the candidate's component has no pin in the resolved revision: an overlay substitutes a published pin and cannot add a component" },
    ...screenshotErrors,
  ],
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
  summary: "Enqueue a draft (saved, unpublished head revision) component screenshot job rendered from the ephemeral validate candidate bundle. DIAGNOSTIC CANDIDATE OVERLAY (plan 2026-08-07 §W3): the optional `candidateOverlay: {\"<componentId>\": \"cand_...\"}` map is resolved and ECHOED back as `candidateOverlay: [{componentId, candidateId, rev, sourceHash, bundleHash}]` — nothing is stored and the frame itself is not substituted (the durable acceptance surface for a dependency graph is the component case set only). Same refusals as the manifest path (422 candidate_overlay_limit/duplicate, 409 candidate_overlay_expired/evicted); requires EASYUI_ACCEPTANCE_MATRIX=1 (404 otherwise) and EASYUI_CANDIDATE_OVERLAY_DISABLED unset (422 candidate_overlay_disabled).",
  status: 202,
  requestSchema: componentScreenshotRequestSchema.and(z.looseObject({
    /** Диагностическая карта overlay (§W3); эхо-резолв в ответе, ничего не персистится. */
    candidateOverlay: z.record(z.string(), z.string()).optional(),
  })),
  responseSchema: jobAcceptedSchema.and(z.looseObject({
    candidateOverlay: z.array(z.looseObject({
      componentId: z.string(), candidateId: z.string(), rev: z.number(),
      sourceHash: z.string(), bundleHash: z.string(),
    })).optional(),
  })),
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
  /**
   * Объявленный рендерер джобы (R1): отпечаток и его входы, замороженные на постановке.
   * Опционален — джобы, снятые до волны (или воркером без манифеста), его не несут.
   */
  renderer: z.object({
    rendererVersion: z.string(), rendererSchema: z.number().int().positive(), fingerprint: z.string(),
    browserName: z.string(), browserVersion: z.string().nullable(), browserRevision: z.string().nullable(),
    launchedExecutable: z.string().nullable(), browserExecutableSha256: z.string().nullable(),
    contextOptionsHash: z.string().nullable(), launchDeterminismArgsHash: z.string(),
    colorProfile: z.literal("srgb"), source: z.enum(["manifest", "fallback"]),
  }).optional(),
  /** Адрес capture-receipt'а кадра (R5): читается ручкой `GET /api/screenshot-jobs/{jobId}/receipt`. */
  receiptSha256: z.string().optional(),
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
  /** Адрес capture-receipt'а измерительной джобы (R5); у неё `output: null` — кадра нет. */
  receiptSha256: z.string().optional(),
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
/**
 * Байтовый исход джобы (план 2026-08-05 §B2.1, v3.1 F1). Кадр НЕ ингестится в реестр ассетов,
 * поэтому ни `assetId`, ни `imageUrl` у него нет: сами байты живут в памяти процесса до
 * истечения RESULT_TTL и читаются ручкой `GET /api/screenshot-jobs/{jobId}/bytes`.
 *
 * В JSON-конверте статуса байтов **нет никогда** — ни у overlay-джобы, ни у candidate-джоб
 * приёмки (их статус раньше отдавал numeric-keyed массив на мегабайты). Вместо них — размер и
 * адрес кадра: `byteLength` и `pngSha256` (тот же sha, что пишет в capture receipt воркер).
 */
const screenshotImageBytesResultSchema = z.object({
  kind: z.literal("image-bytes"),
  width: z.number(), height: z.number(),
  /** Размер PNG в байтах и его sha256 — метаданные вместо самих байтов (санитизация HTTP-границы). */
  byteLength: z.number().int().nonnegative(), pngSha256: z.string(),
  imageProduced: z.boolean(),
  consoleErrors: z.array(z.string()), pageErrors: z.array(z.string()),
  bundleHash: z.string().optional(),
  draftRev: z.number().int().positive().optional(),
  componentPins: z.array(z.object({ id: z.string(), version: z.number(), bundleHash: z.string() })).optional(),
  rendererBuild: z.string().nullable(), browserVersion: z.string(),
  renderer: screenshotImageResultSchema.shape.renderer,
  /** Overlay-джобы receipt'ов не пишут (§B2.6), поэтому у них поля не будет. */
  receiptSha256: z.string().optional(),
});
export const screenshotJobResultSchema = z.union([screenshotImageResultSchema, screenshotImageBytesResultSchema, screenshotGeometryResultSchema]);

/**
 * Типизированные исходы капчура (план 2026-08-03-renderer-contract-2 §3 E3, §5 R3). Словарь один
 * на продукт: те же значения кладут в метрики гейты приёмки и в доказательство readiness.
 */
export const captureFailureCodeSchema = z.enum([
  "font_load_failed", "font_face_missing", "image_load_failed",
  "layout_unstable", "surface_missing", "surface_overflow",
  "renderer_mismatch", "navigation_failed", "runtime_error",
  // Волны 2026-08-07: геометрия по названным поверхностям (W1a/W1b) и барьер ресурсов (W2).
  // Список обязан совпадать с `CAPTURE_FAILURE_CODES` (`src/capture/failureCodes.ts`) — словарь
  // один на продукт, и код, отсутствующий здесь, не прошёл бы валидацию квитанции.
  "surface_mismatch", "dimensions_irreconcilable",
  "resource_barrier_timeout", "resource_decode_failed", "resource_late_after_barrier", "resource_manifest_overflow",
]);
/** Таксономия исхода **джобы** (A3): инфраструктура против терминального `renderer_mismatch`. */
export const jobOutcomeSchema = z.enum(["ok", "worker_crash", "timeout", "queue_full", "subprocess_error", "renderer_mismatch", "surface_missing"]);

/**
 * Capture receipt (план renderer-contract-2 §3 E4, §5 R5) — один документ о происхождении кадра
 * на **оба** канала доставки. Форма — `src/capture/receipt.ts`; ручки «по sha» нет (N12).
 */
const captureCodeSchema = z.object({ code: captureFailureCodeSchema, severity: z.enum(["error", "warning"]), detail: z.string(), ref: z.string().optional() });
export const captureReceiptSchema = z.object({
  receiptVersion: z.literal(1),
  renderer: z.object({
    rendererSchema: z.number().int().positive(), rendererVersion: z.string(),
    os: z.string(), arch: z.string(), nodeVersion: z.string().nullable(), playwrightVersion: z.string().nullable(),
    browserName: z.string(), browserVersion: z.string().nullable(), browserRevision: z.string().nullable(),
    launchedExecutable: z.string().nullable(), browserExecutableSha256: z.string().nullable(),
    fontStackSha256: z.string().nullable(), appFontsSha256: z.string().nullable(), systemLibsHash: z.string().nullable(),
    launchDeterminismArgsHash: z.string(), contextOptionsHash: z.string().nullable(),
    colorProfile: z.literal("srgb"), source: z.enum(["manifest", "fallback"]),
    provenance: z.object({ buildSha: z.string().nullable(), imageRef: z.string().nullable(), builtAt: z.string().nullable(), bunVersion: z.string().nullable() }).nullable(),
    fingerprint: z.string(), observedBrowserVersion: z.string().nullable(), drift: z.array(captureCodeSchema),
  }),
  target: z.object({
    kind: z.enum(["prototype", "component", "component-draft"]),
    componentId: z.string().nullable(), prototypeId: z.string().nullable(),
    version: z.number().int().nullable(), rev: z.number().int().nullable(), sourceHash: z.string().nullable(),
    bundleHash: z.string().nullable(), dsMetaVersion: z.number().int().nullable(), propsHash: z.string().nullable(),
  }),
  resources: z.object({
    fontManifestHash: z.string().nullable(),
    fontFaces: z.array(z.object({
      family: z.string(), weight: z.string(), style: z.string(),
      assetId: z.string().nullable(), sha256: z.string().nullable(), status: z.string(),
      checked: z.boolean().nullable(), required: z.boolean().nullable(),
    })),
    images: z.array(z.object({
      url: z.string(), assetId: z.string().nullable(),
      naturalWidth: z.number().nullable(), naturalHeight: z.number().nullable(),
      decoded: z.boolean().nullable(), contentHash: z.string().nullable(),
    })),
    themeResources: z.object({ tokens: z.array(z.string()), icons: z.array(z.string()), images: z.array(z.string()) }).nullable(),
    /** W2: эхо фазы барьера ресурсов; `null` — политика барьера не требовала либо эхо не приехало. */
    resourceBarrier: z.object({
      expected: z.number().int(), decoded: z.number().int(), fontsReady: z.boolean(),
      stableFrames: z.number().int(), lateAfterBarrier: z.array(z.string()), durationMs: z.number(),
    }).nullable(),
  }),
  console: z.object({
    errors: z.array(z.string()), warnings: z.array(z.string()), pageErrors: z.array(z.string()),
    /** W10: агрегат подавленного инфраструктурного шума (нормализованная сигнатура + счётчик). */
    suppressed: z.array(z.object({ signature: z.string(), count: z.number().int().nonnegative() })),
  }),
  output: z.object({
    viewport: viewportSchema, dpr: z.number(), colorScheme: z.enum(["light", "dark"]),
    pngWidth: z.number(), pngHeight: z.number(), pngSha256: z.string().nullable(),
    surfaceRect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).nullable(),
    paintMargin: z.number().optional(),
  }).nullable(),
  timings: z.object({
    navigateMs: z.number().nullable(), fontsMs: z.number().nullable(), imagesMs: z.number().nullable(),
    networkMs: z.number().nullable(), framesMs: z.number().nullable(), stabilizeMs: z.number().nullable(),
    screenshotMs: z.number().nullable(), totalMs: z.number().nullable(),
    readyMs: z.number().nullable(), readinessMs: z.number().nullable(),
    barrierMs: z.number().nullable(),
  }),
  verdict: z.object({
    captureClean: z.boolean(), codes: z.array(captureCodeSchema),
    readinessMet: z.boolean().nullable(), readinessPolicyHash: z.string().nullable(),
  }),
});

export const screenshotJobReceiptContract = registerContract({
  method: "GET",
  path: "/api/screenshot-jobs/{jobId}/receipt",
  summary: "Read the capture receipt of a screenshot job: declared renderer and its fingerprint, capture target, resource manifest (theme font faces and decoded images), console output, PNG identity (`pngSha256`, surface rect) and the readiness verdict. Job-scoped by design — there is no receipt-by-sha handle (a content-addressed document has no owner). The receipt outlives the job result (10 min) in a dedicated store (7-day TTL, 64 MB LRU cap), so a settled-and-reaped job still answers here; `output` is null for geometry probes, which produce no frame. Absent when receipts are disabled (EASYUI_CAPTURE_RECEIPTS_DISABLED=1) or the receipt has been evicted.",
  responseSchema: z.object({ receiptSha256: z.string(), receipt: captureReceiptSchema }),
  errors: [{ status: 403, code: "forbidden" }, { status: 404, code: "receipt_not_found" }],
});

export const screenshotJobContract = registerContract({
  method: "GET",
  path: "/api/screenshot-jobs/{jobId}",
  summary: "Poll a screenshot job (queued|running|done|error) and read its result. Terminal jobs additionally carry `outcome` (job taxonomy: ok|worker_crash|timeout|queue_full|subprocess_error|renderer_mismatch|surface_missing — only `ok`, `renderer_mismatch` and `surface_missing` are terminal for a client, the rest are infrastructure and may be retried) and, when the cause is typed, `failure` with a `CaptureFailureCode`. The legacy `error` object is unchanged. A bytes-delivery job (acceptance candidate captures and candidate-overlay frames) reports `result {kind:\"image-bytes\", width, height, byteLength, pngSha256, …}`: the JSON envelope NEVER carries the pixels — read them from GET /api/screenshot-jobs/{jobId}/bytes while the result lives (10 min).",
  responseSchema: z.object({
    status: z.enum(["queued", "running", "done", "error"]),
    result: screenshotJobResultSchema.optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
    outcome: jobOutcomeSchema.optional(),
    failure: z.object({ code: captureFailureCodeSchema, message: z.string() }).optional(),
  }),
  errors: [{ status: 404, code: "job_not_found" }],
});

/**
 * Байты кадра байтовой джобы (план 2026-08-05 §B2.1). Контракт бинарный — `contentType` без
 * `responseSchema`, как у `getComponentBundleContract`: тело это PNG, а не JSON.
 */
export const screenshotJobBytesContract = registerContract({
  method: "GET",
  path: "/api/screenshot-jobs/{jobId}/bytes",
  summary: "Download the PNG of a bytes-delivery screenshot job (`result.kind === \"image-bytes\"`): candidate-overlay frames and acceptance candidate captures never enter the asset registry, so this is the ONLY way to read their pixels. The bytes live exactly as long as the job result does (RESULT_TTL, 10 minutes) — there is no store behind this handle and no address-by-sha. 404 not_found when the job produced an asset-delivery image or a geometry probe instead. Authorization repeats the enqueue check: prototype read access for prototype jobs, component ownership for component jobs, AND ownership of every overridden component for candidate-overlay jobs (an unknown or foreign candidate yields one identical 404).",
  contentType: "image/png",
  errors: [
    { status: 403, code: "forbidden" },
    { status: 404, code: "job_not_found" },
    { status: 404, code: "not_found", description: "the job has no image bytes, or the principal may not read one of the overridden candidates" },
  ],
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

/**
 * Происхождение кадра эталона (R6). Носитель истины — эта запись, а не receipt: стор receipt'ов
 * живёт по TTL/LRU, а эталон судится и через год. `null` в поле — «доказательство этого не
 * принесло», и guard читает такой эталон как `unknown`, а не как совпавший.
 */
const guardSideSchema = z.object({
  fingerprint: z.string().nullable(), fontManifestHash: z.string().nullable(),
  readinessPolicyHash: z.string().nullable(), epoch: z.string().nullable(),
});
export const referenceRendererSchema = z.object({
  fingerprint: z.string(), fontManifestHash: z.string().nullable(), readinessPolicyHash: z.string().nullable(),
  epoch: z.string().nullable(), browserVersion: z.string().nullable(), launchedExecutable: z.string().nullable(),
  browserExecutableSha256: z.string().nullable(), source: z.enum(["manifest", "fallback"]).nullable(),
  receiptSha256: z.string().nullable(), recordedAt: z.string(),
});
export const rendererGuardSchema = z.object({
  state: z.enum(["matched", "mismatch", "unknown", "disabled"]),
  differing: z.array(z.string()),
  reference: guardSideSchema, candidate: guardSideSchema,
  flags: z.object({ rendererFlags: z.boolean(), epoch: z.string().nullable() }),
});

/**
 * Четыре сигнала визуального рана (R7a, E6). `edgeResidual.insidePct` — доля остатка, лежащая на
 * контурах самого эталона: `null`, когда остатка нет вовсе (доли у пустого множества не бывает).
 */
const edgeResidualSchema = z.object({
  residualPixels: z.number(), insidePixels: z.number(), outsidePixels: z.number(),
  insidePct: z.number().nullable(),
  edgePixels: z.number(), edgeCoveragePct: z.number(),
  sobelThreshold: z.number(), dilationPx: z.number(),
});
const visualCauseSchema = z.object({
  code: z.string(), confidence: z.number(), detail: z.string(),
  elementKey: z.string().optional(),
  region: z.object({
    bbox: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
    norm: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
    basis: z.enum(["layoutBounds", "canvas"]),
  }).optional(),
});
export const runSignalsSchema = z.object({
  dims: z.enum(["equal", "normalized", "irreconcilable"]),
  exact: metricResultSchema.nullable(),
  perceptual: metricResultSchema.nullable(),
  edgeResidual: edgeResidualSchema.nullable(),
  thresholds: z.object({ passPct: z.number(), edgeInsidePct: z.number() }),
  reason: z.string().optional(),
  causes: z.array(visualCauseSchema).optional(),
});

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
  // R6 (cross-renderer guard): типизированный исход поверх `status` (N7 — новых значений `status`
  // не появилось) и обе evidence-ссылки на receipt'ы сравнивавшихся кадров.
  outcomeCode: z.enum(["renderer_mismatch", "stale_renderer", "dimensions_irreconcilable"]).nullable(),
  rendererGuard: rendererGuardSchema.nullable(),
  candidateReceiptSha256: z.string().nullable(),
  referenceReceiptSha256: z.string().nullable(),
  // R7a (разделение метрик): класс рана и четыре сигнала, из которых он получен. `null` — ран
  // судился доволновой семантикой (`EASYUI_VISUAL_SIGNALS_V2` выключен), и это видимое состояние.
  class: z.enum(["identical", "renderer_residual", "regression", "indeterminate"]).nullable(),
  signals: runSignalsSchema.nullable(),
  warnings: z.array(z.string()),
});

export const referencePublicSchema = z.object({
  id: z.string(), fingerprint: z.unknown(), note: z.string().nullable(), createdAt: z.string(),
  asset: assetPublicSchema.extend({ url: z.string() }).nullable(),
  lastRun: runReportSchema.nullable(),
  renderer: referenceRendererSchema.nullable(),
});

export const putVisualReferenceContract = registerContract({
  method: "PUT",
  path: "/api/visual-references",
  summary: "Upsert a visual reference by canonical fingerprint (asset must exist and be a PNG).",
  requestSchema: z.object({ fingerprint: fingerprintContractSchema, assetId: z.string(), note: z.string().optional(), receiptSha256: z.string().optional() }),
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
/** Kill-switch BR-09 (план 2026-08-08 §9): запись `elements[].overflowOwnership` требует снятого `EASYUI_GEOMETRY_OWNERSHIP_DISABLED`. */
const flowOverflowOwnershipDisabledError = { status: 422, code: "flow_overflow_ownership_disabled", description: "The document declares elements[].overflowOwnership, but FlowRoot overflow ownership is disabled on this server (EASYUI_GEOMETRY_OWNERSHIP_DISABLED=1). Discovery: capabilities.features.flowOverflowOwnershipV1." } as const;
const surfacesDisabledError = { status: 422, code: "surfaces_disabled", description: "The document declares doc.surfaces, but multi-surface writes are disabled on this server (EASYUI_SURFACES=1 enables them). Discovery: capabilities.features.surfacesWrite." } as const;
/** Kill-switch D9 (план 2026-08-03 W8a): запись композиций `version:3` требует EASYUI_COMPOSITION_V3=1. */
const compositionV3DisabledError = { status: 422, code: "composition_v3_disabled", description: "The composition document declares version 3, but v3 writes are disabled on this server (EASYUI_COMPOSITION_V3=1 enables them). Reading and expanding stored v3 documents always works. Discovery: capabilities.features.compositionV3." } as const;
/** W3 (multi-surface §4): композиции допустимы только на экранах ДС документа; per-screen резолв — v2. */
const compositionForeignDesignSystemError = { status: 422, code: "composition_foreign_design_system", description: "A composition is placed on a screen whose surface uses a design system other than doc.designSystem; compositions are single-design-system in v1." } as const;
/** W3 (multi-surface §4): формат бандла скалярен по ДС, мульти-поверхностный документ не экспортируется. */
const surfacesNotExportableError = { status: 422, code: "surfaces_not_exportable", description: "The prototype declares doc.surfaces; the v1 bundle manifest cannot carry multi-surface documents (multi-design-system manifest is v2)." } as const;

const baselineViewportSchema=z.strictObject({width:z.number().int(),height:z.number().int()});
const baselineMemberSchema=z.strictObject({screenId:z.string(),viewport:baselineViewportSchema,deviceScaleFactor:deviceScaleSchema,theme:z.enum(["light","dark"]),referenceId:z.string()});
const baselineResponseCore=z.strictObject({generation:z.number().int().positive(),rev:z.number().int().positive(),members:z.array(baselineMemberSchema)});
export const putVisualBaselineContract=registerContract({
  method:"PUT",path:"/api/visual-baselines/prototypes/{id}",summary:"Atomically replace the complete committed visual baseline set for a prototype (generation CAS).",
  requestSchema:z.strictObject({rev:z.number().int().positive(),prototypeInstanceId:z.string(),baseGeneration:z.number().int().positive().nullable(),members:z.array(z.strictObject({screenId:z.string(),viewport:baselineViewportSchema,deviceScaleFactor:deviceScaleSchema,theme:z.enum(["light","dark"]),assetId:z.string()})),receipts:z.record(z.string(),z.string()).optional()}),
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

export const getVisualRunBundleContract = registerContract({
  method: "GET",
  path: "/api/visual-runs/{runId}/bundle.zip",
  summary: "Download the diagnostic bundle of a terminal visual run (ZIP): reference.png, candidate.png, diff-perceptual.png (the diff asset the run produced — never re-rendered), diff-exact.png and edge-mask.png (recomputed on request from both frames with the same pure helpers the run was judged with), reference-receipt.json, candidate-receipt.json, report.json (bundleVersion, the full run report, receipt presence and a per-file note with sha256 and provenance) and SHA256SUMS over every file in the archive. Missing pieces are never invented: an evicted receipt, a reclaimed frame or irreconcilable dimensions come back as an absent file plus a reason in report.json. Entries use a fixed mtime so the same run yields the same archive. Same read authorization as the run report; 409 bundle_not_ready while the run is still running.",
  contentType: "application/zip",
  errors: [
    { status: 404, code: "run_not_found" },
    { status: 409, code: "bundle_not_ready", description: "the run has not terminalized yet" },
    { status: 413, code: "evidence_too_large", description: "raw run evidence exceeds limits.evidenceMaxBytes" },
  ],
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
  summary: "List prototypes with head revision and latest published version; optional CSV lifecycle-kind filter. `scope=all` (admin only) lists every prototype, including other users' private/archived ones and prototypes without an owner.",
  query: z.object({ kind: z.string().optional(), scope: z.literal("all").optional() }),
  responseSchema: z.array(prototypeListItemSchema),
  errors: [errorCatalog.invalidRequest, { status: 403, code: "admin_required", description: "scope=all is admin-only" }, errorCatalog.validationFailed, errorCatalog.methodNotAllowed],
});

export const createPrototypeContract = registerContract({
  method: "POST", path: "/api/prototypes",
  summary: "Create a prototype from a document (revision 1); validates against the design-system catalog.",
  status: 201,
  requestSchema: z.object({ doc: inputPrototypeDocSchema, message: z.string().optional(), figma: figmaSchema.optional(), ...prototypeLifecycleSchema.omit({ track: true }).shape }),
  responseSchema: z.looseObject({ id: z.string(), rev: z.literal(1), warnings: z.array(issueSchema), screens: z.array(screenUrlSchema) }),
  errors: [errorCatalog.invalidRequest, errorCatalog.alreadyExists, errorCatalog.validationFailed, { status: 422, code: "asset_not_found" }, surfacesDisabledError, flowOverflowOwnershipDisabledError, compositionForeignDesignSystemError],
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
  errors: [errorCatalog.invalidRequest, errorCatalog.baseRevRequired, errorCatalog.prototypeNotFound, errorCatalog.revConflict, errorCatalog.validationFailed, surfacesDisabledError, flowOverflowOwnershipDisabledError, compositionForeignDesignSystemError],
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

// --- Импакт-план галерейной съёмки (план 2026-08-07 §W5, миграция v34) ---
const snapPlanScreenSchema = z.strictObject({
  screenId: z.string(),
  action: z.enum(["capture", "reuse"]),
  reason: z.enum(["proven-reuse", "new", "unprovable", "renderer", "theme", "impacted"]),
  screenFrameFingerprint: z.string(),
  unprovable: z.string().optional(),
  reuseReceipt: z.strictObject({
    screenId: z.string(), screenFrameFingerprint: z.string(),
    previousRev: positiveInt, previousPngSha256: z.string(), provenAt: isoDate,
  }).optional(),
});

export const snapPlanContract = registerContract({
  method: "POST", path: "/api/prototypes/{id}/snap-plan",
  summary: "Plan an impact-driven gallery re-capture (plan 2026-08-07 §W5, `capabilities.features.impactedSnap`): for every screen of the resolved revision the server answers `capture` or `reuse` and NAMES the reason. Read-only — it enqueues nothing and writes nothing. The proof is `screenFrameFingerprint` = sha256 of the tuple that decides the pixels of ONE screen: the prototype handshake tuple (`prototypeInstanceId`, `screenId`, `componentManifestHash` OF THE SCREEN'S PIN SUBSET, `builtinCatalogHash`, the design system OF THE SCREEN'S SURFACE and its pinned theme version — `rev` is deliberately NOT hashed, it is provenance: adding one screen is a new revision, and hashing `rev` would make every other screen unprovable exactly when the feature is supposed to prove them), `screenSpecHash` (the screen plus the document-level render inputs `state`/`computed`/`device`/`designSystem`/`surfaces` — navigation and naming are excluded so that ADDING a screen costs exactly one capture), `viewport`/`deviceScaleFactor`/`theme`, `readinessPolicyHash`, `rendererFingerprint`, and the RESOLVED theme meta version of that screen's design system plus its spacing-resolver version (there is no separate theme content hash: design-system versions are immutable and append-only, so an unpinned theme resolves to the head version and a new theme version honestly moves every screen of that system). A frame is reused only when a frame with the SAME fingerprint was already captured for this prototype (`reuseReceipt` carries `previousRev`, `previousPngSha256`, `provenAt`); anything else is a capture whose `reason` is `new` (no frame of this screen at all), `renderer` (the renderer fingerprint moved — the readiness policy is part of it), `theme` (theme version, pin, spacing resolver or builtin catalog hash moved), `unprovable` or `impacted`. UNPROVABLE MEANS CAPTURE: a screen holding an element whose resolved tree does not expand completely — a composition whose body is not resolvable at that revision, a type with no component pin, nesting deeper than the expansion limit — is ALWAYS captured, and `unprovable` says which element. `readiness: \"barrier\"` plans against the same readiness policy the barrier opt-in of the screenshot route uses; `screens[]` limits the plan to a subset (at most `limits.snapPlanMaxScreens`). Frames are recorded by the ordinary gallery capture path (asset-delivered prototype screenshots without a probe and without a candidate overlay) and retained for the last 5 revisions per prototype. The fingerprint is a REUSE key only: it enters no acceptance fingerprint and no verdict. With EASYUI_IMPACTED_SNAP_DISABLED=1 the route answers 404 and no frames are recorded.",
  requestSchema: z.object({
    rev: z.number().int().optional(), version: z.number().int().optional(),
    viewport: viewportSchema, deviceScaleFactor: z.number().int().optional(),
    theme: z.enum(["light", "dark"]).optional(),
    readiness: z.literal("barrier").optional(),
    screens: z.array(z.string().min(1)).optional(),
  }),
  responseSchema: z.strictObject({
    prototypeId: z.string(), rev: positiveInt,
    viewport: viewportSchema, deviceScaleFactor: z.number().int(), theme: z.enum(["light", "dark"]),
    screens: z.array(snapPlanScreenSchema),
    summary: z.strictObject({ total: z.number().int(), capture: z.number().int(), reuse: z.number().int() }),
  }),
  errors: [
    errorCatalog.invalidRequest,
    { status: 403, code: "forbidden" },
    errorCatalog.prototypeNotFound, errorCatalog.revisionNotFound,
    { status: 404, code: "version_not_found" },
    { status: 404, code: "screen_not_found", description: "a screen id in `screens[]` does not exist in the resolved revision" },
    { status: 404, code: "not_found", description: "impacted snap planning is disabled (EASYUI_IMPACTED_SNAP_DISABLED=1)" },
    { status: 422, code: "invalid_viewport" },
    { status: 422, code: "snap_plan_too_many_screens", description: "more than limits.snapPlanMaxScreens screens were requested" },
  ],
});

// --- Сага миграционного коммита (план 2026-08-07 §1.3/§W4, миграция v35) ---

const MIGRATION_COMMIT_PHASE_IDS = ["preflight", "promote", "gallery-save", "verify", "impacted-regression", "audit"] as const;
const migrationCommitStateSchema = z.enum([
  ...MIGRATION_COMMIT_PHASE_IDS,
  ...MIGRATION_COMMIT_PHASE_IDS.map((phase) => `needs-${phase}` as const),
  "complete", "cancelled",
]);

const migrationCommitGallerySchema = z.object({
  prototypeId: z.string().min(1),
  baseRev: positiveInt.optional(),
  /** Экран или массив экранов галереи; вставка по `id`, существующий с тем же id заменяется. */
  screenFragment: z.unknown().optional(),
  message: z.string().optional(),
  viewport: viewportSchema.optional(),
  deviceScaleFactor: z.number().int().optional(),
  theme: z.enum(["light", "dark"]).optional(),
  readiness: z.literal("barrier").optional(),
});

const migrationCommitRequestSchema = z.object({
  idempotencyKey: z.string().min(1).max(200),
  componentId: z.string().min(1),
  baseRev: positiveInt,
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
  candidateId: z.string().optional(),
  acceptanceRunIds: z.array(z.string()).min(1).optional(),
  expectedCases: positiveInt.optional(),
  supersede: z.enum(["auto", "none"]).optional(),
  message: z.string().optional(),
  gallery: migrationCommitGallerySchema.optional(),
  auditDesignSystem: z.string().optional(),
  dryRun: z.boolean().optional(),
});

const migrationCommitPhaseEntrySchema = z.strictObject({
  phase: z.enum(MIGRATION_COMMIT_PHASE_IDS),
  startedAt: isoDate,
  endedAt: isoDate.nullable(),
  status: z.enum(["done", "failed", "timeout", "skipped"]),
  idempotentReplay: z.boolean().optional(),
  detail: z.unknown().optional(),
  error: z.strictObject({ code: z.string(), message: z.string() }).optional(),
});

export const migrationCommitReceiptSchema = z.object({
  commitId: z.string(),
  componentId: z.string(),
  designSystem: z.string(),
  candidateId: z.string().nullable(),
  galleryPrototypeId: z.string().nullable(),
  phase: migrationCommitStateSchema,
  phasesDone: z.array(z.enum(MIGRATION_COMMIT_PHASE_IDS)),
  regressionMode: z.enum(["impacted", "full"]),
  createdAt: isoDate,
  updatedAt: isoDate,
  phaseStartedAt: isoDate,
  request: z.unknown(),
  phases: z.array(migrationCommitPhaseEntrySchema),
  result: z.unknown(),
  error: z.strictObject({ code: z.string(), message: z.string() }).optional(),
  /** true — повтор запроса с тем же `idempotencyKey`: строка возвращена как есть, ничего не двигалось. */
  idempotentReplay: z.boolean().optional(),
});

const migrationCommitErrors = [
  errorCatalog.invalidRequest,
  { status: 403, code: "forbidden" },
  { status: 404, code: "not_found", description: "no such commit, or the saga is disabled (EASYUI_ACCEPTANCE_MATRIX unset / EASYUI_MIGRATION_COMMIT_DISABLED=1)" },
  { status: 409, code: "migration_commit_in_flight", description: "another commit of the SAME component is in an active phase; `needs-*` states never block" },
] as const;

export const createMigrationCommitContract = registerContract({
  method: "POST", path: "/api/migration-commits",
  summary: "Start (or replay) the migration commit saga for one component (plan 2026-08-07 §1.3/§W4, `capabilities.features.migrationCommit`, migration v35). The saga is DURABLE SERVER STATE and the driver is a poller over it: phases run `preflight → promote → gallery-save → verify → impacted-regression → audit → complete`, and the request drives them until the saga completes or a phase fails. A FAILED PHASE IS NOT AN HTTP ERROR: the saga moves to `needs-<phase>` and the response still carries the receipt, because the caller needs to read WHERE it stopped. There are NO compensations — promote is irreversible by construction, so a later failure never un-publishes it; `needs-*` waits for a human and resumes from the same phase via `advance`. Idempotency is `(componentId, idempotencyKey)` and the key is REQUIRED: repeating it returns the existing saga untouched with `idempotentReplay: true` (200, not 201). A second commit of the same component is refused `409 migration_commit_in_flight` ONLY while a phase is active — `needs-*` states deliberately do not block, so a stuck saga never holds the component hostage; commits of OTHER components are never blocked (the lock is per-component). `dryRun: true` writes NOTHING: it runs the read-only preflight for real and returns the phase list, the mutations the saga would make and a snap-plan preview. Phases orchestrate the EXISTING mutations (`promote`, prototype save, snap-plan, catalog audit) and change none of them. HONEST BOUNDARY: the server closes the server-side tail only — the coordinator's own control documents (WORKFLOW_STATE.md, BUILD_ORDER.md) are never written by the server, the driver still records one receipt of its own. A phase that outlives `limits.migrationCommitPhaseTimeoutMs` is swept into `needs-<phase>` on process start and on every request to this route set (the server runs no periodic timers).",
  requestSchema: migrationCommitRequestSchema,
  responseSchema: migrationCommitReceiptSchema,
  status: 201,
  errors: [...migrationCommitErrors, errorCatalog.validationFailed, errorCatalog.revConflict,
    { status: 409, code: "rev_mismatch", description: "component or gallery head moved away from the declared baseRev" },
    { status: 422, code: "invalid_viewport" },
  ],
});

export const getMigrationCommitContract = registerContract({
  method: "GET", path: "/api/migration-commits/{commitId}",
  summary: "Status and receipt of one migration commit saga: current `phase`, `phasesDone`, `regressionMode` (`impacted` when the W5 snap plan proved which screens can be reused, `full` when planning was unavailable and every screen must be treated as impacted), the per-phase journal and the accumulated per-phase results. Polling this route also runs the stale-phase watchdog.",
  responseSchema: migrationCommitReceiptSchema,
  errors: [...migrationCommitErrors],
});

export const advanceMigrationCommitContract = registerContract({
  method: "POST", path: "/api/migration-commits/{commitId}/advance",
  summary: "Resume a saga that sits in `needs-<phase>`: the stored request is replayed from that phase onwards. Phases already recorded in the receipt are NOT re-executed — a replayed `promote` would mint a second version, so it returns `idempotentReplay: true` instead. Only `needs-*` states are resumable: an active phase answers `409 migration_commit_in_flight`, `complete`/`cancelled` answer `409 migration_commit_not_resumable`.",
  responseSchema: migrationCommitReceiptSchema,
  errors: [...migrationCommitErrors, { status: 409, code: "migration_commit_not_resumable", description: "the saga is complete or cancelled" }],
});

export const cancelMigrationCommitContract = registerContract({
  method: "POST", path: "/api/migration-commits/{commitId}/cancel",
  summary: "Terminal exit from ANY `needs-*` state into `cancelled`. Nothing is rolled back — the phases that already ran stay done (a promoted version stays published); cancelling only says that nobody will resume this saga. An active phase answers `409 migration_commit_in_flight`; `complete` answers `409 migration_commit_not_cancellable`; cancelling an already cancelled saga is a no-op.",
  requestSchema: z.object({ reason: z.string().optional() }),
  responseSchema: migrationCommitReceiptSchema,
  errors: [...migrationCommitErrors, { status: 409, code: "migration_commit_not_cancellable", description: "the saga is complete" }],
});

// --- Figma Source Package (план 2026-08-07 §W8, миграция v36) ---

const sourcePackageErrors = [
  errorCatalog.invalidRequest,
  { status: 403, code: "forbidden" },
  { status: 404, code: "source_package_not_found", description: "no such package" },
  { status: 404, code: "not_found", description: "source packages are disabled (EASYUI_SOURCE_PACKAGE_DISABLED=1)" },
] as const;

const sourcePackageResponseSchema = z.strictObject({
  packageId: z.string(),
  designSystem: z.string(),
  fileKey: z.string(),
  sourceRevision: z.string(),
  exportCount: z.number().int().nonnegative(),
  createdBy: z.string(),
  createdAt: isoDate,
  manifest: sourcePackageManifestSchema,
  /** true — повторная загрузка того же манифеста: строка возвращена как есть, ничего не писалось. */
  deduplicated: z.boolean().optional(),
});

export const uploadSourcePackageContract = registerContract({
  method: "POST", path: "/api/figma-source-packages",
  summary: "Upload one Figma source package (plan 2026-08-07 §W8, `capabilities.features.figmaSourcePackage`, migration v36): the unit of transfer between Figma and easy-ui. The package carries PROVENANCE, not bytes — `nodes[]` (nodeId, componentKey, semantic role), `exports[]` pointing at ALREADY UPLOADED registry assets (`POST /api/assets`) with their declared `width`/`height`/`sha256`, plus `instanceProperties`/`textRuns`/`effects`/`usageContexts` and the explicit `missing[]`/`anomalies[]` records. The package id is CONTENT-ADDRESSED (`fsp_<sha256(manifest)>`), so re-uploading the same manifest is idempotent: it answers 200 with `deduplicated: true` and writes nothing (a new package answers 201). Declared dimensions and sha256 are verified AGAINST THE ASSET REGISTRY (`422 source_package_export_dimension_mismatch` / `source_package_export_sha_mismatch`) — a package cannot claim a size its bytes do not have. Provenance consistency is enforced too: every nodeId mentioned by an export, a missing record or an anomaly must be declared in `nodes[]` (`422 source_package_node_not_declared`), a nodeId may appear once (`422 source_package_duplicate_node`) and a componentKey may identify one node (`422 source_package_duplicate_component_key`). At most `limits.sourcePackageMaxExports` exports. Changing `sourceRevision` produces a DIFFERENT package with different assets: dependent cases move through their own `referenceAssetId` (the `comparison` fingerprint layer) — no re-capture, and the package itself enters NO fingerprint.",
  requestSchema: z.strictObject({ manifest: sourcePackageManifestSchema }),
  responseSchema: sourcePackageResponseSchema,
  status: 201,
  errors: [...sourcePackageErrors, errorCatalog.validationFailed,
    { status: 422, code: "asset_not_found", description: "an export references an asset that is not in the registry" },
    { status: 422, code: "source_package_export_sha_mismatch" },
    { status: 422, code: "source_package_export_dimension_mismatch" },
    { status: 422, code: "source_package_duplicate_node" },
    { status: 422, code: "source_package_duplicate_component_key" },
    { status: 422, code: "source_package_node_not_declared" },
    { status: 422, code: "source_package_component_key_not_declared" },
  ],
});

export const listSourcePackagesContract = registerContract({
  method: "GET", path: "/api/figma-source-packages",
  summary: "List the source packages of one design system (newest first), optionally narrowed by `fileKey`. Manifests are NOT included — the list answers \"which packages exist\", and 256 exports per row would turn that into megabytes; read one package for its manifest.",
  query: z.strictObject({ designSystem: z.string(), fileKey: z.string().optional(), limit: z.string().optional() }),
  responseSchema: z.strictObject({
    designSystem: z.string(),
    packages: z.array(sourcePackageResponseSchema.omit({ manifest: true, deduplicated: true })),
  }),
  errors: [...sourcePackageErrors],
});

export const getSourcePackageContract = registerContract({
  method: "GET", path: "/api/figma-source-packages/{packageId}",
  summary: "One source package with its full manifest. Reference it from an artifact through `figma.sourcePackageId` — a METADATA-ONLY link that enters no acceptance fingerprint (frame, comparison, verdict or candidate id): it says where the artifact came from, and feeds the `missing_exact_reference` publish-preflight warning plus the component-key/semantic-role ranking signals of the reuse search. Pixels keep moving through `referenceAssetId` alone.",
  responseSchema: sourcePackageResponseSchema,
  errors: [...sourcePackageErrors],
});

export const skeletonRequestSchema = z.strictObject({
  componentId: z.string().min(1).max(64),
  viewport: z.strictObject({ width: z.number().int().positive().max(8192), height: z.number().int().positive().max(8192) }).optional(),
  deviceScaleFactor: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  theme: z.enum(["light", "dark"]).optional(),
  nodeIds: z.array(z.string().min(1).max(64)).min(1).max(256).optional(),
});

export const sourcePackageSkeletonContract = registerContract({
  method: "POST", path: "/api/figma-source-packages/{packageId}/case-set-skeleton",
  summary: "Draft a case-set manifest from the package — a DRAFT, nothing is saved (`saved: false`). One case per export: `referenceAssetId` is the exported asset and `expectedSurfaces.referenceExport` its dimensions converted from the declared export scale to CSS px. `props` are left empty and `expectedGeometry` is NOT invented — the package only knows its own exports. The result is guaranteed to parse as a case-set manifest, so the author fills in props and PUTs it to `/api/components/{id}/case-sets`. `nodeIds[]` narrows the skeleton to a subset of the package.",
  requestSchema: skeletonRequestSchema,
  responseSchema: z.strictObject({
    packageId: z.string(), componentId: z.string(), manifest: z.unknown(), saved: z.literal(false),
  }),
  errors: [...sourcePackageErrors, errorCatalog.validationFailed,
    { status: 422, code: "source_package_no_exports", description: "the package carries no export for the requested nodes" },
  ],
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

/**
 * RFC candidate-acceptance-pipeline §6 (волна R3a): provenance отвязана от runtime-версий.
 * Правка ссылки на Figma больше не требует ни новой ревизии, ни metadata-only версии — она
 * добавляет seq-строку в append-only `component_provenance`, а чтение резолвится cross-revision.
 */
export const putComponentProvenanceContract = registerContract({
  method: "PUT", path: "/api/components/{id}/provenance",
  summary: "Update the Figma provenance of a revision WITHOUT creating a revision or a version: appends a seq row to the append-only component_provenance history of `rev` (head by default). `figma: null` writes an explicit tombstone (clears provenance) instead of deleting rows; an unchanged value is deduplicated and answers {unchanged:true, seq:null}. Reads resolve cross-revision (the latest (rev,seq) row among revisions <= rev, otherwise the revision column), so a later source PUT inherits the provenance. The provenance of a PUBLISHED version is deliberately mutable through this handle — only the byte part of a version (compiled_js/bundle_hash/definition_meta) is immutable. Owner or admin only; share/capture principals are always 403.",
  requestSchema: z.strictObject({ rev: positiveInt.optional(), figma: figmaSchema.nullable() }),
  responseSchema: z.looseObject({ rev: z.number(), seq: z.number().nullable(), unchanged: z.boolean(), figma: figmaResponseSchema }),
  errors: [errorCatalog.invalidRequest, errorCatalog.notFound, errorCatalog.methodNotAllowed, errorCatalog.validationFailed, { status: 403, code: "forbidden", description: "only the component owner or an admin may edit provenance" }, { status: 422, code: "asset_not_found" }],
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
    z.looseObject({ code: z.enum(["revision_conflict", "already_published", "source_hash_mismatch", "candidate_unavailable", "acceptance_run_in_flight", "candidate_rejected", "candidate_already_promoted"]), message: z.string() }),
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
  summary: "Promote the validated head revision to a public version in one call: reruns the catalog-time publish checks (host primitive name, canonical role, atomic policy, asset refs), stages the candidate artifacts WITHOUT re-running typecheck/compile, import-verifies, then activates, pins assets, records validation and auto-supersedes the other active versions in one short transaction. `sourceHash` must match the head source; `expectedCatalogRevision` is an opt-in catalog CAS; `supersede: \"none\"` leaves parallel active versions alone. Disabled via EASYUI_ACCEPTANCE_DISABLED=1 (404). Optional `candidateId`/`acceptanceRunId` (EASYUI_ACCEPTANCE_MATRIX=1 only, 422 acceptance_matrix_disabled otherwise) bind the promotion to a durable acceptance candidate and its terminal run: the candidate must describe exactly {baseRev, sourceHash} (409 revision_conflict), must not hold a queued/running run (409 acceptance_run_in_flight), and the run must belong to that candidate (422 acceptance_run_mismatch), must have been executed under a promotion policy profile (`capabilities.acceptance.promotionPolicyProfiles`, otherwise 422 acceptance_policy_mismatch with `{runPolicyProfileId, allowed}`) and must carry a pass/pass_with_exceptions verdict (422 acceptance_run_not_passed). The candidate's own `policyProfileHash` is an informational stamp and is NOT compared with the run: candidate identity excludes policy, so requiring equality made every pixel-strict-v1 run unpromotable (defect P0-2, fixed 2026-08-04; EASYUI_PROMOTE_POLICY_STRICT=1 restores the old equality as an emergency rollback). A run whose `policy_profile_hash` no longer matches the current definition of its profile is accepted with a warning and both hashes reported in `acceptancePolicy` and in the audit event. Both ids are then written onto the published version as flat receipts and the candidate becomes `promoted`. MULTI-RUN (W7, `capabilities.features.acceptanceMultiRunPromote`): a family that does not fit one run is promoted with `acceptanceRunIds` (1..8, mutually exclusive with `acceptanceRunId` — sending both is 400). Every run must belong to the same candidate, be a terminal pass under the SAME promotion policy profile (otherwise 422 acceptance_policy_mismatch) and carry the same `renderer_fingerprint` (422 acceptance_renderer_mismatch; runs predating schema v30 have none and are skipped with a warning). Coverage must be PAIRWISE DISJOINT by (propsHash, slotsHash, surface) — the surface is the case-set `capture` (viewport/dsf/theme), so sharding light/dark legitimately repeats props and even case ids, and since migration v31 two cases with equal props but different `slotBindings` are two distinct frames instead of one; an intersection is 422 acceptance_coverage_overlap, while a repeated caseKey across shards is only a warning. Optional `expectedCases` compares the union coverage (distinct (propsHash, slotsHash, surface) frames, so aliases count once) and answers 422 acceptance_coverage_incomplete on a mismatch. The stored array is sorted by (created_at, run_id) regardless of argument order and `acceptanceRunId` is its FIRST element; the response carries `acceptanceRunIds` and `evidenceManifestHashes` of the whole set. CANDIDATE DEPENDENCY OVERLAY (plan 2026-08-07 §W3): if the backing runs were captured against unpublished dependencies (`candidateOverlay` of their case set), every node of that graph must be published NOW with the same bundleHash/sourceHash (409 overlay_dependency_not_published / overlay_dependency_diverged), and all runs of a multi-run promote must declare the SAME graph (422 overlay_hash_mismatch) — a leaf published from a different build makes the parent's green verdict describe pixels nobody can rebuild. The successful check is reported as a warning naming the version each dependency landed on.",
  status: 201,
  requestSchema: z.strictObject({
    ...casBody,
    sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
    expectedCatalogRevision: z.string().optional(),
    supersede: z.enum(["auto", "none"]).optional(),
    reuseOverride: componentReuseOverrideSchema.optional(),
    /** A9 (W1c): ссылки на durable-приёмку; требуют EASYUI_ACCEPTANCE_MATRIX=1. */
    candidateId: z.string().optional(),
    acceptanceRunId: z.string().optional(),
    /**
     * W7 (D-D): набор ранов шардированной семьи, 1..8, **взаимоисключим** с `acceptanceRunId`
     * (оба сразу — `400 invalid_request`). Порядок аргументов на хранение не влияет: сервер
     * сортирует набор по `(created_at, run_id)`.
     */
    acceptanceRunIds: z.array(z.string()).min(1).max(8).optional(),
    /** Опциональная сверка суммарного покрытия набора (`422 acceptance_coverage_incomplete`). */
    expectedCases: z.number().int().positive().optional(),
  }),
  responseSchema: z.looseObject({
    version: z.number(), rev: z.number(), hostAbiVersion: z.number(),
    sourceHash: z.string(), bundleHash: z.string(),
    themeVersion: z.number().nullable(), catalogRevision: z.string(),
    superseded: z.array(z.number()), cached: z.boolean(), warnings: z.array(z.string()),
    candidateId: z.string().nullable(), acceptanceRunId: z.string().nullable(),
    /**
     * W7: весь набор ранов версии, отсортированный `(created_at, run_id)`; `[]` — promote без
     * матричной приёмки. `acceptanceRunId` — **первый элемент** этого массива (контракт C7).
     */
    acceptanceRunIds: z.array(z.string()),
    /** Манифест-хэши evidence ранов набора (раны без evidence пропущены). */
    evidenceManifestHashes: z.array(z.string()),
    /**
     * Provenance политики публикации (план 2026-08-04 W3, C18): профиль рана и оба хэша его
     * определения — на момент рана и текущий. `stale: true` — профиль правили после рана; это
     * не отказ, а warning + запись обоих хэшей сюда и в аудит-событие `component.promoted`.
     */
    acceptancePolicy: z.looseObject({
      profileId: z.string(), runPolicyProfileHash: z.string(),
      currentPolicyProfileHash: z.string().nullable(), stale: z.boolean(),
    }).nullable(),
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
    { status: 409, code: "acceptance_run_in_flight", description: "the referenced candidate still has a queued/running acceptance run" },
    { status: 409, code: "candidate_rejected", description: "a human rejected a candidate of this very revision; promote a new revision instead" },
    { status: 409, code: "candidate_already_promoted", description: "promote-saga CAS: the referenced candidate is already promoted to another version (phase-B markPromoted conflict)" },
    { status: 422, code: "acceptance_matrix_disabled", description: "candidateId/acceptanceRunId were sent while EASYUI_ACCEPTANCE_MATRIX is off" },
    { status: 422, code: "acceptance_run_mismatch", description: "the acceptance run belongs to another candidate (with EASYUI_PROMOTE_POLICY_STRICT=1 also: its policy profile hash differs from the candidate stamp)" },
    { status: 422, code: "acceptance_policy_mismatch", description: "the acceptance run ran under a policy profile that may not back a promotion; details carry {runPolicyProfileId, allowed}" },
    { status: 422, code: "acceptance_run_not_passed", description: "the acceptance run is not a terminal pass/pass_with_exceptions" },
    { status: 422, code: "acceptance_renderer_mismatch", description: "W7: the runs of a multi-run promote were captured by different renderers; details carry {runIds, rendererFingerprints}" },
    { status: 422, code: "acceptance_coverage_overlap", description: "W7: two runs of a multi-run promote cover the same (propsHash, slotsHash, surface) frame; details carry {runIds, overlap, overlapCount}" },
    // Верификация графа overlay (план 2026-08-07 §W3): зелёный ран, снятый на неопубликованных
    // зависимостях, не имеет права стать версией каталога, пока эти зависимости не опубликованы
    // ровно тем же билдом. Статус 409 — причина внешняя (состояние каталога), и повтор promote
    // после публикации зависимости обязан пройти.
    { status: 409, code: "overlay_dependency_not_published", description: "W3: an acceptance run of this promote used a candidate dependency overlay whose node is still unpublished; promote that dependency first" },
    { status: 409, code: "overlay_dependency_diverged", description: "W3: an overlay dependency is published, but not with the bundleHash/sourceHash the run captured; re-run acceptance against the published dependency" },
    { status: 422, code: "overlay_hash_mismatch", description: "W3: the runs of a multi-run promote declare different candidate dependency overlays; shards of one family must share one dependency graph" },
    { status: 422, code: "case_set_manifest_unreadable", description: "a run of this promote references a case-set manifest this server build cannot parse (a newer manifest after a rollback, or a hand-edited row)" },
    { status: 422, code: "acceptance_coverage_incomplete", description: "W7: the union coverage of the runs does not match the requested expectedCases; details carry {expectedCases, coveredCases, runs}" },
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
const acceptanceRunStatusSchema = z.enum(["queued", "running", "pass", "pass_with_exceptions", "fail", "error", "cancelled"]);

const acceptanceCandidateFields = {
  candidateId: z.string(), componentId: z.string(), designSystem: z.string(), rev: z.number(),
  sourceHash: z.string(), bundleHash: z.string(), hostAbiVersion: z.number(), themeVersion: z.number().nullable(),
  buildFingerprint: z.string(), policyProfileHash: z.string(), catalogRevision: z.string(),
  status: z.enum(["validated", "promoted"]), statusReason: z.string().nullable(),
  /** R3b: `rejected` — вычисляемый статус поверх append-only `candidate_decisions`, а не значение `status`. */
  rejected: z.boolean(),
  decision: z.looseObject({ reason: z.string(), actor: z.string(), createdAt: isoDate }).nullable(),
  /**
   * **Последний поставленный** ран кандидата (`attachRun`), не «принятый» и не «промоутабельный»
   * (план 2026-08-04, C4). Источник выбора связки promote — `runs[]` ниже.
   */
  acceptanceRunId: z.string().nullable(),
  /**
   * Все раны кандидата в порядке постановки с готовым `promotionEligible` (терминальный
   * `pass|pass_with_exceptions` под профилем из `capabilities.acceptance.promotionPolicyProfiles`)
   * — план 2026-08-04 W3.
   */
  runs: z.array(z.looseObject({
    runId: z.string(), status: acceptanceRunStatusSchema, policyProfileId: z.string(),
    caseSetId: z.string().nullable(), finishedAt: isoDate.nullable(), promotionEligible: z.boolean(),
  })),
  promotedVersion: z.number().nullable(),
  createdAt: isoDate, expiresAt: isoDate,
};

/**
 * Прогресс рана. Счётчики reuse разведены планом 2026-08-04 (D9), потому что одно поле `reused`
 * было двусмысленным (P2-10 фидбэка): `reused` — только полный reuse по `case_fingerprint`;
 * `frameReused` — кадр взят из CAS (надмножество: сюда попадают recompute и re-diff);
 * `verdictRecomputed` — вердикт пересчитан по сохранённым метрикам под новой политикой;
 * `rediffed` — кадр пересравнён с новым эталоном без съёмки.
 */
const acceptanceProgressSchema = z.looseObject({
  total: z.number(), completed: z.number(), reused: z.number(), failed: z.number(), running: z.number(),
  frameReused: z.number().optional(), verdictRecomputed: z.number().optional(), rediffed: z.number().optional(),
  eta: z.looseObject({ secondsRemaining: z.number(), basis: z.enum(["measured", "estimate"]) }).optional(),
});

/** Кого форсит один скоуп refresh: всех, только упавших, либо перечисленные случаи. */
const acceptanceRefreshTargetSchema = z.looseObject({
  all: z.boolean(), failed: z.boolean(), caseIds: z.array(z.string()),
});
/**
 * План refresh со скоупами (план 2026-08-04, C1). `frame` — пересъёмка кадра, `verdict` —
 * переоценка вердикта над переиспользованным кадром: `--refresh failed` по умолчанию именно
 * verdict-скоуп, а `--recapture` поднимает его до frame.
 */
const acceptanceRefreshPlanSchema = z.looseObject({
  frame: acceptanceRefreshTargetSchema, verdict: acceptanceRefreshTargetSchema,
});
/**
 * Алгебра рана: `effective = requested ∪ impact`. Импакт-часть **не форсит** пересъёмку — она
 * запрещает перенос вердикта baseline; отпечаток доказывает строго больше, чем импакт.
 */
const acceptanceRefreshAlgebraSchema = z.looseObject({
  requested: acceptanceRefreshPlanSchema,
  impact: acceptanceRefreshPlanSchema,
  effective: acceptanceRefreshPlanSchema,
});
/**
 * Результат одного гейта случая. `metrics` — свободный мешок измерений гейта (форма зависит от
 * гейта и от волны), поэтому он `record(unknown)`, а не фиксированная схема: `geometry` кладёт
 * layout/paint-контуры, `readiness` — доказательство готовности, `visual` (W5a) —
 * `rawDiffPct`/`aaDiffPct`/`maxChannelDelta`/`regions`/`bestOffset` и `severityClass`.
 */
/**
 * Классифицированная причина визуального расхождения (W5b, фидбэк §19.6). Диагностика поверх
 * вердикта: список **никогда не влияет** на pass/fail и всегда непуст у объяснённого случая
 * (последний код — `unclassified`, «причина не названа»).
 */
const acceptanceCauseSchema = z.looseObject({
  code: z.enum([
    "surface-tint", "edge-radius-stroke", "geometry-shift", "text-raster-residual",
    "missing-late-asset", "alpha-compositing", "effect-overflow", "descendant-outside-mask",
    "unclassified",
  ]),
  confidence: z.number(), detail: z.string(),
  elementKey: z.string().optional(),
  region: z.looseObject({
    bbox: z.looseObject({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
    norm: z.looseObject({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
    basis: z.enum(["layoutBounds", "canvas"]),
  }).optional(),
});

/**
 * Предложение минимальной правки бюджета (W7, план 2026-08-07 §W7). Report-only: ни в вердикт, ни
 * в отпечатки не входит, `requiresHumanJudgement` всегда `true`.
 */
const acceptanceSuggestedPolicySchema = z.looseObject({
  kind: z.enum(["textAaBudget", "maxRawDiffPct"]),
  textAaBudget: z.string().optional(),
  maxRawDiffPct: z.number().optional(),
  target: z.string(), basis: z.string(),
  scope: z.enum(["case-id", "remediation-group"]),
  caseIds: z.array(z.string()),
  remediationKey: z.string().optional(),
  evidence: z.looseObject({
    topCause: z.string(), confidence: z.number(), rawDiffPct: z.number(),
    currentMaxRawDiffPct: z.number().nullable(), edgeResidualInsidePct: z.number().nullable(),
    bestOffset: z.looseObject({ dx: z.number(), dy: z.number(), residualPct: z.number() }).nullable(),
    geometryClean: z.boolean(), affectedElementKeys: z.array(z.string()),
    rendererFingerprint: z.string().nullable(),
  }),
  expiry: z.looseObject({
    trigger: z.literal("renderer-or-source-fingerprint-change"),
    rendererFingerprint: z.string().nullable(), referenceAssetId: z.string().nullable(),
  }),
  requiresHumanJudgement: z.literal(true),
});

/** Advisory-предупреждение рана (W7, AC §9.3): исключение пережило смену рендерера. */
const acceptanceRunWarningSchema = z.looseObject({
  code: z.literal("policy_exception_stale"),
  caseId: z.string(), exceptions: z.array(z.string()),
  baselineRunId: z.string(), baselineRendererFingerprint: z.string(),
  rendererFingerprint: z.string(), detail: z.string(),
});

const acceptanceGateResultSchema = z.looseObject({
  gate: z.string(), status: z.string(), detail: z.string().optional(),
  metrics: z.record(z.string(), z.unknown()).optional(),
  causes: z.array(acceptanceCauseSchema).optional(),
  suggestedPolicy: acceptanceSuggestedPolicySchema.optional(),
});

/** Группа ремедиаций рана (W5b): «одна правка» на все случаи с той же причиной в том же месте. */
const acceptanceRemediationGroupSchema = z.looseObject({
  key: z.string(),
  cause: z.looseObject({ code: z.string(), confidence: z.number(), detail: z.string() }),
  bboxSignature: z.looseObject({
    x: z.number(), y: z.number(), width: z.number(), height: z.number(), grid: z.number(),
  }).nullable(),
  sharedElementKey: z.string().nullable(),
  variantFamily: z.record(z.string(), z.string()).nullable(),
  cases: z.array(z.string()), caseCount: z.number(), suggestion: z.string(),
  /** W7: одна правка на всю группу — только если она есть у каждого участника и одного вида. */
  suggestedPolicy: acceptanceSuggestedPolicySchema.optional(),
});
const acceptanceSeveritySchema = z.looseObject({ rank: z.number(), class: z.string(), score: z.number() }).nullable();

/**
 * Отчёт импакт-анализа (план §3 D6, §5 W6). Три базиса и ни одного «может быть»: узкий базис
 * доказан совпадением хэшей, всё остальное — `conservative` с честной причиной.
 */
const acceptanceImpactSchema = z.looseObject({
  basis: z.enum(["asset-only", "theme-only", "conservative"]),
  candidateId: z.string(), baselineRunId: z.string(), baselineCandidateId: z.string(),
  changedAssets: z.array(z.string()), changedTokens: z.array(z.string()),
  affectedCases: z.array(z.string()), unaffectedCases: z.array(z.string()),
  recaptureCount: z.number(), reason: z.string(),
});

/**
 * Отчёт об остановке рана (BR-06, план 2026-08-08 §6). Одна форма на два случая — «где встали» и
 * «чьим продолжением являемся», — потому что оба отвечают на один вопрос агента: с какой точки
 * продолжать. `resumable: false` бывает: не всякая остановка продолжаема (cancel, пустой скоуп).
 */
const acceptanceResumeSchema = z.looseObject({
  resumable: z.boolean(),
  /** Фаза, на которой ран встал: `resolve|validate|allocate-renderer|capture|readiness|geometry|visual|determinism|verdict`. */
  phase: z.string().optional(),
  /** Минимальная фаза по НЕЗАВЕРШЁННЫМ случаям: «дальше неё ран целиком не продвинулся». */
  lastCompletedPhase: z.string().optional(),
  elapsedMs: z.number().optional(),
  resumeFrom: z.string().optional(),
  /** Джобы капчура, названные упавшими случаями. */
  jobIds: z.array(z.string()).optional(),
  /** Продолжение: прежние статус, причина и фаза рана-предка. */
  resumedFrom: z.looseObject({
    runId: z.string(), attempt: z.number(), status: z.string(),
    statusReason: z.string().nullable(), phase: z.string().nullable(),
    lastCompletedPhase: z.string().nullable(), jobIds: z.array(z.string()),
  }).optional(),
});

const acceptanceRunViewSchema = z.looseObject({
  runId: z.string(), candidateId: z.string(), componentId: z.string(), status: acceptanceRunStatusSchema,
  policy: z.looseObject({ id: z.string(), hash: z.string() }),
  caseSetId: z.string().nullable(), idempotencyKey: z.string().nullable(),
  progress: acceptanceProgressSchema, eta: z.looseObject({}).nullable(),
  gates: z.unknown(), evidenceManifestHash: z.string().nullable(),
  /** W6: план частичной пересъёмки, применённый к рану; `null` — импакт не считался. */
  impact: acceptanceImpactSchema.nullable(),
  /** Алгебра refresh (C1); `null` — ран поставлен до миграции v29. */
  refresh: acceptanceRefreshAlgebraSchema.nullable(),
  /**
   * Причина терминального статуса; `null` у обычного исхода. Словарь: `refresh_scope_empty` (D2),
   * BR-06 добавил `interrupted`, `phase_timeout`, `renderer_unavailable`,
   * `capture_budget_exhausted`, `queue_starvation`.
   */
  statusReason: z.string().nullable(),
  /** BR-06: ран, продолжением которого этот является; `null` — самостоятельный. */
  resumedFromRunId: z.string().nullable().optional(),
  /** BR-06: номер попытки в цепочке продолжений (1 — исходный ран). */
  attempt: z.number().optional(),
  /** BR-06: отчёт об остановке либо lineage продолжения; `null` — остановки ран не описывал. */
  resume: acceptanceResumeSchema.nullable().optional(),
  /**
   * BR-10a: `blk_<sha256>` канонизованного basis блокера и сортированных терминальных кодов;
   * `null` — блокера нет (ран прошёл либо отменён). **Ключа нет вовсе** при
   * `EASYUI_BLOCKER_FINGERPRINT_DISABLED=1` — вместе с ним исчезает и ручка `/retry-disposition`.
   */
  blockerFingerprint: z.string().nullable().optional(),
  remediationGroups: z.array(acceptanceRemediationGroupSchema),
  /** W7 (AC §9.3): advisory-предупреждения рана; пустой массив — «нечего перепроверять». */
  warnings: z.array(acceptanceRunWarningSchema),
  createdAt: isoDate, startedAt: isoDate.nullable(), finishedAt: isoDate.nullable(),
  failedCases: z.array(z.looseObject({
    caseId: z.string(), caseKey: z.string(), status: z.string(), verdict: z.string().nullable(),
    severity: acceptanceSeveritySchema, causes: z.array(acceptanceCauseSchema),
    /** W7: предложение по случаю; `null` — предложения нет (это не «случай в порядке»). */
    suggestedPolicy: acceptanceSuggestedPolicySchema.nullable(),
    failedGates: z.array(acceptanceGateResultSchema),
  })),
});

/**
 * Компактная сводка рана (`?view=summary`, план 2026-08-04 §W8, фидбэк P1-9).
 *
 * Форма намеренно **не** является подмножеством `acceptanceRunViewSchema`: `gates` и
 * `remediationGroups` схлопнуты в карты «ключ → строка», а `failedCases` несут два числа вместо
 * полного мешка метрик. Это и есть предмет P1-9: failed-ран на 25 случаев в полном виде — около
 * 1800 строк, в сводке — меньше 100.
 */
const acceptanceRunSummarySchema = z.looseObject({
  /** Маркер контракта (C23): его отсутствие означает сервер, который проигнорировал `view`. */
  view: z.literal("summary"),
  runId: z.string(), status: acceptanceRunStatusSchema, statusReason: z.string().nullable(),
  /** BR-06: `attempt 2 after acc_…` — поля нет у самостоятельной первой попытки. */
  lineage: z.string().optional(),
  /** BR-06: `phase_timeout@capture last=validate resumable` — поля нет, если ран не вставал. */
  resume: z.string().optional(),
  /** BR-10a: тот же отпечаток блокера, что в полном виде; ключа нет при поднятом kill-switch'е. */
  blockerFingerprint: z.string().nullable().optional(),
  progress: acceptanceProgressSchema,
  /** `{gate: "pass:17 fail:8"}` — по строке на гейт. */
  gates: z.record(z.string(), z.string()),
  /** `{requested, impact, effective}` строками (`frame:all`, `verdict:failed`, `none`); `null` — ран до v29. */
  refresh: z.looseObject({ requested: z.string(), impact: z.string(), effective: z.string() }).nullable(),
  failedCases: z.array(z.looseObject({
    caseId: z.string(), gate: z.string(),
    raw: z.number().nullable(), aa: z.number().nullable(),
    cause: z.string(),
    /** W7: предложение одной строкой (`textAaBudget=live-text-v1`); поля нет — предложения нет. */
    suggest: z.string().optional(),
  })),
  /** `{<12 символов ключа группы>: "<cause> ×N: caseId, caseId…"}`. */
  remediationGroups: z.record(z.string(), z.string()),
  /** W7: `["policy_exception_stale: <caseId> (<exceptions>)"]`. */
  warnings: z.array(z.string()),
  evidenceUrl: z.string(),
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

export const componentImpactContract = registerContract({
  method: "POST", path: "/api/components/{id}/impact",
  summary: "Dry-run impact analysis of a candidate against a terminal baseline run of the same component: which cases must be recaptured if the acceptance matrix is re-run. Conservative and evidence-based, with exactly three bases. `asset-only` — the candidate's source-shape hash (source with every `asset_<sha256>` literal replaced by a placeholder) equals the baseline candidate's and the theme version is unchanged, so only asset literals moved: affected cases are those whose OBSERVED readiness resources (wave W4 `themeResources`) intersect the symmetric difference of asset references. `theme-only` — the source hash is identical and only the design-system theme version changed: affected cases are those whose observed theme tokens/icons intersect the theme diff (a changed font face applies document-wide and affects every case). `conservative` — anything else (both changed, no shape evidence in the candidate cache, a non-terminal baseline, a design-system move): every case is affected. A case with no readiness evidence at all — a dynamic URL, a reclaimed artifact, a frame from a renderer that predates the readiness protocol — is ALWAYS affected; there is no silent reuse. Writes nothing and captures nothing. Requires EASYUI_ACCEPTANCE_MATRIX=1.",
  requestSchema: z.strictObject({ candidateId: z.string(), baselineRunId: z.string() }),
  responseSchema: acceptanceImpactSchema,
  errors: [
    ...acceptanceAuthErrors, errorCatalog.invalidRequest,
    { status: 422, code: "baseline_run_mismatch", description: "the baseline run belongs to another component" },
  ],
});

export const getComponentCandidateContract = registerContract({
  method: "GET", path: "/api/component-candidates/{candidateId}",
  summary: "Read an acceptance candidate by id (global namespace; it does not overlap /api/catalog/candidates). Owner or admin only. Requires EASYUI_ACCEPTANCE_MATRIX=1. The response is mutable — `status`, `acceptanceRunId` and `runs[]` change over the candidate's life — so clients must cache it with a short freshness window, never as immutable. `runs[]` lists every run of the candidate in queueing order with a precomputed `promotionEligible` (terminal pass/pass_with_exceptions under a promotion policy profile); the scalar `acceptanceRunId` is merely the LAST QUEUED run and must not be used to pick the run that backs a promote.",
  responseSchema: z.looseObject(acceptanceCandidateFields),
  errors: [...acceptanceAuthErrors],
});

/**
 * RFC §4.1 (волна R3b): отклонение кандидата человеком. Терминально по построению — `unreject`/DELETE
 * не существует ни здесь, ни в планах: выход из отклонения — новая ревизия компонента.
 */
export const rejectComponentCandidateContract = registerContract({
  method: "POST", path: "/api/component-candidates/{candidateId}/reject",
  summary: "Reject an acceptance candidate by hand: writes an append-only decision row (the stored `status` enum is NOT extended — `rejected` stays a computed flag on the DTO) and returns the candidate with `rejected: true` and `decision {reason, actor, createdAt}`. Owner or admin only; `reason` is required. THE DECISION IS TERMINAL: there is no unreject handle, the tombstone outlives the candidate TTL (the sweeper skips candidates that carry a decision), and repeating `POST /api/components/{id}/candidates` for the same build returns that same rejected candidate instead of a clean one. From then on `POST /api/components/{id}/promote` refuses the WHOLE revision with 409 candidate_rejected — on both paths, with or without `candidateId`, and regardless of EASYUI_ACCEPTANCE_MATRIX. Rejecting twice → 409 candidate_already_rejected carrying the existing decision; rejecting an already promoted candidate → 409 candidate_promoted with `{currentVersion}` (a different code from `markPromoted`'s 409 candidate_already_promoted, which reports a promote-saga CAS conflict). Rejection does not cancel a running acceptance run: it neither mutates the candidate row nor frees the in-flight slot. Requires EASYUI_ACCEPTANCE_MATRIX=1 (404 otherwise).",
  requestSchema: z.strictObject({ reason: z.string().min(1).max(2000) }),
  responseSchema: z.looseObject(acceptanceCandidateFields),
  errors: [
    ...acceptanceAuthErrors, errorCatalog.invalidRequest,
    { status: 409, code: "candidate_already_rejected", description: "the candidate already carries a rejection; the details hold the existing decision" },
    { status: 409, code: "candidate_promoted", description: "the candidate is already promoted to a public version and cannot be rejected" },
  ],
});

export const createAcceptanceRunContract = registerContract({
  method: "POST", path: "/api/acceptance-runs",
  summary: "Queue a matrix acceptance run over the candidate's cases. The case set comes either from a published case-set manifest (`caseSetId`, wave W2 — it also supplies the capture surface, per-case reference assets, expected geometry and per-case policy) or, by default, from the candidate's named examples; `cases` and `caseSetId` are mutually exclusive. The run executes outside the screenshot pump, one capture job at a time, with per-case verdicts folded into pass/fail/error/cancelled. `idempotencyKey` deduplicates the queueing itself ((candidate_id, idempotency_key) is unique); a candidate may hold at most one non-terminal run (409 acceptance_run_in_flight). `refresh` controls reuse AND carries a scope (wave 2026-08-04 W1): `\"none\"` (default) runs the full reuse cascade, `\"failed\"` is a VERDICT-scope force over the cases that previously failed (the frame is reused from CAS whenever its frameFingerprint still matches, so `recapture: 0` is a legitimate outcome — pass `recapture: true` to escalate it to a full re-capture), `\"all\"` and `{caseIds:[…]}` are FRAME-scope forces, i.e. real re-captures (unknown id → 422 unknown_case_id; a listed alias forces its target). The forcing reason is recorded per case in `reuseReason` (`refresh:<mode>`) and in the evidence manifest, and the run carries the whole algebra in `refresh {requested, impact, effective}` (`effective = requested ∪ impact`). A run whose explicit scope re-evaluated nothing terminalizes as `error` with `statusReason: \"refresh_scope_empty\"` rather than silently passing. `baselineRunId` (wave W6) turns the run into a PARTIAL recapture: the impact of the candidate against that terminal run of the same component (see POST /api/components/{id}/impact) is computed before the run is created and returned in `impact`; cases proven unaffected inherit the baseline verdict and artifacts without a capture (`reuseReason: \"impact:<basis>\"`, upserted under the new case fingerprint so later runs reuse them normally), affected cases are captured as usual, and an unprovable impact (`conservative`) simply runs everything. An explicit `refresh` always wins over the impact plan. 422 baseline_run_mismatch when the baseline belongs to another component. Requires EASYUI_ACCEPTANCE_MATRIX=1.",
  status: 202,
  requestSchema: z.strictObject({
    candidateId: z.string(),
    caseSetId: z.string().optional(),
    idempotencyKey: z.string().min(1).max(200).optional(),
    policy: z.enum(["default-v1", "pixel-strict-v1"]).optional(),
    cases: z.array(z.strictObject({ key: z.string(), props: z.record(z.string(), z.unknown()) })).optional(),
    refresh: z.union([
      z.enum(["none", "failed", "all"]),
      z.strictObject({ caseIds: z.array(z.string()).min(1).max(64) }),
    ]).optional(),
    /** Эскалация `refresh:"failed"` из verdict-скоупа в frame-скоуп (CLI `--recapture`, D5). */
    recapture: z.boolean().optional(),
    baselineRunId: z.string().optional(),
  }),
  responseSchema: z.looseObject({
    runId: z.string(), status: acceptanceRunStatusSchema, candidateId: z.string(), componentId: z.string(),
    policy: z.looseObject({ id: z.string(), hash: z.string() }),
    progress: acceptanceProgressSchema, cases: z.number(), cached: z.boolean(),
    impact: acceptanceImpactSchema.optional(),
    /** Алгебра refresh рана, посчитанная на постановке (C1). */
    refresh: acceptanceRefreshAlgebraSchema.optional(),
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
    { status: 422, code: "case_set_mismatch", description: "the case set describes another component than the candidate" },
    { status: 422, code: "baseline_run_mismatch", description: "baselineRunId names a run of another component" },
    { status: 422, code: "unsupported_option", description: "cases.concurrency / manifestAssetId are not supported" },
    // Слот-биндинги на старте рана (план 2026-08-05 §A2/§A5): факты головы кандидата становятся
    // жёсткими отказами здесь, а статус-политика пинов проверяется повторно — набор контентно
    // адресован и мог быть опубликован задолго до рана.
    { status: 422, code: "slot_unknown", description: "slotBindings names a slot that the candidate's definition does not declare (the reserved key `default` is always legal)" },
    { status: 422, code: "slot_bindings_unsupported", description: "slotBindings names NAMED slots while the candidate does not declare capabilities.namedSlots" },
    { status: 422, code: "slot_component_not_published", description: "a pinned slot child is missing, deleted or in a non-renderable status by the time the run starts" },
    { status: 422, code: "case_set_manifest_unreadable", description: "the stored case-set manifest cannot be parsed by this server build (a newer manifest after a rollback, or a hand-edited row)" },
    { status: 503, code: "maintenance_in_progress", description: "a catalog migration holds the maintenance lock" },
  ],
});

export const getAcceptanceRunContract = registerContract({
  method: "GET", path: "/api/acceptance-runs/{runId}",
  summary: "Poll an acceptance run: status, per-gate roll-up, progress {total, completed, reused, frameReused, verdictRecomputed, rediffed, failed, running}, ETA and failedCases sorted by severity. Terminal runs also carry `remediationGroups`: visual failures classified into causes (surface-tint, edge-radius-stroke, geometry-shift, text-raster-residual, missing-late-asset, alpha-compositing, effect-overflow, descendant-outside-mask, unclassified) and grouped by {cause, quantized bbox signature, element key, shared variant family} so one broken shared asset across 20 states reads as one group, sorted by case count. Classification never affects pass/fail. SUGGESTED POLICY (wave 2026-08-07 W7, `capabilities.features.suggestedPolicy`): a failed case whose TOP cause is a proven rasterisation residual (`text-raster-residual` with `edgeResidual.insidePct` at or above the classifier threshold) and whose geometry gate is clean carries `suggestedPolicy` — the MINIMAL budget covering the measured fact: either the named server-owned preset `textAaBudget` (preferred: the numbers stay the server's) or, when no preset covers it, a per-case `policy.perCase.<caseId>.maxRawDiffPct` rounded up to the nearest hundredth. It is REPORT-ONLY: it never enters a verdict, a gate or a fingerprint, always carries `requiresHumanJudgement: true`, and is REFUSED (null) for structural top causes (geometry-shift, descendant-outside-mask, effect-overflow, missing-late-asset), for non-budgetable ones (surface-tint, edge-radius-stroke, alpha-compositing), for an unmeasured residual and for any value softer than the loosest profile budget. A remediation group whose members all suggest the same KIND carries one group-level suggestion (`scope: \"remediation-group\"`, the widest member value). `warnings` carries the advisory expiry of accepted exceptions: `policy_exception_stale` says a case still passes under a declared budget that was first accepted by an earlier run under a DIFFERENT `renderer_fingerprint`; the baseline is taken only from runs whose `policy_profile_hash` equals today's hash of their profile, so runs recorded under a pre-wave readiness policy never raise a false stale. With EASYUI_SUGGESTED_POLICY_DISABLED=1 both `suggestedPolicy` and the warnings are absent. `?view=summary` (wave W8, `capabilities.features.acceptanceSummaryView`) answers with a COMPACT report instead: `{view:\"summary\", runId, status, statusReason, progress, gates {gate: \"pass:17 fail:8\"}, refresh {requested, impact, effective} as strings, failedCases [{caseId, gate, raw, aa, cause}], remediationGroups {key: \"<cause> ×N: caseIds\"}, evidenceUrl}` — a failed 25-case run prints under 100 lines instead of ~1800. The `view` marker in the BODY is the compatibility test: servers older than W8 ignore the query and return the full view, so a client must check both the capability flag and the marker. `view=full` is the default and is unchanged; any other value is 400 invalid_request. Drill down into a single case with GET /api/acceptance-runs/{runId}/cases?case=<id>. Owner or admin only. Requires EASYUI_ACCEPTANCE_MATRIX=1.",
  query: z.object({ view: z.enum(["full", "summary"]).optional() }),
  responseSchema: z.union([acceptanceRunViewSchema, acceptanceRunSummarySchema]),
  errors: [...acceptanceAuthErrors],
});

export const getAcceptanceRunCasesContract = registerContract({
  method: "GET", path: "/api/acceptance-runs/{runId}/cases",
  summary: "Per-case verdicts of a run with gate results, severity, classified visual `causes` (W5b diagnostics; empty for cases whose visual outcome is not fail/indeterminate), reuse reason, the per-case REUSE RECEIPT and the evidence artifact names/digests (never bytes: artifact content is served only inside the runId-scoped evidence archive). `reuseReceipt` (wave W8, feedback P2-10) reports reuse LEVEL BY LEVEL — `{reuse:{candidate, frame, readiness, geometry, visualMetrics, verdict}, fingerprints:{frame, comparison, verdictPolicy, case}, reuseReason?}` — because a single `reused` counter cannot tell 'nothing was recomputed' from 'the verdict was recomputed under a new threshold over a reused frame'; it is null for cases recorded before schema v29. `suggestedPolicy` (wave 2026-08-07 W7) is the report-only minimal-budget proposal for this case, or null when there is none — which never means the case is fine. `?case=<id>` narrows the answer to one case (the drill-down after `?view=summary` on the run); an id outside this run's case set is 404, never an empty list. Requires EASYUI_ACCEPTANCE_MATRIX=1.",
  query: z.object({ case: z.string().optional() }),
  responseSchema: z.looseObject({
    runId: z.string(),
    cases: z.array(z.looseObject({
      caseId: z.string(), caseKey: z.string(), status: z.string(), verdict: z.string().nullable(),
      severity: acceptanceSeveritySchema, propsHash: z.string(), caseFingerprint: z.string(),
      aliasOfCaseId: z.string().nullable(), reuseReason: z.string().nullable(), reused: z.boolean(),
      /** Квитанция reuse по уровням (W8, P2-10); `null` — строка случая старше миграции v29. */
      reuseReceipt: z.looseObject({
        reuse: z.looseObject({
          candidate: z.boolean(), frame: z.boolean(), readiness: z.boolean(),
          geometry: z.boolean(), visualMetrics: z.boolean(), verdict: z.boolean(),
        }),
        fingerprints: z.looseObject({
          frame: z.string().nullable(), comparison: z.string().nullable(),
          verdictPolicy: z.string().nullable(), case: z.string(),
        }),
        reuseReason: z.string().optional(),
      }).nullable(),
      referenceAssetId: z.string().nullable(), startedAt: isoDate.nullable(), finishedAt: isoDate.nullable(),
      /**
       * BR-06: причина инфраструктурного падения случая. `null` — случай инфраструктурно не падал
       * (в том числе любая строка старше миграции v37: до неё причина не хранилась нигде).
       */
      error: z.looseObject({
        outcome: z.string(), message: z.string(),
        attempts: z.number().optional(), elapsedMs: z.number().optional(), phase: z.string().optional(),
      }).nullable().optional(),
      gates: z.array(acceptanceGateResultSchema), causes: z.array(acceptanceCauseSchema),
      suggestedPolicy: acceptanceSuggestedPolicySchema.nullable(),
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

/**
 * BR-06 (план 2026-08-08 §6, фидбэк §9): продолжение остановленного рана. Живёт под тем же
 * гейтом `EASYUI_ACCEPTANCE_MATRIX=1` и собственным kill-switch'ем.
 */
export const resumeAcceptanceRunContract = registerContract({
  method: "POST", path: "/api/acceptance-runs/{runId}/resume",
  summary: "Resume a run that STOPPED without a verdict (`capabilities.features.acceptanceResumeV1`). Resume is a NEW RUN, not a resurrection: a terminal run is immutable because publishes, `evidence_manifest_hash` and the promote invariants reference it, so the server queues a fresh run over the same candidate, case set and policy profile and answers 202 with its id, `resumedFromRunId`, `attempt` and `resumedFrom {runId, attempt, status, statusReason, phase, lastCompletedPhase, jobIds}` — the previous error travels with the lineage instead of requiring a second request. Only a run that declared itself resumable can be resumed: after a process restart the startup sweep marks non-terminal runs `error` with `statusReason: \"interrupted\"` (their `running`/`pending` cases are unfinished BY DEFINITION — nobody closed them), a typed infrastructure timeout terminalizes with `statusReason: \"phase_timeout\"` naming the phase, and the allocate circuit breaker terminalizes with `renderer_unavailable` / `capture_budget_exhausted` / `queue_starvation` after three consecutive allocation-class case outcomes. Anything else — a verdict, a cancel, `refresh_scope_empty` — is 409 run_not_resumable; queue an ordinary run instead. WHAT IS REUSED: completed gates of the `validate` phase (contract/defaults/audit) whose PER-GATE FINGERPRINT still matches are carried over verbatim and are not re-executed; everything from `capture` onward is captured again, because the ancestor's frame may not exist at all. A partially executed case carries exactly its finished structural gates. Idempotency is deterministic — `idempotency_key = \"resume:<sourceRunId>:<attempt>\"` — so repeating the call returns the same run, and a second concurrent resume of the same candidate is refused by the one-in-flight index (409 acceptance_run_in_flight). Resuming an already resumed run is 409 run_already_resumed with the successor's id in `error.runId`. The body must be `{}`: the case set, surface, policy and candidate come from the ancestor — overriding them would be a new run, not a continuation. With EASYUI_ACCEPTANCE_RESUME_DISABLED=1 the handle answers 409 acceptance_resume_disabled (the observability half of the wave — per-case `error`, the allocate-renderer seam and the circuit breaker — stays on regardless: those are defect fixes, not a feature).",
  status: 202,
  requestSchema: z.strictObject({}),
  responseSchema: z.looseObject({
    runId: z.string(), status: acceptanceRunStatusSchema, candidateId: z.string(), componentId: z.string(),
    policy: z.looseObject({ id: z.string(), hash: z.string() }),
    progress: acceptanceProgressSchema, cases: z.number(), cached: z.boolean(),
    refresh: acceptanceRefreshAlgebraSchema.optional(),
    resumedFromRunId: z.string().nullable(),
    attempt: z.number(),
    resumedFrom: z.looseObject({}).nullable(),
  }),
  errors: [
    ...acceptanceAuthErrors, errorCatalog.invalidRequest,
    { status: 409, code: "acceptance_resume_disabled", description: "EASYUI_ACCEPTANCE_RESUME_DISABLED=1 on this server" },
    { status: 409, code: "run_not_resumable", description: "the run is still going, or it stopped in a state that is not resumable (verdict, cancel, refresh_scope_empty)" },
    { status: 409, code: "run_already_resumed", description: "a continuation of this run already exists; its id is in error.runId" },
    { status: 409, code: "acceptance_run_in_flight", description: "the candidate already has a queued/running run" },
    { status: 503, code: "maintenance_in_progress", description: "a catalog migration holds the maintenance lock" },
  ],
});

/**
 * BR-10a (план 2026-08-08 §10, фидбэк §13): read-only disposition повтора. Живёт под тем же гейтом
 * `EASYUI_ACCEPTANCE_MATRIX=1` и собственным kill-switch'ем `EASYUI_BLOCKER_FINGERPRINT_DISABLED`.
 */
const retryDispositionBasisSchema = z.looseObject({
  rendererFingerprint: z.string().nullable(),
  geometryContractVersion: z.number(),
  candidateSourceHash: z.string().nullable(),
  comparisonFingerprint: z.array(z.string()),
  verdictPolicyFingerprint: z.array(z.string()),
  readinessPolicyHash: z.string().nullable(),
  policyProfileHash: z.string(),
  caseFingerprintAlgoVersion: z.number(),
});

export const acceptanceRetryDispositionContract = registerContract({
  method: "GET", path: "/api/acceptance-runs/{runId}/retry-disposition",
  summary: "Answer, WITHOUT capturing a single pixel, whether repeating this run can produce a different verdict, and how deep the replay would have to go (`capabilities.features.blockerFingerprintV1`). The server recomputes the WOULD-BE case fingerprints of the same cases under its CURRENT state — with the same function the scheduler and the runner use — and compares them layer by layer with the fingerprints persisted on the run: nothing moved → disposition \"unchanged\" (do-not-retry); the verdict layer moved → \"recompute\"; the comparison layer moved → \"rediff\"; the frame layer moved → \"recapture\"; the component head no longer hashes to the candidate's sourceHash → \"rebuild\" (update-source), because the run was taken from source the author has already replaced. The run-level disposition is the MAXIMUM over cases, `changed[]`/`unchanged[]` name the basis fields, and `cases[]` carries the per-case verdict with the layers that moved. `blockerFingerprint` is `blk_<sha256>` over the canonicalized basis plus the SORTED terminal gate codes — neither runId nor timestamps enter the pre-image, so an unchanged blocker keeps its fingerprint across runs and across servers, and the same value is served by GET /api/acceptance-runs/{runId} and by the evidence manifest. When the basis cannot be completed — the candidate was evicted by TTL/GC, the case set is gone or no longer reconstructible, the policy profile is unknown to this server, or the case rows predate the fingerprint layers of migration v29 — the answer is a TYPED `disposition:\"unchanged\"` + `suggestedAction:\"do-not-retry\"` with `basisIncomplete` naming the reason, never a 500. `suggestedAction` is `update-source` for rebuild, `resume-run` when the run declared itself resumable (BR-06), `do-not-retry` when nothing changed, `new-run` otherwise. Optional `candidateId`/`caseSetId` query parameters are ASSERTIONS about the run, not filters: a mismatch is a typed 409 rather than silent agreement. The handle is strictly read-only (no-store): it creates no run, touches no state, and never writes to the CAS.",
  responseSchema: z.looseObject({
    runId: z.string(),
    blockerFingerprint: z.string().nullable(),
    disposition: z.enum(["unchanged", "recompute", "rediff", "recapture", "rebuild"]),
    changed: z.array(z.string()),
    unchanged: z.array(z.string()),
    suggestedAction: z.enum(["do-not-retry", "resume-run", "new-run", "update-source"]),
    basis: retryDispositionBasisSchema,
    basisIncomplete: z.enum([
      "candidate_evicted", "case_set_evicted", "case_set_unreconstructible", "case_set_changed",
      "policy_profile_unknown", "case_fingerprint_layers_missing", "no_cases",
    ]).optional(),
    cases: z.array(z.looseObject({
      caseId: z.string(),
      disposition: z.enum(["unchanged", "recompute", "rediff", "recapture", "rebuild"]),
      layers: z.array(z.enum(["frame", "comparison", "verdict"])),
    })),
  }),
  errors: [
    ...acceptanceAuthErrors, errorCatalog.invalidRequest,
    { status: 409, code: "candidate_mismatch", description: "the candidateId query parameter names another candidate than the run" },
    { status: 409, code: "case_set_mismatch", description: "the caseSetId query parameter names another case set than the run" },
  ],
});

/**
 * Case-set-манифесты (план 2026-08-03 §5 W2, амендмент A2). Живут за тем же гейтом
 * `EASYUI_ACCEPTANCE_MATRIX=1` и под той же авторизацией, что и приёмка (owner/admin; share/capture — 403).
 */
const caseSetCoverageSchema = z.looseObject({
  dimensions: z.record(z.string(), z.array(z.string())),
  expectedTuples: z.number(), presentTuples: z.number(),
  /** Первые 64 незакрытых ячейки (план 2026-08-04 W6); полное число — `missingCount`. */
  missingTuples: z.array(z.record(z.string(), z.string())),
  missingCount: z.number(), truncated: z.boolean(),
  duplicates: z.array(z.looseObject({ tuple: z.record(z.string(), z.string()), caseIds: z.array(z.string()) })),
  /**
   * Сколько случаев набора реально СНИМАЕТСЯ (план 2026-08-05 §A5): не-алиасы. С появлением
   * `slotBindings` мощность кадров перестала выводиться из числа случаев — два состояния с
   * одинаковыми props и разным содержимым слотов больше не схлопываются в один кадр, — и
   * `expectedCases` для multi-run promote считается именно по кадрам.
   */
  frameCases: z.number(),
});

export const putComponentCaseSetContract = registerContract({
  method: "PUT", path: "/api/components/{id}/case-sets",
  summary: "Publish a case-set manifest for a component: the durable, content-addressed source of an acceptance run's cases (`caseSetId` = \"cset_\" + sha256 of the canonical manifest, so republishing the same manifest is idempotent and returns the same id with cached:true; an edited manifest is a NEW set and never overwrites the old one, so runs stay reproducible). The server validates the manifest as a product entity: schema (manifestVersion 1, strict objects, case ids matching ^[A-Za-z0-9._-]{1,64}$), the declared componentId, the per-run case ceiling, unique case ids, existence of every referenceAssetId in the asset registry (422 asset_not_found), duplicate props without `aliasOf` (422 duplicate_case_props), alias targets (must be another non-alias case with identical props), and crop-lineage rectangles. Dimension coverage gaps and props that disagree with the published component schema come back as `warnings`, never as failures. The reference contract is TWO-PART (wave 2026-08-04 W5): `expectedGeometry` is the LAYOUT ROOT in CSS px, while the comparison canvas is the padded paint surface (`root + 2 x 64px margin, x deviceScaleFactor`). Declare `referenceSurface: \"content-hug\"` (plus optional `referencePlacement {x,y}` in canvas device px, default `margin x dsf`) to hand the server a plain Figma export and let it build that canvas itself — no hand-padded PNGs. `cropLineage.sourceSurface` (`figma-node` | `content-hug` | `paint`) says which surface `rect` addresses, so an already-cropped asset is never cropped a second time; omitting it keeps today's `figma-node` semantics. Rectangles that do not fit their asset are 422 crop_rect_out_of_bounds, and `content-hug` + `cropLineage` without `sourceSurface: \"figma-node\"` is 422 crop_lineage_conflict. An `expectedGeometry` that looks like a padded canvas is a warning. A single canonical axis may carry up to `limits.caseSetMaxDimensionValues` (64) values, so a 49-state family is ONE case set and ONE run — no manual sharding; the Cartesian product of all axes is capped at `limits.caseSetMaxExpectedTuples` (422 case_set_coverage_too_large, computed by multiplying axis lengths before any tuple is materialized) and `coverage.missingTuples` carries at most 64 cells with `missingCount` and `truncated` alongside. SLOT BINDINGS (plan 2026-08-05 §A, `capabilities.features.caseSetSlotBindings`): a case may declare `slotBindings: {\"<slot>\": [{type, version, props?}]}` — up to `limits.caseSetMaxSlotsPerCase` slots of up to `limits.caseSetMaxSlotChildren` children each, children pinned to an EXACT published version by component name. NESTED bindings (plan 2026-08-06 §W6, `capabilities.features.nestedSlotBindings`): a child may carry its own `slotBindings`, up to `limits.caseSetMaxSlotDepth` levels below the case and `limits.caseSetMaxSlotNodes` nodes per case in total (422 slot_depth_exceeded / slot_nodes_exceeded); a nested slot is judged against the DEFINITION of the pinned parent publication, so an unknown nested slot refuses at PUT (422 slot_unknown / slot_bindings_unsupported), and a child that repeats any of its own ancestors is 422 slot_self_reference. The reserved key `default` binds the implicit children slot and is exempt from both the named-slot membership check and the `capabilities.namedSlots` gate. Published facts about a child refuse at PUT (422 slot_component_not_published / slot_component_design_system_mismatch / slot_self_reference / slot_props_invalid / slot_props_dynamic); facts that depend on the candidate's head — an unknown named slot, a subject without `capabilities.namedSlots` — are warnings here and 422 slot_unknown / slot_bindings_unsupported at run start. A child pinned to a `deprecated`/`superseded` version is accepted with a `slot_pin_deprecated`/`slot_pin_superseded` warning, so republishing a byte-identical manifest keeps working after promote auto-supersedes a child. Two cases with equal props and DIFFERENT bindings are no longer `duplicate_case_props`: the dedup key is (props, slots), and both become capture targets. PER-CASE POLICY (`policy.perCase.<caseId>`, plan 2026-08-06 §W3): besides `maxRawDiffPct`/`allowPaintOverflow`/`expectedClip` a case may declare `sizeDeltaPx` (int 0..64 CSS px — the |dw|,|dh| tolerance against `expectedGeometry`, WINS over the profile's `policy.geometry.sizeDeltaPx`) and `overflowBudgetPx` ({top,right,bottom,left}, int 0..256, at least one side, unnamed sides budget 0) — a declarative paint-overflow allowance: overflow within the budget stops blocking while the geometry verdict class stays honest in the facts. `allowPaintOverflow` together with `overflowBudgetPx` on the same case is 422 case_policy_conflict, and both fields are VERDICT-layer, so changing them re-evaluates stored metrics without a recapture. COMPARISON MATTE AND LIVE-TEXT PRESET (plan 2026-08-06 §W4, CASE level — not `policy.perCase`): `comparison: {matte: \"none\" | \"#RRGGBB\"}` makes the visual gate composite BOTH images over that colour after crop/placement/pad and before any metric (straight-alpha over, resulting alpha is 255) — the capture itself stays transparent, so a matte is a comparison input and its change costs a re-diff of the stored frame, never a recapture; the applied colour lands in the gate metrics as `matteApplied` and the matted reference derivative is written to evidence, while the `alpha-compositing` cause is de-energised for such a case (after a matte there are no alpha divergences by construction). `textAaBudget: \"live-text-v1\"` is a NAMED, server-owned preset (the manifest declares the name, the server owns the numbers: maxRawDiffPct 0.75%, minEdgeResidualPct 95% — the same constant the `text-raster-residual` classifier uses): a case that busts its own budget still passes when `rawDiffPct` is within the preset AND `edgeResidual.insidePct` is at or above it, i.e. the whole residual lies on the reference's own contours; the fact of application is recorded in the gate metrics, not in `causes`. Tuning the thresholds means a NEW preset (`live-text-v2`). Both fields are comparison-layer (`textAaBudget` is also verdict-layer), so declaring them re-diffs the stored frame instead of recomputing stored numbers — the preset needs `edgeResidual`, which pre-wave metrics do not carry. CAPTURE SURFACE (plan 2026-08-06 §W5, `capabilities.features.captureViewportSurface`): `capture.surface` is `\"hug\"` (default, the historical surface that shrink-wraps the component) or `\"viewport\"` — a scene exactly `capture.viewport` in size, mounted inside the padded capture surface and carrying the stage host (`HostStageSurface`), so the `Overlay` host primitive finally has an anchor in a component capture instead of rendering nothing. On a viewport surface the paint margin defaults to 16 CSS px (not 64: the frame is already viewport-sized), the geometry gate measures the single `[data-eui-overlay-content]` box as the layout root instead of the empty scene, and the comparison canvas is `(viewport + 2 x margin) x dsf` with the reference placed at `margin x dsf` (`referenceSurface: \"paint\"`) or at the measured `layoutBounds {x,y} x dsf` (`referenceSurface: \"content-hug\"`; a re-diff without fresh geometry facts answers `indeterminate reference_canvas_unresolved` instead of guessing). Anything painted BEHIND the overlay (a scrim, a scene background) lies outside the content box and is honest paint overflow, so geometry cases of a viewport surface are captured with an empty scene (`scrim: false`) or declare `allowPaintOverflow`/`overflowBudgetPx`. GEOMETRY SURFACES (plan 2026-08-07 §W1a): a case may replace `expectedGeometry` with `expectedSurfaces` — up to four named surfaces, ALL in CSS px: `root` (the border box of the component root), `layoutUnion` (the union of in-flow descendant boxes — the exact meaning `expectedGeometry` always had), `paint` (the ink bbox) and `referenceExport` (the Figma export dimensions, normalised from the asset device px by the deviceScaleFactor). At least one surface must be declared, and declaring BOTH `expectedGeometry` and `expectedSurfaces` is 422 case_surface_conflict — the former is the legacy spelling of `expectedSurfaces.layoutUnion` and the server will not pick one of two numbers for you. `comparisonSurface` (one of the four) names the surface whose coordinates the comparison canvas is built in; it must be declared in `expectedSurfaces` (422 case_comparison_surface_undeclared) and omitting it keeps today's behaviour byte-for-byte. `clipExpectation: \"root-does-not-clip-layout\"` states that the layout union may exceed the root box as long as nothing clips it on the way, and requires `expectedSurfaces.root` (422 case_clip_expectation_requires_root). The geometry verdict then NAMES the surface: per-surface verdicts (`clean` | `size-mismatch` | `not-measured`), `divergingSurfaces[]` ordered root → layoutUnion → paint → referenceExport, the verdict class `surface-mismatch` and a typed `surface_mismatch` code whose `ref` is the surface; the tolerance is the existing `sizeDeltaPx` (per-case wins over the profile). LAYERS ARE SPLIT BY SUB-FIELD: `expectedSurfaces.referenceExport` and `comparisonSurface` are comparison-layer (a re-diff), `expectedSurfaces.root|layoutUnion|paint` and `clipExpectation` are verdict-layer (a cheap recompute) — so tightening a root expectation never costs a re-diff. A case that declares nothing new keeps every fingerprint byte-identical, and `GEOMETRY_CONTRACT_VERSION` stays 2: the surfaces are additive facts, not a new frame contract. A pre-wave frame that carries no fact for a newly declared surface refuses the recompute and falls through to a re-diff/recapture of THAT case only. The surface is a FRAME-layer input (`surface.mode`): a hug frame is never reused for a viewport case, while omitting the field (or declaring `\"hug\"`) leaves every existing fingerprint byte-identical. CANDIDATE DEPENDENCY OVERLAY (plan 2026-08-07 §W3): a manifest may declare a top-level `candidateOverlay: {\"<componentId>\": \"cand_...\"}` (up to `limits.caseSetMaxOverlayNodes` nodes) and bind those nodes as slot children in the OVERLAY FORM `{overlay: \"<componentId>\", props?}` — that is how a parent and its NEVER-PUBLISHED dependencies are accepted in ONE run instead of publishing the leaf just to accept the parent. The overlay child is resolved directly against `components.id` plus the declared candidate, bypassing the published-pin lookup that made this impossible before; the resolved binding carries `candidate {candidateId}` and NO `version` at all (a candidate is not a version, and a sentinel would corrupt `slotsHash` and the disjointness check of a multi-run promote). Refusals: a node no slot child binds — or the subject component itself — is 422 candidate_overlay_unused (an unused node would shift every case's frame fingerprint without changing a pixel); a child binding an undeclared node is 422 candidate_overlay_unknown; two nodes sharing one candidate id are 422 candidate_overlay_duplicate; more than the limit is 422 candidate_overlay_limit; a node that is not a component of the same design system is 422 candidate_overlay_component_not_found / candidate_overlay_design_system_mismatch. A candidate this server no longer holds is only a `candidate_overlay_unresolved` WARNING here (the manifest is content-addressed and must outlive the 24h candidate cache) and becomes 409 candidate_overlay_expired / candidate_overlay_evicted when the run is created. The whole overlay is a FRAME-layer input of EVERY case of the set (accepted price: a node that does not reach a given case still moves its frame; no reachability dedup is built), it is persisted onto the run (`overlay_manifest_json`/`overlay_hash`, schema v33), it PINS the candidate bundles against the candidate-cache GC while the run is non-terminal (durable, survives a restart), and promote verifies it: every node must be published NOW with the same bundleHash/sourceHash (409 overlay_dependency_not_published / overlay_dependency_diverged) and all runs of a multi-run promote must declare the same graph (422 overlay_hash_mismatch). The scope is deliberate: this is the ONLY durable acceptance surface for a dependency graph. The prototype path (`candidateOverrides`) stays SWAP-ONLY over already published pins, composition acceptance does not exist at all, and the diagnostic surfaces (component head screenshot, composition preview-tree, screen render-status) accept the same map and merely ECHO its resolution. With EASYUI_CANDIDATE_OVERLAY_DISABLED=1 a manifest declaring `candidateOverlay` is 422 candidate_overlay_disabled. Requires EASYUI_ACCEPTANCE_MATRIX=1 (404 otherwise).",
  requestSchema: z.strictObject({ manifest: z.unknown() }),
  responseSchema: z.looseObject({
    caseSetId: z.string(), componentId: z.string(), designSystem: z.string(),
    cases: z.number(), cached: z.boolean(), coverage: caseSetCoverageSchema, warnings: z.array(z.string()),
  }),
  errors: [
    ...acceptanceAuthErrors, errorCatalog.invalidRequest, errorCatalog.payloadTooLarge, errorCatalog.validationFailed,
    { status: 422, code: "case_set_component_mismatch", description: "the manifest names another componentId than the route" },
    { status: 422, code: "case_set_too_large", description: "the manifest declares more cases than limits.acceptanceMaxCasesPerRun" },
    {
      status: 422, code: "case_set_coverage_too_large",
      description: "the Cartesian product of `dimensions` exceeds limits.caseSetMaxExpectedTuples (checked by multiplying axis lengths, before any tuple is built)",
    },
    { status: 422, code: "duplicate_case_id" },
    { status: 422, code: "duplicate_case_props", description: "two cases declare identical props without aliasOf" },
    { status: 422, code: "invalid_alias_target", description: "aliasOf names a missing case, an alias, or a case with different props" },
    { status: 422, code: "asset_not_found", description: "a referenceAssetId is not in the asset registry" },
    { status: 422, code: "crop_rect_out_of_bounds", description: "cropLineage.rect does not fit the referenced asset" },
    {
      status: 422, code: "crop_lineage_conflict",
      description: "referenceSurface \"content-hug\" with a cropLineage requires cropLineage.sourceSurface \"figma-node\"",
    },
    // Слот-биндинги (план 2026-08-05 §A2). Опубликованные факты про ребёнка — жёсткий 422 уже
    // на PUT; факты головы кандидата (`slot_unknown`/`slot_bindings_unsupported`) здесь только
    // warning и превращаются в 422 на старте рана, где кандидат наконец известен.
    { status: 422, code: "slot_component_not_published", description: "a slotBindings child names an unknown component, an unpublished/deleted version, or a version in a non-renderable status (archived|rejected|staging|failed)" },
    { status: 422, code: "slot_component_design_system_mismatch", description: "a slotBindings child belongs to another design system than the subject component" },
    { status: 422, code: "slot_self_reference", description: "a slotBindings child resolves to the subject component itself" },
    { status: 422, code: "slot_props_invalid", description: "a slotBindings child's props fail the propsJsonSchema of the pinned version" },
    { status: 422, code: "slot_props_dynamic", description: "a slotBindings child's props carry a `$`-directive or a `__eui`-prefixed key at any depth; case-set props are literal JSON" },
    // Вложенные слоты (план 2026-08-06 §W6): оба потолка судятся обходом дерева, поэтому отказ
    // называет путь до узла, а не «манифест слишком большой».
    { status: 422, code: "slot_depth_exceeded", description: "a slotBindings tree is deeper than `limits.caseSetMaxSlotDepth` levels below the case" },
    { status: 422, code: "slot_nodes_exceeded", description: "the whole slotBindings tree of one case holds more than `limits.caseSetMaxSlotNodes` children" },
    // Per-case политика (план 2026-08-06 §W3): бюджет и бланкетное разрешение об одном вердикте.
    { status: 422, code: "case_policy_conflict", description: "a policy.perCase entry declares both allowPaintOverflow and overflowBudgetPx; the blanket allowance and the per-side budget are mutually exclusive" },
    // Поверхности геометрии (план 2026-08-07 §W1a): три несовместимости декларации.
    { status: 422, code: "case_surface_conflict", description: "a case declares both expectedGeometry and expectedSurfaces; the former is the legacy spelling of expectedSurfaces.layoutUnion" },
    { status: 422, code: "case_comparison_surface_undeclared", description: "comparisonSurface names a surface whose dimensions the case never declares in expectedSurfaces" },
    { status: 422, code: "case_clip_expectation_requires_root", description: "clipExpectation is declared without expectedSurfaces.root, so the expectation is unverifiable" },
    { status: 422, code: "per_case_policy_on_alias", description: "policy.perCase addresses a case with aliasOf; per-case policy belongs on the alias target" },
    { status: 422, code: "slot_unknown", description: "a NESTED binding names a slot the pinned parent publication does not declare (at the case root this is a warning re-checked at run start)" },
    { status: 422, code: "slot_bindings_unsupported", description: "a NESTED binding uses a named slot of a pinned parent publication that declares no capabilities.namedSlots" },
    // Candidate dependency overlay (план 2026-08-07 §W3): декларативные отказы — при PUT, живость
    // кандидата — при создании рана (409, см. POST /api/components/{id}/acceptance-runs).
    { status: 422, code: "candidate_overlay_limit", description: "candidateOverlay declares more than `limits.caseSetMaxOverlayNodes` nodes" },
    { status: 422, code: "candidate_overlay_duplicate", description: "two candidateOverlay nodes map to the same candidate id; a candidate is component-scoped" },
    { status: 422, code: "candidate_overlay_unused", description: "a candidateOverlay node is bound by no slot child (declaring the subject component itself is the same refusal)" },
    { status: 422, code: "candidate_overlay_unknown", description: "a slot child binds an overlay node that candidateOverlay does not declare" },
    { status: 422, code: "candidate_overlay_component_not_found", description: "a candidateOverlay node is not a component of this catalog" },
    { status: 422, code: "candidate_overlay_design_system_mismatch", description: "a candidateOverlay node belongs to another design system than the subject component" },
    { status: 422, code: "candidate_overlay_component_mismatch", description: "a candidateOverlay node maps to a candidate that describes another component" },
    { status: 422, code: "candidate_overlay_disabled", description: "EASYUI_CANDIDATE_OVERLAY_DISABLED=1: candidate dependency overlay is switched off on this server" },
  ],
});

/**
 * Dry-run манифеста (план 2026-08-04 §W6, P1-7/C20/C23). Гейт возможности —
 * `capabilities.features.caseSetValidate`: старая сборка отвечает на путь 404, и клиент обязан
 * узнать это до вызова, а не молча свалиться на мутирующий PUT.
 */
export const validateComponentCaseSetContract = registerContract({
  method: "POST", path: "/api/components/{id}/case-sets/validate",
  summary: "Dry-run a case-set manifest: exactly the checks of PUT /api/components/{id}/case-sets (schema, componentId, per-run ceiling, Cartesian ceiling, unique ids, reference assets, aliases, crop lineage, duplicate props) WITHOUT writing anything. Returns the content address the manifest would get (`caseSetId`), the run's case list as the orchestrator would build it (`cases {count, ids}` — aliases included, same `empty_case_set` refusal), `coverage`, `warnings`, and `wouldBeCached` (true when that exact manifest is already published, i.e. a PUT would be an idempotent repeat). Owner or admin, same authorization as PUT. Gated by `capabilities.features.caseSetValidate`; requires EASYUI_ACCEPTANCE_MATRIX=1 (404 otherwise).",
  requestSchema: z.strictObject({ manifest: z.unknown() }),
  responseSchema: z.looseObject({
    caseSetId: z.string(), componentId: z.string(), designSystem: z.string(),
    cases: z.looseObject({ count: z.number(), ids: z.array(z.string()) }),
    /** Кадры набора (§A5): случаи без `aliasOfCaseId` — то, что действительно снимается. */
    frames: z.looseObject({ count: z.number(), ids: z.array(z.string()) }),
    coverage: caseSetCoverageSchema, warnings: z.array(z.string()), wouldBeCached: z.boolean(),
  }),
  errors: putComponentCaseSetContract.errors,
});

export const getCaseSetContract = registerContract({
  method: "GET", path: "/api/case-sets/{caseSetId}",
  summary: "Read a case-set manifest with its stored metadata (component, design system, case count, Figma source, author). Owner or admin only. Requires EASYUI_ACCEPTANCE_MATRIX=1.",
  responseSchema: z.looseObject({
    caseSetId: z.string(), componentId: z.string(), designSystem: z.string(), caseCount: z.number(),
    source: z.looseObject({ fileKey: z.string(), componentSetNodeId: z.string().nullable() }).nullable(),
    createdBy: z.string(), createdAt: isoDate, manifest: z.unknown(),
  }),
  errors: [...acceptanceAuthErrors],
});

export const getCaseSetCoverageContract = registerContract({
  method: "GET", path: "/api/case-sets/{caseSetId}/coverage",
  summary: "Coverage report of a case set: the declared `dimensions`, the size of their Cartesian product (`expectedTuples`), how many distinct tuples the cases actually cover (`presentTuples`), the `missingTuples` and the tuples covered by more than one case (`duplicates`). A manifest without `dimensions` reports a trivial coverage (expectedTuples 0, presentTuples = number of cases): no fake Cartesian product is invented for an incomplete Figma matrix. Requires EASYUI_ACCEPTANCE_MATRIX=1.",
  responseSchema: z.looseObject({ caseSetId: z.string(), componentId: z.string(), ...caseSetCoverageSchema.shape }),
  errors: [
    ...acceptanceAuthErrors,
    { status: 422, code: "case_set_manifest_unreadable", description: "the stored manifest cannot be parsed by this server build (a newer manifest after a rollback, or a hand-edited row)" },
  ],
});

export const listComponentVersionsContract = registerContract({
  method: "GET", path: "/api/components/{id}/versions",
  summary: "List published versions with lifecycle status and their flat acceptance receipts: `acceptanceRunId`/`candidateId` are non-null only for versions published by `promote` with a durable candidate and a passing acceptance run (null on everything published before, or through the legacy publish path). `acceptanceRunIds` is the full sorted set backing the version (W7 multi-run promote; rows written before schema v30 report `[acceptanceRunId]`, and `acceptanceRunId` always equals its first element), `evidenceManifestHashes` the evidence manifest hash of each of those runs.",
  responseSchema: z.array(z.looseObject({
    version: z.number(), rev: z.number(), status: z.string(), designSystem: z.string(), publishedAt: isoDate,
    candidateId: z.string().nullable(), acceptanceRunId: z.string().nullable(),
    /** W7: весь набор ранов версии (legacy-строки читаются как `[acceptanceRunId]`) и манифест-хэши их evidence. */
    acceptanceRunIds: z.array(z.string()), evidenceManifestHashes: z.array(z.string()),
  })),
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
/**
 * Параметр v3 (план 2026-08-03 W8a): плоские типы v1/v2 плюс `enum`/`object`/`array`.
 * Форма — discovery-проекция; строгая схема живёт в `src/prototype/compositionV3/params.ts`.
 */
const compositionParamV3Schema = z.looseObject({
  type: z.enum(["string", "number", "boolean", "json", "asset", "enum", "object", "array", "action"]),
  values: z.array(z.string()).optional(),
  schema: z.record(z.string(), z.looseObject({ type: z.enum(["string", "number", "boolean"]), required: z.boolean().optional(), default: z.json().optional() })).optional(),
  items: z.looseObject({ type: z.enum(["string", "number", "boolean", "object"]) }).optional(),
  maxItems: z.number().int().optional(),
  required: z.boolean().optional(), default: z.json().optional(), description: z.string().optional(),
});
/**
 * Слот v3 (план 2026-08-03 W8c): имя как раньше **или** метаданные слота.
 * Форма — discovery-проекция; строгая схема живёт в `src/prototype/compositionV3/slots.ts`.
 */
const compositionSlotsV3Schema = z.union([
  z.array(z.string()),
  z.record(z.string(), z.looseObject({
    required: z.boolean().optional(),
    allowedRoles: z.array(z.string()).optional(),
    allowedTypes: z.array(z.string()).optional(),
    cardinality: z.looseObject({ min: z.number().int().optional(), max: z.number().int().optional() }).optional(),
    fallback: z.array(z.string()).optional(),
    description: z.string().optional(),
  })),
]);
/**
 * Варианты v3 (план 2026-08-03 W8f): оси семейства, легальные комбинации и их параметры.
 * Форма — discovery-проекция; строгая схема живёт в `src/prototype/compositionV3/variants.ts`.
 */
const compositionVariantsSchema = z.looseObject({
  dimensions: z.record(z.string(), z.array(z.string())),
  tuples: z.array(z.looseObject({
    dims: z.record(z.string(), z.string()),
    params: z.record(z.string(), z.unknown()).optional(),
    description: z.string().optional(),
  })).optional(),
  defaults: z.record(z.string(), z.string()).optional(),
});
const compositionDocumentSchema = z.discriminatedUnion("version", [
  z.looseObject({ version: z.literal(1), ...compositionDocumentCommonSchema }),
  z.looseObject({ version: z.literal(2), atomicLevel: z.enum(["molecule", "organism", "template", "page"]), ...compositionDocumentCommonSchema }),
  z.looseObject({
    version: z.literal(3),
    atomicLevel: z.enum(["molecule", "organism", "template", "page"]),
    ...compositionDocumentCommonSchema,
    params: z.record(z.string(), compositionParamV3Schema),
    slots: compositionSlotsV3Schema,
    variants: compositionVariantsSchema.optional(),
  }),
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
  errors: [errorCatalog.invalidRequest, errorCatalog.alreadyExists, errorCatalog.validationFailed, errorCatalog.notFound, compositionV3DisabledError],
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
  errors: [errorCatalog.invalidRequest, errorCatalog.baseRevRequired, errorCatalog.notFound, errorCatalog.revConflict, errorCatalog.alreadyExists, errorCatalog.validationFailed, compositionV3DisabledError],
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

// --- W8g: анализатор кандидата и preview-дерево (план 2026-08-03 §5) ---

const compositionAnalyzeReasonSchema = z.looseObject({ code: z.string(), message: z.string(), elementKey: z.string().optional() });
const compositionUnsupportedSchema = z.looseObject({ feature: z.string(), elementKey: z.string(), hint: z.string() });

export const analyzeCompositionContract = registerContract({
  method: "POST", path: "/api/compositions/analyze",
  summary: "Analyze a composition candidate or draft: is the construct expressible with composition v3 (`composition`), is it one component with prop variations (`extend-component`), or does it need an ownership component (`needs-ownership-component`)? Writes nothing and works regardless of EASYUI_COMPOSITION_V3; the document need not pass the strict schema (drafts are analyzed as-is, `schemaValid` reports it). With `designSystem`, the answer also carries dependency impact (head/immutable usages of the components and nested compositions the body references) and `unknownTypes`. `analyze` is a reserved path segment: POST here never addresses a composition whose id is `analyze`.",
  requestSchema: z.object({ doc: z.unknown(), designSystem: slugString.optional() }),
  responseSchema: z.looseObject({
    verdict: z.enum(["composition", "extend-component", "needs-ownership-component"]),
    reasons: z.array(compositionAnalyzeReasonSchema),
    unsupported: z.array(compositionUnsupportedSchema),
    schemaValid: z.boolean(),
    stats: z.looseObject({
      elements: z.number(), params: z.number(), slots: z.number(), componentTypes: z.array(z.string()),
      branches: z.number(), switches: z.number(), repeats: z.number(), actionParams: z.number(), nestedCompositions: z.number(),
    }),
    dependencyImpact: z.looseObject({
      components: z.array(z.looseObject({ componentId: z.string(), name: z.string(), headUsageCount: z.number(), immutableUsageCount: z.number(), safeToRemove: z.boolean() })),
      compositions: z.array(z.looseObject({ id: z.string(), headUsageCount: z.number(), immutableUsageCount: z.number(), safeToRemove: z.boolean() })),
      unknownTypes: z.array(z.string()),
    }),
  }),
  errors: [errorCatalog.invalidRequest, { status: 401, code: "unauthorized" }, { status: 403, code: "forbidden" }, errorCatalog.notFound, errorCatalog.methodNotAllowed],
});

export const compositionPreviewTreeContract = registerContract({
  method: "POST", path: "/api/compositions/{id}/preview-tree",
  summary: "Preview how a composition revision expands for the given params/variant: an instrumented run of the very same expansion the prototype save path uses. Returns resolved params (after variant and declared defaults), the `when` branches actually taken, the `$switch` cases chosen, the `repeatParam` clone counts, declarative slot bindings (a preview has no reference point, so `filled` is always false and fallbacks materialize), the props each token `layout` compiled into, the expanded `{root, elements}` fragment and expansion issues. Writes nothing and works regardless of EASYUI_COMPOSITION_V3. `rev` defaults to the head revision.",
  requestSchema: z.object({
    params: z.record(z.string(), z.unknown()).optional(),
    variant: z.record(z.string(), z.string()).optional(),
    rev: positiveInt.optional(),
    /** Диагностический overlay (план 2026-08-07 §W3): резолв уезжает в ответ эхом (§1.2, п.3). */
    candidateOverlay: z.record(z.string(), z.string()).optional(),
  }),
  responseSchema: z.looseObject({
    compositionId: z.string(), rev: z.number(), designSystem: z.string(),
    resolvedParams: z.record(z.string(), z.unknown()),
    chosenBranches: z.array(z.looseObject({ elementKey: z.string(), compositionId: z.string(), when: z.looseObject({ param: z.string() }), taken: z.boolean() })),
    switches: z.array(z.looseObject({ elementKey: z.string(), prop: z.string(), param: z.string(), case: z.string() })),
    repeatExpansions: z.array(z.looseObject({ elementKey: z.string(), param: z.string(), count: z.number() })),
    slotBindings: z.array(z.looseObject({ slot: z.string(), compositionId: z.string(), required: z.boolean(), filled: z.boolean(), fallbackUsed: z.boolean() })),
    layoutOwners: z.array(z.looseObject({ elementKey: z.string(), type: z.string(), props: z.record(z.string(), z.unknown()) })),
    expandedTree: z.looseObject({ root: z.string(), elements: z.record(z.string(), z.unknown()) }),
    issues: z.array(z.looseObject({ path: z.array(z.string()), message: z.string(), code: z.string().optional() })),
  }),
  errors: [errorCatalog.invalidRequest, { status: 401, code: "unauthorized" }, { status: 403, code: "forbidden" }, errorCatalog.notFound, errorCatalog.revisionNotFound, errorCatalog.methodNotAllowed],
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
  // `accepted` — независимый от visual-`verified` признак (RFC §7): активная версия несёт
  // непустой `acceptance_run_id`. Не входит в проекцию `catalogRevision`.
  accepted: z.boolean(),
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
  // `sourceCount` (план §W1) — число дополнительных источников lineage сверх primary-документа;
  // отсутствует, когда их нет (мульти-источники — редкий случай, ответ остаётся прежним).
  figma: z.strictObject({ fileKey: z.string(), nodeCount: z.number().int().nonnegative(), sourceCount: z.number().int().positive().optional() }).nullable(),
  preview: componentPreviewSelectorSchema.nullable(),
});

export const catalogLibraryContract = registerContract({
  method: "GET", path: "/api/catalog/library",
  summary: "Library read model: latest active component versions with resolved status (published/verified/visualPending/blocked/rejected/accepted), head usage, Figma summary and the preview selector. `accepted` is independent of the visual `verified` flag: it means the active version carries a non-empty acceptance run receipt (promote with a passing acceptance run) and it is deliberately excluded from `catalogRevision`. Identity is (componentId, designSystem). Never returns source, props schemas or examples.",
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
  /**
   * Документ композиции для `kind: "composition"` (W9). Строгую схему проходить **не обязан**:
   * кандидат приходит черновиком. Без него ответ считается по имени/описанию/контракту, но без
   * структурной сигнатуры тела и без вердикта анализатора.
   */
  compositionDoc: z.unknown().optional(),
  /**
   * Источник предложения (план 2026-08-07 §W8, триаж S-M6): пакет исходников Figma и узлы, из
   * которых артефакт собирают. Сервер сам проецирует их в ключи компонентов и семантические роли
   * и подмешивает **ранжирующий** сигнал: кандидат из того же мастера Figma поднимается в выдаче,
   * но `blocking` от него не зависит ни в одном положении.
   */
  sourcePackageId: z.string().regex(/^fsp_[0-9a-f]{64}$/, "must be a source package id").optional(),
  sourceNodeIds: z.array(z.string().min(1).max(64)).min(1).max(50).optional(),
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
  /** `composition` появляется только в ответе на композиционный кандидат (W9). */
  kind: z.enum(["component", "composition"]),
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

/**
 * Workbench-исходы композиционного кандидата (план 2026-08-03 W9, спека §19.4).
 * **Рекомендательные**: гейт переиспользования (409) на композиции не распространяется.
 */
export const compositionOutcomeSchema = z.enum(["build-composition", "extend-component", "new-ownership-component"]);

const compositionMatchSchema = z.strictObject({
  kind: z.enum(["component", "composition"]),
  id: z.string(), name: z.string(), version: z.number().int().nonnegative(),
  score: z.number(), blocking: z.boolean(), recommendable: z.boolean(),
  why: z.string(),
});

const compositionAnalysisSchema = z.strictObject({
  reasons: z.array(z.strictObject({ code: z.string(), message: z.string(), elementKey: z.string().optional() })),
  unsupported: z.array(z.strictObject({ feature: z.string(), elementKey: z.string(), hint: z.string() })),
  schemaValid: z.boolean(),
  stats: z.looseObject({}),
});

const compositionDependencyImpactSchema = z.strictObject({
  components: z.array(z.strictObject({
    componentId: z.string(), name: z.string(),
    headUsageCount: z.number().int().nonnegative(), immutableUsageCount: z.number().int().nonnegative(),
    safeToRemove: z.boolean(),
  })),
  compositions: z.array(z.strictObject({
    id: z.string(), headUsageCount: z.number().int().nonnegative(),
    immutableUsageCount: z.number().int().nonnegative(), safeToRemove: z.boolean(),
  })),
  unknownTypes: z.array(z.string()),
});

const catalogCandidatesPostResponseSchema = catalogCandidatesResponseSchema.extend({
  /** Present only when POST included source and the server extracted authoritative metadata. */
  overrideTemplate: z.strictObject({
    catalogRevision: z.string(),
    candidateKeys: z.array(z.string()),
  }).optional(),
  /** Composition proposals only (W9): the recommended outcome and why. */
  outcome: compositionOutcomeSchema.optional(),
  explanation: z.string().optional(),
  matches: z.array(compositionMatchSchema).optional(),
  /** Present when the composition proposal carried `compositionDoc` (analyzer W8g). */
  analyzerVerdict: z.enum(["composition", "extend-component", "needs-ownership-component"]).optional(),
  analysis: compositionAnalysisSchema.optional(),
  /** Usages of the components and nested compositions the candidate depends on. */
  dependencyImpact: compositionDependencyImpactSchema.optional(),
});

const catalogCandidatesErrors: RouteError[] = [
  { status: 403, code: "forbidden", description: "share/capture principals may not read the catalog index" },
  errorCatalog.notFound,
  errorCatalog.methodNotAllowed,
  errorCatalog.validationFailed,
];

const catalogCandidatesSummary = "Compact reuse-candidate search over the requested design system: active publications and head drafts scored by the deterministic matcher. Never returns source or props schemas. `catalogRevision` pins the catalog snapshot the scores were computed on.";

export const catalogCandidatesContract = registerContract({
  method: "POST", path: "/api/catalog/candidates",
  summary: `${catalogCandidatesSummary} POST is the full form and accepts \`proposed\` (including source). With \`proposed.kind: "composition"\` the corpus also carries the design system's compositions and the response adds the advisory workbench outcome (\`outcome\`/\`explanation\`/\`matches\`/\`analyzerVerdict\`/\`dependencyImpact\`); composition matches never produce a reuse 409.`,
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

/**
 * Физический снимок SQLite-базы для бэкапа (admin-only). База работает в WAL, поэтому копия файла
 * на живом сервере не консистентна: снимок снимает сам движок (`VACUUM INTO` во временный файл
 * внутри DATA_DIR), отдаётся целиком как attachment и временный файл удаляется после отдачи.
 * Логический экспорт (`GET /api/bundles/export`) его не заменяет — там только владельческий срез.
 */
export const adminDbSnapshotContract = registerContract({
  method: "GET", path: "/api/admin/db-snapshot",
  summary: "Admin-only consistent physical snapshot of the server SQLite database (VACUUM INTO), streamed as an attachment for backups. Not a substitute for the logical bundle export.",
  contentType: "application/octet-stream",
  errors: [
    { status: 401, code: "unauthorized", description: "authentication is required" },
    { status: 403, code: "forbidden", description: "administrator access required; share/capture principals are rejected" },
    errorCatalog.methodNotAllowed,
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

/**
 * Объявленный рендерер (план 2026-08-03 renderer-contract-2 §3 E1, §5 R1) — то, чем этот образ
 * рисует кадры: фактически запускаемый бинарь (`chrome-headless-shell`, **не** `chrome`), его
 * sha256, шрифтовой стек образа, детерминизм-флаги запуска. `fingerprint` — под дефолтной
 * readiness-политикой (`policyHash`): именно по ней снимаются интерактивные капчуры.
 *
 * `source: "fallback"` — манифест образа недоступен (рабочее дерево): дорогие поля деградируют
 * в `null`, отпечаток остаётся стабильным внутри процесса, но сравнивать его между хостами
 * бессмысленно. `provenance` в отпечаток **не входит**: иначе каждый коммит обнулял бы reuse.
 */
export const rendererReportSchema = z.object({
  rendererSchema: z.number().int().positive(),
  rendererVersion: z.string(),
  fingerprint: z.string(),
  policyHash: z.string(),
  os: z.string(), arch: z.string(),
  nodeVersion: z.string().nullable(), playwrightVersion: z.string().nullable(),
  browserName: z.string(), browserVersion: z.string().nullable(), browserRevision: z.string().nullable(),
  launchedExecutable: z.string().nullable(), browserExecutableSha256: z.string().nullable(),
  fontStackSha256: z.string().nullable(), appFontsSha256: z.string().nullable(), systemLibsHash: z.string().nullable(),
  launchDeterminismArgsHash: z.string(), contextOptionsHash: z.string().nullable(),
  colorProfile: z.literal("srgb"),
  source: z.enum(["manifest", "fallback"]),
  provenance: z.object({
    buildSha: z.string().nullable(), imageRef: z.string().nullable(),
    builtAt: z.string().nullable(), bunVersion: z.string().nullable(),
  }).nullable(),
});

export const healthContract = registerContract({
  method: "GET", path: "/api/health",
  summary: "Liveness/readiness: 200 ready, 503 while starting. Exempt from BasicAuth. Carries the declared renderer so a deploy sees a manifest/image mismatch before the first capture does.",
  responseSchema: z.object({ status: z.enum(["ready", "starting"]), renderer: rendererReportSchema.optional() }),
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
    /**
     * Case-set-манифест (план 2026-08-04 §W6): потолок массива `cases`, число осей `dimensions`,
     * значений в оси (≥ `acceptanceMaxCasesPerRun`, чтобы одна каноническая ось не шардировала
     * семью), размер декартова произведения и единственная поддерживаемая версия манифеста.
     */
    caseSetMaxCases: z.number(), caseSetMaxDimensions: z.number(), caseSetMaxDimensionValues: z.number(),
    caseSetMaxExpectedTuples: z.number(), caseSetManifestVersion: z.number(),
    /**
     * Слот-биндинги случая (план 2026-08-05 §A1): детей на один слот и слотов на случай.
     * Кардинальность самого слота сервер не проверяет — это свойство компонента, а не набора.
     */
    caseSetMaxSlotChildren: z.number(), caseSetMaxSlotsPerCase: z.number(),
    /**
     * Вложенные слоты (план 2026-08-06 §W6): `caseSetMaxSlotDepth` — уровней дерева от корня
     * случая, `caseSetMaxSlotNodes` — узлов на случай целиком (равен прежнему максимуму 8×12,
     * проверка `≤`, поэтому граничный плоский манифест остаётся валидным).
     */
    caseSetMaxSlotDepth: z.number(), caseSetMaxSlotNodes: z.number(),
    /** Per-case вердиктные допуски (план 2026-08-06 §W3): потолки `sizeDeltaPx` и `overflowBudgetPx`. */
    caseSetMaxCaseSizeDeltaPx: z.number(), caseSetMaxCaseOverflowBudgetPx: z.number(),
    /** Подмен кандидатов на один прототипный кадр (план 2026-08-05 §B1). */
    prototypeCandidateOverlayMax: z.number(),
    /**
     * Волна 2026-08-07: узлов `candidateOverlay` в case-set-манифесте (§W3, не путать с
     * `prototypeCandidateOverlayMax` — тот про swap опубликованных пинов прототипного кадра),
     * экранов в одном плане импакт-съёмки (§W5), потолок жизни фазы саги миграционного коммита
     * (§W4; sweep — на старте и на запросах, периодических таймеров в сервере нет), экспортов в
     * пакете исходников Figma (§W8) и два потолка барьера ресурсов (§W2): манифест одной страницы
     * и **суммарный** бюджет фазы, за которым поднимается `resource_barrier_timeout`.
     */
    caseSetMaxOverlayNodes: z.number(), snapPlanMaxScreens: z.number(),
    migrationCommitPhaseTimeoutMs: z.number(), sourcePackageMaxExports: z.number(),
    resourceBarrierMaxResources: z.number(), resourceBarrierBudgetMs: z.number(),
    /**
     * Волна 2026-08-08 (BR-02/BR-03): потолок **одной стороны** поля краски случая
     * (`cases[].paintPaddingPx`, тот же, что у скалярного `paintMargin`), бюджет площади кадра
     * `(w+left+right)×(h+top+bottom)×dsf²` в мегапикселях (`422 capture_budget_exceeded`) и потолок
     * hint'а предзагрузки (`cases[].preloadAssets`).
     */
    captureMaxPaintPaddingPx: z.number(), captureFrameBudgetMpx: z.number(),
    caseSetMaxPreloadAssets: z.number(),
    /** BR-05: потолок объявленных узлов владения геометрией на случай (`cases[].geometryOwnership`). */
    caseSetMaxGeometryOwnership: z.number(),
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
    /**
     * Geometry Contract 2.0 (план 2026-08-03 §5 W3): режим `probe:"paint"` (прозрачная поверхность
     * + маргин-поле, geometry и PNG из одной сессии) и боевой гейт `geometry` с
     * `layoutBounds`/`paintBounds`/`overflow.sources`. Режим доступен только на candidate-пути
     * приёмки — на публичных screenshot-ручках `probe` остаётся `geometry`.
     */
    geometryPaint: z.boolean(),
    /**
     * Deterministic Capture Readiness (план 2026-08-03 §5 W4): капчур-поверхность исполняет
     * версионированную политику readiness (used-faces шрифты, декод изображений, network-quiet по
     * ресурсам компонента, стабильные кадры, выключенные анимации) и публикует доказательство —
     * `fontFaces`/`images`/`pendingRequests`/`themeResources` — плюс отпечаток окружения.
     * В приёмке это обязательный гейт `readiness`: кадр с `met:false` не получает визуального и
     * геометрического вердикта (инвариант D5).
     */
    captureReadiness: z.boolean(),
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
    /** Запись композиций `version:3` разрешена (kill-switch D9, `EASYUI_COMPOSITION_V3=1`); иначе `422 composition_v3_disabled`. Чтение/раскрытие сохранённых v3 — всегда. */
    compositionV3: z.boolean(),
    /**
     * Матричная приёмка (план 2026-08-03 §5 W1a, `EASYUI_ACCEPTANCE_MATRIX=1`). Три флага —
     * один kill-switch, но разные подсистемы: кандидаты (`POST /api/components/:id/candidates`,
     * `GET /api/component-candidates/:id`), раны (`/api/acceptance-runs*`) и матрица целиком
     * (включая ссылки `candidateId`/`acceptanceRunId` в promote). Все false — ручек нет (404).
     */
    acceptanceMatrix: z.boolean(), acceptanceCandidates: z.boolean(), acceptanceRuns: z.boolean(),
    /** `PUT /api/components/:id/provenance` — правка Figma-ссылки без ревизии и версии (RFC R3a); kill-switch'а нет. */
    acceptanceProvenance: z.boolean(),
    /** `POST /api/components/:id/case-sets/validate` — dry-run манифеста без записи (план 2026-08-04 §W6, C23). */
    caseSetValidate: z.boolean(),
    /** `promote` принимает `acceptanceRunIds[]` — набор ранов шардированной семьи (план 2026-08-04 §W7, C23). */
    acceptanceMultiRunPromote: z.boolean(),
    /**
     * `GET /api/acceptance-runs/{runId}?view=summary` — компактная сводка рана (план 2026-08-04
     * §W8, C23). Проверять флаг обязан клиент **до** запроса: сервер прошлых волн молча
     * игнорирует незнакомый query и отдаёт полный ран, поэтому вторая проверка — маркер
     * `view:"summary"` в теле ответа.
     */
    acceptanceSummaryView: z.boolean(),
    /**
     * `cases[].slotBindings` в case-set-манифесте (план 2026-08-05 §A9): дети именованных и
     * default-слота с точным пином версии. Сборка до этой волны отвергает такой манифест как
     * `422 validation_failed` (strictObject), поэтому флаг читается **до** публикации набора.
     */
    caseSetSlotBindings: z.boolean(),
    /**
     * `candidateOverrides` у `POST /prototypes/:id/screens/:screenId/screenshot` (план 2026-08-05
     * §B3): подмена пина уже опубликованного компонента бандлом кандидата, только байты, без
     * ассета и без вердикта. Гаснет двумя ключами — `EASYUI_ACCEPTANCE_MATRIX=0` и
     * `EASYUI_VALIDATE_DISABLED=1`; выключенная фича отвечает на `candidateOverrides` `404`.
     */
    prototypeCandidateOverlay: z.boolean(),
    /** `figma.sources[]` — дополнительные Figma-документы lineage (план 2026-08-06 §W1). */
    figmaMultiSource: z.boolean(),
    /** Layout bounds v2: живой текст + нисходящий clip-стек; версия — `acceptance.geometryContractVersion` (план 2026-08-06 §W2). */
    geometryContractV2: z.boolean(),
    /** `policy.perCase.sizeDeltaPx`/`overflowBudgetPx` — per-case вердиктные допуски (план 2026-08-06 §W3). */
    geometryCaseTolerances: z.boolean(),
    /** `cases[].comparison.matte` — матирование обеих картинок до метрик (план 2026-08-06 §W4). Пресеты — `textAaPresets`. */
    comparisonMatte: z.boolean(),
    /** Вложенные `cases[].slotBindings` (план 2026-08-06 §W6; лимиты `caseSetMaxSlotDepth/Nodes`). */
    nestedSlotBindings: z.boolean(),
    /** Overlay v2: maxHeight на всех placement + prop `scroll`; composition-токены `maxHeight:"viewport"`/`scroll` (план 2026-08-06 §W5). */
    overlayScrollOwnership: z.boolean(),
    /** `capture.surface:"viewport"` в case-set (план 2026-08-06 §W5). */
    captureViewportSurface: z.boolean(),
    /**
     * Четыре поверхности геометрии случая (план 2026-08-07 §W1a): `expectedSurfaces`,
     * `comparisonSurface`, `clipExpectation` и per-surface вердикты. Список поверхностей —
     * `acceptance.comparisonSurfaces`; `acceptance.geometryContractVersion` при этом **остаётся 2**
     * (замеры аддитивны, кадры не инвалидируются). false — при `EASYUI_GEOMETRY_SURFACES_DISABLED=1`
     * (вердикт целиком на легаси-ветке) либо без матричной приёмки.
     */
    geometrySurfacesV3: z.boolean(),
    /**
     * Детерминированный барьер ресурсов — readiness v3 (план 2026-08-07 §W2): оба профиля приёмки,
     * режим `reference` и опт-ин галерейной джобы `readiness:"barrier"`. Матрицей не гейтится.
     * false — при `EASYUI_RESOURCE_BARRIER_DISABLED=1`: каждый профиль возвращается в **свою**
     * доволновую политику, а опт-ин остаётся валидным no-op'ом. Чем снято — в
     * `acceptance.readinessPolicyVersion`.
     */
    resourceBarrier: z.boolean(),
    /**
     * `candidateOverlay` в case-set-манифесте и overlay-форма slot-ребёнка (план 2026-08-07 §W3) —
     * единственная durable-поверхность приёмки графа неопубликованных зависимостей. Гаснет матрицей
     * и `EASYUI_CANDIDATE_OVERLAY_DISABLED=1` (`422 candidate_overlay_disabled`).
     */
    candidateDependencyOverlay: z.boolean(),
    /**
     * `suggestedPolicy` в отчёте рана и advisory `policy_exception_stale` (план 2026-08-07 §W7).
     * Report-only: вердикт и promote от флага не зависят. false — при
     * `EASYUI_SUGGESTED_POLICY_DISABLED=1` либо без матричной приёмки.
     */
    suggestedPolicy: z.boolean(),
    /** `/api/figma-source-packages*` и ссылка `figma.sourcePackageId` (план 2026-08-07 §W8); false при `EASYUI_SOURCE_PACKAGE_DISABLED=1`. */
    figmaSourcePackage: z.boolean(),
    /**
     * Хост применяет Zod-дефолты схемы к props компонента, объявившего
     * `definition.capabilities.runtimeSchemaDefaults` (план 2026-08-07 §W9). Флаг отвечает
     * «применяются ли дефолты сейчас», а не «умеет ли образ»: `EASYUI_RUNTIME_DEFAULTS_DISABLED=1` —
     * аварийный render-affecting kill-switch, при котором приёмка флагнутых семей недействительна.
     */
    runtimeSchemaDefaults: z.boolean(),
    /** Сводка подавленного шума капчура: `quality.suppressedCount` + `console.suppressed[]` (план 2026-08-07 §W10); kill-switch'а нет. */
    captureNoiseSummary: z.boolean(),
    /** `POST /api/prototypes/:id/snap-plan` — импакт-план галерейной съёмки (план 2026-08-07 §W5); false при `EASYUI_IMPACTED_SNAP_DISABLED=1`. */
    impactedSnap: z.boolean(),
    /** Сага миграционного коммита `/api/migration-commits*` (план 2026-08-07 §W4); гаснет матрицей и `EASYUI_MIGRATION_COMMIT_DISABLED=1`. */
    migrationCommit: z.boolean(),
    /**
     * `POST /api/acceptance-runs/:runId/resume` — продолжение остановленного рана **новым** раном
     * (BR-06, план 2026-08-08 §6); гаснет матрицей и `EASYUI_ACCEPTANCE_RESUME_DISABLED=1`.
     * Наблюдаемость той же волны (per-case `error`, шов allocate-renderer, circuit breaker) от
     * флага не зависит — это фиксы дефектов, а не фича.
     */
    acceptanceResumeV1: z.boolean(),
    /**
     * `blockerFingerprint` терминального рана и read-only
     * `GET /api/acceptance-runs/:runId/retry-disposition` (BR-10a, план 2026-08-08 §10); гаснет
     * матрицей и `EASYUI_BLOCKER_FINGERPRINT_DISABLED=1`. Слой полностью read-only: ни вердиктов,
     * ни отпечатков случаев, ни evidence он не меняет — только отвечает, стоит ли повторять.
     */
    blockerFingerprintV1: z.boolean(),
    /**
     * Версия схемы агентской квитанции драйвера (`envelope`, план 2026-08-07 §1.4, W6b) —
     * **число**, а не булев флаг: конверт существует всегда, вопрос только в том, какую его
     * форму понимает эта пара «сервер × харнес». Растёт лишь при несовместимом изменении самого
     * конверта; новые ключи внутри `summary` версию не двигают.
     */
    receiptEnvelopeVersion: z.number().int().positive(),
    /**
     * Единый резолвер схемы published component на save/readiness (план 2026-08-08 §1, BR-01a):
     * пины композиции — только на её раскрытие, `track:head` резолвит голову в ДС закреплённой
     * версии, неизвестный prop — `component_prop_unknown` с `resolvedVersion`/`sourceHash`/
     * `propsSchemaHash`/`catalogRevision`/`acceptedKeys`. Матрицей не гейтится; false — при
     * `EASYUI_SCHEMA_RESOLVER_V2_DISABLED=1` (доволновая семантика byte-for-byte).
     */
    prototypeSchemaResolverV2: z.boolean(),
    /** Контрактная версия этого резолвера: 2 — волна BR-01a, 1 — доволновой путь под kill-switch. */
    prototypeSchemaResolverVersion: z.number().int().positive(),
    /**
     * Поле краски случая **по сторонам** (`cases[].paintPaddingPx`, план 2026-08-08 §2, BR-02):
     * кадровый слой ровно того случая, который его объявил, — соседние кейсы набора не
     * переснимаются. Канву сравнения поле не двигает: кандидатский растр приводится к ней окном.
     * Матрицей не гейтится; false — при `EASYUI_CAPTURE_V4_DISABLED=1`
     * (`422 capture_padding_disabled` на PUT набора). Потолки — `limits.captureMaxPaintPaddingPx`
     * и `limits.captureFrameBudgetMpx`.
     */
    paintCapturePaddingV1: z.boolean(),
    /**
     * Точная канва content-hug сравнения (план 2026-08-08 §4, BR-04): при объявленной канве
     * размеры сводятся **точно** (delta 0, без неявного zero-pad), бюджет судится по поверхности
     * сравнения (`rawDiffPctOfSurface`), эталон не того масштаба — `reference_scale_mismatch`.
     * Общий kill-switch с `paintCapturePaddingV1`: `EASYUI_CAPTURE_V4_DISABLED=1`.
     */
    exactContentHugCanvasV1: z.boolean(),
    /**
     * Полный registry-resource barrier (план 2026-08-08 §3, BR-03): фаза `registry`, каналы
     * srcset/псевдоэлементов/шрифтов/`icon-registry`, ожидаемый манифест ассетов кандидата,
     * пер-ресурсные записи и сужение вердикта до `indeterminate` (`resource_barrier_incomplete`)
     * на барьерных причинах. Матрицей не гейтится; false — под любым из двух свитчей
     * (`EASYUI_RESOURCE_BARRIER_DISABLED=1`, `EASYUI_RESOURCE_BARRIER_V4_DISABLED=1`).
     */
    /**
     * Decoration-aware geometry (план 2026-08-08 §5, BR-05): факты замера узлов вне потока
     * (`preTransformBounds`, матрица, post-transform краска, причины участия в поверхностях),
     * авто-правило decoration (прозрачность для `rootBounds`, неблокирующая краска) и per-case
     * `cases[].geometryOwnership` (слой `frame`+`verdict`, `geometryContractVersion: 3`).
     * Матрицей не гейтится; false — при `EASYUI_GEOMETRY_OWNERSHIP_DISABLED=1`
     * (`422 geometry_ownership_disabled` на PUT набора, доволновая семантика byte-for-byte).
     */
    geometryDecorationOwnershipV1: z.boolean(),
    /**
     * Владение переливом FlowRoot (план 2026-08-08 §9, BR-09): `elements[].overflowOwnership`
     * (и composition layout-токен), вклад поддерева по объявленной оси ограничен scrollport'ом,
     * факты `overflowOwners`, коды `unowned-overflow`/`owned-overflow-exceeds-axis`. Общий
     * kill-switch с `geometryDecorationOwnershipV1`; false ⇒ `422 flow_overflow_ownership_disabled`
     * на записи документа с полем (чтение stored-документов не гейтится).
     */
    flowOverflowOwnershipV1: z.boolean(),
    resourceBarrierV4: z.boolean(),
    /** Фактическая версия политики барьера этого инстанса: `4` / `3` (v4-свитч) / `1` (барьера нет). */
    resourceBarrierPolicyVersion: z.number().int().positive(),
  }),
  /**
   * Именованные пресеты live-text AA-бюджета (план 2026-08-06 §W4): значения владеет сервер,
   * манифест выбирает имя (`cases[].textAaBudget`). Пороги публикуются для воспроизводимости.
   */
  textAaPresets: z.record(z.string(), z.object({
    maxRawDiffPct: z.number(), minEdgeResidualPct: z.number(),
  })),
  /**
   * Фаза гейта переиспользования. Читается агентом **до** `POST /api/components`: в `shadow`
   * запрос без `intent` проходит с предупреждением, в `enforce` — падает `400 invalid_request`.
   * `policyVersion` совпадает с `/api/catalog/candidates` и с записями аудита.
   */
  /**
   * Политики приёмки (план 2026-08-04 W3): что примет постановка рана и под каким профилем
   * вердикт допускает promote. `promotionPolicyProfiles` — единственный способ узнать состав
   * promotion-policy до вызова; ран под профилем вне множества отвергается
   * `422 acceptance_policy_mismatch`.
   */
  acceptance: z.object({
    policyProfiles: z.array(z.string()),
    defaultPolicyProfile: z.string(),
    promotionPolicyProfiles: z.array(z.string()),
    /** Версия контракта измерения геометрии — кадровый вход frameFingerprint (план 2026-08-06 §1.3). */
    geometryContractVersion: z.number().int().positive(),
    /**
     * Поверхности геометрии случая (план 2026-08-07 §W1a): что принимают `expectedSurfaces` и
     * `comparisonSurface` манифеста. Порядок совпадает с `divergingSurfaces[]` вердикта.
     */
    comparisonSurfaces: z.array(z.enum(GEOMETRY_SURFACES)),
    /**
     * Версия readiness-политики дефолтного профиля приёмки (план 2026-08-07 §W2/§1.5) — чем этот
     * инстанс реально снимает кадры: `3` — строгая политика плюс барьер ресурсов. При
     * `EASYUI_RESOURCE_BARRIER_DISABLED=1` здесь честно доволновое значение профиля
     * (`default-v1` → `1`; `pixel-strict-v1` откатывается в `2`, поэтому одно число на всех соврало бы).
     */
    readinessPolicyVersion: z.number().int().positive(),
  }),
  /** Объявленный рендерер этой сборки (план renderer-contract-2 §5 R1). */
  renderer: rendererReportSchema,
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
