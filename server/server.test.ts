import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "./db";
import { createHandler } from "./main";
import { seedPrototypes } from "./seed";
import { prototypeDocSchema } from "../src/prototype/schema";

const servers:Bun.Server<unknown>[]=[]; const dirs:string[]=[];
afterEach(async()=>{ for(const s of servers.splice(0)) s.stop(true); for(const d of dirs.splice(0)) await rm(d,{recursive:true,force:true}); });
function start(handler:(r:Request)=>Response|Promise<Response>) { const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:handler}); servers.push(server); return `http://127.0.0.1:${server.port}`; }
async function body(response:Response):Promise<unknown> { return await response.json(); }

describe("prototype API",()=>{
  test("covers seed, validation, CAS, revisions, restore, publish and delete ledger",async()=>{
    const dir=await mkdtemp(resolve(tmpdir(),"easy-ui-server-")); dirs.push(dir); const dbFile=resolve(dir,"easy.db");
    const db=openDatabase(dbFile); await seedPrototypes(db,resolve("prototypes"));
    let base=start(createHandler(db));
    let response=await fetch(`${base}/api/health`); expect(response.status).toBe(200); expect(await body(response)).toEqual({status:"ready"});
    response=await fetch(`${base}/api/prototypes`); const seeded=await body(response); expect(seeded).toHaveLength(3); expect(response.headers.get("cache-control")).toBe("no-store");
    const original=prototypeDocSchema.parse(await Bun.file(resolve("prototypes/hello-world.json")).json());
    response=await fetch(`${base}/api/prototypes/hello-world`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({baseRev:1,doc:{...original,screens:[]}})}); expect(response.status).toBe(422); expect(((await body(response)) as {error:{issues:unknown[]}}).error.issues.length).toBeGreaterThan(0);
    response=await fetch(`${base}/api/prototypes/hello-world`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({doc:original})}); expect(response.status).toBe(400);
    response=await fetch(`${base}/api/prototypes/hello-world`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({baseRev:99,doc:original})}); expect(response.status).toBe(409); expect(((await body(response)) as {error:{currentRev:number}}).error.currentRev).toBe(1);
    const changed={...original,name:"Renamed",description:"Changed",device:"tablet"};
    response=await fetch(`${base}/api/prototypes/hello-world`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({baseRev:1,doc:changed,message:"edit"})}); expect(await body(response)).toMatchObject({rev:2,warnings:expect.any(Array)});
    const list=await body(await fetch(`${base}/api/prototypes`)) as {id:string}[]; expect(list.find(x=>x.id==="hello-world")).toMatchObject({name:"Renamed",description:"Changed",device:"tablet",screenCount:2,headRev:2});
    response=await fetch(`${base}/api/prototypes/hello-world/revisions?limit=1`); expect(await body(response)).toEqual([{rev:2,message:"edit",createdAt:expect.any(String)}]);
    response=await fetch(`${base}/api/prototypes/hello-world/restore`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({rev:1,baseRev:2})}); expect(await body(response)).toEqual({rev:3});
    response=await fetch(`${base}/api/prototypes/hello-world/publish`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({baseRev:3})}); expect(response.status).toBe(201); expect(await body(response)).toEqual({version:1,rev:3});
    response=await fetch(`${base}/api/prototypes/hello-world/publish`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({baseRev:3})}); expect(response.status).toBe(409); expect(((await body(response)) as {error:{currentVersion:number}}).error.currentVersion).toBe(1);
    response=await fetch(`${base}/api/prototypes/hello-world/versions`); expect(response.headers.get("cache-control")).toBe("no-store"); expect(await body(response)).toHaveLength(1);
    response=await fetch(`${base}/api/prototypes/hello-world/versions/1`); expect(response.headers.get("cache-control")).toContain("immutable"); expect(await body(response)).toMatchObject({version:1,rev:3,builtinCatalogHash:expect.any(String),componentManifestHash:expect.any(String),components:[]});
    response=await fetch(`${base}/api/prototypes/hello-world`,{method:"DELETE",headers:{"content-type":"application/json"},body:JSON.stringify({baseRev:3})}); expect(response.status).toBe(204);
    servers.pop()!.stop(true); db.close();
    const reopened=openDatabase(dbFile); await seedPrototypes(reopened,resolve("prototypes")); base=start(createHandler(reopened)); const after=await body(await fetch(`${base}/api/prototypes`)) as {id:string}[]; expect(after.map(x=>x.id)).not.toContain("hello-world"); reopened.close();
  });

  test("enforces media type and body limit",async()=>{ const db=openDatabase(":memory:"); const base=start(createHandler(db)); let r=await fetch(`${base}/api/prototypes`,{method:"POST",body:"{}"}); expect(r.status).toBe(415); r=await fetch(`${base}/api/prototypes`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({padding:"x".repeat(1_048_576)})}); expect(r.status).toBe(413); db.close(); });
});

test("static serving is contained and fallback is HTML-only",async()=>{
  const dir=await mkdtemp(resolve(tmpdir(),"easy-ui-dist-")); dirs.push(dir); await mkdir(resolve(dir,"assets")); await writeFile(resolve(dir,"index.html"),"<main>SPA</main>"); await writeFile(resolve(dir,"assets/app.js"),"ok");
  const db=openDatabase(":memory:"); const base=start(createHandler(db,{serveDist:dir}));
  let r=await fetch(`${base}/dashboard`,{headers:{accept:"text/html"}}); expect(r.status).toBe(200); expect(await r.text()).toContain("SPA");
  r=await fetch(`${base}/dashboard`,{headers:{accept:"application/json"}}); expect(r.status).toBe(404);
  r=await fetch(`${base}/missing.js`,{headers:{accept:"text/html"}}); expect(r.status).toBe(404);
  for(const path of ["/%2e%2e%2fsecret","/%252e%252e%252fsecret","/bad%5cpath","/api/unknown"]) { r=await fetch(base+path,{headers:{accept:"text/html"}}); expect(r.status).toBeGreaterThanOrEqual(400); expect(r.headers.get("content-type")).toContain("application/json"); }
  r=await fetch(`${base}/assets/app.js`,{method:"HEAD"}); expect(r.status).toBe(200); expect(await r.text()).toBe(""); db.close();
});
