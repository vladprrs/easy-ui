import { createTestHandler } from "./test-auth";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "./db";
import { startServer } from "./main";
import { prototypeDocSchema } from "../src/prototype/schema";
import { Database } from "bun:sqlite";

const servers: Bun.Server<unknown>[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
function start(handler: (r: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}
async function body(response: Response): Promise<unknown> {
  return await response.json();
}

describe("prototype API", () => {
  test("supports the DB-backed Registry API and strict error semantics", async () => {
    const db = openDatabase(":memory:");
    const base = start(createTestHandler(db));
    let response = await fetch(`${base}/api/design-systems`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const value = (await body(response)) as { designSystems: unknown[] };
    expect(value.designSystems).toEqual([
      expect.objectContaining({ id: "yandex-pay", retired:false, components: [], hostPrimitives: expect.arrayContaining([expect.objectContaining({ name: "Overlay" }), expect.objectContaining({ name: "Image" }), expect.objectContaining({ name: "Hotspot" })]) }),
    ]);
    expect(await body(await fetch(`${base}/api/design-systems/shadcn`))).toMatchObject({id:"shadcn",retired:true,components:[]});
    expect(JSON.stringify(value)).not.toContain("_def");
    response = await fetch(`${base}/api/design-systems/yandex-pay`);
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({id:"yandex-pay",components:[]});
    expect((await fetch(`${base}/api/design-systems/missing`)).status).toBe(404);
    response = await fetch(`${base}/api/design-systems`, {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:"product-ui",name:"Product UI",description:"Product components"})});
    expect(response.status).toBe(201);
    expect(response.headers.get("location")).toBe("/api/design-systems/product-ui");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await body(response)).toMatchObject({id:"product-ui",components:[]});
    for(const id of ["product-ui","shadcn"]) {
      response=await fetch(`${base}/api/design-systems`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id,name:"Duplicate",description:"Duplicate system"})});
      expect(response.status).toBe(409); expect(await body(response)).toMatchObject({error:{code:"already_exists"}});
    }
    for(const [payload,status,path] of [["{",400,undefined],["[]",400,undefined],[JSON.stringify({id:"Bad Slug",name:"Name",description:"Description"}),422,"id"],[JSON.stringify({id:"valid",name:" Name ",description:"Description",extra:true}),422,"name"]] as const) {
      response=await fetch(`${base}/api/design-systems`,{method:"POST",headers:{"content-type":"application/json"},body:payload});
      expect(response.status).toBe(status);
      if(path) expect((await body(response)) as {error:{issues:{path:string[]}[]}}).toMatchObject({error:{code:"validation_failed",issues:expect.arrayContaining([expect.objectContaining({path:[path]})])}});
    }
    for(const method of ["PUT","PATCH","DELETE"]) expect((await fetch(`${base}/api/design-systems`,{method})).status).toBe(405);
    for(const method of ["PUT","DELETE"]) expect((await fetch(`${base}/api/design-systems/product-ui`,{method})).status).toBe(405);
    // PATCH on :id is the theme endpoint: custom systems accept it, retired systems reject.
    expect((await fetch(`${base}/api/design-systems/product-ui`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({tokens:{"color.a":"#111"},baseVersion:0})})).status).toBe(200);
    expect((await fetch(`${base}/api/design-systems/shadcn`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({baseVersion:0})})).status).toBe(409);
    db.close();
  });

  test("keeps API-created systems across a database restart",async()=>{
    const dir=await mkdtemp(resolve(tmpdir(),"easy-ui-registry-")); dirs.push(dir);
    const file=resolve(dir,"registry.db"); let db=openDatabase(file);
    let response=await createTestHandler(db)(new Request("http://local/api/design-systems",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:"persistent",name:"Persistent",description:"Survives restart"})}));
    expect(response.status).toBe(201); db.close(); db=openDatabase(file);
    response=await createTestHandler(db)(new Request("http://local/api/design-systems/persistent"));
    expect(response.status).toBe(200); expect(await body(response)).toMatchObject({id:"persistent",name:"Persistent"}); db.close();
  });

  test("failed startup audit does not recover staging publishes or run seeds",async()=>{
    const dir=await mkdtemp(resolve(tmpdir(),"easy-ui-audit-")); dirs.push(dir); const file=resolve(dir,"audit.db");
    const db=openDatabase(file);
    db.run("INSERT INTO components (id,name,head_rev,design_system,created_at,updated_at) VALUES ('bad','Bad',1,'yandex-pay','now','now')");
    db.run("INSERT INTO component_revisions (component_id,rev,source,design_system,created_at) VALUES ('bad',1,'source','yandex-pay','now')");
    db.run("INSERT INTO component_publishes (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,published_at) VALUES ('bad',1,1,'staging','js','{}','source','bundle',1,'now')");
    db.run("UPDATE components SET design_system='missing' WHERE id='bad'"); db.close();
    await expect(startServer({database:file,port:0})).rejects.toThrow("Dangling design system reference in components");
    const inspect=new Database(file,{strict:true});
    expect(inspect.query("SELECT status FROM component_publishes WHERE component_id='bad'").get()).toEqual({status:"staging"});
    expect(inspect.query("SELECT COUNT(*) count FROM seed_log").get()).toEqual({count:0}); inspect.close();
  });

  test("keeps list and meta design system aligned with the head draft through save and restore", async () => {
    const db = openDatabase(":memory:");
    db.run("INSERT INTO design_systems (id,name,description,builtin_provider,retired,created_at,updated_at) VALUES ('test-alt','Test alt','Test',NULL,0,'now','now')");
    const base = start(createTestHandler(db));
    const original = prototypeDocSchema.parse(await Bun.file(resolve("test/fixtures/host-content.json")).json()),
      shadcn = { ...original, id: "systems", name: "Systems" },
      wireframe = { ...original,id:"systems",name:"Systems",designSystem:"test-alt" };
    let response = await fetch(`${base}/api/prototypes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ doc: shadcn }),
    });
    expect(response.status).toBe(201);
    const assertSystem = async (expected: string) => {
      const list = (await body(await fetch(`${base}/api/prototypes`))) as {
        id: string;
        designSystem: string;
      }[];
      const meta = (await body(await fetch(`${base}/api/prototypes/systems`))) as { designSystem: string };
      const draft = (await body(await fetch(`${base}/api/prototypes/systems/draft`))) as { doc: { designSystem: string } };
      expect(list.find((x) => x.id === "systems")!.designSystem).toBe(expected);
      expect(meta.designSystem).toBe(expected);
      expect(draft.doc.designSystem).toBe(expected);
    };
    await assertSystem("yandex-pay");
    response = await fetch(`${base}/api/prototypes/systems`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRev: 1, doc: wireframe }),
    });
    expect(response.status).toBe(200);
    await assertSystem("test-alt");
    response = await fetch(`${base}/api/prototypes/systems/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rev: 1, baseRev: 2 }),
    });
    expect(response.status).toBe(200);
    await assertSystem("yandex-pay");
    db.close();
  });

  test("does not resolve a wireframe custom component from a shadcn prototype", async () => {
    const dir = await mkdtemp(resolve(process.cwd(), ".easy-ui-components-"));
    dirs.push(dir);
    const db = openDatabase(":memory:");
    db.run("INSERT INTO design_systems (id,name,description,builtin_provider,retired,created_at,updated_at) VALUES ('test-alt','Test alt','Test',NULL,0,'now','now')");
    const base = start(createTestHandler(db, { dataDir: dir }));
    const source = (await Bun.file(resolve("server/fixtures/rating-stars.tsx")).text()).replaceAll("RatingStars", "WireRating");
    let response = await fetch(`${base}/api/components`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "wire-rating",
        name: "WireRating",
        source,
        designSystem: "test-alt",
      }),
    });
    expect(response.status).toBe(201);
    response = await fetch(`${base}/api/components/wire-rating/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRev: 1 }),
    });
    expect(response.status).toBe(201);
    const doc = {
      version: 1,
      id: "wrong-custom-system",
      name: "Wrong custom system",
      designSystem: "yandex-pay",
      device: "desktop",
      startScreen: "home",
      state: {},
      screens: [
        {
          id: "home",
          name: "Home",
          spec: {
            root: "root",
            elements: { root: { type: "WireRating", props: { value: 3 } } },
          },
        },
      ],
    };
    response = await fetch(`${base}/api/prototypes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ doc }),
    });
    expect(response.status).toBe(422);
    expect(await body(response)).toMatchObject({
      error: {
        issues: [
          {
            message: "Unknown or unpublished component type in design system 'yandex-pay': WireRating",
          },
        ],
      },
    });
    db.close();
  });
  test("rejects component types outside the document design system", async () => {
    const db = openDatabase(":memory:");
    const base = start(createTestHandler(db));
    const doc = {
      version: 1,
      id: "bad-wire",
      name: "Bad wire",
      designSystem: "yandex-pay",
      device: "desktop",
      startScreen: "home",
      state: {},
      screens: [
        {
          id: "home",
          name: "Home",
          spec: {
            root: "root",
            elements: { root: { type: "Tabs", props: {} } },
          },
        },
      ],
    };
    const response = await fetch(`${base}/api/prototypes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ doc }),
    });
    expect(response.status).toBe(422);
    expect(await body(response)).toMatchObject({
      error: {
        issues: [
          {
            message: "Unknown or unpublished component type in design system 'yandex-pay': Tabs",
          },
        ],
      },
    });
    db.close();
  });

  test("enforces media type and body limit", async () => {
    const db = openDatabase(":memory:");
    const base = start(createTestHandler(db));
    let r = await fetch(`${base}/api/prototypes`, {
      method: "POST",
      body: "{}",
    });
    expect(r.status).toBe(415);
    r = await fetch(`${base}/api/prototypes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(1_048_576) }),
    });
    expect(r.status).toBe(413);
    db.close();
  });
});

test("static serving is contained and the SPA fallback ignores Accept", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "easy-ui-dist-"));
  dirs.push(dir);
  await mkdir(resolve(dir, "assets"));
  await writeFile(resolve(dir, "index.html"), "<main>SPA</main>");
  await writeFile(resolve(dir, "assets/app.js"), "ok");
  const db = openDatabase(":memory:");
  const base = start(createTestHandler(db, { serveDist: dir }));
  let r = await fetch(`${base}/dashboard`, {
    headers: { accept: "text/html" },
  });
  expect(r.status).toBe(200);
  expect(await r.text()).toContain("SPA");
  // Programmatic clients (no text/html Accept) still reach the SPA on extensionless routes.
  r = await fetch(`${base}/dashboard`, {
    headers: { accept: "application/json" },
  });
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toContain("text/html");
  r = await fetch(`${base}/p/hello-world/s/home`);
  expect(r.status).toBe(200);
  expect(await r.text()).toContain("SPA");
  // Extension paths and /api/* are never SPA-fallbacked.
  r = await fetch(`${base}/missing.js`, { headers: { accept: "text/html" } });
  expect(r.status).toBe(404);
  for (const path of ["/%2e%2e%2fsecret", "/%252e%252e%252fsecret", "/bad%5cpath", "/api/unknown"]) {
    r = await fetch(base + path, { headers: { accept: "text/html" } });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.headers.get("content-type")).toContain("application/json");
  }
  r = await fetch(`${base}/assets/app.js`, { method: "HEAD" });
  expect(r.status).toBe(200);
  expect(await r.text()).toBe("");
  db.close();
});
