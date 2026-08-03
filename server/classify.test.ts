import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { classifyRevision, migrationV15Report } from "./classify";
import { migrate, RETIRED_DESIGN_SYSTEM_TRIGGER_NAMES } from "./migrations";
import { PrototypeRepo } from "./repos/prototypes";

const image=(props:Record<string,unknown>)=>({version:1,id:"placeholder",name:"Fixture",designSystem:"shadcn",device:"desktop",startScreen:"home",state:{src:"/state.png"},screens:[{id:"home",name:"Home",spec:{root:"root",elements:{root:{type:"Image",props}}}}]});
const typed=(id:string,type:string,props:Record<string,unknown>={})=>{const doc=image(props);doc.id=id;doc.screens[0]!.spec.elements.root!.type=type;return doc;};

function v14():Database {
  const db=new Database(":memory:");migrate(db);
  for(const name of RETIRED_DESIGN_SYSTEM_TRIGGER_NAMES) db.run(`DROP TRIGGER ${name}`);
  db.run("ALTER TABLE design_systems DROP COLUMN retired");
  // v16 lifecycle-колонки тоже надо снять (и v22 track), иначе повторный migrate() упрётся в duplicate column.
  for(const column of ["kind","tags","derived_from","track"] as const) db.run(`ALTER TABLE prototypes DROP COLUMN ${column}`);
  // То же для v17 tombstone-колонок на components.
  for(const column of ["delete_reason","replacement_component_id"] as const) db.run(`ALTER TABLE components DROP COLUMN ${column}`);
  // v18 завёл новые таблицы композиций — их надо снести, иначе повторный migrate() упрётся в "table already exists".
  for(const table of ["prototype_revision_compositions","composition_publishes","composition_revisions","compositions"] as const) db.run(`DROP TABLE IF EXISTS ${table}`);
  // v19 завела таблицу сценариев — тот же приём, иначе повторный migrate() упрётся в "table already exists".
  db.run("DROP TABLE IF EXISTS prototype_scenarios");
  // v20 завела аудит переиспользования и кэш отпечатков — снимаем и их (append-only триггеры
  // умирают вместе со своей таблицей).
  for(const table of ["catalog_reuse_decisions","component_fingerprints"] as const) db.run(`DROP TABLE IF EXISTS ${table}`);
  // v21 added composition closure metadata and migration control-plane tables. This fixture
  // deliberately rewinds the schema to v14, so remove those additive objects as well.
  for(const table of ["maintenance_locks","atomic_policy","catalog_migration_staging","catalog_migration_runs","catalog_replacements"] as const) db.run(`DROP TABLE IF EXISTS ${table}`);
  // v23 добавила колонку резолвера spacing-шкалы на версии тем — снимаем по той же причине.
  db.run("ALTER TABLE design_system_versions DROP COLUMN spacing_resolver");
  // v24 завела таблицу пинов темы (мульти-поверхностные документы) — тот же приём.
  db.run("DROP TABLE IF EXISTS prototype_revision_theme_pins");
  // v25 завела durable-слой acceptance и колонки-свидетельства — снимаем таблицы и колонки,
  // иначе повторный migrate() упрётся в "table already exists"/duplicate column.
  for(const table of ["acceptance_case_results","acceptance_cases","acceptance_runs","component_candidates"] as const) db.run(`DROP TABLE IF EXISTS ${table}`);
  for(const column of ["candidate_id","acceptance_run_id"] as const) db.run(`ALTER TABLE component_publishes DROP COLUMN ${column}`);
  db.run("ALTER TABLE design_systems DROP COLUMN acceptance");
  db.run("PRAGMA user_version=14");
  return db;
}

function revision(db:Database,id:string,rev:number,doc:unknown,head=rev):void {
  if(!db.query("SELECT 1 ok FROM prototypes WHERE id=?").get(id)) db.query("INSERT INTO prototypes (id,name,device,screen_count,head_rev,design_system,instance_id,created_at,updated_at,status) VALUES (?,?,'desktop',1,?,'shadcn',?,'now','now','published')").run(id,id,head,`${id}-instance`);
  db.query("INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,created_at) VALUES (?,?,?,'h','now')").run(id,rev,JSON.stringify(doc));
  db.query("UPDATE prototypes SET head_rev=? WHERE id=?").run(head,id);
}

function customPin(db:Database,prototypeId:string,rev:number,name="CustomCard"):void {
  const id=`component-${prototypeId}`;
  db.query("INSERT INTO components (id,name,head_rev,design_system,created_at,updated_at) VALUES (?,?,1,'yandex-pay','now','now')").run(id,name);
  db.query("INSERT INTO component_revisions (component_id,rev,source,design_system,created_at) VALUES (?,1,'source','yandex-pay','now')").run(id);
  db.query("INSERT INTO component_publishes (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,published_at) VALUES (?,1,1,'active','js','{}','source','bundle',1,'now')").run(id);
  db.query("INSERT INTO prototype_revision_components (prototype_id,rev,component_id,component_version) VALUES (?,?,?,1)").run(prototypeId,rev,id);
}

test("classifyRevision is directive-aware and rejects builtin/wireframe Image props",()=>{
  const db=v14();
  const cases=[
    ["asset",{$asset:`asset_${"a".repeat(64)}`}],
    ["state",{$state:"/src"}],
    ["cond",{$cond:{if:true,then:"/yes.png",else:"/no.png"}}],
  ] as const;
  for(const [id,src] of cases) { revision(db,id,1,image({src,alt:"Image"})); expect(classifyRevision(db,id,1)).toMatchObject({renderable:true,error:null}); }
  revision(db,"host",1,image({src:"/host.png",alt:"Host"}));
  revision(db,"shadcn-image",1,image({alt:"Legacy without src",width:320,height:180}));
  revision(db,"wireframe-image",1,image({alt:"Legacy",label:"IMAGE"}));
  expect(classifyRevision(db,"host",1).renderable).toBeTrue();
  expect(classifyRevision(db,"shadcn-image",1).renderable).toBeFalse();
  expect(classifyRevision(db,"wireframe-image",1).renderable).toBeFalse();
  db.close();
});

test("v15 classifies heads and each pinned grant revision independently",()=>{
  const db=v14();
  revision(db,"head-live",1,typed("head-live","Button"),2);
  revision(db,"head-live",2,typed("head-live","Image",{src:"/ok.png",alt:"ok"}),2);
  db.run("INSERT INTO prototype_publishes (prototype_id,version,rev,published_at) VALUES ('head-live',1,1,'now'),('head-live',2,2,'now')");
  db.run("INSERT INTO share_grants (id,token_hash,prototype_id,version,rev,dependencies_json,created_at,expires_at) VALUES ('grant-old','old','head-live',1,1,'{}','now','later')");
  db.run("INSERT INTO share_sessions (id,session_hash,grant_id,created_at,expires_at) VALUES ('session-old','session','grant-old','now','later')");

  revision(db,"head-dead",1,typed("head-dead","CustomCard"),2);customPin(db,"head-dead",1);
  revision(db,"head-dead",2,typed("head-dead","Button"),2);
  db.run("INSERT INTO prototype_publishes (prototype_id,version,rev,published_at) VALUES ('head-dead',1,1,'now'),('head-dead',2,2,'now')");
  db.run("INSERT INTO share_grants (id,token_hash,prototype_id,version,rev,dependencies_json,created_at,expires_at) VALUES ('grant-custom','custom','head-dead',1,1,'{}','now','later')");

  expect(migrationV15Report(db)).toMatchObject({databaseVersion:14,prototypesToArchive:["head-dead"],shareGrantsToRevoke:["grant-old"],counts:{prototypesToArchive:1,shareGrantsToRevoke:1}});
  migrate(db);
  expect(db.query("SELECT status FROM prototypes WHERE id='head-live'").get()).toEqual({status:"published"});
  expect(db.query("SELECT status FROM prototypes WHERE id='head-dead'").get()).toEqual({status:"archived"});
  expect(db.query("SELECT revoked_at FROM share_grants WHERE id='grant-old'").get()).toEqual({revoked_at:expect.any(String)});
  expect(db.query("SELECT COUNT(*) count FROM share_sessions WHERE grant_id='grant-old'").get()).toEqual({count:0});
  expect(db.query("SELECT revoked_at FROM share_grants WHERE id='grant-custom'").get()).toEqual({revoked_at:null});
  const repo=new PrototypeRepo(db);
  expect(()=>repo.setStatus("head-dead","private")).toThrow(expect.objectContaining({status:409,code:"prototype_not_renderable"}));
  repo.setStatus("head-live","archived");
  expect(repo.setStatus("head-live","private")).toEqual({status:"private"});
  db.close();
});

test("v15 triggers reject new references to retired systems and allow active systems",()=>{
  const db=new Database(":memory:");migrate(db);
  expect(()=>db.run("INSERT INTO components (id,name,head_rev,design_system,created_at,updated_at) VALUES ('bad','Bad',1,'shadcn','now','now')")).toThrow("retired design system reference");
  expect(()=>db.run("INSERT INTO prototypes (id,name,device,screen_count,head_rev,design_system,instance_id,created_at,updated_at,status) VALUES ('bad','Bad','desktop',1,1,'wireframe','instance','now','now','private')")).toThrow("retired design system reference");
  db.run("INSERT INTO prototypes (id,name,device,screen_count,head_rev,design_system,instance_id,created_at,updated_at,status) VALUES ('ok','Ok','desktop',1,1,'yandex-pay','instance','now','now','private')");
  expect(()=>db.query("INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,created_at) VALUES ('ok',1,?,'h','now')").run(JSON.stringify(typed("ok","Button")))).toThrow("retired design system reference");
  db.close();
});

// --- Композиционные пины (волна 5) ------------------------------------------
// Пин композиции трактуется как компонентный: отсутствие пина или пин на
// нерендеримую публикацию делают ревизию нерендеримой.

const composed=(id:string,compositionId="ctyp-shell")=>({
  version:1,id,name:"Composed",designSystem:"yandex-pay",device:"mobile",startScreen:"home",state:{},
  screens:[{id:"home",name:"Home",spec:{root:"root",elements:{root:{type:"@eui/Composition",props:{composition:compositionId}}}}}],
});

function composedRevision(db:Database,id:string,doc:unknown):void {
  db.query("INSERT INTO prototypes (id,name,device,screen_count,head_rev,design_system,instance_id,created_at,updated_at,status) VALUES (?,?,'mobile',1,1,'yandex-pay',?,'now','now','published')").run(id,id,`${id}-instance`);
  db.query("INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,created_at) VALUES (?,1,?,'h','now')").run(id,JSON.stringify(doc));
}

function compositionPin(db:Database,prototypeId:string,rev:number,status:string,compositionId="ctyp-shell"):void {
  if(!db.query("SELECT 1 ok FROM compositions WHERE id=?").get(compositionId)) {
    db.query("INSERT INTO compositions (id,name,head_rev,design_system,created_at,updated_at) VALUES (?,?,1,'yandex-pay','now','now')").run(compositionId,`Composition ${compositionId}`);
    db.query("INSERT INTO composition_revisions (composition_id,rev,doc,design_system,created_at) VALUES (?,1,'{}','yandex-pay','now')").run(compositionId);
    db.query("INSERT INTO composition_publishes (composition_id,version,rev,status,source_hash,published_at) VALUES (?,1,1,?,'hash','now')").run(compositionId,status);
  }
  db.query("INSERT INTO prototype_revision_compositions (prototype_id,rev,composition_id,composition_version) VALUES (?,?,?,1)").run(prototypeId,rev,compositionId);
}

test("classifyRevision honours composition pins exactly like component pins",()=>{
  const db=new Database(":memory:");migrate(db);

  composedRevision(db,"comp-active",composed("comp-active"));compositionPin(db,"comp-active",1,"active");
  expect(classifyRevision(db,"comp-active",1)).toMatchObject({renderable:true,error:null});

  // Пина нет вовсе — ревизия нерендерима (документ сохранён в обход save-пути).
  composedRevision(db,"comp-unpinned",composed("comp-unpinned","missing-shell"));
  const unpinned=classifyRevision(db,"comp-unpinned",1);
  expect(unpinned.renderable).toBeFalse();
  expect(unpinned.error?.issues[0]).toMatchObject({path:"/screens/0/spec/elements/root/props/composition",message:expect.stringContaining("is not pinned")});

  // deprecated/superseded рендерятся (как у компонентов), archived — нет.
  composedRevision(db,"comp-deprecated",composed("comp-deprecated","deprecated-shell"));compositionPin(db,"comp-deprecated",1,"deprecated","deprecated-shell");
  expect(classifyRevision(db,"comp-deprecated",1).renderable).toBeTrue();
  composedRevision(db,"comp-archived",composed("comp-archived","archived-shell"));compositionPin(db,"comp-archived",1,"archived","archived-shell");
  const archived=classifyRevision(db,"comp-archived",1);
  expect(archived.renderable).toBeFalse();
  expect(archived.error?.issues[0]!.message).toContain("status archived");
  db.close();
});
