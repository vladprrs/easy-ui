import { createTestHandler } from "./test-auth";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { openDatabase } from "./db";
import { computeReadiness } from "./readiness";
import { expandPrototypeForSave, snapshotDefinitions } from "./validation";
import { importPublished, materializeSource } from "./components/pipeline";
import { ComponentRepo } from "./repos/components";
import { PrototypeRepo } from "./repos/prototypes";
import { prototypeDocSchema } from "../src/prototype/schema";

/**
 * V0-D1 плана docs/plans/2026-08-08-blocker-removal-eui-br.md (§1, EUI-BR-01).
 *
 * Диагностические тесты гипотез H1–H4 root cause `422 Unrecognized key` при save
 * прототипа. Тесты, помеченные `// RED (Hn)`, **ассертят текущее (баговое) поведение**,
 * чтобы CI оставался зелёным до BR-01a; V1-агент инвертирует эти ассерты вместе с фиксом.
 */

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

type Handler = (request: Request) => Promise<Response>;

const req = (url: string, method = "GET", value?: unknown) => new Request(`http://test/api${url}`, {
  method,
  headers: value === undefined ? undefined : { "content-type": "application/json" },
  body: value === undefined ? undefined : JSON.stringify(value),
});
const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;
const issues = async (response: Response) =>
  (await json<{ error: { code: string; issues?: { path: string[]; message: string }[] } }>(response)).error;

async function setup() {
  const dir = await mkdtemp(resolve(process.cwd(), ".schema-diag-test-"));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  return { dir, db, handler: createTestHandler(db, { dataDir: dir }) as Handler };
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

/** Публикует следующую версию компонента: PUT (новая ревизия) + publish. */
async function publishNextVersion(handler: Handler, id: string, baseRev: number, source: string) {
  const saved = await handler(req(`/components/${id}`, "PUT", { baseRev, source }));
  expect(saved.status).toBe(200);
  const { rev } = await json<{ rev: number }>(saved);
  const published = await handler(req(`/components/${id}/publish`, "POST", { baseRev: rev }));
  if (published.status !== 201) throw new Error(`publish ${id}@rev${rev} failed: ${published.status} ${await published.text()}`);
  return json<{ version: number }>(published);
}

/**
 * Мотивирующий сетап H1: композиция опубликована ПОКА активна версия 1 бейджа
 * (её manifest пинует `ctyp-accrual-badge@1`), затем выходит версия 2 с новым prop `mode`.
 */
async function seedCompositionPinnedToV1() {
  const { dir, db, handler } = await setup();
  await publishComponent(handler, "ctyp-success-shell", "CtypSuccessShell", await fixture("ctyp-success-shell.tsx"));
  await publishComponent(handler, "ctyp-accrual-badge", "CtypAccrualBadge", badgeSource(false));
  expect((await handler(req("/compositions", "POST", { id: "ctyp-payment-success", designSystem: "yandex-pay", doc: compositionDoc }))).status).toBe(201);
  expect((await handler(req("/compositions/ctyp-payment-success/publish", "POST", { baseRev: 1 }))).status).toBe(201);
  // Активной становится версия 2 — та, чью схему авторский элемент вправе использовать.
  const v2 = await publishNextVersion(handler, "ctyp-accrual-badge", 1, badgeSource(true));
  expect(v2.version).toBe(2);
  return { dir, db, handler };
}

/** Документ композиции + (опционально) авторский элемент того же типа ВНЕ композиции. */
function docWithAuthoredBadge(id: string, authored: boolean) {
  const doc = structuredClone(composedScreen) as typeof composedScreen & {
    id: string; screens: { spec: { elements: Record<string, unknown> } }[];
  };
  doc.id = id;
  const screen = doc.screens[0]!;
  if (authored) {
    (screen.spec.elements.root as { children: string[] }).children = ["screen", "authored"];
    screen.spec.elements.authored = { type: "CtypAccrualBadge", props: { amount: "34 ₽", mode: "current-main" } };
  }
  return prototypeDocSchema.parse(doc);
}

describe("H1 — composition pins leak onto authored elements", () => {
  test("RED (H1): an authored element outside the composition is validated against the composition-pinned version", async () => {
    const { db, handler } = await seedCompositionPinnedToV1();

    // Контроль: тот же авторский элемент с `mode` БЕЗ композиции в документе проходит save —
    // значит active-версия 2 действительно принимает `mode`, и дело не в самой схеме.
    const control = structuredClone(composedScreen) as { id: string; screens: { spec: { root: string; elements: Record<string, unknown> } }[] };
    control.id = "authored-only";
    control.screens[0]!.spec.elements = {
      root: { type: "@eui/FlowRoot", props: {}, children: ["authored"] },
      authored: { type: "CtypAccrualBadge", props: { amount: "34 ₽", mode: "current-main" } },
    };
    const okResponse = await handler(req("/prototypes", "POST", { doc: prototypeDocSchema.parse(control) }));
    expect(okResponse.status).toBe(201);

    // Тот же элемент в документе, где ЕЩЁ ЕСТЬ композиция, пинующая версию 1.
    const response = await handler(req("/prototypes", "POST", { doc: docWithAuthoredBadge("composed-and-authored", true) }));
    // RED (H1): текущее поведение — баг, фикс в BR-01a. Ожидание после фикса: 201.
    expect(response.status).toBe(422);
    const error = await issues(response);
    expect(error.code).toBe("validation_failed");
    expect(JSON.stringify(error.issues)).toContain("mode");
    db.close();
  }, 60000);

  test("H1 mechanism: compositionComponentPins map is keyed by type name, so snapshotDefinitions resolves v1 for every element of that type", async () => {
    const { dir, db } = await seedCompositionPinnedToV1();
    const doc = docWithAuthoredBadge("mechanism", true);
    const expanded = expandPrototypeForSave(db, doc);
    const snapshot = await snapshotDefinitions(db, expanded.doc, dir);
    const badgePin = snapshot.pins.find((pin) => pin.name === "CtypAccrualBadge");
    // RED (H1): пин — версия 1 из manifest'а композиции, хотя active-версия компонента = 2.
    expect(badgePin?.version).toBe(1);
    const active = db.query("SELECT version FROM component_publishes WHERE component_id='ctyp-accrual-badge' AND status='active' ORDER BY version DESC LIMIT 1").get() as { version: number };
    expect(active.version).toBe(2);
    // Карта определений name-keyed: одна схема на имя типа — двух пинов одного имени в ней нет.
    expect(snapshot.definitions.CtypAccrualBadge!.props.safeParse({ amount: "1", mode: "compact" }).success).toBe(false);
    db.close();
  }, 60000);
});

describe("H2 — readiness resolves definitions from the unexpanded document", () => {
  test("RED (H2): readiness sees @eui/Composition instead of the expanded tree, so save and readiness disagree", async () => {
    const { dir, db, handler } = await seedCompositionPinnedToV1();
    const created = await handler(req("/prototypes", "POST", { doc: docWithAuthoredBadge("readiness-doc", false) }));
    expect(created.status).toBe(201);

    // Save-путь: раскрытие ДО snapshotDefinitions — компонент композиции резолвится.
    const stored = new PrototypeRepo(db).draft("readiness-doc").doc;
    const expanded = expandPrototypeForSave(db, stored);
    const saveSnapshot = await snapshotDefinitions(db, expanded.doc, dir);
    expect(Object.keys(saveSnapshot.definitions)).toContain("CtypAccrualBadge");
    expect(saveSnapshot.pins.map((pin) => pin.name).sort()).toEqual(["CtypAccrualBadge", "CtypSuccessShell"]);

    // Readiness-путь (readiness.ts:174): snapshotDefinitions по НЕраскрытому документу.
    // `@eui/Composition` — host-примитив, поэтому резолв не падает: он просто не доходит
    // до компонентов, которые существуют только внутри раскрытия.
    const readinessSnapshot = await snapshotDefinitions(db, stored, dir);
    // RED (H2): текущее поведение — баг, фикс в BR-01a. После фикса обе карты совпадают.
    expect(Object.keys(readinessSnapshot.definitions)).not.toContain("CtypAccrualBadge");
    expect(Object.keys(readinessSnapshot.definitions)).not.toContain("CtypSuccessShell");
    expect(readinessSnapshot.pins).toEqual([]);

    // Следствие: гейт `schema` отчёта валидирует другое дерево, чем принял save.
    const report = await computeReadiness(db, "readiness-doc", { dataDir: dir });
    const schema = report.gates.find((gate) => gate.id === "schema");
    expect(schema).toBeDefined();
    // Резолв не сорвался (`definitions_unavailable` нет) — гейт просто судит о другом дереве:
    // ни один prop элемента композиции им не проверяется, схем этих типов у него нет.
    expect(schema?.status).not.toBe("fail");
    expect(JSON.stringify(schema)).not.toContain("CtypAccrualBadge");
    db.close();
  }, 60000);
});

describe("H3 — imported module cache keyed by id@rev", () => {
  test("H3: component_revisions.source is immutable per (id, rev) — no API path repoints a key at different bytes", async () => {
    const { db, handler } = await setup();
    await publishComponent(handler, "ctyp-accrual-badge", "CtypAccrualBadge", badgeSource(false));
    const before = new ComponentRepo(db).source("ctyp-accrual-badge", 1).source;
    await publishNextVersion(handler, "ctyp-accrual-badge", 1, badgeSource(true));
    // Новая публикация = новая ревизия: ключ кэша `id@2` ещё не занят, `id@1` не переписан.
    expect(new ComponentRepo(db).source("ctyp-accrual-badge", 1).source).toBe(before);
    const revs = db.query("SELECT rev FROM component_revisions WHERE component_id='ctyp-accrual-badge' ORDER BY rev").all() as { rev: number }[];
    expect(revs.map((row) => row.rev)).toEqual([1, 2]);
    const publishes = db.query("SELECT version,rev FROM component_publishes WHERE component_id='ctyp-accrual-badge' ORDER BY version").all() as { version: number; rev: number }[];
    expect(publishes).toEqual([{ version: 1, rev: 1 }, { version: 2, rev: 2 }]);
    db.close();
  }, 60000);

  test("H3: re-staging a failed publish reuses the same (component_id, rev) but the same source bytes, so the cached module stays correct", async () => {
    const { dir, db, handler } = await setup();
    await publishComponent(handler, "ctyp-accrual-badge", "CtypAccrualBadge", badgeSource(false));
    const repo = new ComponentRepo(db);
    // Ревизия 2 сорвана на stage: строка остаётся в статусе failed.
    const saved = await handler(req("/components/ctyp-accrual-badge", "PUT", { baseRev: 1, source: badgeSource(true) }));
    expect(saved.status).toBe(200);
    const revision = repo.source("ctyp-accrual-badge", 2);
    const staged = repo.stage("ctyp-accrual-badge", 2, { compiledJs: "x", bundleHash: "x", sourceHash: "x", meta: { description: "x" } as never });
    repo.fail("ctyp-accrual-badge", staged.version);
    expect((repo.versions("ctyp-accrual-badge").at(-1) as { status: string }).status).toBe("failed");

    // Повтор publish переписывает ту же failed-строку тем же (component_id, rev).
    const republished = await handler(req("/components/ctyp-accrual-badge/publish", "POST", { baseRev: 2 }));
    expect(republished.status).toBe(201);
    const rows = db.query("SELECT version,rev,status FROM component_publishes WHERE component_id='ctyp-accrual-badge' ORDER BY version").all() as { version: number; rev: number; status: string }[];
    // Номер версии сохранён (failed-строка переписана), дырки в нумерации нет.
    expect(rows.map((row) => [row.version, row.rev])).toEqual([[1, 1], [2, 2]]);
    expect(rows[1]!.status).toBe("active");
    // Источник ревизии 2 не менялся между stage-попытками — ключ `id@2` всё время указывает
    // на одни и те же байты, поэтому промах кэша `imported` недостижим.
    expect(repo.source("ctyp-accrual-badge", 2).source).toBe(revision.source);
    const path = await materializeSource(dir, "ctyp-accrual-badge", 2, repo.source("ctyp-accrual-badge", 2).source);
    const mod = await importPublished("ctyp-accrual-badge", 2, path);
    expect(mod.definition.props.safeParse({ amount: "1", mode: "compact" }).success).toBe(true);
    db.close();
  }, 60000);
});

describe("H4 — design_system filter differs between the save SQL and headPin", () => {
  test("RED (H4): after a component moves to another design system, save resolves the old version while headPin resolves the new one", async () => {
    const { dir, db, handler } = await setup();
    expect((await handler(req("/design-systems", "POST", { id: "h4-ds", name: "H4 DS", description: "Second design system for the H4 diagnosis" }))).status).toBe(201);
    await publishComponent(handler, "ctyp-accrual-badge", "CtypAccrualBadge", badgeSource(false));
    // Ревизия 2 живёт в другой ДС; её публикация — версия 2.
    const moved = await handler(req("/components/ctyp-accrual-badge", "PUT", { baseRev: 1, designSystem: "h4-ds", source: badgeSource(true) }));
    expect(moved.status).toBe(200);
    expect((await handler(req("/components/ctyp-accrual-badge/publish", "POST", { baseRev: 2 }))).status).toBe(201);

    // Save-путь фильтрует по `cr.design_system` — в yandex-pay видна только версия 1.
    const control = structuredClone(composedScreen) as { id: string; screens: { spec: { root: string; elements: Record<string, unknown> } }[] };
    control.id = "h4-doc";
    control.screens[0]!.spec.elements = {
      root: { type: "@eui/FlowRoot", props: {}, children: ["authored"] },
      authored: { type: "CtypAccrualBadge", props: { amount: "34 ₽" } },
    };
    const doc = prototypeDocSchema.parse(control);
    const snapshot = await snapshotDefinitions(db, doc, dir);
    expect(snapshot.pins.find((pin) => pin.name === "CtypAccrualBadge")?.version).toBe(1);

    // Read-путь `headPin` фильтра ДС не имеет — трекающий документ увидит версию 2.
    expect((await handler(req("/prototypes", "POST", { doc, kind: "component-gallery" }))).status).toBe(201);
    expect((await handler(req("/prototypes/h4-doc/lifecycle", "POST", { track: "head" }))).status).toBe(200);
    const pinned = new PrototypeRepo(db).draft("h4-doc").components as { name: string; version: number }[];
    // RED (H4): текущее поведение — баг, фикс в BR-01a (согласование фильтра ДС).
    expect(pinned.find((pin) => pin.name === "CtypAccrualBadge")?.version).toBe(2);
    db.close();
  }, 60000);
});
