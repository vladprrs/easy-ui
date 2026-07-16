import type { Database } from "bun:sqlite";
import type { ValidationIssue } from "../src/prototype/types";

// Bumped whenever the semantic validator or its catalog descriptor changes shape.
// `validatedRevision` in meta responses reflects records written by this version.
export const VALIDATOR_VERSION = "v2";

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
