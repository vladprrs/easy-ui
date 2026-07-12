import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrations";

test("migrations are idempotent and install the complete v8 schema",()=>{
  const db=new Database(":memory:"); migrate(db); migrate(db);
  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(8);
  const names=(db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(x=>x.name);
  expect(names).toEqual(expect.arrayContaining(["prototypes","prototype_revisions","prototype_revision_components","prototype_publishes","components","component_revisions","component_publishes","seed_log","design_systems","validation_records","assets","prototype_revision_assets","component_publish_assets","visual_references","visual_runs","design_system_versions"]));
  // v8 widened the component_publishes lifecycle columns.
  const cols=(db.query("PRAGMA table_info(component_publishes)").all() as {name:string}[]).map(c=>c.name);
  expect(cols).toEqual(expect.arrayContaining(["status","status_reason","superseded_by","status_rev"]));
  db.close();
});

// Roll a fully-migrated database back below v7 for the pre-v7 upgrade fixtures.
function rollbackBelowV7(db:Database):void {
  db.run("DROP TABLE design_system_versions");
  db.run("ALTER TABLE prototype_revisions DROP COLUMN design_system_meta_version");
}

test("upgrades a populated v2 database and backfills revision design systems",()=>{
  const db=new Database(":memory:"); migrate(db); rollbackBelowV7(db);
  db.run("DROP TABLE visual_runs"); db.run("DROP TABLE visual_references");
  db.run("PRAGMA user_version = 2"); db.run("DROP TABLE component_publish_assets"); db.run("DROP TABLE prototype_revision_assets"); db.run("DROP TABLE assets"); db.run("DROP TABLE design_systems"); db.run("DROP TABLE validation_records");
  db.run("ALTER TABLE component_revisions DROP COLUMN design_system");
  db.run("INSERT INTO prototypes (id,name,device,screen_count,head_rev,design_system,created_at,updated_at) VALUES ('legacy','Legacy','desktop',1,1,'wireframe','now','now')");
  db.run(`INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,created_at) VALUES ('legacy',1,'{"version":1,"id":"legacy","designSystem":"wireframe"}','','now')`);
  db.run("INSERT INTO components (id,name,head_rev,design_system,deleted_at,created_at,updated_at) VALUES ('custom','LegacyCustom',1,'wireframe',NULL,'now','now')");
  db.run("INSERT INTO component_revisions (component_id,rev,source,created_at) VALUES ('custom',1,'source','now')");

  migrate(db);

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(8);
  expect(db.query("SELECT design_system FROM component_revisions WHERE component_id='custom'").get()).toEqual({design_system:"wireframe"});
  expect(db.query("SELECT COUNT(*) count FROM design_systems").get()).toEqual({count:3});
  expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='validation_records'").get()).toEqual({name:"validation_records"});
  db.close();
});

test("adds validation_records to a populated v3 database without touching existing rows",()=>{
  const db=new Database(":memory:"); migrate(db); rollbackBelowV7(db);
  // Simulate a live v3 database: seed data, then roll back to the v3 shape.
  db.run("INSERT INTO prototypes (id,name,device,screen_count,head_rev,design_system,created_at,updated_at) VALUES ('p1','P1','desktop',1,1,'shadcn','now','now')");
  db.run(`INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,created_at) VALUES ('p1',1,'{"version":1,"id":"p1","designSystem":"shadcn"}','h','now')`);
  db.run("INSERT INTO components (id,name,head_rev,design_system,deleted_at,created_at,updated_at) VALUES ('c1','C1',1,'shadcn',NULL,'now','now')");
  db.run("INSERT INTO component_revisions (component_id,rev,source,design_system,created_at) VALUES ('c1',1,'src','shadcn','now')");
  db.run("DROP TABLE visual_runs"); db.run("DROP TABLE visual_references");
  db.run("DROP TABLE component_publish_assets"); db.run("DROP TABLE prototype_revision_assets"); db.run("DROP TABLE assets"); db.run("DROP TABLE validation_records"); db.run("PRAGMA user_version = 3");

  migrate(db);

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(8);
  expect(db.query("SELECT COUNT(*) count FROM validation_records").get()).toEqual({count:0});
  expect(db.query("SELECT COUNT(*) count FROM prototypes").get()).toEqual({count:1});
  expect(db.query("SELECT COUNT(*) count FROM components").get()).toEqual({count:1});
  db.run("INSERT INTO validation_records (resource_type,resource_id,rev,validator_version,catalog_hash,ok,issues_json,created_at) VALUES ('prototype','p1',1,'v1','h',1,'[]','now')");
  expect(db.query("SELECT ok FROM validation_records WHERE resource_id='p1'").get()).toEqual({ok:1});
  db.close();
});

test("adds the v5 asset registry to a populated v4 database without touching existing rows",()=>{
  const db=new Database(":memory:"); migrate(db); rollbackBelowV7(db);
  db.run("INSERT INTO prototypes (id,name,device,screen_count,head_rev,design_system,created_at,updated_at) VALUES ('p1','P1','desktop',1,1,'shadcn','now','now')");
  db.run(`INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,created_at) VALUES ('p1',1,'{"version":1,"id":"p1","designSystem":"shadcn"}','h','now')`);
  db.run("INSERT INTO validation_records (resource_type,resource_id,rev,validator_version,catalog_hash,ok,issues_json,created_at) VALUES ('prototype','p1',1,'v1','h',1,'[]','now')");
  // Roll back to the v4 shape (drop the v5+v6 tables) and re-migrate.
  db.run("DROP TABLE visual_runs"); db.run("DROP TABLE visual_references");
  db.run("DROP TABLE component_publish_assets"); db.run("DROP TABLE prototype_revision_assets"); db.run("DROP TABLE assets"); db.run("PRAGMA user_version = 4");

  migrate(db);

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(8);
  expect(db.query("SELECT COUNT(*) count FROM assets").get()).toEqual({count:0});
  expect(db.query("SELECT COUNT(*) count FROM prototypes").get()).toEqual({count:1});
  expect(db.query("SELECT COUNT(*) count FROM validation_records").get()).toEqual({count:1});
  // FK RESTRICT: an asset pinned by a revision cannot be deleted.
  db.run("INSERT INTO assets (id,sha256,mime,size,created_at) VALUES ('asset_x','x','image/png',10,'now')");
  db.run("INSERT INTO prototype_revision_assets (prototype_id,rev,asset_id) VALUES ('p1',1,'asset_x')");
  expect(()=>db.run("DELETE FROM assets WHERE id='asset_x'")).toThrow();
  db.close();
});

test("adds the v6 visual regression tables to a populated v5 database with FK RESTRICT",()=>{
  const db=new Database(":memory:"); migrate(db); rollbackBelowV7(db);
  db.run("INSERT INTO assets (id,sha256,mime,size,width,height,created_at) VALUES ('asset_ref','refsha','image/png',10,4,4,'now')");
  // Roll back to the v5 shape (drop the v6 tables) and re-migrate.
  db.run("DROP TABLE visual_runs"); db.run("DROP TABLE visual_references"); db.run("PRAGMA user_version = 5");

  migrate(db);

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(8);
  expect(db.query("SELECT COUNT(*) count FROM visual_references").get()).toEqual({count:0});
  expect(db.query("SELECT COUNT(*) count FROM assets").get()).toEqual({count:1});
  // FK RESTRICT: an asset used as a reference baseline cannot be deleted.
  db.run("INSERT INTO visual_references (id,fingerprint_json,asset_id,created_at) VALUES ('vref_1','{\"scope\":\"component\"}','asset_ref','now')");
  expect(()=>db.run("DELETE FROM assets WHERE id='asset_ref'")).toThrow();
  // CASCADE: dropping a reference removes its runs.
  db.run("INSERT INTO visual_runs (id,reference_id,status,created_at) VALUES ('vrun_1','vref_1','error','now')");
  db.run("DELETE FROM visual_references WHERE id='vref_1'");
  expect(db.query("SELECT COUNT(*) count FROM visual_runs").get()).toEqual({count:0});
  db.close();
});

test("adds the v7 design-system theme versions to a populated v6 database with FK CASCADE",()=>{
  const db=new Database(":memory:"); migrate(db);
  // Seed a custom system + a prototype revision at the full schema, then roll back to the v6 shape.
  db.run("INSERT INTO design_systems (id,name,description,builtin_provider,created_at,updated_at) VALUES ('cust','Cust','Custom',NULL,'now','now')");
  db.run("INSERT INTO prototypes (id,name,device,screen_count,head_rev,design_system,created_at,updated_at) VALUES ('p1','P1','desktop',1,1,'cust','now','now')");
  db.run(`INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,created_at) VALUES ('p1',1,'{"version":1,"id":"p1","designSystem":"cust"}','h','now')`);
  rollbackBelowV7(db); db.run("PRAGMA user_version = 6");

  migrate(db);

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(8);
  expect(db.query("SELECT COUNT(*) count FROM design_system_versions").get()).toEqual({count:0});
  expect((db.query("PRAGMA table_info(prototype_revisions)").all() as {name:string}[]).map(c=>c.name)).toContain("design_system_meta_version");
  // Existing rows survive and the new pin column defaults to NULL.
  expect(db.query("SELECT design_system_meta_version FROM prototype_revisions WHERE prototype_id='p1'").get()).toEqual({design_system_meta_version:null});
  expect(db.query("SELECT COUNT(*) count FROM prototypes").get()).toEqual({count:1});
  // A theme version can be inserted; FK CASCADE removes versions with their system.
  db.run("INSERT INTO design_system_versions (system_id,version,tokens_json,fonts_json,icons_json,created_at) VALUES ('cust',1,'{}','[]','[]','now')");
  db.run("DELETE FROM design_systems WHERE id='cust'");
  expect(db.query("SELECT COUNT(*) count FROM design_system_versions").get()).toEqual({count:0});
  db.close();
});

// Rebuild component_publishes back to its pre-status (v1/v5-era) shape so we can populate a
// database that predates the v8 lifecycle columns, then let migrate() run the strict rebuild.
function revertComponentPublishesToPreStatus(db:Database):void {
  db.run("DROP TABLE prototype_revision_components");
  db.run("DROP TABLE component_publish_assets");
  db.run("DROP TABLE component_publishes");
  db.run(`CREATE TABLE component_publishes (
    component_id TEXT NOT NULL REFERENCES components(id), version INTEGER NOT NULL,
    rev INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'staging'
      CHECK(status IN ('staging','active','failed')),
    compiled_js TEXT NOT NULL, definition_meta TEXT NOT NULL,
    source_hash TEXT NOT NULL, bundle_hash TEXT NOT NULL, host_abi_version INTEGER NOT NULL,
    message TEXT, published_at TEXT NOT NULL,
    PRIMARY KEY (component_id, version), UNIQUE (component_id, rev),
    FOREIGN KEY (component_id, rev) REFERENCES component_revisions(component_id, rev))`);
  db.run(`CREATE TABLE prototype_revision_components (
    prototype_id TEXT NOT NULL, rev INTEGER NOT NULL, component_id TEXT NOT NULL,
    component_version INTEGER NOT NULL, PRIMARY KEY (prototype_id, rev, component_id),
    FOREIGN KEY (prototype_id, rev) REFERENCES prototype_revisions(prototype_id, rev) ON DELETE CASCADE,
    FOREIGN KEY (component_id, component_version) REFERENCES component_publishes(component_id, version) ON DELETE RESTRICT)`);
  db.run(`CREATE TABLE component_publish_assets (
    component_id TEXT NOT NULL, version INTEGER NOT NULL, asset_id TEXT NOT NULL,
    PRIMARY KEY (component_id, version, asset_id),
    FOREIGN KEY (component_id, version) REFERENCES component_publishes(component_id, version) ON DELETE CASCADE,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE RESTRICT)`);
}

test("v8 strictly rebuilds component_publishes on a populated pre-status database preserving children and FKs",()=>{
  const db=new Database(":memory:"); migrate(db);
  // Drop to the pre-v8 (pre-status) component_publishes shape, then set the DB back to v7.
  revertComponentPublishesToPreStatus(db); db.run("PRAGMA user_version = 7");
  const insert=()=>{
    // A live component with active/failed/staging versions, a soft-deleted component still pinned,
    // pins across several prototype revisions and a component_publish_asset row (v5 FK-child).
    db.run("INSERT INTO components (id,name,head_rev,design_system,deleted_at,created_at,updated_at) VALUES ('c1','C1',3,'shadcn',NULL,'now','now')");
    db.run("INSERT INTO components (id,name,head_rev,design_system,deleted_at,created_at,updated_at) VALUES ('c2','C2',1,'shadcn','now','now','now')");
    for(const [id,rev] of [["c1",1],["c1",2],["c1",3],["c2",1]] as const) db.run("INSERT INTO component_revisions (component_id,rev,source,design_system,created_at) VALUES (?,?,?,'shadcn','now')",[id,rev,`src-${id}-${rev}`]);
    for(const [id,ver,rev,status] of [["c1",1,1,"active"],["c1",2,2,"failed"],["c1",3,3,"staging"],["c2",1,1,"active"]] as const)
      db.run("INSERT INTO component_publishes (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,message,published_at) VALUES (?,?,?,?,'js','{}','sh','bh',1,NULL,'now')",[id,ver,rev,status]);
    db.run("INSERT INTO prototypes (id,name,device,screen_count,head_rev,design_system,created_at,updated_at) VALUES ('p1','P1','desktop',1,2,'shadcn','now','now')");
    db.run(`INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,created_at) VALUES ('p1',1,'{"version":1,"id":"p1","designSystem":"shadcn"}','h','now')`);
    db.run(`INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,created_at) VALUES ('p1',2,'{"version":1,"id":"p1","designSystem":"shadcn"}','h','now')`);
    db.run("INSERT INTO prototype_revision_components (prototype_id,rev,component_id,component_version) VALUES ('p1',1,'c1',1)");
    db.run("INSERT INTO prototype_revision_components (prototype_id,rev,component_id,component_version) VALUES ('p1',1,'c2',1)");
    db.run("INSERT INTO prototype_revision_components (prototype_id,rev,component_id,component_version) VALUES ('p1',2,'c1',1)");
    db.run("INSERT INTO assets (id,sha256,mime,size,created_at) VALUES ('asset_z','z','image/png',10,'now')");
    db.run("INSERT INTO component_publish_assets (component_id,version,asset_id) VALUES ('c1',1,'asset_z')");
  };
  insert();

  migrate(db);

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(8);
  // No FK violations after the rebuild.
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  // Parent rows and their statuses survive; new columns default.
  expect(db.query("SELECT status,status_reason,superseded_by,status_rev FROM component_publishes WHERE component_id='c1' AND version=2").get()).toEqual({status:"failed",status_reason:null,superseded_by:null,status_rev:1});
  expect(db.query("SELECT COUNT(*) count FROM component_publishes").get()).toEqual({count:4});
  // FK-children survive with all their rows.
  expect(db.query("SELECT COUNT(*) count FROM prototype_revision_components").get()).toEqual({count:3});
  expect(db.query("SELECT version v FROM component_publish_assets WHERE asset_id='asset_z'").get()).toEqual({v:1});
  // RESTRICT is still enforced: a pinned publish cannot be deleted.
  expect(()=>db.run("DELETE FROM component_publishes WHERE component_id='c1' AND version=1")).toThrow();
  // The widened CHECK now accepts a lifecycle status; the old one would have rejected it.
  db.run("UPDATE component_publishes SET status='deprecated',status_rev=2 WHERE component_id='c1' AND version=1");
  expect(db.query("SELECT status FROM component_publishes WHERE component_id='c1' AND version=1").get()).toEqual({status:"deprecated"});
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
