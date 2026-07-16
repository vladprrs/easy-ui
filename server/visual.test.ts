import { createTestHandler } from "./test-auth";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import pngjs from "pngjs";
import { openDatabase } from "./db";
import { createHandler } from "./main";
import { prototypeDocSchema } from "../src/prototype/schema";
import { AssetRepo } from "./repos/assets";
import { PrototypeRepo } from "./repos/prototypes";
import { ScreenshotService, type RunJob } from "./screenshot/service";
import { VisualService } from "./visual/service";
import { fingerprintId, fingerprintJson, parseFingerprint } from "./visual/fingerprint";
import { spawnDiffWorker, type RunDiff } from "./visual/diff-runner";
import { compare } from "../scripts/visual-diff-worker.mjs";

const { PNG } = pngjs;

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function helloDoc(id: string) {
  const original = prototypeDocSchema.parse(await Bun.file("test/fixtures/host-content.json").json());
  return { ...original, id, name: id };
}
async function setup() {
  const dir = await mkdtemp(resolve(process.cwd(), ".visual-test-"));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  return { dir, db };
}
const req = (url: string, method = "GET", value?: unknown) =>
  new Request(`http://test/api${url}`, { method, headers: value ? { "content-type": "application/json" } : undefined, body: value ? JSON.stringify(value) : undefined });

/** Solid-fill RGBA PNG. `mutate` may poke individual pixels for controlled diffs. */
function makePng(width: number, height: number, rgba: [number, number, number, number], mutate?: (png: InstanceType<typeof PNG>) => void): Uint8Array {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) { png.data[i] = rgba[0]; png.data[i + 1] = rgba[1]; png.data[i + 2] = rgba[2]; png.data[i + 3] = rgba[3]; }
  mutate?.(png);
  return new Uint8Array(PNG.sync.write(png));
}

const white: [number, number, number, number] = [255, 255, 255, 255];

// In-process diff (exercises the real worker logic without a subprocess) for fast cycle tests.
const inProcessDiff: RunDiff = async (job) => compare(Buffer.from(job.referencePngBase64, "base64"), Buffer.from(job.candidatePngBase64, "base64"), job.options) as Awaited<ReturnType<RunDiff>>;

function candidateRunJob(png: Uint8Array): RunJob {
  const buf = Buffer.from(png);
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  return async () => ({ ok: true, pngBase64: buf.toString("base64"), width: w, height: h, consoleErrors: [], pageErrors: [], browserVersion: "test/1" });
}

async function waitReport(service: VisualService, runId: string) {
  for (let i = 0; i < 200; i++) {
    const view = service.get(runId);
    if (view?.kind === "report") return view.report;
    await Bun.sleep(10);
  }
  throw new Error("run did not finalize");
}

function makeScreenshots(db: Parameters<typeof createHandler>[0], dir: string, runJob: RunJob) {
  return new ScreenshotService({ db, dataDir: dir, serveDist: "dist", captureOrigin: "http://127.0.0.1:8787", chromiumAvailable: true, runJob });
}

const protoFingerprint = (prototypeId: string) => ({
  scope: "prototype-screen" as const, prototypeId, screenId: "welcome", refRevision: 1,
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 as const, theme: "light" as const,
});

describe("visual fingerprint", () => {
  test("canonicalizes key order and drops undefined optionals", () => {
    const a = parseFingerprint({ scope: "component", componentId: "c1", refVersion: 2, viewport: { width: 100, height: 200 }, deviceScaleFactor: 1, theme: "light" });
    const b = parseFingerprint({ theme: "light", deviceScaleFactor: 1, viewport: { height: 200, width: 100 }, refVersion: 2, componentId: "c1", scope: "component", propsHash: undefined });
    expect(fingerprintJson(a)).toBe(fingerprintJson(b));
    expect(fingerprintId(fingerprintJson(a))).toBe(fingerprintId(fingerprintJson(b)));
  });

  test("distinct surfaces fingerprint differently", () => {
    const light = parseFingerprint({ ...protoFingerprint("p"), theme: "light" });
    const dark = parseFingerprint({ ...protoFingerprint("p"), theme: "dark" });
    expect(fingerprintJson(light)).not.toBe(fingerprintJson(dark));
  });
});

describe("migration v6", () => {
  test("populates visual_references and visual_runs", () => {
    const db = openDatabase(":memory:");
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toContain("visual_references");
    expect(tables).toContain("visual_runs");
    const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(version).toBeGreaterThanOrEqual(6);
  });
});

describe("PUT /api/visual-references upsert", () => {
  test("requires an existing PNG asset and upserts by fingerprint preserving runs", async () => {
    const { db, dir } = await setup();
    const handler = createTestHandler(db, { dataDir: dir });
    const assets = new AssetRepo(db, dir);
    const a1 = (await assets.ingest(makePng(4, 4, white), "image/png")).asset;
    const a2 = (await assets.ingest(makePng(4, 4, [0, 0, 0, 255]), "image/png")).asset;

    // Non-existent asset -> 422.
    const missing = await handler(req("/visual-references", "PUT", { fingerprint: protoFingerprint("p"), assetId: "asset_deadbeef" }));
    expect(missing.status).toBe(422);

    const first = await handler(req("/visual-references", "PUT", { fingerprint: protoFingerprint("p"), assetId: a1.id, note: "baseline" }));
    expect(first.status).toBe(200);
    const ref1 = await first.json() as { id: string; asset: { id: string }; note: string };
    expect(ref1.asset.id).toBe(a1.id);
    expect(ref1.note).toBe("baseline");
    db.run("INSERT INTO visual_runs (id,reference_id,reference_asset_id,status,created_at) VALUES ('vrun_old_baseline',?,?, 'pass','now')", [ref1.id, a1.id]);

    const second = await handler(req("/visual-references", "PUT", { fingerprint: protoFingerprint("p"), assetId: a2.id }));
    const ref2 = await second.json() as { id: string; asset: { id: string }; lastRun: unknown };
    expect(ref2.id).toBe(ref1.id); // same fingerprint => same content-addressed id
    expect(ref2.asset.id).toBe(a2.id); // asset replaced
    expect(ref2.lastRun).toBeNull(); // the pass against a1 does not verify the new a2 baseline

    const list = await (await handler(req("/visual-references?scope=prototype-screen"))).json() as { references: { lastRun: unknown }[] };
    expect(list.references.length).toBe(1);
    expect(list.references[0]?.lastRun).toBeNull();
    const detail = await (await handler(req(`/visual-references/${ref1.id}`))).json() as { runs: { reference: { assetId: string } }[] };
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0]?.reference.assetId).toBe(a1.id);
  });

  test("rejects a non-PNG reference asset", async () => {
    const { db, dir } = await setup();
    const handler = createTestHandler(db, { dataDir: dir });
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0x21, 0xf9, 4, 0, 0, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0, 0x3b]);
    const asset = (await new AssetRepo(db, dir).ingest(gif, "image/gif")).asset;
    const res = await handler(req("/visual-references", "PUT", { fingerprint: protoFingerprint("p"), assetId: asset.id }));
    expect(res.status).toBe(422);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("invalid_reference_asset");
  });
});

describe("visual check full cycle", () => {
  async function prepare(protoId: string, referencePng: Uint8Array) {
    const { db, dir } = await setup();
    const handler = createTestHandler(db, { dataDir: dir });
    expect((await handler(req("/prototypes", "POST", { doc: await helloDoc(protoId) }))).status).toBe(201);
    const refAsset = (await new AssetRepo(db, dir).ingest(referencePng, "image/png")).asset;
    const put = await handler(req("/visual-references", "PUT", { fingerprint: protoFingerprint(protoId), assetId: refAsset.id }));
    const reference = await put.json() as { id: string };
    return { db, dir, handler, referenceId: reference.id, refAsset };
  }

  test("identical images => pass at 0% with full evidence", async () => {
    const png = makePng(4, 4, white);
    const { db, dir, referenceId, refAsset } = await prepare("vpass", png);
    const screenshots = makeScreenshots(db, dir, candidateRunJob(png));
    const service = new VisualService({ db, dataDir: dir, screenshots, runDiff: inProcessDiff });
    const { runId, jobId } = service.check(referenceId, {});
    expect(jobId).toBeDefined();
    const report = await waitReport(service, runId);
    expect(report.status).toBe("pass");
    expect(report.metric).toBe("pixelmatch-v1");
    expect(report.diffPixels).toBe(0);
    expect(report.totalPixels).toBe(16);
    expect(report.diffPercent).toBe(0);
    expect(report.metrics["exact-rgba"]).toEqual({ diffPixels: 0, totalPixels: 16, diffPercent: 0 });
    // Evidence guard: both sha256, both dimensions, numerator + denominator, candidate meta.
    expect(report.reference?.sha256).toBe(refAsset.sha256);
    expect(report.reference?.width).toBe(4);
    expect(report.candidate?.sha256).toBeDefined();
    expect(report.candidate?.width).toBe(4);
    expect(report.candidateMeta).toMatchObject({ rev: 1, browserVersion: "test/1" });
    expect(report.diff?.url).toContain("/api/assets/");
    expect(db.query("SELECT reference_asset_id FROM visual_runs WHERE id=?").get(runId)).toEqual({ reference_asset_id: refAsset.id });
  });

  test("different images => fail with exact diff_pixels", async () => {
    const reference = makePng(4, 4, white);
    // Candidate: 4 black pixels out of 16.
    const candidate = makePng(4, 4, white, (p) => { for (let i = 0; i < 4; i++) { p.data[i * 4] = 0; p.data[i * 4 + 1] = 0; p.data[i * 4 + 2] = 0; } });
    const { db, dir, referenceId } = await prepare("vfail", reference);
    const screenshots = makeScreenshots(db, dir, candidateRunJob(candidate));
    const service = new VisualService({ db, dataDir: dir, screenshots, runDiff: inProcessDiff });
    const { runId } = service.check(referenceId, {});
    const report = await waitReport(service, runId);
    expect(report.status).toBe("fail");
    expect(report.metrics["exact-rgba"]?.diffPixels).toBe(4);
    expect(report.metrics["exact-rgba"]?.totalPixels).toBe(16);
    expect(report.diffPixels).toBeGreaterThanOrEqual(1);
    expect(report.diff?.assetId).toBeDefined();
  });

  test("dimension mismatch => error with no percentage", async () => {
    const reference = makePng(4, 4, white);
    const candidate = makePng(2, 2, white);
    const { db, dir, referenceId } = await prepare("vdim", reference);
    const screenshots = makeScreenshots(db, dir, candidateRunJob(candidate));
    const service = new VisualService({ db, dataDir: dir, screenshots, runDiff: inProcessDiff });
    const { runId } = service.check(referenceId, {});
    const report = await waitReport(service, runId);
    expect(report.status).toBe("error");
    expect(report.diffPercent).toBeNull();
    expect(report.diffPixels).toBeNull();
    // Both physical files still recorded with their (differing) dimensions.
    expect(report.reference?.width).toBe(4);
    expect(report.candidate?.width).toBe(2);
  });

  test("missing reference bytes => reference_missing, pixelDiffPercent null, no candidate capture", async () => {
    const png = makePng(4, 4, white);
    const { db, dir, referenceId, refAsset } = await prepare("vmiss", png);
    // Remove the reference bytes to simulate an empty reference directory.
    await rm(new AssetRepo(db, dir).bytesPath(refAsset.sha256));
    const screenshots = makeScreenshots(db, dir, candidateRunJob(png));
    const service = new VisualService({ db, dataDir: dir, screenshots, runDiff: inProcessDiff });
    const { runId, jobId } = service.check(referenceId, {});
    expect(jobId).toBeUndefined();
    const report = await waitReport(service, runId);
    expect(report.status).toBe("reference_missing");
    expect(report.diffPercent).toBeNull();
    expect(report.candidate).toBeNull();
  });

  test("threshold tolerates a small diff (pass) via HTTP + persisted run history", async () => {
    const reference = makePng(4, 4, white);
    const candidate = makePng(4, 4, white, (p) => { p.data[0] = 0; p.data[1] = 0; p.data[2] = 0; });
    const { db, dir, handler, referenceId } = await prepare("vthresh", reference);
    const screenshots = makeScreenshots(db, dir, candidateRunJob(candidate));
    const service = new VisualService({ db, dataDir: dir, screenshots, runDiff: inProcessDiff });
    const handlerWithVisual = createTestHandler(db, { dataDir: dir, visual: service });
    const invalid = await handlerWithVisual(req(`/visual-references/${referenceId}/check`, "POST", { threshold: 100.1 }));
    expect(invalid.status).toBe(422);
    expect((await invalid.json() as { error: { code: string } }).error.code).toBe("invalid_threshold");
    // 1 of 16 pixels differs = 6.25%; threshold 10% => pass.
    const res = await handlerWithVisual(req(`/visual-references/${referenceId}/check`, "POST", { threshold: 10 }));
    expect(res.status).toBe(202);
    const { runId } = await res.json() as { runId: string };
    const report = await waitReport(service, runId);
    expect(report.status).toBe("pass");
    // GET run via a fresh handler with no service falls back to the persisted DB row.
    const persisted = await (await handler(req(`/visual-runs/${runId}`))).json() as { status: string; runId: string };
    expect(persisted.status).toBe("pass");
    // Reference detail lists run history.
    const detail = await (await handler(req(`/visual-references/${referenceId}`))).json() as { runs: unknown[] };
    expect(detail.runs.length).toBe(1);
  });

  test("real diff subprocess produces an honest report", async () => {
    const png = makePng(6, 6, white);
    const { db, dir, referenceId } = await prepare("vsub", png);
    const screenshots = makeScreenshots(db, dir, candidateRunJob(png));
    const service = new VisualService({ db, dataDir: dir, screenshots, runDiff: spawnDiffWorker });
    const { runId } = service.check(referenceId, {});
    const report = await waitReport(service, runId);
    expect(report.status).toBe("pass");
    expect(report.totalPixels).toBe(36);
  });

  test("prototype candidate rev override and default target are frozen into metadata",async()=>{
    const png=makePng(4,4,white);const {db,dir,handler,referenceId}=await prepare("override-proto",png);
    expect((await handler(req("/prototypes/override-proto","PUT",{doc:await helloDoc("override-proto"),baseRev:1}))).status).toBe(200);
    const screenshots=makeScreenshots(db,dir,candidateRunJob(png));const service=new VisualService({db,dataDir:dir,screenshots,runDiff:inProcessDiff});
    const overridden=await waitReport(service,service.check(referenceId,{rev:2}).runId);
    expect(overridden.candidateMeta).toMatchObject({kind:"prototype",outcome:"captured",requestedTarget:{rev:2},resolvedTarget:{rev:2},rev:2,browser:{browserVersion:"test/1"}});
    expect((overridden.candidateMeta as {expected?:unknown}|null)?.expected).toMatchObject({kind:"prototype",rev:2,prototypeInstanceId:expect.any(String)});
    const defaulted=await waitReport(service,service.check(referenceId,{}).runId);
    expect(defaulted.candidateMeta).toMatchObject({requestedTarget:{rev:1},resolvedTarget:{rev:1},rev:1});
    expect(()=>service.check(referenceId,{version:1})).toThrow();
  });

  test("component version override uses version only and preserves legacy aliases",async()=>{
    const {db,dir}=await setup();
    db.run("INSERT INTO components (id,name,head_rev,design_system,created_at,updated_at) VALUES ('visual-component','VisualComponent',2,'yandex-pay','now','now')");
    for(const rev of [1,2]) db.run("INSERT INTO component_revisions (component_id,rev,source,design_system,created_at) VALUES ('visual-component',?,'source','yandex-pay','now')",[rev]);
    for(const version of [1,2]) db.run("INSERT INTO component_publishes (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,published_at) VALUES ('visual-component',?,?, 'active','js','{}',?,?,1,'now')",[version,version,`source-${version}`,`bundle-${version}`]);
    const baseline=(await new AssetRepo(db,dir).ingest(makePng(4,4,white),"image/png")).asset;
    const handler=createTestHandler(db,{dataDir:dir});const put=await handler(req("/visual-references","PUT",{fingerprint:{scope:"component",componentId:"visual-component",refVersion:1,viewport:{width:320,height:480},deviceScaleFactor:1,theme:"light"},assetId:baseline.id}));const {id}=await put.json() as {id:string};
    const screenshots=makeScreenshots(db,dir,candidateRunJob(makePng(4,4,white)));const service=new VisualService({db,dataDir:dir,screenshots,runDiff:inProcessDiff});
    const report=await waitReport(service,service.check(id,{version:2}).runId);
    expect(report.candidateMeta).toMatchObject({kind:"component",outcome:"captured",requestedTarget:{version:2},resolvedTarget:{version:2},version:2,bundleHash:"bundle-2",rendererBuild:expect.anything(),browserVersion:"test/1"});
    expect(()=>service.check(id,{rev:1})).toThrow();
  });

  test("hash-bearing references are never checked and invalid screenshot viewport stays typed",async()=>{
    const png=makePng(4,4,white);const {db,dir,handler}=await prepare("hash-target",png);const asset=(await new AssetRepo(db,dir).ingest(png,"image/png")).asset;
    const hashPut=await handler(req("/visual-references","PUT",{fingerprint:{...protoFingerprint("hash-target"),propsHash:"aa"},assetId:asset.id}));const hashId=(await hashPut.json() as {id:string}).id;
    const service=new VisualService({db,dataDir:dir,screenshots:makeScreenshots(db,dir,candidateRunJob(png)),runDiff:inProcessDiff});
    try{service.check(hashId,{});throw new Error("expected rejection");}catch(error){expect((error as {code:string}).code).toBe("invalid_candidate_target");}
    const invalidPut=await handler(req("/visual-references","PUT",{fingerprint:{...protoFingerprint("hash-target"),viewport:{width:10,height:844}},assetId:asset.id}));const invalidId=(await invalidPut.json() as {id:string}).id;
    try{service.check(invalidId,{});throw new Error("expected rejection");}catch(error){expect((error as {code:string}).code).toBe("invalid_viewport");}
  });

  test("capture errors/timeouts keep requested target with browser null; browser diagnostics force error",async()=>{
    const png=makePng(4,4,white);const {db,dir,referenceId}=await prepare("candidate-errors",png);
    const failedShots=makeScreenshots(db,dir,async()=>({ok:false,error:"navigation failed"}));const failedService=new VisualService({db,dataDir:dir,screenshots:failedShots,runDiff:inProcessDiff});
    const failed=await waitReport(failedService,failedService.check(referenceId,{rev:1}).runId);expect(failed.status).toBe("error");expect(failed.candidateMeta).toMatchObject({kind:"prototype",outcome:"capture_failed",requestedTarget:{rev:1},resolvedTarget:{rev:1},browser:null,error:"navigation failed",rev:1});
    const timeoutShots=makeScreenshots(db,dir,()=>new Promise(()=>{}));let clock=0;const timeoutService=new VisualService({db,dataDir:dir,screenshots:timeoutShots,runDiff:inProcessDiff,now:()=>{clock+=100_000;return clock;}});
    const timed=await waitReport(timeoutService,timeoutService.check(referenceId,{rev:1}).runId);expect(timed.candidateMeta).toMatchObject({outcome:"capture_failed",requestedTarget:{rev:1},browser:null});
    const browserShots=makeScreenshots(db,dir,async()=>{const b=Buffer.from(png);return{ok:true,pngBase64:b.toString("base64"),width:4,height:4,consoleErrors:["boom".repeat(300)],pageErrors:["page boom"],browserVersion:"test/2"};});const browserService=new VisualService({db,dataDir:dir,screenshots:browserShots,runDiff:inProcessDiff});
    const browser=await waitReport(browserService,browserService.check(referenceId,{}).runId);expect(browser.status).toBe("error");expect(browser.diffPercent).toBeNull();expect(browser.candidateMeta).toMatchObject({outcome:"captured",browser:{browserVersion:"test/2",pageErrors:["page boom"]},rev:1,browserVersion:"test/2"});const diagnostics=(browser.candidateMeta as {browser?:{consoleErrors:string[]}|null}|null)?.browser?.consoleErrors??[];expect(diagnostics[0]!.length).toBeLessThanOrEqual(500);
  });

  test("queued check cannot capture a delete/recreated prototype incarnation",async()=>{
    const png=makePng(4,4,white);const {db,dir,handler}=await prepare("aba-check",png);const draft=await (await handler(req("/prototypes/aba-check/draft"))).json() as {prototypeInstanceId:string};const asset=(await new AssetRepo(db,dir).ingest(png,"image/png")).asset;
    const put=await handler(req("/visual-references","PUT",{fingerprint:{...protoFingerprint("aba-check"),prototypeInstanceId:draft.prototypeInstanceId},assetId:asset.id}));const referenceId=(await put.json() as {id:string}).id;
    let release!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;});let calls=0;
    const runJob:RunJob=async(job)=>{calls+=1;if(calls===1) await blocked;const current=db.query("SELECT instance_id FROM prototypes WHERE id='aba-check'").get() as {instance_id:string};if(job.expected.kind==="prototype"&&job.expected.prototypeInstanceId!==current.instance_id)return{ok:false,error:"readiness mismatch: prototype instance changed"};const b=Buffer.from(png);return{ok:true,pngBase64:b.toString("base64"),width:4,height:4,consoleErrors:[],pageErrors:[],browserVersion:"test/1"};};
    const screenshots=makeScreenshots(db,dir,runJob);screenshots.enqueuePrototype("aba-check","welcome",{viewport:{width:390,height:844}});const service=new VisualService({db,dataDir:dir,screenshots,runDiff:inProcessDiff});const {runId}=service.check(referenceId,{});
    new PrototypeRepo(db).delete("aba-check",1);new PrototypeRepo(db).create(await helloDoc("aba-check"));release();
    const report=await waitReport(service,runId);expect(report.status).toBe("error");expect(report.candidate).toBeNull();expect(report.diff).toBeNull();expect(report.diffPercent).toBeNull();expect(report.candidateMeta).toMatchObject({outcome:"capture_failed",browser:null,expected:{prototypeInstanceId:draft.prototypeInstanceId}});
  });
});

describe("DELETE /api/visual-references/:id retention", () => {
  test("reports a migrated run with no proven baseline as reference_unknown", async () => {
    const { db, dir } = await setup();
    const handler = createTestHandler(db, { dataDir: dir });
    const baseline = (await new AssetRepo(db, dir).ingest(makePng(4, 4, white), "image/png")).asset;
    const put = await handler(req("/visual-references", "PUT", { fingerprint: protoFingerprint("legacy"), assetId: baseline.id }));
    const { id } = await put.json() as { id: string };
    db.run("INSERT INTO visual_runs (id,reference_id,reference_asset_id,metric,diff_pixels,total_pixels,diff_percent,status,created_at) VALUES ('vrun_legacy',?,NULL,'pixelmatch-v1',1,16,6.25,'pass','before-v11')", [id]);

    const report = await (await handler(req("/visual-runs/vrun_legacy"))).json() as { status: string; referenceStatus: string; reference: unknown; metric: unknown; diffPercent: unknown; metrics: unknown };
    expect(report.status).toBe("reference_unknown");
    expect(report.referenceStatus).toBe("unknown");
    expect(report.reference).toBeNull();
    expect(report.metric).toBeNull();
    expect(report.diffPercent).toBeNull();
    expect(report.metrics).toEqual({});
  });

  test("tombstones the active reference without deleting runs and allows a later revival", async () => {
    const { db, dir } = await setup();
    const handler = createTestHandler(db, { dataDir: dir });
    const assets = new AssetRepo(db, dir);
    const baseline = (await assets.ingest(makePng(4, 4, white), "image/png")).asset;
    const put = await handler(req("/visual-references", "PUT", { fingerprint: protoFingerprint("retained"), assetId: baseline.id }));
    const { id } = await put.json() as { id: string };
    db.run("INSERT INTO visual_runs (id,reference_id,reference_asset_id,status,created_at) VALUES ('vrun_retained',?,?, 'pass','now')", [id, baseline.id]);

    expect((await handler(req(`/visual-references/${id}`, "DELETE"))).status).toBe(204);
    expect(db.query("SELECT COUNT(*) count FROM visual_runs WHERE reference_id=?").get(id)).toEqual({ count: 1 });
    expect(db.query("SELECT deleted_at IS NOT NULL deleted FROM visual_references WHERE id=?").get(id)).toEqual({ deleted: 1 });
    expect((await handler(req(`/visual-references/${id}`))).status).toBe(404);
    const list = await (await handler(req("/visual-references"))).json() as { references: unknown[] };
    expect(list.references).toEqual([]);
    const retained = await (await handler(req("/visual-runs/vrun_retained"))).json() as { referenceStatus: string; reference: { assetId: string } };
    expect(retained.referenceStatus).toBe("known");
    expect(retained.reference.assetId).toBe(baseline.id);
    expect((await handler(req(`/visual-references/${id}`, "DELETE"))).status).toBe(404);

    const revived = await handler(req("/visual-references", "PUT", { fingerprint: protoFingerprint("retained"), assetId: baseline.id }));
    expect(revived.status).toBe(200);
    expect((await revived.json() as { id: string }).id).toBe(id);
    expect((await handler(req(`/visual-references/${id}`))).status).toBe(200);
  });
});

describe("check availability", () => {
  test("501 when no visual service is wired", async () => {
    const { db, dir } = await setup();
    const handler = createTestHandler(db, { dataDir: dir });
    const assets = new AssetRepo(db, dir);
    const asset = (await assets.ingest(makePng(4, 4, white), "image/png")).asset;
    const put = await handler(req("/visual-references", "PUT", { fingerprint: protoFingerprint("p"), assetId: asset.id }));
    const { id } = await put.json() as { id: string };
    const res = await handler(req(`/visual-references/${id}/check`, "POST", { threshold: 0 }));
    expect(res.status).toBe(501);
  });
});
