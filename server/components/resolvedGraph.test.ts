import { createTestHandler } from "../test-auth";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../db";
import { PrototypeRepo } from "../repos/prototypes";
import { expandPrototypeForSave, snapshotDefinitions } from "../validation";
import { resolveComponentGraph, resolveHeadPublish, schemaCacheKeyOf, type ResolvedComponentGraph } from "./resolvedGraph";
import { ScreenshotService, type RunJob, type WorkerResult } from "../screenshot/service";
import { prototypeDocSchema } from "../../src/prototype/schema";

/**
 * BR-01b плана `docs/plans/2026-08-08-blocker-removal-eui-br.md` §1 — единый
 * `ResolvedComponentGraph`.
 *
 * Файл несёт два обязательства волны:
 *
 * 1. **Дифференциальный тест «старый vs новый резолвер»** (done-критерий V4, CI-артефакт):
 *    один и тот же корпус фикстур резолвится обоими режимами kill-switch'а
 *    `EASYUI_SCHEMA_RESOLVER_V2_DISABLED`. Там, где legacy корректен, резолв обязан совпасть
 *    **байт-в-байт**; там, где legacy баговал (классы H1/H2/H4), расхождение ОЖИДАЕМО и
 *    перечислено явно с указанием класса.
 * 2. **AC §4/§5 фидбэка**: save/status/snap называют одинаковые
 *    `resolvedVersion`/`sourceHash`/`propsSchemaHash`, а после promote новой версии повторный
 *    save не видит старую схему.
 */

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

type Handler = (request: Request) => Promise<Response>;
const req = (url: string, method = "GET", value?: unknown) => new Request(`http://test/api${url}`, {
  method,
  headers: value === undefined ? undefined : { "content-type": "application/json" },
  body: value === undefined ? undefined : JSON.stringify(value),
});
const asJson = async <T>(response: Response): Promise<T> => (await response.json()) as T;

async function setup() {
  const dir = await mkdtemp(resolve(process.cwd(), ".resolved-graph-test-"));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  return { dir, db, handler: createTestHandler(db, { dataDir: dir }) as Handler };
}

/** Прогоняет тело при поднятом kill-switch'е волны (доволновой резолвер). */
async function withLegacyResolver<T>(body: () => Promise<T> | T): Promise<T> {
  process.env.EASYUI_SCHEMA_RESOLVER_V2_DISABLED = "1";
  try { return await body(); } finally { delete process.env.EASYUI_SCHEMA_RESOLVER_V2_DISABLED; }
}

const fixture = (name: string) => Bun.file(resolve("server/fixtures", name)).text();
const compositionDoc = await Bun.file("test/fixtures/architecture/ctyp-payment-success.composition.json").json() as Record<string, unknown>;
const composedScreen = await Bun.file("test/fixtures/architecture/composition-screen.json").json() as Record<string, unknown>;

/** Исходник бейджа: v1 — только `amount`; v2 — ещё и новый опциональный prop `mode`. */
const badgeSource = (withMode: boolean) => `import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ amount: z.string().min(1)${withMode ? `, mode: z.enum(["current-main", "compact"]).optional()` : ""} }),
  events: [],
  slots: [],
  atomicLevel: "molecule" as const,
  ownership: { reason: "Owns the irreducible amount formatting behavior of the success badge" },
  description: "Cashback accrual badge; used only from inside the CTYP success composition",
  example: { amount: "12 ₽" },
};

type Props = z.output<typeof definition.props>;

export default function CtypAccrualBadge({ props }: EasyUIComponentProps<Props>) {
  return <span data-ctyp-accrual data-mode={${withMode ? "props.mode ?? \"\"" : "\"\""}}>{props.amount}</span>;
}
`;

async function publishComponent(handler: Handler, id: string, name: string, source: string) {
  expect((await handler(req("/components", "POST", { designSystem: "yandex-pay", id, name, source, intent: `Renders ${name} inside a reusable product composition` }))).status).toBe(201);
  expect((await handler(req(`/components/${id}/publish`, "POST", { baseRev: 1 }))).status).toBe(201);
}

async function publishNextVersion(handler: Handler, id: string, baseRev: number, source: string, designSystem?: string) {
  const saved = await handler(req(`/components/${id}`, "PUT", { baseRev, source, ...(designSystem ? { designSystem } : {}) }));
  expect(saved.status).toBe(200);
  const { rev } = await asJson<{ rev: number }>(saved);
  const published = await handler(req(`/components/${id}/publish`, "POST", { baseRev: rev }));
  expect(published.status).toBe(201);
  return asJson<{ version: number }>(published);
}

/** Одноэкранный документ с одним авторским бейджем. */
function docWithBadge(id: string, props: Record<string, unknown> = { amount: "34 ₽" }) {
  const doc = structuredClone(composedScreen) as { id: string; screens: { spec: { root: string; elements: Record<string, unknown> } }[] };
  doc.id = id;
  doc.screens[0]!.spec.elements = {
    root: { type: "@eui/FlowRoot", props: {}, children: ["authored"] },
    authored: { type: "CtypAccrualBadge", props },
  };
  return prototypeDocSchema.parse(doc);
}

/** Документ композиции + (опционально) авторский элемент того же типа ВНЕ композиции. */
function docWithComposition(id: string, authored: boolean) {
  const doc = structuredClone(composedScreen) as typeof composedScreen & {
    id: string; screens: { spec: { elements: Record<string, unknown> } }[];
  };
  doc.id = id;
  const screen = doc.screens[0]!;
  if (authored) {
    (screen.spec.elements.root as { children: string[] }).children = ["screen", "authored"];
    screen.spec.elements.authored = { type: "CtypAccrualBadge", props: { amount: "34 ₽" } };
  }
  return prototypeDocSchema.parse(doc);
}

/** Наблюдаемая проекция графа — то, что сравнивает дифференциальный тест. */
type GraphShot = { error?: string; nodes?: { name: string; componentId: string; version: number; origin: string; sourceHash: string | null; propsSchemaHash: string | null }[] };
function shotOf(build: () => ResolvedComponentGraph): GraphShot {
  try {
    return { nodes: build().nodes.map((node) => ({
      name: node.name, componentId: node.componentId, version: node.version, origin: node.origin,
      sourceHash: node.sourceHash, propsSchemaHash: node.propsSchemaHash,
    })) };
  } catch (error) {
    return { error: (error as { code?: string }).code ?? (error as Error).message };
  }
}

/** Резолв документа обоими режимами резолвера — вход всех дифференциальных ассертов. */
async function differential(db: Database, doc: ReturnType<typeof docWithBadge>) {
  const modern = shotOf(() => resolveComponentGraph(db, expandPrototypeForSave(db, doc).doc));
  const legacy = await withLegacyResolver(() => shotOf(() => resolveComponentGraph(db, expandPrototypeForSave(db, doc).doc)));
  return { modern, legacy };
}

describe("BR-01b — дифференциальный резолв старый vs новый (корпус фикстур)", () => {
  test("совпадение: обычный документ с авторским компонентом резолвится одинаково обоими резолверами", async () => {
    const { db, handler } = await setup();
    await publishComponent(handler, "ctyp-accrual-badge", "CtypAccrualBadge", badgeSource(false));
    await publishNextVersion(handler, "ctyp-accrual-badge", 1, badgeSource(true));
    const { modern, legacy } = await differential(db, docWithBadge("plain"));
    expect(modern).toEqual(legacy);
    expect(modern.nodes).toEqual([{
      name: "CtypAccrualBadge", componentId: "ctyp-accrual-badge", version: 2, origin: "head-active",
      sourceHash: expect.any(String), propsSchemaHash: expect.any(String),
    }]);
    db.close();
  }, 60000);

  test("совпадение: композиция БЕЗ авторского элемента того же типа — оба резолвера дают пин манифеста", async () => {
    const { db, handler } = await setup();
    await publishComponent(handler, "ctyp-success-shell", "CtypSuccessShell", await fixture("ctyp-success-shell.tsx"));
    await publishComponent(handler, "ctyp-accrual-badge", "CtypAccrualBadge", badgeSource(false));
    expect((await handler(req("/compositions", "POST", { id: "ctyp-payment-success", designSystem: "yandex-pay", doc: compositionDoc }))).status).toBe(201);
    expect((await handler(req("/compositions/ctyp-payment-success/publish", "POST", { baseRev: 1 }))).status).toBe(201);
    await publishNextVersion(handler, "ctyp-accrual-badge", 1, badgeSource(true));

    const { modern, legacy } = await differential(db, docWithComposition("composed", false));
    expect(modern).toEqual(legacy);
    // Бейдж — из раскрытия, поэтому пин композиции (v1) законен на обоих путях.
    expect(modern.nodes!.find((node) => node.name === "CtypAccrualBadge")).toMatchObject({ version: 1, origin: "composition-pin" });
    db.close();
  }, 60000);

  test("совпадение: отсутствующая публикация — одинаковый типизированный отказ на обоих резолверах", async () => {
    const { db, handler } = await setup();
    await publishComponent(handler, "ctyp-accrual-badge", "CtypAccrualBadge", badgeSource(false));
    // Тип, которого в ДС нет вовсе.
    const doc = docWithBadge("missing");
    doc.screens[0]!.spec.elements.authored!.type = "CtypNotPublished";
    const { modern, legacy } = await differential(db, doc);
    expect(modern).toEqual(legacy);
    expect(modern.error).toBe("validation_failed");
    db.close();
  }, 60000);

  test("РАСХОЖДЕНИЕ ОЖИДАЕМО (класс H1): пин композиции + авторский элемент того же типа", async () => {
    const { db, handler } = await setup();
    await publishComponent(handler, "ctyp-success-shell", "CtypSuccessShell", await fixture("ctyp-success-shell.tsx"));
    await publishComponent(handler, "ctyp-accrual-badge", "CtypAccrualBadge", badgeSource(false));
    expect((await handler(req("/compositions", "POST", { id: "ctyp-payment-success", designSystem: "yandex-pay", doc: compositionDoc }))).status).toBe(201);
    expect((await handler(req("/compositions/ctyp-payment-success/publish", "POST", { baseRev: 1 }))).status).toBe(201);
    await publishNextVersion(handler, "ctyp-accrual-badge", 1, badgeSource(true));

    const { modern, legacy } = await differential(db, docWithComposition("h1", true));
    // Legacy: пин течёт по имени — авторский элемент молча судится схемой v1 (root cause 422 фидбэка).
    expect(legacy.nodes!.find((node) => node.name === "CtypAccrualBadge")).toMatchObject({ version: 1, origin: "composition-pin" });
    // BR-01a/01b: две версии одного имени в name-keyed карте невыразимы — честный типизированный отказ.
    expect(modern.error).toBe("component_pin_conflict");
    expect(modern).not.toEqual(legacy);
    db.close();
  }, 60000);

  test("РАСХОЖДЕНИЕ ОЖИДАЕМО (класс H2): readiness резолвит раскрытый документ, legacy — нераскрытый", async () => {
    const { dir, db, handler } = await setup();
    await publishComponent(handler, "ctyp-success-shell", "CtypSuccessShell", await fixture("ctyp-success-shell.tsx"));
    await publishComponent(handler, "ctyp-accrual-badge", "CtypAccrualBadge", badgeSource(false));
    expect((await handler(req("/compositions", "POST", { id: "ctyp-payment-success", designSystem: "yandex-pay", doc: compositionDoc }))).status).toBe(201);
    expect((await handler(req("/compositions/ctyp-payment-success/publish", "POST", { baseRev: 1 }))).status).toBe(201);
    const doc = docWithComposition("h2", false);
    expect((await handler(req("/prototypes", "POST", { doc }))).status).toBe(201);
    const stored = new PrototypeRepo(db).draft("h2").doc;

    // Нераскрытый документ: composition — host-примитив, компонентов раскрытия резолвер не видит.
    const unexpanded = shotOf(() => resolveComponentGraph(db, stored));
    expect(unexpanded.nodes).toEqual([]);
    const expanded = shotOf(() => resolveComponentGraph(db, expandPrototypeForSave(db, stored).doc));
    expect(expanded.nodes!.map((node) => node.name).sort()).toEqual(["CtypAccrualBadge", "CtypSuccessShell"]);
    // Тот же контраст в отчёте готовности покрыт `server/schema-resolver-diagnosis.test.ts` (H2).
    expect((await snapshotDefinitions(db, expandPrototypeForSave(db, stored).doc, dir)).pins.map((pin) => pin.name).sort())
      .toEqual(["CtypAccrualBadge", "CtypSuccessShell"]);
    db.close();
  }, 60000);

  test("РАСХОЖДЕНИЕ ОЖИДАЕМО (класс H4): голова track:head после переноса компонента в другую ДС", async () => {
    const { db, handler } = await setup();
    expect((await handler(req("/design-systems", "POST", { id: "h4-ds", name: "H4 DS", description: "Second design system for the H4 differential" }))).status).toBe(201);
    await publishComponent(handler, "ctyp-accrual-badge", "CtypAccrualBadge", badgeSource(false));
    await publishNextVersion(handler, "ctyp-accrual-badge", 1, badgeSource(true), "h4-ds");

    // Save-путь (граф) фильтрует ДС: в yandex-pay видна только версия 1 — одинаково на обоих резолверах.
    const { modern, legacy } = await differential(db, docWithBadge("h4"));
    expect(modern.nodes![0]).toMatchObject({ version: 1 });
    expect(legacy.nodes![0]).toMatchObject({ version: 1 });

    const pin = { id: "ctyp-accrual-badge", version: 1 };
    // BR-01a/01b: голова резолвится в ДС закреплённой версии — та же v1, что примет save.
    expect(resolveHeadPublish(db, pin)?.version).toBe(1);
    // Legacy: фильтра ДС нет — голова перескакивает в чужую ДС (v2), и снап рендерит не то, что save.
    expect((await withLegacyResolver(() => resolveHeadPublish(db, pin)))?.version).toBe(2);
    db.close();
  }, 60000);

  test("track:head — резолвер записывает в пины разрешённую голову, без fallback на прежнюю active", async () => {
    const { db, handler } = await setup();
    await publishComponent(handler, "ctyp-accrual-badge", "CtypAccrualBadge", badgeSource(false));
    expect((await handler(req("/prototypes", "POST", { doc: docWithBadge("tracked"), kind: "component-gallery" }))).status).toBe(201);
    expect((await handler(req("/prototypes/tracked/lifecycle", "POST", { track: "head" }))).status).toBe(200);
    await publishNextVersion(handler, "ctyp-accrual-badge", 1, badgeSource(true));

    const repo = new PrototypeRepo(db);
    // Пин read-пути — разрешённая голова (v2), а не прежняя active (v1).
    expect(repo.draft("tracked").components.map((pin) => pin.version)).toEqual([2]);
    const readiness = repo.bundleReadiness("tracked", 1);
    expect(readiness.resolvedPins[0]).toMatchObject({ version: 2, resolvedVersion: 2 });
    db.close();
  }, 60000);

  test("ключ кэша схемы — ровно контракт фидбэка §4 и различает каждый его вход", () => {
    const base = {
      designSystemId: "yandex-pay", designSystemMetaVersion: 3, catalogRevision: "cat_1",
      componentId: "ctyp-accrual-badge", componentVersion: 2, sourceHash: "a".repeat(64), propsSchemaHash: "b".repeat(64),
    };
    const key = schemaCacheKeyOf(base);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    // Порядок ключей объекта на значение не влияет (канонизация), а каждый вход — влияет.
    expect(schemaCacheKeyOf({ ...base })).toBe(key);
    const variants: Partial<typeof base>[] = [
      { designSystemId: "other" }, { designSystemMetaVersion: 4 }, { catalogRevision: "cat_2" },
      { componentId: "other" }, { componentVersion: 3 }, { sourceHash: "c".repeat(64) },
      { propsSchemaHash: null as unknown as string },
    ];
    for (const variant of variants) expect(schemaCacheKeyOf({ ...base, ...variant })).not.toBe(key);
  });
});

// --- AC §4/§5 фидбэка -------------------------------------------------------

const geometryOk = (): WorkerResult => ({
  ok: true,
  geometry: {
    rects: [{ key: "root", instance: 0, domIndex: 0, x: 0, y: 0, width: 10, height: 10, layoutContext: null }],
    truncated: false, total: 1,
    safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
    roleRects: {}, frame: { x: 0, y: 0, width: 390, height: 844, source: "surface" },
    content: { x: 0, y: 0, width: 390, height: 844 }, layout: { x: 0, y: 0, width: 390, height: 844 },
    scroll: { width: 390, height: 844 },
    viewportOwnership: { frame: { width: 390, height: 844 }, content: { width: 390, height: 844 }, scroll: { width: 390, height: 844 }, scrollable: false, owners: [], unownedPct: 0 },
    issues: [],
  },
  consoleErrors: [], pageErrors: [], browserVersion: "test/geometry",
} as unknown as WorkerResult);

async function settle(service: ScreenshotService, jobId: string) {
  for (let i = 0; i < 200 && !["done", "error"].includes(service.get(jobId).status); i += 1) await Bun.sleep(5);
  return service.get(jobId);
}

describe("BR-01b — AC §4/§5: save, status и snap называют один резолв", () => {
  test("копия документа с @2 {mode:\"current-main\"} сохраняется, и три ручки называют одинаковые resolvedVersion/sourceHash/propsSchemaHash", async () => {
    const { dir, db, handler } = await setup();
    await publishComponent(handler, "ctyp-accrual-badge", "CtypAccrualBadge", badgeSource(false));
    expect((await publishNextVersion(handler, "ctyp-accrual-badge", 1, badgeSource(true))).version).toBe(2);

    // Save копии документа, использующей новый prop версии 2 (AC §4 фидбэка).
    const created = await handler(req("/prototypes", "POST", { doc: docWithBadge("ac4") }));
    expect(created.status).toBe(201);
    const saved = await handler(req("/prototypes/ac4", "PUT", { baseRev: 1, doc: docWithBadge("ac4", { amount: "34 ₽", mode: "current-main" }) }));
    expect(saved.status).toBe(200);
    const saveBody = await asJson<{ rev: number; components: { id: string; resolvedVersion: number; sourceHash: string; propsSchemaHash: string }[] }>(saved);
    const fromSave = saveBody.components.find((component) => component.id === "ctyp-accrual-badge")!;
    expect(fromSave).toMatchObject({ resolvedVersion: 2, sourceHash: expect.any(String), propsSchemaHash: expect.any(String) });

    // Тот же резолв в render-status.
    const status = await handler(req("/prototypes/ac4/screens/success/render-status"));
    expect(status.status).toBe(200);
    const statusBody = await asJson<{ resolvedPins: { id: string; resolvedVersion: number; sourceHash: string; propsSchemaHash: string }[] }>(status);
    const fromStatus = statusBody.resolvedPins.find((pin) => pin.id === "ctyp-accrual-badge")!;

    // И в снапе (geometry probe): componentPins несут ту же тройку.
    const service = new ScreenshotService({ db, dataDir: dir, serveDist: "dist", captureOrigin: "http://127.0.0.1:8787", chromiumAvailable: true, runJob: (async () => geometryOk()) as RunJob });
    const { jobId } = service.enqueuePrototype("ac4", "success", { probe: "geometry", viewport: { width: 390, height: 844 } });
    const final = await settle(service, jobId);
    expect(final.status).toBe("done");
    if (final.result?.kind !== "geometry" || final.result.surface !== "prototype") throw new Error("expected prototype geometry result");
    const fromSnap = final.result.componentPins.find((pin) => pin.id === "ctyp-accrual-badge")!;

    const triple = (value: { resolvedVersion?: number; sourceHash?: string | null; propsSchemaHash?: string | null }) =>
      [value.resolvedVersion, value.sourceHash, value.propsSchemaHash];
    expect(triple(fromStatus)).toEqual(triple(fromSave));
    expect(triple(fromSnap)).toEqual(triple(fromSave));
    db.close();
  }, 60000);

  test("после promote новой версии повторный save не видит старую схему", async () => {
    const { db, handler } = await setup();
    await publishComponent(handler, "ctyp-accrual-badge", "CtypAccrualBadge", badgeSource(false));
    // До publish версии 2 новый prop отвергается фактической схемой v1.
    const early = await handler(req("/prototypes", "POST", { doc: docWithBadge("promote", { amount: "34 ₽", mode: "current-main" }) }));
    expect(early.status).toBe(422);

    expect((await handler(req("/prototypes", "POST", { doc: docWithBadge("promote") }))).status).toBe(201);
    const before = await asJson<{ resolvedPins: { id: string; resolvedVersion: number; propsSchemaHash: string }[] }>(
      await handler(req("/prototypes/promote/screens/success/render-status")));
    expect(before.resolvedPins[0]).toMatchObject({ resolvedVersion: 1 });

    await publishNextVersion(handler, "ctyp-accrual-badge", 1, badgeSource(true));
    // Повторный save резолвит уже новую схему: тот же документ с `mode` теперь проходит,
    // а ответ называет версию 2 и **другой** propsSchemaHash.
    const saved = await handler(req("/prototypes/promote", "PUT", { baseRev: 1, doc: docWithBadge("promote", { amount: "34 ₽", mode: "current-main" }) }));
    expect(saved.status).toBe(200);
    const body = await asJson<{ components: { id: string; resolvedVersion: number; propsSchemaHash: string }[] }>(saved);
    expect(body.components[0]).toMatchObject({ id: "ctyp-accrual-badge", resolvedVersion: 2 });
    expect(body.components[0]!.propsSchemaHash).not.toBe(before.resolvedPins[0]!.propsSchemaHash);
    db.close();
  }, 60000);

  test("kill-switch: поля резолвера исчезают из save-ответа и render-status (доволновой ответ)", async () => {
    const { db, handler } = await setup();
    await publishComponent(handler, "ctyp-accrual-badge", "CtypAccrualBadge", badgeSource(false));
    await withLegacyResolver(async () => {
      const created = await handler(req("/prototypes", "POST", { doc: docWithBadge("legacy-fields") }));
      expect(created.status).toBe(201);
      expect(await asJson<Record<string, unknown>>(created)).not.toHaveProperty("components");
      const status = await asJson<{ resolvedPins: Record<string, unknown>[] }>(
        await handler(req("/prototypes/legacy-fields/screens/success/render-status")));
      expect(Object.keys(status.resolvedPins[0]!).sort()).toEqual(["bundleHash", "bundleUrl", "id", "name", "status", "version"]);
    });
    db.close();
  }, 60000);
});
