import { expect, test } from "bun:test";
import { openDatabase } from "../db";
import { builtinCatalogHash } from "../builtinHash";
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
