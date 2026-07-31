import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "./db";
import { createHandler } from "./main";
import { createTestHandler } from "./test-auth";
import { BOOTSTRAP_ADMIN_ID, UserRepo } from "./users";
import { ReuseDecisionRepo, type ReuseDecisionInput } from "./repos/reuseDecisions";
import { routeReuseDecisions } from "./routes/reuseDecisions";
import { reuseAuditResponseSchema } from "./contracts";
import type { ApiError } from "./http";

/**
 * `GET /api/catalog/reuse-decisions` — админское чтение аудита гейта (спека §5, план §4 T10).
 *
 * Решения сидятся через репозиторий, а не через настоящий гейт: гейт на каждое создание
 * платит extract+typecheck в подпроцессе, а проверяемое здесь зависит только от строк
 * `catalog_reuse_decisions` и каталожных таблиц.
 */

const at = (seconds: number) => new Date(Date.UTC(2026, 6, 31, 12, 0, seconds)).toISOString();

let db: Database;
let handler: (request: Request) => Promise<Response>;

function seedSystem(id: string): void {
  db.query("INSERT INTO design_systems (id,name,description,builtin_provider,created_at,updated_at,owner_id,retired) VALUES (?,?,?,NULL,?,?,?,0)")
    .run(id, `System ${id}`, `seeded ${id}`, at(0), at(0), BOOTSTRAP_ADMIN_ID);
}

function seedComponent(id: string, designSystem: string, createdAt: string): void {
  db.query("INSERT INTO components (id,name,head_rev,design_system,deleted_at,created_at,updated_at,owner_id) VALUES (?,?,1,?,NULL,?,?,?)")
    .run(id, id.replace(/-/g, ""), designSystem, createdAt, createdAt, BOOTSTRAP_ADMIN_ID);
  db.query("INSERT INTO component_revisions (component_id,rev,source,design_system,figma_json,message,created_at) VALUES (?,1,?,?,NULL,NULL,?)")
    .run(id, "export const definition={}", designSystem, createdAt);
}

const decision = (over: Partial<ReuseDecisionInput> = {}): ReuseDecisionInput => ({
  actorId: "user_alice",
  artifactKind: "component",
  artifactId: "yp-proposed-badge",
  designSystem: "audit-ds",
  sourceOrDocHash: "sha-source",
  catalogRevision: "rev-1",
  policyVersion: 1,
  gateMode: "enforce",
  intent: "Бейдж статуса заказа для карточки",
  candidates: [{ id: "yp-badge", score: 0.91, blocking: true, reasons: ["same props/events/slots signature"] }],
  decision: "blocked",
  ...over,
});

/** Полный набор материала §5: force-new, повторы, конфликт роли, would_block, неревьюленные. */
function seedAudit(): ReuseDecisionRepo {
  const repo = new ReuseDecisionRepo(db);
  repo.record(decision());
  repo.record(decision());
  repo.record(decision({ actorId: "user_bob", artifactId: "yp-other-badge" }));
  repo.record(decision({ gateMode: "shadow", decision: "would_block" }));
  repo.record(decision({ gateMode: "shadow", decision: "would_block", actorId: "user_bob", artifactId: "yp-shadow-card" }));
  repo.record(decision({ decision: "force_new", actorId: "user_admin", reason: "Approved: a separate owner needs an independent lifecycle" }));
  repo.record(decision({ decision: "accepted_no_match", candidates: [] }));
  repo.record(decision({ artifactId: "yp-role-clash", reason: "canonical_role_conflict:payment-success, order-status" }));
  return repo;
}

async function read(query = ""): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handler(new Request(`http://test/api/catalog/reuse-decisions${query}`));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeEach(() => {
  db = openDatabase(":memory:");
  handler = createTestHandler(db) as (request: Request) => Promise<Response>;
  seedSystem("audit-ds");
});

describe("reuse decision audit", () => {
  test("отдаёт четыре выборки §5 плюс счётчики would_block", async () => {
    seedAudit();
    // Компонент старше первого решения гейта — он ревью не проходил по построению.
    seedComponent("yp-legacy-card", "audit-ds", at(-3600));

    const { status, body } = await read();
    expect(status).toBe(200);
    expect(reuseAuditResponseSchema.safeParse(body).success).toBe(true);

    const report = body as unknown as {
      gateActiveSince: string | null;
      totals: { decisions: number; actors: number; byDecision: Record<string, number>; byGateMode: Record<string, number> };
      forceNew: { actorId: string; reason: string | null }[];
      repeatedBlocked: { actorId: string; artifactId: string; attempts: number; blocked: number; wouldBlock: number; candidateIds: string[]; lastDecisionId: string | null }[];
      canonicalRoleConflicts: { artifactId: string; roles: string[] }[];
      wouldBlock: { total: number; actors: number; byActor: { actorId: string; count: number }[]; decisions: { decision: string }[] };
      unreviewed: { total: number; artifacts: { id: string; kind: string; createdBeforeGate: boolean }[] };
    };

    expect(report.totals).toMatchObject({
      decisions: 8,
      actors: 3,
      byDecision: { blocked: 4, would_block: 2, force_new: 1, accepted_no_match: 1 },
      byGateMode: { enforce: 6, shadow: 2 },
    });
    expect(report.gateActiveSince).not.toBeNull();

    // (a) force-new — атрибутируемый обход гейта.
    expect(report.forceNew).toHaveLength(1);
    expect(report.forceNew[0]).toMatchObject({ actorId: "user_admin", reason: "Approved: a separate owner needs an independent lifecycle" });

    // (b) агрегация повторов: одиночные попытки в выборку не попадают.
    expect(report.repeatedBlocked).toEqual([expect.objectContaining({
      actorId: "user_alice", artifactId: "yp-proposed-badge", attempts: 3, blocked: 2, wouldBlock: 1, candidateIds: ["yp-badge"],
    })]);
    expect(report.repeatedBlocked[0]!.lastDecisionId).toMatch(/^reuse_/);

    // (c) конфликт канонической роли — `blocked` с распарсенными ролями.
    expect(report.canonicalRoleConflicts).toEqual([expect.objectContaining({
      artifactId: "yp-role-clash", roles: ["payment-success", "order-status"],
    })]);

    // shadow-наблюдаемость §5.4: счётчик и число разных акторов.
    expect(report.wouldBlock.total).toBe(2);
    expect(report.wouldBlock.actors).toBe(2);
    expect(report.wouldBlock.byActor).toEqual([{ actorId: "user_alice", count: 1 }, { actorId: "user_bob", count: 1 }]);
    expect(report.wouldBlock.decisions.every((row) => row.decision === "would_block")).toBe(true);

    // (d) артефакт каталога без единого reuse-review.
    expect(report.unreviewed).toMatchObject({ total: 1 });
    expect(report.unreviewed.artifacts).toEqual([expect.objectContaining({ id: "yp-legacy-card", kind: "component", createdBeforeGate: true })]);
  });

  test("артефакт, созданный уже при работающем гейте и без решения, помечен как обход", async () => {
    seedAudit();
    seedComponent("yp-bypass-card", "audit-ds", new Date(Date.now() + 60_000).toISOString());
    const { body } = await read();
    const unreviewed = (body as unknown as { unreviewed: { artifacts: { id: string; createdBeforeGate: boolean }[] } }).unreviewed;
    expect(unreviewed.artifacts).toEqual([expect.objectContaining({ id: "yp-bypass-card", createdBeforeGate: false })]);
  });

  test("фильтры окна, актора и системы сужают все выборки", async () => {
    const repo = seedAudit();
    seedSystem("other-ds");
    repo.record(decision({ designSystem: "other-ds", decision: "force_new", reason: "Другая система" }));

    const byActor = (await read("?actorId=user_bob")).body as unknown as {
      totals: { decisions: number }; repeatedBlocked: unknown[]; wouldBlock: { total: number };
    };
    expect(byActor.totals.decisions).toBe(2);
    expect(byActor.repeatedBlocked).toEqual([]);
    expect(byActor.wouldBlock.total).toBe(1);

    const bySystem = (await read("?designSystem=other-ds")).body as unknown as { totals: { decisions: number }; forceNew: unknown[] };
    expect(bySystem.totals.decisions).toBe(1);
    expect(bySystem.forceNew).toHaveLength(1);

    // Окно строго новее `since`: собственный момент последней записи в него не попадает.
    const future = new Date(Date.now() + 60_000).toISOString();
    const empty = (await read(`?since=${encodeURIComponent(future)}`)).body as unknown as { totals: { decisions: number }; forceNew: unknown[] };
    expect(empty.totals.decisions).toBe(0);
    expect(empty.forceNew).toEqual([]);
  });

  test("minAttempts поднимает порог повторов, limit ограничивает секции", async () => {
    seedAudit();
    const strict = (await read("?minAttempts=4")).body as unknown as { repeatedBlocked: unknown[] };
    expect(strict.repeatedBlocked).toEqual([]);

    const limited = (await read("?limit=1")).body as unknown as { wouldBlock: { total: number; decisions: unknown[] } };
    // Лимит режет перечисление, но не агрегат: иначе счётчик §5.4 врал бы.
    expect(limited.wouldBlock).toMatchObject({ total: 2 });
    expect(limited.wouldBlock.decisions).toHaveLength(1);
  });

  test("невалидный запрос отклоняется схемой контракта", async () => {
    const badLimit = await read("?limit=0");
    expect(badLimit.status).toBe(422);
    expect((badLimit.body as { error: { code: string } }).error.code).toBe("validation_failed");
    const unknownParam = await read("?decision=blocked");
    expect(unknownParam.status).toBe(422);
    const badAttempts = await read("?minAttempts=1");
    expect(badAttempts.status).toBe(422);
  });

  test("только GET", async () => {
    const response = await handler(new Request("http://test/api/catalog/reuse-decisions", { method: "POST", headers: { origin: "http://test" } }));
    expect(response.status).toBe(405);
  });

  test("не-админ получает 403, аноним — 401", async () => {
    seedAudit();
    const user = await new UserRepo(db).create({ name: "Plain Author", password: "plain-author-password", actorId: BOOTSTRAP_ADMIN_ID });
    const session = new UserRepo(db).createSession(user.id);
    const plain = createHandler(db, {});
    const response = await plain(new Request("http://test/api/catalog/reuse-decisions", { headers: { cookie: `easyui_session=${session.token}` } }));
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("forbidden");
    // Содержимое аудита не должно просачиваться в тело отказа.
    expect(await (await plain(new Request("http://test/api/catalog/reuse-decisions", { headers: { cookie: `easyui_session=${session.token}` } }))).text())
      .not.toContain("yp-proposed-badge");

    const anonymous = await plain(new Request("http://test/api/catalog/reuse-decisions"));
    expect(anonymous.status).toBe(401);
  });

  /**
   * Share- и capture-принципалы не анонимны (`main.ts`), поэтому отказать обязан сам роут:
   * аудит — это «кто и что пытался создать», материал строго админский.
   */
  test("share- и capture-принципалы получают 403", () => {
    seedAudit();
    const request = new Request("http://test/api/catalog/reuse-decisions");
    for (const principal of [
      { kind: "share" as const, scope: { grantId: "share_1", prototypeId: "p", version: 1, allowedUrls: ["/api/catalog/reuse-decisions"] } },
      { kind: "capture" as const, scope: { token: "t", allowedUrls: ["/api/catalog/reuse-decisions"] } },
    ]) {
      let error: ApiError | null = null;
      try { routeReuseDecisions(request, db, principal); } catch (thrown) { error = thrown as ApiError; }
      expect({ kind: principal.kind, status: error?.status, code: error?.code }).toEqual({ kind: principal.kind, status: 403, code: "forbidden" });
    }
  });

  test("чтение не мутирует append-only таблицу", async () => {
    seedAudit();
    const before = db.query("SELECT COUNT(*) count FROM catalog_reuse_decisions").get() as { count: number };
    await read();
    const after = db.query("SELECT COUNT(*) count FROM catalog_reuse_decisions").get() as { count: number };
    expect(after).toEqual(before);
    // Триггеры на месте: чтение их не снимало.
    expect(() => db.run("DELETE FROM catalog_reuse_decisions")).toThrow();
  });
});
