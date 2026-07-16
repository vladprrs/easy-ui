/* eslint-disable @typescript-eslint/no-explicit-any */
import { createTestHandler } from "./test-auth";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { openDatabase } from "./db";
import { prototypeDocSchema, type PrototypeDoc } from "../src/prototype/schema";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir,{recursive:true,force:true}); });
async function setup() { const dir=await mkdtemp(resolve(process.cwd(),".prototype-diff-test-")); dirs.push(dir); const db=openDatabase(":memory:"); return {db,handler:createTestHandler(db,{dataDir:dir})}; }
const request = (path:string,method="GET",body?:unknown) => new Request(`http://test/api${path}`,{method,headers:body?{"content-type":"application/json"}:undefined,body:body?JSON.stringify(body):undefined});
async function fixture(id:string):Promise<PrototypeDoc> { const value=prototypeDocSchema.parse(await Bun.file("test/fixtures/host-content.json").json()); return {...value,id,name:"First"}; }

describe("prototype revision diff route", () => {
  test("diffs three revisions, defaults against to rev-1, and accepts explicit older revisions", async () => {
    const {db,handler}=await setup(); const first=await fixture("diff-three");
    expect((await handler(request("/prototypes","POST",{doc:first,message:"one"}))).status).toBe(201);
    const second={...first,name:"Second",state:{...first.state,count:1}};
    expect((await handler(request("/prototypes/diff-three","PUT",{baseRev:1,doc:second,message:"two"}))).status).toBe(200);
    const third={...second,description:"Third"};
    expect((await handler(request("/prototypes/diff-three","PUT",{baseRev:2,doc:third,message:"three"}))).status).toBe(200);
    const adjacent=await (await handler(request("/prototypes/diff-three/revisions/3/diff"))).json() as any;
    expect(adjacent.from.rev).toBe(2); expect(adjacent.to.rev).toBe(3);
    expect(adjacent.doc).toEqual([{key:"description",from:{missing:true},to:{value:"Third"}}]);
    const full=await (await handler(request("/prototypes/diff-three/revisions/3/diff?against=1"))).json() as any;
    expect(full.doc.map((x:any)=>x.key)).toEqual(["name","description"]);
    expect(full.state.added).toContainEqual({key:"count",value:{value:1}});
    db.close();
  });

  test("reports doc identity separately from changed design-system render metadata", async () => {
    const {db,handler}=await setup(); const value=await fixture("diff-render");
    await handler(request("/prototypes","POST",{doc:value})); await handler(request("/prototypes/diff-render","PUT",{baseRev:1,doc:value}));
    db.run("UPDATE prototype_revisions SET design_system_meta_version=7 WHERE prototype_id='diff-render' AND rev=2");
    const body=await (await handler(request("/prototypes/diff-render/revisions/2/diff"))).json() as any;
    expect(body.summary).toMatchObject({docIdentical:true,identical:false});
    expect(body.renderInputs[0].key).toBe("designSystemMetaVersion"); db.close();
  });

  test("returns the specified typed errors", async () => {
    const {db,handler}=await setup(); const value=await fixture("diff-errors"); await handler(request("/prototypes","POST",{doc:value}));
    for (const [path,status,code] of [
      ["/prototypes/missing/revisions/2/diff?against=1",404,"prototype_not_found"],
      ["/prototypes/diff-errors/revisions/2/diff?against=1",404,"revision_not_found"],
      ["/prototypes/diff-errors/revisions/1/diff?against=2",404,"revision_not_found"],
      ["/prototypes/diff-errors/revisions/1/diff",400,"invalid_request"],
      ["/prototypes/diff-errors/revisions/1/diff?against=1",400,"invalid_request"],
    ] as const) { const response=await handler(request(path)); expect(response.status).toBe(status); expect(await response.json()).toMatchObject({error:{code}}); }
    db.close();
  });

  test("bounds adversarial stored JSON and keeps __proto__/constructor changes visible", async () => {
    const {db,handler}=await setup(); const value=await fixture("diff-cap"); await handler(request("/prototypes","POST",{doc:value,message:"a"})); await handler(request("/prototypes/diff-cap","PUT",{baseRev:1,doc:value,message:"b"}));
    const make=(n:number) => { const copy=structuredClone(value) as any; const root=copy.screens[0].spec.elements[copy.screens[0].spec.root]; root.props=JSON.parse(`{"__proto__":${n},"constructor":${n},"${"ключ😀".repeat(20_000)}":${n}}`); root.type="Text"; return copy; };
    db.query("UPDATE prototype_revisions SET doc=?,message=? WHERE prototype_id='diff-cap' AND rev=?").run(JSON.stringify(make(1)),"😀".repeat(100_000),1);
    db.query("UPDATE prototype_revisions SET doc=?,message=? WHERE prototype_id='diff-cap' AND rev=?").run(JSON.stringify(make(2)),"\u0000".repeat(100_000),2);
    const response=await handler(request("/prototypes/diff-cap/revisions/2/diff")); const text=await response.text(); const body=JSON.parse(text);
    expect(Buffer.byteLength(text,"utf8")).toBeLessThanOrEqual(256*1024);
    const keys=body.screens.changed[0].elements.changed[0].props.changed.map((x:any)=>x.key);
    expect(keys).toContain("__proto__"); expect(keys).toContain("constructor"); expect(body.summary.truncated).toBe(true); db.close();
  });
});
