import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildCaptureReceipt, canonicalReceiptJson, type CaptureReceipt, type ReceiptRendererDeclaration } from "../../src/capture/receipt";
import {
  gcReceipts, getAssetReceipt, getJobReceipt, putAssetReceipt, putJobReceipt, putReceipt,
  readReceipt, readReceiptBytes, receiptPath, receiptsRoot, RECEIPT_TTL_MS, setReceiptPinProvider,
} from "./receiptStore";

// R5 (план 2026-08-03-renderer-contract-2 §2.1 P7, §5 R5). Предмет теста — контракт стора:
// адресация по sha канонического JSON, два индекса (job с ключом владения, asset), и свипер,
// который не вытесняет запиненное — то есть receipt'ы живых джоб и живых per-run манифестов.

const dirs: string[] = [];
afterEach(async () => {
  setReceiptPinProvider(null);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(resolve(process.cwd(), ".receipt-store-test-"));
  dirs.push(dir);
  return dir;
};

const declaration: ReceiptRendererDeclaration = {
  rendererSchema: 2, rendererVersion: "r2", os: "linux", arch: "x64", nodeVersion: "24.5.0",
  playwrightVersion: "1.61.1", browserName: "chromium", browserVersion: "149.0.7827.55",
  browserRevision: "1210", launchedExecutable: "chrome-headless-shell",
  browserExecutableSha256: null, fontStackSha256: null, appFontsSha256: null, systemLibsHash: null,
  launchDeterminismArgsHash: "e".repeat(64), contextOptionsHash: "f".repeat(64),
  colorProfile: "srgb", source: "fallback", provenance: null,
};

const receiptOf = (label: string): CaptureReceipt => buildCaptureReceipt({
  renderer: declaration,
  fingerprint: "7".repeat(64),
  target: { kind: "component", componentId: label, version: 1 },
  readiness: { met: true, policyHash: "5".repeat(64), codes: [], evidence: null },
  console: { errors: [], warnings: [], pageErrors: [] },
  output: { viewport: { width: 100, height: 100 }, dpr: 1, colorScheme: "light", pngWidth: 100, pngHeight: 100, pngSha256: "6".repeat(64), surfaceRect: null },
  timings: { totalMs: 10 },
  captureClean: true,
});

const JOB_ID = "job_00000000-0000-4000-8000-000000000001";
const ASSET_ID = `asset_${"a".repeat(64)}`;

/** Стареет файл на диске: TTL/LRU свипера считаются по mtime. */
const age = async (path: string, ms: number): Promise<void> => {
  const when = new Date(Date.now() - ms);
  await utimes(path, when, when);
};

describe("receipt store (R5)", () => {
  test("адрес — sha канонического JSON; повторная запись того же документа идемпотентна", async () => {
    const dir = await tempDir();
    const receipt = receiptOf("one");
    const first = await putReceipt(dir, receipt);
    const second = await putReceipt(dir, receipt);
    expect(second.sha256).toBe(first.sha256);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Байты в сторе — ровно канонический JSON: гейт `render` кладёт их в CAS приёмки, и адрес
    // receipt'а обязан совпасть с адресом его CAS-копии.
    expect(await readReceiptBytes(dir, first.sha256)).toBe(canonicalReceiptJson(receipt));
    expect((await readReceipt(dir, first.sha256))?.target.componentId).toBe("one");
    expect(await readReceipt(dir, "z".repeat(64))).toBeNull();
    // Адрес не бывает произвольным путём.
    expect(receiptPath(dir, "../../etc/passwd")).toBeNull();
  });

  test("индекс джобы несёт ключ владения и переживает саму джобу; индекс ассета пишется отдельно", async () => {
    const dir = await tempDir();
    const stored = await putReceipt(dir, receiptOf("two"));
    await putJobReceipt(dir, JOB_ID, { receiptSha256: stored.sha256, ownerKey: "component:yp-button" });
    await putAssetReceipt(dir, ASSET_ID, stored.sha256);

    const link = await getJobReceipt(dir, JOB_ID);
    expect(link?.receiptSha256).toBe(stored.sha256);
    // Ключ владения записан рядом со ссылкой: авторизация ручки не зависит от живой джобы (V-N4).
    expect(link?.ownerKey).toBe("component:yp-button");
    expect((await getAssetReceipt(dir, ASSET_ID))?.receiptSha256).toBe(stored.sha256);

    // Мусорные ключи не создают записей и не читаются.
    await putJobReceipt(dir, "../escape", { receiptSha256: stored.sha256, ownerKey: "component:x" });
    expect(await getJobReceipt(dir, "../escape")).toBeNull();
    expect(await getAssetReceipt(dir, "not-an-asset")).toBeNull();
  });

  test("свипер вытесняет по TTL, но не трогает запиненное живой джобой или манифестом приёмки", async () => {
    const dir = await tempDir();
    const live = await putReceipt(dir, receiptOf("live-job"));
    const manifest = await putReceipt(dir, receiptOf("cas-manifest"));
    const stale = await putReceipt(dir, receiptOf("stale"));
    for (const sha of [live.sha256, manifest.sha256, stale.sha256]) await age(receiptPath(dir, sha)!, RECEIPT_TTL_MS * 2);

    // Пины: sha живого job-результата и sha, на который ссылается per-run манифест приёмки
    // (у receipt'а и его CAS-копии один адрес — см. `referencedArtifactShas`).
    const report = await gcReceipts(dir, { pinned: () => new Set([live.sha256, manifest.sha256]) });
    expect(report.removed).toBe(1);
    expect(await readReceipt(dir, live.sha256)).not.toBeNull();
    expect(await readReceipt(dir, manifest.sha256)).not.toBeNull();
    expect(await readReceipt(dir, stale.sha256)).toBeNull();
  });

  test("потолок байт вытесняет по LRU и снова щадит запиненное", async () => {
    const dir = await tempDir();
    const oldest = await putReceipt(dir, receiptOf("oldest"));
    const pinnedOld = await putReceipt(dir, receiptOf("pinned-old"));
    const newest = await putReceipt(dir, receiptOf("newest"));
    // Все три старше grace-периода, но моложе TTL: вытеснение только по потолку.
    await age(receiptPath(dir, oldest.sha256)!, 60 * 60_000);
    await age(receiptPath(dir, pinnedOld.sha256)!, 50 * 60_000);
    await age(receiptPath(dir, newest.sha256)!, 40 * 60_000);

    // Потолок ровно такой, что вытеснения одной (самой давней) записи достаточно.
    const cap = pinnedOld.bytes + newest.bytes;
    const report = await gcReceipts(dir, { maxBytes: cap, pinned: () => new Set([pinnedOld.sha256]) });
    expect(report.removed).toBe(1);
    expect(await readReceipt(dir, oldest.sha256)).toBeNull();
    expect(await readReceipt(dir, pinnedOld.sha256)).not.toBeNull();
    expect(await readReceipt(dir, newest.sha256)).not.toBeNull();
    // Потолок остался превышен, потому что остаток запинен: пин не вытесняется, но и не врёт
    // про размер — его байты учтены в отчёте.
    expect(report.totalBytes).toBeGreaterThan(0);
  });

  test("отказ пин-провайдера не вытесняет ничего; висячие ссылки индекса убираются", async () => {
    const dir = await tempDir();
    const stored = await putReceipt(dir, receiptOf("guarded"));
    await age(receiptPath(dir, stored.sha256)!, RECEIPT_TTL_MS * 2);
    const refused = await gcReceipts(dir, { pinned: () => { throw new Error("pins unavailable"); } });
    expect(refused.removed).toBe(0);
    expect(await readReceipt(dir, stored.sha256)).not.toBeNull();

    // Ссылка на несуществующий receipt — мусор, но только после grace-периода.
    const danglingDir = resolve(receiptsRoot(dir), "index", "jobs");
    await mkdir(danglingDir, { recursive: true });
    const dangling = resolve(danglingDir, "job_00000000-0000-4000-8000-000000000009.json");
    await writeFile(dangling, JSON.stringify({ receiptSha256: "b".repeat(64), ownerKey: "component:x", createdAt: new Date().toISOString() }));
    await age(dangling, 60 * 60_000);
    const swept = await gcReceipts(dir, { pinned: () => new Set([stored.sha256]) });
    expect(swept.removedLinks).toBe(1);
    await expect(stat(dangling)).rejects.toThrow();
    expect((await readdir(danglingDir)).length).toBe(0);
  });
});
