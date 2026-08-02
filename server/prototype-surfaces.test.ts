import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { openDatabase } from "./db";
import { createHandler } from "./main";
import { createTestHandler } from "./test-auth";
import { UserRepo } from "./users";
import { capabilities } from "./routes/meta";
import { SURFACES_LIMIT } from "../src/prototype/schema";

// План docs/plans/2026-08-02-multi-surface-flows.md, W1: kill-switch D16 (EASYUI_SURFACES)
// и discovery D15. Полярность обратна EASYUI_PUBLISH_GATES: пусто = фича выключена.

const dirs: string[] = [];
const previousEnv = process.env.EASYUI_SURFACES;
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  if (previousEnv === undefined) delete process.env.EASYUI_SURFACES; else process.env.EASYUI_SURFACES = previousEnv;
});

const image = (alt: string) => ({ root: "image", elements: { image: { type: "Image", props: { src: "https://example.com/fixture.png", alt } } } });

const duoDoc = (id: string) => ({
  version: 1,
  id,
  name: id,
  designSystem: "yandex-pay",
  device: "desktop",
  startScreen: "kso-idle",
  state: {},
  surfaces: [
    { id: "kso", name: "КСО", device: "desktop", startScreen: "kso-idle" },
    { id: "app", name: "Приложение", device: "mobile", startScreen: "app-home" },
  ],
  screens: [
    { id: "kso-idle", name: "KSO", surface: "kso", canvas: { width: 1080, height: 1920 }, spec: image("KSO") },
    { id: "app-home", name: "App", surface: "app", spec: image("App") },
  ],
});

const plainDoc = (id: string) => ({
  version: 1, id, name: id, designSystem: "yandex-pay", device: "desktop", startScreen: "only", state: {},
  screens: [{ id: "only", name: "Only", spec: image("Only") }],
});

async function fixture() {
  const dir = await mkdtemp(resolve(process.cwd(), ".surfaces-test-")); dirs.push(dir);
  const db = openDatabase(":memory:"); createTestHandler(db, { dataDir: dir });
  db.query("INSERT INTO users (id,name,password_hash,is_admin,created_at) VALUES (?,?,?,?,?)")
    .run("user_alice", "Alice", "unused", 0, new Date().toISOString());
  const token = new UserRepo(db).createSession("user_alice").token;
  const handler = createHandler(db, { dataDir: dir, publicOrigin: "http://test" });
  const call = (method: string, path: string, body?: unknown) => handler(new Request(`http://test/api${path}`, {
    method,
    headers: { cookie: `easyui_session=${token}`, ...(body === undefined ? {} : { "content-type": "application/json", origin: "http://test" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  return { db, call };
}

describe("multi-surface kill-switch (D16)", () => {
  test("rejects a surfaces document with a stable 422 while disabled", async () => {
    delete process.env.EASYUI_SURFACES;
    const { call } = await fixture();
    const response = await call("POST", "/prototypes", { doc: duoDoc("duo") });
    expect(response.status).toBe(422);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("surfaces_disabled");
    // Строка в БД не появилась.
    expect((await call("GET", "/prototypes/duo")).status).toBe(404);
    // Документы без поверхностей не затронуты.
    expect((await call("POST", "/prototypes", { doc: plainDoc("plain") })).status).toBe(201);
  });

  test("accepts create and save with EASYUI_SURFACES=1", async () => {
    process.env.EASYUI_SURFACES = "1";
    const { call } = await fixture();
    const created = await call("POST", "/prototypes", { doc: duoDoc("duo") });
    expect(created.status).toBe(201);
    const saved = await call("PUT", "/prototypes/duo", { doc: { ...duoDoc("duo"), name: "Duo v2" }, baseRev: 1 });
    expect(saved.status).toBe(200);
    // Round-trip: поверхности и теги экранов дожили до чтения.
    const draft = await (await call("GET", "/prototypes/duo/draft")).json() as { doc: { surfaces: { id: string }[]; screens: { surface?: string }[] } };
    expect(draft.doc.surfaces.map((surface) => surface.id)).toEqual(["kso", "app"]);
    expect(draft.doc.screens.map((screen) => screen.surface)).toEqual(["kso", "app"]);
  });

  test("save of a surfaces document is rejected while disabled", async () => {
    process.env.EASYUI_SURFACES = "1";
    const { call } = await fixture();
    expect((await call("POST", "/prototypes", { doc: duoDoc("duo") })).status).toBe(201);
    delete process.env.EASYUI_SURFACES;
    const saved = await call("PUT", "/prototypes/duo", { doc: { ...duoDoc("duo"), name: "Duo v2" }, baseRev: 1 });
    expect([saved.status, (await saved.json() as { error: { code: string } }).error.code]).toEqual([422, "surfaces_disabled"]);
    // Чтение уже сохранённого документа не гейтится.
    expect((await call("GET", "/prototypes/duo/draft")).status).toBe(200);
  });
});

describe("multi-surface discovery (D15)", () => {
  test("publishes the limit from the enforcement site and reflects the kill-switch", async () => {
    const { db } = await fixture();
    delete process.env.EASYUI_SURFACES;
    const disabled = capabilities(db) as { limits: Record<string, number>; features: Record<string, boolean> };
    expect(disabled.limits.surfaces).toBe(SURFACES_LIMIT);
    expect(disabled.features.surfaces).toBe(true);
    expect(disabled.features.surfacesWrite).toBe(false);
    process.env.EASYUI_SURFACES = "1";
    expect((capabilities(db) as { features: Record<string, boolean> }).features.surfacesWrite).toBe(true);
  });

  test("the document JSON schema exposes surfaces and step companions", async () => {
    const { call } = await fixture();
    const schema = await (await call("GET", "/schemas/prototype-document.json")).json() as { properties: Record<string, unknown> };
    expect(schema.properties.surfaces).toBeDefined();
    expect(JSON.stringify(schema)).toContain("companions");
  });
});
