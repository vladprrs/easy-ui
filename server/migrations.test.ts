import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrations";

test("migrations are idempotent and install the complete v1 schema",()=>{
  const db=new Database(":memory:"); migrate(db); migrate(db);
  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(1);
  const names=(db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(x=>x.name);
  expect(names).toEqual(expect.arrayContaining(["prototypes","prototype_revisions","prototype_revision_components","prototype_publishes","components","component_revisions","component_publishes","seed_log"]));
  db.close();
});
