import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { prototypeDocSchema } from "../src/prototype/schema";
import { openDatabase } from "./db";
import { createHandler, resolvePublicOrigin } from "./main";
import { createTestHandler } from "./test-auth";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const credentials = `Basic ${btoa("owner:secret")}`;

async function fixture() {
  const dist = await mkdtemp(resolve(tmpdir(), "easy-ui-share-dist-"));
  dirs.push(dist);
  await mkdir(resolve(dist, "assets"));
  await mkdir(resolve(dist, ".vite"));
  await writeFile(resolve(dist, "index.html"), "<main>share app</main>");
  await writeFile(resolve(dist, "favicon.svg"), "<svg/>");
  await writeFile(resolve(dist, "assets/app-A.js"), "export const build='A'");
  await writeFile(resolve(dist, ".vite/manifest.json"), JSON.stringify({ index: { file: "assets/app-A.js", isEntry: true } }));
  const db = openDatabase(":memory:");
  const options = {
    basicAuth: "owner:secret",
    serveDist: dist,
    publicOrigin: "http://127.0.0.1:4199",
  } as const;
  const handler = createHandler(db, options);
  const owner = createTestHandler(db, options);
  const doc = { ...prototypeDocSchema.parse(await Bun.file("test/fixtures/host-content.json").json()), id:"hello-world", name:"Hello world" };
  let response = await owner(new Request("http://local/api/prototypes", {
    method: "POST",
    headers: { authorization: credentials, "content-type": "application/json" },
    body: JSON.stringify({ doc }),
  }));
  expect(response.status).toBe(201);
  response = await owner(new Request("http://local/api/prototypes/hello-world/publish", {
    method: "POST",
    headers: { authorization: credentials, "content-type": "application/json" },
    body: JSON.stringify({ baseRev: 1 }),
  }));
  expect(response.status).toBe(201);
  return { db, dist, handler, owner };
}

async function createGrant(handler: ReturnType<typeof createHandler>) {
  const response = await handler(new Request("http://local/api/prototypes/hello-world/share", {
    method: "POST",
    headers: { authorization: credentials, "content-type": "application/json" },
    body: JSON.stringify({ version: 1, ttlSeconds: 3600 }),
  }));
  expect(response.status).toBe(201);
  return await response.json() as { id: string; url: string; version: number };
}

describe("scoped share", () => {
  test("exchanges a hashed bearer token before BasicAuth and restricts the cookie to the pinned closure", async () => {
    const { db, handler, owner } = await fixture();
    const grant = await createGrant(owner);
    expect(grant.url).toMatch(/^http:\/\/127\.0\.0\.1:4199\/share\/[A-Za-z0-9_-]{43}$/);
    const token = grant.url.split("/").at(-1)!;
    const stored = db.query("SELECT token_hash,dependencies_json FROM share_grants WHERE id=?").get(grant.id) as { token_hash: string; dependencies_json: string };
    expect(stored.token_hash).toHaveLength(64);
    expect(stored.token_hash).not.toContain(token);
    expect(stored.dependencies_json).not.toContain(token);

    let response = await handler(new Request(`http://local/share/${token}`));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://127.0.0.1:4199/share/p/hello-world/v/1/present/s/welcome");
    const setCookie = response.headers.get("set-cookie")!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toContain("Domain=");
    expect(setCookie).not.toContain("Secure");
    const cookie = setCookie.split(";", 1)[0]!;
    const rawSession = cookie.split("=", 2)[1]!;
    const sessionRow = db.query("SELECT session_hash FROM share_sessions").get() as { session_hash: string };
    expect(sessionRow.session_hash).toHaveLength(64);
    expect(sessionRow.session_hash).not.toBe(rawSession);

    const shared = (path: string, method = "GET") => handler(new Request(`http://local${path}`, { method, headers: { cookie } }));
    response = await shared("/share/p/hello-world/v/1/present/s/welcome");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("share app");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");

    expect((await shared("/api/prototypes/hello-world/versions/1")).status).toBe(200);
    expect((await shared("/favicon.svg")).status).toBe(200);
    expect((await shared("/api/prototypes")).status).toBe(401);
    expect((await shared("/api/prototypes/hello-world/versions/2")).status).toBe(401);
    expect((await shared("/p/hello-world/v/1/present/s/welcome")).status).toBe(401);
    expect((await shared("/api/prototypes/hello-world/versions/1", "POST")).status).toBe(401);

    // A valid share cookie that does not match this path must not shadow a valid user session.
    expect((await owner(new Request("http://local/api/prototypes", { headers: { cookie, authorization: credentials } }))).status).toBe(200);

    response = await owner(new Request(`http://local/api/prototypes/hello-world/share/${grant.id}`, {
      method: "DELETE",
      headers: { authorization: credentials },
    }));
    expect(response.status).toBe(204);
    expect(db.query("SELECT COUNT(*) count FROM share_sessions").get()).toEqual({ count: 0 });
    expect((await shared("/share/p/hello-world/v/1/present/s/welcome")).status).toBe(401);
    expect((await handler(new Request(`http://local/share/${token}`))).status).toBe(404);
    db.close();
  });

  test("resolves exact renderer static files from the current build for an already-issued cookie", async () => {
    const { db, dist, handler, owner } = await fixture();
    const grant = await createGrant(owner);
    const token = grant.url.split("/").at(-1)!;
    const exchange = await handler(new Request(`http://local/share/${token}`));
    const cookie = exchange.headers.get("set-cookie")!.split(";", 1)[0]!;
    const shared = (path: string) => handler(new Request(`http://local${path}`, { headers: { cookie } }));
    expect((await shared("/assets/app-A.js")).status).toBe(200);
    expect((await shared("/assets/not-in-build.js")).status).toBe(401);

    await rm(resolve(dist, "assets/app-A.js"));
    await writeFile(resolve(dist, "assets/app-B.js"), "export const build='B'");
    await writeFile(resolve(dist, ".vite/manifest.json"), JSON.stringify({ index: { file: "assets/app-B.js", isEntry: true } }));
    expect((await shared("/assets/app-B.js")).status).toBe(200);
    expect((await shared("/assets/app-A.js")).status).toBe(401);
    db.close();
  });

  test("forwards only one exact mobile override through the token exchange redirect", async () => {
    const { db, handler, owner } = await fixture();
    const grant = await createGrant(owner);
    const token = grant.url.split("/").at(-1)!;
    const location = "http://127.0.0.1:4199/share/p/hello-world/v/1/present/s/welcome";
    const cases = [
      ["?mobile=0", `${location}?mobile=0`],
      ["?mobile=1", `${location}?mobile=1`],
      ["?mobile=1&mobile=0", location],
      ["?mobile=yes", location],
      ["?mobile=%0A", location],
      ["?mobile=1&foo=bar", `${location}?mobile=1`],
      ["", location],
    ] as const;

    for (const [query, expectedLocation] of cases) {
      const response = await handler(new Request(`http://local/share/${token}${query}`));
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(expectedLocation);
    }
    db.close();
  });

  test("sets Secure only for HTTPS public origins", async () => {
    const { db, dist, owner } = await fixture();
    const handler = createHandler(db, { basicAuth: "owner:secret", serveDist: dist, publicOrigin: "https://share.example" });
    const grant = await createGrant(owner);
    const token = grant.url.split("/").at(-1)!;
    const response = await handler(new Request(`http://local/share/${token}`));
    expect(response.headers.get("set-cookie")).toContain("; Secure");
    expect(response.headers.get("location")).toMatch(/^https:\/\/share\.example\//);
    db.close();
  });
});

describe("PUBLIC_ORIGIN", () => {
  test("allows explicit loopback HTTP but requires HTTPS for public hosts", () => {
    expect(resolvePublicOrigin("http://127.0.0.1:4174", { host: "127.0.0.1", port: 4174 }).origin).toBe("http://127.0.0.1:4174");
    expect(resolvePublicOrigin("https://easy-ui.example", { host: "0.0.0.0", port: 8787 }).origin).toBe("https://easy-ui.example");
    expect(() => resolvePublicOrigin("http://easy-ui.example", { host: "0.0.0.0", port: 8787 })).toThrow("must use https");
    expect(() => resolvePublicOrigin(undefined, { host: "0.0.0.0", port: 8787 })).toThrow("PUBLIC_ORIGIN is required");
  });
});
