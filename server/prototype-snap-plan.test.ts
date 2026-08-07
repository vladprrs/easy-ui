/**
 * Impact-driven gallery regression (план `docs/plans/2026-08-07-migration-feedback-wave.md` §W5,
 * миграция v34): отпечаток кадра экрана, план `POST /api/prototypes/:id/snap-plan`, запись кадров
 * галерейным путём, retention и kill-switch.
 *
 * Главный инвариант, который проверяют почти все тесты ниже: **недоказанный reuse = capture**.
 */
import { createTestHandler } from "./test-auth";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { openDatabase } from "./db";
import { prototypeDocSchema, type PrototypeDoc } from "../src/prototype/schema";
import { ScreenshotService, type RunJob } from "./screenshot/service";
import {
  buildSnapPlan, impactedSnapEnabled, recordScreenFrame, screenFrameContext, screenFrameFingerprint,
  screenFrameOf, screenFramesOf, SCREEN_FRAME_RETENTION_REVS, SNAP_PLAN_MAX_SCREENS,
  type ScreenFrameInputs, type SnapPlan,
} from "./prototypes/screenFrames";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

type Handler = (request: Request) => Promise<Response>;
const req = (url: string, method = "GET", value?: unknown) =>
  new Request(`http://test/api${url}`, { method, headers: value ? { "content-type": "application/json" } : undefined, body: value ? JSON.stringify(value) : undefined });

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1]);
const okJob: RunJob = async () => ({ ok: true, pngBase64: Buffer.from(png).toString("base64"), width: 1, height: 1, consoleErrors: [], pageErrors: [], browserVersion: "test/1" });

const VIEWPORT = { width: 390, height: 844 };

async function setup(runJob: RunJob = okJob) {
  const dir = await mkdtemp(resolve(process.cwd(), ".snap-plan-test-"));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  const service = new ScreenshotService({ db, dataDir: dir, serveDist: "dist", captureOrigin: "http://127.0.0.1:8787", chromiumAvailable: true, runJob });
  const handler = createTestHandler(db, { dataDir: dir, screenshots: service }) as Handler;
  return { dir, db, service, handler };
}

const source = () => Bun.file(resolve("server/fixtures", "rating-stars.tsx")).text();

async function seedComponent(handler: Handler): Promise<void> {
  const tsx = await source();
  expect((await handler(req("/components", "POST", { designSystem: "yandex-pay", id: "rating-stars", name: "RatingStars", source: tsx, intent: "Collects star ratings on gallery surfaces" }))).status).toBe(201);
  expect((await handler(req("/components/rating-stars/publish", "POST", { baseRev: 1 }))).status).toBe(201);
}

/** Экран из host-примитива `Image` — «экран без пинов»: его отпечаток не зависит от компонентов. */
const imageScreen = (id: string) => ({ id, name: id, spec: { root: "image", elements: { image: { type: "Image", props: { src: "https://example.com/fixture.png", alt: "Fixture" } } } } });
/** Экран с custom-компонентом — единственный, чей отпечаток двигает публикация нового бандла. */
const componentScreen = (id: string) => ({ id, name: id, spec: { root: "rating", elements: { rating: { type: "RatingStars", props: { value: 3 } } } } });

async function galleryDoc(id: string, screens: unknown[]): Promise<PrototypeDoc> {
  const base = prototypeDocSchema.parse(await Bun.file("test/fixtures/host-content.json").json());
  return prototypeDocSchema.parse({ ...base, id, name: id, startScreen: (screens[0] as { id: string }).id, screens });
}

/** Снимает экран галерейным путём (asset-доставка) и дожидается терминального исхода. */
async function capture(service: ScreenshotService, id: string, screenId: string): Promise<void> {
  const { jobId } = service.enqueuePrototype(id, screenId, { viewport: VIEWPORT });
  let status = service.get(jobId).status;
  for (let i = 0; i < 200 && status !== "done" && status !== "error"; i += 1) { await Bun.sleep(5); status = service.get(jobId).status; }
  expect(service.get(jobId).status).toBe("done");
}

const plan = (db: Database, id: string): SnapPlan =>
  buildSnapPlan(db, { prototypeId: id, viewport: VIEWPORT, dsf: 1, theme: "light" });

const actions = (result: SnapPlan): Record<string, string> =>
  Object.fromEntries(result.screens.map((screen) => [screen.screenId, `${screen.action}:${screen.reason}`]));

describe("screen frame fingerprint + snap plan (§W5)", () => {
  test("addition-only: одна новая ревизия с новым экраном ⇒ 1 capture + N proven-reuse", async () => {
    const { db, service, handler } = await setup();
    await seedComponent(handler);
    const screens = [componentScreen("s1"), imageScreen("s2"), imageScreen("s3")];
    expect((await handler(req("/prototypes", "POST", { doc: await galleryDoc("gallery", screens) }))).status).toBe(201);
    for (const screen of ["s1", "s2", "s3"]) await capture(service, "gallery", screen);

    // Все три сняты ровно в этих условиях — план обязан доказать переиспользование всех трёх.
    const before = plan(db, "gallery");
    expect(actions(before)).toEqual({ s1: "reuse:proven-reuse", s2: "reuse:proven-reuse", s3: "reuse:proven-reuse" });
    expect(before.summary).toEqual({ total: 3, capture: 0, reuse: 3 });
    expect(before.screens[0]!.reuseReceipt).toMatchObject({ screenId: "s1", previousRev: 1, previousPngSha256: expect.any(String) });

    // Добавление экрана — новая ревизия. Именно здесь ломался бы `rev` внутри отпечатка.
    const saved = await handler(req("/prototypes/gallery", "PUT", { doc: await galleryDoc("gallery", [...screens, imageScreen("s4")]), baseRev: 1 }));
    expect(saved.status).toBe(200);
    const after = plan(db, "gallery");
    expect(actions(after)).toEqual({
      s1: "reuse:proven-reuse", s2: "reuse:proven-reuse", s3: "reuse:proven-reuse", s4: "capture:new",
    });
    expect(after.summary).toEqual({ total: 4, capture: 1, reuse: 3 });
    db.close();
  });

  test("изменение компонента ⇒ capture только у экранов, где он есть", async () => {
    const { db, service, handler } = await setup();
    await seedComponent(handler);
    const screens = [componentScreen("s1"), imageScreen("s2"), imageScreen("s3")];
    expect((await handler(req("/prototypes", "POST", { doc: await galleryDoc("impact", screens) }))).status).toBe(201);
    for (const screen of ["s1", "s2", "s3"]) await capture(service, "impact", screen);

    // Новая версия компонента + перепин головы: пин экрана s1 переезжает, остальные два экрана
    // компонента не содержат вовсе.
    const tsx = await source();
    expect((await handler(req("/components/rating-stars", "PUT", { baseRev: 1, source: tsx.replace("five-star", "five-star v2") }))).status).toBe(200);
    expect((await handler(req("/components/rating-stars/publish", "POST", { baseRev: 2 }))).status).toBe(201);
    const repin = await handler(req("/prototypes/impact/repin", "POST", {}));
    expect(repin.status).toBe(200);
    expect((await repin.json() as { changed: unknown[] }).changed.length).toBe(1);

    expect(actions(plan(db, "impact"))).toEqual({
      s1: "capture:impacted", s2: "reuse:proven-reuse", s3: "reuse:proven-reuse",
    });
    db.close();
  });

  test("смена токена темы (незапиннутая голова, рост meta-версии) ⇒ все экраны capture с причиной theme", async () => {
    const { db, service, handler } = await setup();
    const screens = [imageScreen("s1"), imageScreen("s2")];
    expect((await handler(req("/prototypes", "POST", { doc: await galleryDoc("theme-move", screens) }))).status).toBe(201);
    for (const screen of ["s1", "s2"]) await capture(service, "theme-move", screen);
    expect(actions(plan(db, "theme-move"))).toEqual({ s1: "reuse:proven-reuse", s2: "reuse:proven-reuse" });

    // У ДС не было ни одной версии темы ⇒ пин ревизии `null` ⇒ тема резолвится в голову.
    // Публикация версии двигает резолвнутую версию, а с ней — отпечаток каждого экрана этой ДС.
    const patched = await handler(req("/design-systems/yandex-pay", "PATCH", { tokens: { "color.brand": "#123456" }, baseVersion: 0 }));
    expect(patched.status).toBe(200);
    expect(actions(plan(db, "theme-move"))).toEqual({ s1: "capture:theme", s2: "capture:theme" });
    db.close();
  });

  test("смена rendererFingerprint ⇒ все экраны capture с причиной renderer", async () => {
    const { db, service, handler } = await setup();
    const screens = [imageScreen("s1"), imageScreen("s2")];
    expect((await handler(req("/prototypes", "POST", { doc: await galleryDoc("renderer-move", screens) }))).status).toBe(201);
    for (const screen of ["s1", "s2"]) await capture(service, "renderer-move", screen);

    // Сменить рендерер в процессе теста нечем (он объявлен манифестом сборки), поэтому
    // моделируется обратное и эквивалентное: записанные кадры сняты **прежним** рендерером.
    for (const row of screenFramesOf(db, "renderer-move")) {
      const before: ScreenFrameInputs = { ...row.receipt!.inputs, rendererFingerprint: "renderer-before-the-wave" };
      db.query("DELETE FROM prototype_screen_frames WHERE prototype_id=? AND rev=? AND screen_id=? AND screen_frame_fingerprint=?")
        .run(row.prototypeId, row.rev, row.screenId, row.screenFrameFingerprint);
      recordScreenFrame(db, { ...row, screenFrameFingerprint: screenFrameFingerprint(before), receipt: { ...row.receipt!, inputs: before } });
    }
    expect(actions(plan(db, "renderer-move"))).toEqual({ s1: "capture:renderer", s2: "capture:renderer" });
    db.close();
  });

  test("экран с неразворачиваемым деревом всегда capture (недоказанный reuse = capture)", async () => {
    const { db, service, handler } = await setup();
    await seedComponent(handler);
    const screens = [componentScreen("s1"), imageScreen("s2")];
    expect((await handler(req("/prototypes", "POST", { doc: await galleryDoc("unprovable", screens) }))).status).toBe(201);
    for (const screen of ["s1", "s2"]) await capture(service, "unprovable", screen);
    expect(actions(plan(db, "unprovable"))).toEqual({ s1: "reuse:proven-reuse", s2: "reuse:proven-reuse" });

    // Тип без пина ревизии — «неразобранный бандл» в терминах §1.7. Кадр с точно таким же
    // отпечатком в таблице **есть**, и именно поэтому тест содержательный: недоказуемость бьёт
    // reuse, а не наоборот.
    db.query("DELETE FROM prototype_revision_components WHERE prototype_id=?").run("unprovable");
    const withoutPin = plan(db, "unprovable");
    expect(actions(withoutPin)).toEqual({ s1: "capture:unprovable", s2: "reuse:proven-reuse" });
    expect(withoutPin.screens[0]!.unprovable).toContain("RatingStars");

    // Композиция, тела которой на ревизии нет: внутренних ключей не видно, доказать
    // непричастность экрана нечем.
    const context = screenFrameContext(db, "unprovable", {}, { viewport: VIEWPORT, dsf: 1, theme: "light" });
    const withComposition = {
      ...context,
      doc: { ...context.doc, screens: [{ id: "s1", name: "s1", spec: { root: "host", elements: { host: { type: "@eui/Composition", props: { composition: "pay-header" } } } } }] } as PrototypeDoc,
    };
    expect(screenFrameOf(db, withComposition, "s1").unprovable).toContain("pay-header");
    db.close();
  });

  test("retention: хранятся кадры последних 5 ревизий прототипа", async () => {
    const { db, handler } = await setup();
    const screens = [imageScreen("s1")];
    expect((await handler(req("/prototypes", "POST", { doc: await galleryDoc("retention", screens) }))).status).toBe(201);
    for (let rev = 1; rev <= 7; rev += 1) {
      if (rev > 1) expect((await handler(req("/prototypes/retention", "PUT", { doc: await galleryDoc("retention", screens), baseRev: rev - 1 }))).status).toBe(200);
      recordScreenFrame(db, { prototypeId: "retention", rev, screenId: "s1", screenFrameFingerprint: `fp-${rev}`, pngSha256: `sha-${rev}`, receipt: null });
    }
    expect(screenFramesOf(db, "retention").map((row) => row.rev)).toEqual([3, 4, 5, 6, 7]);
    expect(SCREEN_FRAME_RETENTION_REVS).toBe(5);
    db.close();
  });

  test("квитанция больше 64 КБ не роняет запись кадра — усекается", async () => {
    const { db, handler } = await setup();
    expect((await handler(req("/prototypes", "POST", { doc: await galleryDoc("receipt-cap", [imageScreen("s1")]) }))).status).toBe(201);
    const context = screenFrameContext(db, "receipt-cap", {}, { viewport: VIEWPORT, dsf: 1, theme: "light" });
    const frame = screenFrameOf(db, context, "s1");
    recordScreenFrame(db, {
      prototypeId: "receipt-cap", rev: 1, screenId: "s1", screenFrameFingerprint: frame.fingerprint, pngSha256: "sha",
      receipt: { capturedAt: new Date().toISOString(), assetId: "x".repeat(70_000), inputs: frame.inputs },
    });
    const rows = screenFramesOf(db, "receipt-cap");
    expect(rows.length).toBe(1);
    expect(rows[0]!.receipt).toBeNull();
    // Кадр без квитанции всё ещё доказывает reuse — причину пересъёмки он назвать не может.
    expect(actions(plan(db, "receipt-cap"))).toEqual({ s1: "reuse:proven-reuse" });
    db.close();
  });
});

describe("POST /api/prototypes/:id/snap-plan", () => {
  test("отдаёт план ревизии, уважает подмножество экранов и потолок", async () => {
    const { db, service, handler } = await setup();
    const screens = [imageScreen("s1"), imageScreen("s2")];
    expect((await handler(req("/prototypes", "POST", { doc: await galleryDoc("route", screens) }))).status).toBe(201);
    await capture(service, "route", "s1");

    const response = await handler(req("/prototypes/route/snap-plan", "POST", { viewport: VIEWPORT }));
    expect(response.status).toBe(200);
    const body = await response.json() as SnapPlan;
    expect(body.rev).toBe(1);
    expect(body.theme).toBe("light");
    expect(actions(body)).toEqual({ s1: "reuse:proven-reuse", s2: "capture:new" });

    // Подмножество экранов.
    const subset = await handler(req("/prototypes/route/snap-plan", "POST", { viewport: VIEWPORT, screens: ["s2"] }));
    expect((await subset.json() as SnapPlan).screens.map((screen) => screen.screenId)).toEqual(["s2"]);

    // Другая тема — другие условия съёмки, доказательства нет.
    const dark = await handler(req("/prototypes/route/snap-plan", "POST", { viewport: VIEWPORT, theme: "dark" }));
    expect(actions(await dark.json() as SnapPlan).s1).toBe("capture:impacted");

    // Потолок плана.
    const tooMany = await handler(req("/prototypes/route/snap-plan", "POST", { viewport: VIEWPORT, screens: Array.from({ length: SNAP_PLAN_MAX_SCREENS + 1 }, (_, index) => `s${index}`) }));
    expect(tooMany.status).toBe(422);
    expect((await tooMany.json() as { error: { code: string } }).error.code).toBe("snap_plan_too_many_screens");

    // Форма запроса: неизвестное значение readiness — отказ, а не молчаливое игнорирование.
    expect((await handler(req("/prototypes/route/snap-plan", "POST", { viewport: VIEWPORT, readiness: "strict" }))).status).toBe(400);
    expect((await handler(req("/prototypes/route/snap-plan", "GET"))).status).toBe(405);
    db.close();
  });

  test("kill-switch EASYUI_IMPACTED_SNAP_DISABLED гасит ручку и запись кадров", async () => {
    const { db, service, handler } = await setup();
    expect((await handler(req("/prototypes", "POST", { doc: await galleryDoc("killed", [imageScreen("s1")]) }))).status).toBe(201);
    process.env.EASYUI_IMPACTED_SNAP_DISABLED = "1";
    try {
      expect(impactedSnapEnabled()).toBe(false);
      const response = await handler(req("/prototypes/killed/snap-plan", "POST", { viewport: VIEWPORT }));
      expect(response.status).toBe(404);
      await capture(service, "killed", "s1");
      expect(screenFramesOf(db, "killed")).toEqual([]);
      const capabilities = await (await handler(req("/capabilities"))).json() as { features: Record<string, unknown> };
      expect(capabilities.features.impactedSnap).toBe(false);
    } finally {
      delete process.env.EASYUI_IMPACTED_SNAP_DISABLED;
    }
    // Снятый kill-switch возвращает и ручку, и запись.
    expect(impactedSnapEnabled()).toBe(true);
    await capture(service, "killed", "s1");
    expect(screenFramesOf(db, "killed").length).toBe(1);
    expect((await handler(req("/prototypes/killed/snap-plan", "POST", { viewport: VIEWPORT }))).status).toBe(200);
    db.close();
  });
});
