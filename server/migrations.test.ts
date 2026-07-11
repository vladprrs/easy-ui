import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrations";

test("migrations are idempotent and install the complete v2 schema",()=>{
  const db=new Database(":memory:"); migrate(db); migrate(db);
  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(2);
  const names=(db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(x=>x.name);
  expect(names).toEqual(expect.arrayContaining(["prototypes","prototype_revisions","prototype_revision_components","prototype_publishes","components","component_revisions","component_publishes","seed_log"]));
  db.close();
});

test("upgrades a populated v1 database and backfills design systems",()=>{
  const db=new Database(":memory:");
  db.run(`CREATE TABLE prototypes (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
    device TEXT NOT NULL, screen_count INTEGER NOT NULL,
    head_rev INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  db.run(`CREATE TABLE components (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, head_rev INTEGER NOT NULL,
    deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  db.run("INSERT INTO prototypes VALUES ('legacy','Legacy',NULL,'desktop',1,1,'now','now')");
  db.run("INSERT INTO components VALUES ('custom','LegacyCustom',1,NULL,'now','now')");
  db.run("PRAGMA user_version = 1");

  migrate(db);

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(2);
  expect(db.query("SELECT design_system FROM prototypes WHERE id='legacy'").get()).toEqual({design_system:"shadcn"});
  expect(db.query("SELECT design_system FROM components WHERE id='custom'").get()).toEqual({design_system:"shadcn"});
  db.close();
});

test("startup invariant rejects custom names used by any builtin system",()=>{
  const db=new Database(":memory:"); migrate(db);
  db.run("INSERT INTO components (id,name,head_rev,deleted_at,created_at,updated_at) VALUES ('collision','Button',1,NULL,'now','now')");
  expect(()=>migrate(db)).toThrow("Custom component names collide with registered builtin components: Button");
  db.close();
});
