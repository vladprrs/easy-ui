import type { Database } from "bun:sqlite";
import { ApiError, noStore } from "../http";
import { BundleClosure } from "../bundle/exporter";
import type { Principal } from "../auth";
import { requireUser } from "../authorization";

// Binary ZIP response (precedent: component bundle.js). Attachment + no-store; the archive is a
// fresh materialization of the export closure and must not be cached by intermediaries.
export function zipResponse(bytes: Uint8Array, filename: string): Response {
  return new Response(bytes as unknown as BodyInit, {
    headers: { ...noStore, "content-type": "application/zip", "content-disposition": `attachment; filename="${filename}"` },
  });
}

/** Dispatches /api/bundles/* (bulk export today; import lands in T3). Returns null for other paths. */
export async function routeBundles(request: Request, db: Database, segments: string[], principal: Principal, dataDir: string): Promise<Response | null> {
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
    const bytes = await closure.buildZip("bulk", origin);
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    return zipResponse(bytes, `easy-ui-export-${stamp}.zip`);
  }
  return null;
}
