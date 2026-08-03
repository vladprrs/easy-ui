import type { Database } from "bun:sqlite";
import { ApiError } from "./http";

export interface MaintenanceLock {
  runId: string;
  reason: string;
  acquiredAt: string;
}

export function currentMaintenanceLock(db: Database): MaintenanceLock | null {
  const row = db.query("SELECT run_id runId,reason,acquired_at acquiredAt FROM maintenance_locks WHERE id=1")
    .get() as MaintenanceLock | null;
  return row;
}

/**
 * Держится ли lock прямо сейчас. Постановка acceptance-рана обязана отказать 503 при удержанном
 * lock'е (план §4, мера 8) — сам отказ живёт в роуте, а знание о lock'е остаётся здесь.
 */
export function maintenanceLockHeld(db: Database): boolean {
  return currentMaintenanceLock(db) !== null;
}

export function acquireMaintenanceLock(db: Database, runId: string, reason: string): MaintenanceLock {
  const normalizedReason = reason.trim() || "catalog migration";
  return db.transaction(() => {
    // Обратная сторона той же меры (§4.8): миграция каталога не начинается поверх живого
    // acceptance-рана — иначе она переписывала бы каталог под уже снятыми кадрами.
    const activeRun = db.query("SELECT run_id runId FROM acceptance_runs WHERE status IN ('queued','running') LIMIT 1")
      .get() as { runId: string } | null;
    if (activeRun) {
      throw new ApiError(503, "acceptance_run_in_flight", "An acceptance run is in flight; retry the migration after it finishes", { runId: activeRun.runId, retryAfterSeconds: 30 });
    }
    const current = currentMaintenanceLock(db);
    if (current) {
      // A lock is an ownership token, not a lease that may be refreshed by a
      // second caller. In particular, allowing the same run id to replace the
      // row would let a concurrent invocation release the first invocation's
      // lock in its finally block.
      throw new ApiError(503, "maintenance_in_progress", "Another catalog migration is already in progress", { runId: current.runId, retryAfterSeconds: 5 });
    }
    const acquiredAt = new Date().toISOString();
    const inserted = db.query("INSERT INTO maintenance_locks (id,run_id,reason,acquired_at) VALUES (1,?,?,?) ON CONFLICT(id) DO NOTHING")
      .run(runId, normalizedReason, acquiredAt);
    if (inserted.changes !== 1) {
      const owner = currentMaintenanceLock(db);
      throw new ApiError(503, "maintenance_in_progress", "Another catalog migration is already in progress", { runId: owner?.runId, retryAfterSeconds: 5 });
    }
    return { runId, reason: normalizedReason, acquiredAt };
  }).immediate();
}

/** Release only the exact lock acquired by this operation when a token is supplied. */
export function releaseMaintenanceLock(db: Database, runId: string, acquiredAt?: string): boolean {
  const result = acquiredAt === undefined
    ? db.query("DELETE FROM maintenance_locks WHERE id=1 AND run_id=?").run(runId)
    : db.query("DELETE FROM maintenance_locks WHERE id=1 AND run_id=? AND acquired_at=?").run(runId, acquiredAt);
  return result.changes > 0;
}

/** Fail closed if the database lock changed while a protected operation was running. */
export function assertMaintenanceLockOwner(db: Database, lock: MaintenanceLock): void {
  const current = currentMaintenanceLock(db);
  if (!current || current.runId !== lock.runId || current.acquiredAt !== lock.acquiredAt) {
    throw new ApiError(409, "maintenance_lock_lost", "Catalog migration lost its maintenance lock", {
      runId: lock.runId,
    });
  }
}

/**
 * Reads continue during cutover. Only unsafe requests are blocked, and the
 * migration endpoint itself is allowed to finish/abort the active run.
 */
export function assertMutationAllowed(db: Database, method: string, pathname: string): void {
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return;
  if (pathname === "/api/catalog/migrations" || pathname.startsWith("/api/catalog/migrations/")) return;
  const lock = currentMaintenanceLock(db);
  if (!lock) return;
  throw new ApiError(503, "maintenance_in_progress", "Writes are temporarily paused for a catalog migration", {
    runId: lock.runId,
    retryAfterSeconds: 5,
  });
}
