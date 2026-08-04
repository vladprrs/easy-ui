import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createTestHandler } from "./test-auth";
import { openDatabase } from "./db";
import { migrations } from "./migrations";
import { libraryCatalog } from "./routes/libraryCatalog";
import { AssetRepo } from "./repos/assets";

/*
 * Provenance-слой компонентов (RFC candidate-acceptance-pipeline §6, волна R3a).
 *
 * Проверяется контракт целиком: cross-revision резолв, правило B1 (seq-строку пишет любой
 * write-путь с переданным `figma`), дедуп истории, tombstone, restore, no-op-детекция,
 * мутабельность provenance опубликованной версии и backfill миграции.
 *
 * Компонентные id уникальны для этого файла (`prov-*`): кэши import-верификации живут в общем
 * процессе `bun test`.
 */

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

async function setup() {
  const dir = await mkdtemp(resolve(process.cwd(), ".provenance-test-"));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  return { dir, db, handler: createTestHandler(db, { dataDir: dir }) };
}

const req = (url: string, method = "GET", value?: unknown) =>
  new Request(`http://test/api${url}`, { method, headers: value ? { "content-type": "application/json" } : undefined, body: value ? JSON.stringify(value) : undefined });
const json = async (response: Response) => await response.json() as Record<string, unknown>;

const FIGMA_A = { fileKey: "provKeyA", nodeIds: ["1:2"] };
const FIGMA_B = { fileKey: "provKeyB", nodeIds: ["3:4"] };
const FIGMA_C = { fileKey: "provKeyC", nodeIds: ["5:6", "7:8"] };

async function source(): Promise<string> { return await Bun.file("server/fixtures/rating-stars.tsx").text(); }

async function createComponent(handler: (request: Request) => Promise<Response>, id: string, name: string, figma?: unknown) {
  return await handler(req("/components", "POST", {
    designSystem: "yandex-pay", id, name, source: await source(),
    intent: "Collects product ratings for the provenance resolver scenario",
    ...(figma === undefined ? {} : { figma }),
  }));
}

const headFigma = async (handler: (request: Request) => Promise<Response>, id: string) =>
  (await json(await handler(req(`/components/${id}`)))).figma;

const seqRows = (db: Database, id: string) =>
  db.query("SELECT rev,seq,figma_json FROM component_provenance WHERE component_id=? ORDER BY rev,seq").all(id) as { rev: number; seq: number; figma_json: string | null }[];

describe("component provenance — cross-revision resolver", () => {
  test("a provenance PUT on rev N survives a later source PUT (inheritance, триаж R3-B1)", async () => {
    const { db, handler } = await setup();
    expect((await createComponent(handler, "prov-inherit", "ProvInherit")).status).toBe(201);

    const written = await handler(req("/components/prov-inherit/provenance", "PUT", { figma: FIGMA_A }));
    expect(written.status).toBe(200);
    expect(await json(written)).toMatchObject({ rev: 1, seq: 1, unchanged: false, figma: FIGMA_A });
    // Ни ревизии, ни версии ручка не создаёт.
    expect(await json(await handler(req("/components/prov-inherit")))).toMatchObject({ headRev: 1, versions: [] });

    // Обычный source-PUT без `figma` создаёт rev 2 — provenance наследуется резолвером.
    const saved = await handler(req("/components/prov-inherit", "PUT", { baseRev: 1, source: `${await source()}\n// touch\n` }));
    expect(saved.status).toBe(200);
    expect(await json(saved)).toMatchObject({ rev: 2 });
    expect(await headFigma(handler, "prov-inherit")).toEqual(FIGMA_A);
    expect(seqRows(db, "prov-inherit")).toHaveLength(1);
    db.close();
  });

  test("POST create with figma survives a source PUT without figma (правило B1, раунд3-BL-1)", async () => {
    const { db, handler } = await setup();
    expect((await createComponent(handler, "prov-create", "ProvCreate", FIGMA_A)).status).toBe(201);
    expect(seqRows(db, "prov-create")).toMatchObject([{ rev: 1, seq: 1 }]);

    expect((await handler(req("/components/prov-create", "PUT", { baseRev: 1, source: `${await source()}\n// touch\n` }))).status).toBe(200);
    expect(await headFigma(handler, "prov-create")).toEqual(FIGMA_A);
    db.close();
  });

  test("a component PUT with a new figma wins over an earlier provenance PUT (раунд2-B1)", async () => {
    const { db, handler } = await setup();
    expect((await createComponent(handler, "prov-put", "ProvPut")).status).toBe(201);
    expect((await handler(req("/components/prov-put/provenance", "PUT", { figma: FIGMA_A }))).status).toBe(200);

    const changed = await handler(req("/components/prov-put", "PUT", { baseRev: 1, figma: FIGMA_B }));
    expect(changed.status).toBe(200);
    expect(await json(changed)).toMatchObject({ rev: 2 });
    expect(await headFigma(handler, "prov-put")).toEqual(FIGMA_B);
    // Историческая ревизия продолжает резолвиться в своё значение.
    expect((await json(await handler(req("/components/prov-put/revisions/1")))).figma).toEqual(FIGMA_A);
    db.close();
  });

  test("an identical component PUT after a provenance PUT is a no-op (триаж R3-B2)", async () => {
    const { db, handler } = await setup();
    expect((await createComponent(handler, "prov-noop", "ProvNoop")).status).toBe(201);
    expect((await handler(req("/components/prov-noop/provenance", "PUT", { figma: FIGMA_A }))).status).toBe(200);

    const noop = await handler(req("/components/prov-noop", "PUT", { baseRev: 1, figma: FIGMA_A }));
    expect(noop.status).toBe(200);
    expect(await noop.json()).toEqual({ unchanged: true, rev: 1 });
    expect(seqRows(db, "prov-noop")).toHaveLength(1);
    db.close();
  });

  test("restore brings back the provenance of the restored revision (триаж раунд2-M2)", async () => {
    const { db, handler } = await setup();
    expect((await createComponent(handler, "prov-restore", "ProvRestore", FIGMA_A)).status).toBe(201);
    expect((await handler(req("/components/prov-restore", "PUT", { baseRev: 1, source: `${await source()}\n// r2\n`, figma: FIGMA_B }))).status).toBe(200);
    expect((await handler(req("/components/prov-restore/provenance", "PUT", { rev: 2, figma: FIGMA_C }))).status).toBe(200);
    expect(await headFigma(handler, "prov-restore")).toEqual(FIGMA_C);

    // Восстановление rev 1 обязано победить более поздние seq-записи rev 2.
    const restored = await handler(req("/components/prov-restore/restore", "POST", { rev: 1, baseRev: 2 }));
    expect(restored.status).toBe(200);
    expect(await headFigma(handler, "prov-restore")).toEqual(FIGMA_A);
    // Инвариант раунд3-m-3: колонка новой ревизии и её seq-строка несут одно значение.
    const column = (db.query("SELECT figma_json FROM component_revisions WHERE component_id=? AND rev=3").get("prov-restore") as { figma_json: string | null }).figma_json;
    expect(JSON.parse(column!)).toEqual(FIGMA_A);
    expect(seqRows(db, "prov-restore").at(-1)).toMatchObject({ rev: 3 });
    db.close();
  });

  test("figma: null writes a tombstone instead of falling back to the revision column", async () => {
    const { db, handler } = await setup();
    expect((await createComponent(handler, "prov-tomb", "ProvTomb", FIGMA_A)).status).toBe(201);

    const cleared = await handler(req("/components/prov-tomb/provenance", "PUT", { figma: null }));
    expect(cleared.status).toBe(200);
    expect(await json(cleared)).toMatchObject({ rev: 1, seq: 2, unchanged: false, figma: null });
    expect(await headFigma(handler, "prov-tomb")).toBeNull();
    // Колонка ревизии осталась заполненной — tombstone обязан её перекрывать, а не удалять.
    expect((db.query("SELECT figma_json FROM component_revisions WHERE component_id=? AND rev=1").get("prov-tomb") as { figma_json: string | null }).figma_json).not.toBeNull();
    expect(seqRows(db, "prov-tomb").at(-1)).toMatchObject({ rev: 1, seq: 2, figma_json: null });

    // Tombstone наследуется новой ревизией: source-PUT без `figma` не воскрешает старую ссылку.
    expect((await handler(req("/components/prov-tomb", "PUT", { baseRev: 1, source: `${await source()}\n// t\n` }))).status).toBe(200);
    expect(await headFigma(handler, "prov-tomb")).toBeNull();

    // Restore ревизии с пустой provenance переносит tombstone (иначе «пустое» невыразимо).
    expect((await handler(req("/components/prov-tomb/provenance", "PUT", { rev: 2, figma: FIGMA_B }))).status).toBe(200);
    expect((await handler(req("/components/prov-tomb/restore", "POST", { rev: 1, baseRev: 2 }))).status).toBe(200);
    expect(await headFigma(handler, "prov-tomb")).toBeNull();
    db.close();
  });

  test("identical values are deduplicated on every write path (триаж раунд3-m-1)", async () => {
    const { db, handler } = await setup();
    expect((await createComponent(handler, "prov-dedup", "ProvDedup", FIGMA_A)).status).toBe(201);
    expect(seqRows(db, "prov-dedup")).toHaveLength(1);

    // Повтор того же значения через provenance-PUT — без новой строки.
    const repeat = await handler(req("/components/prov-dedup/provenance", "PUT", { figma: FIGMA_A }));
    expect(repeat.status).toBe(200);
    expect(await json(repeat)).toMatchObject({ rev: 1, seq: null, unchanged: true, figma: FIGMA_A });
    expect(seqRows(db, "prov-dedup")).toHaveLength(1);

    // Source-PUT, таскающий тот же `figma` (сегодняшнее поведение драйвера), тоже не растит историю.
    expect((await handler(req("/components/prov-dedup", "PUT", { baseRev: 1, source: `${await source()}\n// d\n`, figma: FIGMA_A }))).status).toBe(200);
    expect(seqRows(db, "prov-dedup")).toHaveLength(1);
    expect(await headFigma(handler, "prov-dedup")).toEqual(FIGMA_A);
    db.close();
  });

  test("provenance of a published version is mutable while its byte part is not", async () => {
    const { db, handler } = await setup();
    expect((await createComponent(handler, "prov-version", "ProvVersion", FIGMA_A)).status).toBe(201);
    expect((await handler(req("/components/prov-version/publish", "POST", { baseRev: 1 }))).status).toBe(201);
    const before = await json(await handler(req("/components/prov-version/versions/1")));
    expect(before.figma).toEqual(FIGMA_A);

    expect((await handler(req("/components/prov-version/provenance", "PUT", { rev: 1, figma: FIGMA_B }))).status).toBe(200);
    const after = await json(await handler(req("/components/prov-version/versions/1")));
    expect(after.figma).toEqual(FIGMA_B);
    // Байтовая часть версии неизменна: ни бандл, ни его хэш ручка не трогает.
    expect(after.bundleHash).toBe(before.bundleHash as string);
    expect(await (await handler(req("/components/prov-version/versions/1/bundle.js"))).text())
      .toBe(await (await handler(req("/components/prov-version/versions/1/bundle.js"))).text());
    db.close();
  });

  test("the library Figma chip and the asset usage report see a provenance PUT", async () => {
    const { db, handler } = await setup();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
    const uploaded = await handler(new Request("http://test/api/assets", { method: "POST", headers: { "content-type": "image/png" }, body: png }));
    expect(uploaded.status).toBe(201);
    const assetId = (await json(uploaded)).id as string;

    expect((await createComponent(handler, "prov-library", "ProvLibrary", FIGMA_A)).status).toBe(201);
    expect((await handler(req("/components/prov-library/publish", "POST", { baseRev: 1 }))).status).toBe(201);
    expect(libraryCatalog(db).components.find((entry) => entry.id === "prov-library")?.figma).toEqual({ fileKey: FIGMA_A.fileKey, nodeCount: 1 });

    expect((await handler(req("/components/prov-library/provenance", "PUT", { figma: { ...FIGMA_C, referenceScreenshots: [assetId] } }))).status).toBe(200);
    expect(libraryCatalog(db).components.find((entry) => entry.id === "prov-library")?.figma).toEqual({ fileKey: FIGMA_C.fileKey, nodeCount: 2 });

    // AssetUsage: ассет, на который ссылается только seq-запись, обязан быть виден.
    const usage = new AssetRepo(db, dirs[0]!).usage(assetId);
    expect(usage?.provenance).toEqual([{ componentId: "prov-library", name: "ProvLibrary", revs: [1] }]);
    db.close();
  });

  test("validate sees a corrupted seq row (raw resolver form, триаж раунд2-B4)", async () => {
    const { db, handler } = await setup();
    expect((await createComponent(handler, "prov-broken", "ProvBroken", FIGMA_A)).status).toBe(201);
    db.run("UPDATE component_provenance SET figma_json=? WHERE component_id=?", ["{not json", "prov-broken"]);

    const response = await handler(req("/components/prov-broken/validate", "POST"));
    expect(response.status).toBe(422);
    expect(await json(response)).toMatchObject({ error: { code: "validation_failed" } });
    db.close();
  });

  test("authorization: only the owner or an admin may edit provenance", async () => {
    const { db, handler } = await setup();
    expect((await createComponent(handler, "prov-authz", "ProvAuthz")).status).toBe(201);

    // Анонимный принципал (без сессии) — 403, не 401-обход: ручка мутирует состояние.
    const anonymous = await createTestHandler(db, { dataDir: dirs[0]! });
    void anonymous;
    const noSession = await (async () => {
      const { createHandler } = await import("./main");
      return await createHandler(db, { dataDir: dirs[0]! })(new Request("http://test/api/components/prov-authz/provenance", {
        method: "PUT", headers: { "content-type": "application/json", origin: "http://test" }, body: JSON.stringify({ figma: FIGMA_A }),
      }));
    })();
    expect([401, 403]).toContain(noSession.status);

    // Неизвестное поле и отсутствие `figma` — 400 (поле обязательно, `null` — очистка).
    expect((await handler(req("/components/prov-authz/provenance", "PUT", { rev: 1 }))).status).toBe(400);
    expect((await handler(req("/components/prov-authz/provenance", "PUT", { figma: FIGMA_A, nope: 1 }))).status).toBe(400);
    // Несуществующая ревизия — 404, а не молчаливая запись.
    expect((await handler(req("/components/prov-authz/provenance", "PUT", { rev: 9, figma: FIGMA_A }))).status).toBe(404);
    // Метод, отличный от PUT — 405.
    expect((await handler(req("/components/prov-authz/provenance", "POST", { figma: FIGMA_A }))).status).toBe(405);
    db.close();
  });
});

describe("component provenance — migration", () => {
  /**
   * Индекс миграции v27 в массиве (нумерация с нуля). Пин по номеру, а не `at(-1)`: пакет
   * renderer-contract-2 посадил v28, и «последняя миграция» перестала быть волной R3a.
   */
  const V27_INDEX = 26;
  /** Прогоняет все миграции до v27 — «старая» БД до посадки волны R3a. */
  function legacyDatabase(): Database {
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    for (let index = 0; index < V27_INDEX; index += 1) {
      const isV13 = index === 12;
      if (isV13) db.run("PRAGMA foreign_keys = OFF");
      db.transaction(() => { migrations[index]!(db); db.run(`PRAGMA user_version = ${index + 1}`); })();
      if (isV13) db.run("PRAGMA foreign_keys = ON");
    }
    return db;
  }

  test("backfills head revisions with a non-empty figma_json and leaves the rest alone", () => {
    const db = legacyDatabase();
    const at = new Date().toISOString();
    db.query("INSERT OR IGNORE INTO design_systems (id,name,description,builtin_provider,created_at,updated_at) VALUES ('yandex-pay','YP','',NULL,?,?)").run(at, at);
    for (const [id, headRev] of [["legacy-with", 2], ["legacy-without", 1]] as const) {
      db.query("INSERT INTO components (id,name,head_rev,design_system,deleted_at,created_at,updated_at) VALUES (?,?,?,'yandex-pay',NULL,?,?)").run(id, id.toUpperCase(), headRev, at, at);
    }
    // legacy-with: figma есть и на голове (rev 2), и на исторической rev 1 — backfill берёт только голову.
    db.query("INSERT INTO component_revisions (component_id,rev,source,design_system,figma_json,created_at) VALUES ('legacy-with',1,'x','yandex-pay',?,?)").run(JSON.stringify(FIGMA_B), at);
    db.query("INSERT INTO component_revisions (component_id,rev,source,design_system,figma_json,created_at) VALUES ('legacy-with',2,'x','yandex-pay',?,?)").run(JSON.stringify(FIGMA_A), at);
    db.query("INSERT INTO component_revisions (component_id,rev,source,design_system,figma_json,created_at) VALUES ('legacy-without',1,'x','yandex-pay',NULL,?)").run(at);

    migrations[V27_INDEX]!(db);

    const rows = db.query("SELECT component_id,rev,seq,figma_json,author FROM component_provenance ORDER BY component_id").all() as { component_id: string; rev: number; seq: number; figma_json: string; author: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ component_id: "legacy-with", rev: 2, seq: 1, author: "migration:component_provenance" });
    expect(JSON.parse(rows[0]!.figma_json)).toEqual(FIGMA_A);
    db.close();
  });

  test("is additive: no existing table is rebuilt, so the previous image still starts on the new database", () => {
    const db = legacyDatabase();
    const ddl = () => Object.fromEntries((db.query("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all() as { name: string; sql: string }[]).map((row) => [row.name, row.sql]));
    const before = ddl();

    migrations[V27_INDEX]!(db);

    const after = ddl();
    for (const [name, sql] of Object.entries(before)) expect(after[name]).toBe(sql);
    expect(Object.keys(after).filter((name) => !(name in before)).sort())
      .toEqual(["candidate_decisions", "candidate_decisions_candidate", "candidate_decisions_one_rejected", "component_provenance", "component_provenance_lookup"]);
    // `SELECT *` старого кода по затронутым таблицам продолжает работать.
    expect(() => db.query("SELECT * FROM component_candidates").all()).not.toThrow();
    expect(() => db.query("SELECT * FROM component_revisions").all()).not.toThrow();
    db.close();
  });

  test("candidate_decisions keeps at most one rejection per candidate and cascades with the candidate", () => {
    const db = legacyDatabase();
    migrations[V27_INDEX]!(db);
    const at = new Date().toISOString();
    db.query(`INSERT INTO component_candidates (candidate_id,component_id,design_system,rev,source_hash,bundle_hash,host_abi_version,build_fingerprint,observed_catalog_revision,policy_profile_hash,status,created_by,created_at,expires_at)
      VALUES ('cand_x','c','yandex-pay',1,'a','b',1,'f','cr','p','validated','u',?,?)`).run(at, at);
    db.query("INSERT INTO candidate_decisions (candidate_id,decision,reason,actor,created_at) VALUES ('cand_x','rejected','no','u',?)").run(at);
    expect(() => db.query("INSERT INTO candidate_decisions (candidate_id,decision,reason,actor,created_at) VALUES ('cand_x','rejected','again','u',?)").run(at)).toThrow();
    expect(() => db.query("INSERT INTO candidate_decisions (candidate_id,decision,reason,actor,created_at) VALUES ('cand_missing','rejected','x','u',?)").run(at)).toThrow();

    db.run("DELETE FROM component_candidates WHERE candidate_id='cand_x'");
    expect(db.query("SELECT COUNT(*) n FROM candidate_decisions").get() as { n: number }).toMatchObject({ n: 0 });
    db.close();
  });
});
