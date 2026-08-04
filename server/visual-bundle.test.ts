/**
 * R7b — diagnostic bundle визуального рана (`GET /api/visual-runs/:runId/bundle.zip`).
 *
 * Проверяется то, ради чего архив существует: он **полон** (оба кадра, три производные картинки,
 * оба receipt'а, отчёт), **самопроверяем** (каждая строка `SHA256SUMS` сходится с байтами файла),
 * **воспроизводим** (два запроса — байт в байт) и **честен** об отсутствующем (вытесненный receipt
 * эталона — `null` в `report.json`, а не выдуманный документ).
 */
import { createTestHandler } from "./test-auth";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import pngjs from "pngjs";
import { openDatabase } from "./db";
import { prototypeDocSchema } from "../src/prototype/schema";
import { AssetRepo } from "./repos/assets";
import { ScreenshotService, type RunJob } from "./screenshot/service";
import { VisualService } from "./visual/service";
import { putReceipt } from "./capture/receiptStore";
import type { CaptureReceipt } from "../src/capture/receipt";
import { compare } from "../scripts/visual-diff-worker.mjs";
import type { RunDiff } from "./visual/diff-runner";

const { PNG } = pngjs;
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const req = (url: string) => new Request(`http://test/api${url}`);
const inProcessDiff: RunDiff = async (job) => compare(Buffer.from(job.referencePngBase64, "base64"), Buffer.from(job.candidatePngBase64, "base64"), job.options) as Awaited<ReturnType<RunDiff>>;

function makePng(width: number, height: number, rgba: [number, number, number, number], mutate?: (png: InstanceType<typeof PNG>) => void): Uint8Array {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) { png.data[i] = rgba[0]; png.data[i + 1] = rgba[1]; png.data[i + 2] = rgba[2]; png.data[i + 3] = rgba[3]; }
  mutate?.(png);
  return new Uint8Array(PNG.sync.write(png));
}
const white: [number, number, number, number] = [255, 255, 255, 255];

function candidateRunJob(png: Uint8Array): RunJob {
  const buf = Buffer.from(png);
  return async () => ({ ok: true, pngBase64: buf.toString("base64"), width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), consoleErrors: [], pageErrors: [], browserVersion: "test/1" });
}

const protoFingerprint = (prototypeId: string) => ({
  scope: "prototype-screen" as const, prototypeId, screenId: "welcome", refRevision: 1,
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 as const, theme: "light" as const,
});

const receiptOf = (fingerprint: string): CaptureReceipt => ({
  receiptVersion: 1,
  renderer: { rendererSchema: 2, fingerprint, rendererVersion: "r-test", os: null, arch: null, nodeVersion: null, playwrightVersion: null, browserName: null, browserVersion: null, browserRevision: null, launchedExecutable: null, browserExecutableSha256: null, fontStackSha256: null, appFontsSha256: null, systemLibsHash: null, launchDeterminismArgsHash: null, contextOptionsHash: null, colorProfile: "srgb", readinessPolicyHash: "policy-test", source: "test", provenance: null, observedBrowserVersion: null, drift: [] },
  target: { kind: "prototype", prototypeId: "p", rev: 1 },
  resources: { fontManifestHash: null, fontFaces: [], images: [], themeResources: null },
  console: { errors: [], warnings: [], pageErrors: [] },
  output: null,
  timings: { totalMs: 1 },
  verdict: { captureClean: true, codes: [], readinessMet: true, readinessPolicyHash: "policy-test" },
} as unknown as CaptureReceipt);

async function setup(protoId: string, referencePng: Uint8Array, candidatePng: Uint8Array) {
  const dir = await mkdtemp(resolve(process.cwd(), ".visual-bundle-test-"));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  const original = prototypeDocSchema.parse(await Bun.file("test/fixtures/host-content.json").json());
  const screenshots = new ScreenshotService({ db, dataDir: dir, serveDist: "dist", captureOrigin: "http://127.0.0.1:8787", chromiumAvailable: true, runJob: candidateRunJob(candidatePng) });
  const service = new VisualService({ db, dataDir: dir, screenshots, runDiff: inProcessDiff });
  const handler = createTestHandler(db, { dataDir: dir, visual: service });
  expect((await handler(new Request("http://test/api/prototypes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ doc: { ...original, id: protoId, name: protoId } }) }))).status).toBe(201);
  const refAsset = (await new AssetRepo(db, dir).ingest(referencePng, "image/png")).asset;
  const put = await handler(new Request("http://test/api/visual-references", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ fingerprint: protoFingerprint(protoId), assetId: refAsset.id }) }));
  const reference = await put.json() as { id: string };
  // Второй хэндлер — без сервиса: `VisualService` держит терминальный отчёт в памяти 10 минут, и
  // тесты, которые правят строку рана в БД, обязаны читать её из БД, а не из кэша живого сервиса.
  const dbHandler = createTestHandler(db, { dataDir: dir });
  return { db, dir, handler, dbHandler, service, referenceId: reference.id, refAsset };
}

async function terminalRun(service: VisualService, referenceId: string): Promise<string> {
  const { runId } = service.check(referenceId, {});
  for (let i = 0; i < 300; i += 1) {
    const view = service.get(runId);
    if (view?.kind === "report") return runId;
    await Bun.sleep(10);
  }
  throw new Error("run did not finalize");
}

interface BundleReport {
  bundleVersion: number; runId: string; status: string;
  receipts: Record<string, { sha256: string; present: boolean; reason?: string } | null>;
  artifacts: { name: string; present: boolean; sha256?: string; source?: string; reason?: string }[];
}

const sha256Of = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

function readBundle(bytes: Uint8Array) {
  const files = unzipSync(bytes);
  const report = JSON.parse(strFromU8(files["report.json"]!)) as BundleReport;
  return { files, report };
}

describe("GET /api/visual-runs/:runId/bundle.zip", () => {
  test("carries every artifact, self-verifying sums and honest receipts", async () => {
    const reference = makePng(8, 8, white);
    // Кандидат отличается четырьмя пикселями: ран `fail`, значит diff-ассет существует.
    const candidate = makePng(8, 8, white, (p) => { for (let i = 0; i < 4; i += 1) { p.data[i * 4] = 0; p.data[i * 4 + 1] = 0; p.data[i * 4 + 2] = 0; } });
    const { db, dir, dbHandler, service, referenceId } = await setup("vbundle", reference, candidate);
    const runId = await terminalRun(service, referenceId);
    // Receipt кандидата ран записал сам (R5, asset-путь). Эталонный — вешаем руками: путь его
    // записи (R6, `upsertReferencePrivileged`) здесь не проверяется, проверяется, что bundle
    // находит оба и отдаёт документами.
    const refReceipt = await putReceipt(dir, receiptOf("fp-reference"));
    db.run("UPDATE visual_runs SET reference_receipt_sha256=? WHERE id=?", [refReceipt.sha256, runId]);
    const candSha = (db.query("SELECT candidate_receipt_sha256 sha FROM visual_runs WHERE id=?").get(runId) as { sha: string }).sha;
    expect(candSha).toMatch(/^[0-9a-f]{64}$/);

    const res = await dbHandler(req(`/visual-runs/${runId}/bundle.zip`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/zip");
    expect(res.headers.get("content-disposition")).toContain(`easy-ui-visual-run-${runId}.zip`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const { files, report } = readBundle(bytes);

    expect(Object.keys(files).sort()).toEqual([
      "SHA256SUMS", "candidate-receipt.json", "candidate.png", "diff-exact.png", "diff-perceptual.png",
      "edge-mask.png", "reference-receipt.json", "reference.png", "report.json",
    ]);

    // Каждая строка SHA256SUMS сходится с байтами файла — иначе архив не доказательство.
    const sums = strFromU8(files.SHA256SUMS!).trim().split("\n");
    expect(sums).toHaveLength(8);
    for (const line of sums) {
      const [sha, name] = line.split("  ");
      expect(files[name!]).toBeDefined();
      expect(sha256Of(files[name!]!)).toBe(sha);
    }

    expect(report.bundleVersion).toBe(1);
    expect(report.runId).toBe(runId);
    expect(report.status).toBe("fail");
    expect(report.receipts["reference-receipt.json"]).toEqual({ sha256: refReceipt.sha256, present: true });
    expect(report.receipts["candidate-receipt.json"]).toEqual({ sha256: candSha, present: true });
    expect(JSON.parse(strFromU8(files["reference-receipt.json"]!))).toMatchObject({ renderer: { fingerprint: "fp-reference" } });
    // Происхождение каждого файла названо: кадры — ассеты рана, маски — пересчитаны.
    const bySource = Object.fromEntries(report.artifacts.filter((a) => a.present).map((a) => [a.name, a.source!]));
    expect(bySource["diff-perceptual.png"]).toStartWith("asset:");
    expect(bySource["diff-exact.png"]).toBe("derived:exact-rgba");
    expect(bySource["edge-mask.png"]).toBe("derived:sobel-edge-mask");
    // diff-exact.png — маска exact-rgba: ровно 4 отличающихся пикселя, отмеченных чёрным.
    const exactMask = PNG.sync.read(Buffer.from(files["diff-exact.png"]!));
    let marked = 0;
    for (let i = 0; i < exactMask.data.length; i += 4) if (exactMask.data[i] === 0) marked += 1;
    expect(marked).toBe(4);

    // Воспроизводимость: фиксированный mtime + детерминированное содержимое.
    const again = new Uint8Array(await (await dbHandler(req(`/visual-runs/${runId}/bundle.zip`))).arrayBuffer());
    expect(Buffer.from(again).equals(Buffer.from(bytes))).toBe(true);
  });

  test("records a missing reference receipt as null instead of inventing one", async () => {
    const png = makePng(8, 8, white);
    const { db, dbHandler, service, referenceId } = await setup("vbundle-noreceipt", png, png);
    const runId = await terminalRun(service, referenceId);
    // Эталонный receipt вытеснен: sha записан, документа в сторе нет.
    const evicted = "f".repeat(64);
    db.run("UPDATE visual_runs SET reference_receipt_sha256=? WHERE id=?", [evicted, runId]);

    const { files, report } = readBundle(new Uint8Array(await (await dbHandler(req(`/visual-runs/${runId}/bundle.zip`))).arrayBuffer()));
    expect(files["reference-receipt.json"]).toBeUndefined();
    expect(report.receipts["reference-receipt.json"]).toEqual({ sha256: evicted, present: false, reason: "receipt_unavailable" });
    expect(report.artifacts.find((a) => a.name === "reference-receipt.json")).toMatchObject({ present: false, reason: `receipt_unavailable:${evicted}` });
    expect(files["candidate-receipt.json"]).toBeDefined();
    // Совпавшие кадры: diff-ассет всё равно есть (воркер отдаёт пустой diff), маски — тоже.
    expect(files["diff-exact.png"]).toBeDefined();
    expect(files["edge-mask.png"]).toBeDefined();
  });

  test("эталон без receipt'а — честный null, receipt кандидата приезжает из самого рана", async () => {
    const png = makePng(8, 8, white);
    const { handler, service, referenceId } = await setup("vbundle-null", png, png);
    const runId = await terminalRun(service, referenceId);
    const { files, report } = readBundle(new Uint8Array(await (await handler(req(`/visual-runs/${runId}/bundle.zip`))).arrayBuffer()));
    // Эталон залит ассетом напрямую (PUT /visual-references) — происхождения у него нет.
    expect(report.receipts["reference-receipt.json"]).toBeNull();
    expect(files["reference-receipt.json"]).toBeUndefined();
    expect(report.artifacts.find((a) => a.name === "reference-receipt.json")).toMatchObject({ present: false, reason: "no_receipt_recorded" });
    // А кадр кандидата снят конвейером — его receipt R5 лежит в архиве без всякой подготовки.
    expect(report.receipts["candidate-receipt.json"]).toMatchObject({ present: true });
    expect(JSON.parse(strFromU8(files["candidate-receipt.json"]!))).toMatchObject({ receiptVersion: 1 });
  });

  test("отсутствующий кадр кандидата не отменяет архив и называется причиной", async () => {
    const png = makePng(8, 8, white);
    const { db, dbHandler, service, referenceId } = await setup("vbundle-partial", png, png);
    const runId = await terminalRun(service, referenceId);
    db.run("UPDATE visual_runs SET candidate_asset_id=NULL WHERE id=?", [runId]);
    const { files, report } = readBundle(new Uint8Array(await (await dbHandler(req(`/visual-runs/${runId}/bundle.zip`))).arrayBuffer()));
    expect(files["candidate.png"]).toBeUndefined();
    expect(files["reference.png"]).toBeDefined();
    expect(report.artifacts.find((a) => a.name === "candidate.png")).toMatchObject({ present: false, reason: "asset_not_recorded" });
    expect(report.artifacts.find((a) => a.name === "diff-exact.png")).toMatchObject({ present: false, reason: "requires both reference.png and candidate.png" });
    // SHA256SUMS остаётся полным описанием того, что в архиве есть.
    const names = strFromU8(files.SHA256SUMS!).trim().split("\n").map((line) => line.split("  ")[1]);
    expect(names).not.toContain("candidate.png");
    expect(new Set(names)).toEqual(new Set(Object.keys(files).filter((name) => name !== "SHA256SUMS")));
  });

  test("бегущий ран отдаёт 409, несуществующий — 404, POST — 405", async () => {
    const png = makePng(8, 8, white);
    const { db, dir, handler, referenceId } = await setup("vbundle-running", png, png);
    // Джоба, которая никогда не завершается: ран остаётся `running`.
    const screenshots = new ScreenshotService({ db, dataDir: dir, serveDist: "dist", captureOrigin: "http://127.0.0.1:8787", chromiumAvailable: true, runJob: () => new Promise(() => {}) });
    const stuck = new VisualService({ db, dataDir: dir, screenshots, runDiff: inProcessDiff });
    const stuckHandler = createTestHandler(db, { dataDir: dir, visual: stuck });
    const { runId } = stuck.check(referenceId, {});
    const running = await stuckHandler(req(`/visual-runs/${runId}/bundle.zip`));
    expect(running.status).toBe(409);
    expect((await running.json() as { error: { code: string } }).error.code).toBe("bundle_not_ready");

    expect((await handler(req("/visual-runs/vrun_missing/bundle.zip"))).status).toBe(404);
    expect((await handler(new Request(`http://test/api/visual-runs/${runId}/bundle.zip`, { method: "POST", headers: { origin: "http://test" } }))).status).toBe(405);
  });
});
