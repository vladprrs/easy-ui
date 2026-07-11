import { expect, test } from "bun:test";
import { openDatabase } from "../db";
import { builtinCatalogHash, builtinCatalogHashFor } from "../builtinHash";
import { prototypeDocSchema } from "../../src/prototype/schema";
import { PrototypeRepo } from "./prototypes";

const legacyDoc = {
  version: 1,
  id: "legacy",
  name: "Legacy",
  device: "desktop",
  startScreen: "home",
  state: {},
  screens: [{ id: "home", name: "Home", spec: { root: "root", elements: { root: { type: "Text", props: { text: "Legacy" } } } } }],
};

test("normalizes legacy stored docs in draft, revision, version, restore, and publish paths",()=>{
  const db=openDatabase(":memory:");
  db.query(`INSERT INTO prototypes (id,name,description,device,screen_count,head_rev,created_at,updated_at)
    VALUES (?,?,?,?,?,1,?,?)`).run("legacy","Legacy",null,"desktop",1,"now","now");
  db.query(`INSERT INTO prototype_revisions
    (prototype_id,rev,doc,builtin_catalog_hash,message,created_at) VALUES (?,?,?,?,?,?)`)
    .run("legacy",1,JSON.stringify(legacyDoc),builtinCatalogHash,null,"now");
  const repo=new PrototypeRepo(db);

  expect(repo.draft("legacy").doc.designSystem).toBe("shadcn");
  expect(repo.revision("legacy",1).doc.designSystem).toBe("shadcn");
  expect(repo.publish("legacy",1)).toEqual({version:1,rev:1});
  expect(repo.version("legacy",1).doc.designSystem).toBe("shadcn");
  expect(repo.restore("legacy",1,1)).toEqual({rev:2});
  expect(repo.draft("legacy").doc.designSystem).toBe("shadcn");
  db.close();
});

test("restore reinstates the source revision design system and catalog hash",()=>{
  const db=openDatabase(":memory:"); const repo=new PrototypeRepo(db);
  const shadcn=prototypeDocSchema.parse(legacyDoc);
  repo.create(shadcn); repo.save("legacy",{...shadcn,designSystem:"wireframe"},1);
  expect((db.query("SELECT design_system value FROM prototypes WHERE id='legacy'").get() as {value:string}).value).toBe("wireframe");
  expect(repo.restore("legacy",1,2)).toEqual({rev:3});
  expect(repo.draft("legacy")).toMatchObject({doc:{designSystem:"shadcn"},builtinCatalogHash:builtinCatalogHashFor("shadcn")});
  expect((db.query("SELECT design_system value FROM prototypes WHERE id='legacy'").get() as {value:string}).value).toBe("shadcn");
  db.close();
});

test("restore and publish reject pins from another design system",()=>{
  const db=openDatabase(":memory:"); const repo=new PrototypeRepo(db); const doc=prototypeDocSchema.parse(legacyDoc);
  db.query("INSERT INTO components (id,name,head_rev,design_system,created_at,updated_at) VALUES ('custom','Custom',1,'wireframe','now','now')").run();
  db.query("INSERT INTO component_revisions (component_id,rev,source,design_system,created_at) VALUES ('custom',1,'source','wireframe','now')").run();
  db.query(`INSERT INTO component_publishes (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,published_at)
    VALUES ('custom',1,1,'active','js','{}','source-hash','bundle-hash',1,'now')`).run();
  repo.create(doc,undefined,[{id:"custom",name:"Custom",version:1,bundleHash:"bundle-hash",sourcePath:"unused"}]);
  try { repo.publish("legacy",1); throw new Error("publish unexpectedly succeeded"); } catch(error) { expect(error).toMatchObject({status:422,code:"validation_failed"}); }
  repo.save("legacy",doc,1);
  try { repo.restore("legacy",1,2); throw new Error("restore unexpectedly succeeded"); } catch(error) { expect(error).toMatchObject({status:422,code:"validation_failed"}); }
  db.close();
});

test("round-trips a prototype in a registered system without a provider",()=>{
  const db=openDatabase(":memory:"); const repo=new PrototypeRepo(db);
  const doc=prototypeDocSchema.parse({...legacyDoc,id:"yp",name:"YP",designSystem:"yandex-pay",screens:[{...legacyDoc.screens[0],spec:{root:"root",elements:{root:{type:"YpCustom",props:{}}}}}]});
  db.query("INSERT INTO components (id,name,head_rev,design_system,created_at,updated_at) VALUES ('yp-custom','YpCustom',1,'yandex-pay','now','now')").run();
  db.query("INSERT INTO component_revisions (component_id,rev,source,design_system,created_at) VALUES ('yp-custom',1,'source','yandex-pay','now')").run();
  db.query(`INSERT INTO component_publishes (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,published_at)
    VALUES ('yp-custom',1,1,'active','js','{}','source-hash','bundle-hash',1,'now')`).run();
  const pins=[{id:"yp-custom",name:"YpCustom",version:1,bundleHash:"bundle-hash",sourcePath:"unused"}];
  expect(repo.create(doc,undefined,pins)).toEqual({id:"yp",rev:1});
  expect(repo.draft("yp").doc.designSystem).toBe("yandex-pay");
  expect(repo.revision("yp",1).doc.designSystem).toBe("yandex-pay");
  repo.publish("yp",1);
  expect(repo.version("yp",1).doc.designSystem).toBe("yandex-pay");
  expect(repo.restore("yp",1,1)).toEqual({rev:2});
  expect(repo.meta("yp").designSystem).toBe("yandex-pay");
  db.close();
});

test("restore and publish use the pinned publish revision system after a component move",()=>{
  const db=openDatabase(":memory:"); const repo=new PrototypeRepo(db); const doc=prototypeDocSchema.parse(legacyDoc);
  db.query("INSERT INTO components (id,name,head_rev,design_system,created_at,updated_at) VALUES ('custom','Custom',2,'yandex-pay','now','now')").run();
  db.query("INSERT INTO component_revisions (component_id,rev,source,design_system,created_at) VALUES ('custom',1,'old','shadcn','now'),('custom',2,'new','yandex-pay','now')").run();
  db.query(`INSERT INTO component_publishes (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,published_at)
    VALUES ('custom',1,1,'active','js','{}','source-hash','bundle-hash',1,'now')`).run();
  repo.create(doc,undefined,[{id:"custom",name:"Custom",version:1,bundleHash:"bundle-hash",sourcePath:"unused"}]);
  expect(repo.publish("legacy",1)).toEqual({version:1,rev:1});
  expect(repo.restore("legacy",1,1)).toEqual({rev:2});
  expect(repo.draft("legacy").components).toMatchObject([{id:"custom",version:1}]);
  db.close();
});

test("unknown design systems fail atomically with the designSystem path",()=>{
  const db=openDatabase(":memory:"); const repo=new PrototypeRepo(db);
  const doc=prototypeDocSchema.parse({...legacyDoc,designSystem:"missing"});
  try { repo.create(doc); throw new Error("create unexpectedly succeeded"); }
  catch(error) { expect(error).toMatchObject({status:422,details:{issues:[{path:["designSystem"]}]}}); }
  expect((db.query("SELECT COUNT(*) count FROM prototypes").get() as {count:number}).count).toBe(0);
  expect((db.query("SELECT COUNT(*) count FROM prototype_revisions").get() as {count:number}).count).toBe(0);
  db.close();
});

test("damaged historical revisions return a controlled error with prototype context",()=>{
  const db=openDatabase(":memory:"); const repo=new PrototypeRepo(db); const doc=prototypeDocSchema.parse(legacyDoc);
  repo.create(doc); repo.publish("legacy",1);
  db.query("UPDATE prototype_revisions SET doc='not json' WHERE prototype_id='legacy' AND rev=1").run();
  for(const read of [()=>repo.draft("legacy"),()=>repo.revision("legacy",1),()=>repo.version("legacy",1),()=>repo.restore("legacy",1,1),()=>repo.publish("legacy",1)]) {
    try { read(); throw new Error("read unexpectedly succeeded"); }
    catch(error) { expect(error).toMatchObject({status:422,code:"invalid_stored_revision",message:"Stored prototype revision is invalid: legacy rev 1"}); }
  }
  db.close();
});
