import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { openDatabase } from "./db";
import { createHandler } from "./main";
import { catalogManifest } from "./routes/components";
import { PrototypeRepo } from "./repos/prototypes";
import { prototypeDocSchema } from "../src/prototype/schema";

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
async function setup() {
  const dir = await mkdtemp(resolve(process.cwd(), ".status-test-"));
  dirs.push(dir);
  const db = openDatabase(":memory:"), handler = createHandler(db, { dataDir: dir });
  return { dir, db, handler };
}
const req = (url: string, method = "GET", value?: unknown) =>
  new Request(`http://test/api${url}`, { method, headers: value ? { "content-type": "application/json" } : undefined, body: value ? JSON.stringify(value) : undefined });
const fixture = (name: string) => Bun.file(resolve("server/fixtures", name)).text();

// Publishes N versions of a RatingStars component (each a distinct revision) so we can exercise
// the transition matrix across several versions.
async function seedComponent(handler: (r: Request) => Promise<Response>, versions = 1) {
  const source = await fixture("rating-stars.tsx");
  expect((await handler(req("/components", "POST", { id: "rating-stars", name: "RatingStars", source }))).status).toBe(201);
  expect((await handler(req("/components/rating-stars/publish", "POST", { baseRev: 1 }))).status).toBe(201);
  for (let v = 2; v <= versions; v += 1) {
    await handler(req("/components/rating-stars", "PUT", { baseRev: v - 1, source: source.replace("five-star", `five-star v${v}`) }));
    expect((await handler(req(`/components/rating-stars/publish`, "POST", { baseRev: v }))).status).toBe(201);
  }
}
const setStatus = (handler: (r: Request) => Promise<Response>, version: number, body: unknown) =>
  handler(req(`/components/rating-stars/versions/${version}/status`, "POST", body));

describe("component version status transitions", () => {
  test("valid transitions walk the lifecycle and bump statusRev", async () => {
    const { db, handler } = await setup(); await seedComponent(handler);
    // active -> deprecated
    let res = await setStatus(handler, 1, { status: "deprecated", baseStatusRev: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "deprecated", statusRev: 2 });
    // deprecated -> active (back)
    res = await setStatus(handler, 1, { status: "active", baseStatusRev: 2 });
    expect(await res.json()).toEqual({ status: "active", statusRev: 3 });
    // active -> archived (terminal, no further transitions)
    res = await setStatus(handler, 1, { status: "archived", baseStatusRev: 3 });
    expect(await res.json()).toEqual({ status: "archived", statusRev: 4 });
    const invalid = await setStatus(handler, 1, { status: "active", baseStatusRev: 4 });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({ error: { code: "invalid_transition" } });
    db.close();
  });

  test("invalid transitions and non-manual states are rejected", async () => {
    const { db, handler } = await setup(); await seedComponent(handler);
    // active -> staging is not allowed
    let res = await setStatus(handler, 1, { status: "staging", baseStatusRev: 1 });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("invalid_transition");
    // active -> deprecated -> rejected is not allowed (rejected only reachable from active)
    await setStatus(handler, 1, { status: "deprecated", baseStatusRev: 1 });
    res = await setStatus(handler, 1, { status: "rejected", baseStatusRev: 2 });
    expect(res.status).toBe(422);
    db.close();
  });

  test("CAS on statusRev rejects a stale base", async () => {
    const { db, handler } = await setup(); await seedComponent(handler);
    await setStatus(handler, 1, { status: "deprecated", baseStatusRev: 1 });
    const stale = await setStatus(handler, 1, { status: "archived", baseStatusRev: 1 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "status_conflict", currentStatusRev: 2 } });
    db.close();
  });

  test("rejected requires a reason and stores it", async () => {
    const { db, handler } = await setup(); await seedComponent(handler);
    const noReason = await setStatus(handler, 1, { status: "rejected", baseStatusRev: 1 });
    expect(noReason.status).toBe(422);
    expect((await noReason.json()).error.issues[0].path).toEqual(["reason"]);
    expect((await setStatus(handler, 1, { status: "rejected", baseStatusRev: 1, reason: "unsafe code" })).status).toBe(200);
    const meta = await (await handler(req("/components/rating-stars"))).json() as { versions: { version: number; status: string; statusReason: string | null }[] };
    expect(meta.versions[0]).toMatchObject({ status: "rejected", statusReason: "unsafe code" });
    db.close();
  });

  // Seeds three published versions; each publish runs compile + SSR conformance, which
  // exceeds the default 5s budget when the full suite runs in parallel.
  test("superseded requires a valid supersededBy: existent, non-self, acyclic", async () => {
    const { db, handler } = await setup(); await seedComponent(handler, 3);
    // Missing supersededBy
    expect((await setStatus(handler, 1, { status: "superseded", baseStatusRev: 1 })).status).toBe(422);
    // Self
    expect((await setStatus(handler, 1, { status: "superseded", baseStatusRev: 1, supersededBy: 1 })).status).toBe(422);
    // Unknown version
    expect((await setStatus(handler, 1, { status: "superseded", baseStatusRev: 1, supersededBy: 99 })).status).toBe(422);
    // Valid: v1 superseded by v2
    const res = await setStatus(handler, 1, { status: "superseded", baseStatusRev: 1, supersededBy: 2 });
    expect(await res.json()).toEqual({ status: "superseded", statusRev: 2 });
    // v2 superseded by v3
    expect((await setStatus(handler, 2, { status: "superseded", baseStatusRev: 1, supersededBy: 3 })).status).toBe(200);
    // Cycle: v3 superseded by v1 (v1 -> v2 -> v3 -> v1)
    const cycle = await setStatus(handler, 3, { status: "superseded", baseStatusRev: 1, supersededBy: 1 });
    expect(cycle.status).toBe(422);
    expect((await cycle.json()).error.issues[0].message).toContain("cycle");
    // Read-back carries supersededBy
    const meta = await (await handler(req("/components/rating-stars"))).json() as { versions: { version: number; supersededBy: number | null }[] };
    expect(meta.versions.find((v) => v.version === 1)?.supersededBy).toBe(2);
    db.close();
  }, 30_000);

  test("unknown version yields 404", async () => {
    const { db, handler } = await setup(); await seedComponent(handler);
    expect((await setStatus(handler, 5, { status: "archived", baseStatusRev: 1 })).status).toBe(404);
    db.close();
  });
});

describe("status-aware execution semantics", () => {
  test("bundle endpoint serves renderable statuses and 404s the rest", async () => {
    const { db, handler } = await setup(); await seedComponent(handler);
    expect((await handler(req("/components/rating-stars/versions/1/bundle.js"))).status).toBe(200);
    // deprecated still serves
    await setStatus(handler, 1, { status: "deprecated", baseStatusRev: 1 });
    expect((await handler(req("/components/rating-stars/versions/1/bundle.js"))).status).toBe(200);
    // rejected does not serve
    await setStatus(handler, 1, { status: "active", baseStatusRev: 2 });
    await setStatus(handler, 1, { status: "rejected", baseStatusRev: 3, reason: "bad" });
    const gone = await handler(req("/components/rating-stars/versions/1/bundle.js"));
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({ error: { code: "bundle_unavailable" } });
    // metadata stays readable at any status
    expect((await handler(req("/components/rating-stars/versions/1"))).status).toBe(200);
    db.close();
  });

  test("catalog manifest lists only active versions", async () => {
    const { db, handler } = await setup(); await seedComponent(handler);
    expect(catalogManifest(db)).toHaveLength(1);
    await setStatus(handler, 1, { status: "deprecated", baseStatusRev: 1 });
    // No active version left -> component drops out of the manifest.
    expect(catalogManifest(db)).toHaveLength(0);
    db.close();
  });

  test("render-status warns on deprecated pins and fails on rejected pins", async () => {
    const { db, handler } = await setup(); await seedComponent(handler);
    const original = prototypeDocSchema.parse(await Bun.file("prototypes/hello-world.json").json());
    const screenId = original.screens[0]!.id;
    const doc = { ...original, id: "pinned", name: "Pinned", screens: original.screens.map((s, i) => i ? s : { ...s, spec: { root: "rating", elements: { rating: { type: "RatingStars", props: { value: 3 } } } } }) };
    expect((await handler(req("/prototypes", "POST", { doc }))).status).toBe(201);
    const repo = new PrototypeRepo(db);

    // active pin -> renderable, no warnings
    let status = repo.screenRenderStatus("pinned", screenId, {});
    expect(status.bundles).toBeTrue();
    expect(status.warnings).toHaveLength(0);

    // deprecated pin -> renderable with a pin_deprecated warning
    await setStatus(handler, 1, { status: "deprecated", baseStatusRev: 1 });
    status = repo.screenRenderStatus("pinned", screenId, {});
    expect(status.bundles).toBeTrue();
    expect(status.warnings.map((w) => w.code)).toContain("pin_deprecated");

    // rejected pin -> bundle_failed
    await setStatus(handler, 1, { status: "active", baseStatusRev: 2 });
    await setStatus(handler, 1, { status: "rejected", baseStatusRev: 3, reason: "bad" });
    status = repo.screenRenderStatus("pinned", screenId, {});
    expect(status.bundles).toBeFalse();
    expect(status.errors.map((e) => e.code)).toContain("bundle_failed");
    db.close();
  });
});
