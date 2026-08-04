import { createTestHandler } from "./test-auth";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { openDatabase } from "./db";
import { BOOTSTRAP_ADMIN_ID } from "./users";
import { fingerprintId, fingerprintJson, type Fingerprint } from "./visual/fingerprint";
import { catalogRevision, catalogRevisionRows, type CatalogRevisionSource } from "./catalogRevision";
import { componentLibraryStatus } from "../src/library/libraryModel";
import type { ComponentVersionSummary, VisualReference } from "../src/api/client";

// Read-model библиотеки (`GET /api/catalog/library`) и данные инлайн-превью
// (`GET /api/components/:id/versions/:version/preview`), план 2026-07-31 §3.1–3.2.
//
// Компоненты сидятся напрямую в БД: настоящая публикация — подпроцесс extract + typecheck +
// compile на каждый компонент, а проверяемое здесь поведение зависит только от строк
// `components`/`component_revisions`/`component_publishes`.
//
// СМЕНА КОНТРАКТА относительно проекта 1 (план 2026-07-31 §2 D2 / §3.4, задача T1): раньше
// `catalogRevision` хэшировал запись read-model целиком, поэтому менялся от `headUsageCount`,
// `status.verified`, `figma`, `preview` и `bundleUrl`. Теперь он считается по стабильной
// discovery-проекции `{kind, designSystem, id, version, metaHash}`. Ослабление ревизии —
// осознанное: проект 2 использует её как защиту override от гонки каталога, и волатильность от
// чужого прототипа или фонового visual-run делала бы её бесполезной. Тесты ниже пинят обе
// стороны контракта: что ревизия меняется, и что она НЕ меняется.

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

async function setup() {
  const dir = await mkdtemp(resolve(process.cwd(), ".library-catalog-test-"));
  dirs.push(dir);
  const db = openDatabase(":memory:"), handler = createTestHandler(db, { dataDir: dir });
  return { dir, db, handler };
}

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
const get = (handler: (r: Request) => Promise<Response>, url: string) => handler(new Request(`http://test/api${url}`));
const body = async <T>(response: Response): Promise<T> => (await response.json()) as T;

function seedSystem(db: Database, id: string): void {
  db.query("INSERT INTO design_systems (id,name,description,builtin_provider,created_at,updated_at,owner_id,retired) VALUES (?,?,?,NULL,?,?,?,0)")
    .run(id, `System ${id}`, `seeded ${id}`, at(0), at(0), BOOTSTRAP_ADMIN_ID);
}

interface SeedVersion { status: string; designSystem: string; meta?: Record<string, unknown> }
const SEED_SOURCE = "export const definition = { description: 'seeded source marker' };";
const seedMeta = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  description: "Seeded component", events: [], slots: ["body"], example: { value: 3 },
  propsJsonSchema: { type: "object", properties: { value: { type: "number" } } },
  ...extra,
});

/** Компонент с одной публикацией на версию; ревизия версии N — это rev N (UNIQUE(component_id,rev)). */
function seedComponent(db: Database, id: string, name: string, versions: SeedVersion[], figmaJson: string | null = null): void {
  const head = versions.length;
  db.query("INSERT INTO components (id,name,head_rev,design_system,deleted_at,created_at,updated_at,owner_id) VALUES (?,?,?,?,NULL,?,?,?)")
    .run(id, name, head, versions.at(-1)!.designSystem, at(0), at(0), BOOTSTRAP_ADMIN_ID);
  versions.forEach((version, index) => {
    const rev = index + 1;
    db.query("INSERT INTO component_revisions (component_id,rev,source,design_system,figma_json,message,created_at) VALUES (?,?,?,?,?,NULL,?)")
      .run(id, rev, SEED_SOURCE, version.designSystem, rev === head ? figmaJson : null, at(rev));
    db.query("INSERT INTO component_publishes (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,message,published_at) VALUES (?,?,?,?,?,?,?,?,?,NULL,?)")
      .run(id, rev, rev, version.status, "export default () => null;", JSON.stringify(version.meta ?? seedMeta()), `sh-${id}-${rev}`, `bh-${id}-${rev}`, 4, at(rev));
  });
}

/** Новая активная публикация поверх существующего компонента (rev = version = head + 1). */
function seedNewVersion(db: Database, id: string, designSystem: string, meta?: Record<string, unknown>): void {
  const head = (db.query("SELECT head_rev rev FROM components WHERE id=?").get(id) as { rev: number }).rev;
  const rev = head + 1;
  db.query("INSERT INTO component_revisions (component_id,rev,source,design_system,figma_json,message,created_at) VALUES (?,?,?,?,NULL,NULL,?)")
    .run(id, rev, SEED_SOURCE, designSystem, at(rev));
  db.query("INSERT INTO component_publishes (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,message,published_at) VALUES (?,?,?,?,?,?,?,?,?,NULL,?)")
    .run(id, rev, rev, "active", "export default () => null;", JSON.stringify(meta ?? seedMeta()), `sh-${id}-${rev}`, `bh-${id}-${rev}`, 4, at(rev));
  db.query("UPDATE components SET head_rev=? WHERE id=?").run(rev, id);
}

/** Сохранение драфта: новая ревизия без публикации, head двигается (в т.ч. figma головы). */
function seedDraft(db: Database, id: string, designSystem: string, figmaJson: string | null): void {
  const head = (db.query("SELECT head_rev rev FROM components WHERE id=?").get(id) as { rev: number }).rev;
  const rev = head + 1;
  db.query("INSERT INTO component_revisions (component_id,rev,source,design_system,figma_json,message,created_at) VALUES (?,?,?,?,?,NULL,?)")
    .run(id, rev, `${SEED_SOURCE}\n// draft`, designSystem, figmaJson, at(rev));
  db.query("UPDATE components SET head_rev=? WHERE id=?").run(rev, id);
}

/** Прототип, использующий версию компонента, — единственный источник `headUsageCount`. */
function seedPrototype(db: Database, id: string, componentId: string, componentVersion: number, updatedAt: string): void {
  db.query("INSERT INTO prototypes (id,name,description,device,screen_count,head_rev,created_at,updated_at,design_system,instance_id,owner_id,status,kind,tags,derived_from) VALUES (?,?,NULL,?,?,?,?,?,?,?,?,?,?,NULL,NULL)")
    .run(id, `Proto ${id}`, "mobile", 1, 1, at(0), updatedAt, "lib-a", crypto.randomUUID(), BOOTSTRAP_ADMIN_ID, "private", "product-flow");
  db.query("INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,message,author,created_at,design_system_meta_version,figma_json) VALUES (?,?,?,?,NULL,NULL,?,NULL,NULL)")
    .run(id, 1, JSON.stringify({ screens: [] }), "hash", at(0));
  db.query("INSERT INTO prototype_revision_components (prototype_id,rev,component_id,component_version) VALUES (?,?,?,?)")
    .run(id, 1, componentId, componentVersion);
}

function seedAsset(db: Database, id: string): string {
  db.query("INSERT INTO assets (id,sha256,mime,size,original_name,created_at) VALUES (?,?,?,?,NULL,?)").run(id, `sha-${id}`, "image/png", 1, at(0));
  return id;
}

const componentFingerprint = (componentId: string, refVersion: number, width = 320): Fingerprint =>
  ({ scope: "component", componentId, refVersion, viewport: { width, height: 480 }, deviceScaleFactor: 1, theme: "light" });

function seedReference(db: Database, fingerprint: Fingerprint, assetId: string, deleted = false): string {
  const json = fingerprintJson(fingerprint), id = fingerprintId(json);
  db.query("INSERT INTO visual_references (id,fingerprint_json,asset_id,note,created_at,deleted_at) VALUES (?,?,?,NULL,?,?)")
    .run(id, json, assetId, at(0), deleted ? at(1) : null);
  return id;
}

function seedRun(db: Database, id: string, referenceId: string, referenceAssetId: string | null, status: string, createdAt: string): void {
  db.query(`INSERT INTO visual_runs (id,reference_id,reference_asset_id,candidate_asset_id,diff_asset_id,metric,metric_options_json,diff_pixels,total_pixels,diff_percent,status,candidate_meta_json,created_at)
    VALUES (?,?,?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,?,NULL,?)`).run(id, referenceId, referenceAssetId, status, createdAt);
}

interface LibraryEntry {
  kind: "component"; id: string; name: string; designSystem: string; version: number;
  bundleUrl: string; bundleHash: string; hostAbiVersion: number; description: string;
  atomicLevel?: string; layoutNeutral: boolean; scope?: string; canonicalFor: string[]; replacement?: string;
  deprecated: boolean; headUsageCount: number;
  status: { published: boolean; verified: boolean; visualPending: boolean; blocked: boolean; rejected: boolean; accepted: boolean };
  figma: null | { fileKey: string; nodeCount: number };
  preview: null | { selector: "legacy" } | { selector: "named"; name: string };
}
interface LibraryResponse { catalogRevision: string; components: LibraryEntry[]; systems: { id: string; name: string; count: number }[] }

const entryOf = (response: LibraryResponse, designSystem: string, id: string): LibraryEntry =>
  response.components.find((entry) => entry.designSystem === designSystem && entry.id === id)!;

describe("GET /api/catalog/library", () => {
  // Таблица расхождений с легаси `componentLibraryStatus` (src/library/libraryModel.ts:143-159).
  // Легаси считает `latest` по ВСЕМ версиям компонента без разбиения по системам, поэтому
  // расхождение возможно только у компонента, активного в двух системах (план §3.1, B3).
  // `reason` — документация; `legacy`/`next` вычисляются и сверяются.
  const DIVERGENCE = [
    {
      key: "lib-a lib-dual",
      legacy: { published: true, rejected: true, blocked: false, verified: false, visualPending: true, accepted: false },
      next: { published: true, rejected: false, blocked: false, verified: false, visualPending: true, accepted: false },
      reason: "легаси берёт latest по всем системам — это v3 (rejected) в lib-b; read-model смотрит только группу lib-a, где latest = v1 active",
    },
    {
      key: "lib-b lib-dual",
      legacy: { published: true, rejected: true, blocked: false, verified: false, visualPending: true, accepted: false },
      next: { published: true, rejected: true, blocked: false, verified: false, visualPending: true, accepted: false },
      reason: "совпадает: latest компонента и latest группы lib-b — одна и та же v3 (rejected)",
    },
    {
      key: "lib-a lib-solo",
      legacy: { published: true, rejected: false, blocked: true, verified: false, visualPending: true, accepted: false },
      next: { published: true, rejected: false, blocked: true, verified: false, visualPending: true, accepted: false },
      reason: "совпадает: компонент живёт в одной системе, разбиение ничего не меняет",
    },
  ];

  test("статус на пару (компонент, система) расходится с легаси ровно там, где легаси схлопывает системы", async () => {
    const { db, handler } = await setup();
    seedSystem(db, "lib-a"); seedSystem(db, "lib-b");
    seedComponent(db, "lib-dual", "LibDual", [
      { status: "active", designSystem: "lib-a" },
      { status: "active", designSystem: "lib-b" },
      { status: "rejected", designSystem: "lib-b" },
    ]);
    seedComponent(db, "lib-solo", "LibSolo", [
      { status: "active", designSystem: "lib-a" },
      { status: "deprecated", designSystem: "lib-a" },
    ]);

    const catalog = await body<LibraryResponse>(await get(handler, "/catalog/library"));
    const references = (await body<{ references: VisualReference[] }>(await get(handler, "/visual-references?scope=component"))).references;
    const actual = [];
    for (const entry of catalog.components) {
      const meta = await body<{ versions: ComponentVersionSummary[] }>(await get(handler, `/components/${entry.id}`));
      const legacy = componentLibraryStatus(entry.id, entry.version, meta.versions, references);
      actual.push({ key: `${entry.designSystem} ${entry.id}`, legacy, next: entry.status });
    }
    expect(actual).toEqual(DIVERGENCE.map(({ key, legacy, next }) => ({ key, legacy, next })));

    // `deprecated` тоже считается по группе системы, а не по компоненту целиком.
    expect(entryOf(catalog, "lib-a", "lib-dual").deprecated).toBe(false);
    expect(entryOf(catalog, "lib-b", "lib-dual").deprecated).toBe(false);
    expect(entryOf(catalog, "lib-a", "lib-solo").deprecated).toBe(true);
    db.close();
  });

  test("verified воспроизводит lastRun-семантику referencePublic()", async () => {
    const { db, handler } = await setup();
    seedSystem(db, "lib-a");
    const older = seedAsset(db, "asset_older"), current = seedAsset(db, "asset_current");
    const cases: [id: string, name: string][] = [
      ["vis-pass", "VisPass"], ["vis-reupsert", "VisReupsert"], ["vis-newest-other-asset", "VisNewestOtherAsset"],
      ["vis-only-old-asset", "VisOnlyOldAsset"], ["vis-multi", "VisMulti"], ["vis-deleted", "VisDeleted"],
      ["vis-other-version", "VisOtherVersion"], ["vis-null-asset", "VisNullAsset"],
    ];
    for (const [id, name] of cases) seedComponent(db, id, name, [{ status: "active", designSystem: "lib-a" }]);

    // Проходящий прогон против текущего эталона.
    seedRun(db, "run-pass", seedReference(db, componentFingerprint("vis-pass", 1), current), current, "pass", at(10));
    // Эталон перезалит: старый pass шёл против прежнего asset, свежий fail — против текущего.
    const reupsert = seedReference(db, componentFingerprint("vis-reupsert", 1), current);
    seedRun(db, "run-reupsert-old", reupsert, older, "pass", at(10));
    seedRun(db, "run-reupsert-new", reupsert, current, "fail", at(20));
    // Контрпример из плана: новейший прогон вообще — против ЧУЖОГО asset; против текущего
    // самый свежий прогон прошёл. Партиционирование по (reference_id, reference_asset_id)
    // обязано это увидеть, иначе получится ложный visualPending.
    const otherAsset = seedReference(db, componentFingerprint("vis-newest-other-asset", 1), current);
    seedRun(db, "run-other-old", otherAsset, current, "pass", at(10));
    seedRun(db, "run-other-new", otherAsset, older, "fail", at(20));
    // Прогоны есть, но все против прежнего asset — эталон не подтверждён.
    seedRun(db, "run-only-old", seedReference(db, componentFingerprint("vis-only-old-asset", 1), current), older, "pass", at(10));
    // Несколько ссылок на одну (componentId, refVersion): достаточно одной проходящей.
    seedRun(db, "run-multi-fail", seedReference(db, componentFingerprint("vis-multi", 1, 320), current), current, "fail", at(10));
    seedRun(db, "run-multi-pass", seedReference(db, componentFingerprint("vis-multi", 1, 375), current), current, "pass", at(10));
    // Мягко удалённая ссылка не подтверждает ничего.
    seedRun(db, "run-deleted", seedReference(db, componentFingerprint("vis-deleted", 1), current, true), current, "pass", at(10));
    // Ссылка на другую версию не подтверждает активную.
    seedRun(db, "run-other-version", seedReference(db, componentFingerprint("vis-other-version", 2), current), current, "pass", at(10));
    // reference_asset_id IS NULL не матчится ни при каком партиционировании (как в легаси).
    seedRun(db, "run-null-asset", seedReference(db, componentFingerprint("vis-null-asset", 1), current), null, "pass", at(10));

    const catalog = await body<LibraryResponse>(await get(handler, "/catalog/library"));
    expect(Object.fromEntries(catalog.components.map((entry) => [entry.id, entry.status.verified]))).toEqual({
      "vis-pass": true,
      "vis-reupsert": false,
      "vis-newest-other-asset": true,
      "vis-only-old-asset": false,
      "vis-multi": true,
      "vis-deleted": false,
      "vis-other-version": false,
      "vis-null-asset": false,
    });
    // visualPending — ровно дополнение verified среди опубликованных.
    for (const entry of catalog.components) expect(entry.status.visualPending).toBe(!entry.status.verified);
    db.close();
  });

  // --- accepted: независимый признак приёмки (RFC candidate-acceptance §7, волна R3c) ---

  /** Плоский receipt A9 на строке публикации: promote пишет его только для пройденного рана. */
  function seedAcceptanceReceipt(db: Database, id: string, version: number, runId: string | null, candidateId: string | null = null): void {
    db.query("UPDATE component_publishes SET acceptance_run_id=?,candidate_id=? WHERE component_id=? AND version=?")
      .run(runId, candidateId, id, version);
  }

  test("accepted читает acceptance-evidence активной версии и не подменяет visual-verified", async () => {
    const { db, handler } = await setup();
    seedSystem(db, "lib-a");
    seedComponent(db, "acc-yes", "AccYes", [{ status: "active", designSystem: "lib-a" }]);
    // Evidence висит на СТАРОЙ версии; активная — v2, признака у неё нет.
    seedComponent(db, "acc-old-version", "AccOldVersion", [{ status: "active", designSystem: "lib-a" }]);
    seedNewVersion(db, "acc-old-version", "lib-a");
    // Пустая строка — «пусто» наравне с NULL: колонка плоская TEXT без FK.
    seedComponent(db, "acc-empty", "AccEmpty", [{ status: "active", designSystem: "lib-a" }]);
    seedComponent(db, "acc-none", "AccNone", [{ status: "active", designSystem: "lib-a" }]);

    seedAcceptanceReceipt(db, "acc-yes", 1, "acc_11111111-1111-1111-1111-111111111111", "cand_yes");
    seedAcceptanceReceipt(db, "acc-old-version", 1, "acc_22222222-2222-2222-2222-222222222222");
    seedAcceptanceReceipt(db, "acc-empty", 1, "");

    const catalog = await body<LibraryResponse>(await get(handler, "/catalog/library"));
    expect(Object.fromEntries(catalog.components.map((entry) => [entry.id, entry.status.accepted]))).toEqual({
      "acc-yes": true,
      "acc-old-version": false,
      "acc-empty": false,
      "acc-none": false,
    });
    // Признак независим: визуальная сторона у принятой записи осталась нетронутой.
    expect(entryOf(catalog, "lib-a", "acc-yes").status).toMatchObject({ verified: false, visualPending: true, accepted: true });
    db.close();
  });

  test("ревизия не меняется от появления acceptance-evidence: status.accepted вне проекции", async () => {
    const { db, handler } = await setup();
    seedSystem(db, "lib-a");
    seedComponent(db, "rev-accepted", "RevAccepted", [{ status: "active", designSystem: "lib-a" }]);
    const before = await body<LibraryResponse>(await get(handler, "/catalog/library"));
    expect(entryOf(before, "lib-a", "rev-accepted").status.accepted).toBe(false);

    seedAcceptanceReceipt(db, "rev-accepted", 1, "acc_33333333-3333-3333-3333-333333333333", "cand_rev");
    const after = await body<LibraryResponse>(await get(handler, "/catalog/library"));
    expect(entryOf(after, "lib-a", "rev-accepted").status.accepted).toBe(true);
    // Инвариант §7/M4: иначе любой acceptance-run глобально сдвигал бы хэш каталога.
    expect(after.catalogRevision).toBe(before.catalogRevision);
    db.close();
  });

  test("серверный и легаси-вычислители accepted согласованы, а versions-DTO несёт receipt-ссылки", async () => {
    const { db, handler } = await setup();
    seedSystem(db, "lib-a");
    seedComponent(db, "acc-parity-yes", "AccParityYes", [{ status: "active", designSystem: "lib-a" }]);
    seedComponent(db, "acc-parity-no", "AccParityNo", [{ status: "active", designSystem: "lib-a" }]);
    seedAcceptanceReceipt(db, "acc-parity-yes", 1, "acc_44444444-4444-4444-4444-444444444444", "cand_parity");

    const catalog = await body<LibraryResponse>(await get(handler, "/catalog/library"));
    const references = (await body<{ references: VisualReference[] }>(await get(handler, "/visual-references?scope=component"))).references;
    for (const entry of catalog.components) {
      const meta = await body<{ versions: ComponentVersionSummary[] }>(await get(handler, `/components/${entry.id}`));
      expect(componentLibraryStatus(entry.id, entry.version, meta.versions, references).accepted).toBe(entry.status.accepted);
    }

    const versions = await body<ComponentVersionSummary[]>(await get(handler, "/components/acc-parity-yes/versions"));
    expect(versions[0]).toMatchObject({ version: 1, acceptanceRunId: "acc_44444444-4444-4444-4444-444444444444", candidateId: "cand_parity" });
    const bare = await body<ComponentVersionSummary[]>(await get(handler, "/components/acc-parity-no/versions"));
    expect(bare[0]).toMatchObject({ version: 1, acceptanceRunId: null, candidateId: null });
    db.close();
  });

  test("preview выбирается по истинности example, иначе по первому имени примера", async () => {
    const { db, handler } = await setup();
    seedSystem(db, "lib-a");
    seedComponent(db, "prev-legacy", "PrevLegacy", [{ status: "active", designSystem: "lib-a", meta: seedMeta({ example: { value: 1 }, examples: { alpha: {} } }) }]);
    // Пустой объект истинен — это осознанно legacy-превью, а не «нет примера».
    seedComponent(db, "prev-empty", "PrevEmpty", [{ status: "active", designSystem: "lib-a", meta: seedMeta({ example: {} }) }]);
    // Присутствующий, но ложный `example` — падаем на именованные примеры, первый по sort().
    seedComponent(db, "prev-named", "PrevNamed", [{ status: "active", designSystem: "lib-a", meta: seedMeta({ example: null, examples: { zulu: {}, alpha: {}, mike: {} } }) }]);
    seedComponent(db, "prev-none", "PrevNone", [{ status: "active", designSystem: "lib-a", meta: seedMeta({ example: null }) }]);

    const catalog = await body<LibraryResponse>(await get(handler, "/catalog/library"));
    expect(Object.fromEntries(catalog.components.map((entry) => [entry.id, entry.preview]))).toEqual({
      "prev-legacy": { selector: "legacy" },
      "prev-empty": { selector: "legacy" },
      "prev-named": { selector: "named", name: "alpha" },
      "prev-none": null,
    });
    db.close();
  });

  test("systems считаются по нефильтрованному каталогу, catalogRevision не зависит от фильтра", async () => {
    const { db, handler } = await setup();
    seedSystem(db, "lib-a"); seedSystem(db, "lib-b"); seedSystem(db, "lib-empty");
    seedComponent(db, "sys-one", "SysOne", [{ status: "active", designSystem: "lib-a" }]);
    seedComponent(db, "sys-two", "SysTwo", [{ status: "active", designSystem: "lib-a" }]);
    seedComponent(db, "sys-three", "SysThree", [{ status: "active", designSystem: "lib-b" }]);

    const all = await body<LibraryResponse>(await get(handler, "/catalog/library"));
    const filtered = await body<LibraryResponse>(await get(handler, "/catalog/library?designSystem=lib-b"));
    const expectedSystems = [{ id: "lib-a", name: "System lib-a", count: 2 }, { id: "lib-b", name: "System lib-b", count: 1 }];
    expect(all.systems).toEqual(expectedSystems);
    // Фильтр сужает components[], но не systems[] и не ревизию каталога.
    expect(filtered.systems).toEqual(expectedSystems);
    expect(filtered.components.map((entry) => entry.id)).toEqual(["sys-three"]);
    expect(filtered.catalogRevision).toBe(all.catalogRevision);

    seedComponent(db, "sys-four", "SysFour", [{ status: "active", designSystem: "lib-b" }]);
    expect((await body<LibraryResponse>(await get(handler, "/catalog/library"))).catalogRevision).not.toBe(all.catalogRevision);
    db.close();
  });

  // --- catalogRevision: стабильная discovery-проекция (план §3.4, T1) ---

  const revisionOf = async (handler: (r: Request) => Promise<Response>): Promise<string> =>
    (await body<LibraryResponse>(await get(handler, "/catalog/library"))).catalogRevision;

  test("ревизия меняется при публикации новой версии и при смене discovery-меты", async () => {
    const { db, handler } = await setup();
    seedSystem(db, "lib-a");
    seedComponent(db, "rev-one", "RevOne", [{ status: "active", designSystem: "lib-a" }]);
    const initial = await revisionOf(handler);

    seedNewVersion(db, "rev-one", "lib-a");
    const published = await revisionOf(handler);
    expect(published).not.toBe(initial);

    // Каждое поле discovery-проекции двигает ревизию по отдельности.
    const seen = new Set([initial, published]);
    const metaChanges: Record<string, unknown>[] = [
      { description: "Другое описание" },
      { atomicLevel: "molecule" },
      { scope: "section" },
      { canonicalFor: ["checkout-summary"] },
      { replacement: "rev-two" },
      // Сигнатура пропов: имя, обязательность и форма — каждая часть значима.
      { propsJsonSchema: { type: "object", properties: { renamed: { type: "number" } } } },
      { propsJsonSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"] } },
      { propsJsonSchema: { type: "object", properties: { value: { type: "string" } } } },
      { propsJsonSchema: { type: "object", properties: { value: { type: "string", enum: ["a", "b"] } } } },
      // Сигнатура io.
      { events: ["press"] },
      { slots: ["body", "footer"] },
    ];
    for (const change of metaChanges) {
      db.query("UPDATE component_publishes SET definition_meta=? WHERE component_id=? AND version=2")
        .run(JSON.stringify(seedMeta(change)), "rev-one");
      const revision = await revisionOf(handler);
      expect({ change, fresh: seen.has(revision) }).toEqual({ change, fresh: false });
      seen.add(revision);
    }
    db.close();
  });

  test("ревизия не зависит от порядка событий и слотов, но зависит от их состава", async () => {
    const { db, handler } = await setup();
    seedSystem(db, "lib-a");
    seedComponent(db, "rev-io", "RevIo", [{ status: "active", designSystem: "lib-a", meta: seedMeta({ events: ["press", "cancel"], slots: ["body", "footer"] }) }]);
    const initial = await revisionOf(handler);
    db.query("UPDATE component_publishes SET definition_meta=? WHERE component_id=? AND version=1")
      .run(JSON.stringify(seedMeta({ events: ["cancel", "press"], slots: ["footer", "body"] })), "rev-io");
    expect(await revisionOf(handler)).toBe(initial);
    db.query("UPDATE component_publishes SET definition_meta=? WHERE component_id=? AND version=1")
      .run(JSON.stringify(seedMeta({ events: ["cancel"], slots: ["footer", "body"] })), "rev-io");
    expect(await revisionOf(handler)).not.toBe(initial);
    db.close();
  });

  test("ревизия не меняется от правки прототипа: headUsageCount вне проекции", async () => {
    const { db, handler } = await setup();
    seedSystem(db, "lib-a");
    seedComponent(db, "rev-usage", "RevUsage", [{ status: "active", designSystem: "lib-a" }]);
    const initial = await revisionOf(handler);

    seedPrototype(db, "proto-one", "rev-usage", 1, at(30));
    const after = await body<LibraryResponse>(await get(handler, "/catalog/library"));
    // Учёт использования действительно поехал — иначе тест был бы холостым.
    expect(entryOf(after, "lib-a", "rev-usage").headUsageCount).toBe(1);
    expect(after.catalogRevision).toBe(initial);

    seedPrototype(db, "proto-two", "rev-usage", 1, at(40));
    const twice = await body<LibraryResponse>(await get(handler, "/catalog/library"));
    expect(entryOf(twice, "lib-a", "rev-usage").headUsageCount).toBe(2);
    expect(twice.catalogRevision).toBe(initial);
    db.close();
  });

  test("ревизия не меняется от завершения visual-run: status.verified вне проекции", async () => {
    const { db, handler } = await setup();
    seedSystem(db, "lib-a");
    seedComponent(db, "rev-visual", "RevVisual", [{ status: "active", designSystem: "lib-a" }]);
    const before = await body<LibraryResponse>(await get(handler, "/catalog/library"));
    expect(entryOf(before, "lib-a", "rev-visual").status.verified).toBe(false);

    const asset = seedAsset(db, "asset_rev");
    seedRun(db, "run-rev", seedReference(db, componentFingerprint("rev-visual", 1), asset), asset, "pass", at(10));
    const after = await body<LibraryResponse>(await get(handler, "/catalog/library"));
    expect(entryOf(after, "lib-a", "rev-visual").status.verified).toBe(true);
    expect(after.catalogRevision).toBe(before.catalogRevision);
    db.close();
  });

  test("ревизия не меняется при сохранении драфта, даже когда драфт двигает figma головы", async () => {
    const { db, handler } = await setup();
    seedSystem(db, "lib-a");
    seedComponent(db, "rev-draft", "RevDraft", [{ status: "active", designSystem: "lib-a" }]);
    const before = await body<LibraryResponse>(await get(handler, "/catalog/library"));
    expect(entryOf(before, "lib-a", "rev-draft").figma).toBeNull();

    seedDraft(db, "rev-draft", "lib-a", JSON.stringify({ fileKey: "DRAFTKEY", nodeIds: ["1:2"] }));
    const after = await body<LibraryResponse>(await get(handler, "/catalog/library"));
    // Драфт виден в записи (figma головы), но не в ревизии: активная версия та же.
    expect(entryOf(after, "lib-a", "rev-draft").figma).toEqual({ fileKey: "DRAFTKEY", nodeCount: 1 });
    expect(entryOf(after, "lib-a", "rev-draft").version).toBe(1);
    expect(after.catalogRevision).toBe(before.catalogRevision);
    db.close();
  });

  test("отдаёт figma-сводку, canonicalFor и bundle-координаты, но не source и не propsJsonSchema", async () => {
    const { db, handler } = await setup();
    seedSystem(db, "lib-a");
    seedComponent(db, "meta-one", "MetaOne", [{
      status: "active", designSystem: "lib-a",
      meta: seedMeta({ atomicLevel: "molecule", layoutNeutral: true, scope: "section", canonicalFor: ["checkout-summary"], replacement: "meta-two", examples: { alpha: {} } }),
    }], JSON.stringify({ fileKey: "FILEKEY", nodeIds: ["1:2", "3:4"] }));

    const response = await get(handler, "/catalog/library");
    expect(response.headers.get("cache-control")).toContain("no-store");
    const catalog = await body<LibraryResponse>(response);
    expect(entryOf(catalog, "lib-a", "meta-one")).toEqual({
      kind: "component", id: "meta-one", name: "MetaOne", designSystem: "lib-a", version: 1,
      bundleUrl: "/api/components/meta-one/versions/1/bundle.js", bundleHash: "bh-meta-one-1", hostAbiVersion: 4,
      description: "Seeded component", atomicLevel: "molecule", layoutNeutral: true, scope: "section",
      canonicalFor: ["checkout-summary"], replacement: "meta-two", deprecated: false, headUsageCount: 0,
      status: { published: true, verified: false, visualPending: true, blocked: false, rejected: false, accepted: false },
      figma: { fileKey: "FILEKEY", nodeCount: 2 },
      preview: { selector: "legacy" },
    });

    const text = await (await get(handler, "/catalog/library")).text();
    for (const forbidden of ["propsJsonSchema", "seeded source marker", "\"examples\"", "\"example\"", "compiled_js"]) expect(text).not.toContain(forbidden);
    db.close();
  });

  test("неизвестная или отставленная дизайн-система — 404, кривой slug — 422", async () => {
    const { db, handler } = await setup();
    seedSystem(db, "lib-a");
    expect((await get(handler, "/catalog/library?designSystem=missing-system")).status).toBe(404);
    // `shadcn` в базе есть, но retired — как и в манифесте, это 404.
    const retired = await get(handler, "/catalog/library?designSystem=shadcn");
    expect(retired.status).toBe(404);
    expect(await body<{ error: { code: string } }>(retired)).toMatchObject({ error: { code: "not_found" } });
    expect((await get(handler, "/catalog/library?designSystem=Bad_Slug")).status).toBe(422);
    expect((await handler(new Request("http://test/api/catalog/library", { method: "POST", headers: { origin: "http://test" } }))).status).toBe(405);
    db.close();
  });
});

describe("catalogRevision (чистая проекция)", () => {
  const source = (extra: Partial<CatalogRevisionSource> = {}): CatalogRevisionSource => ({
    kind: "component", designSystem: "lib-a", id: "rev-pure", version: 1,
    description: "Seeded component", canonicalFor: [],
    meta: { propsJsonSchema: { type: "object", properties: { value: { type: "number" } } }, events: [], slots: ["body"] },
    ...extra,
  });

  // Регресс-гард против первопричины B1 (план §2): раньше в хэш попадали ФАКТИЧЕСКИЕ ключи
  // записи, поэтому любое новое поле `LibraryCatalogEntry` молча становилось частью ревизии.
  // Побайтовое равенство ревизий библиотеки и кандидатов этот баг не ловит — оно остаётся
  // зелёным и при его возврате.
  test("добавление поля в LibraryCatalogEntry не меняет catalogRevision", () => {
    const base = source();
    const withExtras = {
      ...base,
      headUsageCount: 7, bundleUrl: "/api/components/rev-pure/versions/1/bundle.js", bundleHash: "bh-x",
      name: "RevPure", hostAbiVersion: 4, layoutNeutral: true, deprecated: true,
      status: { published: true, verified: true, visualPending: false, blocked: false, rejected: false, accepted: false },
      figma: { fileKey: "F", nodeCount: 2 }, preview: { selector: "legacy" },
      // Поле, которого сегодня в записи ещё нет, — ровно тот сценарий, что протёк в B1.
      fieldAddedTomorrow: "whatever",
    } as CatalogRevisionSource;
    expect(catalogRevision([withExtras])).toBe(catalogRevision([base]));
    expect(catalogRevisionRows([withExtras])).toEqual(catalogRevisionRows([base]));
    expect(Object.keys(catalogRevisionRows([withExtras])[0]!).sort()).toEqual(["designSystem", "id", "kind", "metaHash", "version"]);
  });

  test("ревизия не зависит от порядка строк на входе", () => {
    const rows = [source(), source({ id: "rev-b" }), source({ id: "rev-a", designSystem: "lib-b" })];
    expect(catalogRevision([...rows].reverse())).toBe(catalogRevision(rows));
  });

  test("проекция не ходит в БД и не мутирует вход", () => {
    const rows = [source({ canonicalFor: ["role-a"], meta: { events: ["b", "a"], slots: ["y", "x"] } })];
    const snapshot = structuredClone(rows);
    catalogRevision(rows);
    expect(rows).toEqual(snapshot);
  });
});

describe("GET /api/components/:id/versions/:version/preview", () => {
  async function previewSetup() {
    const { db, handler } = await setup();
    seedSystem(db, "lib-a");
    seedComponent(db, "prev-main", "PrevMain", [
      { status: "active", designSystem: "lib-a", meta: seedMeta({ examples: { compact: { value: 1 }, wide: { value: 5 } }, capabilities: { typedEvents: true } }) },
      { status: "deprecated", designSystem: "lib-a", meta: seedMeta({ example: { value: 4 } }) },
      { status: "archived", designSystem: "lib-a", meta: seedMeta() },
    ]);
    seedComponent(db, "prev-bare", "PrevBare", [{ status: "active", designSystem: "lib-a", meta: seedMeta({ example: null }) }]);
    return { db, handler };
  }
  const preview = (handler: (r: Request) => Promise<Response>, query: string, id = "prev-main", version = 1) =>
    get(handler, `/components/${id}/versions/${version}/preview${query}`);
  const errorCode = async (response: Response) => (await body<{ error: { code: string } }>(response)).error.code;

  test("selector=legacy отдаёт example, slots и capabilities без source и схем", async () => {
    const { db, handler } = await previewSetup();
    const response = await preview(handler, "?selector=legacy");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await body<Record<string,unknown>>(response)).toEqual({
      componentId: "prev-main", name: "PrevMain", version: 1, designSystem: "lib-a",
      bundleUrl: "/api/components/prev-main/versions/1/bundle.js", bundleHash: "bh-prev-main-1", hostAbiVersion: 4,
      props: { value: 3 }, slots: ["body"], capabilities: { typedEvents: true },
    });
    const text = await (await preview(handler, "?selector=legacy")).text();
    for (const forbidden of ["propsJsonSchema", "seeded source marker", "\"examples\""]) expect(text).not.toContain(forbidden);
    db.close();
  });

  test("selector=named находит именованный пример; capabilities отсутствуют, когда их нет", async () => {
    const { db, handler } = await previewSetup();
    expect(await body<Record<string,unknown>>(await preview(handler, "?selector=named&name=wide"))).toMatchObject({ props: { value: 5 } });
    const deprecated = await preview(handler, "?selector=legacy", "prev-main", 2);
    expect(deprecated.status).toBe(200);
    expect(await body<Record<string,unknown>>(deprecated)).toEqual({
      componentId: "prev-main", name: "PrevMain", version: 2, designSystem: "lib-a",
      bundleUrl: "/api/components/prev-main/versions/2/bundle.js", bundleHash: "bh-prev-main-2", hostAbiVersion: 4,
      props: { value: 4 }, slots: ["body"],
    });
    db.close();
  });

  test("грамматика селектора строгая: дубли и несовместимые комбинации — 400", async () => {
    const { db, handler } = await previewSetup();
    for (const query of ["", "?selector=bogus", "?selector=named", "?selector=legacy&name=compact", "?selector=legacy&selector=named", "?selector=named&name=compact&name=wide", "?selector=named&selector=named&name=compact"]) {
      const response = await preview(handler, query);
      expect({ query, status: response.status }).toEqual({ query, status: 400 });
      expect({ query, code: await errorCode(response) }).toEqual({ query, code: "invalid_request" });
    }
    db.close();
  });

  test("пустой name — присутствующий параметр: именованный поиск и 422 unknown_example", async () => {
    const { db, handler } = await previewSetup();
    const empty = await preview(handler, "?selector=named&name=");
    expect(empty.status).toBe(422);
    expect(await errorCode(empty)).toBe("unknown_example");
    const missing = await preview(handler, "?selector=named&name=nope");
    expect(missing.status).toBe(422);
    expect(await errorCode(missing)).toBe("unknown_example");
    db.close();
  });

  test("нет legacy-примера — 422 example_unavailable", async () => {
    const { db, handler } = await previewSetup();
    const response = await preview(handler, "?selector=legacy", "prev-bare");
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe("example_unavailable");
    db.close();
  });

  test("нет версии — 404 not_found; неисполняемая версия — 404 bundle_unavailable", async () => {
    const { db, handler } = await previewSetup();
    const missing = await preview(handler, "?selector=legacy", "prev-main", 99);
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe("not_found");
    const archived = await preview(handler, "?selector=legacy", "prev-main", 3);
    expect(archived.status).toBe(404);
    expect(await errorCode(archived)).toBe("bundle_unavailable");
    db.close();
  });
});
