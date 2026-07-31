import { expect, test } from "bun:test";
import { openDatabase } from "../db";
import { auditCatalog } from "./audit";
import { hashCatalogMigrationPlan } from "./migrationPlan";

const duplicateSource = `export const definition = { props: {}, events: [], slots: [], description: "Shared" }; export default function Shared(){ return null; }`;

function seedComponent(db: ReturnType<typeof openDatabase>, id: string, name: string): void {
  db.query("INSERT INTO components (id,name,head_rev,design_system,created_at,updated_at) VALUES (?,?,1,'yandex-pay','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')").run(id, name);
  db.query("INSERT INTO component_revisions (component_id,rev,source,design_system,created_at) VALUES (?,1,?,'yandex-pay','2026-01-01T00:00:00.000Z')").run(id, duplicateSource);
  db.query(`INSERT INTO component_publishes
    (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,published_at)
    VALUES (?,1,1,'active','',?,'source','bundle',1,'2026-01-01T00:00:00.000Z')`).run(id, JSON.stringify({ description: "Shared", events: [], slots: [], propsJsonSchema: { type: "object", properties: { value: { type: "string" } } } }));
}

function seedComposition(db: ReturnType<typeof openDatabase>, id: string, doc: object, manifest: object): void {
  db.query("INSERT INTO compositions (id,name,head_rev,design_system,created_at,updated_at) VALUES (?, ?, 1, 'yandex-pay', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run(id, id);
  db.query("INSERT INTO composition_revisions (composition_id,rev,doc,design_system,created_at) VALUES (?,1,?,'yandex-pay','2026-01-01T00:00:00.000Z')").run(id, JSON.stringify(doc));
  db.query(`INSERT INTO composition_publishes
    (composition_id,version,rev,status,source_hash,dependency_manifest_json,dependency_manifest_hash,published_at)
    VALUES (?,1,1,'active','source',?,'manifest','2026-01-01T00:00:00.000Z')`).run(id, JSON.stringify(manifest));
}

test("catalog audit returns a deterministic duplicate mapping with real usage coordinates", () => {
  const db = openDatabase(":memory:");
  seedComponent(db, "component-a", "ComponentA");
  seedComponent(db, "component-b", "ComponentB");
  const doc = { version: 1, id: "audit-prototype", name: "Audit", designSystem: "yandex-pay", device: "mobile", startScreen: "home", state: {}, screens: [{ id: "home", name: "Home", spec: { root: "root", elements: { root: { type: "ComponentA", props: {} } } } }] };
  db.query("INSERT INTO prototypes (id,name,device,screen_count,head_rev,design_system,instance_id,created_at,updated_at,status) VALUES ('audit-prototype','Audit','mobile',2,2,'yandex-pay','audit-instance','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','published')").run();
  db.query("INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,created_at) VALUES ('audit-prototype',1,?,'hash','2026-01-01T00:00:00.000Z'),('audit-prototype',2,?,'hash','2026-01-01T00:00:00.000Z')").run(JSON.stringify({ ...doc, screens: [{ ...doc.screens[0], spec: { ...doc.screens[0].spec, elements: { root: { type: "ComponentB", props: {} } } } }] }), JSON.stringify(doc));
  db.query("INSERT INTO prototype_revision_components (prototype_id,rev,component_id,component_version) VALUES ('audit-prototype',1,'component-b',1),('audit-prototype',2,'component-a',1)").run();
  db.query("INSERT INTO prototype_publishes (prototype_id,version,rev,published_at) VALUES ('audit-prototype',7,1,'2026-01-01T00:00:00.000Z')").run();

  const first = auditCatalog(db);
  const second = auditCatalog(db);
  expect(first.duplicateGroups).toHaveLength(1);
  expect(first.plan.groups[0]).toMatchObject({ canonical: { id: "component-a" }, retired: [{ id: "component-b" }], confidence: 1 });
  expect(first.plan.groups[0]!.affectedPrototypeHeads).toEqual([]);
  expect(first.plan.groups[0]!.immutableUsages).toEqual([{ resourceId: "audit-prototype", version: 7 }]);
  expect(hashCatalogMigrationPlan(first.plan)).toBe(hashCatalogMigrationPlan(second.plan));
  expect(first.artifacts.find((artifact) => artifact.artifact.id === "component-b")?.classification).toBe("semantic-duplicate");
  db.close();
});

test("catalog audit counts nested active composition manifest usage", () => {
  const db = openDatabase(":memory:");
  seedComponent(db, "component-a", "ComponentA");
  seedComponent(db, "component-b", "ComponentB");
  db.query("UPDATE component_publishes SET definition_meta=? WHERE component_id='component-a' AND version=1")
    .run(JSON.stringify({ description: "Shared", canonicalFor: ["layout-primitive"], events: [], slots: [], propsJsonSchema: { type: "object", properties: { value: { type: "string" } } } }));

  const childDoc = { version: 2, name: "NestedChild", description: "Child", atomicLevel: "molecule", params: {}, slots: [], spec: { root: "child", elements: { child: { type: "ComponentB", props: {} } } } };
  const parentDoc = { version: 2, name: "NestedParent", description: "Parent", atomicLevel: "organism", params: {}, slots: [], spec: { root: "parent", elements: { parent: { type: "@eui/Composition", props: { composition: "nested-child" } } } } };
  seedComposition(db, "nested-child", childDoc, { version: 1, root: { id: "nested-child", version: 1 }, compositions: [{ id: "nested-child", name: "nested-child", version: 1, sourceHash: "child" }], components: [{ id: "component-b", name: "ComponentB", version: 1, bundleHash: "bundle" }], hash: "child-manifest" });
  seedComposition(db, "nested-parent", parentDoc, { version: 1, root: { id: "nested-parent", version: 1 }, compositions: [{ id: "nested-child", name: "nested-child", version: 1, sourceHash: "child" }, { id: "nested-parent", name: "nested-parent", version: 1, sourceHash: "parent" }], components: [{ id: "component-b", name: "ComponentB", version: 1, bundleHash: "bundle" }], hash: "parent-manifest" });

  const report = auditCatalog(db);
  const componentB = report.artifacts.find((artifact) => artifact.artifact.id === "component-b");
  expect(report.plan.groups[0]).toMatchObject({ canonical: { id: "component-a" }, retired: [{ id: "component-b" }] });
  expect(componentB?.currentHeadUsageCount).toBe(2);
  expect(report.plan.groups[0]!.affectedCompositionHeads).toEqual(["nested-child", "nested-parent"]);
  db.close();
});
