export type ErrorDetails = { issues?: unknown[]; warnings?: unknown[]; currentRev?: number; currentVersion?: number; currentStatusRev?: number; currentGeneration?: number | null; usages?: unknown; report?: unknown; blockers?: Record<string, number>; runId?: string; retryAfterSeconds?: number; catalogRevision?: string; dataFingerprint?: string; planHash?: string;
  /** RFC candidate-acceptance R1: фактический sha256 head-исходника в `409 source_hash_mismatch`. */
  sourceHash?: string;
  /**
   * RFC candidate-acceptance R3b: решение человека в конвертах `409 candidate_already_rejected`
   * (плоские `reason`/`actor`/`createdAt` — конфликт по самому кандидату) и `409 candidate_rejected`
   * (надгробие другой сборки той же ревизии: `candidateId` + вложенное `decision`).
   */
  reason?: string; actor?: string; createdAt?: string;
  candidateId?: string; decision?: { reason: string; actor: string; createdAt: string };
  /**
   * План 2026-08-04 W3: `422 acceptance_policy_mismatch` — под каким профилем исполнен ран и
   * какие профили допускают публикацию (`capabilities.acceptance.promotionPolicyProfiles`).
   */
  runPolicyProfileId?: string; allowed?: string[];
  /**
   * План 2026-08-07 §W3 (candidate dependency overlay): какой узел графа и какой его кандидат
   * не резолвится (`409 candidate_overlay_expired|evicted`, `422 candidate_overlay_*`), плюс
   * срок жизни кандидата в отказе по протуханию.
   */
  componentId?: string; expiresAt?: string;
  /**
   * План 2026-08-08 §1 (BR-01a): `422 component_pin_conflict` — имя типа, которое один документ
   * требует в двух версиях (пин раскрытой композиции против активной публикации авторского
   * элемента). Обе версии и пути элементов приезжают в `issues`; `componentId` — уже объявлен выше.
   */
  componentName?: string;
  /** План 2026-08-07 §W4: id саги в `409 migration_commit_in_flight`. */
  commitId?: string;
  /** `422 overlay_hash_mismatch` мультиран-promote: какие графы разошлись. */
  overlayHashes?: (string | null)[];
  /**
   * План 2026-08-04 W7 (multi-run promote): состав набора ранов и то, чем он несогласован —
   * разные профили (`policyProfileIds`), разные рендереры (`rendererFingerprints`), пересечение
   * покрытия (`overlap`/`overlapCount`) или несходящееся суммарное покрытие
   * (`expectedCases`/`coveredCases`/`runs`).
   */
  runIds?: string[]; policyProfileIds?: string[]; rendererFingerprints?: string[];
  overlap?: string[]; overlapCount?: number;
  expectedCases?: number; coveredCases?: number; runs?: unknown[];
  /**
   * План 2026-08-08 §8 (BR-08, субъектный promote): какой набор объявил владение
   * (`caseSetId`), какой половины контракта не хватает (`missing`), какие случаи мешают
   * (`cases`) и какие runtime-зависимости не имеют собственной приёмки (`dependencies`).
   */
  caseSetId?: string; missing?: string; cases?: unknown[]; dependencies?: unknown[] };

export class ApiError extends Error {
  constructor(public status: 400|401|403|404|405|409|413|415|422|429|501|503, public code: string, message: string, public details: ErrorDetails = {}) { super(message); }
}

// RFC 6901 JSON Pointer. Array paths are escaped segment-by-segment (~ -> ~0, / -> ~1);
// string paths that already look like a pointer are passed through unchanged.
export const toPointer = (path: unknown): string | undefined => {
  if (Array.isArray(path)) return "/" + path.map((seg) => String(seg).replace(/~/g, "~0").replace(/\//g, "~1")).join("/");
  if (typeof path === "string") return path === "" || path.startsWith("/") ? path : "/" + path;
  return undefined;
};
const withPointer = (issue: unknown): unknown => {
  if (!issue || typeof issue !== "object" || Array.isArray(issue)) return issue;
  const record = issue as Record<string, unknown>;
  if (!("path" in record) || "pointer" in record) return issue;
  const pointer = toPointer(record.path);
  return pointer === undefined ? issue : { ...record, pointer };
};

export const json = (body: unknown, status = 200, headers?: HeadersInit): Response => {
  const out = new Headers(headers); out.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers: out });
};
export const noStore = { "cache-control": "no-store" };
export const immutable = { "cache-control": "public, max-age=31536000, immutable" };
export const errorResponse = (error: unknown): Response => {
  if (error instanceof ApiError) {
    const details = { ...error.details };
    if (Array.isArray(details.issues)) details.issues = details.issues.map(withPointer);
    return json({ error: { code: error.code, message: error.message, ...details } }, error.status, noStore);
  }
  console.error(error);
  return json({ error: { code: "internal_error", message: "Internal server error" } }, 500, noStore);
};

// JSON request-body ceiling enforced by readJson (surfaced in /api/capabilities limits).
export const MAX_JSON_BODY_BYTES = 1_048_576;

export async function readJson(request: Request, maxBytes = MAX_JSON_BODY_BYTES): Promise<unknown> {
  const type = request.headers.get("content-type")?.split(";",1)[0]?.trim().toLowerCase();
  if (type !== "application/json") throw new ApiError(415, "unsupported_media_type", "Content-Type must be application/json");
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new ApiError(413, "payload_too_large", "Request body exceeds 1 MB");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new ApiError(413, "payload_too_large", "Request body exceeds 1 MB");
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new ApiError(400, "invalid_json", "Request body must be valid JSON"); }
}

export const requireMethod = (request: Request, allowed: string[]): void => {
  if (!allowed.includes(request.method)) throw new ApiError(405, "method_not_allowed", "Method not allowed");
};
