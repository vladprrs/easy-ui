import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { openDatabase } from "./db";
import { createHandler } from "./main";
import { createTestHandler } from "./test-auth";
import { UserRepo } from "./users";
import { capabilities } from "./routes/meta";
import { SURFACES_LIMIT } from "../src/prototype/schema";
import { builtinCatalogHashFor } from "./builtinHash";
import { getDesignSystemVersion, requireActiveDesignSystem } from "./designSystems";
import { resolveSpacingScale } from "../src/designSystems/spacingScale";

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
  const call = (method: string, path: string, body?: unknown, contentType = "application/json") => handler(new Request(`http://test/api${path}`, {
    method,
    headers: {
      cookie: `easyui_session=${token}`,
      ...(method === "GET" || method === "HEAD" ? {} : { origin: "http://test" }),
      ...(body === undefined ? {} : { "content-type": contentType }),
    },
    body: body === undefined ? undefined : (typeof body === "string" || body instanceof Uint8Array ? body as BodyInit : JSON.stringify(body)),
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

// --- W3: сервер multi-DS -----------------------------------------------------
// План docs/plans/2026-08-02-multi-surface-flows.md, §4 (инвентарь single-DS-предположений)
// и §5 W3: резолв компонентов/пинов/тем/share/capture по множеству ДС документа.

const WOFF2 = Uint8Array.from([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0, 1, 2, 3, 4]);
const ratingStars = await Bun.file("server/fixtures/rating-stars.tsx").text();

/** Дуо-док на двух ДС: primary — `primary`, вторая поверхность — `secondary`. */
const multiDsDoc = (id: string, primary: string, secondary: string, screens?: unknown[]) => ({
  ...duoDoc(id),
  designSystem: primary,
  surfaces: [
    { id: "kso", name: "КСО", device: "desktop", startScreen: "kso-idle" },
    { id: "app", name: "Приложение", device: "mobile", startScreen: "app-home", designSystem: secondary },
  ],
  ...(screens ? { screens } : {}),
});

async function multiDsFixture() {
  process.env.EASYUI_SURFACES = "1";
  const base = await fixture();
  const { call } = base;
  const upload = async (bytes: Uint8Array, mime: string) => {
    const response = await call("POST", "/assets", bytes, mime);
    expect(response.status).toBeLessThan(300);
    return (await response.json() as { id: string }).id;
  };
  for (const [id, name] of [["kso-ds", "KSO DS"], ["app-ds", "App DS"]] as const) {
    expect((await call("POST", "/design-systems", { id, name, description: `${name} fixture` })).status).toBe(201);
  }
  // У каждой ДС — своя версия темы со своим шрифтовым ассетом: share-грант и capture-allowlist
  // обязаны нести ресурсы обеих.
  const ksoFont = await upload(WOFF2, "font/woff2");
  const appFont = await upload(Uint8Array.from([...WOFF2, 9]), "font/woff2");
  expect((await call("PATCH", "/design-systems/kso-ds", { fonts: [{ family: "KSO Sans", src: ksoFont }], baseVersion: 0 })).status).toBe(200);
  expect((await call("PATCH", "/design-systems/app-ds", { fonts: [{ family: "App Sans", src: appFont }], baseVersion: 0 })).status).toBe(200);
  return { ...base, upload, ksoFont, appFont };
}

/** Публикует компонент `name` в системе `designSystem` и возвращает его id. */
async function publishComponentInto(call: (method: string, path: string, body?: unknown, contentType?: string) => Promise<Response>, id: string, name: string, designSystem: string, intent: string) {
  const created = await call("POST", "/components", { id, name, source: ratingStars, designSystem, intent });
  expect([created.status, await created.text()][0]).toBe(201);
  expect((await call("POST", `/components/${id}/publish`, { baseRev: 1 })).status).toBe(201);
  return id;
}

const componentScreen = (id: string, surface: string, type: string, canvas?: { width: number; height: number }) => ({
  id, name: id, surface, ...(canvas ? { canvas } : {}),
  spec: { root: "root", elements: { root: { type, props: { value: 3 } } } },
});

describe("multi-surface server: components, pins and theme pins (W3)", () => {
  test("saves a two-design-system document, pins components of both systems and writes a theme pin per system", async () => {
    const { call, db } = await multiDsFixture();
    await publishComponentInto(call, "kso-stars", "KsoStars", "kso-ds", "Rates the checkout kiosk experience on the terminal screen");
    await publishComponentInto(call, "app-stars", "AppStars", "app-ds", "Rates the completed purchase inside the buyer application");
    const doc = multiDsDoc("duo-ds", "kso-ds", "app-ds", [
      componentScreen("kso-idle", "kso", "KsoStars", { width: 1080, height: 1920 }),
      componentScreen("app-home", "app", "AppStars"),
    ]);
    const created = await call("POST", "/prototypes", { doc });
    expect([created.status, await created.clone().text()][0]).toBe(201);

    const pins = db.query("SELECT component_id FROM prototype_revision_components WHERE prototype_id='duo-ds' AND rev=1 ORDER BY component_id").all();
    expect(pins).toEqual([{ component_id: "app-stars" }, { component_id: "kso-stars" }]);
    const themePins = db.query("SELECT design_system, meta_version FROM prototype_revision_theme_pins WHERE prototype_id='duo-ds' AND rev=1 ORDER BY design_system").all();
    expect(themePins).toEqual([{ design_system: "app-ds", meta_version: 1 }, { design_system: "kso-ds", meta_version: 1 }]);

    const draft = await (await call("GET", "/prototypes/duo-ds/draft")).json() as { designSystemMetaVersion: number | null; designSystemMetaVersions: Record<string, number | null> };
    expect(draft.designSystemMetaVersions).toEqual({ "app-ds": 1, "kso-ds": 1 });
    // Колонка остаётся значением primary-ДС (совместимость).
    expect(draft.designSystemMetaVersion).toBe(1);
  });

  test("rejects a component type that belongs to the other surface's design system", async () => {
    const { call } = await multiDsFixture();
    await publishComponentInto(call, "kso-only", "KsoOnly", "kso-ds", "Displays the terminal-only payment status on the kiosk surface");
    const doc = multiDsDoc("duo-foreign", "kso-ds", "app-ds", [
      componentScreen("kso-idle", "kso", "KsoOnly", { width: 1080, height: 1920 }),
      componentScreen("app-home", "app", "KsoOnly"),
    ]);
    const response = await call("POST", "/prototypes", { doc });
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("app-ds");
  });

  test("reads a pre-migration revision without theme-pin rows as {primary: column}", async () => {
    const { call, db } = await multiDsFixture();
    expect((await call("POST", "/prototypes", { doc: { ...plainDoc("legacy"), designSystem: "kso-ds" } })).status).toBe(201);
    // Ревизия, записанная до миграции v24: строк пинов нет — бэкфила by design тоже нет.
    db.run("DELETE FROM prototype_revision_theme_pins WHERE prototype_id='legacy'");
    const draft = await (await call("GET", "/prototypes/legacy/draft")).json() as { designSystemMetaVersion: number | null; designSystemMetaVersions: Record<string, number | null> };
    expect(draft.designSystemMetaVersions).toEqual({ "kso-ds": draft.designSystemMetaVersion });
  });

  test("keeps the builtin catalog hash of a single-surface document byte-identical and derives a stable multi-system hash", async () => {
    const { call, db } = await multiDsFixture();
    expect((await call("POST", "/prototypes", { doc: { ...plainDoc("single"), designSystem: "kso-ds" } })).status).toBe(201);
    const single = (db.query("SELECT builtin_catalog_hash h FROM prototype_revisions WHERE prototype_id='single' AND rev=1").get() as { h: string }).h;
    const theme = getDesignSystemVersion(db, "kso-ds", 1)!;
    expect(single).toBe(builtinCatalogHashFor("kso-ds", requireActiveDesignSystem(db, "kso-ds", []).definitions, resolveSpacingScale("kso-ds", theme.tokens, theme.spacingResolver)));

    expect((await call("POST", "/prototypes", { doc: multiDsDoc("duo-hash", "kso-ds", "app-ds") })).status).toBe(201);
    const duo = (db.query("SELECT builtin_catalog_hash h FROM prototype_revisions WHERE prototype_id='duo-hash' AND rev=1").get() as { h: string }).h;
    expect(duo).not.toBe(single);
    // Детерминированность: повторное сохранение того же документа даёт тот же хэш.
    expect((await call("PUT", "/prototypes/duo-hash", { doc: multiDsDoc("duo-hash", "kso-ds", "app-ds"), baseRev: 1 })).status).toBe(200);
    expect((db.query("SELECT builtin_catalog_hash h FROM prototype_revisions WHERE prototype_id='duo-hash' AND rev=2").get() as { h: string }).h).toBe(duo);
  });

  test("restore copies the theme pins of the source revision", async () => {
    const { call, db, appFont } = await multiDsFixture();
    expect((await call("POST", "/prototypes", { doc: multiDsDoc("duo-restore", "kso-ds", "app-ds") })).status).toBe(201);
    // Новая версия темы второй ДС: свежая ревизия пиновала бы 2, restore обязан оставить 1.
    expect((await call("PATCH", "/design-systems/app-ds", { fonts: [{ family: "App Serif", src: appFont }], baseVersion: 1 })).status).toBe(200);
    expect((await call("PUT", "/prototypes/duo-restore", { doc: { ...multiDsDoc("duo-restore", "kso-ds", "app-ds"), name: "v2" }, baseRev: 1 })).status).toBe(200);
    expect((await call("POST", "/prototypes/duo-restore/restore", { rev: 1, baseRev: 2 })).status).toBe(200);
    const pins = db.query("SELECT design_system, meta_version FROM prototype_revision_theme_pins WHERE prototype_id='duo-restore' AND rev=3 ORDER BY design_system").all();
    expect(pins).toEqual([{ design_system: "app-ds", meta_version: 1 }, { design_system: "kso-ds", meta_version: 1 }]);
  });

  test("warns about the primary token/icon snapshot and about colliding font families (D9)", async () => {
    const { call, appFont } = await multiDsFixture();
    // Обе темы объявляют одно и то же семейство — победит primary (fontRegistry фильтрует по family).
    expect((await call("PATCH", "/design-systems/app-ds", { fonts: [{ family: "KSO Sans", src: appFont }], baseVersion: 1 })).status).toBe(200);
    const created = await call("POST", "/prototypes", { doc: multiDsDoc("duo-warn", "kso-ds", "app-ds") });
    expect(created.status).toBe(201);
    const warnings = (await created.json() as { warnings: { path: string; message: string }[] }).warnings.map((warning) => warning.message);
    expect(warnings.some((message) => message.includes("token() and Icon read the global snapshot"))).toBe(true);
    expect(warnings.some((message) => message.includes("font family 'kso sans'"))).toBe(true);
  });
});

describe("multi-surface server: design-system retire, export and compositions (W3)", () => {
  test("blocks retiring a design system referenced only by a surface", async () => {
    const { call } = await multiDsFixture();
    expect((await call("POST", "/prototypes", { doc: multiDsDoc("duo-retire", "kso-ds", "app-ds") })).status).toBe(201);
    const blocked = await call("DELETE", "/design-systems/app-ds");
    expect(blocked.status).toBe(409);
    const error = await blocked.json() as { error: { code: string; blockers: Record<string, number> } };
    expect(error.error.code).toBe("design_system_in_use");
    expect(error.error.blockers.prototypeSurfaces).toBe(1);
  });

  test("refuses to export a multi-surface prototype with a stable 422", async () => {
    const { call } = await multiDsFixture();
    expect((await call("POST", "/prototypes", { doc: multiDsDoc("duo-export", "kso-ds", "app-ds") })).status).toBe(201);
    const response = await call("GET", "/prototypes/duo-export/export");
    expect(response.status).toBe(422);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("surfaces_not_exportable");
  });

  test("refuses a composition placed on a foreign-design-system surface", async () => {
    const { call } = await multiDsFixture();
    const doc = multiDsDoc("duo-composition", "kso-ds", "app-ds", [
      { id: "kso-idle", name: "KSO", surface: "kso", canvas: { width: 1080, height: 1920 }, spec: image("KSO") },
      { id: "app-home", name: "App", surface: "app", spec: { root: "root", elements: { root: { type: "@eui/Composition", props: { composition: "some-composition" } } } } },
    ]);
    const response = await call("POST", "/prototypes", { doc });
    expect(response.status).toBe(422);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("composition_foreign_design_system");
  });
});

describe("multi-surface server: share grants carry both themes (W3)", () => {
  test("an anonymous share session may read the resources of the second design system", async () => {
    const { call, db, appFont, ksoFont } = await multiDsFixture();
    expect((await call("POST", "/prototypes", { doc: multiDsDoc("duo-share", "kso-ds", "app-ds") })).status).toBe(201);
    expect((await call("POST", "/prototypes/duo-share/publish", { baseRev: 1, force: true })).status).toBe(201);
    const grant = await call("POST", "/prototypes/duo-share/share", { version: 1, ttlSeconds: 3600 });
    expect([grant.status, await grant.clone().text()][0]).toBe(201);
    const dependencies = JSON.parse((db.query("SELECT dependencies_json j FROM share_grants ORDER BY created_at DESC LIMIT 1").get() as { j: string }).j) as { resources: string[] };
    expect(dependencies.resources).toContain("/api/design-systems/kso-ds/versions/1");
    expect(dependencies.resources).toContain("/api/design-systems/app-ds/versions/1");
    expect(dependencies.resources).toContain(`/api/assets/${appFont}`);
    expect(dependencies.resources).toContain(`/api/assets/${ksoFont}`);

    // Аноним по share-гранту действительно получает ресурс второй ДС.
    const url = (await grant.json() as { url: string }).url;
    const token = url.slice(url.lastIndexOf("/") + 1);
    const handler = createHandler(db, { dataDir: ".", publicOrigin: "http://test" });
    const exchange = await handler(new Request(`http://test/share/${token}`, { redirect: "manual" }));
    const cookie = exchange.headers.get("set-cookie")!.split(";")[0]!;
    const themeResponse = await handler(new Request("http://test/api/design-systems/app-ds/versions/1", { headers: { cookie } }));
    expect(themeResponse.status).toBe(200);
    expect((await themeResponse.json() as { fonts: { family: string }[] }).fonts[0]!.family).toBe("App Sans");
  });
});
