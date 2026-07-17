import { expect, test } from "bun:test";
import { openDatabase } from "./db";
import { latestValidatedRev, recordValidation, VALIDATOR_VERSION } from "./validationRecords";

test("latestValidatedRev includes passing audit records from older validator versions", () => {
  const db = openDatabase(":memory:");
  try {
    db.query(`INSERT INTO validation_records
      (resource_type,resource_id,rev,validator_version,catalog_hash,ok,issues_json,created_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run("prototype", "audit-history", 7, "v2", "old-catalog", 1, "[]", "2026-07-16T00:00:00.000Z");
    recordValidation(db, {
      resourceType: "prototype",
      resourceId: "audit-history",
      rev: 6,
      catalogHash: "current-catalog",
      ok: true,
      issues: [],
    });

    expect(VALIDATOR_VERSION).toBe("v3");
    expect(latestValidatedRev(db, "prototype", "audit-history")).toBe(7);
  } finally {
    db.close();
  }
});
