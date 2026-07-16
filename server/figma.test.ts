import { createTestHandler } from "./test-auth";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { openDatabase } from "./db";
import { prototypeDocSchema } from "../src/prototype/schema";

// Figma provenance end-to-end (plan §J): save/restore/read-back on both prototypes and
// components, referenceScreenshots validated against the asset registry, and strict rejection.

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
async function setup() {
  const dir = await mkdtemp(resolve(process.cwd(), ".figma-test-"));
  dirs.push(dir);
  const db = openDatabase(":memory:"), handler = createTestHandler(db, { dataDir: dir });
  return { dir, db, handler };
}
const req = (url: string, method = "GET", value?: unknown) =>
  new Request(`http://test/api${url}`, { method, headers: value ? { "content-type": "application/json" } : undefined, body: value ? JSON.stringify(value) : undefined });
const json = async (r: Response) => r.json() as Promise<Record<string, unknown>>;

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
async function uploadPng(handler: (r: Request) => Promise<Response>): Promise<string> {
  const res = await handler(new Request("http://test/api/assets", { method: "POST", headers: { "content-type": "image/png" }, body: PNG_1X1 }));
  expect(res.status).toBe(201);
  return (await json(res)).id as string;
}

const figmaA = { fileKey: "abc123XYZ", nodeIds: ["1:2", "10:20"], lastSyncedAt: "2026-07-12T00:00:00.000Z" };
const figmaB = { fileKey: "second-key", nodeIds: ["3:4"] };

async function helloDoc(id: string) {
  const original = prototypeDocSchema.parse(await Bun.file("test/fixtures/host-content.json").json());
  return { ...original, id, name: id };
}

describe("figma provenance — prototypes", () => {
  test("saves, reads back, restores and publishes figma across revisions", async () => {
    const { db, handler } = await setup();
    const doc = await helloDoc("figma-proto");
    expect((await handler(req("/prototypes", "POST", { doc, figma: figmaA }))).status).toBe(201);

    // Head meta + draft carry the figma provenance of the head revision.
    expect((await json(await handler(req("/prototypes/figma-proto")))).figma).toEqual(figmaA);
    expect((await json(await handler(req("/prototypes/figma-proto/draft")))).figma).toEqual(figmaA);
    expect((await json(await handler(req("/prototypes/figma-proto/revisions/1")))).figma).toEqual(figmaA);

    // Save a new revision with a different link.
    expect((await handler(req("/prototypes/figma-proto", "PUT", { doc, baseRev: 1, figma: figmaB }))).status).toBe(200);
    expect((await json(await handler(req("/prototypes/figma-proto/draft")))).figma).toEqual(figmaB);
    expect((await json(await handler(req("/prototypes/figma-proto/revisions/1")))).figma).toEqual(figmaA);

    // Restore rev 1 copies its figma onto the new head revision.
    expect((await handler(req("/prototypes/figma-proto/restore", "POST", { rev: 1, baseRev: 2 }))).status).toBe(200);
    expect((await json(await handler(req("/prototypes/figma-proto/draft")))).figma).toEqual(figmaA);

    // Publishing the head revision preserves figma on the immutable version read-back.
    expect((await handler(req("/prototypes/figma-proto/publish", "POST", { baseRev: 3 }))).status).toBe(201);
    expect((await json(await handler(req("/prototypes/figma-proto/versions/1")))).figma).toEqual(figmaA);
    db.close();
  });

  test("validates referenceScreenshots against the asset registry and rejects strict violations", async () => {
    const { db, handler } = await setup();
    const doc = await helloDoc("figma-refs");
    const assetId = await uploadPng(handler);

    // Existing asset -> accepted.
    const ok = await handler(req("/prototypes", "POST", { doc, figma: { ...figmaA, referenceScreenshots: [assetId] } }));
    expect(ok.status).toBe(201);
    expect((await json(await handler(req("/prototypes/figma-refs/draft")))).figma).toMatchObject({ referenceScreenshots: [assetId] });

    // Missing asset -> 422 asset_not_found.
    const missing = await handler(req("/prototypes/figma-refs", "PUT", { doc, baseRev: 1, figma: { ...figmaA, referenceScreenshots: [`asset_${"0".repeat(64)}`] } }));
    expect(missing.status).toBe(422);
    expect((await json(missing)).error).toMatchObject({ code: "asset_not_found" });

    // Malformed figma -> 422 validation_failed.
    const bad = await handler(req("/prototypes/figma-refs", "PUT", { doc, baseRev: 1, figma: { fileKey: "bad key!", nodeIds: [] } }));
    expect(bad.status).toBe(422);
    expect((await json(bad)).error).toMatchObject({ code: "validation_failed" });
    db.close();
  });
});

describe("figma provenance — components", () => {
  test("saves, reads back, restores and publishes figma", async () => {
    const { db, handler } = await setup();
    const source = await Bun.file("server/fixtures/rating-stars.tsx").text();
    expect((await handler(req("/components", "POST", {designSystem:"yandex-pay", id: "figma-stars", name: "FigmaStars", source, figma: figmaA }))).status).toBe(201);

    expect((await json(await handler(req("/components/figma-stars")))).figma).toEqual(figmaA);
    expect((await json(await handler(req("/components/figma-stars/source")))).figma).toEqual(figmaA);
    expect((await json(await handler(req("/components/figma-stars/draft")))).figma).toEqual(figmaA);

    // Publish rev 1 -> version read-back keeps figma.
    expect((await handler(req("/components/figma-stars/publish", "POST", { baseRev: 1 }))).status).toBe(201);
    expect((await json(await handler(req("/components/figma-stars/versions/1")))).figma).toEqual(figmaA);

    // A figma-only PUT creates a new revision (source unchanged) with the new link.
    expect((await handler(req("/components/figma-stars", "PUT", { baseRev: 1, figma: figmaB }))).status).toBe(200);
    expect((await json(await handler(req("/components/figma-stars/draft")))).figma).toEqual(figmaB);
    expect((await json(await handler(req("/components/figma-stars/revisions/1")))).figma).toEqual(figmaA);

    // Restore rev 1 copies figmaA onto the new head revision.
    expect((await handler(req("/components/figma-stars/restore", "POST", { rev: 1, baseRev: 2 }))).status).toBe(200);
    expect((await json(await handler(req("/components/figma-stars/draft")))).figma).toEqual(figmaA);
    db.close();
  });

  test("validates component referenceScreenshots and rejects malformed figma", async () => {
    const { db, handler } = await setup();
    const source = await Bun.file("server/fixtures/rating-stars.tsx").text();
    const missing = await handler(req("/components", "POST", {designSystem:"yandex-pay", id: "figma-bad", name: "FigmaBad", source, figma: { ...figmaA, referenceScreenshots: [`asset_${"0".repeat(64)}`] } }));
    expect(missing.status).toBe(422);
    expect((await json(missing)).error).toMatchObject({ code: "asset_not_found" });

    const bad = await handler(req("/components", "POST", {designSystem:"yandex-pay", id: "figma-bad2", name: "FigmaBad2", source, figma: { fileKey: "x", nodeIds: ["ok"], extra: true } }));
    expect(bad.status).toBe(422);
    expect((await json(bad)).error).toMatchObject({ code: "validation_failed" });
    db.close();
  });
});
