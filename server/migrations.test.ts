import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, RETIRED_DESIGN_SYSTEM_TRIGGER_NAMES } from "./migrations";

/**
 * Возвращает `design_system_versions` к домиграционному (v22) виду: колонка `spacing_resolver`
 * добавлена v23, поэтому искусственный откат `user_version` ниже 23 обязан снять и её —
 * иначе повторный прогон ALTER TABLE ловит duplicate column. Таблица создаётся в v7, а тесты
 * откатываются и ниже, поэтому helper молча пропускает отсутствующую таблицу/колонку.
 */
function rollbackPostV22(db:Database):void {
  const tables=(db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(row=>row.name);
  // v25 создала durable-слой acceptance и добавила колонки-свидетельства, v26 — case-set-манифесты,
  // v27 — provenance-слой и надгробия решений; откат ниже снимает и их, иначе повторный прогон шага
  // ловит duplicate table/column. `candidate_decisions` — до `component_candidates` (FK-ребёнок).
  for(const table of ["candidate_decisions","component_provenance","component_case_sets","acceptance_case_results","acceptance_cases","acceptance_runs","component_candidates"]) {
    if(tables.includes(table)) db.run(`DROP TABLE ${table}`);
  }
  const publishColumns=new Set((db.query("PRAGMA table_info(component_publishes)").all() as {name:string}[]).map(column=>column.name));
  // v30 добавила массив ранов на строку версии (`acceptance_run_ids`); `acceptance_runs`
  // с её колонкой `renderer_fingerprint` уносится целиком выше.
  for(const column of ["candidate_id","acceptance_run_id","acceptance_run_ids"]) {
    if(publishColumns.has(column)) db.run(`ALTER TABLE component_publishes DROP COLUMN ${column}`);
  }
  if(tables.includes("design_systems")) {
    const dsColumns=new Set((db.query("PRAGMA table_info(design_systems)").all() as {name:string}[]).map(column=>column.name));
    if(dsColumns.has("acceptance")) db.run("ALTER TABLE design_systems DROP COLUMN acceptance");
  }
  // v28 (renderer-contract-2 R6) добавила аддитивные колонки cross-renderer guard'а обеим
  // визуальным таблицам — искусственный откат ниже 28 обязан снять и их.
  for(const [table,columns] of [
    ["visual_references",["renderer_fingerprint","renderer_json","font_manifest_hash","receipt_sha256","renderer_recorded_at"]],
    ["visual_runs",["renderer_guard","outcome_code","candidate_receipt_sha256","reference_receipt_sha256"]],
  ] as const) {
    if(!tables.includes(table)) continue;
    const present=new Set((db.query(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(column=>column.name));
    for(const column of columns) if(present.has(column)) db.run(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }
  // v24 создала таблицу пинов темы — искусственный откат ниже 24 обязан её снять.
  if(tables.includes("prototype_revision_theme_pins")) db.run("DROP TABLE prototype_revision_theme_pins");
  if(!tables.includes("design_system_versions")) return;
  const columns=(db.query("PRAGMA table_info(design_system_versions)").all() as {name:string}[]).map(row=>row.name);
  if(columns.includes("spacing_resolver")) db.run("ALTER TABLE design_system_versions DROP COLUMN spacing_resolver");
}


test("migrations upgrade a fresh v0 database to latest and a v16 database is idempotent",()=>{
  const db=new Database(":memory:"); migrate(db);
  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(32);
  const names=(db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(x=>x.name);
  expect(names).toEqual(expect.arrayContaining(["prototypes","prototype_revisions","prototype_revision_components","prototype_publishes","components","component_revisions","component_publishes","seed_log","design_systems","validation_records","assets","prototype_revision_assets","component_publish_assets","visual_references","visual_runs","visual_baseline_sets","design_system_versions","share_grants","share_sessions","users","user_sessions","audit_events","catalog_reuse_decisions","component_fingerprints","catalog_replacements","catalog_migration_runs","catalog_migration_staging","atomic_policy","maintenance_locks","prototype_revision_theme_pins","component_candidates","acceptance_runs","acceptance_cases","acceptance_case_results","component_case_sets","component_provenance","candidate_decisions"]));
  // v27 (RFC candidate-acceptance R3a): provenance-слой и append-only надгробия решений.
  const provenanceCols=(db.query("PRAGMA table_info(component_provenance)").all() as {name:string;pk:number}[]);
  expect(provenanceCols.map(c=>c.name)).toEqual(["component_id","rev","seq","figma_json","author","created_at"]);
  expect(provenanceCols.filter(c=>c.pk>0).map(c=>c.name)).toEqual(["component_id","rev","seq"]);
  expect((db.query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='candidate_decisions'").all() as {name:string}[]).map(r=>r.name)).toContain("candidate_decisions_one_rejected");
  // v26: контентно адресованные case-set-манифесты (план 2026-08-03 §5 W2) — PK и индекс по компоненту.
  const caseSetCols=(db.query("PRAGMA table_info(component_case_sets)").all() as {name:string;pk:number;notnull:number}[]);
  expect(caseSetCols.map(c=>c.name)).toEqual(["case_set_id","component_id","design_system","manifest_json","case_count","source_file_key","source_node_id","created_by","created_at"]);
  expect(caseSetCols.find(c=>c.name==="case_set_id")?.pk).toBe(1);
  expect((db.query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='component_case_sets'").all() as {name:string}[]).map(r=>r.name)).toContain("component_case_sets_component");
  // v25: колонки-свидетельства A9 (плоские TEXT без FK) и переключатель приёмки ДС с обязательным DEFAULT.
  const publishCols=(db.query("PRAGMA table_info(component_publishes)").all() as {name:string}[]).map(c=>c.name);
  expect(publishCols).toEqual(expect.arrayContaining(["candidate_id","acceptance_run_id"]));
  const acceptance=(db.query("PRAGMA table_info(design_systems)").all() as {name:string;notnull:number;dflt_value:string|null}[]).find(c=>c.name==="acceptance");
  expect(acceptance).toMatchObject({notnull:1,dflt_value:"'off'"});
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
  // v22 added the head-tracking lifecycle column with a 'pinned' default and no CHECK (contract-owned enum).
  const track=(db.query("PRAGMA table_info(prototypes)").all() as {name:string;notnull:number;dflt_value:string|null}[]).find(c=>c.name==="track");
  expect(track).toMatchObject({notnull:1,dflt_value:"'pinned'"});
  // v23 added the spacing-resolver version column on theme versions (default 1 = legacy resolver).
  const resolver=(db.query("PRAGMA table_info(design_system_versions)").all() as {name:string;notnull:number;dflt_value:string|null}[]).find(c=>c.name==="spacing_resolver");
  expect(resolver).toMatchObject({notnull:1,dflt_value:"1"});
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  migrate(db);
  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(32);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});

test("adds scoped-share grants and hashed sessions to a populated v9 database",()=>{
  const db=new Database(":memory:"); migrate(db);
  rollbackV11(db);
  db.run("DROP TABLE share_sessions"); db.run("DROP TABLE share_grants"); rollbackPostV22(db); db.run("PRAGMA user_version = 9");
  db.run("INSERT INTO prototypes (id,name,device,screen_count,head_rev,design_system,created_at,updated_at) VALUES ('shared','Shared','mobile',1,1,'shadcn','now','now')");
  db.run(`INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,created_at) VALUES ('shared',1,'{"version":1,"id":"shared","designSystem":"shadcn"}','h','now')`);
  db.run("INSERT INTO prototype_publishes (prototype_id,version,rev,published_at) VALUES ('shared',1,1,'now')");

  migrate(db);

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(32);
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
  rollbackV14(db);
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

// v22 добавляет колонку `prototypes.track` (план 2026-08-02, P2) — откат тривиальный DROP.
function rollbackV22(db:Database):void {
  const columns=new Set((db.query("PRAGMA table_info(prototypes)").all() as {name:string}[]).map(column=>column.name));
  if(columns.has("track")) db.run("ALTER TABLE prototypes DROP COLUMN track");
}

// v21 добавляет миграционный ledger and Composition v2 metadata.
function rollbackV21(db:Database):void {
  rollbackV22(db);
  db.run("DROP TABLE IF EXISTS maintenance_locks");
  db.run("DROP TABLE IF EXISTS atomic_policy");
  db.run("DROP TABLE IF EXISTS catalog_migration_staging");
  db.run("DROP TABLE IF EXISTS catalog_migration_runs");
  db.run("DROP TABLE IF EXISTS catalog_replacements");
  for(const trigger of [
    "compositions_reject_retired_design_system_insert",
    "compositions_reject_retired_design_system_update",
    "composition_revisions_reject_retired_design_system_insert",
    "composition_revisions_reject_retired_design_system_update",
  ]) db.run(`DROP TRIGGER IF EXISTS ${trigger}`);
  db.run("ALTER TABLE composition_publishes DROP COLUMN dependency_manifest_json");
  db.run("ALTER TABLE composition_publishes DROP COLUMN dependency_manifest_hash");
}

// v20 добавляет две таблицы (и триггеры аудита падают вместе со своей таблицей).
function rollbackV20(db:Database):void {
  rollbackV21(db);
  db.run("DROP TABLE IF EXISTS catalog_reuse_decisions");
  db.run("DROP TABLE IF EXISTS component_fingerprints");
}

// v19 добавляет одну таблицу сценариев — откат тривиальный DROP.
function rollbackV19(db:Database):void {
  rollbackV20(db);
  db.run("DROP TABLE IF EXISTS prototype_scenarios");
}

// v18 добавляет только новые таблицы, поэтому откат — их DROP в порядке FK-детей.
function rollbackV18(db:Database):void {
  rollbackV19(db);
  for(const table of ["prototype_revision_compositions","composition_publishes","composition_revisions","compositions"] as const) db.run(`DROP TABLE IF EXISTS ${table}`);
}

// v17 tombstone columns live on `components` — same rule as v16 below.
function rollbackV17(db:Database):void {
  rollbackV18(db);
  const columns=new Set((db.query("PRAGMA table_info(components)").all() as {name:string}[]).map(column=>column.name));
  for(const column of ["delete_reason","replacement_component_id"] as const) if(columns.has(column)) db.run(`ALTER TABLE components DROP COLUMN ${column}`);
}

// v16 columns live on `prototypes`, so every rollback below v16 has to drop them again —
// otherwise re-migration hits "duplicate column name: kind".
function rollbackV16(db:Database):void {
  rollbackV17(db);
  const columns=new Set((db.query("PRAGMA table_info(prototypes)").all() as {name:string}[]).map(column=>column.name));
  for(const column of ["kind","tags","derived_from"] as const) if(columns.has(column)) db.run(`ALTER TABLE prototypes DROP COLUMN ${column}`);
}

function rollbackV14(db:Database):void {
  rollbackV16(db);
  for(const name of RETIRED_DESIGN_SYSTEM_TRIGGER_NAMES) db.run(`DROP TRIGGER IF EXISTS ${name}`);
  const retired=(db.query("PRAGMA table_info(design_systems)").all() as {name:string}[]).some(column=>column.name==="retired");
  if(retired) db.run("ALTER TABLE design_systems DROP COLUMN retired");
  const has=(db.query("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='users'").get());
  if(!has) return;
  db.run("ALTER TABLE prototypes DROP COLUMN status");
  db.run("ALTER TABLE prototypes DROP COLUMN owner_id");
  db.run("ALTER TABLE components DROP COLUMN owner_id");
  db.run("ALTER TABLE design_systems DROP COLUMN owner_id");
  db.run("DROP TABLE audit_events");
  db.run("DROP TABLE user_sessions");
  db.run("DROP TABLE users");
}

test("v14 adds users, sessions, owners and publishes populated legacy prototypes",()=>{
  const db=new Database(":memory:"); migrate(db); rollbackV14(db); rollbackPostV22(db); db.run("PRAGMA user_version = 13");
  db.run("INSERT INTO prototypes (id,name,device,screen_count,head_rev,design_system,instance_id,created_at,updated_at) VALUES ('legacy-v14','Legacy','desktop',1,1,'shadcn','instance','now','now')");
  db.run(`INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,created_at) VALUES ('legacy-v14',1,'{"version":1,"id":"legacy-v14","designSystem":"shadcn"}','h','now')`);
  migrate(db);
  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(32);
  expect(db.query("SELECT owner_id,status FROM prototypes WHERE id='legacy-v14'").get()).toEqual({owner_id:null,status:"archived"});
  expect(db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='user_sessions_user'").get()).toEqual({name:"user_sessions_user"});
  expect(db.query("SELECT actor_id,subject_id FROM audit_events WHERE action='migration.applied'").get()).toEqual({actor_id:"system",subject_id:"v14"});
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});

test("v18 adds composition tables to a populated v17 database and pins them with FK RESTRICT",()=>{
  const db=new Database(":memory:"); migrate(db); rollbackV18(db); rollbackPostV22(db); db.run("PRAGMA user_version = 17");
  db.run("INSERT INTO users (id,name,password_hash,is_admin,created_at) VALUES ('user_owner_v18','Owner','hash',0,'now')");
  db.run("INSERT INTO prototypes (id,name,device,screen_count,head_rev,design_system,instance_id,owner_id,status,created_at,updated_at) VALUES ('legacy-v18','Legacy','mobile',1,1,'yandex-pay','instance-v18','user_owner_v18','private','now','now')");
  db.run(`INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,created_at) VALUES ('legacy-v18',1,'{"version":1,"id":"legacy-v18","designSystem":"yandex-pay"}','h','now')`);

  migrate(db);

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(32);
  db.run("INSERT INTO compositions (id,name,head_rev,design_system,owner_id,created_at,updated_at) VALUES ('c1','C1',1,'yandex-pay','user_owner_v18','now','now')");
  db.run("INSERT INTO composition_revisions (composition_id,rev,doc,design_system,created_at) VALUES ('c1',1,'{}','yandex-pay','now')");
  db.run("INSERT INTO composition_publishes (composition_id,version,rev,source_hash,published_at) VALUES ('c1',1,1,'hash','now')");
  db.run("INSERT INTO prototype_revision_compositions (prototype_id,rev,composition_id,composition_version) VALUES ('legacy-v18',1,'c1',1)");
  // FK RESTRICT: закреплённая публикация композиции не удаляется, пока на неё есть пин.
  expect(()=>db.run("DELETE FROM composition_publishes WHERE composition_id='c1' AND version=1")).toThrow();
  // Каскад по ревизии прототипа продолжает работать.
  db.run("DELETE FROM prototypes WHERE id='legacy-v18'");
  expect(db.query("SELECT COUNT(*) count FROM prototype_revision_compositions").get()).toEqual({count:0});
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});

test("v19 adds prototype scenarios to a populated v18 database and cascades with the prototype",()=>{
  const db=new Database(":memory:"); migrate(db); rollbackV19(db); rollbackPostV22(db); db.run("PRAGMA user_version = 18");
  db.run("INSERT INTO users (id,name,password_hash,is_admin,created_at) VALUES ('user_owner_v19','Owner','hash',0,'now')");
  db.run("INSERT INTO prototypes (id,name,device,screen_count,head_rev,design_system,instance_id,owner_id,status,created_at,updated_at) VALUES ('legacy-v19','Legacy','mobile',1,1,'yandex-pay','instance-v19','user_owner_v19','private','now','now')");
  db.run(`INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,created_at) VALUES ('legacy-v19',1,'{"version":1,"id":"legacy-v19","designSystem":"yandex-pay"}','h','now')`);

  migrate(db);

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(32);
  db.run(`INSERT INTO prototype_scenarios (prototype_id,id,name,steps_json,author,created_at,updated_at) VALUES ('legacy-v19','happy','Happy path','[{"type":"expectScreen","screenId":"home"}]','user_owner_v19','now','now')`);
  // id уникален в пределах прототипа, а не глобально.
  expect(()=>db.run(`INSERT INTO prototype_scenarios (prototype_id,id,name,steps_json,created_at,updated_at) VALUES ('legacy-v19','happy','Dup','[]','now','now')`)).toThrow();
  // Сценарии живут ровно столько, сколько прототип.
  db.run("DELETE FROM prototypes WHERE id='legacy-v19'");
  expect(db.query("SELECT COUNT(*) count FROM prototype_scenarios").get()).toEqual({count:0});
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});

test("v20 adds the append-only reuse audit and the content-addressed fingerprint cache to a populated v19 database",()=>{
  const db=new Database(":memory:"); migrate(db); rollbackV20(db); rollbackPostV22(db); db.run("PRAGMA user_version = 19");
  db.run("INSERT INTO users (id,name,password_hash,is_admin,created_at) VALUES ('user_owner_v20','Owner','hash',0,'now')");
  db.run("INSERT INTO components (id,name,head_rev,design_system,owner_id,created_at,updated_at) VALUES ('legacy-v20','legacy-v20',1,'yandex-pay','user_owner_v20','now','now')");
  db.run("INSERT INTO component_revisions (component_id,rev,source,design_system,created_at) VALUES ('legacy-v20',1,'export default () => null','yandex-pay','now')");

  migrate(db);

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(32);
  // Ключевое свойство схемы: `artifact_id` без FK — `blocked` ссылается на предложенный id
  // компонента, которого в базе нет и не будет.
  db.run(`INSERT INTO catalog_reuse_decisions (id,actor_id,artifact_kind,artifact_id,design_system,source_or_doc_hash,catalog_revision,policy_version,gate_mode,intent,candidates_json,decision,reason,created_at)
    VALUES ('d1','user_owner_v20','component','yp-never-created','yandex-pay','sha','rev',1,'enforce','intent','[]','blocked',NULL,'now')`);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  // Append-only: обе мутации отбиваются триггером.
  expect(()=>db.run("UPDATE catalog_reuse_decisions SET decision='accepted_no_match' WHERE id='d1'")).toThrow();
  expect(()=>db.run("DELETE FROM catalog_reuse_decisions WHERE id='d1'")).toThrow();
  expect(db.query("SELECT decision FROM catalog_reuse_decisions WHERE id='d1'").get()).toEqual({decision:"blocked"});
  // CHECK-ограничения фиксируют словари режима и решения.
  expect(()=>db.run(`INSERT INTO catalog_reuse_decisions (id,actor_id,artifact_kind,artifact_id,design_system,source_or_doc_hash,catalog_revision,policy_version,gate_mode,candidates_json,decision,created_at)
    VALUES ('d2','a','component','x','yandex-pay','s','r',1,'audit','[]','blocked','now')`)).toThrow();
  expect(()=>db.run(`INSERT INTO catalog_reuse_decisions (id,actor_id,artifact_kind,artifact_id,design_system,source_or_doc_hash,catalog_revision,policy_version,gate_mode,candidates_json,decision,created_at)
    VALUES ('d3','a','component','x','yandex-pay','s','r',1,'shadow','[]','maybe','now')`)).toThrow();
  for(const decision of ["accepted_no_match","would_block","force_new","intent_missing"] as const) {
    db.run(`INSERT INTO catalog_reuse_decisions (id,actor_id,artifact_kind,artifact_id,design_system,source_or_doc_hash,catalog_revision,policy_version,gate_mode,candidates_json,decision,created_at)
      VALUES ('d_${decision}','a','component','x','yandex-pay','s','r',1,'shadow','[]','${decision}','now')`);
  }
  const indexes=(db.query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='catalog_reuse_decisions'").all() as {name:string}[]).map(row=>row.name);
  expect(indexes).toEqual(expect.arrayContaining(["catalog_reuse_decisions_actor","catalog_reuse_decisions_artifact","catalog_reuse_decisions_decision"]));
  // Кэш отпечатков: ключ — тройка, а не component_id.
  db.run("INSERT INTO component_fingerprints (component_id,rev,source_sha256,shingles_json,updated_at) VALUES ('legacy-v20',1,'sha-a','[\"a\"]','now')");
  db.run("INSERT INTO component_fingerprints (component_id,rev,source_sha256,shingles_json,updated_at) VALUES ('legacy-v20',1,'sha-b','[\"b\"]','now')");
  expect(()=>db.run("INSERT INTO component_fingerprints (component_id,rev,source_sha256,shingles_json,updated_at) VALUES ('legacy-v20',1,'sha-a','[\"c\"]','now')")).toThrow();
  expect(db.query("SELECT COUNT(*) count FROM component_fingerprints").get()).toEqual({count:2});
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});

test("v16 adds lifecycle columns to a populated v15 database and defaults existing rows to product-flow",()=>{
  const db=new Database(":memory:"); migrate(db); rollbackV16(db); rollbackPostV22(db); db.run("PRAGMA user_version = 15");
  db.run("INSERT INTO users (id,name,password_hash,is_admin,created_at) VALUES ('user_owner','Owner','hash',0,'now')");
  db.run("INSERT INTO prototypes (id,name,device,screen_count,head_rev,design_system,instance_id,owner_id,status,created_at,updated_at) VALUES ('legacy-v16','Legacy','mobile',1,1,'yandex-pay','instance','user_owner','private','now','now')");
  db.run(`INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,created_at) VALUES ('legacy-v16',1,'{"version":1,"id":"legacy-v16","designSystem":"yandex-pay"}','h','now')`);

  migrate(db);

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(32);
  expect(db.query("SELECT kind,tags,derived_from FROM prototypes WHERE id='legacy-v16'").get()).toEqual({kind:"product-flow",tags:null,derived_from:null});
  // The column carries no CHECK by design (see the migration comment) — the zod contract owns the enum.
  db.run("UPDATE prototypes SET kind='component-gallery',tags='[\"catalog\"]',derived_from='other' WHERE id='legacy-v16'");
  expect(db.query("SELECT kind,tags,derived_from FROM prototypes WHERE id='legacy-v16'").get()).toEqual({kind:"component-gallery",tags:'["catalog"]',derived_from:"other"});
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});

test("v22 adds the track column to a populated v21 database and defaults existing rows to pinned",()=>{
  const db=new Database(":memory:"); migrate(db); rollbackV22(db); rollbackPostV22(db); db.run("PRAGMA user_version = 21");
  db.run("INSERT INTO users (id,name,password_hash,is_admin,created_at) VALUES ('user_owner_v22','Owner','hash',0,'now')");
  db.run("INSERT INTO prototypes (id,name,device,screen_count,head_rev,design_system,instance_id,owner_id,status,created_at,updated_at) VALUES ('legacy-v22','Legacy','mobile',1,1,'yandex-pay','instance-v22','user_owner_v22','private','now','now')");
  db.run(`INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,created_at) VALUES ('legacy-v22',1,'{"version":1,"id":"legacy-v22","designSystem":"yandex-pay"}','h','now')`);

  migrate(db);

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(32);
  // Существующие строки читаются как pinned (сегодняшняя семантика пинов ревизии).
  expect(db.query("SELECT track FROM prototypes WHERE id='legacy-v22'").get()).toEqual({track:"pinned"});
  // Колонка без CHECK по дизайну (см. комментарий миграции): enum принадлежит zod-контракту.
  db.run("UPDATE prototypes SET track='head' WHERE id='legacy-v22'");
  expect(db.query("SELECT track FROM prototypes WHERE id='legacy-v22'").get()).toEqual({track:"head"});
  // Идемпотентно: повторный прогон не падает и не меняет записанное значение.
  migrate(db);
  expect(db.query("SELECT track FROM prototypes WHERE id='legacy-v22'").get()).toEqual({track:"head"});
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});

test("v17 adds component tombstone columns to a populated v16 database without touching existing rows",()=>{
  const db=new Database(":memory:"); migrate(db); rollbackV17(db); rollbackPostV22(db); db.run("PRAGMA user_version = 16");
  db.run("INSERT INTO users (id,name,password_hash,is_admin,created_at) VALUES ('user_owner_v17','Owner','hash',0,'now')");
  db.run("INSERT INTO components (id,name,head_rev,design_system,deleted_at,owner_id,created_at,updated_at) VALUES ('legacy-v17','LegacyV17',1,'yandex-pay',NULL,'user_owner_v17','now','now')");
  db.run("INSERT INTO component_revisions (component_id,rev,source,design_system,created_at) VALUES ('legacy-v17',1,'export const definition={}','yandex-pay','now')");

  migrate(db);

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(32);
  expect(db.query("SELECT deleted_at,delete_reason,replacement_component_id FROM components WHERE id='legacy-v17'").get())
    .toEqual({deleted_at:null,delete_reason:null,replacement_component_id:null});
  // Надгробие пишется без FK на замену: удалённая замена не должна ломать историю.
  db.run("UPDATE components SET deleted_at='now',delete_reason='superseded by v2',replacement_component_id='gone' WHERE id='legacy-v17'");
  expect(db.query("SELECT delete_reason,replacement_component_id FROM components WHERE id='legacy-v17'").get())
    .toEqual({delete_reason:"superseded by v2",replacement_component_id:"gone"});
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});

test("v13 backfills a distinct immutable instance id per populated prototype and preserves rows",()=>{
  const db=new Database(":memory:"); migrate(db); rollbackV13(db); rollbackPostV22(db); db.run("PRAGMA user_version = 12");
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
  const db=new Database(":memory:"); migrate(db); rollbackV12(db); rollbackPostV22(db); db.run("PRAGMA user_version = 11");
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
  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(32);
  expect(db.query("SELECT instance_id FROM prototypes WHERE id='retry'").get()).toEqual({instance_id:expect.any(String)});
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});

test("v11 preserves populated visual history and leaves legacy baseline evidence unknown",()=>{
  const db=new Database(":memory:"); migrate(db); rollbackV11(db); rollbackPostV22(db); db.run("PRAGMA user_version = 10");
  db.run("INSERT INTO assets (id,sha256,mime,size,width,height,created_at) VALUES ('asset_old','old','image/png',10,4,4,'now')");
  db.run("INSERT INTO assets (id,sha256,mime,size,width,height,created_at) VALUES ('asset_candidate','candidate','image/png',10,4,4,'now')");
  db.run("INSERT INTO visual_references (id,fingerprint_json,asset_id,created_at) VALUES ('vref_legacy','{\"scope\":\"component\"}','asset_old','before')");
  db.run("INSERT INTO visual_runs (id,reference_id,candidate_asset_id,status,created_at) VALUES ('vrun_legacy','vref_legacy','asset_candidate','pass','before')");

  migrate(db);

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(32);
  expect(db.query("SELECT reference_asset_id FROM visual_runs WHERE id='vrun_legacy'").get()).toEqual({reference_asset_id:null});
  expect(db.query("SELECT deleted_at FROM visual_references WHERE id='vref_legacy'").get()).toEqual({deleted_at:null});
  expect(()=>db.run("DELETE FROM visual_references WHERE id='vref_legacy'")).toThrow();
  db.run("INSERT INTO visual_runs (id,reference_id,reference_asset_id,status,created_at) VALUES ('vrun_new','vref_legacy','asset_old','pass','after')");
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.query("SELECT COUNT(*) count FROM visual_runs").get()).toEqual({count:2});
  db.close();
});

test("v12 adds asset listing and reverse hard-pin indexes to a populated v11 database",()=>{
  const db=new Database(":memory:"); migrate(db); rollbackV12(db); rollbackPostV22(db); db.run("PRAGMA user_version = 11");
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

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(32);
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
  rollbackPostV22(db); db.run("PRAGMA user_version = 2"); db.run("DROP TABLE component_publish_assets"); db.run("DROP TABLE prototype_revision_assets"); db.run("DROP TABLE assets"); db.run("DROP TABLE design_systems"); db.run("DROP TABLE validation_records");
  db.run("ALTER TABLE component_revisions DROP COLUMN design_system");
  db.run("INSERT INTO prototypes (id,name,device,screen_count,head_rev,design_system,created_at,updated_at) VALUES ('legacy','Legacy','desktop',1,1,'wireframe','now','now')");
  db.run(`INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,created_at) VALUES ('legacy',1,'{"version":1,"id":"legacy","designSystem":"wireframe"}','','now')`);
  db.run("INSERT INTO components (id,name,head_rev,design_system,deleted_at,created_at,updated_at) VALUES ('custom','LegacyCustom',1,'wireframe',NULL,'now','now')");
  db.run("INSERT INTO component_revisions (component_id,rev,source,created_at) VALUES ('custom',1,'source','now')");

  migrate(db);

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(32);
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
  db.run("DROP TABLE component_publish_assets"); db.run("DROP TABLE prototype_revision_assets"); db.run("DROP TABLE assets"); db.run("DROP TABLE validation_records"); rollbackPostV22(db); db.run("PRAGMA user_version = 3");

  migrate(db);

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(32);
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
  db.run("DROP TABLE component_publish_assets"); db.run("DROP TABLE prototype_revision_assets"); db.run("DROP TABLE assets"); rollbackPostV22(db); db.run("PRAGMA user_version = 4");

  migrate(db);

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(32);
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
  db.run("DROP TABLE visual_runs"); db.run("DROP TABLE visual_references"); rollbackPostV22(db); db.run("PRAGMA user_version = 5");

  migrate(db);

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(32);
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
  rollbackBelowV7(db); rollbackPostV22(db); db.run("PRAGMA user_version = 6");

  migrate(db);

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(32);
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

test("v23 backfills spacing_resolver=1 on existing theme versions of a populated v22 database",()=>{
  const db=new Database(":memory:"); migrate(db);
  // Roll the theme-version table back to its pre-v23 shape and repopulate it as a v22 server would.
  db.run("DROP TABLE design_system_versions");
  db.run(`CREATE TABLE design_system_versions (
    system_id TEXT NOT NULL REFERENCES design_systems(id) ON DELETE CASCADE,
    version INTEGER NOT NULL, tokens_json TEXT NOT NULL, fonts_json TEXT NOT NULL,
    icons_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (system_id,version))`);
  db.run("INSERT INTO design_systems (id,name,description,builtin_provider,created_at,updated_at) VALUES ('legacy-ds','Legacy','Legacy',NULL,'now','now')");
  db.run(`INSERT INTO design_system_versions (system_id,version,tokens_json,fonts_json,icons_json,created_at)
    VALUES ('legacy-ds',1,'{"space.md":"20px"}','[]','[]','now'),('legacy-ds',2,'{"color.brand":"red"}','[]','[]','now')`);
  rollbackPostV22(db); db.run("PRAGMA user_version = 22");

  migrate(db);

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(32);
  // Every pre-existing version keeps the legacy resolver; content is untouched.
  expect(db.query("SELECT version,spacing_resolver FROM design_system_versions WHERE system_id='legacy-ds' ORDER BY version").all())
    .toEqual([{version:1,spacing_resolver:1},{version:2,spacing_resolver:1}]);
  expect(db.query("SELECT tokens_json FROM design_system_versions WHERE system_id='legacy-ds' AND version=1").get()).toEqual({tokens_json:'{"space.md":"20px"}'});
  // Rows written without the column still land on the legacy resolver.
  db.run("INSERT INTO design_system_versions (system_id,version,tokens_json,fonts_json,icons_json,created_at) VALUES ('legacy-ds',3,'{}','[]','[]','now')");
  expect(db.query("SELECT spacing_resolver FROM design_system_versions WHERE system_id='legacy-ds' AND version=3").get()).toEqual({spacing_resolver:1});
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
  rollbackPostV22(db); db.run("PRAGMA user_version = 7");
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

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(32);
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

test("startup no longer rejects custom names formerly used by builtin systems",()=>{
  const db=new Database(":memory:"); migrate(db);
  db.run("INSERT INTO components (id,name,head_rev,design_system,deleted_at,created_at,updated_at) VALUES ('collision','Button',1,'yandex-pay',NULL,'now','now')");
  db.run("INSERT INTO component_revisions (component_id,rev,source,design_system,created_at) VALUES ('collision',1,'source','yandex-pay','now')");
  expect(()=>migrate(db)).not.toThrow();
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
    db.run("INSERT INTO component_revisions (component_id,rev,source,design_system,created_at) VALUES ('bad',1,'x','yandex-pay','now')");
  } else if(table==="component_revisions") {
    db.run("INSERT INTO components (id,name,head_rev,design_system,created_at,updated_at) VALUES ('bad','Bad',1,'yandex-pay','now','now')");
    db.run("INSERT INTO component_revisions (component_id,rev,source,design_system,created_at) VALUES ('bad',1,'x','missing','now')");
  } else {
    db.run("INSERT INTO prototypes (id,name,device,screen_count,head_rev,design_system,instance_id,created_at,updated_at) VALUES ('bad','Bad','desktop',1,1,'missing','fixture-instance','now','now')");
    db.run(`INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,created_at) VALUES ('bad',1,'{"version":1,"id":"bad","designSystem":"missing"}','','now')`);
  }
  expect(()=>migrate(db)).toThrow(`Dangling design system reference in ${table}`); db.close();
});

test("startup audit rejects component and prototype head mismatches",()=>{
  const componentDb=new Database(":memory:"); migrate(componentDb);
  componentDb.run("INSERT INTO design_systems (id,name,description,builtin_provider,retired,created_at,updated_at) VALUES ('other','Other','Other',NULL,0,'now','now')");
  componentDb.run("INSERT INTO components (id,name,head_rev,design_system,created_at,updated_at) VALUES ('bad','Bad',1,'other','now','now')");
  componentDb.run("INSERT INTO component_revisions (component_id,rev,source,design_system,created_at) VALUES ('bad',1,'x','yandex-pay','now')");
  expect(()=>migrate(componentDb)).toThrow("Component head design system mismatch: bad"); componentDb.close();
  const prototypeDb=new Database(":memory:"); migrate(prototypeDb);
  prototypeDb.run("INSERT INTO design_systems (id,name,description,builtin_provider,retired,created_at,updated_at) VALUES ('other','Other','Other',NULL,0,'now','now')");
  prototypeDb.run("INSERT INTO prototypes (id,name,device,screen_count,head_rev,design_system,instance_id,created_at,updated_at) VALUES ('bad','Bad','desktop',1,1,'other','fixture-instance','now','now')");
  prototypeDb.run(`INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,created_at) VALUES ('bad',1,'{"version":1,"id":"bad","designSystem":"yandex-pay"}','','now')`);
  expect(()=>migrate(prototypeDb)).toThrow("Prototype head design system mismatch: bad"); prototypeDb.close();
});

test("startup audit rejects an unknown builtin provider",()=>{
  const db=new Database(":memory:"); migrate(db);
  db.run("INSERT INTO design_systems (id,name,description,builtin_provider,created_at,updated_at) VALUES ('bad','Bad','Bad provider','unknown','now','now')");
  expect(()=>migrate(db)).toThrow("Unknown builtin provider for design system bad: unknown"); db.close();
});

test("startup allows an unknown provider only when its design system is retired",()=>{
  const db=new Database(":memory:");migrate(db);
  db.run("INSERT INTO design_systems (id,name,description,builtin_provider,retired,created_at,updated_at) VALUES ('legacy-provider','Legacy','Retired provider','removed-provider',1,'now','now')");
  expect(()=>migrate(db)).not.toThrow();
  db.run("UPDATE design_systems SET retired=0 WHERE id='legacy-provider'");
  expect(()=>migrate(db)).toThrow("Unknown builtin provider for design system legacy-provider: removed-provider");
  db.close();
});

test("startup checks that every retired-reference trigger is installed",()=>{
  const db=new Database(":memory:");migrate(db);
  db.run(`DROP TRIGGER ${RETIRED_DESIGN_SYSTEM_TRIGGER_NAMES[0]}`);
  expect(()=>migrate(db)).toThrow("Missing retired design-system triggers");
  db.close();
});

/**
 * План 2026-08-02 multi-surface-flows, W3: шаг v24 — таблица пинов темы и пересоздание
 * триггеров ретайрнутых ДС (те же два имени, плюс скан `doc.surfaces[].designSystem`).
 */
test("v24 adds the theme-pin table and re-creates the retired-design-system triggers on a populated v23 database",()=>{
  const db=new Database(":memory:"); migrate(db);
  // Искусственный откат до v23: снимаем таблицу и возвращаем тела триггеров шага v15.
  db.run("DROP TABLE prototype_revision_theme_pins");
  for(const [suffix,event] of [["insert","INSERT"],["update","UPDATE OF prototype_id,doc"]] as const) {
    db.run(`DROP TRIGGER prototype_revisions_reject_retired_design_system_${suffix}`);
    db.run(`CREATE TRIGGER prototype_revisions_reject_retired_design_system_${suffix}
      BEFORE ${event} ON prototype_revisions
      WHEN EXISTS (
        SELECT 1 FROM prototypes p JOIN design_systems ds
          ON ds.id=COALESCE(json_extract(NEW.doc,'$.designSystem'),p.design_system)
        WHERE p.id=NEW.prototype_id AND ds.retired=1)
      BEGIN SELECT RAISE(ABORT,'retired design system reference'); END`);
  }
  rollbackPostV22(db); db.run("PRAGMA user_version = 23");
  const at="2026-08-02T00:00:00.000Z";
  db.query("INSERT INTO design_systems (id,name,description,builtin_provider,created_at,updated_at) VALUES (?,?,?,NULL,?,?)").run("kso-ds","KSO","fixture",at,at);
  db.query("INSERT INTO users (id,name,password_hash,is_admin,created_at) VALUES ('u','U','x',0,?)").run(at);
  db.run(`INSERT INTO prototypes (id,name,device,screen_count,head_rev,design_system,instance_id,created_at,updated_at,owner_id)
    VALUES ('duo','Duo','desktop',2,1,'yandex-pay','duo-instance','${at}','${at}','u')`);
  const doc=JSON.stringify({version:1,id:"duo",designSystem:"yandex-pay",surfaces:[{id:"kso",designSystem:"yandex-pay"},{id:"app",designSystem:"kso-ds"}]});
  db.query("INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,design_system_meta_version,created_at) VALUES ('duo',1,?,'hash',NULL,?)").run(doc,at);

  migrate(db);

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(32);
  // Бэкфила нет by design: существующая ревизия остаётся без строк пинов.
  expect(db.query("SELECT COUNT(*) n FROM prototype_revision_theme_pins").get()).toEqual({n:0});
  // Имена триггеров не менялись — старая проверка целостности зелёная.
  const installed=(db.query("SELECT name FROM sqlite_master WHERE type='trigger'").all() as {name:string}[]).map(row=>row.name);
  expect(RETIRED_DESIGN_SYSTEM_TRIGGER_NAMES.every(name=>installed.includes(name))).toBe(true);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);

  // Обычная ревизия (без surfaces) пишется как раньше.
  db.query("INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,created_at) VALUES ('duo',2,?,'hash',?)")
    .run(JSON.stringify({version:1,id:"duo",designSystem:"yandex-pay"}),at);
  // Ссылка поверхности на ретайрнутую ДС — ABORT нового тела триггера.
  db.run("UPDATE design_systems SET retired=1 WHERE id='kso-ds'");
  expect(()=>db.query("INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,created_at) VALUES ('duo',3,?,'hash',?)").run(doc,at))
    .toThrow(/retired design system reference/);
  db.close();
});

/**
 * v30 (план 2026-08-04 W7): multi-run provenance. Проверяется на **populated** базе: строка
 * версии и строка рана, записанные до миграции, обязаны пережить её без изменений, а новые
 * колонки — появиться как NULL (backfill'а нет by design: `acceptance_run_ids IS NULL` читается
 * как `[acceptance_run_id]`, а неизвестный рендерер до-миграционного рана вычислить нечем).
 */
test("v30 adds multi-run provenance columns to a populated v29 database without touching existing rows",()=>{
  const db=new Database(":memory:"); migrate(db);
  db.run("ALTER TABLE component_publishes DROP COLUMN acceptance_run_ids");
  db.run("ALTER TABLE acceptance_runs DROP COLUMN renderer_fingerprint");
  // Искусственный откат до v29 снимает и колонки v31/v32 — иначе повторный прогон ловит
  // duplicate column (их шаги применяются в том же вызове `migrate` следом за v30).
  db.run("ALTER TABLE acceptance_cases DROP COLUMN slots_hash");
  db.run("ALTER TABLE acceptance_cases DROP COLUMN expected_surfaces_json");
  db.run("PRAGMA user_version = 29");
  const at="2026-08-04T00:00:00.000Z";
  db.run("INSERT INTO components (id,name,head_rev,design_system,created_at,updated_at) VALUES ('yp-legacy','YpLegacy',1,'yandex-pay','now','now')");
  db.run("INSERT INTO component_revisions (component_id,rev,source,design_system,created_at) VALUES ('yp-legacy',1,'src','yandex-pay','now')");
  db.query(`INSERT INTO component_candidates
    (candidate_id,component_id,design_system,rev,source_hash,bundle_hash,host_abi_version,theme_version,build_fingerprint,
     observed_catalog_revision,policy_profile_hash,status,created_by,created_at,expires_at)
    VALUES ('cand_legacy','yp-legacy','yandex-pay',1,'src-hash','bundle-hash',4,NULL,'bf','cat','ph','validated','u',?,?)`).run(at,at);
  db.query(`INSERT INTO acceptance_runs
    (run_id,candidate_id,component_id,status,policy_profile_hash,policy_profile_id,progress_json,gates_json,created_by,created_at)
    VALUES ('acc_legacy','cand_legacy','yp-legacy','pass','ph','default-v1','{}','{}','u',?)`).run(at);
  db.query(`INSERT INTO component_publishes
    (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,published_at,candidate_id,acceptance_run_id)
    VALUES ('yp-legacy',1,1,'active','js','{}','src-hash','bundle-hash',4,?,'cand_legacy','acc_legacy')`).run(at);

  migrate(db);

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(32);
  expect(db.query("SELECT acceptance_run_id one,acceptance_run_ids many FROM component_publishes WHERE component_id='yp-legacy'").get())
    .toEqual({one:"acc_legacy",many:null});
  expect(db.query("SELECT status,renderer_fingerprint fp FROM acceptance_runs WHERE run_id='acc_legacy'").get())
    .toEqual({status:"pass",fp:null});
  // Новые строки пишутся с обеими колонками — контракт «скаляр = первый элемент массива».
  db.query("UPDATE component_publishes SET acceptance_run_ids=?,acceptance_run_id=? WHERE component_id='yp-legacy'")
    .run(JSON.stringify(["acc_legacy","acc_second"]),"acc_legacy");
  expect(db.query("SELECT j.value id FROM component_publishes p, json_each(p.acceptance_run_ids) j WHERE p.component_id='yp-legacy'").all())
    .toEqual([{id:"acc_legacy"},{id:"acc_second"}]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});

/**
 * v31 (план 2026-08-05 §A8, волна W2): слоты случая приёмки. Проверяется на **populated** базе:
 * строки случаев, записанные до миграции, обязаны пережить её без изменений, а `slots_hash` —
 * появиться как NULL. Backfill'а нет, потому что backfill'ить нечего: слотов до v31 не
 * существовало, и NULL здесь читается как «случай без слотов», а не как «неизвестно» (в отличие
 * от слоёв отпечатка v29).
 */
test("v31 adds slots_hash to a populated v30 database without touching existing cases",()=>{
  const db=new Database(":memory:"); migrate(db);
  db.run("ALTER TABLE acceptance_cases DROP COLUMN slots_hash");
  db.run("ALTER TABLE acceptance_cases DROP COLUMN expected_surfaces_json");
  db.run("PRAGMA user_version = 30");
  const at="2026-08-05T00:00:00.000Z";
  db.run("INSERT INTO components (id,name,head_rev,design_system,created_at,updated_at) VALUES ('yp-slots','YpSlots',1,'yandex-pay','now','now')");
  db.run("INSERT INTO component_revisions (component_id,rev,source,design_system,created_at) VALUES ('yp-slots',1,'src','yandex-pay','now')");
  db.query(`INSERT INTO component_candidates
    (candidate_id,component_id,design_system,rev,source_hash,bundle_hash,host_abi_version,theme_version,build_fingerprint,
     observed_catalog_revision,policy_profile_hash,status,created_by,created_at,expires_at)
    VALUES ('cand_slots','yp-slots','yandex-pay',1,'src-hash','bundle-hash',4,NULL,'bf','cat','ph','validated','u',?,?)`).run(at,at);
  db.query(`INSERT INTO acceptance_runs
    (run_id,candidate_id,component_id,status,policy_profile_hash,policy_profile_id,progress_json,gates_json,created_by,created_at)
    VALUES ('acc_slots','cand_slots','yp-slots','pass','ph','default-v1','{}','{}','u',?)`).run(at);
  for(const caseId of ["alpha","beta"]) {
    db.query(`INSERT INTO acceptance_cases
      (run_id,case_id,case_key,props_hash,case_fingerprint,case_policy_hash,status,verdict,gates_json,frame_fingerprint,started_at,finished_at)
      VALUES ('acc_slots',?,?,'props-1',?,'ph_case','done','pass','[]',?,?,?)`).run(caseId,caseId,`fp_${caseId}`,`frame_${caseId}`,at,at);
  }

  migrate(db);

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(32);
  // Backfill'а нет: обе до-миграционные строки видят NULL, остальные поля не тронуты.
  expect(db.query("SELECT case_id id,props_hash props,frame_fingerprint frame,verdict,slots_hash slots FROM acceptance_cases WHERE run_id='acc_slots' ORDER BY case_id").all())
    .toEqual([
      {id:"alpha",props:"props-1",frame:"frame_alpha",verdict:"pass",slots:null},
      {id:"beta",props:"props-1",frame:"frame_beta",verdict:"pass",slots:null},
    ]);
  // Колонка nullable и без DEFAULT: INSERT состава v30 (без `slots_hash`) продолжает проходить.
  expect(()=>db.query(`INSERT INTO acceptance_cases
    (run_id,case_id,case_key,props_hash,case_fingerprint,case_policy_hash,status,gates_json,started_at,finished_at)
    VALUES ('acc_slots','gamma','gamma','props-2','fp_gamma','ph_case','pending',NULL,NULL,NULL)`).run()).not.toThrow();
  expect(db.query("SELECT slots_hash slots FROM acceptance_cases WHERE case_id='gamma'").get()).toEqual({slots:null});
  // Новые строки пишут хэш разрешённых слотов; это обычный TEXT, никаких CHECK/FK на нём нет.
  db.run("UPDATE acceptance_cases SET slots_hash='slots-1' WHERE case_id='beta'");
  expect(db.query("SELECT case_id id FROM acceptance_cases WHERE slots_hash='slots-1'").all()).toEqual([{id:"beta"}]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});

/**
 * Обратный тест отката образа (план 2026-08-04, триаж C28): **код v28 на БД v29/v30**.
 *
 * Прямое направление (v28-БД → v29 → v30) проверяют тесты выше; здесь проверяется то, что
 * случается при откате образа после миграции, когда откатить схему уже нельзя:
 *
 * 1. **старт** — `migrate()` старого кода на «будущей» БД не запускает ни одного шага
 *    (цикл `for(index=current; index<migrations.length)` при `current ≥ length` пуст) и ничего
 *    не ломает; здесь это моделируется повторным прогоном на уже мигрированной базе;
 * 2. **запись** — INSERT'ы ровно того состава колонок, который знал код до v29/v30, проходят:
 *    все новые колонки nullable и без DEFAULT-ограничений;
 * 3. **чтение** — строки, записанные старым составом, читаются целиком, а новые колонки честно
 *    отвечают NULL («неизвестно»), что и уводит каскад reuse в пересъёмку (D17), а promote —
 *    в legacy-ветку `acceptance_run_ids IS NULL ⇒ [acceptance_run_id]`.
 *
 * Образец — `server/visual-renderer-guard.test.ts` («старый образ на БД v28»).
 */
test("откат образа: код v28 на БД v31 стартует, пишет и читает приёмку без колонок v29/v30/v31 (C28)",()=>{
  const db=new Database(":memory:"); migrate(db);
  const at="2026-08-04T12:00:00.000Z";
  // (1) Старт старого образа: миграций к применению нет, аудит FK проходит.
  expect(()=>migrate(db)).not.toThrow();
  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(32);

  db.run("INSERT INTO components (id,name,head_rev,design_system,created_at,updated_at) VALUES ('yp-rollback','YpRollback',1,'yandex-pay','now','now')");
  db.run("INSERT INTO component_revisions (component_id,rev,source,design_system,created_at) VALUES ('yp-rollback',1,'src','yandex-pay','now')");

  // (2) Запись составом v28: ни `refresh_json`/`status_reason` (v29), ни `renderer_fingerprint` (v30),
  // ни слоёв отпечатка, ни квитанции reuse — их этот код не знает.
  db.query(`INSERT INTO component_candidates
    (candidate_id,component_id,design_system,rev,source_hash,bundle_hash,host_abi_version,theme_version,build_fingerprint,
     observed_catalog_revision,policy_profile_hash,status,created_by,created_at,expires_at)
    VALUES ('cand_rollback','yp-rollback','yandex-pay',1,'src-hash','bundle-hash',4,NULL,'bf','cat','ph','validated','u',?,?)`).run(at,at);
  db.query(`INSERT INTO acceptance_runs
    (run_id,candidate_id,component_id,status,policy_profile_hash,policy_profile_id,progress_json,gates_json,created_by,created_at)
    VALUES ('acc_rollback','cand_rollback','yp-rollback','pass','ph','default-v1','{"total":1}','{}','u',?)`).run(at);
  db.query(`INSERT INTO acceptance_cases
    (run_id,case_id,case_key,props_hash,case_fingerprint,case_policy_hash,status,verdict,gates_json,started_at,finished_at)
    VALUES ('acc_rollback','alpha','alpha','props','fp_case','ph_case','done','pass','[]',?,?)`).run(at,at);
  db.query(`INSERT INTO acceptance_case_results
    (case_fingerprint,component_id,artifacts_json,metrics_json,verdict,produced_run_id,created_at,last_used_at)
    VALUES ('fp_case','yp-rollback','[]','{}','pass','acc_rollback',?,?)`).run(at,at);
  db.query(`INSERT INTO component_publishes
    (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,published_at,candidate_id,acceptance_run_id)
    VALUES ('yp-rollback',1,1,'active','js','{}','src-hash','bundle-hash',4,?,'cand_rollback','acc_rollback')`).run(at);

  // (3) Чтение: строки на месте, новые колонки — NULL, а не мусор и не отказ.
  expect(db.query("SELECT status,refresh_json refresh,status_reason reason,renderer_fingerprint fp FROM acceptance_runs WHERE run_id='acc_rollback'").get())
    .toEqual({status:"pass",refresh:null,reason:null,fp:null});
  expect(db.query(`SELECT verdict,frame_fingerprint frame,comparison_fingerprint comparison,verdict_policy_hash vph,reuse_receipt_json receipt,slots_hash slots
    FROM acceptance_cases WHERE run_id='acc_rollback' AND case_id='alpha'`).get())
    .toEqual({verdict:"pass",frame:null,comparison:null,vph:null,receipt:null,slots:null});
  expect(db.query(`SELECT verdict,frame_fingerprint frame,comparison_fingerprint comparison,verdict_policy_hash vph,verdict_policy_json snapshot
    FROM acceptance_case_results WHERE case_fingerprint='fp_case'`).get())
    .toEqual({verdict:"pass",frame:null,comparison:null,vph:null,snapshot:null});
  // Legacy-строка публикации: массив ранов NULL — читатель обязан вывести его из скаляра.
  expect(db.query("SELECT acceptance_run_id one,acceptance_run_ids many FROM component_publishes WHERE component_id='yp-rollback'").get())
    .toEqual({one:"acc_rollback",many:null});
  // NULL-слой не находится lookup'ом по слоям: сравнение с NULL ложно, и reuse честно не случается.
  expect(db.query("SELECT COUNT(*) n FROM acceptance_case_results WHERE component_id='yp-rollback' AND frame_fingerprint=?").get("fp_case"))
    .toEqual({n:0});
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});

/**
 * v32 (план 2026-08-07 §W1a): объявленные поверхности геометрии случая. Проверяется на
 * **populated** базе: строки, записанные до миграции, обязаны пережить её без изменений, а
 * `expected_surfaces_json` — появиться как NULL. Backfill'а нет **принципиально**: он записал бы в
 * БД нормализацию `expectedGeometry → {layoutUnion}`, то есть ровно ту производную, которую
 * инвариант волны запрещает персистить (иначе доволновой случай сменил бы `verdict_policy_hash`).
 */
test("v32 adds expected_surfaces_json to a populated v31 database without touching existing cases",()=>{
  const db=new Database(":memory:"); migrate(db);
  db.run("ALTER TABLE acceptance_cases DROP COLUMN expected_surfaces_json");
  db.run("PRAGMA user_version = 31");
  const at="2026-08-07T00:00:00.000Z";
  db.run("INSERT INTO components (id,name,head_rev,design_system,created_at,updated_at) VALUES ('yp-surf','YpSurf',1,'yandex-pay','now','now')");
  db.run("INSERT INTO component_revisions (component_id,rev,source,design_system,created_at) VALUES ('yp-surf',1,'src','yandex-pay','now')");
  db.query(`INSERT INTO component_candidates
    (candidate_id,component_id,design_system,rev,source_hash,bundle_hash,host_abi_version,theme_version,build_fingerprint,
     observed_catalog_revision,policy_profile_hash,status,created_by,created_at,expires_at)
    VALUES ('cand_surf','yp-surf','yandex-pay',1,'src-hash','bundle-hash',4,NULL,'bf','cat','ph','validated','u',?,?)`).run(at,at);
  db.query(`INSERT INTO acceptance_runs
    (run_id,candidate_id,component_id,status,policy_profile_hash,policy_profile_id,progress_json,gates_json,created_by,created_at)
    VALUES ('acc_surf','cand_surf','yp-surf','pass','ph','default-v1','{}','{}','u',?)`).run(at);
  db.query(`INSERT INTO acceptance_cases
    (run_id,case_id,case_key,props_hash,case_fingerprint,case_policy_hash,expected_geometry_json,status,verdict,gates_json,frame_fingerprint,started_at,finished_at)
    VALUES ('acc_surf','alpha','alpha','props-1','fp_alpha','ph_case',?,'done','pass','[]','frame_alpha',?,?)`)
    .run(JSON.stringify({width:480,height:88}),at,at);

  migrate(db);

  expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(32);
  // Легаси-случай: `expectedGeometry` на месте, поверхности — NULL («не объявлял»), не нормализация.
  expect(db.query("SELECT expected_geometry_json geo,expected_surfaces_json surfaces,verdict FROM acceptance_cases WHERE case_id='alpha'").get())
    .toEqual({geo:JSON.stringify({width:480,height:88}),surfaces:null,verdict:"pass"});
  // Колонка nullable и без DEFAULT: INSERT состава v31 продолжает проходить (откат образа).
  expect(()=>db.query(`INSERT INTO acceptance_cases
    (run_id,case_id,case_key,props_hash,case_fingerprint,case_policy_hash,status,gates_json,started_at,finished_at)
    VALUES ('acc_surf','beta','beta','props-2','fp_beta','ph_case','pending',NULL,NULL,NULL)`).run()).not.toThrow();
  expect(db.query("SELECT expected_surfaces_json surfaces FROM acceptance_cases WHERE case_id='beta'").get()).toEqual({surfaces:null});
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});
