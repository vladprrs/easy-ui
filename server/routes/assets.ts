import type { Database } from "bun:sqlite";
import { ApiError, immutable, json, noStore } from "../http";
import { MAX_ASSET_BYTES } from "../assets/validate";
import { AssetRepo, assetPublic } from "../repos/assets";

// Hardened delivery headers for GET /api/assets/:id. Assets (incl. un-sanitized SVG) are served
// inert: no scripts, no navigation, same-origin only, behind the BasicAuth boundary.
const ASSET_SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
};

function tooLargeByHeader(request: Request): void {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES) throw new ApiError(413, "asset_too_large", `Asset exceeds ${MAX_ASSET_BYTES} bytes`);
}

async function readUpload(request: Request): Promise<{ bytes: Uint8Array; mime: string; name?: string }> {
  const contentType = (request.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
  tooLargeByHeader(request);
  if (contentType === "multipart/form-data") {
    const form = await request.formData();
    const values = [...form.values()] as unknown[];
    const files = values.filter((value): value is Blob => typeof value === "object" && value !== null && value instanceof Blob);
    if (files.length !== 1) throw new ApiError(422, "unsupported_asset_type", "multipart upload must contain exactly one file");
    const file = files[0]!;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > MAX_ASSET_BYTES) throw new ApiError(413, "asset_too_large", `Asset exceeds ${MAX_ASSET_BYTES} bytes`);
    const name = "name" in file && typeof (file as { name?: unknown }).name === "string" ? (file as { name: string }).name : undefined;
    return { bytes, mime: file.type, name: name || undefined };
  }
  if (!contentType) throw new ApiError(422, "unsupported_asset_type", "Content-Type is required for a raw asset upload");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_ASSET_BYTES) throw new ApiError(413, "asset_too_large", `Asset exceeds ${MAX_ASSET_BYTES} bytes`);
  return { bytes, mime: request.headers.get("content-type") ?? "" };
}

export async function routeAssets(request: Request, db: Database, segments: string[], dataDir: string): Promise<Response> {
  const repo = new AssetRepo(db, dataDir);
  if (segments.length === 1) {
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    const upload = await readUpload(request);
    const { asset, deduplicated } = await repo.ingest(upload.bytes, upload.mime, upload.name);
    const body = { ...assetPublic(asset), url: `/api/assets/${asset.id}`, ...(deduplicated ? { deduplicated: true } : {}) };
    return json(body, deduplicated ? 200 : 201, deduplicated ? noStore : { ...noStore, location: `/api/assets/${asset.id}` });
  }
  const id = segments[1]!;
  if (segments.length === 2) {
    if (request.method !== "GET" && request.method !== "HEAD") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    const row = repo.get(id);
    if (!row) throw new ApiError(404, "asset_not_found", "Asset not found");
    const file = Bun.file(repo.bytesPath(row.sha256));
    if (!(await file.exists())) throw new ApiError(404, "asset_not_found", "Asset bytes are missing");
    const headers = { ...immutable, ...ASSET_SECURITY_HEADERS, "content-type": row.mime };
    if (request.method === "HEAD") return new Response(null, { headers: { ...headers, "content-length": String(row.size) } });
    return new Response(file, { headers });
  }
  throw new ApiError(404, "not_found", "API route not found");
}
