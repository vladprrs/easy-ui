import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../migrations";
import { ReuseDecisionRepo, type ReuseDecisionInput } from "./reuseDecisions";

const dbForRepo = () => { const db = new Database(":memory:"); migrate(db); return db; };

const input = (over: Partial<ReuseDecisionInput> = {}): ReuseDecisionInput => ({
  actorId: "user_alice",
  artifactKind: "component",
  artifactId: "yp-proposed-badge",
  designSystem: "yandex-pay",
  sourceOrDocHash: "sha-source",
  catalogRevision: "rev-1",
  policyVersion: 1,
  gateMode: "enforce",
  intent: "Бейдж статуса заказа для карточки",
  candidates: [{ id: "yp-badge", score: 0.91, blocking: true, reasons: ["props_match"], propsDelta: { added: ["tone"] } }],
  decision: "blocked",
  ...over,
});

test("records a decision for a component id that was never created (no FK on artifact_id)", () => {
  const db = dbForRepo(); const repo = new ReuseDecisionRepo(db);
  const recorded = repo.record(input());
  expect(db.query("SELECT 1 ok FROM components WHERE id='yp-proposed-badge'").get()).toBeNull();
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  const stored = repo.get(recorded.id);
  expect(stored).toEqual(recorded);
  expect(stored?.candidates[0]?.propsDelta).toEqual({ added: ["tone"] });
  db.close();
});

test("the audit table is append-only: UPDATE and DELETE abort, the row survives", () => {
  const db = dbForRepo(); const repo = new ReuseDecisionRepo(db);
  const recorded = repo.record(input());
  expect(() => db.run("UPDATE catalog_reuse_decisions SET decision='accepted_no_match'")).toThrow();
  expect(() => db.query("UPDATE catalog_reuse_decisions SET reason='rewritten' WHERE id=?").run(recorded.id)).toThrow();
  expect(() => db.run("DELETE FROM catalog_reuse_decisions")).toThrow();
  expect(repo.get(recorded.id)?.decision).toBe("blocked");
  db.close();
});

test("shadow-phase decisions stay distinguishable and countable", () => {
  const db = dbForRepo(); const repo = new ReuseDecisionRepo(db);
  repo.record(input({ gateMode: "shadow", decision: "would_block" }));
  repo.record(input({ gateMode: "shadow", decision: "intent_missing", intent: null }));
  repo.record(input({ decision: "accepted_no_match", candidates: [] }));
  repo.record(input({ decision: "force_new", reason: "Новый компонент нужен для другого домена" }));
  expect(repo.countByDecision()).toEqual({ would_block: 1, intent_missing: 1, accepted_no_match: 1, force_new: 1 });
  expect(repo.list({ decision: ["would_block", "blocked"] }).map(row => row.decision)).toEqual(["would_block"]);
  expect(repo.list({ gateMode: "shadow" })).toHaveLength(2);
  expect(repo.list({ artifactId: "other" })).toEqual([]);
  db.close();
});

test("repeatedAttempts counts only blocking encounters of the same actor and artifact", () => {
  const db = dbForRepo(); const repo = new ReuseDecisionRepo(db);
  repo.record(input());
  repo.record(input({ gateMode: "shadow", decision: "would_block" }));
  repo.record(input({ decision: "accepted_no_match" }));
  repo.record(input({ actorId: "user_bob" }));
  repo.record(input({ artifactId: "yp-other" }));
  expect(repo.repeatedAttempts("user_alice", "yp-proposed-badge")).toBe(2);
  expect(repo.repeatedAttempts("user_bob", "yp-proposed-badge")).toBe(1);
  expect(repo.repeatedAttempts("user_carol", "yp-proposed-badge")).toBe(0);
  db.close();
});

test("record is safe inside a synchronous transaction and rolls back with it", () => {
  const db = dbForRepo(); const repo = new ReuseDecisionRepo(db);
  expect(() => db.transaction(() => { repo.record(input()); throw new Error("gate rejected"); })()).toThrow("gate rejected");
  expect(repo.list()).toEqual([]);
  db.close();
});

test("retention prunes old rows through the maintenance path and restores the append-only trigger", () => {
  const db = dbForRepo(); const repo = new ReuseDecisionRepo(db);
  const triggerSql = (db.query("SELECT sql FROM sqlite_master WHERE name='catalog_reuse_decisions_no_delete'").get() as { sql: string }).sql;
  const old = repo.record(input());
  const stale = repo.record(input({ artifactId: "yp-stale" }));
  expect(old.createdAt <= stale.createdAt).toBe(true);
  // Строку в append-only таблице нельзя состарить UPDATE-ом, поэтому «старым» её делает cutoff.
  const cutoff = new Date(Date.now() + 60_000).toISOString();

  const removed = repo.prune(cutoff, { actorId: "user_admin" });

  expect(removed).toBe(2);
  expect(repo.list()).toEqual([]);
  // Триггер вернулся побайтово тем же DDL и снова защищает таблицу.
  expect((db.query("SELECT sql FROM sqlite_master WHERE name='catalog_reuse_decisions_no_delete'").get() as { sql: string }).sql).toBe(triggerSql);
  const fresh = repo.record(input());
  expect(() => db.run("DELETE FROM catalog_reuse_decisions")).toThrow();
  expect(repo.get(fresh.id)).toBeDefined();
  // Удаление из append-only таблицы обязано оставить след.
  expect(db.query("SELECT actor_id,subject_id,detail FROM audit_events WHERE action='reuse.decisions.pruned'").get())
    .toEqual({ actor_id: "user_admin", subject_id: cutoff, detail: JSON.stringify({ removed: 2 }) });
  db.close();
});

test("prune keeps rows newer than the cutoff and refuses to run without the trigger", () => {
  const db = dbForRepo(); const repo = new ReuseDecisionRepo(db);
  const kept = repo.record(input());
  expect(repo.prune("2000-01-01T00:00:00.000Z")).toBe(0);
  expect(repo.get(kept.id)).toBeDefined();

  db.run("DROP TRIGGER catalog_reuse_decisions_no_delete");
  expect(() => repo.prune(new Date().toISOString())).toThrow(/trigger is missing/);
  db.close();
});
