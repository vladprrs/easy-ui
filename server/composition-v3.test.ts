import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { openDatabase } from "./db";
import { createTestHandler } from "./test-auth";
import { capabilities } from "./routes/meta";

/**
 * Kill-switch D9 (план 2026-08-03 §5 W8a): запись композиций `version: 3` требует
 * `EASYUI_COMPOSITION_V3=1`. Полярность как у `EASYUI_SURFACES`: пусто = фича выключена.
 * Чтение и раскрытие уже сохранённых v3 флагом не управляются.
 */

const dirs: string[] = [];
const previousEnv = process.env.EASYUI_COMPOSITION_V3;
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  if (previousEnv === undefined) delete process.env.EASYUI_COMPOSITION_V3; else process.env.EASYUI_COMPOSITION_V3 = previousEnv;
});

const component = (db: Database, id: string, name: string, designSystem = "yandex-pay"): void => {
  db.query(`INSERT INTO components (id,name,head_rev,design_system,created_at,updated_at)
    VALUES (?,?,1,?,'now','now')`).run(id, name, designSystem);
  db.query(`INSERT INTO component_revisions (component_id,rev,source,design_system,created_at)
    VALUES (?,1,'export const definition = {}',?,'now')`).run(id, designSystem);
  db.query(`INSERT INTO component_publishes
    (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,published_at)
    VALUES (?,1,1,'active','','{}','source-hash',?,1,'now')`).run(id, `bundle-${id}`);
};

const v3Doc = (name: string) => ({
  version: 3,
  name,
  atomicLevel: "molecule",
  params: { tone: { type: "enum", values: ["brand", "muted"], default: "brand" } },
  slots: [],
  spec: {
    root: "leaf",
    elements: {
      leaf: { type: "Leaf", props: { tone: { $switch: { param: "tone", cases: { brand: "accent", muted: "grey" } } } }, children: ["extra"] },
      extra: { type: "Leaf", props: {}, when: { param: "tone", eq: "muted" } },
    },
  },
});

const v2Doc = (name: string) => ({
  version: 2, name, atomicLevel: "molecule", params: {}, slots: [],
  spec: { root: "leaf", elements: { leaf: { type: "Leaf", props: {} } } },
});

async function fixture() {
  const dir = await mkdtemp(resolve(process.cwd(), ".composition-v3-test-"));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  const handler = createTestHandler(db, { dataDir: dir });
  component(db, "leaf", "Leaf");
  const req = (url: string, method = "GET", value?: unknown) => handler(new Request(`http://test/api${url}`, {
    method,
    headers: value === undefined ? undefined : { "content-type": "application/json" },
    body: value === undefined ? undefined : JSON.stringify(value),
  }));
  return { db, req };
}

describe("composition v3 kill-switch", () => {
  test("rejects create and save of version 3 while EASYUI_COMPOSITION_V3 is off", async () => {
    delete process.env.EASYUI_COMPOSITION_V3;
    const { req } = await fixture();

    const created = await req("/compositions", "POST", { id: "tone", designSystem: "yandex-pay", doc: v3Doc("Tone") });
    expect(created.status).toBe(422);
    expect((await created.json() as { error: { code: string } }).error.code).toBe("composition_v3_disabled");

    // v2 продолжает писаться при выключенном флаге, и апгрейд головы до v3 — тоже 422.
    expect((await req("/compositions", "POST", { id: "legacy", designSystem: "yandex-pay", doc: v2Doc("Legacy") })).status).toBe(201);
    const saved = await req("/compositions/legacy", "PUT", { baseRev: 1, doc: v3Doc("Legacy") });
    expect(saved.status).toBe(422);
    expect((await saved.json() as { error: { code: string } }).error.code).toBe("composition_v3_disabled");
  });

  test("accepts version 3 with EASYUI_COMPOSITION_V3=1 and keeps reading it after the flag is turned off", async () => {
    process.env.EASYUI_COMPOSITION_V3 = "1";
    const { req } = await fixture();

    expect((await req("/compositions", "POST", { id: "tone", designSystem: "yandex-pay", doc: v3Doc("Tone") })).status).toBe(201);
    expect((await req("/compositions/tone/publish", "POST", { baseRev: 1 })).status).toBe(201);

    // После первой v3-записи откат невозможен без чистки данных: чтение обязано работать
    // независимо от флага (канон EASYUI_SURFACES).
    delete process.env.EASYUI_COMPOSITION_V3;
    const meta = await req("/compositions/tone");
    expect(meta.status).toBe(200);
    expect((await meta.json() as { doc: { version: number } }).doc.version).toBe(3);
  });

  test("publishes the expansion probe of a v3 document (typed params, when and $switch)", async () => {
    process.env.EASYUI_COMPOSITION_V3 = "1";
    const { db, req } = await fixture();
    expect((await req("/compositions", "POST", { id: "tone", designSystem: "yandex-pay", doc: v3Doc("Tone") })).status).toBe(201);
    expect((await req("/compositions/tone/publish", "POST", { baseRev: 1 })).status).toBe(201);
    // Strict-closure v2 действует и для v3: компонент тела попал в манифест зависимостей.
    const row = db.query("SELECT dependency_manifest_json FROM composition_publishes WHERE composition_id='tone' AND version=1").get() as { dependency_manifest_json: string };
    expect(JSON.parse(row.dependency_manifest_json).components).toEqual([{ id: "leaf", name: "Leaf", version: 1, bundleHash: "bundle-leaf" }]);
  });

  test("saves a prototype that references a stored v3 composition regardless of the flag", async () => {
    process.env.EASYUI_COMPOSITION_V3 = "1";
    const dir = await mkdtemp(resolve(process.cwd(), ".composition-v3-test-"));
    dirs.push(dir);
    const db = openDatabase(":memory:");
    const handler = createTestHandler(db, { dataDir: dir });
    const req = (url: string, method = "GET", value?: unknown) => handler(new Request(`http://test/api${url}`, {
      method,
      headers: value === undefined ? undefined : { "content-type": "application/json" },
      body: value === undefined ? undefined : JSON.stringify(value),
    }));

    const source = await Bun.file(resolve("server/fixtures", "ctyp-accrual-badge.tsx")).text();
    expect((await req("/components", "POST", { designSystem: "yandex-pay", id: "ctyp-accrual-badge", name: "CtypAccrualBadge", source, intent: "Renders the accrual badge inside a reusable product composition" })).status).toBe(201);
    expect((await req("/components/ctyp-accrual-badge/publish", "POST", { baseRev: 1 })).status).toBe(201);

    const doc = {
      version: 3, name: "Accrual", atomicLevel: "molecule",
      params: { tone: { type: "enum", values: ["brand", "muted"], default: "brand" } },
      slots: [],
      spec: { root: "badge", elements: {
        badge: { type: "CtypAccrualBadge", props: { amount: { $switch: { param: "tone", cases: { brand: "12 ₽", muted: "0 ₽" } } } }, children: ["extra"] },
        extra: { type: "CtypAccrualBadge", props: { amount: "1 ₽" }, when: { param: "tone", eq: "muted" } },
      } },
    };
    expect((await req("/compositions", "POST", { id: "accrual", designSystem: "yandex-pay", doc })).status).toBe(201);
    expect((await req("/compositions/accrual/publish", "POST", { baseRev: 1 })).status).toBe(201);

    // Save-путь прототипа (`expandPrototypeForSave`) раскрывает v3 так же, как v2, и от
    // kill-switch'а не зависит: флаг гейтит только запись самих композиций.
    delete process.env.EASYUI_COMPOSITION_V3;
    const prototype = {
      version: 1, id: "v3-host", name: "V3 host", designSystem: "yandex-pay", device: "mobile", startScreen: "main", state: {},
      screens: [{ id: "main", name: "Main", spec: { root: "screen", elements: {
        screen: { type: "@eui/Composition", props: { composition: "accrual", params: { tone: "muted" } } },
      } } }],
    };
    expect((await req("/prototypes", "POST", { doc: prototype })).status).toBe(201);
    expect(db.query("SELECT composition_id id,composition_version version FROM prototype_revision_compositions WHERE prototype_id='v3-host' AND rev=1").all())
      .toEqual([{ id: "accrual", version: 1 }]);
    // Пины полны: компонент встречается только внутри композиции.
    expect(db.query("SELECT component_id id FROM prototype_revision_components WHERE prototype_id='v3-host' AND rev=1").all())
      .toEqual([{ id: "ctyp-accrual-badge" }]);
    // Хранится авторский документ; `when`/`$switch` живут в композиции, а не в прототипе.
    const stored = (db.query("SELECT doc FROM prototype_revisions WHERE prototype_id='v3-host' AND rev=1").get() as { doc: string }).doc;
    expect(stored).toContain("@eui/Composition");
    expect(stored).not.toContain("$switch");
    db.close();
  });

  test("publishes the write policy through capabilities.features.compositionV3", async () => {
    const { db } = await fixture();
    delete process.env.EASYUI_COMPOSITION_V3;
    expect((capabilities(db) as { features: Record<string, boolean> }).features.compositionV3).toBe(false);
    process.env.EASYUI_COMPOSITION_V3 = "1";
    expect((capabilities(db) as { features: Record<string, boolean> }).features.compositionV3).toBe(true);
  });
});

/**
 * W8b/W8c: `repeatParam` и слоты с метаданными живут за тем же kill-switch'ем, что и
 * остальной v3, и проходят полный путь save → publish → ссылка из прототипа.
 */
describe("composition v3 — repeatParam and slot metadata", () => {
  const listDoc = {
    version: 3, name: "List", atomicLevel: "organism",
    params: {
      rows: { type: "array", items: { type: "object", schema: { id: { type: "string", required: true }, text: { type: "string" } } }, maxItems: 10, default: [] },
    },
    slots: {
      body: { required: true, allowedTypes: ["Leaf"], cardinality: { min: 1, max: 2 }, fallback: ["empty"] },
    },
    spec: {
      root: "list",
      elements: {
        list: { type: "Leaf", props: {}, children: ["row", "body-slot"] },
        row: { type: "Leaf", props: { text: { $item: "text" }, order: { $index: true } }, repeatParam: { param: "rows", key: "id" } },
        "body-slot": { type: "@eui/Slot", props: { name: "body" } },
        empty: { type: "Leaf", props: { text: "nothing" } },
      },
    },
  };

  test("rejects repeatParam and dictionary slots while the flag is off", async () => {
    delete process.env.EASYUI_COMPOSITION_V3;
    const { req } = await fixture();
    const created = await req("/compositions", "POST", { id: "list", designSystem: "yandex-pay", doc: listDoc });
    expect(created.status).toBe(422);
    expect((await created.json() as { error: { code: string } }).error.code).toBe("composition_v3_disabled");
  });

  test("rejects an unknown canonical role in slot metadata", async () => {
    process.env.EASYUI_COMPOSITION_V3 = "1";
    const { req } = await fixture();
    const doc = { ...listDoc, slots: { body: { allowedRoles: ["definitely-not-a-role"], fallback: ["empty"] } } };
    const created = await req("/compositions", "POST", { id: "list", designSystem: "yandex-pay", doc });
    expect(created.status).toBe(422);
    const body = await created.json() as { error: { issues: { message: string }[] } };
    expect(body.error.issues[0]!.message).toContain("unknown canonical role");
  });

  test("saves, publishes and expands repeatParam and slot fallback from a prototype", async () => {
    process.env.EASYUI_COMPOSITION_V3 = "1";
    const dir = await mkdtemp(resolve(process.cwd(), ".composition-v3-test-"));
    dirs.push(dir);
    const db = openDatabase(":memory:");
    const handler = createTestHandler(db, { dataDir: dir });
    const req = (url: string, method = "GET", value?: unknown) => handler(new Request(`http://test/api${url}`, {
      method,
      headers: value === undefined ? undefined : { "content-type": "application/json" },
      body: value === undefined ? undefined : JSON.stringify(value),
    }));
    const source = await Bun.file(resolve("server/fixtures", "ctyp-accrual-badge.tsx")).text();
    expect((await req("/components", "POST", { designSystem: "yandex-pay", id: "ctyp-accrual-badge", name: "CtypAccrualBadge", source, intent: "Renders the accrual badge inside a repeated composition row" })).status).toBe(201);
    expect((await req("/components/ctyp-accrual-badge/publish", "POST", { baseRev: 1 })).status).toBe(201);

    const doc = {
      version: 3, name: "List", atomicLevel: "organism",
      params: {
        rows: { type: "array", items: { type: "object", schema: { id: { type: "string", required: true }, text: { type: "string", required: true } } }, maxItems: 10, default: [] },
      },
      slots: { body: { required: true, allowedTypes: ["CtypAccrualBadge"], cardinality: { min: 1, max: 2 }, fallback: ["empty"] } },
      spec: {
        root: "list",
        elements: {
          list: { type: "CtypAccrualBadge", props: { amount: "0 ₽" }, children: ["row", "body-slot"] },
          row: { type: "CtypAccrualBadge", props: { amount: { $item: "text" } }, repeatParam: { param: "rows", key: "id" } },
          "body-slot": { type: "@eui/Slot", props: { name: "body" } },
          empty: { type: "CtypAccrualBadge", props: { amount: "nothing" } },
        },
      },
    };
    expect((await req("/compositions", "POST", { id: "list", designSystem: "yandex-pay", doc })).status).toBe(201);
    // Publish-probe не имеет точки ссылки: required-слот его не роняет, fallback раскрывается.
    expect((await req("/compositions/list/publish", "POST", { baseRev: 1 })).status).toBe(201);

    const prototype = (id: string, elements: Record<string, unknown>) => ({
      version: 1, id, name: "V3 list", designSystem: "yandex-pay", device: "mobile", startScreen: "main", state: {},
      screens: [{ id: "main", name: "Main", spec: { root: "screen", elements } }],
    });
    const rows = [{ id: "a", text: "A" }, { id: "b", text: "B" }];

    const saved = await req("/prototypes", "POST", {
      doc: prototype("v3-list", {
        screen: { type: "@eui/Composition", props: { composition: "list", params: { rows } }, children: ["kid"] },
        kid: { type: "CtypAccrualBadge", props: { amount: "1 ₽" }, slot: "body" },
      }),
    });
    expect(saved.status).toBe(201);
    expect(db.query("SELECT composition_id id,composition_version version FROM prototype_revision_compositions WHERE prototype_id='v3-list' AND rev=1").all())
      .toEqual([{ id: "list", version: 1 }]);
    // Хранится авторский документ: ни `repeatParam`, ни `$item` в прототип не уезжают.
    const stored = (db.query("SELECT doc FROM prototype_revisions WHERE prototype_id='v3-list' AND rev=1").get() as { doc: string }).doc;
    expect(stored).not.toContain("repeatParam");
    expect(stored).not.toContain("$item");

    // Пустой обязательный слот покрыт fallback'ом.
    expect((await req("/prototypes", "POST", {
      doc: prototype("v3-list-fallback", {
        screen: { type: "@eui/Composition", props: { composition: "list", params: { rows } } },
      }),
    })).status).toBe(201);

    // Нарушенный контракт слота — 422 из save-пути (раскрытие в точке ссылки).
    const tooMany = await req("/prototypes", "POST", {
      doc: prototype("v3-list-too-many", {
        screen: { type: "@eui/Composition", props: { composition: "list", params: { rows } }, children: ["a", "b", "c"] },
        a: { type: "CtypAccrualBadge", props: { amount: "1 ₽" }, slot: "body" },
        b: { type: "CtypAccrualBadge", props: { amount: "2 ₽" }, slot: "body" },
        c: { type: "CtypAccrualBadge", props: { amount: "3 ₽" }, slot: "body" },
      }),
    });
    expect(tooMany.status).toBe(422);
    expect(JSON.stringify(await tooMany.json())).toContain("accepts at most 2");
    db.close();
  });
});
