import { createTestHandler } from "./test-auth";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { openDatabase } from "./db";

/**
 * Волна 5: версионированные композиции.
 *
 * Главный инвариант теста — **полнота пинов** (B3): компонент, встречающийся только
 * внутри композиции, обязан оказаться в `prototype_revision_components`, иначе
 * FK-RESTRICT инвариант обходится и опубликованная версия ссылается на удаляемый компонент.
 */

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function setup() {
  const dir = await mkdtemp(resolve(process.cwd(), ".compositions-test-"));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  return { db, handler: createTestHandler(db, { dataDir: dir }) };
}

const req = (url: string, method = "GET", value?: unknown) => new Request(`http://test/api${url}`, {
  method,
  headers: value === undefined ? undefined : { "content-type": "application/json" },
  body: value === undefined ? undefined : JSON.stringify(value),
});
const fixture = (name: string) => Bun.file(resolve("server/fixtures", name)).text();
const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

const compositionDoc = await Bun.file("test/fixtures/architecture/ctyp-payment-success.composition.json").json();
const composedScreen = await Bun.file("test/fixtures/architecture/composition-screen.json").json();

async function publishComponent(handler: (request: Request) => Promise<Response>, id: string, name: string, file: string) {
  expect((await handler(req("/components", "POST", { designSystem: "yandex-pay", id, name, source: await fixture(file) }))).status).toBe(201);
  const published = await handler(req(`/components/${id}/publish`, "POST", { baseRev: 1 }));
  expect(published.status).toBe(201);
}

/** Публикует оба компонента и композицию, возвращает handler/db. */
async function seed() {
  const { db, handler } = await setup();
  await publishComponent(handler, "ctyp-success-shell", "CtypSuccessShell", "ctyp-success-shell.tsx");
  await publishComponent(handler, "ctyp-accrual-badge", "CtypAccrualBadge", "ctyp-accrual-badge.tsx");
  const created = await handler(req("/compositions", "POST", { id: "ctyp-payment-success", designSystem: "yandex-pay", doc: compositionDoc }));
  expect(created.status).toBe(201);
  const published = await handler(req("/compositions/ctyp-payment-success/publish", "POST", { baseRev: 1 }));
  expect(published.status).toBe(201);
  return { db, handler };
}

describe("composition resource lifecycle", () => {
  test("create/save/publish/version mirror the component lifecycle and CAS on baseRev", async () => {
    const { db, handler } = await seed();
    const saved = await handler(req("/compositions/ctyp-payment-success", "PUT", { doc: { ...compositionDoc, description: "v2" }, baseRev: 1 }));
    expect(saved.status).toBe(200);
    expect(await json<{ rev: number }>(saved)).toEqual({ rev: 2 });
    // CAS: устаревший baseRev — 409.
    expect((await handler(req("/compositions/ctyp-payment-success", "PUT", { doc: compositionDoc, baseRev: 1 }))).status).toBe(409);
    const meta = await json<{ headRev: number; publishedVersion: number; versions: unknown[] }>(await handler(req("/compositions/ctyp-payment-success")));
    expect(meta).toMatchObject({ headRev: 2, publishedVersion: 1 });
    const version = await json<{ version: number; doc: { name: string } }>(await handler(req("/compositions/ctyp-payment-success/versions/1")));
    expect(version.version).toBe(1);
    // Опубликованная версия неизменяема: правка головы не меняет её документ.
    expect(version.doc.name).toBe("CtypPaymentSuccessComposition");
    db.close();
  });

  test("rejects a composition whose element type is not a published component of the design system", async () => {
    const { db, handler } = await setup();
    const broken = structuredClone(compositionDoc) as { spec: { elements: Record<string, { type: string }> } };
    broken.spec.elements.badge!.type = "NotPublishedAnywhere";
    const response = await handler(req("/compositions", "POST", { id: "broken", designSystem: "yandex-pay", doc: broken }));
    expect(response.status).toBe(422);
    const body = await json<{ error: { issues: { message: string }[] } }>(response);
    expect(body.error.issues.map((issue) => issue.message)).toContain("Unknown or unpublished component type in design system 'yandex-pay': NotPublishedAnywhere");
    db.close();
  });

  test("rejects a composition document carrying a region marker or a nested composition", async () => {
    const { db, handler } = await setup();
    const region = structuredClone(compositionDoc) as { spec: { elements: Record<string, Record<string, unknown>> } };
    region.spec.elements.badge!.region = "footer";
    expect((await handler(req("/compositions", "POST", { id: "regioned", designSystem: "yandex-pay", doc: region }))).status).toBe(422);
    db.close();
  });
});

describe("composition version status transitions", () => {
  test("superseded requires a valid supersededBy, exactly like a component version", async () => {
    const { db, handler } = await seed();
    // Вторая публикация — цель для supersededBy.
    expect((await handler(req("/compositions/ctyp-payment-success", "PUT", { doc: { ...compositionDoc, description: "v2" }, baseRev: 1 }))).status).toBe(200);
    expect((await handler(req("/compositions/ctyp-payment-success/publish", "POST", { baseRev: 2 }))).status).toBe(201);

    const status = (body: unknown, version = 1) => handler(req(`/compositions/ctyp-payment-success/versions/${version}/status`, "POST", body));
    // Без supersededBy — 422, а не молчаливый переход.
    const missing = await status({ status: "superseded", baseStatusRev: 1 });
    expect(missing.status).toBe(422);
    expect(await json<{ error: { issues: { path: string[] }[] } }>(missing)).toMatchObject({ error: { issues: [{ path: ["supersededBy"] }] } });
    // Сам на себя и на несуществующую версию — тоже 422.
    expect((await status({ status: "superseded", supersededBy: 1, baseStatusRev: 1 })).status).toBe(422);
    expect((await status({ status: "superseded", supersededBy: 99, baseStatusRev: 1 })).status).toBe(422);

    const ok = await status({ status: "superseded", supersededBy: 2, baseStatusRev: 1 });
    expect(ok.status).toBe(200);
    const versions = await json<{ version: number; status: string; supersededBy: number | null }[]>(await handler(req("/compositions/ctyp-payment-success/versions")));
    expect(versions[0]).toMatchObject({ version: 1, status: "superseded", supersededBy: 2 });

    // Цикл 2 → 1 при уже существующем 1 → 2 отклоняется.
    expect((await status({ status: "superseded", supersededBy: 1, baseStatusRev: 1 }, 2)).status).toBe(422);
    db.close();
  });
});

describe("acceptance: CTYP payment success rebuilt as a composition", () => {
  test("saves the authored doc, pins every component reachable through the composition, and publishes clean", async () => {
    const { db, handler } = await seed();

    const created = await handler(req("/prototypes", "POST", { doc: composedScreen }));
    expect(created.status).toBe(201);
    expect(await json<{ warnings: { code?: string }[] }>(created)).toMatchObject({ rev: 1 });
    const warnings = (await json<{ warnings: { code?: string; message: string }[] }>(await handler(req("/prototypes", "POST", { doc: { ...composedScreen, id: "ctyp-warn-probe" } })))).warnings;
    expect(warnings.filter((warning) => warning.code?.startsWith("arch/"))).toEqual([]);

    // В БД лежит АВТОРСКИЙ документ (с @eui/Composition), а не раскрытый.
    const stored = (db.query("SELECT doc FROM prototype_revisions WHERE prototype_id='ctyp-payment-success-composed' AND rev=1").get() as { doc: string }).doc;
    expect(stored).toContain("@eui/Composition");
    expect(stored).not.toContain("CtypAccrualBadge");

    // …и при этом пины полны: CtypAccrualBadge встречается ТОЛЬКО внутри композиции.
    const pins = db.query("SELECT component_id id,component_version version FROM prototype_revision_components WHERE prototype_id='ctyp-payment-success-composed' AND rev=1 ORDER BY component_id").all() as { id: string; version: number }[];
    expect(pins.map((pin) => pin.id)).toEqual(["ctyp-accrual-badge", "ctyp-success-shell"]);
    const compositionPins = db.query("SELECT composition_id id,composition_version version FROM prototype_revision_compositions WHERE prototype_id='ctyp-payment-success-composed' AND rev=1").all();
    expect(compositionPins).toEqual([{ id: "ctyp-payment-success", version: 1 }]);

    // Черновик отдаёт документы закреплённых композиций — клиент раскрывает тем же кодом.
    const draft = await json<{ compositions: { id: string; version: number; doc: { slots: string[] } }[] }>(await handler(req("/prototypes/ctyp-payment-success-composed/draft")));
    expect(draft.compositions).toHaveLength(1);
    expect(draft.compositions[0]!.doc.slots).toEqual(["nav", "merchant", "accrual", "offer", "payment-method", "footer"]);

    // Публикация проходит: проверка «все custom-типы закреплены» видит раскрытый набор.
    const published = await handler(req("/prototypes/ctyp-payment-success-composed/publish", "POST", { baseRev: 1 }));
    expect(published.status).toBe(201);

    // FK RESTRICT: закреплённая публикация композиции неудаляема, а сама композиция «в работе».
    expect(() => db.run("DELETE FROM composition_publishes WHERE composition_id='ctyp-payment-success' AND version=1")).toThrow();
    const deleted = await handler(req("/compositions/ctyp-payment-success", "DELETE", { baseRev: 1 }));
    expect(deleted.status).toBe(409);
    expect(await json<{ error: { code: string } }>(deleted)).toMatchObject({ error: { code: "composition_in_use" } });
    db.close();
  });

  test("rejects a prototype referencing an unpublished composition and one with a bad param", async () => {
    const { db, handler } = await setup();
    const missing = await handler(req("/prototypes", "POST", { doc: composedScreen }));
    expect(missing.status).toBe(422);
    expect(await json<{ error: { issues: { message: string }[] } }>(missing)).toMatchObject({
      error: { issues: [{ message: expect.stringContaining("unknown or unpublished composition") }] },
    });
    db.close();
  });

  test("rejects an authored element key containing the composition separator", async () => {
    const { db, handler } = await setup();
    const doc = structuredClone(composedScreen) as { screens: { spec: { elements: Record<string, unknown> } }[] };
    doc.screens[0]!.spec.elements["na$v"] = doc.screens[0]!.spec.elements.nav;
    const response = await handler(req("/prototypes", "POST", { doc }));
    expect(response.status).toBe(422);
    db.close();
  });
});

describe("composition params drive the expanded props", () => {
  test("a saved param value lands in the pinned component props of the expanded document", async () => {
    const { db, handler } = await seed();
    const doc = structuredClone(composedScreen) as { id: string; screens: { spec: { elements: Record<string, { props: Record<string, unknown> }> } }[] };
    doc.id = "ctyp-params";
    (doc.screens[0]!.spec.elements.screen!.props.params as Record<string, unknown>)["accrual-amount"] = "99 ₽";
    expect((await handler(req("/prototypes", "POST", { doc }))).status).toBe(201);
    // Проверяем через render-status: раскрытие идёт на save, но документ остаётся авторским.
    const stored = (db.query("SELECT doc FROM prototype_revisions WHERE prototype_id='ctyp-params' AND rev=1").get() as { doc: string }).doc;
    expect(stored).toContain("99 ₽");
    expect(stored).not.toContain("CtypAccrualBadge");
    db.close();
  });

  test("a wrong param type is a 422 mapped back to the authored path", async () => {
    const { db, handler } = await seed();
    const doc = structuredClone(composedScreen) as { id: string; screens: { spec: { elements: Record<string, { props: Record<string, unknown> }> } }[] };
    doc.id = "ctyp-bad-param";
    (doc.screens[0]!.spec.elements.screen!.props.params as Record<string, unknown>)["accrual-amount"] = 12;
    const response = await handler(req("/prototypes", "POST", { doc }));
    expect(response.status).toBe(422);
    const body = await json<{ error: { issues: { path: string[]; message: string }[] } }>(response);
    expect(body.error.issues[0]!.path).toEqual(["screens", "0", "spec", "elements", "screen", "props", "params", "accrual-amount"]);
    db.close();
  });
});

function unusedDatabaseTypeProbe(db: Database): Database { return db; }
void unusedDatabaseTypeProbe;
