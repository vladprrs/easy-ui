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
 * V0-D1 + BR-01a плана docs/plans/2026-08-08-blocker-removal-eui-br.md (§1, EUI-BR-01).
 *
 * Диагностические тесты гипотез H1–H4 root cause `422 Unrecognized key` при save прототипа.
 * Прежние `// RED (Hn)`-ассерты инвертированы вместе с фиксом BR-01a; рядом с каждым живёт
 * тест kill-switch'а `EASYUI_SCHEMA_RESOLVER_V2_DISABLED=1`, сторожащий доволновое поведение
 * byte-for-byte. H3 признана ложной — её тесты позитивные и остаются как есть.
 */

/** Прогоняет тело при поднятом kill-switch'е волны. */
async function withLegacyResolver<T>(body: () => Promise<T>): Promise<T> {
  process.env.EASYUI_SCHEMA_RESOLVER_V2_DISABLED = "1";
  try { return await body(); } finally { delete process.env.EASYUI_SCHEMA_RESOLVER_V2_DISABLED; }
}

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

/**
 * Композиция, чей бейдж живёт в **fallback** слота: манифест зависимостей пинует
 * `ctyp-accrual-badge@1`, но раскрытие в документе, который слот заполняет, его не
 * инстанцирует. Это чистая форма симптома H1 — пин без единого элемента раскрытия.
 */
const optionalCompositionDoc = {
  version: 3,
  atomicLevel: "organism",
  scope: "screen",
  ownership: { reason: "Owns the accrual block layout of the success screen" },
  name: "CtypAccrualOptionalComposition",
  description: "Композиция с необязательным бейджем начисления в fallback слота accrual",
  params: { "accrual-amount": { type: "string", required: true, description: "Сумма начисленного кэшбэка" } },
  slots: { accrual: { fallback: ["badge"], description: "Блок начисления; по умолчанию — собственный бейдж композиции" } },
  spec: {
    root: "shell",
    elements: {
      shell: { type: "CtypSuccessShell", props: { tone: "success" }, children: ["accrual"] },
      accrual: { type: "@eui/Slot", props: { name: "accrual" } },
      badge: { type: "CtypAccrualBadge", props: { amount: { $param: "accrual-amount" } } },
    },
  },
} as const;

async function seedOptionalCompositionPinnedToV1() {
  const { dir, db, handler } = await setup();
  await publishComponent(handler, "ctyp-success-shell", "CtypSuccessShell", await fixture("ctyp-success-shell.tsx"));
  await publishComponent(handler, "ctyp-accrual-badge", "CtypAccrualBadge", badgeSource(false));
  // Слот с `fallback` — форма v3 (W8c), поэтому набор **публикуется** при поднятом флаге v3;
  // раскрытие уже опубликованной композиции флагом не гейтится.
  const previous = process.env.EASYUI_COMPOSITION_V3;
  process.env.EASYUI_COMPOSITION_V3 = "1";
  try {
    expect((await handler(req("/compositions", "POST", { id: "ctyp-accrual-optional", designSystem: "yandex-pay", doc: optionalCompositionDoc }))).status).toBe(201);
    expect((await handler(req("/compositions/ctyp-accrual-optional/publish", "POST", { baseRev: 1 }))).status).toBe(201);
  } finally {
    if (previous === undefined) delete process.env.EASYUI_COMPOSITION_V3; else process.env.EASYUI_COMPOSITION_V3 = previous;
  }
  const v2 = await publishNextVersion(handler, "ctyp-accrual-badge", 1, badgeSource(true));
  expect(v2.version).toBe(2);
  return { dir, db, handler };
}

/** Документ: композиция со **заполненным** слотом (fallback не материализуется) + авторский бейдж. */
function docWithOptionalComposition(id: string) {
  return prototypeDocSchema.parse({
    version: 1,
    id,
    name: "Optional composition",
    designSystem: "yandex-pay",
    device: "mobile",
    startScreen: "success",
    state: {},
    screens: [{
      id: "success",
      name: "Success",
      spec: {
        root: "root",
        elements: {
          root: { type: "@eui/FlowRoot", props: {}, children: ["screen", "authored"] },
          screen: { type: "@eui/Composition", props: { composition: "ctyp-accrual-optional", params: { "accrual-amount": "12 ₽" } }, children: ["filler"] },
          filler: { type: "Image", props: { src: "/accrual.png", alt: "Начисление" }, slot: "accrual" },
          authored: { type: "CtypAccrualBadge", props: { amount: "34 ₽", mode: "current-main" } },
        },
      },
    }],
  });
}

/** Одноэкранный документ с единственным авторским бейджем и заданными props. */
function docWithBadgeProps(id: string, props: Record<string, unknown>) {
  const doc = structuredClone(composedScreen) as { id: string; screens: { spec: { root: string; elements: Record<string, unknown> } }[] };
  doc.id = id;
  doc.screens[0]!.spec.elements = {
    root: { type: "@eui/FlowRoot", props: {}, children: ["authored"] },
    authored: { type: "CtypAccrualBadge", props },
  };
  return prototypeDocSchema.parse(doc);
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

describe("H1 — composition pins scoped to the expansion they came from", () => {
  test("BR-01a: пин композиции, чьё раскрытие компонент не инстанцирует, больше не течёт на авторский элемент", async () => {
    const { db, handler } = await seedOptionalCompositionPinnedToV1();
    const response = await handler(req("/prototypes", "POST", { doc: docWithOptionalComposition("optional-composed") }));
    // До BR-01a: 422 `Unrecognized key: mode` — авторский элемент судился схемой пина v1.
    expect(response.status).toBe(201);
    // Пин ревизии — активная версия 2, та же, что резолвит save авторского элемента.
    const pinned = new PrototypeRepo(db).draft("optional-composed").components as { name: string; version: number }[];
    expect(pinned.find((pin) => pin.name === "CtypAccrualBadge")?.version).toBe(2);
    db.close();
  }, 60000);

  test("kill-switch: при EASYUI_SCHEMA_RESOLVER_V2_DISABLED=1 пин снова течёт по имени (доволновое 422)", async () => {
    const { db, handler } = await seedOptionalCompositionPinnedToV1();
    const response = await withLegacyResolver(() => handler(req("/prototypes", "POST", { doc: docWithOptionalComposition("legacy-composed") })));
    expect(response.status).toBe(422);
    const error = await issues(response);
    expect(error.code).toBe("validation_failed");
    expect(JSON.stringify(error.issues)).toContain("mode");
    // Доволновая форма issue: путь до объекта props, без типизированного кода и контекста.
    expect(error.issues![0] as unknown).toEqual({ path: "/screens/0/spec/elements/authored/props", pointer: "/screens/0/spec/elements/authored/props", message: expect.stringContaining("mode") });
    db.close();
  }, 60000);

  test("BR-01a: документ, требующий один тип в двух версиях, отвергается типизированным component_pin_conflict", async () => {
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

    // Тот же элемент в документе, где ЕЩЁ ЕСТЬ композиция, пинующая версию 1: карта определений
    // name-keyed, двух схем одного имени в ней нет — значит честный отказ, а не молчаливый выбор.
    const response = await handler(req("/prototypes", "POST", { doc: docWithAuthoredBadge("composed-and-authored", true) }));
    expect(response.status).toBe(422);
    const error = await json<{ error: { code: string; componentId?: string; componentName?: string; message: string; issues?: { path: string; message: string }[] } }>(response);
    expect(error.error.code).toBe("component_pin_conflict");
    expect(error.error.componentId).toBe("ctyp-accrual-badge");
    expect(error.error.componentName).toBe("CtypAccrualBadge");
    // Обе версии названы в сообщении, пути — обеих сторон конфликта.
    expect(error.error.message).toContain("v1");
    expect(error.error.message).toContain("v2");
    const paths = (error.error.issues ?? []).map((issue) => issue.path);
    expect(paths).toContain("/screens/0/spec/elements/screen$badge");
    expect(paths).toContain("/screens/0/spec/elements/authored");
    db.close();
  }, 60000);

  test("BR-01a: раскрытие композиции по-прежнему резолвится своим пином, а не активной версией", async () => {
    const { dir, db } = await seedCompositionPinnedToV1();
    const doc = docWithAuthoredBadge("mechanism", false);
    const expanded = expandPrototypeForSave(db, doc);
    const snapshot = await snapshotDefinitions(db, expanded.doc, dir);
    // Элементы раскрытия — только они — судятся схемой манифеста композиции (версия 1).
    expect(snapshot.pins.find((pin) => pin.name === "CtypAccrualBadge")?.version).toBe(1);
    expect(snapshot.definitions.CtypAccrualBadge!.props.safeParse({ amount: "1", mode: "compact" }).success).toBe(false);
    const active = db.query("SELECT version FROM component_publishes WHERE component_id='ctyp-accrual-badge' AND status='active' ORDER BY version DESC LIMIT 1").get() as { version: number };
    expect(active.version).toBe(2);
    db.close();
  }, 60000);
});

describe("BR-01a — типизированный component_prop_unknown", () => {
  test("неизвестный prop называет componentId, resolvedVersion, sourceHash, propsSchemaHash, catalogRevision и acceptedKeys", async () => {
    const { db, handler } = await setup();
    await publishComponent(handler, "ctyp-accrual-badge", "CtypAccrualBadge", badgeSource(false));
    await publishNextVersion(handler, "ctyp-accrual-badge", 1, badgeSource(true));
    const response = await handler(req("/prototypes", "POST", { doc: docWithBadgeProps("prop-unknown", { amount: "34 ₽", nope: 1 }) }));
    expect(response.status).toBe(422);
    const error = await issues(response);
    expect(error.code).toBe("validation_failed");
    const issue = error.issues![0] as Record<string, unknown>;
    expect(issue.code).toBe("component_prop_unknown");
    // Путь достроен до самого prop'а (zod рапортует unrecognized_keys на объекте).
    expect(issue.path).toBe("/screens/0/spec/elements/authored/props/nope");
    expect(issue.pointer).toBe("/screens/0/spec/elements/authored/props/nope");
    expect(issue.componentId).toBe("ctyp-accrual-badge");
    expect(issue.resolvedVersion).toBe(2);
    expect(issue.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(issue.propsSchemaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof issue.catalogRevision).toBe("string");
    expect(issue.acceptedKeys).toEqual(["amount", "mode"]);
    db.close();
  }, 60000);

  test("kill-switch: доволновой issue без кода и контекста, путь — до объекта props", async () => {
    const { db, handler } = await setup();
    await publishComponent(handler, "ctyp-accrual-badge", "CtypAccrualBadge", badgeSource(true));
    const response = await withLegacyResolver(() => handler(req("/prototypes", "POST", { doc: docWithBadgeProps("legacy-prop-unknown", { amount: "34 ₽", nope: 1 }) })));
    expect(response.status).toBe(422);
    const error = await issues(response);
    expect(error.issues![0] as unknown).toEqual({ path: "/screens/0/spec/elements/authored/props", pointer: "/screens/0/spec/elements/authored/props", message: expect.stringContaining("nope") });
    db.close();
  }, 60000);
});

describe("H2 — readiness resolves definitions from the expanded document", () => {
  test("BR-01a: readiness видит компоненты раскрытия и судит то же дерево, что принял save", async () => {
    const { dir, db, handler } = await seedCompositionPinnedToV1();
    const created = await handler(req("/prototypes", "POST", { doc: docWithAuthoredBadge("readiness-doc", false) }));
    expect(created.status).toBe(201);

    const stored = new PrototypeRepo(db).draft("readiness-doc").doc;
    const storedJson = JSON.stringify(stored);
    const expanded = expandPrototypeForSave(db, stored);
    const saveSnapshot = await snapshotDefinitions(db, expanded.doc, dir);
    expect(Object.keys(saveSnapshot.definitions)).toContain("CtypAccrualBadge");
    expect(saveSnapshot.pins.map((pin) => pin.name).sort()).toEqual(["CtypAccrualBadge", "CtypSuccessShell"]);

    // Отчёт готовности резолвит определения по раскрытому документу — те же типы и те же пины.
    const report = await computeReadiness(db, "readiness-doc", { dataDir: dir });
    const schema = report.gates.find((gate) => gate.id === "schema");
    expect(schema?.status).not.toBe("fail");
    expect(schema?.summary).not.toBe("definitions_unavailable");
    // Раскрытие — чистая функция: хранимая ревизия не мутирована отчётом.
    expect(JSON.stringify(new PrototypeRepo(db).draft("readiness-doc").doc)).toBe(storedJson);
    // Гейт `pins` отчёта и пины save-пути называют один и тот же состав.
    const pins = (report.gates.find((gate) => gate.id === "pins") as unknown as { pins: { name: string }[] }).pins;
    expect(pins.map((pin) => pin.name).sort()).toEqual(["CtypAccrualBadge", "CtypSuccessShell"]);
    db.close();
  }, 60000);

  test("kill-switch: при EASYUI_SCHEMA_RESOLVER_V2_DISABLED=1 readiness снова резолвит нераскрытый документ", async () => {
    const { dir, db, handler } = await seedCompositionPinnedToV1();
    expect((await handler(req("/prototypes", "POST", { doc: docWithAuthoredBadge("legacy-readiness", false) }))).status).toBe(201);
    const stored = new PrototypeRepo(db).draft("legacy-readiness").doc;
    await withLegacyResolver(async () => {
      const readinessSnapshot = await snapshotDefinitions(db, stored, dir);
      expect(Object.keys(readinessSnapshot.definitions)).not.toContain("CtypAccrualBadge");
      expect(readinessSnapshot.pins).toEqual([]);
      const report = await computeReadiness(db, "legacy-readiness", { dataDir: dir });
      const schema = report.gates.find((gate) => gate.id === "schema");
      expect(JSON.stringify(schema)).not.toContain("CtypAccrualBadge");
    });
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
    // BR-01a: `headPin` фильтрует ДС так же, как save-SQL — голова резолвится в yandex-pay.
    expect(pinned.find((pin) => pin.name === "CtypAccrualBadge")?.version).toBe(1);
    db.close();
  }, 60000);

  test("kill-switch: при EASYUI_SCHEMA_RESOLVER_V2_DISABLED=1 headPin снова перескакивает в чужую ДС", async () => {
    const { dir, db, handler } = await setup();
    expect((await handler(req("/design-systems", "POST", { id: "h4-ds", name: "H4 DS", description: "Second design system for the H4 diagnosis" }))).status).toBe(201);
    await publishComponent(handler, "ctyp-accrual-badge", "CtypAccrualBadge", badgeSource(false));
    expect((await handler(req("/components/ctyp-accrual-badge", "PUT", { baseRev: 1, designSystem: "h4-ds", source: badgeSource(true) }))).status).toBe(200);
    expect((await handler(req("/components/ctyp-accrual-badge/publish", "POST", { baseRev: 2 }))).status).toBe(201);

    const doc = docWithBadgeProps("h4-legacy-doc", { amount: "34 ₽" });
    const snapshot = await snapshotDefinitions(db, doc, dir);
    expect(snapshot.pins.find((pin) => pin.name === "CtypAccrualBadge")?.version).toBe(1);
    expect((await handler(req("/prototypes", "POST", { doc, kind: "component-gallery" }))).status).toBe(201);
    expect((await handler(req("/prototypes/h4-legacy-doc/lifecycle", "POST", { track: "head" }))).status).toBe(200);
    await withLegacyResolver(async () => {
      const pinned = new PrototypeRepo(db).draft("h4-legacy-doc").components as { name: string; version: number }[];
      expect(pinned.find((pin) => pin.name === "CtypAccrualBadge")?.version).toBe(2);
    });
    db.close();
  }, 60000);
});
