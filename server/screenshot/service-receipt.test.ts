import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createTestHandler } from "../test-auth";
import { openDatabase } from "../db";
import { BOOTSTRAP_ADMIN_ID } from "../users";
import { ApiError } from "../http";
import { authorizeReceiptOwner } from "../routes/screenshots";
import { getAssetReceipt, getJobReceipt } from "../capture/receiptStore";
import { ScreenshotService, type RunJob } from "./service";

// R5 (план 2026-08-03-renderer-contract-2 §5 R5): receipt на **asset-канале** доставки — том
// самом, который до волны не нёс ни рендерера, ни readiness (дыра §1.6), — его job-scoped ручка
// и авторизация, не зависящая от живой джобы.

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const COMPONENT_ID = "receipt-probe";
const PNG_1X1 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1]);

const source = `import { z } from "zod";
export const definition = {
  props: z.strictObject({ label: z.string().default("receipt") }),
  events: [], slots: [],
  description: "Receipt probe component",
  atomicLevel: "atom" as const,
  examples: { full: { label: "receipt" } },
};
export default function ReceiptProbe({ props }: any) {
  return <div><span>{props.label}</span></div>;
}`;

const req = (url: string, method = "GET", value?: unknown) =>
  new Request(`http://test/api${url}`, {
    method,
    headers: value ? { "content-type": "application/json" } : undefined,
    body: value ? JSON.stringify(value) : undefined,
  });

/** Воркер-заглушка волны R5: приносит тайминги, sha кадра и бокс поверхности. */
const workerOk: RunJob = async () => ({
  ok: true as const,
  pngBase64: Buffer.from(PNG_1X1).toString("base64"),
  pngSha256: "6".repeat(64),
  surfaceRect: { x: 0, y: 0, width: 320, height: 200 },
  width: 1, height: 1,
  timings: { navigateMs: 12, readyMs: 34, screenshotMs: 5, totalMs: 60 },
  consoleErrors: [], consoleWarnings: [], pageErrors: [],
  browserVersion: "test/1",
  readiness: {
    met: true, policyHash: "5".repeat(64), elapsedMs: 30,
    evidence: {
      fontFaces: [{ family: "YS Text", weight: "400", style: "normal", status: "loaded", required: true, checked: true }],
      images: { total: 0, decoded: 0, failed: 0 },
      pendingRequests: [], framesWaited: 2, animationsDisabled: true,
      themeResources: { tokens: [], icons: [], images: [] },
    },
  },
});

/**
 * Тот же воркер, но с шумной консолью (W10): два одинаковых favicon-сообщения, один
 * ResizeObserver и одна настоящая ошибка прототипа — чтобы было видно, что агрегат сворачивает
 * ровно подавленное, а продуктовая ошибка остаётся продуктовой.
 */
const workerNoisy: RunJob = async (job, deadlineMs) => ({
  ...await workerOk(job, deadlineMs),
  consoleErrors: [
    "Failed to load resource: 404 (http://127.0.0.1:8787/favicon.ico?v=1)",
    "Failed to load resource: 404 (http://127.0.0.1:8787/favicon.ico?v=2)",
    "ResizeObserver loop completed with undelivered notifications.",
    "Blocked script (https://cdn.example.com/tracker.js)",
  ],
  pageErrors: ["boom in prototype code"],
} as never);

async function setup(now?: () => number, runJob: RunJob = workerOk) {
  const dir = await mkdtemp(resolve(process.cwd(), ".receipt-service-test-"));
  dirs.push(dir);
  const db: Database = openDatabase(":memory:");
  const handler = createTestHandler(db, { dataDir: dir });
  const created = await handler(req("/components", "POST", {
    designSystem: "yandex-pay", id: COMPONENT_ID, name: "ReceiptProbe", source,
    intent: "Renders a receipt probe label so capture receipts have a real target",
  }));
  expect(created.status).toBe(201);
  const service = new ScreenshotService({
    db, dataDir: dir, serveDist: "dist", captureOrigin: "http://127.0.0.1:8787",
    chromiumAvailable: true, runJob, ...(now ? { now } : {}),
  });
  // Ручка receipt'а идёт через тот же handler, что и все остальные роуты.
  const api = createTestHandler(db, { dataDir: dir, screenshots: service });
  return { dir, db, service, api };
}

async function waitDone(service: ScreenshotService, jobId: string) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const status = service.get(jobId);
    if (status.status === "done" || status.status === "error") return status;
    await Bun.sleep(10);
  }
  return service.get(jobId);
}

describe("capture receipt on the asset delivery channel (R5)", () => {
  test("asset-джоба возвращает receiptSha256, а ручка отдаёт документ с рендерером и faces", async () => {
    const { dir, service, api } = await setup();
    const { jobId } = await service.enqueueComponentDraft(COMPONENT_ID, BOOTSTRAP_ADMIN_ID, { viewport: { width: 320, height: 200 } });
    const status = await waitDone(service, jobId);
    expect(status.status).toBe("done");
    const result = status.result!;
    expect(result.kind).toBe("image");
    const receiptSha = (result as { receiptSha256?: string }).receiptSha256;
    expect(receiptSha).toMatch(/^[0-9a-f]{64}$/);

    const response = await api(req(`/screenshot-jobs/${jobId}/receipt`));
    expect(response.status).toBe(200);
    const body = await response.json() as { receiptSha256: string; receipt: Record<string, unknown> & {
      renderer: { fingerprint: string; observedBrowserVersion: string | null };
      resources: { fontFaces: { family: string }[] };
      output: { surfaceRect: unknown };
      timings: { navigateMs: number | null };
    } };
    expect(body.receiptSha256).toBe(receiptSha!);
    expect(body.receipt.receiptVersion).toBe(1);
    // Рендерер и faces — то, ради чего receipt заведён на этом канале (§1.6).
    expect(body.receipt.renderer.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(body.receipt.renderer.observedBrowserVersion).toBe("test/1");
    expect(body.receipt.resources.fontFaces[0].family).toBe("YS Text");
    expect(body.receipt.target).toMatchObject({ kind: "component-draft", componentId: COMPONENT_ID });
    expect(body.receipt.output).toMatchObject({ pngSha256: "6".repeat(64), dpr: 1, colorScheme: "light" });
    expect(body.receipt.output.surfaceRect).toEqual({ x: 0, y: 0, width: 320, height: 200 });
    expect(body.receipt.timings.navigateMs).toBe(12);
    expect(body.receipt.verdict).toMatchObject({ captureClean: true, readinessMet: true });

    // Индекс `assetId → receipt` пишется после ингеста (V-N7) — по нему R6 резолвит рендерер эталона.
    const assetId = (result as { assetId: string }).assetId;
    expect((await getAssetReceipt(dir, assetId))?.receiptSha256).toBe(receiptSha!);
    expect((await getJobReceipt(dir, jobId))?.ownerKey).toBe(`component:${COMPONENT_ID}`);
  });

  test("receipt переживает вычищенную по TTL джобу: ручка отвечает, `GET job` — уже нет", async () => {
    let clock = Date.now();
    const { service, api } = await setup(() => clock);
    const { jobId } = await service.enqueueComponentDraft(COMPONENT_ID, BOOTSTRAP_ADMIN_ID, { viewport: { width: 320, height: 200 } });
    await waitDone(service, jobId);
    // RESULT_TTL_MS джобы — 10 минут; TTL стора — 7 суток (V-N4).
    clock += 30 * 60_000;
    expect(() => service.get(jobId)).toThrow(ApiError);
    const response = await api(req(`/screenshot-jobs/${jobId}/receipt`));
    expect(response.status).toBe(200);
    expect((await response.json() as { receipt: { receiptVersion: number } }).receipt.receiptVersion).toBe(1);
  });

  /**
   * W10 (план 2026-08-07 §W10, P2.2): подавленный шум перестаёт быть невидимым. `suppressedCount`
   * результата и агрегат `console.suppressed` receipt'а — одно и то же множество сообщений,
   * поэтому сумма счётчиков обязана совпадать со счётчиком.
   */
  test("подавленный шум едет сигнатурами в receipt, а его счётчик — в результате джобы", async () => {
    const { service, api } = await setup(undefined, workerNoisy);
    const { jobId } = await service.enqueueComponentDraft(COMPONENT_ID, BOOTSTRAP_ADMIN_ID, { viewport: { width: 320, height: 200 } });
    const status = await waitDone(service, jobId);
    expect(status.status).toBe("done");
    const result = status.result as { suppressedCount: number; infraNoise: string[]; productErrors: string[]; consoleErrors: string[] };
    // Продуктовая ошибка остаётся продуктовой: агрегат сворачивает только подавленное.
    expect(result.productErrors).toEqual(["boom in prototype code"]);
    expect(result.suppressedCount).toBe(result.infraNoise.length);
    expect(result.suppressedCount).toBe(4);

    const body = await (await api(req(`/screenshot-jobs/${jobId}/receipt`))).json() as {
      receipt: { console: { errors: string[]; suppressed: { signature: string; count: number }[] } };
    };
    // Два favicon-сообщения различались только query — одна сигнатура со счётчиком 2.
    expect(body.receipt.console.suppressed).toEqual([
      { signature: "Failed to load resource: 404 (http://127.0.0.1:8787/favicon.ico)", count: 2 },
      { signature: "Blocked script (https://cdn.example.com/tracker.js)", count: 1 },
      { signature: "ResizeObserver loop completed with undelivered notifications.", count: 1 },
    ]);
    expect(body.receipt.console.suppressed.reduce((sum, item) => sum + item.count, 0)).toBe(result.suppressedCount);
    // Аддитивность: сырой список консоли остаётся дословным.
    expect(body.receipt.console.errors).toEqual(result.consoleErrors);
  });

  test("kill-switch: с EASYUI_CAPTURE_RECEIPTS_DISABLED=1 receipt не пишется, кадр не страдает", async () => {
    process.env.EASYUI_CAPTURE_RECEIPTS_DISABLED = "1";
    try {
      const { service, api } = await setup();
      const { jobId } = await service.enqueueComponentDraft(COMPONENT_ID, BOOTSTRAP_ADMIN_ID, { viewport: { width: 320, height: 200 } });
      const status = await waitDone(service, jobId);
      expect(status.status).toBe("done");
      expect((status.result as { receiptSha256?: string }).receiptSha256).toBeUndefined();
      expect((status.result as { assetId?: string }).assetId).toBeTruthy();
      expect((await api(req(`/screenshot-jobs/${jobId}/receipt`))).status).toBe(404);
    } finally {
      delete process.env.EASYUI_CAPTURE_RECEIPTS_DISABLED;
    }
  });

  test("share/capture-принципал получает 403 на чужой job-receipt, владелец — доступ", async () => {
    const { db } = await setup();
    const ownerKey = `component:${COMPONENT_ID}`;
    const share = { kind: "share" as const, scope: { grantId: "g1", prototypeId: "other-prototype", version: 1, allowedUrls: [] } };
    const capture = { kind: "capture" as const, scope: { token: "t1", allowedUrls: [] } };
    for (const principal of [share, capture, { kind: "anonymous" as const }]) {
      expect(() => authorizeReceiptOwner(db, ownerKey, principal)).toThrow(ApiError);
      try { authorizeReceiptOwner(db, ownerKey, principal); }
      catch (error) { expect((error as ApiError).status).toBe(403); }
    }
    // Чужой пользователь — тоже 403 (владение компонентом проверяется в БД, а не по памяти).
    db.query("INSERT INTO users (id,name,password_hash,is_admin,created_at) VALUES (?,?,?,?,?)")
      .run("user_other", "Other", "x", 0, new Date().toISOString());
    try { authorizeReceiptOwner(db, ownerKey, { kind: "user", userId: "user_other", name: "Other", isAdmin: false }); }
    catch (error) { expect((error as ApiError).status).toBe(403); }
    // Владелец проходит; неразбираемый ключ владения не отдаёт документ никому.
    expect(() => authorizeReceiptOwner(db, ownerKey, { kind: "user", userId: BOOTSTRAP_ADMIN_ID, name: "Test Admin", isAdmin: true })).not.toThrow();
    expect(() => authorizeReceiptOwner(db, "garbage", { kind: "user", userId: BOOTSTRAP_ADMIN_ID, name: "Test Admin", isAdmin: true })).toThrow(ApiError);
  });
});
