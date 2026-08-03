import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createTestHandler } from "../test-auth";
import { openDatabase } from "../db";
import { BOOTSTRAP_ADMIN_ID } from "../users";
import { sha256 } from "../components/pipeline";
import { candidateBundlePresent, candidatesRoot, gcCandidates, writeCandidate } from "../components/candidates";
import { classifyJobFailure, jobOutcomeOfError, MAX_QUEUE, ScreenshotService, type RunJob } from "./service";
import { ApiError } from "../http";

// W1a (план 2026-08-03, §2 A4/A10 + §4 пп.5–7): байтовый канал мимо asset-store,
// постановка по явной ревизии кандидата, резервирование очереди, таксономия jobOutcome
// и пин кандидата против `gcCandidates`. Компонентный id уникален для файла: import-кэши
// верификации живут в общем процессе `bun test`.

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

const COMPONENT_ID = "acc-capture";
const PNG_1X1 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1]);

const componentSource = (label: string) => `import { z } from "zod";
export const definition = {
  props: z.strictObject({ label: z.string().default("${label}") }),
  events: [], slots: [],
  description: "Acceptance capture probe component",
  atomicLevel: "atom" as const,
  examples: { full: { label: "${label}" } },
};
export default function AccCapture({ props }: any) {
  return <div><span>{props.label}</span></div>;
}`;

const req = (url: string, method = "GET", value?: unknown) =>
  new Request(`http://test/api${url}`, {
    method,
    headers: value ? { "content-type": "application/json" } : undefined,
    body: value ? JSON.stringify(value) : undefined,
  });

const neverResolves: RunJob = () => new Promise(() => {});
const imageOk = { ok: true as const, pngBase64: Buffer.from(PNG_1X1).toString("base64"), width: 1, height: 1, consoleErrors: [], pageErrors: [], browserVersion: "test/1" };
const imageStub: RunJob = async () => imageOk;

function makeService(db: Database, dir: string, runJob: RunJob = neverResolves) {
  return new ScreenshotService({ db, dataDir: dir, serveDist: "dist", captureOrigin: "http://127.0.0.1:8787", chromiumAvailable: true, runJob });
}

async function waitDone(service: ScreenshotService, jobId: string) {
  for (let i = 0; i < 300; i++) {
    const status = service.get(jobId);
    if (status.status === "done" || status.status === "error") return status;
    await Bun.sleep(10);
  }
  return service.get(jobId);
}

const assetCount = (db: Database) => (db.query("SELECT COUNT(*) AS n FROM assets").get() as { n: number }).n;

/**
 * Создаёт компонент и прогревает candidate-кэш через существующий draft-путь (он же
 * собирает бандл, который acceptance потом снимает по явной ревизии).
 */
async function setupCandidate(runJob: RunJob = imageStub) {
  const dir = await mkdtemp(resolve(process.cwd(), ".acc-capture-test-"));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  const source = componentSource("first");
  const h = createTestHandler(db, { dataDir: dir });
  const created = await h(req("/components", "POST", {
    designSystem: "yandex-pay", id: COMPONENT_ID, name: "AccCapture", source,
    intent: "Renders an acceptance capture probe label for pipeline tests",
  }));
  expect(created.status).toBe(201);
  const service = makeService(db, dir, runJob);
  // Прогрев кандидата head'а: тот же `getOrComputeCandidate`, что зовёт validate-префлайт.
  const warm = await service.enqueueComponentDraft(COMPONENT_ID, BOOTSTRAP_ADMIN_ID, { viewport: { width: 320, height: 200 } });
  // `neverResolves` — прогрев остаётся бегущей джобой намеренно (тест резервирования очереди).
  if (runJob !== neverResolves) await waitDone(service, warm.jobId);
  return { dir, db, service, handler: h, sourceHash: sha256(source), source };
}

describe("acceptance capture layer (W1a)", () => {
  test("bytes delivery keeps the PNG out of the asset store; asset delivery is unchanged", async () => {
    // Кадр отличается от прогревочного, поэтому ingest дал бы **новую** строку assets —
    // равенство счётчика после байтовой джобы означает именно «не ингестили».
    const otherPng = new Uint8Array([...PNG_1X1, 7, 7, 7, 7]);
    const { db, dir, sourceHash } = await setupCandidate();
    // Отдельный сервис поверх того же кэша кандидатов: прогрев уже ингестил PNG_1X1.
    const service = makeService(db, dir, async () => ({ ...imageOk, pngBase64: Buffer.from(otherPng).toString("base64") }));
    const before = assetCount(db);

    const bytesJob = await service.enqueueComponentCandidate(COMPONENT_ID, { rev: 1, sourceHash }, {
      viewport: { width: 320, height: 200 }, deliver: "bytes",
    });
    const bytesStatus = await waitDone(service, bytesJob.jobId);
    expect(bytesStatus.status).toBe("done");
    expect(bytesStatus.result?.kind).toBe("image-bytes");
    if (bytesStatus.result?.kind !== "image-bytes") throw new Error("expected image-bytes result");
    expect(Array.from(bytesStatus.result.bytes)).toEqual(Array.from(otherPng));
    expect(bytesStatus.result.width).toBe(1);
    expect(bytesStatus.result.height).toBe(1);
    expect(bytesStatus.result.captureClean).toBe(true);
    expect(bytesStatus.result.draftRev).toBe(1);
    expect(service.outcome(bytesJob.jobId)).toBe("ok");
    // A4: acceptance-кадр не ингестится — таблица assets не выросла ни на строку.
    expect(assetCount(db)).toBe(before);

    const assetJob = await service.enqueueComponentCandidate(COMPONENT_ID, { rev: 1, sourceHash }, {
      viewport: { width: 320, height: 200 },
    });
    const assetStatus = await waitDone(service, assetJob.jobId);
    expect(assetStatus.status).toBe("done");
    expect(assetStatus.result).toMatchObject({ kind: "image", imageProduced: true, assetId: expect.stringMatching(/^asset_/) });
    expect(assetCount(db)).toBe(before + 1);
    db.close();
  });

  test("enqueue by rev freezes the candidate build and 409s once the bundle is gone", async () => {
    const { dir, db, service, handler, sourceHash } = await setupCandidate();

    // Head уезжает на rev 2 — снимаемый билд обязан остаться кандидатским (rev 1).
    const saved = await handler(req(`/components/${COMPONENT_ID}`, "PUT", { source: componentSource("second"), baseRev: 1 }));
    expect(saved.status).toBe(200);

    const pinned = await service.enqueueComponentCandidate(COMPONENT_ID, { rev: 1, sourceHash }, { viewport: { width: 320, height: 200 }, deliver: "bytes" });
    expect(pinned.expected).toMatchObject({ kind: "component-draft", componentId: COMPONENT_ID, rev: 1, sourceHash });
    expect(service.peek(pinned.jobId)?.draft?.bundleUrl).toBe(`/api/components/${COMPONENT_ID}/draft/${sourceHash}/bundle.js`);
    expect(service.peek(pinned.jobId)?.allowedUrls).toContain(`/api/components/${COMPONENT_ID}/draft/${sourceHash}/bundle.js`);

    // Пара {rev, sourceHash} не с этой ревизии — не молчаливая пересъёмка, а отказ.
    await expect(service.enqueueComponentCandidate(COMPONENT_ID, { rev: 2, sourceHash }, { viewport: { width: 320, height: 200 } }))
      .rejects.toMatchObject({ status: 409, code: "candidate_stale" });

    // Head-ревизия кандидатом не собиралась: пересборки по произвольному rev нет.
    await expect(service.enqueueComponentCandidate(COMPONENT_ID, { rev: 2, sourceHash: sha256(componentSource("second")) }, { viewport: { width: 320, height: 200 } }))
      .rejects.toMatchObject({ status: 409, code: "candidate_evicted" });

    // Вытеснение бандла кандидата — тот же 409.
    expect(await candidateBundlePresent(dir, COMPONENT_ID, sourceHash)).toBe(true);
    await rm(candidatesRoot(dir), { recursive: true, force: true });
    expect(await candidateBundlePresent(dir, COMPONENT_ID, sourceHash)).toBe(false);
    await expect(service.enqueueComponentCandidate(COMPONENT_ID, { rev: 1, sourceHash }, { viewport: { width: 320, height: 200 } }))
      .rejects.toMatchObject({ status: 409, code: "candidate_evicted" });
    db.close();
  });

  test("queue reservation refuses background enqueues at MAX-2 while interactive still fits", async () => {
    const { db, service, sourceHash } = await setupCandidate(neverResolves);
    const shot = { viewport: { width: 320, height: 200 } };
    // Прогрев занял слот бегущей джобы (runJob не резолвится), очередь пуста.
    expect(service.queueDepth()).toBe(0);
    for (let i = 0; i < MAX_QUEUE - 2; i++) {
      await service.enqueueComponentCandidate(COMPONENT_ID, { rev: 1, sourceHash }, { ...shot, background: false });
    }
    expect(service.queueDepth()).toBe(MAX_QUEUE - 2);
    expect(service.hasBackgroundCapacity()).toBe(false);
    await expect(service.enqueueComponentCandidate(COMPONENT_ID, { rev: 1, sourceHash }, shot))
      .rejects.toMatchObject({ status: 429, code: "queue_full" });
    // Интерактиву зарезервированные слоты остаются доступны.
    await service.enqueueComponentCandidate(COMPONENT_ID, { rev: 1, sourceHash }, { ...shot, background: false });
    await service.enqueueComponentDraft(COMPONENT_ID, BOOTSTRAP_ADMIN_ID, shot);
    expect(service.queueDepth()).toBe(MAX_QUEUE);
    await expect(service.enqueueComponentDraft(COMPONENT_ID, BOOTSTRAP_ADMIN_ID, shot))
      .rejects.toMatchObject({ status: 429, code: "queue_full" });
    db.close();
  });

  test("jobOutcome classifies worker failures and enqueue refusals", async () => {
    const { db, service, sourceHash } = await setupCandidate(async () => ({ ok: false, error: "capture timed out after 60000ms" }));
    const timedOut = await service.enqueueComponentCandidate(COMPONENT_ID, { rev: 1, sourceHash }, { viewport: { width: 320, height: 200 }, deliver: "bytes" });
    const status = await waitDone(service, timedOut.jobId);
    expect(status.status).toBe("error");
    expect(service.outcome(timedOut.jobId)).toBe("timeout");
    db.close();

    expect(classifyJobFailure("worker produced no result: killed")).toBe("worker_crash");
    expect(classifyJobFailure("worker spawn failed: ENOENT")).toBe("subprocess_error");
    expect(classifyJobFailure("worker result was not JSON: <html>")).toBe("subprocess_error");
    expect(jobOutcomeOfError(new ApiError(429, "queue_full", "full"))).toBe("queue_full");
    expect(jobOutcomeOfError(new Error("capture timed out after 1ms"))).toBe("timeout");
  });
});

describe("candidate GC pins (A10)", () => {
  test("pinned sourceHash survives TTL and LRU eviction", async () => {
    const dir = await mkdtemp(resolve(process.cwd(), ".acc-gc-test-"));
    dirs.push(dir);
    const pinnedHash = "a".repeat(64);
    const looseHash = "b".repeat(64);
    // `writeCandidate` сам гоняет GC-on-write, поэтому записи создаются свежими, а протухание
    // моделируется отрицательным ttl уже в самом прогоне GC.
    for (const hash of [pinnedHash, looseHash]) {
      await writeCandidate(dir, {
        version: 1, sourceHash: hash, componentIds: [COMPONENT_ID], createdAt: new Date().toISOString(), ok: true, bundleHash: hash,
      }, "export default null;\n");
    }

    // TTL-вытеснение: запиненная запись остаётся, обычная уходит.
    const pinnedGc = await gcCandidates(dir, { ttlMs: -1, pinned: () => new Set([pinnedHash]) });
    expect(pinnedGc.removed).toBe(1);
    expect(await candidateBundlePresent(dir, COMPONENT_ID, pinnedHash)).toBe(true);
    expect(await candidateBundlePresent(dir, COMPONENT_ID, looseHash)).toBe(false);

    // Потолок байт: запиненная запись не вытесняется даже при maxBytes: 0.
    await gcCandidates(dir, { maxBytes: 0, pinned: () => new Set([pinnedHash]) });
    expect(await candidateBundlePresent(dir, COMPONENT_ID, pinnedHash)).toBe(true);

    // Тот же кэш без пина — запись уходит по TTL (регресс-контроль дефолтного пути).
    await gcCandidates(dir, { ttlMs: -1 });
    expect(await candidateBundlePresent(dir, COMPONENT_ID, pinnedHash)).toBe(false);
    await expect(stat(resolve(candidatesRoot(dir), pinnedHash))).rejects.toThrow();
  });
});
