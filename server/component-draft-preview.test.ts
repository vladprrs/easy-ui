import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createTestHandler } from "./test-auth";
import { openDatabase } from "./db";
import { createHandler } from "./main";
import { BOOTSTRAP_ADMIN_ID, UserRepo } from "./users";
import { sha256 } from "./components/pipeline";
import { candidatesRoot, getCandidateBundle } from "./components/candidates";
import { ScreenshotService, type RunJob } from "./screenshot/service";
import { matchAllowed } from "./screenshot/sessions";
import type { GeometryCollection } from "../src/capture/geometry.mjs";

// P1b (план 2026-08-02): draft-preview сохранённой head-ревизии через candidate-bundle P8
// (`POST /api/components/:id/head/screenshot`) + geometry-проба компонентной поверхности.
// Компонентный id `draft-stars` уникален для этого файла: import-кэши верификации живут
// в общем процессе `bun test` (см. component-validate.test.ts).

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

const ASSET_SHA = "d".repeat(64);
const ASSET_ID = `asset_${ASSET_SHA}`;
const PNG_1X1 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1]);

/** Драфт с именованным example и asset-ссылкой в JSX — упирается в оба новых пина allowlist'а. */
function draftSource(assetId: string) {
  return `import { z } from "zod";
export const definition = {
  props: z.strictObject({ label: z.string().default("draft") }),
  events: [], slots: [],
  description: "Draft preview probe component",
  atomicLevel: "atom" as const,
  examples: { full: { label: "from-example" } },
};
export default function DraftStars({ props }: any) {
  return <div><span>{props.label}</span><img src="/api/assets/${assetId}" alt="dot" /></div>;
}`;
}

async function setup(options: { validateDisabled?: boolean } = {}) {
  const dir = await mkdtemp(resolve(process.cwd(), ".draft-preview-test-"));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  const handler = createTestHandler(db, { dataDir: dir, ...options });
  return { dir, db, handler };
}

const req = (url: string, method = "GET", value?: unknown) =>
  new Request(`http://test/api${url}`, {
    method,
    headers: value ? { "content-type": "application/json" } : undefined,
    body: value ? JSON.stringify(value) : undefined,
  });

const neverResolves: RunJob = () => new Promise(() => {});
function makeService(db: Database, dir: string, runJob: RunJob = neverResolves) {
  return new ScreenshotService({ db, dataDir: dir, serveDist: "dist", captureOrigin: "http://127.0.0.1:8787", chromiumAvailable: true, runJob });
}

function seedAsset(db: Database) {
  db.run("INSERT INTO assets (id,sha256,mime,size,width,height,original_name,created_at) VALUES (?,?,?,?,?,?,?,?)",
    [ASSET_ID, ASSET_SHA, "image/png", PNG_1X1.length, 1, 1, "dot.png", "now"]);
}

/** Published-запись без реальной сборки (тот же каркас, что seedComponent в driver-cli.test.ts). */
function seedPublished(db: Database, id: string, name: string, ownerId: string = BOOTSTRAP_ADMIN_ID) {
  const definitionMeta = JSON.stringify({
    description: "seeded", events: [], slots: [],
    propsJsonSchema: { type: "object", properties: { label: { type: "string" } } },
    examples: { full: { label: "seeded" } },
  });
  db.query("INSERT INTO components (id,name,head_rev,design_system,deleted_at,owner_id,created_at,updated_at) VALUES (?,?,1,'yandex-pay',NULL,?,'now','now')").run(id, name, ownerId);
  db.query("INSERT INTO component_revisions (component_id,rev,source,design_system,created_at) VALUES (?,1,'export default null','yandex-pay','now')").run(id);
  db.query("INSERT INTO component_publishes (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,published_at) VALUES (?,1,1,'active','',?,'sh','bh',2,'now')").run(id, definitionMeta);
}

const createDraft = (handler: (r: Request) => Promise<Response>, source: string) =>
  handler(req("/components", "POST", {
    designSystem: "yandex-pay", id: "draft-stars", name: "DraftStars", source,
    intent: "Shows a draft preview probe label next to a pinned image dot",
  }));

async function waitDone(service: ScreenshotService, jobId: string) {
  for (let i = 0; i < 300; i++) {
    const status = service.get(jobId);
    if (status.status === "done" || status.status === "error") return status;
    await Bun.sleep(10);
  }
  return service.get(jobId);
}

const imageOk = { ok: true as const, pngBase64: Buffer.from(PNG_1X1).toString("base64"), width: 1, height: 1, consoleErrors: [], pageErrors: [], browserVersion: "test/1" };
const imageStub: RunJob = async () => imageOk;
const geometryShape: GeometryCollection = {
  rects: [{ key: "root", instance: 0, domIndex: 0, x: 1, y: 2, width: 10, height: 20, layoutContext: null }],
  truncated: false, total: 1,
  safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
  roleRects: {},
  frame: { x: 0, y: 0, width: 320, height: 200, source: "surface" },
  content: { x: 0, y: 0, width: 320, height: 200 },
  scroll: { width: 320, height: 200 },
  viewportOwnership: { frame: { width: 320, height: 200 }, content: { width: 320, height: 200 }, scroll: { width: 320, height: 200 }, scrollable: false, owners: [], unownedPct: 0 },
  issues: [],
};

describe("component draft preview (P1b)", () => {
  test("shoots the saved head through a candidate bundle: image, geometry probe, allowlist pins", async () => {
    const { dir, db, handler: h } = await setup();
    seedAsset(db);
    const source = draftSource(ASSET_ID);
    expect((await createDraft(h, source)).status).toBe(201);
    const sourceHash = sha256(source);

    const jobs: Parameters<RunJob>[0][] = [];
    const runJob: RunJob = async (job) => {
      jobs.push(job);
      if (job.probe === "geometry") return { ok: true, geometry: geometryShape, consoleErrors: [], pageErrors: [], browserVersion: "test/geometry" };
      return imageOk;
    };
    const service = makeService(db, dir, runJob);
    const handler = createTestHandler(db, { dataDir: dir, screenshots: service });

    // --- image-проба по именованному example (холодный кэш: сборка кандидата в постановке) ---
    const accepted = await handler(req("/components/draft-stars/head/screenshot", "POST", { viewport: { width: 320, height: 200 }, exampleName: "full" }));
    expect(accepted.status).toBe(202);
    const { jobId } = await accepted.json() as { jobId: string };
    const final = await waitDone(service, jobId);
    expect(final.status).toBe("done");
    expect(final.result).toMatchObject({ kind: "image", draftRev: 1, bundleHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    if (final.result?.kind !== "image") throw new Error("expected image result");
    const bundleHash = final.result.bundleHash!;

    const workerJob = jobs[0]!;
    expect(workerJob.captureUrl).toBe("/capture/component/draft-stars/draft?theme=light&dsf=1");
    expect(workerJob.bootstrap).toMatchObject({
      kind: "component-draft",
      target: {
        kind: "component-draft", componentId: "draft-stars", rev: 1, name: "DraftStars",
        designSystem: "yandex-pay", bundleUrl: `/api/components/draft-stars/draft/${sourceHash}/bundle.js`,
      },
      props: { label: "from-example" },
      examples: { full: { label: "from-example" } },
    });
    expect(workerJob.bootstrap.propsJsonSchema).toMatchObject({ type: "object" });
    expect(workerJob.expected).toMatchObject({
      kind: "component-draft", componentId: "draft-stars", rev: 1, sourceHash, bundleHash,
      propsHash: expect.stringMatching(/^[0-9a-f]{64}$/), dsMetaVersion: null,
    });

    // Allowlist: candidate-bundle — точным content-addressed путём; published-DTO драфту не нужны.
    const allowed = workerJob.allowedUrls;
    expect(allowed).toContain("/capture/component/draft-stars/draft");
    expect(allowed).toContain(`/api/components/draft-stars/draft/${sourceHash}/bundle.js`);
    expect(allowed).toContain(`/api/assets/${ASSET_ID}`);
    expect(allowed).toContain("/api/design-systems/yandex-pay");
    expect(allowed).toContain("/api/shims/");
    expect(allowed).not.toContain("/api/components/draft-stars");
    expect(allowed.some((u) => u.startsWith("/api/components/draft-stars/versions"))).toBe(false);

    // Candidate-bundle отдаётся по content-addressed URL.
    const bundle = await handler(req(`/components/draft-stars/draft/${sourceHash}/bundle.js`));
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get("content-type")).toContain("text/javascript");

    // --- geometry-проба той же головы (кандидат уже в кэше — без пересборки) ---
    const acceptedGeo = await handler(req("/components/draft-stars/head/screenshot", "POST", { viewport: { width: 320, height: 200 }, probe: "geometry" }));
    expect(acceptedGeo.status).toBe(202);
    const geoJobId = (await acceptedGeo.json() as { jobId: string }).jobId;
    const finalGeo = await waitDone(service, geoJobId);
    expect(finalGeo.status).toBe("done");
    expect(finalGeo.result).toMatchObject({
      kind: "geometry", surface: "component", componentId: "draft-stars", draftRev: 1, bundleHash,
      designSystemMetaVersion: null, resolvedSpaceScale: { md: "12px" },
      viewport: { width: 320, height: 200 }, dpr: 1,
      rects: [{ key: "root", width: 10, height: 20 }], truncated: false, total: 1,
    });
    expect(finalGeo.result).not.toHaveProperty("version");
    const workerGeo = jobs[1]!;
    expect(workerGeo).toMatchObject({ probe: "geometry", geometryLimit: 2000 });
    expect(workerGeo.geometryRoleKeys).toBeUndefined();

    // --- дешёвые отказы на тёплом кэше ---
    const unknownExample = await handler(req("/components/draft-stars/head/screenshot", "POST", { viewport: { width: 320, height: 200 }, exampleName: "nope" }));
    expect(unknownExample.status).toBe(422);
    expect(await unknownExample.json()).toMatchObject({ error: { code: "unknown_example" } });
    const invalidProps = await handler(req("/components/draft-stars/head/screenshot", "POST", { viewport: { width: 320, height: 200 }, props: { label: 42 } }));
    expect(invalidProps.status).toBe(422);
    expect(await invalidProps.json()).toMatchObject({ error: { code: "invalid_props" } });
    db.close();
  }, 90000);

  test("rebuilds the candidate itself after GC wiped the cache", async () => {
    const { dir, db, handler: h } = await setup();
    seedAsset(db);
    const source = draftSource(ASSET_ID);
    expect((await createDraft(h, source)).status).toBe(201);
    const sourceHash = sha256(source);
    const service = makeService(db, dir, imageStub);
    const handler = createTestHandler(db, { dataDir: dir, screenshots: service });

    const first = await handler(req("/components/draft-stars/head/screenshot", "POST", { viewport: { width: 320, height: 200 } }));
    expect(first.status).toBe(202);
    expect((await waitDone(service, (await first.json() as { jobId: string }).jobId)).status).toBe("done");

    // GC/потеря кэша: превью обязано собрать кандидата само, без явного validate.
    await rm(candidatesRoot(dir), { recursive: true, force: true });
    expect(await getCandidateBundle(dir, "draft-stars", sourceHash)).toBeNull();

    const second = await handler(req("/components/draft-stars/head/screenshot", "POST", { viewport: { width: 320, height: 200 } }));
    expect(second.status).toBe(202);
    const secondJob = (await second.json() as { jobId: string }).jobId;
    expect((await waitDone(service, secondJob)).status).toBe("done");
    expect((await handler(req(`/components/draft-stars/draft/${sourceHash}/bundle.js`))).status).toBe(200);
    db.close();
  }, 120000);

  test("candidate bundle url stays scoped to the enqueueing draft job and out of the catalog", async () => {
    const { dir, db, handler } = await setup();
    seedAsset(db);
    const source = draftSource(ASSET_ID);
    expect((await createDraft(handler, source)).status).toBe(201);
    const sourceHash = sha256(source);
    seedPublished(db, "published-card", "PublishedCard");

    // Джобы не завершаются (neverResolves) — читаем замороженные снапшоты из очереди.
    const service = makeService(db, dir);
    const { jobId: jobA } = await service.enqueueComponentDraft("draft-stars", BOOTSTRAP_ADMIN_ID, { viewport: { width: 320, height: 200 } });
    const { jobId: jobB } = service.enqueueComponent("published-card", 1, { viewport: { width: 390, height: 844 } });
    const a = service.peek(jobA)!, b = service.peek(jobB)!;
    const candidatePath = `/api/components/draft-stars/draft/${sourceHash}/bundle.js`;

    expect(matchAllowed(candidatePath, a.allowedUrls)).toBe(true);
    expect(matchAllowed(candidatePath, b.allowedUrls)).toBe(false);
    expect(b.allowedUrls).toContain("/api/components/published-card/versions/1/bundle.js");
    expect(matchAllowed("/api/components/published-card/versions/1/bundle.js", a.allowedUrls)).toBe(false);

    // Валидный, но чужой sourceHash → 404; правильный hash под чужим componentId → 404.
    expect((await handler(req(`/components/draft-stars/draft/${"e".repeat(64)}/bundle.js`))).status).toBe(404);
    expect((await handler(req(`/components/published-card/draft/${sourceHash}/bundle.js`))).status).toBe(404);

    // Каталог собирается из publishes — эфемерный candidate URL туда не протекает.
    const manifest = await handler(req("/catalog/manifest?designSystem=yandex-pay"));
    expect(manifest.status).toBe(200);
    expect(JSON.stringify(await manifest.json())).not.toContain("/draft/");
    db.close();
  }, 90000);

  test("component screenshot job re-checks component ownership on read", async () => {
    const dir = await mkdtemp(resolve(process.cwd(), ".draft-preview-test-"));
    dirs.push(dir);
    const db = openDatabase(":memory:");
    const at = new Date().toISOString();
    db.query("INSERT INTO users (id,name,password_hash,is_admin,created_at) VALUES (?,?,?,?,?),(?,?,?,?,?)")
      .run("user_alice", "Alice", "unused", 0, at, "user_bob", "Bob", "unused", 0, at);
    const users = new UserRepo(db);
    const alice = users.createSession("user_alice").token, bob = users.createSession("user_bob").token;
    seedPublished(db, "alice-card", "AliceCard", "user_alice");

    const service = makeService(db, dir);
    const { jobId } = service.enqueueComponent("alice-card", 1, { viewport: { width: 390, height: 844 } });
    const handler = createHandler(db, { dataDir: dir, screenshots: service, publicOrigin: "http://test" });
    const as = (token: string) => handler(new Request(`http://test/api/screenshot-jobs/${jobId}`, { headers: { cookie: `easyui_session=${token}` } }));

    const denied = await as(bob);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: "forbidden" } });
    expect((await as(alice)).status).toBe(200);
    db.close();
  }, 10000);

  test("geometry probe works on a published component version; unknown probe modes are rejected", async () => {
    const { dir, db } = await setup();
    seedPublished(db, "pub-geom", "PubGeom");
    const jobs: Parameters<RunJob>[0][] = [];
    const runJob: RunJob = async (job) => { jobs.push(job); return { ok: true, geometry: geometryShape, consoleErrors: [], pageErrors: [], browserVersion: "test/geometry" }; };
    const service = makeService(db, dir, runJob);
    const handler = createTestHandler(db, { dataDir: dir, screenshots: service });

    const accepted = await handler(req("/components/pub-geom/versions/1/screenshot", "POST", { viewport: { width: 320, height: 200 }, probe: "geometry" }));
    expect(accepted.status).toBe(202);
    const { jobId } = await accepted.json() as { jobId: string };
    const final = await waitDone(service, jobId);
    expect(final.status).toBe("done");
    expect(final.result).toMatchObject({
      kind: "geometry", surface: "component", componentId: "pub-geom", version: 1, bundleHash: "bh",
      designSystemMetaVersion: null, resolvedSpaceScale: { md: "12px" },
      viewport: { width: 320, height: 200 }, dpr: 1,
    });
    expect(final.result).not.toHaveProperty("draftRev");
    expect(jobs[0]).toMatchObject({ probe: "geometry", geometryLimit: 2000 });
    expect(jobs[0]!.geometryRoleKeys).toBeUndefined();

    const badPublished = await handler(req("/components/pub-geom/versions/1/screenshot", "POST", { viewport: { width: 320, height: 200 }, probe: "pixels" }));
    expect(badPublished.status).toBe(400);
    expect(await badPublished.json()).toMatchObject({ error: { code: "invalid_request" } });
    // Режемся на валидации тела — до постановки и сборки кандидата.
    const badDraft = await handler(req("/components/pub-geom/head/screenshot", "POST", { viewport: { width: 320, height: 200 }, probe: "pixels" }));
    expect(badDraft.status).toBe(400);
    expect(await badDraft.json()).toMatchObject({ error: { code: "invalid_request" } });
    db.close();
  }, 10000);

  test("kill-switch hides the draft route and drops the capability feature", async () => {
    const { dir, db, handler: h } = await setup({ validateDisabled: true });
    seedAsset(db);
    expect((await createDraft(h, draftSource(ASSET_ID))).status).toBe(201);
    const service = makeService(db, dir);
    const handler = createTestHandler(db, { dataDir: dir, screenshots: service, validateDisabled: true });

    const response = await handler(req("/components/draft-stars/head/screenshot", "POST", { viewport: { width: 320, height: 200 } }));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });

    const caps = await (await handler(req("/capabilities"))).json() as { features: Record<string, boolean> };
    expect(caps.features.componentDraftPreview).toBe(false);
    expect(caps.features.componentGeometry).toBe(true);
    db.close();
  }, 30000);
});
