import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrations";

test("migrations upgrade a fresh v0 database to latest and a v13 database is idempotent",()=>{
  const db=new Database(":memory:"); migrate(db);
  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(13);
  const names=(db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(x=>x.name);
  expect(names).toEqual(expect.arrayContaining(["prototypes","prototype_revisions","prototype_revision_components","prototype_publishes","components","component_revisions","component_publishes","seed_log","design_systems","validation_records","assets","prototype_revision_assets","component_publish_assets","visual_references","visual_runs","visual_baseline_sets","design_system_versions","share_grants","share_sessions"]));
  // v8 widened the component_publishes lifecycle columns.
  const cols=(db.query("PRAGMA table_info(component_publishes)").all() as {name:string}[]).map(c=>c.name);
  expect(cols).toEqual(expect.arrayContaining(["status","status_reason","superseded_by","status_rev"]));
  // v9 added Figma provenance columns to both revision tables.
  expect((db.query("PRAGMA table_info(prototype_revisions)").all() as {name:string}[]).map(c=>c.name)).toContain("figma_json");
  expect((db.query("PRAGMA table_info(component_revisions)").all() as {name:string}[]).map(c=>c.name)).toContain("figma_json");
  expect((db.query("PRAGMA table_info(visual_references)").all() as {name:string}[]).map(c=>c.name)).toContain("deleted_at");
  expect((db.query("PRAGMA table_info(visual_runs)").all() as {name:string}[]).map(c=>c.name)).toContain("reference_asset_id");
  const instance=(db.query("PRAGMA table_info(prototypes)").all() as {name:string;notnull:number}[]).find(c=>c.name==="instance_id");
  expect(instance?.notnull).toBe(1);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  migrate(db);
  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(13);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});

test("adds scoped-share grants and hashed sessions to a populated v9 database",()=>{
  const db=new Database(":memory:"); migrate(db);
  rollbackV11(db);
  db.run("DROP TABLE share_sessions"); db.run("DROP TABLE share_grants"); db.run("PRAGMA user_version = 9");
  db.run("INSERT INTO prototypes (id,name,device,screen_count,head_rev,design_system,created_at,updated_at) VALUES ('shared','Shared','mobile',1,1,'shadcn','now','now')");
  db.run(`INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,created_at) VALUES ('shared',1,'{"version":1,"id":"shared","designSystem":"shadcn"}','h','now')`);
  db.run("INSERT INTO prototype_publishes (prototype_id,version,rev,published_at) VALUES ('shared',1,1,'now')");

  migrate(db);

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(13);
  db.run("INSERT INTO share_grants (id,token_hash,prototype_id,version,rev,dependencies_json,created_at,expires_at) VALUES ('g','hash','shared',1,1,'{}','now','later')");
  db.run("INSERT INTO share_sessions (id,session_hash,grant_id,created_at,expires_at) VALUES ('s','session-hash','g','now','later')");
  db.run("DELETE FROM share_grants WHERE id='g'");
  expect(db.query("SELECT COUNT(*) count FROM share_sessions").get()).toEqual({count:0});
  expect(db.query("SELECT COUNT(*) count FROM prototypes").get()).toEqual({count:1});
  db.close();
});

function rollbackV11(db:Database):void {
  rollbackV12(db);
  db.run("DROP TABLE visual_runs");
  db.run(`CREATE TABLE visual_runs (
    id TEXT PRIMARY KEY, reference_id TEXT NOT NULL, candidate_asset_id TEXT, diff_asset_id TEXT,
    metric TEXT, metric_options_json TEXT, diff_pixels INTEGER, total_pixels INTEGER,
    diff_percent REAL, status TEXT NOT NULL CHECK(status IN ('pass','fail','error','reference_missing')),
    candidate_meta_json TEXT, created_at TEXT NOT NULL,
    FOREIGN KEY (reference_id) REFERENCES visual_references(id) ON DELETE CASCADE,
    FOREIGN KEY (candidate_asset_id) REFERENCES assets(id) ON DELETE RESTRICT,
    FOREIGN KEY (diff_asset_id) REFERENCES assets(id) ON DELETE RESTRICT)`);
  db.run("CREATE INDEX visual_runs_reference ON visual_runs (reference_id, created_at, id)");
  db.run("ALTER TABLE visual_references DROP COLUMN deleted_at");
}

const V12_INDEXES = [
  "assets_created_id",
  "prototype_revision_assets_asset",
  "component_publish_assets_asset",
  "visual_references_asset",
  "visual_runs_reference_asset",
  "visual_runs_candidate_asset",
  "visual_runs_diff_asset",
] as const;

function rollbackV12(db:Database):void {
  rollbackV13(db);
  for (const index of V12_INDEXES) db.run(`DROP INDEX IF EXISTS ${index}`);
}

function rollbackV13(db:Database):void {
  const has=(db.query("PRAGMA table_info(prototypes)").all() as {name:string}[]).some(c=>c.name==="instance_id");
  if(!has) return;
  db.run("PRAGMA foreign_keys = OFF");
  db.run("DROP TABLE IF EXISTS visual_baseline_sets");
  db.run("PRAGMA legacy_alter_table = ON");
  db.run("ALTER TABLE prototypes RENAME TO _prototypes_v13");
  db.run(`CREATE TABLE prototypes (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
    device TEXT NOT NULL, screen_count INTEGER NOT NULL,
    head_rev INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    design_system TEXT NOT NULL DEFAULT 'shadcn')`);
  db.run(`INSERT INTO prototypes (id,name,description,device,screen_count,head_rev,created_at,updated_at,design_system)
    SELECT id,name,description,device,screen_count,head_rev,created_at,updated_at,design_system FROM _prototypes_v13`);
  db.run("DROP TABLE _prototypes_v13");
  db.run("PRAGMA legacy_alter_table = OFF");
  db.run("PRAGMA foreign_keys = ON");
}

test("v13 backfills a distinct immutable instance id per populated prototype and preserves rows",()=>{
  const db=new Database(":memory:"); migrate(db); rollbackV13(db); db.run("PRAGMA user_version = 12");
  for(const id of ["legacy-a","legacy-b"]) {
    db.run("INSERT INTO prototypes (id,name,device,screen_count,head_rev,design_system,created_at,updated_at) VALUES (?,?, 'desktop',1,1,'shadcn','now','now')",[id,id]);
    db.run("INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,created_at) VALUES (?,1,?,'h','now')",[id,JSON.stringify({version:1,id,designSystem:"shadcn"})]);
  }
  migrate(db);
  const rows=db.query("SELECT id,instance_id FROM prototypes ORDER BY id").all() as {id:string;instance_id:string}[];
  expect(rows).toHaveLength(2); expect(rows[0]!.instance_id).not.toBe(rows[1]!.instance_id);
  expect(rows.every(row=>/^[0-9a-f-]{36}$/.test(row.instance_id))).toBe(true);
  expect((db.query("PRAGMA table_info(prototypes)").all() as {name:string;notnull:number}[]).find(c=>c.name==="instance_id")?.notnull).toBe(1);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});

test("a failed migration preserves the last successful version and retry applies the remainder",()=>{
  const db=new Database(":memory:"); migrate(db); rollbackV12(db); db.run("PRAGMA user_version = 11");
  db.run("INSERT INTO prototypes (id,name,device,screen_count,head_rev,design_system,created_at,updated_at) VALUES ('retry','Retry','desktop',1,1,'shadcn','now','now')");
  db.run(`INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,created_at) VALUES ('retry',1,'{"version":1,"id":"retry","designSystem":"shadcn"}','h','now')`);
  // Force v13 to fail at its final CREATE TABLE, after v12 has committed independently.
  db.run("CREATE TABLE visual_baseline_sets (collision TEXT)");

  expect(()=>migrate(db)).toThrow();
  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(12);
  expect((db.query("PRAGMA table_info(prototypes)").all() as {name:string}[]).map(c=>c.name)).not.toContain("instance_id");
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);

  db.run("DROP TABLE visual_baseline_sets");
  migrate(db);
  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(13);
  expect(db.query("SELECT instance_id FROM prototypes WHERE id='retry'").get()).toEqual({instance_id:expect.any(String)});
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});

test("v11 preserves populated visual history and leaves legacy baseline evidence unknown",()=>{
  const db=new Database(":memory:"); migrate(db); rollbackV11(db); db.run("PRAGMA user_version = 10");
  db.run("INSERT INTO assets (id,sha256,mime,size,width,height,created_at) VALUES ('asset_old','old','image/png',10,4,4,'now')");
  db.run("INSERT INTO assets (id,sha256,mime,size,width,height,created_at) VALUES ('asset_candidate','candidate','image/png',10,4,4,'now')");
  db.run("INSERT INTO visual_references (id,fingerprint_json,asset_id,created_at) VALUES ('vref_legacy','{\"scope\":\"component\"}','asset_old','before')");
  db.run("INSERT INTO visual_runs (id,reference_id,candidate_asset_id,status,created_at) VALUES ('vrun_legacy','vref_legacy','asset_candidate','pass','before')");

  migrate(db);

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(13);
  expect(db.query("SELECT reference_asset_id FROM visual_runs WHERE id='vrun_legacy'").get()).toEqual({reference_asset_id:null});
  expect(db.query("SELECT deleted_at FROM visual_references WHERE id='vref_legacy'").get()).toEqual({deleted_at:null});
  expect(()=>db.run("DELETE FROM visual_references WHERE id='vref_legacy'")).toThrow();
  db.run("INSERT INTO visual_runs (id,reference_id,reference_asset_id,status,created_at) VALUES ('vrun_new','vref_legacy','asset_old','pass','after')");
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.query("SELECT COUNT(*) count FROM visual_runs").get()).toEqual({count:2});
  db.close();
});

test("v12 adds asset listing and reverse hard-pin indexes to a populated v11 database",()=>{
  const db=new Database(":memory:"); migrate(db); rollbackV12(db); db.run("PRAGMA user_version = 11");
  db.run("INSERT INTO prototypes (id,name,device,screen_count,head_rev,design_system,created_at,updated_at) VALUES ('p_index','P Index','desktop',1,1,'shadcn','now','now')");
  db.run(`INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,created_at) VALUES ('p_index',1,'{"version":1,"id":"p_index","designSystem":"shadcn"}','h','now')`);
  db.run("INSERT INTO components (id,name,head_rev,design_system,created_at,updated_at) VALUES ('c_index','IndexFixture',1,'shadcn','now','now')");
  db.run("INSERT INTO component_revisions (component_id,rev,source,design_system,created_at) VALUES ('c_index',1,'source','shadcn','now')");
  db.run("INSERT INTO component_publishes (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,published_at) VALUES ('c_index',1,1,'active','js','{}','source','bundle',1,'now')");
  db.run("INSERT INTO assets (id,sha256,mime,size,created_at) VALUES ('asset_populated','populated','image/png',10,'2026-07-15T00:00:00.000Z')");
  db.run("INSERT INTO prototype_revision_assets (prototype_id,rev,asset_id) VALUES ('p_index',1,'asset_populated')");
  db.run("INSERT INTO component_publish_assets (component_id,version,asset_id) VALUES ('c_index',1,'asset_populated')");
  db.run("INSERT INTO visual_references (id,fingerprint_json,asset_id,created_at) VALUES ('vref_populated','{\"scope\":\"component\"}','asset_populated','now')");
  db.run("INSERT INTO visual_runs (id,reference_id,reference_asset_id,candidate_asset_id,diff_asset_id,status,created_at) VALUES ('vrun_populated','vref_populated','asset_populated','asset_populated','asset_populated','pass','now')");

  migrate(db);

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(13);
  const indexes=(db.query("SELECT name FROM sqlite_master WHERE type='index'").all() as {name:string}[]).map((row)=>row.name);
  expect(indexes).toEqual(expect.arrayContaining([...V12_INDEXES]));
  expect(db.query("SELECT asset_id FROM prototype_revision_assets WHERE prototype_id='p_index'").get()).toEqual({asset_id:"asset_populated"});
  expect(db.query("SELECT asset_id FROM component_publish_assets WHERE component_id='c_index'").get()).toEqual({asset_id:"asset_populated"});
  expect(db.query("SELECT asset_id FROM visual_references WHERE id='vref_populated'").get()).toEqual({asset_id:"asset_populated"});
  expect(db.query("SELECT reference_asset_id,candidate_asset_id,diff_asset_id FROM visual_runs WHERE id='vrun_populated'").get()).toEqual({reference_asset_id:"asset_populated",candidate_asset_id:"asset_populated",diff_asset_id:"asset_populated"});
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});

// Roll a fully-migrated database back below v7 (and below the v9 figma columns) for the
// pre-v7 upgrade fixtures, so re-migration re-runs v7..v12 cleanly.
function rollbackBelowV7(db:Database):void {
  rollbackV11(db);
  db.run("DROP TABLE share_sessions");
  db.run("DROP TABLE share_grants");
  db.run("DROP TABLE design_system_versions");
  db.run("ALTER TABLE prototype_revisions DROP COLUMN design_system_meta_version");
  db.run("ALTER TABLE prototype_revisions DROP COLUMN figma_json");
  db.run("ALTER TABLE component_revisions DROP COLUMN figma_json");
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

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(13);
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

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(13);
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

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(13);
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

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(13);
  expect(db.query("SELECT COUNT(*) count FROM visual_references").get()).toEqual({count:0});
  expect(db.query("SELECT COUNT(*) count FROM assets").get()).toEqual({count:1});
  // FK RESTRICT: an asset used as a reference baseline cannot be deleted.
  db.run("INSERT INTO visual_references (id,fingerprint_json,asset_id,created_at) VALUES ('vref_1','{\"scope\":\"component\"}','asset_ref','now')");
  expect(()=>db.run("DELETE FROM assets WHERE id='asset_ref'")).toThrow();
  // v11 removes the destructive cascade: physical deletion is restricted while history exists.
  db.run("INSERT INTO visual_runs (id,reference_id,status,created_at) VALUES ('vrun_1','vref_1','error','now')");
  expect(()=>db.run("DELETE FROM visual_references WHERE id='vref_1'")).toThrow();
  expect(db.query("SELECT COUNT(*) count FROM visual_runs").get()).toEqual({count:1});
  db.close();
});

test("adds the v7 design-system theme versions to a populated v6 database with FK CASCADE",()=>{
  const db=new Database(":memory:"); migrate(db);
  // Seed a custom system + a prototype revision at the full schema, then roll back to the v6 shape.
  db.run("INSERT INTO design_systems (id,name,description,builtin_provider,created_at,updated_at) VALUES ('cust','Cust','Custom',NULL,'now','now')");
  db.run("INSERT INTO prototypes (id,name,device,screen_count,head_rev,design_system,instance_id,created_at,updated_at) VALUES ('p1','P1','desktop',1,1,'cust','fixture-instance','now','now')");
  db.run(`INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,created_at) VALUES ('p1',1,'{"version":1,"id":"p1","designSystem":"cust"}','h','now')`);
  rollbackBelowV7(db); db.run("PRAGMA user_version = 6");

  migrate(db);

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(13);
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
  // Drop to the pre-v8 (pre-status) component_publishes shape and remove the v9 figma columns,
  // then set the DB back to v7 so re-migration re-runs v8 (rebuild) and v9 (figma).
  rollbackV11(db);
  revertComponentPublishesToPreStatus(db);
  db.run("ALTER TABLE prototype_revisions DROP COLUMN figma_json");
  db.run("ALTER TABLE component_revisions DROP COLUMN figma_json");
  db.run("DROP TABLE share_sessions");
  db.run("DROP TABLE share_grants");
  db.run("PRAGMA user_version = 7");
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

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(13);
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
    db.run("INSERT INTO prototypes (id,name,device,screen_count,head_rev,design_system,instance_id,created_at,updated_at) VALUES ('bad','Bad','desktop',1,1,'missing','fixture-instance','now','now')");
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
  prototypeDb.run("INSERT INTO prototypes (id,name,device,screen_count,head_rev,design_system,instance_id,created_at,updated_at) VALUES ('bad','Bad','desktop',1,1,'wireframe','fixture-instance','now','now')");
  prototypeDb.run(`INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,created_at) VALUES ('bad',1,'{"version":1,"id":"bad","designSystem":"shadcn"}','','now')`);
  expect(()=>migrate(prototypeDb)).toThrow("Prototype head design system mismatch: bad"); prototypeDb.close();
});

test("startup audit rejects an unknown builtin provider",()=>{
  const db=new Database(":memory:"); migrate(db);
  db.run("INSERT INTO design_systems VALUES ('bad','Bad','Bad provider','unknown','now','now')");
  expect(()=>migrate(db)).toThrow("Unknown builtin provider for design system bad: unknown"); db.close();
});
