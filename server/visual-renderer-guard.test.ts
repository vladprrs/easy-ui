/**
 * Cross-renderer guard на визуальных эталонах (план `docs/plans/2026-08-03-renderer-contract-2.md`
 * §5 **R6**). Здесь проверяется ровно то, ради чего волна существует:
 *
 * 1. **нулевой регресс до флагов** — легаси-эталон (NULL-рендерер) судится метриками как раньше,
 *    guard добавляет только advisory `renderer_unknown`;
 * 2. **отказ сравнивать после флагов** — тот же эталон даёт `error/stale_renderer` **без процента**;
 * 3. **mismatch** — эталон и кандидат разных рендереров дают `error/renderer_mismatch` c `differing[]`;
 * 4. **оба пути записи** эталона (generic PUT и baseline-коммит) получают непустой `renderer_json`;
 * 5. **совместимость v28** — старый код, не знающий новых колонок, пишет и читает строки, а
 *    потребители `SELECT *` не сериализуют row наружу.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import pngjs from "pngjs";
import { createTestHandler } from "./test-auth";
import { openDatabase } from "./db";
import { prototypeDocSchema } from "../src/prototype/schema";
import { AssetRepo } from "./repos/assets";
import { ScreenshotService, type RunJob } from "./screenshot/service";
import { VisualService, evaluateRendererGuard, type RendererGuardFlags } from "./visual/service";
import { VisualRepo, type ReferenceRendererRecord } from "./visual/repo";
import { spawnDiffWorker as _spawnDiffWorker, type RunDiff } from "./visual/diff-runner";
import { compare } from "../scripts/visual-diff-worker.mjs";
import { rendererReport } from "./capture/renderer";
import { putAssetReceipt, putReceipt } from "./capture/receiptStore";
import { buildCaptureReceipt } from "../src/capture/receipt";

const { PNG } = pngjs;
void _spawnDiffWorker;

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function setup() {
  const dir = await mkdtemp(resolve(process.cwd(), ".visual-guard-test-"));
  dirs.push(dir);
  return { dir, db: openDatabase(":memory:") };
}
const req = (url: string, method = "GET", value?: unknown) =>
  new Request(`http://test/api${url}`, { method, headers: value ? { "content-type": "application/json" } : undefined, body: value ? JSON.stringify(value) : undefined });

function makePng(width: number, height: number): Uint8Array {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) { png.data[i] = 255; png.data[i + 1] = 255; png.data[i + 2] = 255; png.data[i + 3] = 255; }
  return new Uint8Array(PNG.sync.write(png));
}

const inProcessDiff: RunDiff = async (job) => compare(Buffer.from(job.referencePngBase64, "base64"), Buffer.from(job.candidatePngBase64, "base64"), job.options) as Awaited<ReturnType<RunDiff>>;
const candidateRunJob = (png: Uint8Array): RunJob => {
  const buf = Buffer.from(png);
  return async () => ({ ok: true, pngBase64: buf.toString("base64"), width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), consoleErrors: [], pageErrors: [], browserVersion: "test/1" });
};

async function waitReport(service: VisualService, runId: string) {
  for (let i = 0; i < 300; i += 1) {
    const view = service.get(runId);
    if (view?.kind === "report") return view.report;
    await Bun.sleep(10);
  }
  throw new Error("run did not finalize");
}

const helloDoc = async (id: string) => {
  const original = prototypeDocSchema.parse(await Bun.file("test/fixtures/host-content.json").json());
  return { ...original, id, name: id };
};

/** Запись рендерера эталона, как её пишет резолвер: по умолчанию — рендерер этого процесса. */
function record(overrides: Partial<ReferenceRendererRecord> = {}): ReferenceRendererRecord {
  const report = rendererReport();
  return {
    fingerprint: report.fingerprint, fontManifestHash: null, readinessPolicyHash: report.policyHash,
    epoch: report.rendererVersion, browserVersion: report.browserVersion, launchedExecutable: report.launchedExecutable,
    browserExecutableSha256: report.browserExecutableSha256, source: report.source,
    receiptSha256: null, recordedAt: new Date().toISOString(), ...overrides,
  };
}

const flags = (over: Partial<RendererGuardFlags> = {}): RendererGuardFlags =>
  ({ rendererFlags: false, epoch: "r2", disabled: false, ...over });

/** Прогоняет `check` с временно поднятыми env-флагами (снапшот берётся на `beginCheck`). */
async function withEnv<T>(vars: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { return await body(); }
  finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

describe("evaluateRendererGuard", () => {
  test("легаси-эталон без рендерера: до флагов — advisory, вердикт остаётся за метриками", () => {
    const verdict = evaluateRendererGuard(null, record(), flags());
    expect(verdict.record.state).toBe("unknown");
    expect(verdict.outcomeCode).toBeNull();
    expect(verdict.warnings).toEqual(["renderer_unknown"]);
  });

  test("тот же эталон при EASYUI_RENDERER_FLAGS=1 — stale_renderer, а не ложный процент", () => {
    const verdict = evaluateRendererGuard(null, record(), flags({ rendererFlags: true }));
    expect(verdict.record.state).toBe("unknown");
    expect(verdict.outcomeCode).toBe("stale_renderer");
  });

  test("расхождение отпечатков — renderer_mismatch с перечислением полей", () => {
    const verdict = evaluateRendererGuard(record({ fingerprint: "a".repeat(64) }), record({ fingerprint: "b".repeat(64) }), flags());
    expect(verdict.record.state).toBe("mismatch");
    expect(verdict.outcomeCode).toBe("renderer_mismatch");
    expect(verdict.record.differing).toEqual(["rendererFingerprint"]);
  });

  test("fontManifestHash сравнивается только когда обе стороны его заявили", () => {
    const known = evaluateRendererGuard(record({ fontManifestHash: "aa" }), record({ fontManifestHash: "bb" }), flags());
    expect(known.record.differing).toEqual(["fontManifestHash"]);
    const partial = evaluateRendererGuard(record({ fontManifestHash: null }), record({ fontManifestHash: "bb" }), flags());
    expect(partial.record.state).toBe("matched");
  });

  test("чужая эпоха при флагах — stale_renderer; без флагов эпоха не проверяется", () => {
    const stale = evaluateRendererGuard(record({ epoch: "r1" }), record({ epoch: "r2" }), flags({ rendererFlags: true, epoch: "r2" }));
    expect(stale.outcomeCode).toBe("stale_renderer");
    expect(stale.record.differing).toEqual(["rendererEpoch"]);
    expect(evaluateRendererGuard(record({ epoch: "r1" }), record({ epoch: "r2" }), flags()).outcomeCode).toBeNull();
  });

  test("приоритет кодов: разошлись и отпечаток, и эпоха ⇒ более специфичный renderer_mismatch", () => {
    const verdict = evaluateRendererGuard(record({ fingerprint: "a".repeat(64), epoch: "r1" }), record({ fingerprint: "b".repeat(64), epoch: "r2" }), flags({ rendererFlags: true, epoch: "r2" }));
    expect(verdict.outcomeCode).toBe("renderer_mismatch");
  });

  test("kill-switch: выключенный guard не притворяется совпадением", () => {
    const verdict = evaluateRendererGuard(null, null, flags({ rendererFlags: true, disabled: true }));
    expect(verdict.record.state).toBe("disabled");
    expect(verdict.outcomeCode).toBeNull();
    expect(verdict.warnings).toEqual([]);
  });
});

describe("миграция v28", () => {
  test("аддитивные колонки существуют на обеих таблицах", () => {
    const db = openDatabase(":memory:");
    const columns = (table: string) => (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name);
    expect(columns("visual_references")).toEqual(expect.arrayContaining(["renderer_fingerprint", "renderer_json", "font_manifest_hash", "receipt_sha256", "renderer_recorded_at"]));
    expect(columns("visual_runs")).toEqual(expect.arrayContaining(["renderer_guard", "outcome_code", "candidate_receipt_sha256", "reference_receipt_sha256"]));
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBeGreaterThanOrEqual(28);
  });

  test("аддитивность: ни одна существующая таблица не перестроена", () => {
    const db = openDatabase(":memory:");
    const ddl = () => Object.fromEntries((db.query("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all() as { name: string; sql: string }[]).map((row) => [row.name, row.sql]));
    const before = ddl();
    // Повторный прогон миграции невозможен (ADD COLUMN не идемпотентен), поэтому инвариант
    // проверяется по факту схемы: новых таблиц волна не завела, а обе визуальные таблицы
    // сохранили исходный `CREATE TABLE` с дописанными колонками — то есть rebuild'а не было.
    expect(before.visual_references).toContain("FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE RESTRICT");
    expect(before.visual_runs).toContain("CHECK(status IN ('pass','fail','error','reference_missing'))");
    expect(() => db.query("SELECT * FROM visual_references").all()).not.toThrow();
    expect(() => db.query("SELECT * FROM visual_runs").all()).not.toThrow();
  });

  test("старый образ на БД v28: INSERT без новых колонок проходит, чтение работает", async () => {
    const { db, dir } = await setup();
    const asset = (await new AssetRepo(db, dir).ingest(makePng(4, 4), "image/png")).asset;
    // Ровно тот SQL, который писал код до волны: новые колонки не упомянуты и обязаны быть NULLable.
    db.run("INSERT INTO visual_references (id,fingerprint_json,asset_id,note,created_at) VALUES ('vref_legacy','{}',?,NULL,'now')", [asset.id]);
    db.run("INSERT INTO visual_runs (id,reference_id,reference_asset_id,status,created_at) VALUES ('vrun_legacy','vref_legacy',?,'pass','now')", [asset.id]);
    const repo = new VisualRepo(db, dir);
    const run = repo.getRun("vrun_legacy")!;
    expect(run.outcome_code ?? null).toBeNull();
    expect(repo.runReport(run).rendererGuard).toBeNull();
  });

  test("потребители SELECT * не сериализуют row наружу: набор полей отчёта фиксирован", async () => {
    const { db, dir } = await setup();
    const asset = (await new AssetRepo(db, dir).ingest(makePng(4, 4), "image/png")).asset;
    db.run("INSERT INTO visual_references (id,fingerprint_json,asset_id,note,created_at) VALUES ('vref_shape','{}',?,NULL,'now')", [asset.id]);
    db.run("INSERT INTO visual_runs (id,reference_id,reference_asset_id,status,created_at) VALUES ('vrun_shape','vref_shape',?,'pass','now')", [asset.id]);
    const repo = new VisualRepo(db, dir);
    const report = repo.runReport(repo.getRun("vrun_shape")!) as unknown as Record<string, unknown>;
    // Ни одного сырого имени колонки в ответе: иначе добавление колонки меняло бы контракт HTTP.
    for (const column of ["renderer_guard", "outcome_code", "candidate_receipt_sha256", "reference_receipt_sha256", "candidate_meta_json", "metric_options_json"]) {
      expect(Object.keys(report)).not.toContain(column);
    }
    expect(Object.keys(repo.referencePublic(repo.getReference("vref_shape")!) as unknown as Record<string, unknown>))
      .not.toContain("renderer_json");
  });
});

describe("запись рендерера на эталон (T-B2, оба пути)", () => {
  /** Кладёт в стор receipt снятого кадра и связывает его с ассетом — ровно как это делает R5. */
  async function linkReceipt(dir: string, assetId: string): Promise<string> {
    const receipt = buildCaptureReceipt({
      renderer: rendererReport(), fingerprint: rendererReport().fingerprint, observedBrowserVersion: "test/1", drift: [],
      target: { kind: "prototype", componentId: null, prototypeId: "p", version: null, rev: 1, sourceHash: null, bundleHash: null, dsMetaVersion: null, propsHash: null },
      fontManifestHash: null, readiness: null,
      console: { errors: [], warnings: [], pageErrors: [] }, output: null, timings: {}, captureClean: true,
    });
    const stored = await putReceipt(dir, receipt);
    await putAssetReceipt(dir, assetId, stored.sha256);
    return stored.sha256;
  }

  test("generic PUT /api/visual-references резолвит рендерер по индексу assetId → receipt", async () => {
    const { db, dir } = await setup();
    const handler = createTestHandler(db, { dataDir: dir });
    const asset = (await new AssetRepo(db, dir).ingest(makePng(4, 4), "image/png")).asset;
    const sha = await linkReceipt(dir, asset.id);
    const response = await handler(req("/visual-references", "PUT", { fingerprint: { scope: "component", componentId: "c1", refVersion: 1, viewport: { width: 100, height: 100 }, deviceScaleFactor: 1, theme: "light" }, assetId: asset.id }));
    expect(response.status).toBe(200);
    const body = await response.json() as { id: string; renderer: { fingerprint: string; receiptSha256: string } | null };
    expect(body.renderer?.fingerprint).toBe(rendererReport().fingerprint);
    expect(body.renderer?.receiptSha256).toBe(sha);
    expect(db.query("SELECT renderer_json FROM visual_references WHERE id=?").get(body.id)).not.toEqual({ renderer_json: null });
  });

  test("baseline-коммит пишет рендерер каждому члену набора", async () => {
    const { db, dir } = await setup();
    const handler = createTestHandler(db, { dataDir: dir });
    expect((await handler(req("/prototypes", "POST", { doc: await helloDoc("guard-baseline") }))).status).toBe(201);
    const draft = await (await handler(req("/prototypes/guard-baseline/draft"))).json() as { doc: { screens: { id: string }[] }; rev: number; prototypeInstanceId: string };
    const members: { screenId: string; viewport: { width: number; height: number }; deviceScaleFactor: number; theme: string; assetId: string }[] = [];
    for (const screen of draft.doc.screens) {
      const asset = (await new AssetRepo(db, dir).ingest(makePng(4, 4 + members.length), "image/png")).asset;
      await linkReceipt(dir, asset.id);
      members.push({ screenId: screen.id, viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, theme: "light", assetId: asset.id });
    }
    const committed = await handler(req("/visual-baselines/prototypes/guard-baseline", "PUT", { rev: draft.rev, prototypeInstanceId: draft.prototypeInstanceId, baseGeneration: null, members }));
    expect(committed.status).toBe(200);
    const rows = db.query("SELECT renderer_fingerprint, renderer_json FROM visual_references WHERE deleted_at IS NULL").all() as { renderer_fingerprint: string | null; renderer_json: string | null }[];
    expect(rows.length).toBe(members.length);
    for (const row of rows) {
      expect(row.renderer_fingerprint).toBe(rendererReport().fingerprint);
      expect(row.renderer_json).not.toBeNull();
    }
  });

  test("PNG со стороны (без receipt'а) остаётся честным NULL, а не выдуманным совпадением", async () => {
    const { db, dir } = await setup();
    const handler = createTestHandler(db, { dataDir: dir });
    const asset = (await new AssetRepo(db, dir).ingest(makePng(4, 4), "image/png")).asset;
    const body = await (await handler(req("/visual-references", "PUT", { fingerprint: { scope: "component", componentId: "c2", refVersion: 1, viewport: { width: 100, height: 100 }, deviceScaleFactor: 1, theme: "light" }, assetId: asset.id }))).json() as { renderer: unknown };
    expect(body.renderer).toBeNull();
  });
});

describe("guard в VisualService.drive", () => {
  async function prepare(protoId: string, renderer: ReferenceRendererRecord | null) {
    const { db, dir } = await setup();
    const handler = createTestHandler(db, { dataDir: dir });
    expect((await handler(req("/prototypes", "POST", { doc: await helloDoc(protoId) }))).status).toBe(201);
    const png = makePng(4, 4);
    const asset = (await new AssetRepo(db, dir).ingest(png, "image/png")).asset;
    const repo = new VisualRepo(db, dir);
    const reference = repo.upsertReferencePrivileged(
      { scope: "prototype-screen", prototypeId: protoId, screenId: "welcome", refRevision: 1, viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, theme: "light" },
      asset.id, null, renderer,
    );
    const screenshots = new ScreenshotService({ db, dataDir: dir, serveDist: "dist", captureOrigin: "http://127.0.0.1:8787", chromiumAvailable: true, runJob: candidateRunJob(png) });
    return { db, dir, referenceId: reference.id, service: new VisualService({ db, dataDir: dir, screenshots, runDiff: inProcessDiff }) };
  }

  test("NULL-эталон при выключенных флагах: вердикт по метрикам, guard — advisory", async () => {
    const { service, referenceId } = await prepare("guard-legacy", null);
    const report = await withEnv({ EASYUI_RENDERER_FLAGS: undefined }, async () => waitReport(service, service.check(referenceId, {}).runId));
    expect(report.status).toBe("pass");
    expect(report.diffPercent).toBe(0);
    expect(report.outcomeCode).toBeNull();
    expect(report.rendererGuard?.state).toBe("unknown");
    expect(report.warnings).toEqual(["renderer_unknown"]);
  });

  test("NULL-эталон при EASYUI_RENDERER_FLAGS=1: error/stale_renderer без процента", async () => {
    const { service, referenceId } = await prepare("guard-stale", null);
    const report = await withEnv({ EASYUI_RENDERER_FLAGS: "1" }, async () => waitReport(service, service.check(referenceId, {}).runId));
    expect(report.status).toBe("error");
    expect(report.outcomeCode).toBe("stale_renderer");
    expect(report.diffPercent).toBeNull();
    expect(report.metric).toBeNull();
    expect(report.candidateReceiptSha256).not.toBeNull();
  });

  test("эталон другого рендерера: error/renderer_mismatch с differing[]", async () => {
    const { service, referenceId } = await prepare("guard-mismatch", record({ fingerprint: "f".repeat(64) }));
    const report = await waitReport(service, service.check(referenceId, {}).runId);
    expect(report.status).toBe("error");
    expect(report.outcomeCode).toBe("renderer_mismatch");
    expect(report.rendererGuard?.differing).toEqual(["rendererFingerprint"]);
    expect(report.diffPercent).toBeNull();
    expect(report.referenceReceiptSha256).toBeNull();
  });

  test("совпавший рендерер: guard matched, вердикт обычный", async () => {
    const { service, referenceId } = await prepare("guard-matched", record());
    const report = await waitReport(service, service.check(referenceId, {}).runId);
    expect(report.status).toBe("pass");
    expect(report.rendererGuard?.state).toBe("matched");
    expect(report.warnings).toEqual([]);
  });

  test("kill-switch EASYUI_RENDERER_GUARD_DISABLED=1 возвращает доволновое поведение", async () => {
    const { service, referenceId } = await prepare("guard-off", null);
    const report = await withEnv({ EASYUI_RENDERER_FLAGS: "1", EASYUI_RENDERER_GUARD_DISABLED: "1" }, async () => waitReport(service, service.check(referenceId, {}).runId));
    expect(report.status).toBe("pass");
    expect(report.outcomeCode).toBeNull();
    expect(report.rendererGuard?.state).toBe("disabled");
  });
});
