import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "./db";
import { createHandler } from "./main";
import { createTestHandler } from "./test-auth";
import { UserRepo } from "./users";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function fixture(): Promise<{ dir: string; db: Database }> {
  const dir = await mkdtemp(resolve(tmpdir(), "easy-ui-snapshot-")); dirs.push(dir);
  const db = openDatabase(resolve(dir, "easy-ui.db"));
  return { dir, db };
}

describe("GET /api/admin/db-snapshot", () => {
  test("returns a valid SQLite snapshot to an admin and leaves no temp file behind", async () => {
    const { dir, db } = await fixture();
    const handler = createTestHandler(db, { dataDir: dir });
    db.run("INSERT INTO prototypes (id,name,device,screen_count,head_rev,design_system,instance_id,created_at,updated_at) VALUES ('snap','Snap','desktop',1,1,'yandex-pay','instance','now','now')");

    const response = await handler(new Request("http://localhost/api/admin/db-snapshot"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    // `protectSessionResponse` дописывает `private` к no-store всех /api-ответов.
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="easy-ui-db-snapshot-\d{8}-\d{6}\.sqlite"$/);

    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(0, 16))).toBe("SQLite format 3\0");

    const copy = resolve(dir, "downloaded.sqlite");
    await writeFile(copy, bytes);
    const snapshot = new Database(copy, { strict: true });
    expect(snapshot.query("SELECT id FROM prototypes").all()).toEqual([{ id: "snap" }]);
    snapshot.close();

    // Временный файл снимка удалён после отдачи.
    expect(await readdir(resolve(dir, "tmp"))).toEqual([]);
    expect(db.query("SELECT actor_id,subject_id FROM audit_events WHERE action='admin.db_snapshot'").all())
      .toEqual([{ actor_id: "user_admin", subject_id: "easy-ui.db" }]);
    db.close();
  });

  test("401 without a session, 403 for a non-admin user", async () => {
    const { dir, db } = await fixture();
    // Бутстрап-админ нужен, чтобы у базы был владелец; сам запрос идёт без cookie.
    createTestHandler(db, { dataDir: dir });
    const handler = createHandler(db, { dataDir: dir });

    const anonymous = await handler(new Request("http://localhost/api/admin/db-snapshot"));
    expect(anonymous.status).toBe(401);
    expect((await anonymous.json() as { error: { code: string } }).error.code).toBe("unauthorized");

    const repo = new UserRepo(db);
    const operator = await repo.create({ name: "Snapshot Operator", password: "operator password", isAdmin: false, actorId: "user_admin" });
    const session = repo.createSession(operator.id);
    const forbidden = await handler(new Request("http://localhost/api/admin/db-snapshot", { headers: { cookie: `easyui_session=${session.token}` } }));
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json() as { error: { code: string } }).error.code).toBe("forbidden");

    expect(db.query("SELECT COUNT(*) count FROM audit_events WHERE action='admin.db_snapshot'").get()).toEqual({ count: 0 });
    db.close();
  });
});
