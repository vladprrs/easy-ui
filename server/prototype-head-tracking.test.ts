import { createTestHandler } from "./test-auth";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { openDatabase } from "./db";
import { PrototypeRepo } from "./repos/prototypes";
import { computeReadiness } from "./readiness";
import { ScreenshotService, type RunJob, type WorkerJob, type WorkerResult } from "./screenshot/service";
import { prototypeDocSchema } from "../src/prototype/schema";

// W3 плана docs/plans/2026-08-02-agent-iteration-dx.md: head-tracking служебных прототипов
// (P2) и readiness-профиль служебных видов (P9).

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

type Handler = (request: Request) => Promise<Response>;
const req = (url: string, method = "GET", value?: unknown) =>
  new Request(`http://test/api${url}`, { method, headers: value ? { "content-type": "application/json" } : undefined, body: value ? JSON.stringify(value) : undefined });
const code = async (response: Response) => (await response.json() as { error: { code: string } }).error.code;

async function setup() {
  const dir = await mkdtemp(resolve(process.cwd(), ".head-track-test-"));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  const handler = createTestHandler(db, { dataDir: dir }) as Handler;
  return { dir, db, handler };
}

const source = () => Bun.file(resolve("server/fixtures", "rating-stars.tsx")).text();

/** Публикует версию 1 компонента RatingStars. */
async function seedComponent(handler: Handler) {
  const tsx = await source();
  expect((await handler(req("/components", "POST", { designSystem: "yandex-pay", id: "rating-stars", name: "RatingStars", source: tsx, intent: "Collects star ratings on gallery surfaces" }))).status).toBe(201);
  expect((await handler(req("/components/rating-stars/publish", "POST", { baseRev: 1 }))).status).toBe(201);
}

/** Публикует следующую версию того же компонента (новая ревизия → новый bundleHash). */
async function publishNextVersion(handler: Handler, version: number) {
  const tsx = await source();
  const saved = await handler(req("/components/rating-stars", "PUT", { baseRev: version - 1, source: tsx.replace("five-star", `five-star v${version}`) }));
  expect(saved.status).toBe(200);
  expect((await handler(req("/components/rating-stars/publish", "POST", { baseRev: version }))).status).toBe(201);
}

/** Документ с одним экраном, состоящим из custom-компонента (как галерея компонентов). */
async function galleryDoc(id: string) {
  const base = prototypeDocSchema.parse(await Bun.file("test/fixtures/host-content.json").json());
  return { ...base, id, name: id, screens: base.screens.map((screen, index) => index ? screen : { ...screen, spec: { root: "rating", elements: { rating: { type: "RatingStars", props: { value: 3 } } } } }) };
}

const setTrack = (handler: Handler, id: string, body: Record<string, unknown>) => handler(req(`/prototypes/${id}/lifecycle`, "POST", body));

describe("prototype head-tracking (P2)", () => {
  test("track:head is accepted only for service kinds and only while unpublished", async () => {
    const { db, handler } = await setup();
    await seedComponent(handler);
    expect((await handler(req("/prototypes", "POST", { doc: await galleryDoc("flow") }))).status).toBe(201);

    // Продуктовый вид — отказ со стабильным кодом.
    const productKind = await setTrack(handler, "flow", { track: "head" });
    expect([productKind.status, await code(productKind)]).toEqual([422, "track_requires_service_kind"]);

    // Служебный вид — принимается и виден в lifecycle/meta.
    expect((await setTrack(handler, "flow", { kind: "component-gallery" })).status).toBe(200);
    const ok = await setTrack(handler, "flow", { track: "head" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ kind: "component-gallery", tags: [], derivedFrom: null, track: "head" });
    expect(await (await handler(req("/prototypes/flow"))).json()).toMatchObject({ track: "head" });

    // Возврат к продуктовому виду без снятия track — отказ; снятие track разрешает переход.
    const stuck = await setTrack(handler, "flow", { kind: "product-flow" });
    expect([stuck.status, await code(stuck)]).toEqual([422, "track_requires_service_kind"]);
    expect((await setTrack(handler, "flow", { kind: "product-flow", track: "pinned" })).status).toBe(200);

    // Опубликованный прототип нельзя ни перевести в служебный вид, ни включить ему track.
    expect((await handler(req("/prototypes", "POST", { doc: await galleryDoc("shipped"), kind: "evidence" }))).status).toBe(201);
    expect((await handler(req("/prototypes/shipped/publish", "POST", { baseRev: 1 }))).status).toBe(201);
    const published = await setTrack(handler, "shipped", { track: "head" });
    expect([published.status, await code(published)]).toEqual([422, "track_requires_unpublished"]);
    // Строка в БД не поменялась после отказа.
    expect(new PrototypeRepo(db).lifecycle("shipped").track).toBe("pinned");
    db.close();
  });

  test("a published prototype cannot be relabelled into a service kind", async () => {
    const { db, handler } = await setup();
    await seedComponent(handler);
    expect((await handler(req("/prototypes", "POST", { doc: await galleryDoc("p1") }))).status).toBe(201);
    expect((await handler(req("/prototypes/p1/publish", "POST", { baseRev: 1 }))).status).toBe(201);
    const denied = await setTrack(handler, "p1", { kind: "component-gallery" });
    expect([denied.status, await code(denied)]).toEqual([422, "service_kind_requires_unpublished"]);
    // Продуктовые виды между собой по-прежнему переключаются.
    expect((await setTrack(handler, "p1", { kind: "experiment" })).status).toBe(200);
    db.close();
  });

  test("changing kind writes a dedicated audit event", async () => {
    const { db, handler } = await setup();
    await seedComponent(handler);
    expect((await handler(req("/prototypes", "POST", { doc: await galleryDoc("audited") }))).status).toBe(201);
    expect((await setTrack(handler, "audited", { kind: "component-gallery" })).status).toBe(200);
    expect((await setTrack(handler, "audited", { track: "head" })).status).toBe(200);
    // Патч без смены вида второго kind-события не пишет.
    expect((await setTrack(handler, "audited", { tags: ["catalog"] })).status).toBe(200);
    const events = db.query("SELECT action,detail FROM audit_events WHERE subject_id='audited' ORDER BY id").all() as { action: string; detail: string }[];
    const kindEvents = events.filter((event) => event.action === "prototype.kind.changed");
    expect(kindEvents).toHaveLength(1);
    expect(JSON.parse(kindEvents[0]!.detail)).toEqual({ from: "product-flow", to: "component-gallery" });
    expect(events.filter((event) => event.action === "prototype.track.changed").map((event) => JSON.parse(event.detail))).toEqual([{ from: "pinned", to: "head" }]);
    db.close();
  });

  test("publish, share, visual-baseline and bundle-export of a tracking doc answer 422", async () => {
    const { db, handler } = await setup();
    await seedComponent(handler);
    expect((await handler(req("/prototypes", "POST", { doc: await galleryDoc("tracked"), kind: "component-gallery" }))).status).toBe(201);
    expect((await setTrack(handler, "tracked", { track: "head" })).status).toBe(200);

    const publish = await handler(req("/prototypes/tracked/publish", "POST", { baseRev: 1 }));
    expect([publish.status, await code(publish)]).toEqual([422, "prototype_head_tracking"]);

    const share = await handler(req("/prototypes/tracked/share", "POST", { version: 1, ttlSeconds: 3600 }));
    expect([share.status, await code(share)]).toEqual([422, "prototype_head_tracking"]);

    const baseline = await handler(req("/visual-baselines/prototypes/tracked", "PUT", { rev: 1, prototypeInstanceId: "x", baseGeneration: null, members: [] }));
    expect([baseline.status, await code(baseline)]).toEqual([422, "prototype_head_tracking"]);

    const exported = await handler(req("/prototypes/tracked/export"));
    expect([exported.status, await code(exported)]).toEqual([422, "prototype_head_tracking"]);

    // Снятие track возвращает все четыре операции (проверяем самую дешёвую — export).
    expect((await setTrack(handler, "tracked", { track: "pinned" })).status).toBe(200);
    expect((await handler(req("/prototypes/tracked/export"))).status).toBe(200);
    db.close();
  });

  test("the revision DTO resolves head pins and reports resolvedAt without a re-save", async () => {
    const { db, handler } = await setup();
    await seedComponent(handler);
    expect((await handler(req("/prototypes", "POST", { doc: await galleryDoc("gallery"), kind: "component-gallery" }))).status).toBe(201);

    const repo = new PrototypeRepo(db);
    const pinned = repo.draft("gallery");
    expect(pinned.track).toBe("pinned");
    expect(pinned.resolvedAt).toBeNull();
    expect(pinned.components.map((pin) => pin.version)).toEqual([1]);

    expect((await setTrack(handler, "gallery", { track: "head" })).status).toBe(200);
    await publishNextVersion(handler, 2);

    // Документ не пересохранялся: head_rev остался прежним, а пины уже указывают на v2.
    const tracked = repo.draft("gallery");
    expect(tracked.rev).toBe(pinned.rev);
    expect(tracked.track).toBe("head");
    expect(typeof tracked.resolvedAt).toBe("string");
    expect(tracked.components.map((pin) => pin.version)).toEqual([2]);
    expect(tracked.components[0]!.bundleUrl).toContain("/versions/2/bundle.js");
    // manifest-hash считается из пинов на read-пути → резолв даёт согласованный хэш.
    expect(tracked.componentManifestHash).not.toBe(pinned.componentManifestHash);
    expect(repo.revision("gallery", tracked.rev).componentManifestHash).toBe(tracked.componentManifestHash);
    // Скоуп резолва — только компоненты: тема остаётся пином ревизии.
    expect(repo.revision("gallery", tracked.rev).designSystemMetaVersion).toBe(pinned.designSystemMetaVersion);
    db.close();
  });
});

/**
 * Имитация capture-поверхности: она читает DTO ревизии, но пины и manifest-hash берёт из
 * `bootstrap.target`, если постановка их туда положила (`CapturePrototype.tsx`). Возвращает
 * то, что воркер сравнивает с frozen `expected` (`readyToExpected` в screenshot-worker.mjs).
 */
function renderSurface(db: Database, job: WorkerJob) {
  const target = job.bootstrap.target as { rev: number; componentManifestHash?: string; components?: { version: number }[] };
  const id = decodeURIComponent(/^\/capture\/([^/]+)\//.exec(job.captureUrl)![1]!);
  const dto = new PrototypeRepo(db).revision(id, target.rev);
  const components = target.components ?? dto.components;
  return {
    ready: {
      kind: "prototype" as const,
      prototypeInstanceId: dto.prototypeInstanceId,
      rev: dto.rev,
      componentManifestHash: target.componentManifestHash ?? dto.componentManifestHash,
      builtinCatalogHash: dto.builtinCatalogHash,
      dsMetaVersion: dto.designSystemMetaVersion ?? null,
      rendererBuild: job.bootstrap.expected.rendererBuild,
    },
    renderedVersions: components.map((pin) => pin.version),
  };
}

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1]);
const imageOk = (): WorkerResult => ({ ok: true, pngBase64: Buffer.from(png).toString("base64"), width: 1, height: 1, consoleErrors: [], pageErrors: [], browserVersion: "test/1" });

async function settle(service: ScreenshotService, jobId: string) {
  for (let i = 0; i < 200 && !["done", "error"].includes(service.get(jobId).status); i += 1) await Bun.sleep(5);
  return service.get(jobId);
}

describe("head-tracking capture handshake (P2.3)", () => {
  test("a tracking doc snaps after a new component publish without being re-saved", async () => {
    const { db, dir, handler } = await setup();
    await seedComponent(handler);
    expect((await handler(req("/prototypes", "POST", { doc: await galleryDoc("shot"), kind: "component-gallery" }))).status).toBe(201);
    expect((await setTrack(handler, "shot", { track: "head" })).status).toBe(200);
    await publishNextVersion(handler, 2);

    let rendered: number[] = [];
    let mismatch: string | null = null;
    const runJob: RunJob = async (job) => {
      const { ready, renderedVersions } = renderSurface(db, job);
      rendered = renderedVersions;
      if (JSON.stringify(ready) !== JSON.stringify(job.expected)) mismatch = `${JSON.stringify(ready)} vs ${JSON.stringify(job.expected)}`;
      return imageOk();
    };
    const service = new ScreenshotService({ db, dataDir: dir, serveDist: "dist", captureOrigin: "http://127.0.0.1:8787", chromiumAvailable: true, runJob });

    const enqueued = service.enqueuePrototype("shot", "welcome", { viewport: { width: 390, height: 844 } });
    // Ответ enqueue сразу называет разрешённые пины (P2.3/P5.2).
    expect(enqueued.components).toEqual([{ id: "rating-stars", name: "RatingStars", version: 2, bundleHash: expect.any(String) }]);

    const final = await settle(service, enqueued.jobId);
    expect(mismatch).toBeNull();
    expect(final.status).toBe("done");
    // Документ не пересохранялся, а в кадр поехала свежая версия компонента.
    expect(rendered).toEqual([2]);
    expect(new PrototypeRepo(db).draft("shot").rev).toBe(1);
    if (final.result?.kind !== "image") throw new Error("expected image result");
    expect(final.result.componentPins).toEqual([{ id: "rating-stars", version: 2, bundleHash: expect.any(String) }]);
    db.close();
  });

  test("a publish landing between enqueue and render neither fails the job nor moves its resolve", async () => {
    const { db, dir, handler } = await setup();
    await seedComponent(handler);
    expect((await handler(req("/prototypes", "POST", { doc: await galleryDoc("race"), kind: "component-gallery" }))).status).toBe(201);
    expect((await setTrack(handler, "race", { track: "head" })).status).toBe(200);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let rendered: number[] = [];
    let mismatch: string | null = null;
    const runJob: RunJob = async (job) => {
      await gate; // публикация приземляется здесь — между enqueue и «рендером»
      const { ready, renderedVersions } = renderSurface(db, job);
      rendered = renderedVersions;
      if (JSON.stringify(ready) !== JSON.stringify(job.expected)) mismatch = `${JSON.stringify(ready)} vs ${JSON.stringify(job.expected)}`;
      return imageOk();
    };
    const service = new ScreenshotService({ db, dataDir: dir, serveDist: "dist", captureOrigin: "http://127.0.0.1:8787", chromiumAvailable: true, runJob });

    const enqueued = service.enqueuePrototype("race", "welcome", { viewport: { width: 390, height: 844 } });
    expect(enqueued.components.map((pin) => pin.version)).toEqual([1]);
    // Публикация v2 после постановки: read-путь DTO уже отдаёт v2 для трекающего дока.
    await publishNextVersion(handler, 2);
    expect(new PrototypeRepo(db).draft("race").components.map((pin) => pin.version)).toEqual([2]);

    release();
    const final = await settle(service, enqueued.jobId);
    expect(mismatch).toBeNull();
    expect(final.status).toBe("done");
    // Джоба осталась на своём резолве — кадр снят с v1, как и обещал ответ enqueue.
    expect(rendered).toEqual([1]);
    if (final.result?.kind !== "image") throw new Error("expected image result");
    expect(final.result.componentPins?.map((pin) => pin.version)).toEqual([1]);
    db.close();
  });
});

describe("readiness profile (P9)", () => {
  test("service docs report profile:service and their warnings never block", async () => {
    const { db, dir, handler } = await setup();
    await seedComponent(handler);
    expect((await handler(req("/prototypes", "POST", { doc: await galleryDoc("product") }))).status).toBe(201);
    expect((await handler(req("/prototypes", "POST", { doc: await galleryDoc("service"), kind: "component-gallery" }))).status).toBe(201);
    // Депрекация закреплённой публикации переводит гейт `pins` в warn у обоих доков.
    expect((await handler(req("/components/rating-stars/versions/1/status", "POST", { status: "deprecated", baseStatusRev: 1 }))).status).toBe(200);

    const gates = { pins: "warn" } as const;
    const product = await computeReadiness(db, "product", { dataDir: dir, gates });
    const service = await computeReadiness(db, "service", { dataDir: dir, gates });
    expect(product.profile).toBe("product");
    expect(service.profile).toBe("service");
    expect(product.gates.find((gate) => gate.id === "pins")?.status).toBe("warn");
    expect(service.gates.find((gate) => gate.id === "pins")?.status).toBe("warn");
    // Тот же warn: у продуктового дока он блокирует публикацию, у служебного — нет.
    expect(product.blocking).toEqual(["pins"]);
    expect(service.blocking).toEqual([]);
    expect(service.publishable).toBeTrue();
    // `fail` служебный профиль по-прежнему блокирует.
    expect((await handler(req("/components/rating-stars/versions/1/status", "POST", { status: "active", baseStatusRev: 2 }))).status).toBe(200);
    expect((await handler(req("/components/rating-stars/versions/1/status", "POST", { status: "rejected", baseStatusRev: 3, reason: "unsafe" }))).status).toBe(200);
    expect((await computeReadiness(db, "service", { dataDir: dir, gates })).blocking).toEqual(["pins"]);
    db.close();
  });

  test("the readiness route carries the profile", async () => {
    const { db, handler } = await setup();
    await seedComponent(handler);
    expect((await handler(req("/prototypes", "POST", { doc: await galleryDoc("report"), kind: "evidence" }))).status).toBe(201);
    const report = await (await handler(req("/prototypes/report/readiness"))).json() as { profile: string };
    expect(report.profile).toBe("service");
    db.close();
  });
});
