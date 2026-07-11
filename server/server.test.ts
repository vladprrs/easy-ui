import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "./db";
import { createHandler } from "./main";
import { seedPrototypes } from "./seed";
import { prototypeDocSchema } from "../src/prototype/schema";

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
  test("lists serializable design system metadata and only allows GET", async () => {
    const db = openDatabase(":memory:");
    const base = start(createHandler(db));
    let response = await fetch(`${base}/api/design-systems`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const value = (await body(response)) as { designSystems: unknown[] };
    expect(value.designSystems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "shadcn",
          builtinCatalogHash: expect.any(String),
          components: expect.arrayContaining([
            expect.objectContaining({
              name: "Button",
              atomicLevel: "atom",
              layoutNeutral: false,
              events: expect.any(Array),
              slots: expect.any(Array),
            }),
          ]),
        }),
        expect.objectContaining({ id: "wireframe" }),
      ]),
    );
    expect(JSON.stringify(value)).not.toContain("_def");
    response = await fetch(`${base}/api/design-systems`, { method: "POST" });
    expect(response.status).toBe(405);
    db.close();
  });

  test("keeps list and meta design system aligned with the head draft through save and restore", async () => {
    const db = openDatabase(":memory:");
    const base = start(createHandler(db));
    const original = prototypeDocSchema.parse(await Bun.file(resolve("prototypes/hello-world.json")).json()),
      shadcn = { ...original, id: "systems", name: "Systems" },
      wireframe = {
        version: 1,
        id: "systems",
        name: "Systems",
        designSystem: "wireframe",
        device: "desktop",
        startScreen: "home",
        state: {},
        screens: [
          {
            id: "home",
            name: "Home",
            spec: {
              root: "root",
              elements: { root: { type: "Box", props: { label: "Content" } } },
            },
          },
        ],
      };
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
    await assertSystem("shadcn");
    response = await fetch(`${base}/api/prototypes/systems`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRev: 1, doc: wireframe }),
    });
    expect(response.status).toBe(200);
    await assertSystem("wireframe");
    response = await fetch(`${base}/api/prototypes/systems/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rev: 1, baseRev: 2 }),
    });
    expect(response.status).toBe(200);
    await assertSystem("shadcn");
    db.close();
  });

  test("does not resolve a wireframe custom component from a shadcn prototype", async () => {
    const dir = await mkdtemp(resolve(process.cwd(), ".easy-ui-components-"));
    dirs.push(dir);
    const db = openDatabase(":memory:");
    const base = start(createHandler(db, { dataDir: dir }));
    const source = (await Bun.file(resolve("server/fixtures/rating-stars.tsx")).text()).replaceAll("RatingStars", "WireRating");
    let response = await fetch(`${base}/api/components`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "wire-rating",
        name: "WireRating",
        source,
        designSystem: "wireframe",
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
      designSystem: "shadcn",
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
            message: "Unknown or unpublished component type in design system 'shadcn': WireRating",
          },
        ],
      },
    });
    db.close();
  });
  test("seeds a wireframe document from a temporary catalog", async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "easy-ui-seeds-"));
    dirs.push(dir);
    const doc = {
      version: 1,
      id: "wire-seed",
      name: "Wire seed",
      designSystem: "wireframe",
      device: "desktop",
      startScreen: "home",
      state: {},
      screens: [
        {
          id: "home",
          name: "Home",
          spec: {
            root: "root",
            elements: { root: { type: "Box", props: { label: "Seeded" } } },
          },
        },
      ],
    };
    await writeFile(resolve(dir, "wire.json"), JSON.stringify(doc));
    const db = openDatabase(":memory:");
    await seedPrototypes(db, dir);
    expect(db.query("SELECT design_system system FROM prototypes WHERE id='wire-seed'").get()).toEqual({ system: "wireframe" });
    db.close();
  });

  test("rejects component types outside the document design system", async () => {
    const db = openDatabase(":memory:");
    const base = start(createHandler(db));
    const doc = {
      version: 1,
      id: "bad-wire",
      name: "Bad wire",
      designSystem: "wireframe",
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
            message: "Unknown or unpublished component type in design system 'wireframe': Tabs",
          },
        ],
      },
    });
    db.close();
  });

  test("covers seed, validation, CAS, revisions, restore, publish and delete ledger", async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "easy-ui-server-"));
    dirs.push(dir);
    const dbFile = resolve(dir, "easy.db");
    const db = openDatabase(dbFile);
    await seedPrototypes(db, resolve("prototypes"));
    let base = start(createHandler(db));
    let response = await fetch(`${base}/api/health`);
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ status: "ready" });
    response = await fetch(`${base}/api/prototypes`);
    const seeded = await body(response);
    expect(seeded).toHaveLength(3);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const original = prototypeDocSchema.parse(await Bun.file(resolve("prototypes/hello-world.json")).json());
    response = await fetch(`${base}/api/prototypes/hello-world`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRev: 1, doc: { ...original, screens: [] } }),
    });
    expect(response.status).toBe(422);
    expect(((await body(response)) as { error: { issues: unknown[] } }).error.issues.length).toBeGreaterThan(0);
    response = await fetch(`${base}/api/prototypes/hello-world`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ doc: original }),
    });
    expect(response.status).toBe(400);
    response = await fetch(`${base}/api/prototypes/hello-world`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRev: 99, doc: original }),
    });
    expect(response.status).toBe(409);
    expect(((await body(response)) as { error: { currentRev: number } }).error.currentRev).toBe(1);
    const changed = {
      ...original,
      name: "Renamed",
      description: "Changed",
      device: "tablet",
    };
    response = await fetch(`${base}/api/prototypes/hello-world`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRev: 1, doc: changed, message: "edit" }),
    });
    expect(await body(response)).toMatchObject({
      rev: 2,
      warnings: expect.any(Array),
    });
    const list = (await body(await fetch(`${base}/api/prototypes`))) as {
      id: string;
    }[];
    expect(list.find((x) => x.id === "hello-world")).toMatchObject({
      name: "Renamed",
      description: "Changed",
      device: "tablet",
      screenCount: 2,
      headRev: 2,
    });
    response = await fetch(`${base}/api/prototypes/hello-world/revisions?limit=1`);
    expect(await body(response)).toEqual([{ rev: 2, message: "edit", createdAt: expect.any(String) }]);
    response = await fetch(`${base}/api/prototypes/hello-world/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rev: 1, baseRev: 2 }),
    });
    expect(await body(response)).toEqual({ rev: 3 });
    response = await fetch(`${base}/api/prototypes/hello-world/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRev: 3 }),
    });
    expect(response.status).toBe(201);
    expect(await body(response)).toEqual({ version: 1, rev: 3 });
    response = await fetch(`${base}/api/prototypes/hello-world/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRev: 3 }),
    });
    expect(response.status).toBe(409);
    expect(((await body(response)) as { error: { currentVersion: number } }).error.currentVersion).toBe(1);
    response = await fetch(`${base}/api/prototypes/hello-world/versions`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await body(response)).toHaveLength(1);
    response = await fetch(`${base}/api/prototypes/hello-world/versions/1`);
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(await body(response)).toMatchObject({
      version: 1,
      rev: 3,
      builtinCatalogHash: expect.any(String),
      componentManifestHash: expect.any(String),
      components: [],
    });
    response = await fetch(`${base}/api/prototypes/hello-world`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRev: 3 }),
    });
    expect(response.status).toBe(204);
    servers.pop()!.stop(true);
    db.close();
    const reopened = openDatabase(dbFile);
    await seedPrototypes(reopened, resolve("prototypes"));
    base = start(createHandler(reopened));
    const after = (await body(await fetch(`${base}/api/prototypes`))) as {
      id: string;
    }[];
    expect(after.map((x) => x.id)).not.toContain("hello-world");
    reopened.close();
  });

  test("enforces media type and body limit", async () => {
    const db = openDatabase(":memory:");
    const base = start(createHandler(db));
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

test("static serving is contained and fallback is HTML-only", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "easy-ui-dist-"));
  dirs.push(dir);
  await mkdir(resolve(dir, "assets"));
  await writeFile(resolve(dir, "index.html"), "<main>SPA</main>");
  await writeFile(resolve(dir, "assets/app.js"), "ok");
  const db = openDatabase(":memory:");
  const base = start(createHandler(db, { serveDist: dir }));
  let r = await fetch(`${base}/dashboard`, {
    headers: { accept: "text/html" },
  });
  expect(r.status).toBe(200);
  expect(await r.text()).toContain("SPA");
  r = await fetch(`${base}/dashboard`, {
    headers: { accept: "application/json" },
  });
  expect(r.status).toBe(404);
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
