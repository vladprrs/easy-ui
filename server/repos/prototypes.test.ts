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
  db.query("INSERT INTO component_revisions (component_id,rev,source,created_at) VALUES ('custom',1,'source','now')").run();
  db.query(`INSERT INTO component_publishes (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,published_at)
    VALUES ('custom',1,1,'active','js','{}','source-hash','bundle-hash',1,'now')`).run();
  repo.create(doc,undefined,[{id:"custom",name:"Custom",version:1,bundleHash:"bundle-hash",sourcePath:"unused"}]);
  try { repo.publish("legacy",1); throw new Error("publish unexpectedly succeeded"); } catch(error) { expect(error).toMatchObject({status:422,code:"validation_failed"}); }
  repo.save("legacy",doc,1);
  try { repo.restore("legacy",1,2); throw new Error("restore unexpectedly succeeded"); } catch(error) { expect(error).toMatchObject({status:422,code:"validation_failed"}); }
  db.close();
});
