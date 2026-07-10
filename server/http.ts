export type ErrorDetails = { issues?: unknown[]; warnings?: unknown[]; currentRev?: number; currentVersion?: number };

export class ApiError extends Error {
  constructor(public status: 400|404|405|409|413|415|422, public code: string, message: string, public details: ErrorDetails = {}) { super(message); }
}

export const json = (body: unknown, status = 200, headers?: HeadersInit): Response => {
  const out = new Headers(headers); out.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers: out });
};
export const noStore = { "cache-control": "no-store" };
export const immutable = { "cache-control": "public, max-age=31536000, immutable" };
export const errorResponse = (error: unknown): Response => {
  if (error instanceof ApiError) return json({ error: { code: error.code, message: error.message, ...error.details } }, error.status, noStore);
  console.error(error);
  return json({ error: { code: "internal_error", message: "Internal server error" } }, 500, noStore);
};

export async function readJson(request: Request, maxBytes = 1_048_576): Promise<unknown> {
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
