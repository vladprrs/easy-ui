import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrations";

test("migrations are idempotent and install the complete v3 schema",()=>{
  const db=new Database(":memory:"); migrate(db); migrate(db);
  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(3);
  const names=(db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(x=>x.name);
  expect(names).toEqual(expect.arrayContaining(["prototypes","prototype_revisions","prototype_revision_components","prototype_publishes","components","component_revisions","component_publishes","seed_log","design_systems"]));
  db.close();
});

test("upgrades a populated v2 database and backfills revision design systems",()=>{
  const db=new Database(":memory:"); migrate(db);
  db.run("PRAGMA user_version = 2"); db.run("DROP TABLE design_systems");
  db.run("ALTER TABLE component_revisions DROP COLUMN design_system");
  db.run("INSERT INTO prototypes (id,name,device,screen_count,head_rev,design_system,created_at,updated_at) VALUES ('legacy','Legacy','desktop',1,1,'wireframe','now','now')");
  db.run(`INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,created_at) VALUES ('legacy',1,'{"version":1,"id":"legacy","designSystem":"wireframe"}','','now')`);
  db.run("INSERT INTO components (id,name,head_rev,design_system,deleted_at,created_at,updated_at) VALUES ('custom','LegacyCustom',1,'wireframe',NULL,'now','now')");
  db.run("INSERT INTO component_revisions (component_id,rev,source,created_at) VALUES ('custom',1,'source','now')");

  migrate(db);

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(3);
  expect(db.query("SELECT design_system FROM component_revisions WHERE component_id='custom'").get()).toEqual({design_system:"wireframe"});
  expect(db.query("SELECT COUNT(*) count FROM design_systems").get()).toEqual({count:3});
  db.close();
});

test("startup invariant rejects custom names used by any builtin system",()=>{
  const db=new Database(":memory:"); migrate(db);
  db.run("INSERT INTO components (id,name,head_rev,deleted_at,created_at,updated_at) VALUES ('collision','Button',1,NULL,'now','now')");
  db.run("INSERT INTO component_revisions (component_id,rev,source,created_at) VALUES ('collision',1,'source','now')");
  expect(()=>migrate(db)).toThrow("Custom component names collide with registered builtin components: Button");
  db.close();
});

test("repeated startup preserves registry metadata",()=>{
  const db=new Database(":memory:"); migrate(db);
  const before=db.query("SELECT * FROM design_systems ORDER BY id").all(); migrate(db);
  expect(db.query("SELECT * FROM design_systems ORDER BY id").all()).toEqual(before);
  db.close();
});

for(const table of ["components","component_revisions","prototypes"] as const) test(`startup audit rejects dangling registry references in ${table}`,()=>{
  const db=new Database(":memory:"); migrate(db);
  if(table==="components") {
    db.run("INSERT INTO components (id,name,head_rev,design_system,created_at,updated_at) VALUES ('bad','Bad',1,'missing','now','now')");
    db.run("INSERT INTO component_revisions (component_id,rev,source,design_system,created_at) VALUES ('bad',1,'x','shadcn','now')");
  } else if(table==="component_revisions") {
    db.run("INSERT INTO components (id,name,head_rev,design_system,created_at,updated_at) VALUES ('bad','Bad',1,'shadcn','now','now')");
    db.run("INSERT INTO component_revisions (component_id,rev,source,design_system,created_at) VALUES ('bad',1,'x','missing','now')");
  } else {
    db.run("INSERT INTO prototypes (id,name,device,screen_count,head_rev,design_system,created_at,updated_at) VALUES ('bad','Bad','desktop',1,1,'missing','now','now')");
    db.run(`INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,created_at) VALUES ('bad',1,'{"version":1,"id":"bad","designSystem":"missing"}','','now')`);
  }
  expect(()=>migrate(db)).toThrow(`Dangling design system reference in ${table}`); db.close();
});

test("startup audit rejects component and prototype head mismatches",()=>{
  const componentDb=new Database(":memory:"); migrate(componentDb);
  componentDb.run("INSERT INTO components (id,name,head_rev,design_system,created_at,updated_at) VALUES ('bad','Bad',1,'wireframe','now','now')");
  componentDb.run("INSERT INTO component_revisions (component_id,rev,source,design_system,created_at) VALUES ('bad',1,'x','shadcn','now')");
  expect(()=>migrate(componentDb)).toThrow("Component head design system mismatch: bad"); componentDb.close();
  const prototypeDb=new Database(":memory:"); migrate(prototypeDb);
  prototypeDb.run("INSERT INTO prototypes (id,name,device,screen_count,head_rev,design_system,created_at,updated_at) VALUES ('bad','Bad','desktop',1,1,'wireframe','now','now')");
  prototypeDb.run(`INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,created_at) VALUES ('bad',1,'{"version":1,"id":"bad","designSystem":"shadcn"}','','now')`);
  expect(()=>migrate(prototypeDb)).toThrow("Prototype head design system mismatch: bad"); prototypeDb.close();
});

test("startup audit rejects an unknown builtin provider",()=>{
  const db=new Database(":memory:"); migrate(db);
  db.run("INSERT INTO design_systems VALUES ('bad','Bad','Bad provider','unknown','now','now')");
  expect(()=>migrate(db)).toThrow("Unknown builtin provider for design system bad: unknown"); db.close();
});
