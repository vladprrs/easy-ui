import { createTestHandler } from "./test-auth";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { openDatabase } from "./db";
import { prototypeDocSchema } from "../src/prototype/schema";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function setup() {
  const dir = await mkdtemp(resolve(process.cwd(), ".assets-test-"));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  return { dir, db, handler: createTestHandler(db, { dataDir: dir }) };
}

// --- Minimal, header-accurate byte fixtures (the validator decodes headers, not full images). ---
type Bytes = Uint8Array<ArrayBuffer>;
function png(width = 1, height = 1): Bytes {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8); // length + "IHDR"
  new DataView(b.buffer).setUint32(16, width, false);
  new DataView(b.buffer).setUint32(20, height, false);
  return b;
}
function gif(width = 2, height = 3): Bytes {
  const b = new Uint8Array(13);
  b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // GIF89a
  new DataView(b.buffer).setUint16(6, width, true);
  new DataView(b.buffer).setUint16(8, height, true);
  return b;
}
function jpeg(width = 4, height = 5): Bytes {
  const b = new Uint8Array(20);
  b.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08], 0); // SOI + SOF0 + length + precision
  new DataView(b.buffer).setUint16(7, height, false);
  new DataView(b.buffer).setUint16(9, width, false);
  return b;
}
function webpLossy(width = 6, height = 7): Bytes {
  const b = new Uint8Array(30);
  b.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  b.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  b.set([0x56, 0x50, 0x38, 0x20], 12); // "VP8 "
  b.set([0x9d, 0x01, 0x2a], 23);
  new DataView(b.buffer).setUint16(26, width, true);
  new DataView(b.buffer).setUint16(28, height, true);
  return b;
}
const enc = (s: string): Bytes => { const e = new TextEncoder().encode(s); const out = new Uint8Array(e.length); out.set(e); return out; };
const svg = () => enc('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
const woff2 = () => { const b = new Uint8Array(16); b.set([0x77, 0x4f, 0x46, 0x32], 0); return b; };
const ttf = () => { const b = new Uint8Array(16); b.set([0x00, 0x01, 0x00, 0x00], 0); return b; };
const otf = () => { const b = new Uint8Array(16); b.set([0x4f, 0x54, 0x54, 0x4f], 0); return b; };

const upload = (bytes: Bytes, mime: string) => new Request("http://test/api/assets", { method: "POST", headers: { "content-type": mime }, body: bytes });
const proto = (url: string, method = "GET", value?: unknown) => new Request(`http://test/api${url}`, { method, headers: value ? { "content-type": "application/json" } : undefined, body: value ? JSON.stringify(value) : undefined });
async function helloDoc(id: string) { const o = prototypeDocSchema.parse(await Bun.file("prototypes/hello-world.json").json()); return { ...o, id, name: id }; }
function withImage(doc: Awaited<ReturnType<typeof helloDoc>>, src: unknown) {
  return { ...doc, screens: doc.screens.map((s, i) => i ? s : { ...s, spec: { root: "img", elements: { img: { type: "Image", props: { src, alt: "logo" } } } } }) };
}

describe("POST /api/assets", () => {
  test("stores each supported format and echoes content-addressed metadata", async () => {
    const { db, handler } = await setup();
    const cases: [Bytes, string, number | undefined, number | undefined][] = [
      [png(10, 20), "image/png", 10, 20],
      [gif(2, 3), "image/gif", 2, 3],
      [jpeg(4, 5), "image/jpeg", 4, 5],
      [webpLossy(6, 7), "image/webp", 6, 7],
      [svg(), "image/svg+xml", undefined, undefined],
      [woff2(), "font/woff2", undefined, undefined],
      [ttf(), "font/ttf", undefined, undefined],
      [otf(), "font/otf", undefined, undefined],
    ];
    for (const [bytes, mime, w, h] of cases) {
      const r = await handler(upload(bytes, mime));
      expect(r.status).toBe(201);
      const body = await r.json() as { id: string; sha256: string; mime: string; size: number; url: string; width?: number; height?: number };
      expect(body.id).toBe(`asset_${body.sha256}`);
      expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(body.mime).toBe(mime);
      expect(body.size).toBe(bytes.byteLength);
      expect(body.url).toBe(`/api/assets/${body.id}`);
      expect(body.width).toBe(w);
      expect(body.height).toBe(h);
    }
    db.close();
  });

  test("deduplicates identical bytes with a 200 and does not create a second row", async () => {
    const { db, handler } = await setup();
    const first = await handler(upload(png(3, 3), "image/png"));
    expect(first.status).toBe(201);
    const id = (await first.json() as { id: string }).id;
    const second = await handler(upload(png(3, 3), "image/png"));
    expect(second.status).toBe(200);
    const body = await second.json() as { id: string; deduplicated: boolean };
    expect(body.id).toBe(id);
    expect(body.deduplicated).toBe(true);
    expect(db.query("SELECT COUNT(*) c FROM assets").get()).toEqual({ c: 1 });
    db.close();
  });

  test("accepts a single-file multipart upload", async () => {
    const { db, handler } = await setup();
    const form = new FormData();
    form.set("file", new Blob([png(8, 8)], { type: "image/png" }), "logo.png");
    const r = await handler(new Request("http://test/api/assets", { method: "POST", body: form }));
    expect(r.status).toBe(201);
    expect((await r.json() as { mime: string }).mime).toBe("image/png");
    db.close();
  });

  test("rejects a declared/actual mime mismatch with 422", async () => {
    const { db, handler } = await setup();
    const r = await handler(upload(gif(), "image/png"));
    expect(r.status).toBe(422);
    expect((await r.json() as { error: { code: string } }).error.code).toBe("asset_type_mismatch");
    db.close();
  });

  test("rejects an unsupported declared type with 422", async () => {
    const { db, handler } = await setup();
    const r = await handler(upload(png(), "application/pdf"));
    expect(r.status).toBe(422);
    expect((await r.json() as { error: { code: string } }).error.code).toBe("unsupported_asset_type");
    db.close();
  });

  test("rejects a decompression-bomb raster over 16 Mpx with 413", async () => {
    const { db, handler } = await setup();
    const r = await handler(upload(png(5000, 4000), "image/png"));
    expect(r.status).toBe(413);
    expect((await r.json() as { error: { code: string } }).error.code).toBe("asset_too_large");
    db.close();
  });

  test("rejects an upload over 5 MiB with 413", async () => {
    const { db, handler } = await setup();
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const r = await handler(upload(big, "image/png"));
    expect(r.status).toBe(413);
    db.close();
  });
});

describe("GET /api/assets/:id", () => {
  test("serves bytes with immutable caching and hardened inert headers", async () => {
    const { db, handler } = await setup();
    const id = (await (await handler(upload(png(4, 4), "image/png"))).json() as { id: string }).id;
    const r = await handler(new Request(`http://test/api/assets/${id}`));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(r.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(png(4, 4));
    db.close();
  });

  test("returns 404 for a missing asset", async () => {
    const { db, handler } = await setup();
    const r = await handler(new Request(`http://test/api/assets/asset_${"0".repeat(64)}`));
    expect(r.status).toBe(404);
    expect((await r.json() as { error: { code: string } }).error.code).toBe("asset_not_found");
    db.close();
  });
});

describe("GET /api/assets", () => {
  test("returns an empty first page", async () => {
    const { db, handler } = await setup();
    const r = await handler(new Request("http://test/api/assets"));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ assets: [], nextCursor: null });
    db.close();
  });

  test("paginates three limit-2 pages deterministically when created_at values are equal", async () => {
    const { db, handler } = await setup();
    const ids: string[] = [];
    for (let size = 1; size <= 6; size += 1) {
      ids.push((await (await handler(upload(png(size, size), "image/png"))).json() as { id: string }).id);
    }
    db.run("UPDATE assets SET created_at='2026-07-15T12:00:00.000Z'");
    const expected = [...ids].sort().reverse();
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < 3; pageNumber += 1) {
      const query = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : "?limit=2";
      const r = await handler(new Request(`http://test/api/assets${query}`));
      expect(r.status).toBe(200);
      const body = await r.json() as { assets: { id: string; createdAt: string; usage: Record<string, number> }[]; nextCursor: string | null };
      expect(body.assets.map((asset) => asset.id)).toEqual(expected.slice(pageNumber * 2, pageNumber * 2 + 2));
      expect(body.assets.every((asset) => asset.createdAt === "2026-07-15T12:00:00.000Z")).toBe(true);
      expect(body.assets.every((asset) => Object.values(asset.usage).every((count) => count === 0))).toBe(true);
      seen.push(...body.assets.map((asset) => asset.id));
      cursor = body.nextCursor;
      expect(cursor).toBe(pageNumber < 2 ? `2026-07-15T12:00:00.000Z~${body.assets[1]!.id}` : null);
    }
    expect(seen).toEqual(expected);
    db.close();
  });

  test("rejects malformed and SQL-like cursors without interpolating them", async () => {
    const { db, handler } = await setup();
    const cursors = [
      "not-a-cursor",
      `2026-07-15T12:00:00.000Z~asset_${"a".repeat(63)}`,
      `2026-99-99T12:00:00.000Z~asset_${"a".repeat(64)}`,
      `2026-07-15T12:00:00.000Z~asset_${"a".repeat(64)}' OR 1=1 --`,
      "x".repeat(129),
    ];
    for (const cursor of cursors) {
      const r = await handler(new Request(`http://test/api/assets?cursor=${encodeURIComponent(cursor)}`));
      expect(r.status).toBe(400);
      expect((await r.json() as { error: { code: string } }).error.code).toBe("invalid_cursor");
    }
    db.close();
  });

  test("rejects an out-of-range limit through the validated query contract", async () => {
    const { db, handler } = await setup();
    const r = await handler(new Request("http://test/api/assets?limit=201"));
    expect(r.status).toBe(422);
    expect((await r.json() as { error: { code: string } }).error.code).toBe("validation_failed");
    db.close();
  });
});

describe("GET /api/assets/:id/usage", () => {
  test("reports every hard pin and retains tombstoned visual references", async () => {
    const { db, handler } = await setup();
    const asset = await (await handler(upload(png(17, 17), "image/png"))).json() as { id: string };

    const doc = withImage(await helloDoc("usage-proto"), { $asset: asset.id });
    expect((await handler(proto("/prototypes", "POST", { doc }))).status).toBe(201);

    const source = `import { z } from "zod";\nimport type { BaseComponentProps } from "@json-render/react";\nexport const definition = { props: z.strictObject({}), events: [], slots: [], description: "Usage", example: {} };\nexport default function Usage() { return <img src="/api/assets/${asset.id}" alt="usage" />; }\n`;
    expect((await handler(proto("/components", "POST", { id: "usage-component", name: "UsageComponent", source }))).status).toBe(201);
    expect((await handler(proto("/components/usage-component/publish", "POST", { baseRev: 1 }))).status).toBe(201);

    const fingerprint = {
      scope: "prototype-screen", prototypeId: "usage-proto", screenId: doc.screens[0]!.id, refRevision: 1,
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, theme: "light",
    };
    const put = await handler(proto("/visual-references", "PUT", { fingerprint, assetId: asset.id }));
    expect(put.status).toBe(200);
    const referenceId = (await put.json() as { id: string }).id;
    db.run(`INSERT INTO visual_runs
      (id,reference_id,reference_asset_id,candidate_asset_id,diff_asset_id,status,created_at)
      VALUES ('vrun_usage',?,?,?,?,?,'2026-07-15T12:00:00.000Z')`, [referenceId, asset.id, asset.id, asset.id, "fail"]);
    expect((await handler(proto(`/visual-references/${referenceId}`, "DELETE"))).status).toBe(204);

    const list = await (await handler(new Request("http://test/api/assets"))).json() as { assets: { id: string; usage: Record<string, number> }[] };
    expect(list.assets.find((item) => item.id === asset.id)?.usage).toEqual({ prototypes: 1, components: 1, visualReferences: 1, visualRuns: 3 });

    const r = await handler(new Request(`http://test/api/assets/${asset.id}/usage`));
    expect(r.status).toBe(200);
    const body = await r.json() as Record<string, unknown>;
    expect(body.prototypes).toEqual([{ id: "usage-proto", name: "usage-proto", revCount: 1, lastRev: 1, pinnedAtHead: true }]);
    expect(body.components).toEqual([{ id: "usage-component", name: "UsageComponent", versions: [1] }]);
    expect(body.visualReferences).toEqual([{ id: referenceId, deleted: true }]);
    expect(body.visualRuns).toEqual([
      { id: "vrun_usage", referenceId, role: "candidate" },
      { id: "vrun_usage", referenceId, role: "diff" },
      { id: "vrun_usage", referenceId, role: "reference" },
    ]);
    db.close();
  }, 30_000);

  test("returns asset_not_found for a missing asset", async () => {
    const { db, handler } = await setup();
    const r = await handler(new Request(`http://test/api/assets/asset_${"0".repeat(64)}/usage`));
    expect(r.status).toBe(404);
    expect((await r.json() as { error: { code: string } }).error.code).toBe("asset_not_found");
    db.close();
  });

  test("validates the asset id path parameter", async () => {
    const { db, handler } = await setup();
    const r = await handler(new Request("http://test/api/assets/not-an-asset/usage"));
    expect(r.status).toBe(422);
    expect((await r.json() as { error: { code: string } }).error.code).toBe("validation_failed");
    db.close();
  });
});

describe("$asset references in prototypes", () => {
  test("saves a document referencing an existing asset and pins it, exposing read-back assets", async () => {
    const { db, handler } = await setup();
    const asset = await (await handler(upload(png(12, 12), "image/png"))).json() as { id: string; sha256: string; mime: string; size: number };
    const doc = withImage(await helloDoc("asset-proto"), { $asset: asset.id });
    expect((await handler(proto("/prototypes", "POST", { doc }))).status).toBe(201);
    const draft = await (await handler(proto("/prototypes/asset-proto/draft"))).json() as { assets: { id: string; sha256: string; mime: string; size: number }[] };
    expect(draft.assets).toEqual([{ id: asset.id, sha256: asset.sha256, mime: asset.mime, size: asset.size }]);
    expect(db.query("SELECT COUNT(*) c FROM prototype_revision_assets WHERE prototype_id='asset-proto'").get()).toEqual({ c: 1 });
    db.close();
  });

  test("rejects a document referencing a non-existent asset with 422 asset_not_found", async () => {
    const { db, handler } = await setup();
    const doc = withImage(await helloDoc("asset-missing"), { $asset: `asset_${"a".repeat(64)}` });
    const r = await handler(proto("/prototypes", "POST", { doc }));
    expect(r.status).toBe(422);
    expect((await r.json() as { error: { code: string } }).error.code).toBe("asset_not_found");
    db.close();
  });

  test("copies asset pins when restoring an earlier revision", async () => {
    const { db, handler } = await setup();
    const asset = await (await handler(upload(png(9, 9), "image/png"))).json() as { id: string };
    const hello = await helloDoc("asset-restore");
    expect((await handler(proto("/prototypes", "POST", { doc: withImage(hello, { $asset: asset.id }) }))).status).toBe(201);
    // rev 2: drop the asset reference.
    expect((await handler(proto("/prototypes/asset-restore", "PUT", { baseRev: 1, doc: withImage(hello, "/static/logo.png") }))).status).toBe(200);
    expect(db.query("SELECT COUNT(*) c FROM prototype_revision_assets WHERE prototype_id='asset-restore' AND rev=2").get()).toEqual({ c: 0 });
    // restore rev 1 -> rev 3 must re-pin the asset.
    expect((await handler(proto("/prototypes/asset-restore/restore", "POST", { rev: 1, baseRev: 2 }))).status).toBe(200);
    expect(db.query("SELECT COUNT(*) c FROM prototype_revision_assets WHERE prototype_id='asset-restore' AND rev=3").get()).toEqual({ c: 1 });
    db.close();
  });
});

describe("component asset pins on publish", () => {
  test("scans source for /api/assets literals, pins them, and shows read-back assets", async () => {
    const { db, handler } = await setup();
    const asset = await (await handler(upload(png(16, 16), "image/png"))).json() as { id: string; sha256: string; mime: string; size: number };
    const source = `import { z } from "zod";\nimport type { BaseComponentProps } from "@json-render/react";\nexport const definition = { props: z.strictObject({}), events: [], slots: [], description: "Logo", example: {} };\nexport default function Logo() { return <img src="/api/assets/${asset.id}" alt="logo" />; }\n`;
    expect((await handler(proto("/components", "POST", { id: "logo", name: "Logo", source }))).status).toBe(201);
    expect((await handler(proto("/components/logo/publish", "POST", { baseRev: 1 }))).status).toBe(201);
    expect(db.query("SELECT asset_id FROM component_publish_assets WHERE component_id='logo' AND version=1").get()).toEqual({ asset_id: asset.id });
    const version = await (await handler(proto("/components/logo/versions/1"))).json() as { assets: { id: string; sha256: string; mime: string; size: number }[] };
    expect(version.assets).toEqual([{ id: asset.id, sha256: asset.sha256, mime: asset.mime, size: asset.size }]);
    db.close();
  });

  test("rejects publishing a component referencing a non-existent asset with 422", async () => {
    const { db, handler } = await setup();
    const source = `import { z } from "zod";\nimport type { BaseComponentProps } from "@json-render/react";\nexport const definition = { props: z.strictObject({}), events: [], slots: [], description: "Logo", example: {} };\nexport default function Logo() { return <img src="/api/assets/asset_${"b".repeat(64)}" alt="logo" />; }\n`;
    expect((await handler(proto("/components", "POST", { id: "logo2", name: "Logo2", source }))).status).toBe(201);
    const r = await handler(proto("/components/logo2/publish", "POST", { baseRev: 1 }));
    expect(r.status).toBe(422);
    expect((await r.json() as { error: { code: string } }).error.code).toBe("asset_not_found");
    db.close();
  });
});
