import { createTestHandler } from "./test-auth";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { openDatabase } from "./db";
import { createHandler } from "./main";
import { prototypeDocSchema } from "../src/prototype/schema";
import { declaredFontFaces, fontManifestOf, geometryRoleKeysOf, isTerminalJobOutcome, ScreenshotService, themeAssetIds, validatePropsAgainstSchema, type RunJob, type WorkerResult } from "./screenshot/service";
import { classifyCaptureErrors, isInfraNoise } from "./screenshot/noise";
import { CaptureSessionStore, isLoopbackAddress, matchAllowed } from "./screenshot/sessions";
import { buildStaticAllowedUrls, rendererBuildFrom } from "./screenshot/allowedUrls";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function helloDoc(id: string) {
  const original = prototypeDocSchema.parse(await Bun.file("test/fixtures/host-content.json").json());
  return { ...original, id, name: id };
}
async function setup() {
  const dir = await mkdtemp(resolve(process.cwd(), ".screenshot-test-"));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  const handler = createTestHandler(db, { dataDir: dir });
  return { dir, db, handler };
}
const req = (url: string, method = "GET", value?: unknown) =>
  new Request(`http://test/api${url}`, { method, headers: value ? { "content-type": "application/json" } : undefined, body: value ? JSON.stringify(value) : undefined });

const neverResolves: RunJob = () => new Promise<WorkerResult>(() => {});
function makeService(db: Parameters<typeof createHandler>[0], dir: string, runJob: RunJob = neverResolves, now?: () => number) {
  return new ScreenshotService({ db, dataDir: dir, serveDist: "dist", captureOrigin: "http://127.0.0.1:8787", chromiumAvailable: true, runJob, now });
}

describe("screenshot job API", () => {
  test("501 when the service is unavailable (no dist/chromium)", async () => {
    const { handler } = await setup();
    const response = await handler(req("/prototypes/x/screens/welcome/screenshot", "POST", { viewport: { width: 390, height: 844 } }));
    expect(response.status).toBe(501);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("screenshot_unavailable");
  });

  test("bounds are rejected with 422", async () => {
    const { db, dir } = await setup();
    const service = makeService(db, dir);
    const handler = createTestHandler(db, { dataDir: dir, screenshots: service });
    expect((await handler(req("/prototypes", "POST", { doc: await helloDoc("b1") }))).status).toBe(201);
    const bad = async (viewport: unknown, dsf?: number) => (await handler(req("/prototypes/b1/screens/welcome/screenshot", "POST", { viewport, deviceScaleFactor: dsf }))).status;
    expect(await bad({ width: 10, height: 844 })).toBe(422); // width too small
    expect(await bad({ width: 3000, height: 844 })).toBe(422); // width too big
    expect(await bad({ width: 390, height: 5000 })).toBe(422); // height too big
    expect(await bad({ width: 390, height: 844 }, 4)).toBe(422); // dsf out of set
    expect(await bad({ width: 2000, height: 4000 }, 2)).toBe(422); // > 20 Mpx
  });

  test("queue caps at 5 with 429 beyond it", async () => {
    const { db, dir } = await setup();
    const service = makeService(db, dir);
    const handler = createTestHandler(db, { dataDir: dir, screenshots: service });
    expect((await handler(req("/prototypes", "POST", { doc: await helloDoc("q1") }))).status).toBe(201);
    const enqueue = () => handler(req("/prototypes/q1/screens/welcome/screenshot", "POST", { viewport: { width: 390, height: 844 } }));
    for (let i = 0; i < 6; i++) expect((await enqueue()).status).toBe(202); // 1 running + 5 queued
    const overflow = await enqueue();
    expect(overflow.status).toBe(429);
    expect((await overflow.json() as { error: { code: string } }).error.code).toBe("queue_full");
  });

  test("target is snapshotted at enqueue and cannot move to a later head", async () => {
    const { db, dir, handler: h } = await setup();
    expect((await h(req("/prototypes", "POST", { doc: await helloDoc("snap") }))).status).toBe(201);
    const service = makeService(db, dir);
    const { jobId } = service.enqueuePrototype("snap", "welcome", { viewport: { width: 390, height: 844 } });
    expect(service.peek(jobId)?.expected).toMatchObject({ kind: "prototype", rev: 1, prototypeInstanceId:expect.any(String) });
    expect(service.peek(jobId)?.allowedUrls).toContain("/api/prototypes/snap/revisions/1");
    expect(service.peek(jobId)?.allowedUrls).not.toContain("/api/prototypes/");
    // Save a new revision; the queued job's frozen expected.rev must stay 1.
    const saved = await h(req("/prototypes/snap", "PUT", { doc: await helloDoc("snap"), baseRev: 1, message: "second" }));
    expect(saved.status).toBe(200);
    const expected = service.peek(jobId)?.expected;
    expect(expected).toMatchObject({ kind: "prototype", rev: 1 });
  });

  test("public screenshot HTTP response never exposes the frozen expected snapshot",async()=>{
    const {db,dir,handler:h}=await setup();
    expect((await h(req("/prototypes","POST",{doc:await helloDoc("public-shape")}))).status).toBe(201);
    const service=makeService(db,dir);const handler=createTestHandler(db,{dataDir:dir,screenshots:service});
    const response=await handler(req("/prototypes/public-shape/screens/welcome/screenshot","POST",{viewport:{width:390,height:844}}));
    expect(response.status).toBe(202);const body=await response.json() as Record<string,unknown>;
    // `components` — разрешённые пины (план 2026-08-02, P2.3): публичная часть снимка. Всё
    // остальное из frozen expected (manifest/catalog-хэши, allowedUrls, токен) наружу не едет.
    expect(Object.keys(body).sort()).toEqual(["components","jobId"]);
    expect(body.expected).toBeUndefined();expect(body.allowedUrls).toBeUndefined();
    expect(body.components).toEqual([]);
  });

  test("done result ingests the PNG into the asset registry", async () => {
    const { db, dir, handler: h } = await setup();
    expect((await h(req("/prototypes", "POST", { doc: await helloDoc("ok") }))).status).toBe(201);
    // 1x1 PNG.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1]);
    const runJob: RunJob = async () => ({ ok: true, pngBase64: Buffer.from(png).toString("base64"), width: 1, height: 1, consoleErrors: [], pageErrors: [], browserVersion: "test/1" });
    const service = makeService(db, dir, runJob);
    const { jobId } = service.enqueuePrototype("ok", "welcome", { viewport: { width: 390, height: 844 } });
    let status = service.get(jobId).status;
    for (let i = 0; i < 50 && status !== "done" && status !== "error"; i++) { await Bun.sleep(5); status = service.get(jobId).status; }
    const final = service.get(jobId);
    expect(final.status).toBe("done");
    expect(final.result?.kind).toBe("image");
    if (final.result?.kind !== "image") throw new Error("expected image result");
    expect(final.result.assetId.startsWith("asset_")).toBe(true);
    expect(final.result.imageUrl).toBe(`/api/assets/${final.result.assetId}`);
    expect(final.result.componentPins).toEqual([]);
  });

  /**
   * R3: типизированный исход воркера доезжает наружу — и в `failure` (причина по словарю E3), и в
   * `outcome` (таксономия джобы A3). Доволновое поле `error` остаётся на месте: клиенты, читающие
   * его, ничего не теряют.
   */
  test("typed worker failure surfaces as failure.code and outcome over HTTP", async () => {
    const { db, dir, handler: h } = await setup();
    expect((await h(req("/prototypes", "POST", { doc: await helloDoc("typed-failure") }))).status).toBe(201);
    const runJob: RunJob = async () => ({ ok: false, code: "surface_missing", error: "#eui-capture-surface is missing in the captured document" });
    const service = makeService(db, dir, runJob);
    const handler = createTestHandler(db, { dataDir: dir, screenshots: service });
    const { jobId } = service.enqueuePrototype("typed-failure", "welcome", { viewport: { width: 390, height: 844 } });
    let status = service.get(jobId).status;
    for (let i = 0; i < 50 && status !== "done" && status !== "error"; i++) { await Bun.sleep(5); status = service.get(jobId).status; }

    const response = await handler(req(`/screenshot-jobs/${jobId}`));
    expect(response.status).toBe(200);
    const body = await response.json() as { status: string; error?: { code: string }; failure?: { code: string; message: string }; outcome?: string };
    expect(body.status).toBe("error");
    expect(body.failure?.code).toBe("surface_missing");
    expect(body.failure?.message).toContain("#eui-capture-surface");
    expect(body.error?.code).toBe("surface_missing");
    // R4 (минор R3): отсутствие поверхности — **терминальный** исход, а не инфраструктурный шум.
    // До волны это ехало как `subprocess_error` и жгло `maxInfraRetries` приёмки на повторах,
    // которые дают ровно ту же пустую страницу.
    expect(body.outcome).toBe("surface_missing");
    expect(isTerminalJobOutcome("surface_missing")).toBe(true);
  });

  /** Нетипизированный отказ воркера остаётся доволновым `capture_failed` и `failure` не выдумывает. */
  test("an untyped worker failure keeps the pre-wave shape", async () => {
    const { db, dir, handler: h } = await setup();
    expect((await h(req("/prototypes", "POST", { doc: await helloDoc("untyped-failure") }))).status).toBe(201);
    const runJob: RunJob = async () => ({ ok: false, error: "worker produced no result: killed" });
    const service = makeService(db, dir, runJob);
    const { jobId } = service.enqueuePrototype("untyped-failure", "welcome", { viewport: { width: 390, height: 844 } });
    let status = service.get(jobId).status;
    for (let i = 0; i < 50 && status !== "done" && status !== "error"; i++) { await Bun.sleep(5); status = service.get(jobId).status; }
    const final = service.get(jobId);
    expect(final.error?.code).toBe("capture_failed");
    expect(final.failure).toBeUndefined();
    expect(final.outcome).toBe("worker_crash");
  });

  test("geometry probe returns metadata without ingesting a PNG asset", async () => {
    const { db, dir, handler: h } = await setup();
    expect((await h(req("/prototypes", "POST", { doc: await helloDoc("geometry") }))).status).toBe(201);
    let workerJob: Parameters<RunJob>[0] | undefined;
    const runJob: RunJob = async (job) => {
      workerJob = job;
      return { ok:true, geometry:{
        rects:[{key:"root",instance:0,domIndex:0,x:1.25,y:2.5,width:10,height:0,layoutContext:null}], truncated:false, total:1,
        safeArea:{top:0,right:0,bottom:0,left:0},
        roleRects:{ panel:{x:0,y:0,width:390,height:844,source:"key",key:"root"} },
        frame:{x:0,y:0,width:390,height:844,source:"surface"},
        content:{x:0,y:0,width:390,height:844},
        scroll:{width:390,height:844},
        viewportOwnership:{frame:{width:390,height:844},content:{width:390,height:844},scroll:{width:390,height:844},scrollable:false,owners:[{role:"panel",areaPct:100,heightPct:100}],unownedPct:0},
        issues:[{code:"footer-owns-page",severity:"warn",message:"footer owns the page",detail:{}}],
      }, consoleErrors:[], consoleWarnings:["slow render"], pageErrors:[], browserVersion:"test/geometry" };
    };
    const service = makeService(db, dir, runJob);
    const handler = createTestHandler(db, { dataDir:dir, screenshots:service });
    const accepted = await handler(req("/prototypes/geometry/screens/welcome/screenshot", "POST", { probe:"geometry", viewport:{width:390,height:844}, deviceScaleFactor:2 }));
    expect(accepted.status).toBe(202);
    const {jobId} = await accepted.json() as {jobId:string};
    for (let i=0; i<50 && service.get(jobId).status !== "done"; i++) await Bun.sleep(5);
    const final = service.get(jobId);
    expect(workerJob).toMatchObject({ probe:"geometry", geometryLimit:2000, geometryRoleKeys:{ panel:expect.any(String) } });
    expect(final.result).toMatchObject({ kind:"geometry", resolvedRev:1, prototypeInstanceId:expect.any(String), componentPins:[], designSystemMetaVersion:null, resolvedSpaceScale:{md:"12px"}, viewport:{width:390,height:844}, dpr:2, rects:[{key:"root",width:10,height:0}], truncated:false, total:1 });
    expect(final.result).toMatchObject({
      captureClean:true, productErrors:[], infraNoise:[], runtimeWarnings:["slow render"],
      roleRects:{ panel:{ width:390 } }, safeArea:{ top:0 }, issues:[{ code:"footer-owns-page" }],
      viewportOwnership:{ scrollable:false, unownedPct:0 },
    });
    expect((db.query("SELECT count(*) AS n FROM assets").get() as {n:number}).n).toBe(0);
  });

  test("image result splits product errors from infrastructure noise and keeps legacy fields", async () => {
    const { db, dir, handler: h } = await setup();
    expect((await h(req("/prototypes", "POST", { doc: await helloDoc("clean") }))).status).toBe(201);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1]);
    const consoleErrors = [
      "Failed to load resource: 404 (http://127.0.0.1:8787/favicon.ico)",
      "ResizeObserver loop completed with undelivered notifications.",
      "net::ERR_NETWORK_CHANGED",
      "Uncaught TypeError: props.items is not iterable (http://127.0.0.1:8787/api/components/x/versions/1/bundle.js)",
      "extension error (chrome-extension://abcdef/inject.js)",
      "Blocked script (https://cdn.example.com/tracker.js)",
    ];
    const runJob: RunJob = async () => ({ ok: true, pngBase64: Buffer.from(png).toString("base64"), width: 1, height: 1, consoleErrors, consoleWarnings: ["[overlay] warning"], pageErrors: ["boom in prototype code"], browserVersion: "test/1" });
    const service = makeService(db, dir, runJob);
    const { jobId } = service.enqueuePrototype("clean", "welcome", { viewport: { width: 390, height: 844 } });
    for (let i = 0; i < 50 && service.get(jobId).status !== "done"; i++) await Bun.sleep(5);
    const result = service.get(jobId).result;
    if (result?.kind !== "image") throw new Error("expected image result");
    expect(result.imageProduced).toBe(true);
    expect(result.captureClean).toBe(false);
    expect(result.productErrors).toEqual(["Uncaught TypeError: props.items is not iterable (http://127.0.0.1:8787/api/components/x/versions/1/bundle.js)", "boom in prototype code"]);
    expect(result.infraNoise).toHaveLength(5);
    expect(result.runtimeWarnings).toEqual(["[overlay] warning"]);
    // Legacy fields stay verbatim for older clients.
    expect(result.consoleErrors).toEqual(consoleErrors);
    expect(result.pageErrors).toEqual(["boom in prototype code"]);
  });

  test("geometry role keys come from the authored screen regions", async () => {
    const doc = await helloDoc("roles");
    expect(geometryRoleKeysOf(doc, doc.screens[0]!.id)).toMatchObject({ panel: doc.screens[0]!.spec.root });
    expect(geometryRoleKeysOf(doc, "missing")).toEqual({});
  });

  test("rejects unknown probe modes", async () => {
    const { db, dir, handler:h } = await setup();
    expect((await h(req("/prototypes", "POST", { doc:await helloDoc("bad-probe") }))).status).toBe(201);
    const handler=createTestHandler(db,{dataDir:dir,screenshots:makeService(db,dir)});
    const response=await handler(req("/prototypes/bad-probe/screens/welcome/screenshot","POST",{probe:"pixels",viewport:{width:390,height:844}}));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({error:{code:"invalid_request"}});
  });
});

describe("capture error classification", () => {
  const origin = "http://127.0.0.1:8787";
  test("allowlisted noise never counts as a product error", () => {
    for (const message of [
      "GET http://127.0.0.1:8787/favicon.ico 404",
      "Denied loading chrome-extension://xyz/content.js",
      "moz-extension://abc/inject.js failed",
      "Fetch failed: net::ERR_NETWORK_CHANGED",
      "ResizeObserver loop completed with undelivered notifications.",
      "ResizeObserver loop limit exceeded",
      "Refused to connect to https://analytics.example.com/collect",
      // Песочница снимка сама блокирует пробу сессии: у capture-принципала нет пользователя.
      `Failed to load resource: net::ERR_FAILED (${origin}/api/auth/me)`,
    ]) expect(isInfraNoise(message, origin)).toBe(true);
  });

  test("errors of the captured document stay product errors", () => {
    for (const message of [
      "TypeError: cannot read properties of undefined",
      "Failed to load /api/components/yp-box/versions/3/bundle.js (http://127.0.0.1:8787/api/components/yp-box/versions/3/bundle.js)",
      "[overlay] Overlay is not rendered",
    ]) expect(isInfraNoise(message, origin)).toBe(false);
    const classified = classifyCaptureErrors(["favicon.ico 404", "TypeError: boom"], { captureOrigin: origin });
    expect(classified).toEqual({ productErrors: ["TypeError: boom"], infraNoise: ["favicon.ico 404"] });
  });
});

describe("capture-session store", () => {
  const allowed = ["/capture/p/s/welcome", "/api/assets/", "/index.html"];
  const expected = { kind: "prototype", prototypeInstanceId:"instance-test", rev: 1, componentManifestHash: "h", builtinCatalogHash: "b", designSystem: "shadcn", dsMetaVersion: null, rendererBuild: null } as const;

  test("authorizes only loopback GET/HEAD on an allowlisted path with a live token", () => {
    const store = new CaptureSessionStore();
    const session = store.mint({ kind: "prototype", allowedUrls: allowed, expected });
    const ok = { token: session.token, address: "127.0.0.1", method: "GET", path: "/capture/p/s/welcome" };
    expect(store.authorize(ok)).toBe(true);
    expect(store.authorize({ ...ok, address: "::ffff:127.0.0.1" })).toBe(true);
    expect(store.authorize({ ...ok, address: "::1" })).toBe(true);
    expect(store.authorize({ ...ok, address: "10.0.0.5" })).toBe(false); // non-loopback
    expect(store.authorize({ ...ok, method: "POST" })).toBe(false); // wrong method
    expect(store.authorize({ ...ok, path: "/api/prototypes/p" })).toBe(false); // not allowlisted
    expect(store.authorize({ ...ok, path: "/api/assets/asset_x" })).toBe(true); // prefix
    expect(store.authorize({ ...ok, token: "nope" })).toBe(false); // unknown token
  });

  test("token expires at its TTL and revoke removes it", () => {
    let clock = 1000;
    const store = new CaptureSessionStore(() => clock);
    const session = store.mint({ kind: "prototype", allowedUrls: allowed, expected });
    const call = { token: session.token, address: "127.0.0.1", method: "GET", path: "/capture/p/s/welcome" };
    expect(store.authorize(call)).toBe(true);
    clock += 91_000; // past 60s + 30s
    expect(store.authorize(call)).toBe(false);
    // revoke
    clock = 1000;
    const s2 = store.mint({ kind: "prototype", allowedUrls: allowed, expected });
    store.revoke(s2.token);
    expect(store.authorize({ ...call, token: s2.token })).toBe(false);
  });

  test("isLoopbackAddress and matchAllowed helpers", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("192.168.1.1")).toBe(false);
    expect(matchAllowed("/api/assets/asset_x", ["/api/assets/"])).toBe(true);
    expect(matchAllowed("/other", ["/api/assets/"])).toBe(false);
  });
});

describe("allowedUrls builder", () => {
  test("collects every font and icon variant from a design-system theme", () => {
    expect(themeAssetIds({
      tokens: {},
      fonts: [{ family: "YS Text", src: "asset_font" }],
      icons: [{ name: "pay", assetId: "asset_icon", themes: { light: "asset_light", dark: "asset_dark" } }],
    })).toEqual(["asset_font", "asset_icon", "asset_light", "asset_dark"]);
  });

  test("prototype screenshot allowlist includes pinned design-system font assets", async () => {
    const { db, dir, handler } = await setup();
    const sha = "a".repeat(64);
    const assetId = `asset_${sha}`;
    db.run(
      "INSERT INTO assets (id,sha256,mime,size,width,height,original_name,created_at) VALUES (?,?,?,?,?,?,?,?)",
      [assetId, sha, "font/woff2", 16, null, null, "ys-text.woff2", "now"],
    );
    db.run(
      "INSERT INTO design_system_versions (system_id,version,tokens_json,fonts_json,icons_json,created_at) VALUES (?,?,?,?,?,?)",
      ["yandex-pay", 1, "{}", JSON.stringify([{ family: "YS Text", src: assetId, weight: 400 }]), "[]", "now"],
    );
    expect((await handler(req("/prototypes", "POST", { doc: await helloDoc("theme-assets") }))).status).toBe(201);
    const service = makeService(db, dir);
    const { jobId } = service.enqueuePrototype("theme-assets", "welcome", { viewport: { width: 390, height: 844 } });
    expect(service.peek(jobId)?.allowedUrls).toContain(`/api/assets/${assetId}`);
  });

  /**
   * R4 (план renderer-contract-2 §5): манифест шрифтов темы. `assetId` и `sha256` в схеме темы
   * отсутствуют (C-m13) — первый берётся из `src`, второй из канонического формата id
   * `asset_<sha256>`; порядок объявления на хэш не влияет, содержимое — влияет.
   */
  test("font manifest: assetId из src, sha256 из формата id, хэш — функция содержимого", () => {
    const sha = "b".repeat(64);
    const manifest = fontManifestOf({
      tokens: {},
      fonts: [
        { family: "Corpus Text", src: `asset_${sha}`, weight: 700 },
        { family: "Legacy", src: "/api/assets/asset_legacy", style: "italic" },
      ],
      icons: [],
    });
    expect(manifest.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.declared).toContainEqual({ family: "Corpus Text", weight: "700", style: "normal", assetId: `asset_${sha}`, sha256: sha });
    // Не-каноничный id не притворяется хэшем: `null` честнее выдуманного sha.
    expect(manifest.declared).toContainEqual({ family: "Legacy", weight: "400", style: "italic", assetId: "asset_legacy", sha256: null });

    const reordered = fontManifestOf({
      tokens: {},
      fonts: [{ family: "Legacy", src: "asset_legacy", style: "italic" }, { family: "Corpus Text", src: `asset_${sha}`, weight: 700 }],
      icons: [],
    });
    expect(reordered.manifestHash).toBe(manifest.manifestHash);
    expect(fontManifestOf({ tokens: {}, fonts: [], icons: [] }).declared).toEqual([]);
    expect(fontManifestOf(null).manifestHash).toBe(fontManifestOf({ tokens: {}, fonts: [], icons: [] }).manifestHash);
    expect(declaredFontFaces(null)).toEqual([]);
  });

  /** Постановка прототипа резолвит тему **снимаемого экрана** на любом капчуре, не только probe. */
  test("prototype enqueue freezes the theme font manifest onto the job", async () => {
    const { db, dir, handler } = await setup();
    const sha = "c".repeat(64);
    const assetId = `asset_${sha}`;
    db.run(
      "INSERT INTO assets (id,sha256,mime,size,width,height,original_name,created_at) VALUES (?,?,?,?,?,?,?,?)",
      [assetId, sha, "font/woff2", 16, null, null, "ys-text.woff2", "now"],
    );
    db.run(
      "INSERT INTO design_system_versions (system_id,version,tokens_json,fonts_json,icons_json,created_at) VALUES (?,?,?,?,?,?)",
      ["yandex-pay", 1, "{}", JSON.stringify([{ family: "YS Text", src: assetId, weight: 400 }]), "[]", "now"],
    );
    expect((await handler(req("/prototypes", "POST", { doc: await helloDoc("font-manifest") }))).status).toBe(201);
    const service = makeService(db, dir);
    const { jobId } = service.enqueuePrototype("font-manifest", "welcome", { viewport: { width: 390, height: 844 } });
    const job = service.peek(jobId);
    expect(job?.fonts?.declared).toEqual([{ family: "YS Text", weight: "400", style: "normal", assetId, sha256: sha }]);
    expect(job?.fonts?.manifestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  /** Манифест обязан доехать до поверхности: он вход правила required-faces, а не серверная запись. */
  test("bootstrap carries the frozen font manifest to the surface", async () => {
    const { db, dir, handler } = await setup();
    const sha = "d".repeat(64);
    db.run(
      "INSERT INTO assets (id,sha256,mime,size,width,height,original_name,created_at) VALUES (?,?,?,?,?,?,?,?)",
      [`asset_${sha}`, sha, "font/woff2", 16, null, null, "ys.woff2", "now"],
    );
    db.run(
      "INSERT INTO design_system_versions (system_id,version,tokens_json,fonts_json,icons_json,created_at) VALUES (?,?,?,?,?,?)",
      ["yandex-pay", 1, "{}", JSON.stringify([{ family: "YS Text", src: `asset_${sha}` }]), "[]", "now"],
    );
    expect((await handler(req("/prototypes", "POST", { doc: await helloDoc("font-bootstrap") }))).status).toBe(201);
    let seen: { fonts?: { declared: unknown[]; manifestHash: string } } | undefined;
    const runJob: RunJob = async (job) => { seen = job.bootstrap; return { ok: false, error: "stop here" }; };
    const service = makeService(db, dir, runJob);
    const { jobId } = service.enqueuePrototype("font-bootstrap", "welcome", { viewport: { width: 390, height: 844 } });
    for (let i = 0; i < 50 && service.get(jobId).status !== "error"; i++) await Bun.sleep(5);
    expect(seen?.fonts?.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(seen?.fonts?.declared).toHaveLength(1);
  });

  test("includes index.html and assets, tolerating a missing dist build", () => {
    const urls = buildStaticAllowedUrls("dist");
    expect(urls).toContain("/index.html");
    // Иммутабельный compat-CSS линкуется прямо из index.html и не попадает в vite-манифест:
    // без явной записи снимок рендерится без него (тихая потеря стилей опубликованных бандлов).
    expect(urls).toContain("/assets/shadcn-v1-compat.css");
    // Either exact manifest entries (/assets/xxx.js) or the /assets/ prefix fallback.
    expect(urls.some((u) => u.startsWith("/assets/"))).toBe(true);
    const rb = rendererBuildFrom("dist");
    expect(rb === null || /^assets\/.*\.js$/.test(rb)).toBe(true);
    expect(buildStaticAllowedUrls(undefined)).toEqual([]);
    expect(rendererBuildFrom(undefined)).toBe(null);
  });

  test("prototype allowlist snapshot includes capture route, endpoints, shims, static", () => {
    // Exercised through the private builder via a job snapshot in the job API tests;
    // here assert the props-validation guard directly.
    expect(() => validatePropsAgainstSchema({ a: 1 }, { properties: { a: { type: "string" } } })).toThrow();
    expect(() => validatePropsAgainstSchema({ a: "x" }, { properties: { a: { type: "string" } } })).not.toThrow();
    expect(() => validatePropsAgainstSchema({}, { required: ["a"] })).toThrow();
    expect(() => validatePropsAgainstSchema({ $x: 1 }, undefined)).toThrow();
  });
});
