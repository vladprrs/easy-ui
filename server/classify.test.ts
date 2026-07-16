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
