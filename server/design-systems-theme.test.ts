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

    // Патчи, не меняющие контент, версию не создают (no-op detection, план P6.1), поэтому
    // baseVersion остаётся 1 — grandfathering малформленной шкалы от этого не зависит.
    let response = await handler(req("/design-systems/legacy-space", "PATCH", { fonts: [], baseVersion: 1 }));
    expect(response.status).toBe(200);
    expect((await response.json() as { tokens: unknown }).tokens).toEqual({ "space.md": "broken" });
    response = await handler(req("/design-systems/legacy-space", "PATCH", { icons: [], baseVersion: 1 }));
    expect(response.status).toBe(200);
    // Патч без `space.*` не наследует малформленную шкалу базовой версии (наследование включается
    // только для полного валидного набора) — исторический grandfathering сохраняется.
    response = await handler(req("/design-systems/legacy-space", "PATCH", { tokens: { "color.brand": "red" }, baseVersion: 1 }));
    expect(response.status).toBe(200);
    expect(await response.json() as { tokens: unknown; inheritedSpaceTokens: string[] }).toMatchObject({ tokens: { "color.brand": "red" }, inheritedSpaceTokens: [] });
    response = await handler(req("/design-systems/legacy-space", "PATCH", { tokens: { "space.md": "20px" }, baseVersion: 2 }));
    expect(response.status).toBe(422);
    response = await handler(req("/design-systems/legacy-space", "PATCH", { tokens: { ...fullSpace, "space.md": "20px", "space.lg": "24px", "space.xl": "32px", "space.2xl": "40px", "space.3xl": "56px", "space.4xl": "72px" }, baseVersion: 2 }));
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

// --- Волна W4 плана 2026-08-02 (P6): dry-run, no-op, sparse-операции, версионирование резолвера ---

type PatchBody = {
  latestMetaVersion: number | null; tokens: Record<string, unknown>; fonts: unknown[]; icons: unknown[];
  resolvedSpaceScale: Record<string, string>;
  dryRun: boolean; noop: boolean; nextVersion: number | null; spacingResolver: number;
  inheritedSpaceTokens: string[];
  diff: { tokens: { added: Record<string, unknown>; changed: Record<string, { from: unknown; to: unknown }>; removed: string[] }; fonts: { added: unknown[]; removed: unknown[] }; icons: { added: unknown[]; removed: unknown[] }; changed: boolean };
  stalePins: { total: number; limit: number; prototypes: { id: string; name: string; pinnedVersion: number | null }[] };
};
const versionCount = (db: import("bun:sqlite").Database, id: string) =>
  (db.query("SELECT COUNT(*) c FROM design_system_versions WHERE system_id=?").get(id) as { c: number }).c;

describe("PATCH theme — dry-run и no-op (P6.1)", () => {
  test("dryRun returns the token diff and the resulting resolvedSpaceScale without writing a version", async () => {
    const { db, handler } = await setup();
    await createCustomSystem(handler, "dry-run");
    expect((await handler(req("/design-systems/dry-run", "PATCH", { tokens: { ...fullSpace, "color.brand": "#111111" }, baseVersion: 0 }))).status).toBe(200);

    const response = await handler(req("/design-systems/dry-run", "PATCH", {
      tokens: { ...fullSpace, "space.md": "20px", "space.lg": "24px", "space.xl": "32px", "space.2xl": "40px", "space.3xl": "56px", "space.4xl": "72px", "color.accent": "#222222" },
      baseVersion: 1, dryRun: true,
    }));
    expect(response.status).toBe(200);
    const body = await response.json() as PatchBody;
    expect(body.dryRun).toBe(true);
    expect(body.noop).toBe(false);
    expect(body.nextVersion).toBe(2);
    // Итоговая шкала — та, что применилась бы после записи.
    expect(body.resolvedSpaceScale).toMatchObject({ md: "20px", lg: "24px", "4xl": "72px" });
    expect(body.diff.changed).toBe(true);
    expect(body.diff.tokens.added).toEqual({ "color.accent": "#222222" });
    expect(body.diff.tokens.changed["space.md"]).toEqual({ from: "12px", to: "20px" });
    expect(body.diff.tokens.removed).toEqual(["color.brand"]);

    // Ничего не записано: ни версии, ни сдвига latestMetaVersion.
    expect(versionCount(db, "dry-run")).toBe(1);
    const summary = await (await handler(req("/design-systems/dry-run"))).json() as { latestMetaVersion: number; resolvedSpaceScale: Record<string, string> };
    expect(summary.latestMetaVersion).toBe(1);
    expect(summary.resolvedSpaceScale).toMatchObject({ md: "12px" });
    db.close();
  });

  test("a patch identical to the base version creates no version (noop) and keeps the CAS cursor", async () => {
    const { db, handler } = await setup();
    await createCustomSystem(handler, "noop-theme");
    const tokens = { ...fullSpace, "color.brand": "#123456" };
    expect((await handler(req("/design-systems/noop-theme", "PATCH", { tokens, baseVersion: 0 }))).status).toBe(200);

    // Тот же словарь в другом порядке ключей — семантически та же тема.
    const shuffled = Object.fromEntries(Object.entries(tokens).reverse());
    const response = await handler(req("/design-systems/noop-theme", "PATCH", { tokens: shuffled, fonts: [], icons: [], baseVersion: 1 }));
    expect(response.status).toBe(200);
    const body = await response.json() as PatchBody;
    expect(body.noop).toBe(true);
    expect(body.nextVersion).toBe(null);
    expect(body.latestMetaVersion).toBe(1);
    expect(body.diff.changed).toBe(false);
    expect(versionCount(db, "noop-theme")).toBe(1);

    // Следующий содержательный патч по-прежнему идёт от baseVersion 1.
    expect((await handler(req("/design-systems/noop-theme", "PATCH", { tokens: { ...tokens, "color.brand": "#654321" }, baseVersion: 1 }))).status).toBe(200);
    expect(versionCount(db, "noop-theme")).toBe(2);
    db.close();
  });

  test("PATCH lists prototypes whose head revision pins an older theme version", async () => {
    const { db, handler } = await setup();
    await createCustomSystem(handler, "stale-pins");
    expect((await handler(req("/design-systems/stale-pins", "PATCH", { tokens: { "color.brand": "#111111" }, baseVersion: 0 }))).status).toBe(200);
    new PrototypeRepo(db).create(customDoc("stale-proto", "stale-pins"));

    const body = await (await handler(req("/design-systems/stale-pins", "PATCH", { tokens: { "color.brand": "#222222" }, baseVersion: 1 }))).json() as PatchBody;
    expect(body.nextVersion).toBe(2);
    expect(body.stalePins.total).toBe(1);
    expect(body.stalePins.prototypes[0]).toMatchObject({ id: "stale-proto", pinnedVersion: 1 });
    db.close();
  });
});

describe("PATCH theme — sparse append-only операции (P6.2)", () => {
  test("addTokens appends to the base version, never deletes and stays no-op for identical values", async () => {
    const { db, handler } = await setup();
    await createCustomSystem(handler, "sparse-add");
    expect((await handler(req("/design-systems/sparse-add", "PATCH", { tokens: { "color.brand": "#111111", "color.text": "#000000" }, baseVersion: 0 }))).status).toBe(200);

    const body = await (await handler(req("/design-systems/sparse-add", "PATCH", { addTokens: { "color.accent": "#333333" }, baseVersion: 1 }))).json() as PatchBody;
    expect(body.nextVersion).toBe(2);
    // Удаление невозможно by construction: не переданные ключи остаются.
    expect(body.tokens).toEqual({ "color.brand": "#111111", "color.text": "#000000", "color.accent": "#333333" });
    expect(body.diff.tokens.removed).toEqual([]);

    // Повтор того же значения — no-op, версия не растёт.
    const repeat = await (await handler(req("/design-systems/sparse-add", "PATCH", { addTokens: { "color.accent": "#333333" }, baseVersion: 2 }))).json() as PatchBody;
    expect(repeat.noop).toBe(true);
    expect(versionCount(db, "sparse-add")).toBe(2);
    db.close();
  });

  test("sparse resolution is CAS-bound to baseVersion and 409s on a value conflict instead of overwriting", async () => {
    const { db, handler } = await setup();
    await createCustomSystem(handler, "sparse-cas");
    expect((await handler(req("/design-systems/sparse-cas", "PATCH", { tokens: { "color.brand": "#111111" }, baseVersion: 0 }))).status).toBe(200);
    expect((await handler(req("/design-systems/sparse-cas", "PATCH", { tokens: { "color.brand": "#111111", "color.text": "#000000" }, baseVersion: 1 }))).status).toBe(200);

    // Устаревший baseVersion — обычный CAS-отказ, sparse его не обходит.
    const stale = await handler(req("/design-systems/sparse-cas", "PATCH", { addTokens: { "color.accent": "#333333" }, baseVersion: 1 }));
    expect(stale.status).toBe(409);
    expect((await stale.json() as { error: { code: string; currentVersion: number } }).error).toMatchObject({ code: "version_conflict", currentVersion: 2 });

    // Существующий ключ с другим значением — 409, а не тихая перезапись.
    const conflict = await handler(req("/design-systems/sparse-cas", "PATCH", { addTokens: { "color.brand": "#999999" }, baseVersion: 2 }));
    expect(conflict.status).toBe(409);
    const error = await conflict.json() as { error: { code: string; issues: { path: string[]; existing: unknown; incoming: unknown }[] } };
    expect(error.error.code).toBe("theme_append_conflict");
    expect(error.error.issues[0]).toMatchObject({ path: ["addTokens", "color.brand"], existing: "#111111", incoming: "#999999" });
    expect(versionCount(db, "sparse-cas")).toBe(2);
    // Тема не изменилась.
    expect((await (await handler(req("/design-systems/sparse-cas"))).json() as { tokens: Record<string, string> }).tokens["color.brand"]).toBe("#111111");
    db.close();
  });

  test("addFonts/addIcons append by identity and conflict on a different definition", async () => {
    const { db, handler } = await setup();
    await createCustomSystem(handler, "sparse-assets");
    const fontA = await uploadAsset(handler, woff2(), "font/woff2");
    const fontB = await uploadAsset(handler, (() => { const b = woff2(); b[8] = 1; return b; })(), "font/woff2");
    const iconId = await uploadAsset(handler, png(), "image/png");
    expect((await handler(req("/design-systems/sparse-assets", "PATCH", { fonts: [{ family: "Inter", src: fontA }], baseVersion: 0 }))).status).toBe(200);

    const added = await (await handler(req("/design-systems/sparse-assets", "PATCH", { addFonts: [{ family: "Inter", src: fontA, weight: 700 }], addIcons: [{ name: "close", assetId: iconId }], baseVersion: 1 }))).json() as PatchBody;
    expect(added.fonts).toHaveLength(2);
    expect(added.icons).toHaveLength(1);

    const conflict = await handler(req("/design-systems/sparse-assets", "PATCH", { addFonts: [{ family: "Inter", src: fontB }], baseVersion: 2 }));
    expect(conflict.status).toBe(409);
    expect((await conflict.json() as { error: { code: string } }).error.code).toBe("theme_append_conflict");

    const iconConflict = await handler(req("/design-systems/sparse-assets", "PATCH", { addIcons: [{ name: "close", assetId: iconId, viewBox: "0 0 24 24" }], baseVersion: 2 }));
    expect(iconConflict.status).toBe(409);
    db.close();
  });

  test("sparse space.* additions are validated against the merged scale, not the partial body", async () => {
    const { db, handler } = await setup();
    await createCustomSystem(handler, "sparse-space");
    // База без space.*: одиночного `space.md` мало для полной шкалы → 422 на смердженном наборе.
    const incomplete = await handler(req("/design-systems/sparse-space", "PATCH", { addTokens: { "space.md": "20px" }, baseVersion: 0 }));
    expect(incomplete.status).toBe(422);

    // Немонотонный полный набор одной append-операцией — тоже 422 (проверка идёт на результате).
    const nonMonotonic = await handler(req("/design-systems/sparse-space", "PATCH", { addTokens: { ...fullSpace, "space.md": "40px" }, baseVersion: 0 }));
    expect(nonMonotonic.status).toBe(422);
    // Полный валидный набор одной append-операцией проходит.
    expect((await handler(req("/design-systems/sparse-space", "PATCH", { addTokens: fullSpace, baseVersion: 0 }))).status).toBe(200);
    // Неизвестный spacing-токен отсекается формой тела.
    expect((await handler(req("/design-systems/sparse-space", "PATCH", { addTokens: { "space.5xl": "96px" }, baseVersion: 1 }))).status).toBe(422);
    // Существующий ключ с другим значением — append-конфликт, а не молчаливая правка шкалы.
    const overwrite = await handler(req("/design-systems/sparse-space", "PATCH", { addTokens: { "space.md": "40px" }, baseVersion: 1 }));
    expect(overwrite.status).toBe(409);
    db.close();
  });

  test("a collection cannot be sent in full and sparse form at once", async () => {
    const { db, handler } = await setup();
    await createCustomSystem(handler, "sparse-exclusive");
    const response = await handler(req("/design-systems/sparse-exclusive", "PATCH", { tokens: { "color.brand": "#111111" }, addTokens: { "color.text": "#000000" }, baseVersion: 0 }));
    expect(response.status).toBe(422);
    expect((await response.json() as { error: { code: string; issues: { path: string[] }[] } }).error.issues[0]!.path).toEqual(["addTokens"]);
    db.close();
  });
});

describe("PATCH theme — версионирование spacing-резолвера (P6.3)", () => {
  const scaleOf = async (handler: (r: Request) => Promise<Response>, id: string) =>
    (await (await handler(req(`/design-systems/${id}`))).json() as { resolvedSpaceScale: Record<string, string> }).resolvedSpaceScale;

  test("existing (resolver 1) versions of retired builtins keep resolving byte-for-byte, new (resolver 2) ones merge onto the design-system base", async () => {
    const { db, handler } = await setup();
    // Ровно тот случай, где резолверы расходятся: база wireframe не каноническая.
    insertDesignSystemVersion(db, "wireframe", 1, { tokens: { "space.md": "14px" }, fonts: [], icons: [] }, "legacy");
    const legacy = await scaleOf(handler, "wireframe");
    // Legacy-путь: оверрайд ложится на каноническую шкалу (md=14, lg=16 — база wireframe потеряна).
    expect(legacy).toMatchObject({ md: "14px", lg: "16px", xl: "24px", "4xl": "64px" });

    // Та же тема, записанная новым резолвером, сохраняет базу DS.
    db.query("UPDATE design_system_versions SET spacing_resolver=2 WHERE system_id='wireframe' AND version=1").run();
    expect(await scaleOf(handler, "wireframe")).toMatchObject({ md: "14px", lg: "24px", xl: "32px", "4xl": "80px" });
    db.close();
  });

  test("a new theme version is written with resolver 2 and reports it on the version endpoint", async () => {
    const { db, handler } = await setup();
    await createCustomSystem(handler, "resolver-new");
    const body = await (await handler(req("/design-systems/resolver-new", "PATCH", { tokens: { ...fullSpace, "space.md": "20px", "space.lg": "24px", "space.xl": "32px", "space.2xl": "40px", "space.3xl": "56px", "space.4xl": "72px" }, baseVersion: 0 }))).json() as PatchBody;
    expect(body.spacingResolver).toBe(2);
    expect(db.query("SELECT spacing_resolver r FROM design_system_versions WHERE system_id='resolver-new' AND version=1").get()).toEqual({ r: 2 });
    const version = await (await handler(req("/design-systems/resolver-new/versions/1"))).json() as { spacingResolver: number; resolvedSpaceScale: Record<string, string> };
    expect(version.spacingResolver).toBe(2);
    expect(version.resolvedSpaceScale).toMatchObject({ md: "20px", "4xl": "72px" });
    db.close();
  });

  test("a full token patch that drops space.* inherits the base version's scale instead of silently changing it", async () => {
    const { db, handler } = await setup();
    await createCustomSystem(handler, "space-inherit");
    const custom = { ...fullSpace, "space.md": "20px", "space.lg": "24px", "space.xl": "32px", "space.2xl": "40px", "space.3xl": "56px", "space.4xl": "72px" };
    expect((await handler(req("/design-systems/space-inherit", "PATCH", { tokens: custom, baseVersion: 0 }))).status).toBe(200);

    const body = await (await handler(req("/design-systems/space-inherit", "PATCH", { tokens: { "color.brand": "#111111" }, baseVersion: 1 }))).json() as PatchBody;
    expect(body.inheritedSpaceTokens).toEqual(Object.keys(custom));
    expect(body.tokens).toMatchObject({ "color.brand": "#111111", "space.md": "20px", "space.4xl": "72px" });
    expect(body.resolvedSpaceScale).toMatchObject({ md: "20px", "4xl": "72px" });
    expect(body.diff.tokens.removed).toEqual([]);
    db.close();
  });

  test("EASYUI_THEME_RESOLVER_V2_DISABLED keeps writing resolver 1 and the legacy omission behaviour", async () => {
    const { dir, db } = await setup();
    const handler = createTestHandler(db, { dataDir: dir, spacingResolverV2Disabled: true });
    await createCustomSystem(handler, "killswitch");
    const custom = { ...fullSpace, "space.md": "20px", "space.lg": "24px", "space.xl": "32px", "space.2xl": "40px", "space.3xl": "56px", "space.4xl": "72px" };
    expect((await handler(req("/design-systems/killswitch", "PATCH", { tokens: custom, baseVersion: 0 }))).status).toBe(200);
    expect(db.query("SELECT spacing_resolver r FROM design_system_versions WHERE system_id='killswitch' AND version=1").get()).toEqual({ r: 1 });

    const body = await (await handler(req("/design-systems/killswitch", "PATCH", { tokens: { "color.brand": "#111111" }, baseVersion: 1 }))).json() as PatchBody;
    expect(body.spacingResolver).toBe(1);
    expect(body.inheritedSpaceTokens).toEqual([]);
    expect(body.tokens).toEqual({ "color.brand": "#111111" });

    const features = await (await handler(req("/capabilities"))).json() as { features: Record<string, boolean> };
    expect(features.features).toMatchObject({ themeSpacingResolverV2: false, themeDryRun: true, themeSparseOps: true });
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
