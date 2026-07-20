import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { openDatabase } from "./db";
import { createHandler } from "./main";
import { createTestHandler } from "./test-auth";
import { UserRepo } from "./users";
import { bundleManifestSchema } from "../src/bundle/schema";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const ratingStars = await Bun.file("server/fixtures/rating-stars.tsx").text();
// Font/image assets are content-addressed by real bytes so the closure exercises theme + pins.
const WOFF2 = Uint8Array.from([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0, 1, 2, 3, 4]);
const svg = (id: string) => new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" id="${id}"><rect width="1" height="1"/></svg>`);
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

type Who = "alice" | "bob" | null;

async function fixture() {
  const dir = await mkdtemp(resolve(process.cwd(), ".bundle-export-test-"));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  createTestHandler(db, { dataDir: dir }); // bootstrap admin + migrations
  const at = new Date().toISOString();
  db.query("INSERT INTO users (id,name,password_hash,is_admin,created_at) VALUES (?,?,?,?,?),(?,?,?,?,?)")
    .run("user_alice", "Alice", "unused", 0, at, "user_bob", "Bob", "unused", 0, at);
  const users = new UserRepo(db);
  const tokens = { alice: users.createSession("user_alice").token, bob: users.createSession("user_bob").token };
  const handler = createHandler(db, { dataDir: dir, publicOrigin: "http://test" });
  const call = (who: Who, method: string, path: string, body?: unknown, contentType = "application/json") => {
    const headers: Record<string, string> = {};
    if (who) headers.cookie = `easyui_session=${tokens[who]}`;
    if (method !== "GET" && method !== "HEAD") headers.origin = "http://test";
    if (body !== undefined) headers["content-type"] = contentType;
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = typeof body === "string" || body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body);
    return handler(new Request(`http://test/api${path}`, init));
  };
  const upload = async (bytes: Uint8Array, mime: string) => {
    const response = await call("alice", "POST", "/assets", bytes, mime);
    expect(response.status).toBeLessThan(300);
    return (await response.json() as { id: string }).id;
  };
  return { db, handler, call, upload };
}

async function unzip(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/zip");
  const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
  const manifest = bundleManifestSchema.parse(JSON.parse(strFromU8(entries["manifest.json"]!)));
  return { entries, manifest };
}

async function seed(f: Awaited<ReturnType<typeof fixture>>) {
  const { call, upload } = f;
  expect((await call("alice", "POST", "/design-systems", { id: "bundle-ds", name: "Bundle DS", description: "Export fixture" })).status).toBe(201);
  const fontAsset = await upload(WOFF2, "font/woff2");
  const componentAsset = await upload(svg("component"), "image/svg+xml");
  const protoAsset = await upload(svg("prototype"), "image/svg+xml");
  expect((await call("alice", "PATCH", "/design-systems/bundle-ds", { fonts: [{ family: "Inter", src: fontAsset }], baseVersion: 0 })).status).toBe(200);
  const source = `// asset: /api/assets/${componentAsset}\n${ratingStars}`;
  expect((await call("alice", "POST", "/components", { id: "rating-stars", name: "RatingStars", source, designSystem: "bundle-ds" })).status).toBe(201);
  expect((await call("alice", "POST", "/components/rating-stars/publish", { baseRev: 1 })).status).toBe(201);
  const doc = {
    version: 1, id: "bundle-proto", name: "Bundle proto", designSystem: "bundle-ds", device: "desktop", startScreen: "rate", state: {},
    screens: [
      { id: "rate", name: "Rate", spec: { root: "rating", elements: { rating: { type: "RatingStars", props: { value: 3 } } } } },
      { id: "show", name: "Show", spec: { root: "img", elements: { img: { type: "Image", props: { src: { $asset: protoAsset }, alt: "p" } } } } },
    ],
  };
  expect((await call("alice", "POST", "/prototypes", { doc })).status).toBe(201);
  return { fontAsset, componentAsset, protoAsset };
}

describe("bundle export", () => {
  test("prototype export closes over pins, prototype/component assets and the DS theme", async () => {
    const f = await fixture();
    const { fontAsset, componentAsset, protoAsset } = await seed(f);
    const { entries, manifest } = await unzip(await f.call("alice", "GET", "/prototypes/bundle-proto/export"));

    expect(manifest.kind).toBe("prototype");
    expect(manifest.prototypes).toHaveLength(1);
    const proto = manifest.prototypes[0]!;
    expect(proto.exported.selector).toBe("draft");
    expect(proto.componentPins).toEqual([{ id: "rating-stars", version: 1 }]);
    expect(proto.assetIds).toEqual([protoAsset]);
    expect(proto.designSystemMetaVersion).toBe(1);

    // Document, TSX and every asset are present in the archive.
    expect(entries[proto.docPath]).toBeDefined();
    const component = manifest.components[0]!;
    expect(component.id).toBe("rating-stars");
    expect(strFromU8(entries[component.sourcePath]!)).toContain(`/api/assets/${componentAsset}`);
    expect(component.assetIds).toEqual([componentAsset]);

    // Theme travels with its font asset.
    const ds = manifest.designSystems.find((system) => system.id === "bundle-ds")!;
    expect(ds.builtin).toBe(false);
    expect(ds.theme?.fonts.map((font) => font.src)).toEqual([fontAsset]);

    // All three assets are bundled once, and every asset's bytes hash to its declared sha256.
    expect(new Set(manifest.assets.map((a) => a.id))).toEqual(new Set([fontAsset, componentAsset, protoAsset]));
    for (const asset of manifest.assets) {
      const bytes = entries[`assets/${asset.sha256}`]!;
      expect(bytes).toBeDefined();
      expect(sha256(bytes)).toBe(asset.sha256);
      expect(`asset_${asset.sha256}`).toBe(asset.id);
    }
    f.db.close();
  });

  test("?version exports the published revision, absence exports the owner draft", async () => {
    const f = await fixture();
    await seed(f);
    expect((await f.call("alice", "POST", "/prototypes/bundle-proto/publish", { baseRev: 1 })).status).toBe(201);

    const draft = (await unzip(await f.call("alice", "GET", "/prototypes/bundle-proto/export"))).manifest.prototypes[0]!;
    expect(draft.exported).toMatchObject({ selector: "draft", version: null });

    const versioned = (await unzip(await f.call("alice", "GET", "/prototypes/bundle-proto/export?version=1"))).manifest.prototypes[0]!;
    expect(versioned.exported).toMatchObject({ selector: "version", version: 1 });
    f.db.close();
  });

  test("authorization matrix: non-owner published 200, private 404, anonymous 401", async () => {
    const f = await fixture();
    await seed(f);

    // Private prototype: a non-owner cannot see it, let alone export it.
    expect((await f.call("bob", "GET", "/prototypes/bundle-proto/export")).status).toBe(404);
    // Anonymous is rejected before authorization.
    expect((await f.call(null, "GET", "/prototypes/bundle-proto/export")).status).toBe(401);

    expect((await f.call("alice", "POST", "/prototypes/bundle-proto/publish", { baseRev: 1 })).status).toBe(201);
    expect((await f.call("alice", "POST", "/prototypes/bundle-proto/status", { status: "published" })).status).toBe(200);
    // A non-owner with no ?version receives the latest published version, never the draft.
    const nonOwner = (await unzip(await f.call("bob", "GET", "/prototypes/bundle-proto/export"))).manifest.prototypes[0]!;
    expect(nonOwner.exported).toMatchObject({ selector: "version", version: 1 });
    f.db.close();
  });

  test("component export falls back to the head draft when unpublished", async () => {
    const f = await fixture();
    const { componentAsset } = await seed(f);
    // rating-stars is published (version 1) -> exports that version.
    const published = (await unzip(await f.call("alice", "GET", "/components/rating-stars/export"))).manifest;
    expect(published.kind).toBe("component");
    expect(published.components[0]!.exported).toMatchObject({ version: 1 });
    expect(published.components[0]!.assetIds).toEqual([componentAsset]);

    // An unpublished component exports its head draft with version null.
    const draftSource = "import { z } from \"zod\";\nexport const definition = { props: z.strictObject({}), description: \"Draft\" };\nexport default function Draft() { return null; }\n";
    expect((await f.call("alice", "POST", "/components", { id: "draft-only", name: "DraftOnly", source: draftSource, designSystem: "bundle-ds" })).status).toBe(201);
    const draft = (await unzip(await f.call("alice", "GET", "/components/draft-only/export"))).manifest;
    expect(draft.components[0]!.exported).toMatchObject({ version: null });
    f.db.close();
  });

  test("bulk export covers owned resources, prefers published, and excludes other owners", async () => {
    const f = await fixture();
    await seed(f);
    expect((await f.call("alice", "POST", "/prototypes/bundle-proto/publish", { baseRev: 1 })).status).toBe(201);
    // A newer draft revision exists, but bulk must still prefer the published version.
    const doc2 = {
      version: 1, id: "bundle-proto", name: "Bundle proto v2", designSystem: "bundle-ds", device: "desktop", startScreen: "rate", state: {},
      screens: [{ id: "rate", name: "Rate", spec: { root: "rating", elements: { rating: { type: "RatingStars", props: { value: 4 } } } } }],
    };
    expect((await f.call("alice", "PUT", "/prototypes/bundle-proto", { doc: doc2, baseRev: 1 })).status).toBe(200);

    const bulk = (await unzip(await f.call("alice", "GET", "/bundles/export"))).manifest;
    expect(bulk.kind).toBe("bulk");
    expect(bulk.prototypes.map((p) => p.id)).toEqual(["bundle-proto"]);
    expect(bulk.prototypes[0]!.exported).toMatchObject({ selector: "version", version: 1 });
    expect(bulk.components.map((c) => c.id)).toEqual(["rating-stars"]);

    // Bob owns nothing: his bulk archive is empty and never leaks Alice's private prototype.
    const bobBulk = (await unzip(await f.call("bob", "GET", "/bundles/export"))).manifest;
    expect(bobBulk.prototypes).toEqual([]);
    expect(bobBulk.components).toEqual([]);
    f.db.close();
  });
});
