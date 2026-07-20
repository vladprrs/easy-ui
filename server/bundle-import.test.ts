import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { unzipSync, zipSync, strToU8 } from "fflate";
import { openDatabase } from "./db";
import { createHandler } from "./main";
import { createTestHandler } from "./test-auth";
import { UserRepo } from "./users";
import { importReportSchema, type ImportReport } from "../src/bundle/schema";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const ratingStars = await Bun.file("server/fixtures/rating-stars.tsx").text();
const WOFF2 = Uint8Array.from([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0, 1, 2, 3, 4]);
const svg = (id: string) => new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" id="${id}"><rect width="1" height="1"/></svg>`);
const sha256hex = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

// One in-memory server with its own data dir (kept inside the project root so materialized TSX resolves deps).
async function makeServer(prefix: string, userNames: string[]) {
  const dir = await mkdtemp(resolve(process.cwd(), `.bundle-import-${prefix}-`));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  createTestHandler(db, { dataDir: dir }); // bootstrap admin + migrations
  const at = new Date().toISOString();
  const users = new UserRepo(db);
  const tokens: Record<string, string> = {};
  for (const name of userNames) {
    const id = `user_${name}`;
    db.query("INSERT INTO users (id,name,password_hash,is_admin,created_at) VALUES (?,?,?,?,?)").run(id, name, "unused", 0, at);
    tokens[name] = users.createSession(id).token;
  }
  const handler = createHandler(db, { dataDir: dir, publicOrigin: "http://test" });
  const call = (who: string | null, method: string, path: string, body?: unknown, contentType = "application/json") => {
    const headers: Record<string, string> = {};
    if (who) headers.cookie = `easyui_session=${tokens[who]}`;
    if (method !== "GET" && method !== "HEAD") headers.origin = "http://test";
    if (body !== undefined) headers["content-type"] = contentType;
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = typeof body === "string" || body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body);
    return handler(new Request(`http://test/api${path}`, init));
  };
  const upload = async (who: string, bytes: Uint8Array, mime: string) => {
    const response = await call(who, "POST", "/assets", bytes, mime);
    expect(response.status).toBeLessThan(300);
    return (await response.json() as { id: string }).id;
  };
  return { db, call, upload };
}

type Server = Awaited<ReturnType<typeof makeServer>>;

// Seeds a full closure (custom DS + font theme, published component with an asset, prototype) for `who`.
async function seed(server: Server, who: string) {
  const { call, upload } = server;
  expect((await call(who, "POST", "/design-systems", { id: "bundle-ds", name: "Bundle DS", description: "Import fixture" })).status).toBe(201);
  const fontAsset = await upload(who, WOFF2, "font/woff2");
  const componentAsset = await upload(who, svg("component"), "image/svg+xml");
  const protoAsset = await upload(who, svg("prototype"), "image/svg+xml");
  expect((await call(who, "PATCH", "/design-systems/bundle-ds", { fonts: [{ family: "Inter", src: fontAsset }], baseVersion: 0 })).status).toBe(200);
  const source = `// asset: /api/assets/${componentAsset}\n${ratingStars}`;
  expect((await call(who, "POST", "/components", { id: "rating-stars", name: "RatingStars", source, designSystem: "bundle-ds" })).status).toBe(201);
  expect((await call(who, "POST", "/components/rating-stars/publish", { baseRev: 1 })).status).toBe(201);
  const doc = {
    version: 1, id: "bundle-proto", name: "Bundle proto", designSystem: "bundle-ds", device: "desktop", startScreen: "rate", state: {},
    screens: [
      { id: "rate", name: "Rate", spec: { root: "rating", elements: { rating: { type: "RatingStars", props: { value: 3 } } } } },
      { id: "show", name: "Show", spec: { root: "img", elements: { img: { type: "Image", props: { src: { $asset: protoAsset }, alt: "p" } } } } },
    ],
  };
  expect((await call(who, "POST", "/prototypes", { doc })).status).toBe(201);
  return { fontAsset, componentAsset, protoAsset };
}

async function exportZip(server: Server, who: string, path = "/prototypes/bundle-proto/export"): Promise<Uint8Array> {
  const response = await server.call(who, "GET", path);
  expect(response.status).toBe(200);
  return new Uint8Array(await response.arrayBuffer());
}

async function importZip(server: Server, who: string, zip: Uint8Array, mode?: "dry-run" | "apply"): Promise<{ status: number; report: ImportReport }> {
  const response = await server.call(who, "POST", `/bundles/import${mode ? `?mode=${mode}` : ""}`, zip, "application/zip");
  const report = response.status === 200 ? importReportSchema.parse(await response.json()) : (await response.json() as ImportReport);
  return { status: response.status, report };
}

const itemFor = (report: ImportReport, type: string, id: string) => report.items.find((item) => item.type === type && (item.id === id || item.name === id));
const count = (db: Server["db"], table: string) => (db.query(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;

describe("bundle import", () => {
  test("round-trip: export from A imports into B, renders and rebinds; re-import is reused/skipped", async () => {
    const a = await makeServer("a", ["alice"]);
    await seed(a, "alice");
    const zip = await exportZip(a, "alice");

    const b = await makeServer("b", ["bob"]);
    const first = await importZip(b, "bob", zip);
    expect(first.status).toBe(200);
    expect(first.report.mode).toBe("apply");
    expect(first.report.ok).toBe(true);
    expect(first.report.summary.errors).toBe(0);
    // Everything is newly created on the empty target.
    expect(itemFor(first.report, "designSystem", "bundle-ds")!.action).toBe("created");
    expect(itemFor(first.report, "component", "rating-stars")!.action).toBe("created");
    expect(itemFor(first.report, "prototype", "bundle-proto")!.action).toBe("created");
    for (const item of first.report.items.filter((i) => i.type === "asset")) expect(item.action).toBe("created");

    // The imported component is active and its compiled bundle is served.
    expect((await b.call("bob", "GET", "/components/rating-stars/versions/1/bundle.js")).status).toBe(200);
    // The imported prototype is renderable and pinned to the imported component.
    const draft = await (await b.call("bob", "GET", "/prototypes/bundle-proto/draft")).json() as { renderable: boolean; components: { id: string }[] };
    expect(draft.renderable).toBe(true);
    expect(draft.components.map((c) => c.id)).toContain("rating-stars");
    // The theme travelled with its font asset.
    const ds = await (await b.call("bob", "GET", "/design-systems/bundle-ds")).json() as { fonts: { family: string }[] };
    expect(ds.fonts.map((f) => f.family)).toEqual(["Inter"]);

    // Re-importing the identical bundle mutates nothing.
    const again = await importZip(b, "bob", zip);
    expect(again.report.summary.created).toBe(0);
    expect(itemFor(again.report, "designSystem", "bundle-ds")!.action).toBe("reused");
    expect(itemFor(again.report, "component", "rating-stars")!.action).toBe("reused");
    expect(itemFor(again.report, "prototype", "bundle-proto")!.action).toBe("skipped");
    for (const item of again.report.items.filter((i) => i.type === "asset")) expect(item.action).toBe("reused");
    a.db.close(); b.db.close();
  }, 60_000);

  test("an owned component whose head source changed republishes as a new version", async () => {
    const a = await makeServer("a", ["alice"]);
    await seed(a, "alice");
    const zip = await exportZip(a, "alice");

    const b = await makeServer("b", ["bob"]);
    expect((await importZip(b, "bob", zip)).report.ok).toBe(true);
    // Diverge the head so the bundle source no longer matches.
    const head = await (await b.call("bob", "GET", "/components/rating-stars/source")).json() as { source: string };
    expect((await b.call("bob", "PUT", "/components/rating-stars", { source: `${head.source}\n// local edit\n`, baseRev: 1 })).status).toBe(200);

    const redo = await importZip(b, "bob", zip);
    const component = itemFor(redo.report, "component", "rating-stars")!;
    expect(component.action).toBe("created");
    expect(component.version).toBe(2);
    a.db.close(); b.db.close();
  }, 60_000);

  test("foreign name conflicts and cascades into a prototype dependency failure", async () => {
    const a = await makeServer("a", ["alice"]);
    await seed(a, "alice");
    const zip = await exportZip(a, "alice");

    const b = await makeServer("b", ["bob", "carol"]);
    // Carol owns an unpublished component named RatingStars in a different system.
    expect((await b.call("carol", "POST", "/design-systems", { id: "carol-ds", name: "Carol DS", description: "Rival system" })).status).toBe(201);
    expect((await b.call("carol", "POST", "/components", { id: "other-stars", name: "RatingStars", source: `import { z } from "zod";\nexport const definition = { props: z.strictObject({}), description: "Rival" };\nexport default function Rival() { return null; }\n`, designSystem: "carol-ds" })).status).toBe(201);

    const result = await importZip(b, "bob", zip);
    expect(result.status).toBe(200);
    expect(result.report.ok).toBe(false);
    expect(itemFor(result.report, "component", "rating-stars")!).toMatchObject({ action: "error", detail: "name_conflict" });
    const prototype = itemFor(result.report, "prototype", "bundle-proto")!;
    expect(prototype.action).toBe("error");
    expect(prototype.detail).toContain("dependency_failed");
    a.db.close(); b.db.close();
  }, 60_000);

  test("a soft-deleted component id is a deleted_conflict", async () => {
    const a = await makeServer("a", ["alice"]);
    await seed(a, "alice");
    const zip = await exportZip(a, "alice");

    const b = await makeServer("b", ["bob"]);
    expect((await b.call("bob", "POST", "/design-systems", { id: "bundle-ds", name: "Bundle DS", description: "pre-existing" })).status).toBe(201);
    expect((await b.call("bob", "POST", "/components", { id: "rating-stars", name: "Doomed", source: `import { z } from "zod";\nexport const definition = { props: z.strictObject({}), description: "Doomed" };\nexport default function Doomed() { return null; }\n`, designSystem: "bundle-ds" })).status).toBe(201);
    expect((await b.call("bob", "DELETE", "/components/rating-stars", { baseRev: 1 })).status).toBe(204);

    const result = await importZip(b, "bob", zip);
    expect(itemFor(result.report, "component", "rating-stars")!).toMatchObject({ action: "error", detail: "deleted_conflict" });
    a.db.close(); b.db.close();
  }, 60_000);

  test("a foreign prototype id is remapped and a foreign custom DS is reused by reference", async () => {
    const a = await makeServer("a", ["alice"]);
    await seed(a, "alice");
    const zip = await exportZip(a, "alice");

    const b = await makeServer("b", ["bob", "carol"]);
    // Bob imports first, owning bundle-ds, the active RatingStars and bundle-proto.
    expect((await importZip(b, "bob", zip)).report.ok).toBe(true);
    // Carol re-imports: the design system and component belong to Bob, and the prototype id is taken.
    const carol = await importZip(b, "carol", zip);
    expect(itemFor(carol.report, "designSystem", "bundle-ds")!.action).toBe("reused"); // reuse by reference
    expect(itemFor(carol.report, "component", "rating-stars")!).toMatchObject({ action: "error", detail: "name_conflict" });
    const prototype = itemFor(carol.report, "prototype", "bundle-proto")!;
    expect(prototype.action).toBe("created");
    expect(prototype.remappedTo).toBe("bundle-proto-imported-1");
    // The remapped prototype exists and is owned by Carol.
    expect((await b.call("carol", "GET", "/prototypes/bundle-proto-imported-1")).status).toBe(200);
    a.db.close(); b.db.close();
  }, 60_000);

  test("dry-run predicts without writing", async () => {
    const a = await makeServer("a", ["alice"]);
    await seed(a, "alice");
    const zip = await exportZip(a, "alice");

    const b = await makeServer("b", ["bob"]);
    const before = { ds: count(b.db, "design_systems"), components: count(b.db, "components"), prototypes: count(b.db, "prototypes"), assets: count(b.db, "assets"), publishes: count(b.db, "component_publishes") };
    const dry = await importZip(b, "bob", zip, "dry-run");
    expect(dry.status).toBe(200);
    expect(dry.report.mode).toBe("dry-run");
    expect(dry.report.ok).toBe(true);
    expect(itemFor(dry.report, "prototype", "bundle-proto")!.action).toBe("created");
    expect({ ds: count(b.db, "design_systems"), components: count(b.db, "components"), prototypes: count(b.db, "prototypes"), assets: count(b.db, "assets"), publishes: count(b.db, "component_publishes") }).toEqual(before);
    a.db.close(); b.db.close();
  }, 60_000);

  test("malformed bundles are rejected before any write", async () => {
    const b = await makeServer("b", ["bob"]);

    // Not a ZIP at all.
    expect((await importZip(b, "bob", new TextEncoder().encode("definitely not a zip"))).status).toBe(400);

    // A path outside the allowlist (traversal).
    const traversal = zipSync({ "manifest.json": strToU8("{}"), "prototypes/../../etc/passwd": strToU8("x") });
    expect((await importZip(b, "bob", traversal)).status).toBe(400);

    // A central-directory bomb: the declared uncompressed size exceeds the budget and is rejected before inflation.
    const a = await makeServer("a", ["alice"]);
    await seed(a, "alice");
    const good = await exportZip(a, "alice");
    const bomb = good.slice();
    for (let i = 0; i < bomb.length - 4; i += 1) {
      if (bomb[i] === 0x50 && bomb[i + 1] === 0x4b && bomb[i + 2] === 0x01 && bomb[i + 3] === 0x02) {
        bomb[i + 24] = 0xff; bomb[i + 25] = 0xff; bomb[i + 26] = 0xff; bomb[i + 27] = 0xff; // uncompressed size -> ~4 GiB
        break;
      }
    }
    expect((await importZip(b, "bob", bomb)).status).toBe(413);

    // A tampered asset whose bytes no longer hash to the declared sha256 is a per-item error (200 report).
    const entries = unzipSync(good);
    const assetPath = Object.keys(entries).find((name) => name.startsWith("assets/"))!;
    entries[assetPath] = new TextEncoder().encode("tampered bytes not matching the sha");
    const tampered = zipSync(entries);
    const tamperResult = await importZip(b, "bob", tampered);
    expect(tamperResult.status).toBe(200);
    expect(tamperResult.report.ok).toBe(false);
    expect(tamperResult.report.items.some((item) => item.type === "asset" && item.action === "error")).toBe(true);
    expect(sha256hex(new TextEncoder().encode("tampered bytes not matching the sha"))).not.toBe(assetPath.slice("assets/".length));
    a.db.close(); b.db.close();
  }, 60_000);
});
