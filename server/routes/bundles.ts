import type { Database } from "bun:sqlite";
import { ApiError, json, noStore } from "../http";
import { BundleClosure } from "../bundle/exporter";
import { bundleReuseOverrideSchema, importBundle, type BundleReuseOverride, type ImportMode } from "../bundle/importer";
import { importBundleQuerySchema, parseQuery } from "../contracts";
import { DEFAULT_REUSE_GATE_MODE, type ReuseGateMode } from "../catalog/gate";
import type { Principal } from "../auth";
import { requireUser } from "../authorization";

const UPLOAD_CAP = 256 * 1024 * 1024;

interface BundleUpload { bytes: Uint8Array; override?: BundleReuseOverride }

/**
 * Reads the uploaded ZIP from a multipart `file` field or a raw application/zip body.
 *
 * Тело запроса импорта — сам архив, поэтому вторая фаза override (план §3.7, D9) едет
 * multipart-полем `reuseOverride` с JSON: у `application/zip` места для него нет by design.
 */
async function readBundleUpload(request: Request): Promise<BundleUpload> {
  const contentType = (request.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > UPLOAD_CAP) throw new ApiError(413, "payload_too_large", `Bundle exceeds ${UPLOAD_CAP} bytes`);
  if (contentType === "multipart/form-data") {
    const form = await request.formData();
    const values = [...form.values()] as unknown[];
    const files = values.filter((value): value is Blob => typeof value === "object" && value !== null && value instanceof Blob);
    if (files.length !== 1) throw new ApiError(400, "invalid_bundle", "multipart upload must contain exactly one file");
    const bytes = new Uint8Array(await files[0]!.arrayBuffer());
    const raw = form.get("reuseOverride");
    if (typeof raw !== "string" || raw.trim() === "") return { bytes };
    let json: unknown;
    try { json = JSON.parse(raw); }
    catch { throw new ApiError(400, "invalid_request", "reuseOverride must be a JSON object"); }
    const parsed = bundleReuseOverrideSchema.safeParse(json);
    if (!parsed.success) throw new ApiError(400, "invalid_request", "reuseOverride is invalid", { issues: parsed.error.issues });
    return { bytes, override: parsed.data };
  }
  if (contentType === "application/zip" || contentType === "application/x-zip-compressed") return { bytes: new Uint8Array(await request.arrayBuffer()) };
  throw new ApiError(415, "unsupported_media_type", "Content-Type must be multipart/form-data or application/zip");
}

// Binary ZIP response (precedent: component bundle.js). Attachment + no-store; the archive is a
// fresh materialization of the export closure and must not be cached by intermediaries.
export function zipResponse(bytes: Uint8Array, filename: string): Response {
  return new Response(bytes as unknown as BodyInit, {
    headers: { ...noStore, "content-type": "application/zip", "content-disposition": `attachment; filename="${filename}"` },
  });
}

/** Dispatches /api/bundles/* (bulk export today; import lands in T3). Returns null for other paths. */
export async function routeBundles(request: Request, db: Database, segments: string[], principal: Principal, dataDir: string, reuseGateMode: ReuseGateMode = DEFAULT_REUSE_GATE_MODE): Promise<Response | null> {
  if (segments[0] !== "bundles") return null;
  if (segments[1] === "export" && segments.length === 2) {
    if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    const actor = requireUser(principal);
    const origin = new URL(request.url).origin;
    const closure = new BundleClosure(db, dataDir);
    const prototypeIds = db.query("SELECT id FROM prototypes WHERE owner_id=? ORDER BY id").all(actor.userId) as { id: string }[];
    for (const { id } of prototypeIds) closure.addOwnedPrototype(id);
    const componentIds = db.query("SELECT id FROM components WHERE owner_id=? AND deleted_at IS NULL ORDER BY id").all(actor.userId) as { id: string }[];
    for (const { id } of componentIds) closure.addComponent(id);
    // Композиции — такой же owned-ресурс, как компоненты: последняя active-версия, иначе head draft.
    const compositionIds = db.query("SELECT id FROM compositions WHERE owner_id=? AND deleted_at IS NULL ORDER BY id").all(actor.userId) as { id: string }[];
    for (const { id } of compositionIds) closure.addComposition(id);
    const bytes = await closure.buildZip("bulk", origin);
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    return zipResponse(bytes, `easy-ui-export-${stamp}.zip`);
  }
  if (segments[1] === "import" && segments.length === 2) {
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    const actor = requireUser(principal);
    const { mode } = parseQuery(importBundleQuerySchema, new URL(request.url).searchParams);
    const upload = await readBundleUpload(request);
    // Админский барьер ровно на override, а не на импорт: обычный импорт остаётся правом
    // любого пользователя, но force-new мимо гейта — решение администратора (план §3.7, A6).
    if (upload.override !== undefined && !actor.isAdmin) throw new ApiError(403, "admin_required", "Only an admin may override the reuse gate");
    const report = await importBundle(db, dataDir, upload.bytes, actor.userId, (mode ?? "apply") as ImportMode, {
      mode: reuseGateMode, isAdmin: actor.isAdmin, ...(upload.override === undefined ? {} : { override: upload.override }),
    });
    return json(report, 200, noStore);
  }
  return null;
}
