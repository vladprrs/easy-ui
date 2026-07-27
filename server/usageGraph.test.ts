import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { openDatabase } from "./db";
import { createTestHandler } from "./test-auth";
import { catalogUsages, componentUsages, componentUsageTree, headUsageCounts } from "./usageGraph";

// Волна 3 §3.1/§3.2: граф использования, агрегированный индекс и надгробия компонентов.

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const doc = (id: string, elements: Record<string, string>, screenId = "home") => JSON.stringify({
  version: 1, id, name: id, designSystem: "yandex-pay", device: "mobile", startScreen: screenId,
  screens: [{ id: screenId, name: screenId.toUpperCase(), spec: { root: "root", elements: Object.fromEntries(Object.entries(elements).map(([key, type]) => [key, { type, props: {} }])) } }],
});

function component(db: Database, id: string, name: string, versions = 1, designSystem = "yandex-pay"): void {
  db.query("INSERT INTO components (id,name,head_rev,design_system,deleted_at,owner_id,created_at,updated_at) VALUES (?,?,?,?,NULL,'user_admin','now','now')").run(id, name, versions, designSystem);
  for (let rev = 1; rev <= versions; rev += 1) {
    db.query("INSERT INTO component_revisions (component_id,rev,source,design_system,created_at) VALUES (?,?,'export const definition={}',?,'now')").run(id, rev, designSystem);
    db.query(`INSERT INTO component_publishes (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,published_at)
      VALUES (?,?,?,'active','','{}','sh','bh',1,'now')`).run(id, rev, rev);
  }
}

function prototype(db: Database, id: string, headRev: number, docJson: string, kind = "product-flow"): void {
  db.query(`INSERT INTO prototypes (id,name,device,screen_count,head_rev,design_system,instance_id,owner_id,status,kind,created_at,updated_at)
    VALUES (?,?,'mobile',1,?,'yandex-pay',?,'user_admin','private',?,'now',?)`).run(id, id, headRev, `instance-${id}`, kind, `2026-01-0${headRev}`);
  db.query("INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,created_at) VALUES (?,?,?,'h','now')").run(id, headRev, docJson);
}

function pin(db: Database, prototypeId: string, rev: number, componentId: string, version: number): void {
  db.query("INSERT INTO prototype_revision_components (prototype_id,rev,component_id,component_version) VALUES (?,?,?,?)").run(prototypeId, rev, componentId, version);
}

async function fixture() {
  const dir = await mkdtemp(resolve(process.cwd(), ".usage-test-")); dirs.push(dir);
  const db = openDatabase(":memory:");
  const handler = createTestHandler(db, { dataDir: dir });
  const call = (path: string, method = "GET", body?: unknown) => handler(new Request(`http://test/api${path}`, {
    method, headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  return { db, call };
}

describe("component usage graph", () => {
  test("reports head usages with screen/element keys, immutable publication pins and versions in use", async () => {
    const { db } = await fixture();
    component(db, "stars", "Stars", 2);
    component(db, "unused", "Unused");
    prototype(db, "checkout", 4, doc("checkout", { root: "YpBox", a: "Stars", b: "Stars", c: "Unused" }));
    pin(db, "checkout", 4, "stars", 2);
    pin(db, "checkout", 4, "unused", 1);
    // Публикация ссылается на старую ревизию с пином v1 — это immutable-использование.
    db.query("INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,created_at) VALUES ('checkout',1,?,'h','now')").run(doc("checkout", { root: "Stars" }));
    pin(db, "checkout", 1, "stars", 1);
    db.run("INSERT INTO prototype_publishes (prototype_id,version,rev,published_at) VALUES ('checkout',1,1,'now')");

    const stars = componentUsages(db, "stars");
    expect(stars.currentHeadUsages).toEqual([{
      prototypeId: "checkout", name: "checkout", kind: "product-flow", rev: 4, componentVersion: 2,
      screens: [{ screenId: "home", screenName: "HOME", elementKeys: ["a", "b"] }],
    }]);
    expect(stars.immutableUsages).toEqual([{ prototypeId: "checkout", name: "checkout", version: 1, componentVersion: 1 }]);
    expect(stars.versionsInUse).toEqual([1, 2]);
    expect(stars.safeToRemove).toBe(false);

    // Компонент без единого пина — безопасен к удалению.
    component(db, "orphan", "Orphan");
    expect(componentUsages(db, "orphan")).toMatchObject({ currentHeadUsages: [], immutableUsages: [], versionsInUse: [], safeToRemove: true });
  });

  // Компонент, живущий только внутри композиции, не встречается в авторском документе —
  // пин на него есть, а drill-down без раскрытия композиции был бы пустым.
  test("resolves element keys of a component used only inside a pinned composition", async () => {
    const { db } = await fixture();
    component(db, "inner-badge", "InnerBadge");
    db.query("INSERT INTO compositions (id,name,head_rev,design_system,deleted_at,owner_id,created_at,updated_at) VALUES ('sum','Summary',1,'yandex-pay',NULL,'user_admin','now','now')").run();
    db.query(`INSERT INTO composition_revisions (composition_id,rev,doc,design_system,created_at) VALUES ('sum',1,?,'yandex-pay','now')`)
      .run(JSON.stringify({ version: 1, name: "Summary", params: {}, slots: [], spec: { root: "box", elements: { box: { type: "VfBox", props: {} }, badge: { type: "InnerBadge", props: {} } } } }));
    db.query("INSERT INTO composition_publishes (composition_id,version,rev,status,source_hash,published_at) VALUES ('sum',1,1,'active','sh','now')").run();
    prototype(db, "host", 1, JSON.stringify({
      version: 1, id: "host", name: "host", designSystem: "yandex-pay", device: "mobile", startScreen: "home",
      screens: [{ id: "home", name: "HOME", spec: { root: "root", elements: { root: { type: "VfBox", props: {} }, comp: { type: "@eui/Composition", props: { composition: "sum" } } } } }],
    }));
    pin(db, "host", 1, "inner-badge", 1);
    db.query("INSERT INTO prototype_revision_compositions (prototype_id,rev,composition_id,composition_version) VALUES ('host',1,'sum',1)").run();

    const report = componentUsages(db, "inner-badge");
    expect(report.currentHeadUsages[0]!.screens).toEqual([{ screenId: "home", screenName: "HOME", elementKeys: ["comp$badge"] }]);
    expect(report.safeToRemove).toBeFalse();
    db.close();
  });

  test("tree format groups head usages as prototype → screen → element", async () => {
    const { db } = await fixture();
    component(db, "stars", "Stars");
    prototype(db, "flow", 1, doc("flow", { root: "YpBox", a: "Stars" }));
    pin(db, "flow", 1, "stars", 1);
    const tree = componentUsageTree(db, "stars");
    expect(tree.format).toBe("tree");
    expect(tree.nodes).toEqual([{
      kind: "prototype", id: "flow", label: "flow",
      children: [{ kind: "screen", id: "home", label: "HOME", children: [{ kind: "element", id: "a", label: "a" }] }],
    }]);
  });

  test("aggregate index counts head prototypes and invalidates on MAX(prototypes.updated_at)", async () => {
    const { db } = await fixture();
    component(db, "stars", "Stars");
    prototype(db, "one", 1, doc("one", { root: "Stars" }));
    pin(db, "one", 1, "stars", 1);
    expect(catalogUsages(db).components.find((entry) => entry.componentId === "stars")).toMatchObject({ headUsageCount: 1 });

    prototype(db, "two", 1, doc("two", { root: "Stars" }));
    pin(db, "two", 1, "stars", 1);
    db.query("UPDATE prototypes SET updated_at='2026-02-02' WHERE id='two'").run();
    expect(headUsageCounts(db).get("stars")).toBe(2);

    // Удаление прототипа не двигает MAX(updated_at) — счётчик строк в штампе ловит и это.
    db.query("DELETE FROM prototype_revision_components WHERE prototype_id='two'").run();
    db.query("DELETE FROM prototypes WHERE id='two'").run();
    expect(headUsageCounts(db).get("stars")).toBe(1);
  });

  test("usages endpoint serves flat and tree formats and 404s an unknown component", async () => {
    const { db, call } = await fixture();
    component(db, "stars", "Stars");
    prototype(db, "flow", 1, doc("flow", { root: "Stars" }));
    pin(db, "flow", 1, "stars", 1);
    const flat = await call("/components/stars/usages");
    expect(flat.status).toBe(200);
    expect(await flat.json()).toMatchObject({ componentId: "stars", safeToRemove: false });
    expect(await (await call("/components/stars/usages?format=tree")).json()).toMatchObject({ format: "tree" });
    expect((await call("/components/stars/usages?format=nope")).status).toBe(422);
    expect((await call("/components/missing/usages")).status).toBe(404);
    const aggregate = await call("/catalog/usages?designSystem=yandex-pay");
    expect(aggregate.status).toBe(200);
    expect(await aggregate.json()).toMatchObject({ components: [{ componentId: "stars", headUsageCount: 1 }] });
  });
});

describe("component tombstones and safe deletion", () => {
  test("bare GET stays 404 while includeDeleted exposes the tombstone", async () => {
    const { db, call } = await fixture();
    component(db, "stars", "Stars");
    component(db, "next", "Next");
    expect((await call("/components/stars", "DELETE", { baseRev: 1, reason: "replaced by Next", replacement: "next" })).status).toBe(204);

    expect((await call("/components/stars")).status).toBe(404);
    const tombstone = await call("/components/stars?includeDeleted=1");
    expect(tombstone.status).toBe(200);
    expect(await tombstone.json()).toMatchObject({ id: "stars", deleted: true, reason: "replaced by Next", replacement: "next" });

    const plain = await (await call("/components")).json() as { id: string }[];
    expect(plain.map((row) => row.id)).toEqual(["next"]);
    const withDeleted = await (await call("/components?includeDeleted=1")).json() as { id: string; deleted?: boolean }[];
    expect(withDeleted.find((row) => row.id === "stars")).toMatchObject({ deleted: true });
    expect(withDeleted.find((row) => row.id === "next")?.deleted).toBeUndefined();
  });

  test("rejects deletion while head revisions pin the component and lets an admin force it", async () => {
    const { db, call } = await fixture();
    component(db, "stars", "Stars");
    prototype(db, "flow", 1, doc("flow", { root: "Stars" }));
    pin(db, "flow", 1, "stars", 1);

    const blocked = await call("/components/stars", "DELETE", { baseRev: 1 });
    expect(blocked.status).toBe(409);
    const body = await blocked.json() as { error: { code: string; usages: { currentHeadUsages: unknown[] } } };
    expect(body.error.code).toBe("component_in_use");
    expect(body.error.usages.currentHeadUsages).toHaveLength(1);

    // createTestHandler авторизуется bootstrap-админом, поэтому force проходит.
    expect((await call("/components/stars", "DELETE", { baseRev: 1, force: true })).status).toBe(204);
    expect(await (await call("/components/stars?includeDeleted=1")).json()).toMatchObject({ deleted: true, reason: null, replacement: null });
  });

  test("rejects a replacement that does not exist", async () => {
    const { db, call } = await fixture();
    component(db, "stars", "Stars");
    const response = await call("/components/stars", "DELETE", { baseRev: 1, replacement: "ghost" });
    expect(response.status).toBe(422);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("validation_failed");
  });
});
