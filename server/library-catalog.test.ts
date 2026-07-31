import { createTestHandler } from "./test-auth";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { openDatabase } from "./db";
import { BOOTSTRAP_ADMIN_ID } from "./users";
import { fingerprintId, fingerprintJson, type Fingerprint } from "./visual/fingerprint";
import { componentLibraryStatus } from "../src/library/libraryModel";
import type { ComponentVersionSummary, VisualReference } from "../src/api/client";

// Read-model библиотеки (`GET /api/catalog/library`) и данные инлайн-превью
// (`GET /api/components/:id/versions/:version/preview`), план 2026-07-31 §3.1–3.2.
//
// Компоненты сидятся напрямую в БД: настоящая публикация — подпроцесс extract + typecheck +
// compile на каждый компонент, а проверяемое здесь поведение зависит только от строк
// `components`/`component_revisions`/`component_publishes`.

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
  status: { published: boolean; verified: boolean; visualPending: boolean; blocked: boolean; rejected: boolean };
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
      legacy: { published: true, rejected: true, blocked: false, verified: false, visualPending: true },
      next: { published: true, rejected: false, blocked: false, verified: false, visualPending: true },
      reason: "легаси берёт latest по всем системам — это v3 (rejected) в lib-b; read-model смотрит только группу lib-a, где latest = v1 active",
    },
    {
      key: "lib-b lib-dual",
      legacy: { published: true, rejected: true, blocked: false, verified: false, visualPending: true },
      next: { published: true, rejected: true, blocked: false, verified: false, visualPending: true },
      reason: "совпадает: latest компонента и latest группы lib-b — одна и та же v3 (rejected)",
    },
    {
      key: "lib-a lib-solo",
      legacy: { published: true, rejected: false, blocked: true, verified: false, visualPending: true },
      next: { published: true, rejected: false, blocked: true, verified: false, visualPending: true },
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
      status: { published: true, verified: false, visualPending: true, blocked: false, rejected: false },
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
