import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { openDatabase } from "./db";
import { createHandler } from "./main";
import { createTestHandler } from "./test-auth";
import { UserRepo } from "./users";
import { prototypeDocSchema } from "../src/prototype/schema";

const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});

async function fixture(){
  const dir=await mkdtemp(resolve(process.cwd(),".ownership-test-"));dirs.push(dir);
  const db=openDatabase(":memory:");createTestHandler(db,{dataDir:dir});
  const at=new Date().toISOString();
  db.query("INSERT INTO users (id,name,password_hash,is_admin,created_at) VALUES (?,?,?,?,?),(?,?,?,?,?)")
    .run("user_alice","Alice","unused",0,at,"user_bob","Bob","unused",0,at);
  const users=new UserRepo(db),alice=users.createSession("user_alice").token,bob=users.createSession("user_bob").token;
  const handler=createHandler(db,{dataDir:dir,publicOrigin:"http://test"});
  const call=(who:"alice"|"bob",method:string,path:string,body?:unknown)=>handler(new Request(`http://test/api${path}`,{method,headers:{cookie:`easyui_session=${who==="alice"?alice:bob}`,...(body===undefined?{}:{"content-type":"application/json",origin:"http://test"})},body:body===undefined?undefined:JSON.stringify(body)}));
  const base=prototypeDocSchema.parse(await Bun.file("prototypes/hello-world.json").json());
  const doc={...base,id:"owned-proto",name:"Owned proto"};
  const created=await call("alice","POST","/prototypes",{doc,figma:{fileKey:"file_1",nodeIds:["1:2"]}});expect(created.status).toBe(201);
  return {db,handler,call,doc};
}

describe("prototype principal/status matrix",()=>{
  test("projects DTOs, separates visibility from version publish, and preserves archived shares",async()=>{
    const {db,handler,call}=await fixture();
    const published=await call("alice","POST","/prototypes/owned-proto/publish",{baseRev:1});expect(published.status).toBe(201);
    expect((db.query("SELECT status FROM prototypes WHERE id='owned-proto'").get() as {status:string}).status).toBe("private");
    expect((await call("bob","GET","/prototypes/owned-proto")).status).toBe(404);
    expect((await call("bob","GET","/prototypes/owned-proto/versions/1")).status).toBe(404);
    expect((await (await call("alice","GET","/prototypes")).json() as unknown[]).length).toBe(1);
    expect((await (await call("bob","GET","/prototypes")).json() as unknown[]).length).toBe(0);

    expect((await call("alice","POST","/prototypes/owned-proto/status",{status:"published"})).status).toBe(200);
    for(const path of ["/prototypes/owned-proto","/prototypes/owned-proto/draft","/prototypes/owned-proto/versions/1"]){
      const response=await call("bob","GET",path);expect(response.status).toBe(200);expect(Object.hasOwn(await response.json() as object,"figma")).toBe(false);
    }
    expect((await call("bob","GET","/prototypes/owned-proto/revisions")).status).toBe(403);
    const listed=await (await call("bob","GET","/prototypes")).json() as {status:string;owner:{id:string;name:string}}[];expect(listed).toEqual([expect.objectContaining({status:"published",owner:{id:"user_alice",name:"Alice"}})]);
    expect((await call("bob","PUT","/prototypes/owned-proto",{baseRev:1,doc:{}})).status).toBe(403);

    const share=await (await call("alice","POST","/prototypes/owned-proto/share",{version:1,ttlSeconds:3600})).json() as {url:string};
    expect((await call("alice","POST","/prototypes/owned-proto/status",{status:"archived"})).status).toBe(200);
    expect((await call("bob","GET","/prototypes/owned-proto")).status).toBe(404);
    expect((await call("alice","POST","/prototypes/owned-proto/status",{status:"published"})).status).toBe(422);
    expect(db.query("SELECT COUNT(*) count FROM prototype_publishes WHERE prototype_id='owned-proto'").get()).toEqual({count:1});
    expect(db.query("SELECT COUNT(*) count FROM share_grants WHERE prototype_id='owned-proto' AND revoked_at IS NULL").get()).toEqual({count:1});

    const exchanged=await handler(new Request(share.url));expect(exchanged.status).toBe(303);
    const cookie=exchanged.headers.get("set-cookie")!.split(";",1)[0]!;
    const scoped=await handler(new Request("http://test/api/prototypes/owned-proto/versions/1",{headers:{cookie}}));
    expect(scoped.status).toBe(200);expect(Object.hasOwn(await scoped.json() as object,"figma")).toBe(false);
    expect((await call("alice","POST","/prototypes/owned-proto/status",{status:"private"})).status).toBe(200);
    expect(db.query("SELECT actor_id FROM audit_events WHERE action='prototype.status.changed' ORDER BY at DESC LIMIT 1").get()).toEqual({actor_id:"user_alice"});
  });

  test("enforces component/design-system conjunction and protects pinned active bundles",async()=>{
    const {db,call}=await fixture();const at=new Date().toISOString();
    db.query("INSERT INTO design_systems (id,name,description,builtin_provider,created_at,updated_at,owner_id) VALUES ('alice-ds','Alice DS','x',NULL,?,?, 'user_alice'),('bob-ds','Bob DS','x',NULL,?,?, 'user_bob')").run(at,at,at,at);
    db.query("INSERT INTO components (id,name,head_rev,design_system,deleted_at,created_at,updated_at,owner_id) VALUES ('owned-component','OwnedComponent',1,'bob-ds',NULL,?,?, 'user_alice')").run(at,at);
    db.query("INSERT INTO component_revisions (component_id,rev,source,design_system,message,author,created_at) VALUES ('owned-component',1,'export default null','bob-ds',NULL,'user_alice',?)").run(at);
    db.query("INSERT INTO component_publishes (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,published_at) VALUES ('owned-component',1,1,'active','js','{}','source','bundle',1,?)").run(at);
    db.query("INSERT INTO prototype_revision_components (prototype_id,rev,component_id,component_version) VALUES ('owned-proto',1,'owned-component',1)").run();

    expect((await call("alice","POST","/components",{id:"blocked",name:"Blocked",source:"export default null",designSystem:"bob-ds"})).status).toBe(403);
    expect((await call("alice","POST","/components/owned-component/publish",{baseRev:1})).status).toBe(403);
    expect((await call("bob","POST","/components/owned-component/publish",{baseRev:1})).status).toBe(403);
    expect((await call("alice","PATCH","/design-systems/bob-ds",{baseVersion:0,tokens:{}})).status).toBe(403);

    expect((await call("alice","POST","/components/owned-component/versions/1/status",{status:"deprecated",baseStatusRev:1})).status).toBe(200);
    expect((await call("alice","POST","/components/owned-component/versions/1/status",{status:"active",baseStatusRev:2})).status).toBe(200);
    const dangerous=await call("alice","POST","/components/owned-component/versions/1/status",{status:"archived",baseStatusRev:3});
    expect(dangerous.status).toBe(403);expect((await dangerous.json() as {error:{code:string}}).error.code).toBe("admin_required");
    expect(db.query("SELECT actor_id FROM audit_events WHERE action='component.status.changed' ORDER BY at DESC LIMIT 1").get()).toEqual({actor_id:"user_alice"});
  });
});
