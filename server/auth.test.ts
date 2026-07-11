import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { openDatabase } from "./db";
import { createHandler } from "./main";

const dirs:string[]=[];
afterEach(async()=>{ for(const dir of dirs.splice(0)) await rm(dir,{recursive:true,force:true}); });

function request(path:string,authorization?:string,accept?:string):Request {
  const headers=new Headers();
  if(authorization!==undefined) headers.set("authorization",authorization);
  if(accept) headers.set("accept",accept);
  return new Request(`http://localhost${path}`,{headers});
}

describe("basic auth gate",()=>{
  test("leaves existing behavior unchanged when disabled",async()=>{
    const db=openDatabase(":memory:");
    const response=await createHandler(db)(request("/api/prototypes"));
    expect(response.status).toBe(200);
    expect(response.headers.get("vary")).toBeNull();
    db.close();
  });

  test("rejects missing, incorrect, malformed, and non-Basic credentials",async()=>{
    const db=openDatabase(":memory:"); const handler=createHandler(db,{basicAuth:"user:pass"});
    const credentials=[undefined,`Basic ${btoa("user:wrong")}`,"Basic !!!=","Basic dXNlcjpwYXNz=","Bearer dXNlcjpwYXNz"];
    for(const authorization of credentials) {
      const response=await handler(request("/api/prototypes",authorization));
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe('Basic realm="easy-ui"');
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("vary")).toBe("Authorization");
    }
    db.close();
  });

  test("accepts correct credentials case-insensitively and leaves GET health open",async()=>{
    const db=openDatabase(":memory:"); const handler=createHandler(db,{basicAuth:"user:pass"});
    let response=await handler(request("/api/prototypes",`bAsIc ${btoa("user:pass")}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("vary")).toBe("Authorization");
    response=await handler(request("/api/health"));
    expect(response.status).toBe(200);
    expect(response.headers.get("vary")).toBe("Authorization");
    expect(await response.json()).toEqual({status:"ready"});
    db.close();
  });

  test("protects static files and SPA fallback",async()=>{
    const dir=await mkdtemp(resolve(tmpdir(),"easy-ui-auth-")); dirs.push(dir);
    await mkdir(resolve(dir,"assets"));
    await writeFile(resolve(dir,"index.html"),"<main>SPA</main>");
    await writeFile(resolve(dir,"assets/app.js"),"ok");
    const db=openDatabase(":memory:"); const handler=createHandler(db,{serveDist:dir,basicAuth:"user:pass"});
    expect((await handler(request("/assets/app.js"))).status).toBe(401);
    expect((await handler(request("/dashboard",undefined,"text/html"))).status).toBe(401);
    db.close();
  });

  test("marks cacheable authenticated responses private and varies on Authorization",async()=>{
    const db=openDatabase(":memory:"); const handler=createHandler(db,{basicAuth:"user:pass"});
    const response=await handler(request("/api/shims/v1/react.js",`Basic ${btoa("user:pass")}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("cache-control")).not.toContain("public");
    expect(response.headers.get("vary")).toBe("Authorization");
    db.close();
  });
});
