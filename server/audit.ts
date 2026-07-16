import type { Database } from "bun:sqlite";

export type AuditInput = {
  actorId: string;
  action: string;
  subjectType: string;
  subjectId: string;
  detail?: unknown;
};

export function writeAuditEvent(db: Database, input: AuditInput): void {
  db.query(`INSERT INTO audit_events (id,at,actor_id,action,subject_type,subject_id,detail)
    VALUES (?,?,?,?,?,?,?)`).run(
    `audit_${crypto.randomUUID()}`,
    new Date().toISOString(),
    input.actorId,
    input.action,
    input.subjectType,
    input.subjectId,
    input.detail === undefined ? null : JSON.stringify(input.detail),
  );
}
