import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { openDatabase } from "./db";
import { createHandler } from "./main";
import { prototypeDocSchema } from "../src/prototype/schema";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function setup(serveDist?: string) {
  const dir = await mkdtemp(resolve(process.cwd(), ".render-status-test-"));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  return { dir, db, handler: createHandler(db, { dataDir: dir, serveDist }) };
}
const req = (url: string, method = "GET", value?: unknown) =>
  new Request(`http://test/api${url}`, { method, headers: value ? { "content-type": "application/json" } : undefined, body: value ? JSON.stringify(value) : undefined });
const fixture = (name: string) => Bun.file(resolve("server/fixtures", name)).text();
async function helloDoc(id: string) {
  const original = prototypeDocSchema.parse(await Bun.file("prototypes/hello-world.json").json());
  return { ...original, id, name: id };
}

describe("render-status endpoint", () => {
  test("reports a renderable head screen and includes the local route when SERVE_DIST is set", async () => {
    const { db, handler } = await setup("dist");
    expect((await handler(req("/prototypes", "POST", { doc: await helloDoc("rs-happy") }))).status).toBe(201);
    const doc = await helloDoc("rs-happy");
    const screen = doc.screens[0]!.id;
    const r = await handler(req(`/prototypes/rs-happy/screens/${screen}/render-status`));
    expect(r.status).toBe(200);
    const body = await r.json() as { status: { document: boolean; bundles: boolean; route: boolean }; renderable: boolean; url: string; revision: number; bundleStatus: string; errors: unknown[] };
    expect(body).toMatchObject({ status: { document: true, bundles: true, route: true }, renderable: true, revision: 1, bundleStatus: "ready" });
    expect(body.url).toBe(`/p/rs-happy/s/${screen}`);
    expect(body.errors).toEqual([]);
    db.close();
  });

  test("flags route_not_ready when the SPA is not served by this process", async () => {
    const { db, handler } = await setup();
    await handler(req("/prototypes", "POST", { doc: await helloDoc("rs-route") }));
    const screen = (await helloDoc("rs-route")).screens[0]!.id;
    const body = await (await handler(req(`/prototypes/rs-route/screens/${screen}/render-status`))).json() as { status: { route: boolean }; renderable: boolean; errors: { code: string }[] };
    expect(body.status.route).toBe(false);
    expect(body.renderable).toBe(true); // renderable is content readiness, independent of the local route
    expect(body.errors.map(e => e.code)).toContain("route_not_ready");
    db.close();
  });

  test("returns typed 404s for missing prototype, screen, version and revision", async () => {
    const { db, handler } = await setup();
    await handler(req("/prototypes", "POST", { doc: await helloDoc("rs-404") }));
    const screen = (await helloDoc("rs-404")).screens[0]!.id;
    const cases: [string, string][] = [
      ["/prototypes/nope/screens/home/render-status", "prototype_not_found"],
      ["/prototypes/rs-404/screens/ghost/render-status", "screen_not_found"],
      [`/prototypes/rs-404/screens/${screen}/render-status?version=99`, "version_not_found"],
      [`/prototypes/rs-404/screens/${screen}/render-status?rev=99`, "revision_not_found"],
    ];
    for (const [url, code] of cases) {
      const r = await handler(req(url));
      expect(r.status).toBe(404);
      expect(await r.json()).toMatchObject({ error: { code } });
    }
    db.close();
  });

  test("rejects mutually exclusive version and rev selectors", async () => {
    const { db, handler } = await setup();
    await handler(req("/prototypes", "POST", { doc: await helloDoc("rs-both") }));
    const screen = (await helloDoc("rs-both")).screens[0]!.id;
    const r = await handler(req(`/prototypes/rs-both/screens/${screen}/render-status?version=1&rev=1`));
    expect(r.status).toBe(422);
    db.close();
  });

  test("resolves a published version and returns the versioned canonical URL", async () => {
    const { db, handler } = await setup("dist");
    await handler(req("/prototypes", "POST", { doc: await helloDoc("rs-ver") }));
    const published = await (await handler(req("/prototypes/rs-ver/publish", "POST", { baseRev: 1 }))).json() as { version: number; rev: number };
    const screen = (await helloDoc("rs-ver")).screens[0]!.id;
    const body = await (await handler(req(`/prototypes/rs-ver/screens/${screen}/render-status?version=${published.version}`))).json() as { url: string; revision: number; publishedVersion: number };
    expect(body.url).toBe(`/p/rs-ver/v/${published.version}/s/${screen}`);
    expect(body.revision).toBe(published.rev);
    expect(body.publishedVersion).toBe(published.version);
    db.close();
  });

  test("reports bundle_failed when a pinned component version is not renderable", async () => {
    const { db, handler } = await setup();
    const source = await fixture("rating-stars.tsx");
    await handler(req("/components", "POST", { id: "rating-stars", name: "RatingStars", source }));
    await handler(req("/components/rating-stars/publish", "POST", { baseRev: 1 }));
    const original = await helloDoc("rs-bundle");
    const withRating = { ...original, screens: original.screens.map((s, i) => i ? s : { ...s, spec: { root: "rating", elements: { rating: { type: "RatingStars", props: { value: 3 } } } } }) };
    expect((await handler(req("/prototypes", "POST", { doc: withRating }))).status).toBe(201);
    const screen = original.screens[0]!.id;
    // Simulate a pin whose component version is no longer renderable.
    db.run("UPDATE component_publishes SET status='failed' WHERE component_id='rating-stars' AND version=1");
    const body = await (await handler(req(`/prototypes/rs-bundle/screens/${screen}/render-status`))).json() as { renderable: boolean; bundleStatus: string; resolvedPins: { status: string }[]; errors: { code: string }[] };
    expect(body.bundleStatus).toBe("failed");
    expect(body.renderable).toBe(false);
    expect(body.resolvedPins[0]!.status).toBe("failed");
    expect(body.errors.map(e => e.code)).toContain("bundle_failed");
    db.close();
  });
});

describe("lifecycle meta", () => {
  test("prototype meta exposes draft/validated/published revisions and renderable flags", async () => {
    const { db, handler } = await setup();
    await handler(req("/prototypes", "POST", { doc: await helloDoc("lc-proto") }));
    let meta = await (await handler(req("/prototypes/lc-proto"))).json() as { draftRevision: number; validatedRevision: number | null; publishedVersion: number | null; renderable: { head: boolean; published: boolean | null } };
    expect(meta).toMatchObject({ draftRevision: 1, validatedRevision: 1, publishedVersion: null, renderable: { head: true, published: null } });
    await handler(req("/prototypes/lc-proto/publish", "POST", { baseRev: 1 }));
    meta = await (await handler(req("/prototypes/lc-proto"))).json() as typeof meta;
    expect(meta).toMatchObject({ publishedVersion: 1, renderable: { head: true, published: true } });
    db.close();
  });

  test("restore writes a validation record and advances validatedRevision", async () => {
    const { db, handler } = await setup();
    const doc = await helloDoc("lc-restore");
    await handler(req("/prototypes", "POST", { doc }));
    await handler(req("/prototypes/lc-restore", "PUT", { baseRev: 1, doc: { ...doc, name: "Renamed" } }));
    expect((await handler(req("/prototypes/lc-restore/restore", "POST", { rev: 1, baseRev: 2 }))).status).toBe(200);
    const meta = await (await handler(req("/prototypes/lc-restore"))).json() as { draftRevision: number; validatedRevision: number | null };
    expect(meta.draftRevision).toBe(3);
    expect(meta.validatedRevision).toBe(3);
    expect(db.query("SELECT COUNT(*) count FROM validation_records WHERE resource_type='prototype' AND resource_id='lc-restore'").get()).toEqual({ count: 3 });
    db.close();
  });

  test("component meta exposes validated revision and renderable head after publish", async () => {
    const { db, handler } = await setup();
    const source = await fixture("rating-stars.tsx");
    await handler(req("/components", "POST", { id: "rating-stars", name: "RatingStars", source }));
    let meta = await (await handler(req("/components/rating-stars"))).json() as { draftRevision: number; validatedRevision: number | null; publishedVersion: number | null; renderable: { head: boolean; published: boolean | null } };
    expect(meta).toMatchObject({ draftRevision: 1, validatedRevision: null, publishedVersion: null, renderable: { head: false, published: null } });
    await handler(req("/components/rating-stars/publish", "POST", { baseRev: 1 }));
    meta = await (await handler(req("/components/rating-stars"))).json() as typeof meta;
    expect(meta).toMatchObject({ validatedRevision: 1, publishedVersion: 1, renderable: { head: true, published: true } });
    db.close();
  });
});

describe("provider-less design systems", () => {
  test("records validation and serves render-status for a yandex-pay prototype", async () => {
    const { db, handler } = await setup("dist");
    const source = (await fixture("rating-stars.tsx")).replaceAll("RatingStars", "YpRating");
    expect((await handler(req("/components", "POST", { id: "yp-rating", name: "YpRating", source, designSystem: "yandex-pay" }))).status).toBe(201);
    expect((await handler(req("/components/yp-rating/publish", "POST", { baseRev: 1 }))).status).toBe(201);
    const doc = { version: 1, id: "yp-proto", name: "YP", designSystem: "yandex-pay", device: "desktop", startScreen: "home", state: {}, screens: [{ id: "home", name: "Home", spec: { root: "root", elements: { root: { type: "YpRating", props: { value: 3 } } } } }] };
    expect((await handler(req("/prototypes", "POST", { doc }))).status).toBe(201);
    const meta = await (await handler(req("/prototypes/yp-proto"))).json() as { validatedRevision: number | null; renderable: { head: boolean } };
    expect(meta.validatedRevision).toBe(1);
    expect(meta.renderable.head).toBe(true);
    const rs = await (await handler(req("/prototypes/yp-proto/screens/home/render-status"))).json() as { renderable: boolean; resolvedPins: unknown[] };
    expect(rs.renderable).toBe(true);
    expect(rs.resolvedPins).toHaveLength(1);
    expect(db.query("SELECT ok FROM validation_records WHERE resource_type='prototype' AND resource_id='yp-proto'").get()).toEqual({ ok: 1 });
    db.close();
  });
});

describe("issue pointers", () => {
  test("validation issues carry an RFC 6901 pointer alongside the legacy path", async () => {
    const { db, handler } = await setup();
    const original = await helloDoc("ptr");
    const r = await handler(req("/prototypes", "POST", { doc: { ...original, screens: [] } }));
    expect(r.status).toBe(422);
    const body = await r.json() as { error: { issues: { path: unknown; pointer: string }[] } };
    expect(body.error.issues.length).toBeGreaterThan(0);
    for (const issue of body.error.issues) expect(typeof issue.pointer).toBe("string");
    db.close();
  });
});
