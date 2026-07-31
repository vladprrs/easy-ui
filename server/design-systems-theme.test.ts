import { createTestHandler } from "./test-auth";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { openDatabase } from "./db";
import { createHandler } from "./main";
import { UserRepo } from "./users";
import { PrototypeRepo } from "./repos/prototypes";
import { insertDesignSystemVersion } from "./designSystems";
import { prototypeDocSchema, type PrototypeDoc } from "../src/prototype/schema";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function setup() {
  const dir = await mkdtemp(resolve(process.cwd(), ".ds-theme-test-"));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  return { dir, db, handler: createTestHandler(db, { dataDir: dir }) };
}

type Bytes = Uint8Array<ArrayBuffer>;
function png(width = 4, height = 4): Bytes {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(b.buffer).setUint32(16, width, false);
  new DataView(b.buffer).setUint32(20, height, false);
  return b;
}
const woff2 = (): Bytes => { const b = new Uint8Array(16); b.set([0x77, 0x4f, 0x46, 0x32], 0); return b; };

const upload = (bytes: Bytes, mime: string) => new Request("http://test/api/assets", { method: "POST", headers: { "content-type": mime }, body: bytes });
const req = (url: string, method = "GET", value?: unknown) => new Request(`http://test/api${url}`, { method, headers: value ? { "content-type": "application/json" } : undefined, body: value ? JSON.stringify(value) : undefined });
const fullSpace = {
  "space.none": "0px", "space.xs": "4px", "space.sm": "8px", "space.md": "12px", "space.lg": "16px",
  "space.xl": "24px", "space.2xl": "32px", "space.3xl": "48px", "space.4xl": "64px",
};

async function uploadAsset(handler: (r: Request) => Promise<Response>, bytes: Bytes, mime: string): Promise<string> {
  return (await (await handler(upload(bytes, mime))).json() as { id: string }).id;
}
async function createCustomSystem(handler: (r: Request) => Promise<Response>, id: string): Promise<void> {
  const r = await handler(req("/design-systems", "POST", { id, name: "Custom", description: "A custom system" }));
  expect(r.status).toBe(201);
}

describe("PATCH /api/design-systems/:id — theme grammar", () => {
  test("publishes the latest resolved spacing scale in summary and capabilities and bumps compatibility hash", async () => {
    const { db, handler } = await setup();
    await createCustomSystem(handler, "scale-discovery");
    const before = await (await handler(req("/design-systems/scale-discovery"))).json() as { builtinCatalogHash: string };
    const tokens = { ...fullSpace, "space.md": "20px", "space.lg": "24px", "space.xl": "32px", "space.2xl": "40px", "space.3xl": "56px", "space.4xl": "72px" };
    expect((await handler(req("/design-systems/scale-discovery", "PATCH", { tokens, baseVersion: 0 }))).status).toBe(200);
    const summary = await (await handler(req("/design-systems/scale-discovery"))).json() as { builtinCatalogHash: string; resolvedSpaceScale: Record<string,string>; hostPrimitives: unknown[] };
    expect(summary.resolvedSpaceScale).toMatchObject({ md: "20px", "2xl": "40px", "4xl": "72px" });
    expect(summary.hostPrimitives).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Overlay" }), expect.objectContaining({ name: "Image" }), expect.objectContaining({ name: "Hotspot" }),
    ]));
    expect(summary.builtinCatalogHash).not.toBe(before.builtinCatalogHash);
    const capabilities = await (await handler(req("/capabilities"))).json() as { resolvedSpaceScales: Record<string,Record<string,string>> };
    expect(capabilities.resolvedSpaceScales["scale-discovery"]).toEqual(summary.resolvedSpaceScale);
    db.close();
  });

  test("creates version 1 for valid tokens/fonts/icons and reads it back immutably", async () => {
    const { db, handler } = await setup();
    await createCustomSystem(handler, "custom-a");
    const fontId = await uploadAsset(handler, woff2(), "font/woff2");
    const iconId = await uploadAsset(handler, png(), "image/png");
    const patch = {
      tokens: { "color.primary": "#123456", "spacing.lg": 24 },
      fonts: [{ family: "Inter", src: fontId, weight: 500, style: "normal" }],
      icons: [{ name: "close", assetId: iconId, viewBox: "0 0 24 24", themes: { dark: iconId } }],
      baseVersion: 0,
    };
    const r = await handler(req("/design-systems/custom-a", "PATCH", patch));
    expect(r.status).toBe(200);
    const body = await r.json() as { latestMetaVersion: number; tokens: Record<string, unknown>; fonts: unknown[]; icons: unknown[] };
    expect(body.latestMetaVersion).toBe(1);
    expect(body.tokens).toEqual({ "color.primary": "#123456", "spacing.lg": 24 });

    const v = await handler(req("/design-systems/custom-a/versions/1"));
    expect(v.status).toBe(200);
    const vbody = await v.json() as { systemId: string; version: number; tokens: Record<string, unknown> };
    expect(vbody).toMatchObject({ systemId: "custom-a", version: 1 });
    expect(vbody.tokens).toEqual({ "color.primary": "#123456", "spacing.lg": 24 });
    // GET summary exposes latestMetaVersion + latest content additively.
    const s = await handler(req("/design-systems/custom-a")); const sbody = await s.json() as { latestMetaVersion: number; fonts: unknown[] };
    expect(sbody.latestMetaVersion).toBe(1);
    expect(sbody.fonts).toHaveLength(1);
    db.close();
  });

  test("rejects an invalid token key/value with 422", async () => {
    const { db, handler } = await setup();
    await createCustomSystem(handler, "custom-b");
    const bad = await handler(req("/design-systems/custom-b", "PATCH", { tokens: { "Color.Primary": "x" }, baseVersion: 0 }));
    expect(bad.status).toBe(422);
    const badVal = await handler(req("/design-systems/custom-b", "PATCH", { tokens: { "color.a": "x{y}" }, baseVersion: 0 }));
    expect(badVal.status).toBe(422);
    db.close();
  });

  test("accepts allowlisted color.* values and rejects garbage color values", async () => {
    const { db, handler } = await setup();
    await createCustomSystem(handler, "color-validation");
    // Positive: 3-digit hex + rgba() with commas and a leading-dot alpha.
    const ok = await handler(req("/design-systems/color-validation", "PATCH", {
      tokens: { "color.surface": "#fff", "color.overlay": "rgba(255,255,255,.98)", "color.brand": "linear-gradient(90deg, #fff, #000)", "color.ref": "var(--eui-color-surface, #fff)" },
      baseVersion: 0,
    }));
    expect(ok.status).toBe(200);
    // Negative: a value that clears the base grammar (no ;{}<>) but is not a color.
    const bad = await handler(req("/design-systems/color-validation", "PATCH", { tokens: { "color.surface": "url(evil)" }, baseVersion: 1 }));
    expect(bad.status).toBe(422);
    const badMix = await handler(req("/design-systems/color-validation", "PATCH", { tokens: { "color.surface": "12px solid" }, baseVersion: 1 }));
    expect(badMix.status).toBe(422);
    db.close();
  });

  test("accepts shadow.* and gradient.* namespaced color tokens without regressing plain colors", async () => {
    const { db, handler } = await setup();
    await createCustomSystem(handler, "shadow-gradient");
    let version = 0;
    const patch = (tokens: Record<string, unknown>) => handler(req("/design-systems/shadow-gradient", "PATCH", { tokens, baseVersion: version }));
    const accept = async (label: string, tokens: Record<string, unknown>) => {
      const r = await patch(tokens);
      expect(r.status, `accept ${label}`).toBe(200);
      version += 1;
    };
    const reject = async (label: string, tokens: Record<string, unknown>) => {
      const r = await patch(tokens);
      expect(r.status, `reject ${label}`).toBe(422);
    };

    // No regression for plain color.* keys.
    await accept("plain colors", { "color.text-inverted": "#fff", "color.overlay": "rgba(255,255,255,.98)" });
    // Shadows: canonical medium, footer up-shadow, hex-alpha, comma-list, inset.
    await accept("shadow medium", { "color.shadow-medium": "0 8px 24px rgba(0,0,0,.12)" });
    await accept("shadow medium-up", { "color.shadow-medium-up": "0 -8px 24px rgba(0,0,0,.12)" });
    await accept("shadow low-handle", { "color.shadow-low-handle": "0 1px 3px #0003" });
    await accept("shadow comma-list", { "color.shadow-layered": "0 8px 24px rgba(0,0,0,.12), 0 2px 8px rgba(0,0,0,.08)" });
    await accept("shadow inset", { "color.shadow-inset": "inset 0 1px 2px rgba(0,0,0,.08)" });
    // Gradients: radial (new) + multi-stop linear with percents.
    await accept("gradient radial", { "color.gradient-glow": "radial-gradient(circle at 50% 0%, #ff2e93 0%, transparent 70%)" });
    await accept("gradient plus", { "color.gradient-plus": "linear-gradient(135deg,#ff2e93 0%,#8b3dff 52%,#3277ff 100%)" });

    // Rejections.
    await reject("shadow without color", { "color.shadow-medium": "0 8px 24px" });
    await reject("shadow: red garbage", { "color.shadow-medium": "shadow: red" });
    await reject("shadow url()", { "color.shadow-medium": "url(evil.png)" });
    await reject("gradient url()", { "color.gradient-plus": "url(evil.png)" });
    await reject("value with semicolon", { "color.shadow-medium": "0 8px 24px rgba(0,0,0,.12);" });
    // Format-valid comma-list that exceeds the 256-char value cap.
    await reject("value over 256 chars", { "color.shadow-medium": Array(11).fill("0 8px 24px rgba(0,0,0,.12)").join(", ") });
    db.close();
  });

  test("validates complete absolute-px, zero-origin, monotonic spacing scales", async () => {
    const { db, handler } = await setup();
    await createCustomSystem(handler, "space-validation");
    expect((await handler(req("/design-systems/space-validation", "PATCH", { tokens: fullSpace, baseVersion: 0 }))).status).toBe(200);
    for (const [index, tokens] of [
      { "space.md": "12px" },
      { ...fullSpace, "space.none": "1px" },
      { ...fullSpace, "space.md": "1rem" },
      { ...fullSpace, "space.md": "20px" },
    ].entries()) {
      const response = await handler(req("/design-systems/space-validation", "PATCH", { tokens, baseVersion: 1 }));
      expect(response.status, `invalid scale ${index}`).toBe(422);
    }
    db.close();
  });

  test("grandfathers malformed spacing unless PATCH explicitly touches space.*", async () => {
    const { db, handler } = await setup();
    await createCustomSystem(handler, "legacy-space");
    insertDesignSystemVersion(db, "legacy-space", 1, { tokens: { "space.md": "broken" }, fonts: [], icons: [] }, new Date().toISOString());

    let response = await handler(req("/design-systems/legacy-space", "PATCH", { fonts: [], baseVersion: 1 }));
    expect(response.status).toBe(200);
    expect((await response.json() as { tokens: unknown }).tokens).toEqual({ "space.md": "broken" });
    response = await handler(req("/design-systems/legacy-space", "PATCH", { icons: [], baseVersion: 2 }));
    expect(response.status).toBe(200);
    response = await handler(req("/design-systems/legacy-space", "PATCH", { tokens: { "color.brand": "red" }, baseVersion: 3 }));
    expect(response.status).toBe(200);
    response = await handler(req("/design-systems/legacy-space", "PATCH", { tokens: { "space.md": "20px" }, baseVersion: 4 }));
    expect(response.status).toBe(422);
    response = await handler(req("/design-systems/legacy-space", "PATCH", { tokens: { ...fullSpace, "space.md": "20px", "space.lg": "24px", "space.xl": "32px", "space.2xl": "40px", "space.3xl": "56px", "space.4xl": "72px" }, baseVersion: 4 }));
    expect(response.status).toBe(200);
    db.close();
  });

  test("rejects a font referencing a non-existent asset (422)", async () => {
    const { db, handler } = await setup();
    await createCustomSystem(handler, "custom-c");
    const r = await handler(req("/design-systems/custom-c", "PATCH", { fonts: [{ family: "X", src: `asset_${"a".repeat(64)}` }], baseVersion: 0 }));
    expect(r.status).toBe(422);
    db.close();
  });

  test("rejects a font pointing at a non-font asset (422)", async () => {
    const { db, handler } = await setup();
    await createCustomSystem(handler, "custom-d");
    const imageId = await uploadAsset(handler, png(), "image/png");
    const r = await handler(req("/design-systems/custom-d", "PATCH", { fonts: [{ family: "X", src: imageId }], baseVersion: 0 }));
    expect(r.status).toBe(422);
    expect((await r.json() as { error: { code: string } }).error.code).toBe("validation_failed");
    db.close();
  });

  test("rejects an icon pointing at a font asset (422)", async () => {
    const { db, handler } = await setup();
    await createCustomSystem(handler, "custom-e");
    const fontId = await uploadAsset(handler, woff2(), "font/woff2");
    const r = await handler(req("/design-systems/custom-e", "PATCH", { icons: [{ name: "x", assetId: fontId }], baseVersion: 0 }));
    expect(r.status).toBe(422);
    db.close();
  });
});

describe("PATCH CAS + immutability + builtin guard", () => {
  test("baseVersion mismatch → 409 version_conflict", async () => {
    const { db, handler } = await setup();
    await createCustomSystem(handler, "cas-a");
    expect((await handler(req("/design-systems/cas-a", "PATCH", { tokens: { "a.b": "1" }, baseVersion: 0 }))).status).toBe(200);
    const conflict = await handler(req("/design-systems/cas-a", "PATCH", { tokens: { "a.b": "2" }, baseVersion: 0 }));
    expect(conflict.status).toBe(409);
    const cbody = await conflict.json() as { error: { code: string; currentVersion: number } };
    expect(cbody.error.code).toBe("version_conflict");
    expect(cbody.error.currentVersion).toBe(1);
    db.close();
  });

  test("consecutive PATCHes create immutable versions; earlier version unchanged", async () => {
    const { db, handler } = await setup();
    await createCustomSystem(handler, "cas-b");
    expect((await handler(req("/design-systems/cas-b", "PATCH", { tokens: { "a.b": "1" }, baseVersion: 0 }))).status).toBe(200);
    // omitted tokens inherit; provide fonts=[] to keep, change tokens
    expect((await handler(req("/design-systems/cas-b", "PATCH", { tokens: { "a.b": "2" }, baseVersion: 1 }))).status).toBe(200);
    const v1 = await (await handler(req("/design-systems/cas-b/versions/1"))).json() as { tokens: Record<string, string> };
    const v2 = await (await handler(req("/design-systems/cas-b/versions/2"))).json() as { tokens: Record<string, string> };
    expect(v1.tokens).toEqual({ "a.b": "1" });
    expect(v2.tokens).toEqual({ "a.b": "2" });
    expect(db.query("SELECT COUNT(*) c FROM design_system_versions WHERE system_id='cas-b'").get()).toEqual({ c: 2 });
    db.close();
  });

  test("PATCH on a retired builtin system → 409", async () => {
    const { db, handler } = await setup();
    const r = await handler(req("/design-systems/shadcn", "PATCH", { tokens: { "a.b": "1" }, baseVersion: 0 }));
    expect(r.status).toBe(409);
    db.close();
  });

  test("GET missing version → 404", async () => {
    const { db, handler } = await setup();
    await createCustomSystem(handler, "cas-c");
    expect((await handler(req("/design-systems/cas-c/versions/7"))).status).toBe(404);
    db.close();
  });
});

describe("DELETE /api/design-systems/:id — мягкий ретайр", () => {
  const errorOf = async (response: Response) => (await response.json() as { error: { code: string; blockers?: Record<string, number> } }).error;

  test("retires an empty custom system: 204, gone from the list, still readable directly, repeat → 409", async () => {
    const { db, handler } = await setup();
    await createCustomSystem(handler, "retire-empty");
    await createCustomSystem(handler, "retire-keep");

    const retired = await handler(req("/design-systems/retire-empty", "DELETE"));
    expect(retired.status).toBe(204);
    expect(await retired.text()).toBe("");
    expect(db.query("SELECT retired FROM design_systems WHERE id='retire-empty'").get()).toEqual({ retired: 1 });
    expect(db.query("SELECT action FROM audit_events WHERE subject_id='retire-empty' ORDER BY at DESC LIMIT 1").get()).toEqual({ action: "design_system.retired" });

    const listed = await (await handler(req("/design-systems"))).json() as { designSystems: { id: string }[] };
    expect(listed.designSystems.map((system) => system.id)).toContain("retire-keep");
    expect(listed.designSystems.map((system) => system.id)).not.toContain("retire-empty");

    const direct = await handler(req("/design-systems/retire-empty"));
    expect(direct.status).toBe(200);
    expect(await direct.json() as { retired: boolean }).toMatchObject({ id: "retire-empty", retired: true });

    // Повтор — не 204: ретайрнутая система остаётся читаемой, поэтому 404 солгал бы,
    // а 409 повторяет отказ PATCH на той же ретайрнутой системе.
    const repeat = await handler(req("/design-systems/retire-empty", "DELETE"));
    expect(repeat.status).toBe(409);
    expect((await errorOf(repeat)).code).toBe("design_system_retired");
    db.close();
  });

  test("refuses a system that still owns a component or a prototype (409 with counts)", async () => {
    const { db, handler } = await setup();
    await createCustomSystem(handler, "retire-busy");
    const at = new Date().toISOString();
    db.query("INSERT INTO components (id,name,head_rev,design_system,deleted_at,created_at,updated_at,owner_id) VALUES ('busy-widget','BusyWidget',1,'retire-busy',NULL,?,?,'user_admin')").run(at, at);

    const blocked = await handler(req("/design-systems/retire-busy", "DELETE"));
    expect(blocked.status).toBe(409);
    const error = await errorOf(blocked);
    expect(error.code).toBe("design_system_in_use");
    expect(error.blockers).toEqual({ components: 1, prototypes: 0, compositions: 0, total: 1 });

    // Надгробие компонента освобождает систему; живой прототип — снова блокирует.
    db.query("UPDATE components SET deleted_at=? WHERE id='busy-widget'").run(at);
    new PrototypeRepo(db).create(customDoc("busy-proto", "retire-busy"));
    const stillBlocked = await handler(req("/design-systems/retire-busy", "DELETE"));
    expect(stillBlocked.status).toBe(409);
    expect((await errorOf(stillBlocked)).blockers).toEqual({ components: 0, prototypes: 1, compositions: 0, total: 1 });

    db.query("DELETE FROM prototype_revisions WHERE prototype_id='busy-proto'").run();
    db.query("DELETE FROM prototypes WHERE id='busy-proto'").run();
    expect((await handler(req("/design-systems/retire-busy", "DELETE"))).status).toBe(204);
    db.close();
  });

  test("only the owner or an admin may retire; builtin systems answer 405", async () => {
    const { dir, db, handler } = await setup();
    await createCustomSystem(handler, "retire-owned");
    const at = new Date().toISOString();
    db.query("INSERT INTO users (id,name,password_hash,is_admin,created_at) VALUES (?,?,?,?,?),(?,?,?,?,?)")
      .run("user_alice", "Alice", "unused", 0, at, "user_root", "Root", "unused", 1, at);
    const users = new UserRepo(db);
    const alice = users.createSession("user_alice").token;
    const root = users.createSession("user_root").token;
    const raw = createHandler(db, { dataDir: dir, publicOrigin: "http://test" });
    const as = (token: string, id: string) => raw(new Request(`http://test/api/design-systems/${id}`, { method: "DELETE", headers: { cookie: `easyui_session=${token}`, origin: "http://test" } }));

    const stranger = await as(alice, "retire-owned");
    expect(stranger.status).toBe(403);
    expect((await errorOf(stranger)).code).toBe("forbidden");
    expect(db.query("SELECT retired FROM design_systems WHERE id='retire-owned'").get()).toEqual({ retired: 0 });

    // Аноним отсекается ещё аутентификацией (401), до владельческой проверки.
    const anonymous = await raw(new Request("http://test/api/design-systems/retire-owned", { method: "DELETE", headers: { origin: "http://test" } }));
    expect(anonymous.status).toBe(401);

    // Встроенная система неретайрима так же, как неизменяема её тема.
    const builtin = await as(root, "shadcn");
    expect(builtin.status).toBe(405);
    expect((await errorOf(builtin)).code).toBe("method_not_allowed");

    // Админ, не будучи владельцем, ретайрит.
    expect((await as(root, "retire-owned")).status).toBe(204);
    expect((await as(root, "retire-missing")).status).toBe(404);
    db.close();
  });

  test("a retired system accepts no new component or prototype", async () => {
    const { db, handler } = await setup();
    await createCustomSystem(handler, "retire-closed");
    expect((await handler(req("/design-systems/retire-closed", "DELETE"))).status).toBe(204);

    const component = await handler(req("/components", "POST", {
      id: "closed-widget", name: "ClosedWidget", designSystem: "retire-closed",
      source: "export default function ClosedWidget() { return null; }",
      intent: "closed system rejection fixture for retirement coverage",
    }));
    expect(component.status).toBe(422);
    expect((await errorOf(component)).code).toBe("validation_failed");

    const prototype = await handler(req("/prototypes", "POST", { doc: customDoc("closed-proto", "retire-closed") }));
    expect(prototype.status).toBe(422);
    expect((await errorOf(prototype)).code).toBe("validation_failed");

    // Нижний рубеж — триггеры v15: даже прямая вставка в БД отвергается.
    const at = new Date().toISOString();
    expect(() => db.query("INSERT INTO components (id,name,head_rev,design_system,deleted_at,created_at,updated_at,owner_id) VALUES ('raw-widget','RawWidget',1,'retire-closed',NULL,?,?,'user_admin')").run(at, at))
      .toThrow(/retired design system reference/);
    db.close();
  });
});

// A minimal custom-system document (repo-level: HTTP validation of custom types is a route concern).
function customDoc(id: string, designSystem: string): PrototypeDoc {
  return prototypeDocSchema.parse({
    version: 1, id, name: id, device: "mobile", startScreen: "s", designSystem, state: {},
    screens: [{ id: "s", name: "S", spec: { root: "r", elements: { r: { type: "Widget", props: {} } } } }],
  });
}

describe("prototype pins the latest theme version", () => {
  test("save pins latest, read-back exposes designSystemMetaVersion, restore copies the pin", async () => {
    const { db, handler } = await setup();
    await createCustomSystem(handler, "pinsys");
    const repo = new PrototypeRepo(db);

    // No theme versions yet: pin is null.
    const doc = customDoc("pinproto", "pinsys");
    repo.create(doc);
    expect(repo.draft("pinproto").designSystemMetaVersion).toBe(null);

    // Bump the theme to v1, then save rev 2: the new revision pins 1.
    expect((await handler(req("/design-systems/pinsys", "PATCH", { tokens: { "a.b": "1" }, baseVersion: 0 }))).status).toBe(200);
    repo.save("pinproto", doc, 1);
    expect(repo.draft("pinproto").designSystemMetaVersion).toBe(1);
    expect(repo.revision("pinproto", 2).designSystemMetaVersion).toBe(1);

    // Bump theme to v2, then restore rev 1 (pin null) → rev 3 copies the source pin (null), not latest.
    expect((await handler(req("/design-systems/pinsys", "PATCH", { tokens: { "a.b": "2" }, baseVersion: 1 }))).status).toBe(200);
    repo.restore("pinproto", 1, 2);
    expect(repo.revision("pinproto", 3).designSystemMetaVersion).toBe(null);
    db.close();
  });
});
