import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "./db";
import { createHandler } from "./main";
import { ensureBootstrapAdmin, UserRepo } from "./users";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const request = (path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  if (init.method && !["GET", "HEAD", "OPTIONS"].includes(init.method) && !headers.has("origin")) headers.set("origin", "http://localhost");
  return new Request(`http://localhost${path}`, { ...init, headers });
};

async function setup() {
  const db = openDatabase(":memory:");
  await ensureBootstrapAdmin(db, { name: "Admin", password: "correct horse battery staple" });
  return { db, handler: createHandler(db) };
}

async function login(handler: ReturnType<typeof createHandler>, name = "Admin", password = "correct horse battery staple", next?: string) {
  return handler(request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, password, next }) }));
}

describe("cookie authentication", () => {
  test("login, me, and logout use a hashed HttpOnly session and JSON 401", async () => {
    const { db, handler } = await setup();
    const anonymous = await handler(request("/api/auth/me"));
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toBeNull();

    const response = await login(handler, "admin", "correct horse battery staple", "/users?tab=all");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: { userId: "user_admin", name: "Admin", isAdmin: true }, next: "/users?tab=all" });
    const setCookie = response.headers.get("set-cookie")!;
    expect(setCookie).toContain("easyui_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    const cookie = setCookie.split(";", 1)[0]!;
    const raw = cookie.split("=", 2)[1]!;
    const stored = db.query("SELECT session_hash FROM user_sessions").get() as { session_hash: string };
    expect(stored.session_hash).toHaveLength(64);
    expect(stored.session_hash).not.toBe(raw);

    const me = await handler(request("/api/auth/me", { headers: { cookie } }));
    expect(me.status).toBe(200);
    expect(me.headers.get("vary")).toContain("Cookie");
    expect(me.headers.get("cache-control")).toBe("private, no-store");
    expect(await me.json()).toEqual({ userId: "user_admin", name: "Admin", isAdmin: true });

    const logout = await handler(request("/api/auth/logout", { method: "POST", headers: { cookie } }));
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(db.query("SELECT COUNT(*) count FROM user_sessions").get()).toEqual({ count: 0 });
    expect((await handler(request("/api/auth/me", { headers: { cookie } }))).status).toBe(401);
    db.close();
  });

  test("rejects invalid credentials uniformly, validates next, and rate-limits attempts", async () => {
    const { db, handler } = await setup();
    for (const name of ["missing", "Admin"]) {
      const response = await login(handler, name, "wrong password");
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBeNull();
      expect(await response.json()).toMatchObject({ error: { code: "invalid_credentials" } });
    }
    expect((await login(handler, "Admin", "correct horse battery staple", "https://evil.example/")).status).toBe(422);
    for (let index = 0; index < 5; index++) expect((await login(handler, "limited", "wrong password")).status).toBe(401);
    expect((await login(handler, "limited", "wrong password")).status).toBe(429);
    db.close();
  });

  test("checks Origin on every unsafe content type and ignores invalid capture bearer when a session is valid", async () => {
    const { db, handler } = await setup();
    const auth = await login(handler);
    const cookie = auth.headers.get("set-cookie")!.split(";", 1)[0]!;
    for (const contentType of ["application/json", "multipart/form-data; boundary=x"]) {
      const response = await handler(new Request("http://localhost/api/auth/logout", { method: "POST", headers: { cookie, "content-type": contentType } }));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "origin_required" } });
    }
    const me = await handler(request("/api/auth/me", { headers: { cookie, "x-easyui-capture": "invalid" } }));
    expect(me.status).toBe(200);
    db.close();
  });

  test("uses a Secure __Host- cookie for an HTTPS public origin", async () => {
    const db = openDatabase(":memory:");
    await ensureBootstrapAdmin(db, { name: "Admin", password: "correct horse battery staple" });
    const handler = createHandler(db, { publicOrigin: "https://easy-ui.example" });
    const response = await handler(new Request("https://easy-ui.example/api/auth/login", { method: "POST", headers: { origin: "https://easy-ui.example", "content-type": "application/json" }, body: JSON.stringify({ name: "Admin", password: "correct horse battery staple" }) }));
    expect(response.headers.get("set-cookie")).toMatch(/^__Host-easyui_session=.*; Secure$/);
    db.close();
  });
});

describe("anonymous and compatibility boundaries", () => {
  test("allows only health, login, share exchange, public build files, and SPA routes anonymously", async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "easy-ui-static-auth-")); dirs.push(dir);
    await mkdir(resolve(dir, "assets")); await mkdir(resolve(dir, "storybook"));
    await writeFile(resolve(dir, "index.html"), "<main>SPA</main>");
    await writeFile(resolve(dir, "assets/app-ABCDEF.js"), "ok");
    await writeFile(resolve(dir, "assets/plain.js"), "private");
    await writeFile(resolve(dir, "assets/ui.woff2"), "font");
    await writeFile(resolve(dir, "favicon.svg"), "<svg/>");
    await writeFile(resolve(dir, "storybook/index.html"), "storybook");
    const db = openDatabase(":memory:"); const handler = createHandler(db, { serveDist: dir });
    expect((await handler(request("/api/health"))).status).toBe(200);
    expect((await handler(request("/api/prototypes"))).status).toBe(401);
    expect((await handler(request("/assets/app-ABCDEF.js"))).status).toBe(200);
    expect((await handler(request("/assets/ui.woff2"))).status).toBe(200);
    expect((await handler(request("/favicon.svg"))).status).toBe(200);
    expect((await handler(request("/dashboard"))).status).toBe(200);
    expect((await handler(request("/assets/plain.js"))).status).toBe(401);
    expect((await handler(request("/storybook/index.html"))).status).toBe(401);
    expect((await handler(request("/share/p/revoked/v/1/present/s/home"))).status).toBe(404);
    db.close();
  });

  test("legacy Basic is only an outer barrier and health bypasses it", async () => {
    const { db } = await setup(); const handler = createHandler(db, { legacyBasicAuth: "edge:secret" });
    expect((await handler(request("/api/health"))).status).toBe(200);
    const denied = await handler(request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain("Basic");
    db.close();
  });

  test("session cap removes oldest sessions and expired sessions are cleaned up", async () => {
    const { db } = await setup(); const repo = new UserRepo(db);
    for (let index = 0; index < 12; index++) repo.createSession("user_admin");
    expect(db.query("SELECT COUNT(*) count FROM user_sessions").get()).toEqual({ count: 10 });
    db.query("UPDATE user_sessions SET expires_at='2000-01-01T00:00:00.000Z'").run();
    repo.createSession("user_admin");
    expect(db.query("SELECT COUNT(*) count FROM user_sessions").get()).toEqual({ count: 1 });
    db.close();
  });
});
