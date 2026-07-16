import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "./db";
import { createHandler, startServer } from "./main";
import { createTestHandler } from "./test-auth";
import { ensureBootstrapAdmin, UserRepo } from "./users";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("bootstrap admin", () => {
  test("uses stable id, backfills owners, and revokes sessions when the env password changes", async () => {
    const db = openDatabase(":memory:");
    db.run("INSERT INTO prototypes (id,name,device,screen_count,head_rev,design_system,instance_id,created_at,updated_at) VALUES ('owned','Owned','desktop',1,1,'yandex-pay','instance','now','now')");
    db.run(`INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,created_at) VALUES ('owned',1,'{"version":1,"id":"owned","designSystem":"yandex-pay"}','h','now')`);
    const first = await ensureBootstrapAdmin(db, { name: "Root", password: "first bootstrap password" });
    expect(first).toMatchObject({ id: "user_admin", name: "Root", isAdmin: true });
    expect(db.query("SELECT owner_id FROM prototypes WHERE id='owned'").get()).toEqual({ owner_id: "user_admin" });
    expect(db.query("SELECT COUNT(*) count FROM design_systems WHERE owner_id='user_admin'").get()).toEqual({ count: 3 });
    new UserRepo(db).createSession("user_admin");
    expect(db.query("SELECT COUNT(*) count FROM user_sessions").get()).toEqual({ count: 1 });
    await ensureBootstrapAdmin(db, { name: "Root", password: "second bootstrap password" });
    expect(db.query("SELECT COUNT(*) count FROM users WHERE id='user_admin'").get()).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) count FROM user_sessions").get()).toEqual({ count: 0 });
    expect(await Bun.password.verify("second bootstrap password", (db.query("SELECT password_hash FROM users WHERE id='user_admin'").get() as {password_hash:string}).password_hash, "argon2id")).toBe(true);
    db.close();
  });

  test("refuses non-loopback startup without an existing admin or ADMIN env", async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "easy-ui-no-admin-")); dirs.push(dir);
    const old = { name: process.env.ADMIN_NAME, password: process.env.ADMIN_PASSWORD, origin: process.env.PUBLIC_ORIGIN };
    delete process.env.ADMIN_NAME; delete process.env.ADMIN_PASSWORD; process.env.PUBLIC_ORIGIN = "https://easy-ui.example";
    try { await expect(startServer({ database: resolve(dir, "db.sqlite"), host: "0.0.0.0", port: 0 })).rejects.toThrow("non-loopback"); }
    finally {
      if (old.name === undefined) delete process.env.ADMIN_NAME; else process.env.ADMIN_NAME = old.name;
      if (old.password === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = old.password;
      if (old.origin === undefined) delete process.env.PUBLIC_ORIGIN; else process.env.PUBLIC_ORIGIN = old.origin;
    }
  });
});

describe("admin user routes", () => {
  test("creates and lists users, hashes passwords, and audits the actor", async () => {
    const db = openDatabase(":memory:"); const handler = createTestHandler(db);
    const response = await handler(new Request("http://localhost/api/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Operator", password: "operator password", isAdmin: false }) }));
    expect(response.status).toBe(201);
    const user = await response.json() as { id: string; name: string; isAdmin: boolean };
    expect(user).toMatchObject({ name: "Operator", isAdmin: false });
    const row = db.query("SELECT password_hash FROM users WHERE id=?").get(user.id) as { password_hash: string };
    expect(row.password_hash).not.toContain("operator password");
    expect(await Bun.password.verify("operator password", row.password_hash, "argon2id")).toBe(true);
    expect(await (await handler(new Request("http://localhost/api/users"))).json()).toMatchObject({ users: expect.arrayContaining([expect.objectContaining({ id: user.id })]) });
    expect(db.query("SELECT actor_id,subject_id FROM audit_events WHERE action='user.created' AND subject_id=?").get(user.id)).toEqual({ actor_id: "user_admin", subject_id: user.id });
    db.close();
  });

  test("rejects a non-admin user", async () => {
    const db = openDatabase(":memory:");
    await ensureBootstrapAdmin(db, { name: "Root", password: "bootstrap password" });
    const user = await new UserRepo(db).create({ name: "Plain", password: "plain password", actorId: "user_admin" });
    const session = new UserRepo(db).createSession(user.id);
    const response = await createHandler(db)(new Request("http://localhost/api/users", { headers: { cookie: `easyui_session=${session.token}` } }));
    expect(response.status).toBe(403);
    db.close();
  });
});
