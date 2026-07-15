import type { Database } from "bun:sqlite";
import { ApiError, immutable, json, noStore } from "../http";
import { MAX_ASSET_BYTES } from "../assets/validate";
import { AssetRepo, assetPublic, type AssetRow } from "../repos/assets";
import { assetUsageContract, listAssetsQuerySchema, parseQuery, parseWith } from "../contracts";

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

const ISO_CURSOR_PART = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ASSET_ID = /^asset_[0-9a-f]{64}$/;

function cursorBefore(value: string | null): { createdAt: string; id: string } | undefined {
  if (value === null) return undefined;
  if (value.length > 128) throw new ApiError(400, "invalid_cursor", "Cursor is malformed");
  const parts = value.split("~");
  const createdAt = parts[0] ?? "";
  const id = parts[1] ?? "";
  if (parts.length !== 2 || !ISO_CURSOR_PART.test(createdAt) || !ASSET_ID.test(id)) {
    throw new ApiError(400, "invalid_cursor", "Cursor is malformed");
  }
  try {
    if (new Date(createdAt).toISOString() !== createdAt) throw new Error("non-canonical date");
  } catch {
    throw new ApiError(400, "invalid_cursor", "Cursor is malformed");
  }
  return { createdAt, id };
}

const assetMetadata = (row: AssetRow) => ({
  ...assetPublic(row),
  originalName: row.original_name,
  createdAt: row.created_at,
  url: `/api/assets/${row.id}`,
});

export async function routeAssets(request: Request, db: Database, segments: string[], dataDir: string): Promise<Response> {
  const repo = new AssetRepo(db, dataDir);
  if (segments.length === 1) {
    if (request.method === "GET") {
      const searchParams = new URL(request.url).searchParams;
      const before = cursorBefore(searchParams.get("cursor"));
      const { limit } = parseQuery(listAssetsQuerySchema, searchParams);
      const page = repo.list({ limit, before });
      return json({
        assets: page.assets.map((row) => ({
          ...assetMetadata(row),
          usage: {
            prototypes: row.prototypes,
            components: row.components,
            visualReferences: row.visualReferences,
            visualRuns: row.visualRuns,
          },
        })),
        nextCursor: page.nextCursor ? `${page.nextCursor.createdAt}~${page.nextCursor.id}` : null,
      }, 200, noStore);
    }
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    const upload = await readUpload(request);
    const { asset, deduplicated } = await repo.ingest(upload.bytes, upload.mime, upload.name);
    const body = { ...assetPublic(asset), url: `/api/assets/${asset.id}`, ...(deduplicated ? { deduplicated: true } : {}) };
    return json(body, deduplicated ? 200 : 201, deduplicated ? noStore : { ...noStore, location: `/api/assets/${asset.id}` });
  }
  const id = segments[1]!;
  if (segments.length === 3 && segments[2] === "usage") {
    if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    parseWith(assetUsageContract.params!, { id }, "Path parameters are invalid");
    const usage = repo.usage(id);
    if (!usage) throw new ApiError(404, "asset_not_found", "Asset not found");
    return json({ ...usage, asset: assetMetadata(usage.asset) }, 200, noStore);
  }
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
