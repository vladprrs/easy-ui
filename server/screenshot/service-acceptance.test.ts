import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createTestHandler } from "../test-auth";
import { openDatabase } from "../db";
import { BOOTSTRAP_ADMIN_ID } from "../users";
import { sha256 } from "../components/pipeline";
import { candidateBundlePresent, candidatesRoot, gcCandidates, setCandidatePinProvider, writeCandidate } from "../components/candidates";
import { classifyJobFailure, jobOutcomeOfError, MAX_QUEUE, ScreenshotService, type RunJob } from "./service";
import { ApiError } from "../http";
import { canonicalStringify, readyToExpected } from "../../scripts/screenshot-worker.mjs";

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

  test("process-wide pin provider covers GC without explicit pinned (A10, GC-on-write)", async () => {
    const dir = await mkdtemp(resolve(process.cwd(), ".acc-gc-proc-test-"));
    dirs.push(dir);
    const pinnedHash = "c".repeat(64);
    await writeCandidate(dir, {
      version: 1, sourceHash: pinnedHash, componentIds: [COMPONENT_ID], createdAt: new Date().toISOString(), ok: true, bundleHash: pinnedHash,
    }, "export default null;\n");
    setCandidatePinProvider(() => new Set([pinnedHash]));
    try {
      // Явного `pinned` нет — так GC вызывается из writeCandidate; провайдер обязан сработать.
      await gcCandidates(dir, { ttlMs: -1 });
      expect(await candidateBundlePresent(dir, COMPONENT_ID, pinnedHash)).toBe(true);
    } finally {
      setCandidatePinProvider(null);
    }
    await gcCandidates(dir, { ttlMs: -1 });
    expect(await candidateBundlePresent(dir, COMPONENT_ID, pinnedHash)).toBe(false);
  });
});

/**
 * Байт-идентичность handshake'а бесслотового драфта (план 2026-08-05 §«Design invariants»,
 * T2.2). Голден снят на НЕИЗМЕНЁННОМ коде до появления `slotsHash`: `readyToExpected` —
 * явный whitelist, и новое поле обязано добавляться **условно**, иначе каждый бесслотовый
 * капчур получил бы новый пре-образ сравнения и все закэшированные джобы разъехались бы.
 */
describe("readyToExpected golden (slot-free component-draft)", () => {
  const SLOT_FREE_DRAFT_READY = {
    status: "ready",
    kind: "component-draft",
    componentId: "acc-capture",
    rev: 3,
    sourceHash: "s".repeat(64),
    bundleHash: "b".repeat(64),
    propsHash: "p".repeat(64),
    dsMetaVersion: 2,
    rendererBuild: null,
    // Поля W4 едут рядом и в сравнение не входят — они и не должны попасть в голден.
    readiness: { met: true, policyHash: "ph", elapsedMs: 1, evidence: {} },
  };
  // Канонический пре-образ, которым воркер сравнивает ready и expected (screenshot-worker.mjs:221).
  const GOLDEN_CANONICAL = '{"bundleHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","componentId":"acc-capture","dsMetaVersion":2,"kind":"component-draft","propsHash":"pppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp","rendererBuild":null,"rev":3,"sourceHash":"ssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssss"}';
  // Порядок ключей самого объекта тоже зафиксирован: «байт-идентично» — это про него тоже.
  const GOLDEN_RAW = '{"kind":"component-draft","componentId":"acc-capture","rev":3,"sourceHash":"ssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssss","bundleHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","propsHash":"pppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp","dsMetaVersion":2,"rendererBuild":null}';

  test("slot-free draft handshake stays byte-identical", () => {
    expect(canonicalStringify(readyToExpected(SLOT_FREE_DRAFT_READY))).toBe(GOLDEN_CANONICAL);
    expect(JSON.stringify(readyToExpected(SLOT_FREE_DRAFT_READY))).toBe(GOLDEN_RAW);
    expect(readyToExpected(SLOT_FREE_DRAFT_READY)).toEqual({
      kind: "component-draft",
      componentId: "acc-capture",
      rev: 3,
      sourceHash: "s".repeat(64),
      bundleHash: "b".repeat(64),
      propsHash: "p".repeat(64),
      dsMetaVersion: 2,
      rendererBuild: null,
    });
    // `slotsHash` отсутствует, а не пуст — иначе `canonicalStringify` включил бы его в пре-образ.
    expect("slotsHash" in readyToExpected(SLOT_FREE_DRAFT_READY)).toBe(false);
  });

  // Голден для explicit-undefined: у бесслотового случая сервер кладёт поле условно, но и
  // прямой `undefined` в ready не имеет права протечь в сравнение.
  test("explicit undefined slotsHash does not enter the pre-image", () => {
    expect(canonicalStringify(readyToExpected({ ...SLOT_FREE_DRAFT_READY, slotsHash: undefined })))
      .toBe(GOLDEN_CANONICAL);
  });
});

/**
 * Слоты в кандидатном капчуре (план 2026-08-05 §A6, T2.2). Проверяется ровно серверная половина:
 * пины детей, дерево рендера, `slotsHash` в handshake и **точное множество** allowlist'а —
 * поверхность (`CaptureComponent.tsx`) приезжает волной W3.
 */
describe("slot bindings in candidate capture (§A6)", () => {
  const CHILD_ID = "acc-slot-child";
  const OTHER_ID = "acc-slot-other";
  const CHILD_ASSET = "asset_" + "1".repeat(64);
  const OTHER_ASSET = "asset_" + "2".repeat(64);
  const SLOTS_HASH = "d".repeat(64);

  /** Опубликованный ребёнок без реальной сборки — тот же каркас, что `seedPublished` в draft-preview. */
  function seedPublishedChild(db: Database, id: string, name: string, bundleHash: string, assetId: string) {
    const definitionMeta = JSON.stringify({
      description: "seeded slot child", events: [], slots: [],
      propsJsonSchema: { type: "object", properties: { label: { type: "string" } } },
    });
    db.query("INSERT INTO components (id,name,head_rev,design_system,deleted_at,owner_id,created_at,updated_at) VALUES (?,?,1,'yandex-pay',NULL,?,'now','now')").run(id, name, BOOTSTRAP_ADMIN_ID);
    db.query("INSERT INTO component_revisions (component_id,rev,source,design_system,created_at) VALUES (?,1,'export default null','yandex-pay','now')").run(id);
    db.query("INSERT INTO component_publishes (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,published_at) VALUES (?,1,1,'active','',?,'sh',?,2,'now')").run(id, definitionMeta, bundleHash);
    db.run("INSERT INTO assets (id,sha256,mime,size,width,height,original_name,created_at) VALUES (?,?,?,?,?,?,?,?)",
      [assetId, assetId.slice(6), "image/png", 1, 1, 1, "dot.png", "now"]);
    db.run("INSERT INTO component_publish_assets (component_id,version,asset_id) VALUES (?,1,?)", [id, assetId]);
  }

  const bindings = () => [
    { slot: "header", index: 0, componentId: CHILD_ID, name: "AccSlotChild", version: 1, bundleHash: "child-hash", props: { label: "a" }, propsHash: "p1" },
    { slot: "default", index: 0, componentId: CHILD_ID, name: "AccSlotChild", version: 1, bundleHash: "child-hash", props: { label: "b" }, propsHash: "p2" },
    { slot: "default", index: 1, componentId: OTHER_ID, name: "AccSlotOther", version: 1, bundleHash: "other-hash", props: {}, propsHash: "p0" },
  ];

  test("slot job freezes child pins, the render tree and the resolved slotsHash", async () => {
    const { db, service, sourceHash } = await setupCandidate(neverResolves);
    seedPublishedChild(db, CHILD_ID, "AccSlotChild", "child-hash", CHILD_ASSET);
    seedPublishedChild(db, OTHER_ID, "AccSlotOther", "other-hash", OTHER_ASSET);
    const shot = { viewport: { width: 320, height: 200 }, deliver: "bytes" as const };

    const slotFree = await service.enqueueComponentCandidate(COMPONENT_ID, { rev: 1, sourceHash }, shot);
    const slotted = await service.enqueueComponentCandidate(COMPONENT_ID, { rev: 1, sourceHash }, { ...shot, slotBindings: bindings(), slotsHash: SLOTS_HASH });

    const free = service.peek(slotFree.jobId)!;
    const job = service.peek(slotted.jobId)!;

    // Один пин на различную пару `(componentId, version)`: повторный ребёнок бандл не дублирует.
    expect(job.slotChildren).toEqual([
      { id: CHILD_ID, name: "AccSlotChild", version: 1, bundleUrl: `/api/components/${CHILD_ID}/versions/1/bundle.js`, bundleHash: "child-hash", status: "active" },
      { id: OTHER_ID, name: "AccSlotOther", version: 1, bundleUrl: `/api/components/${OTHER_ID}/versions/1/bundle.js`, bundleHash: "other-hash", status: "active" },
    ]);
    // §A2a: дети дефолтного слота едут **без** ключа `slot`; именованные — с ним.
    expect(job.slotTree).toEqual([
      { slot: "header", index: 0, name: "AccSlotChild", props: { label: "a" } },
      { index: 0, name: "AccSlotChild", props: { label: "b" } },
      { index: 1, name: "AccSlotOther", props: {} },
    ]);
    expect(Object.hasOwn(job.slotTree![1]!, "slot")).toBe(false);
    expect(job.expected).toMatchObject({ kind: "component-draft", slotsHash: SLOTS_HASH });
    expect(slotted.expected).toMatchObject({ slotsHash: SLOTS_HASH });

    // Allowlist — **точное** множество: бандл каждого различного ребёнка и ассеты именно этой
    // версии, и ничего больше. DTO ребёнка (`/api/components/:id`, `/versions/:v`) в него не
    // входит намеренно: он отдал бы поверхности опубликованный `source`.
    expect(new Set(job.allowedUrls)).toEqual(new Set([
      ...free.allowedUrls,
      `/api/components/${CHILD_ID}/versions/1/bundle.js`,
      `/api/components/${OTHER_ID}/versions/1/bundle.js`,
      `/api/assets/${CHILD_ASSET}`,
      `/api/assets/${OTHER_ASSET}`,
    ]));
    for (const leaked of [`/api/components/${CHILD_ID}`, `/api/components/${CHILD_ID}/versions/1`, `/api/components/${OTHER_ID}/versions/1`]) {
      expect(job.allowedUrls).not.toContain(leaked);
    }

    // Бесслотовая джоба не изменилась ни в handshake, ни в allowlist, ни в bootstrap-полях.
    expect("slotsHash" in free.expected).toBe(false);
    expect(free.slotChildren).toBeUndefined();
    expect(free.slotTree).toBeUndefined();
    expect(canonicalStringify(free.expected)).toBe(canonicalStringify({
      kind: "component-draft", componentId: COMPONENT_ID, rev: 1, sourceHash,
      bundleHash: (free.expected as { bundleHash: string }).bundleHash,
      propsHash: (free.expected as { propsHash: string }).propsHash,
      dsMetaVersion: (free.expected as { dsMetaVersion: number | null }).dsMetaVersion,
      rendererBuild: (free.expected as { rendererBuild: string | null }).rendererBuild,
    }));
    db.close();
  });

  test("§W6: a nested tree flattens with children indices and dedups pins across all levels", async () => {
    const { db, service, sourceHash } = await setupCandidate(neverResolves);
    seedPublishedChild(db, CHILD_ID, "AccSlotChild", "child-hash", CHILD_ASSET);
    seedPublishedChild(db, OTHER_ID, "AccSlotOther", "other-hash", OTHER_ASSET);
    const shot = { viewport: { width: 320, height: 200 }, deliver: "bytes" as const };
    const free = service.peek((await service.enqueueComponentCandidate(COMPONENT_ID, { rev: 1, sourceHash }, shot)).jobId)!;

    // Родитель в слоте `header` несёт собственный слот `action`; тот же ребёнок повторяется на
    // втором уровне, поэтому пин обязан остаться один.
    const nested = [{
      slot: "header", index: 0, componentId: OTHER_ID, name: "AccSlotOther", version: 1,
      bundleHash: "other-hash", props: {}, propsHash: "p0",
      children: [
        { slot: "action", index: 0, componentId: CHILD_ID, name: "AccSlotChild", version: 1, bundleHash: "child-hash", props: { label: "deep" }, propsHash: "p1" },
      ],
    }];
    const job = service.peek((await service.enqueueComponentCandidate(COMPONENT_ID, { rev: 1, sourceHash },
      { ...shot, slotBindings: nested, slotsHash: SLOTS_HASH })).jobId)!;

    expect(job.slotTree).toEqual([
      { slot: "header", index: 0, name: "AccSlotOther", props: {}, children: [1] },
      { slot: "action", index: 0, name: "AccSlotChild", props: { label: "deep" } },
    ]);
    // Лист `children` не несёт вовсе — «отсутствует, а не пусто».
    expect(Object.hasOwn(job.slotTree![1]!, "children")).toBe(false);
    expect(job.slotChildren).toEqual([
      { id: OTHER_ID, name: "AccSlotOther", version: 1, bundleUrl: `/api/components/${OTHER_ID}/versions/1/bundle.js`, bundleHash: "other-hash", status: "active" },
      { id: CHILD_ID, name: "AccSlotChild", version: 1, bundleUrl: `/api/components/${CHILD_ID}/versions/1/bundle.js`, bundleHash: "child-hash", status: "active" },
    ]);
    // Allowlist покрывает **все** уровни дерева: бандл и ассеты вложенного ребёнка тоже.
    expect(new Set(job.allowedUrls)).toEqual(new Set([
      ...free.allowedUrls,
      `/api/components/${CHILD_ID}/versions/1/bundle.js`,
      `/api/components/${OTHER_ID}/versions/1/bundle.js`,
      `/api/assets/${CHILD_ASSET}`,
      `/api/assets/${OTHER_ASSET}`,
    ]));
    db.close();
  });

  test("an empty slotBindings array leaves the job slot-free (absent, never empty)", async () => {
    const { db, service, sourceHash } = await setupCandidate(neverResolves);
    const shot = { viewport: { width: 320, height: 200 }, deliver: "bytes" as const };
    const baseline = service.peek((await service.enqueueComponentCandidate(COMPONENT_ID, { rev: 1, sourceHash }, shot)).jobId)!;
    const empty = service.peek((await service.enqueueComponentCandidate(COMPONENT_ID, { rev: 1, sourceHash }, { ...shot, slotBindings: [] })).jobId)!;
    expect(empty.slotChildren).toBeUndefined();
    expect(empty.slotTree).toBeUndefined();
    expect(new Set(empty.allowedUrls)).toEqual(new Set(baseline.allowedUrls));
    db.close();
  });

  test("bootstrap carries slots for a slot job and stays untouched for a slot-free one", async () => {
    const { db, dir, sourceHash } = await setupCandidate();
    seedPublishedChild(db, CHILD_ID, "AccSlotChild", "child-hash", CHILD_ASSET);
    seedPublishedChild(db, OTHER_ID, "AccSlotOther", "other-hash", OTHER_ASSET);
    const seen: Record<string, unknown>[] = [];
    const service = makeService(db, dir, async (workerJob) => { seen.push(workerJob.bootstrap as unknown as Record<string, unknown>); return imageOk; });
    const shot = { viewport: { width: 320, height: 200 }, deliver: "bytes" as const };

    const slotted = await service.enqueueComponentCandidate(COMPONENT_ID, { rev: 1, sourceHash }, { ...shot, slotBindings: bindings(), slotsHash: SLOTS_HASH });
    expect((await waitDone(service, slotted.jobId)).status).toBe("done");
    const slotBootstrap = seen.at(-1)!;
    expect(slotBootstrap.slots).toEqual({
      children: [
        { id: CHILD_ID, name: "AccSlotChild", version: 1, bundleUrl: `/api/components/${CHILD_ID}/versions/1/bundle.js`, bundleHash: "child-hash", status: "active" },
        { id: OTHER_ID, name: "AccSlotOther", version: 1, bundleUrl: `/api/components/${OTHER_ID}/versions/1/bundle.js`, bundleHash: "other-hash", status: "active" },
      ],
      tree: [
        { slot: "header", index: 0, name: "AccSlotChild", props: { label: "a" } },
        { index: 0, name: "AccSlotChild", props: { label: "b" } },
        { index: 1, name: "AccSlotOther", props: {} },
      ],
    });
    expect(slotBootstrap.expected).toMatchObject({ slotsHash: SLOTS_HASH });

    const free = await service.enqueueComponentCandidate(COMPONENT_ID, { rev: 1, sourceHash }, shot);
    expect((await waitDone(service, free.jobId)).status).toBe("done");
    expect("slots" in seen.at(-1)!).toBe(false);
    db.close();
  });

  // §A2: манифест неизменен после PUT, но между PUT и капчуром лежит durable-реконструкция —
  // директива рендерера в props ребёнка обязана отказать и здесь, до попадания в bootstrap.
  test("$- and __eui-prefixed child props are refused at pushDraftCapture", async () => {
    const { db, service, sourceHash } = await setupCandidate(neverResolves);
    seedPublishedChild(db, CHILD_ID, "AccSlotChild", "child-hash", CHILD_ASSET);
    const shot = { viewport: { width: 320, height: 200 }, deliver: "bytes" as const };
    const dynamic = (props: Record<string, unknown>) => [
      { slot: "default", index: 0, componentId: CHILD_ID, name: "AccSlotChild", version: 1, bundleHash: "child-hash", props, propsHash: "p1" },
    ];
    await expect(service.enqueueComponentCandidate(COMPONENT_ID, { rev: 1, sourceHash }, { ...shot, slotBindings: dynamic({ $asset: "asset_x" }) }))
      .rejects.toMatchObject({ status: 422, code: "slot_props_dynamic" });
    // Вложенная директива — тот же отказ: обход рекурсивный, а не по верхнему уровню.
    await expect(service.enqueueComponentCandidate(COMPONENT_ID, { rev: 1, sourceHash }, { ...shot, slotBindings: dynamic({ items: [{ $cond: true }] }) }))
      .rejects.toMatchObject({ status: 422, code: "slot_props_dynamic" });
    await expect(service.enqueueComponentCandidate(COMPONENT_ID, { rev: 1, sourceHash }, { ...shot, slotBindings: dynamic({ __euiRef: 1 }) }))
      .rejects.toMatchObject({ status: 422, code: "slot_props_dynamic" });
    db.close();
  });
});
