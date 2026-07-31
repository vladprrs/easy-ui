import type { Database } from "bun:sqlite";
import type { Principal } from "../auth";
import { requireUser } from "../authorization";
import { ApiError, json, noStore, readJson } from "../http";
import { auditCatalog } from "../catalog/audit";
import { createCatalogMigrationPlan, type CatalogMigrationPlan } from "../catalog/migrationPlan";
import { applyMigration, catalogBackupPath, prepareMigration, restoreCatalogBackup } from "../migrationRunner";

function requireAdmin(principal: Principal): ReturnType<typeof requireUser> {
  const user = requireUser(principal);
  if (!user.isAdmin) throw new ApiError(403, "admin_required", "Only an administrator may operate catalog migrations");
  return user;
}

function parsePlan(value: unknown): CatalogMigrationPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "invalid_request", "Migration plan must be an object");
  try {
    const input = value as Omit<CatalogMigrationPlan, "version"> & { version?: unknown };
    if (input.version !== 1) throw new Error("version must be 1");
    return createCatalogMigrationPlan({
      generatedAt: input.generatedAt,
      catalogRevision: input.catalogRevision,
      dataFingerprint: input.dataFingerprint,
      groups: input.groups,
      compositionConversions: input.compositionConversions,
      metadataRevisions: input.metadataRevisions,
      documentedExceptions: input.documentedExceptions,
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, "validation_failed", `Migration plan is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Admin-only, read-only audit and staged migration control surface. */
export async function routeCatalogMigrations(request: Request, db: Database, segments: string[], principal: Principal, dataDir: string): Promise<Response> {
  const admin = requireAdmin(principal);
  const tail = segments.slice(1);
  if (request.method === "GET" && tail.length === 1 && tail[0] === "audit") return json(auditCatalog(db), 200, noStore);
  if (request.method === "GET" && tail.length === 0) {
    const runs = db.query(`SELECT id,plan_hash planHash,catalog_revision catalogRevision,data_fingerprint dataFingerprint,status,
      generated_at generatedAt,started_at startedAt,completed_at completedAt,backup_id backupId,reason
      FROM catalog_migration_runs ORDER BY generated_at DESC,id DESC`).all();
    return json({ runs }, 200, noStore);
  }
  if (request.method === "POST" && tail.length === 1 && tail[0] === "prepare") {
    const plan = parsePlan(await readJson(request));
    return json(prepareMigration(db, plan), 201, noStore);
  }
  if (request.method === "POST" && tail.length === 2 && tail[1] === "apply") {
    const plan = parsePlan(await readJson(request));
    // The cutover image is retained on disk, not only in this process: a rollback may
    // be requested after a restart or a redeploy (design §10).
    const backupId = `sqlite-cutover-${tail[0]!}`;
    applyMigration(db, plan, tail[0]!, { actorId: admin.userId, backupId, backupPath: catalogBackupPath(dataDir, backupId) });
    return json({ runId: tail[0], status: "applied", backupId }, 200, noStore);
  }
  if (request.method === "POST" && tail.length === 2 && tail[1] === "rollback") {
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "invalid_request", "Rollback request must be an object");
    const input = body as { backupId?: unknown; reason?: unknown };
    if (input.backupId !== undefined && typeof input.backupId !== "string") throw new ApiError(422, "validation_failed", "backupId must be a string");
    if (input.reason !== undefined && typeof input.reason !== "string") throw new ApiError(422, "validation_failed", "reason must be a string");
    const recorded = db.query("SELECT backup_id backupId FROM catalog_migration_runs WHERE id=?").get(tail[0]!) as { backupId: string | null } | null;
    const backupId = input.backupId as string | undefined ?? recorded?.backupId;
    if (!backupId) throw new ApiError(404, "migration_backup_not_found", "Migration run has no retained cutover backup");
    const result = restoreCatalogBackup(db, tail[0]!, backupId, { actorId: admin.userId, reason: input.reason, dataDir });
    return json(result, 200, noStore);
  }
  throw new ApiError(405, "method_not_allowed", "Method not allowed");
}
