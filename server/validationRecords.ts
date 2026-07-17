import type { Database } from "bun:sqlite";
import type { ValidationIssue } from "../src/prototype/types";

// Audit label for the validator/catalog semantics that produced each record.
// `validatedRevision` intentionally reports the latest passing record across all
// validator versions; it is revision history, not a current-version cache.
export const VALIDATOR_VERSION = "v3";

export type ValidationResourceType = "prototype" | "component";

export function recordValidation(
  db: Database,
  entry: { resourceType: ValidationResourceType; resourceId: string; rev: number; catalogHash: string; ok: boolean; issues: ValidationIssue[] },
): void {
  db.query(`INSERT INTO validation_records
    (resource_type,resource_id,rev,validator_version,catalog_hash,ok,issues_json,created_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(entry.resourceType, entry.resourceId, entry.rev, VALIDATOR_VERSION, entry.catalogHash, entry.ok ? 1 : 0, JSON.stringify(entry.issues), new Date().toISOString());
}

// Latest revision that produced a passing validation record, or null when none exists.
export function latestValidatedRev(db: Database, resourceType: ValidationResourceType, resourceId: string): number | null {
  const row = db.query(`SELECT MAX(rev) rev FROM validation_records
    WHERE resource_type=? AND resource_id=? AND ok=1`).get(resourceType, resourceId) as { rev: number | null };
  return row.rev;
}
