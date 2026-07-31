import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { openDatabase } from "./db";
import { createTestHandler } from "./test-auth";
import {
  buildCompositionDependencyManifest,
  compositionDependencyManifestHash,
  compositionSourceHash,
  CompositionRepo,
  type CompositionDependencyManifest,
  type CompositionDocV2,
} from "./repos/compositions";
import { resolveCompositionPins } from "./repos/compositions";
import type { Database } from "bun:sqlite";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const component = (db: Database, id: string, name: string, designSystem = "yandex-pay"): void => {
  db.query(`INSERT INTO components (id,name,head_rev,design_system,created_at,updated_at)
    VALUES (?,?,1,?,'now','now')`).run(id, name, designSystem);
  db.query(`INSERT INTO component_revisions (component_id,rev,source,design_system,created_at)
    VALUES (?,1,'export const definition = {}',?,'now')`).run(id, designSystem);
  db.query(`INSERT INTO component_publishes
    (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,published_at)
    VALUES (?,1,1,'active','','{}','source-hash',?,1,'now')`).run(id, `bundle-${id}`);
};

const customDesignSystem = (db: Database, id: string): void => {
  db.query(`INSERT INTO design_systems (id,name,description,builtin_provider,created_at,updated_at,retired)
    VALUES (?,?,'test',NULL,'now','now',0)`).run(id, id);
};

const leafDoc = (name: string, version: 1 | 2 = 2): Record<string, unknown> => version === 1 ? ({
  version: 1, name, params: {}, slots: [],
  spec: { root: "leaf", elements: { leaf: { type: "Leaf", props: {} } } },
}) : ({
  version: 2, name, atomicLevel: "molecule", params: {}, slots: [],
  spec: { root: "leaf", elements: { leaf: { type: "Leaf", props: {} } } },
});

const nestedDoc = (name: string, childId: string): CompositionDocV2 => ({
  version: 2,
  name,
  atomicLevel: "organism",
  params: {},
  slots: [],
  spec: {
    root: "nested",
    elements: { nested: { type: "@eui/Composition", props: { composition: childId } } },
  },
});

function seedPublishedComposition(db: Database, id: string, doc: Record<string, unknown>, designSystem = "yandex-pay"): void {
  db.query(`INSERT INTO compositions (id,name,head_rev,design_system,created_at,updated_at)
    VALUES (?, ?, 1, ?, 'now', 'now')`).run(id, doc.name as string, designSystem);
  db.query(`INSERT INTO composition_revisions (composition_id,rev,doc,design_system,created_at)
    VALUES (?,1,?,?, 'now')`).run(id, JSON.stringify(doc) as string, designSystem);
  db.query(`INSERT INTO composition_publishes
    (composition_id,version,rev,status,source_hash,published_at)
    VALUES (?,1,1,'active',?,'now')`).run(id, compositionSourceHash(doc as CompositionDocV2));
}

describe("Composition v2 dependency closure", () => {
  test("accepts v2 over HTTP and persists direct/transitive pins plus a deterministic manifest", async () => {
    const dir = await mkdtemp(resolve(process.cwd(), ".composition-v2-test-"));
    dirs.push(dir);
    const db = openDatabase(":memory:");
    const handler = createTestHandler(db, { dataDir: dir });
    component(db, "leaf", "Leaf");
    const req = (url: string, method = "GET", value?: unknown) => handler(new Request(`http://test/api${url}`, {
      method,
      headers: value === undefined ? undefined : { "content-type": "application/json" },
      body: value === undefined ? undefined : JSON.stringify(value),
    }));

    expect((await req("/compositions", "POST", { id: "child", designSystem: "yandex-pay", doc: leafDoc("Child") })).status).toBe(201);
    expect((await req("/compositions/child/publish", "POST", { baseRev: 1 })).status).toBe(201);
    expect((await req("/compositions", "POST", { id: "parent", designSystem: "yandex-pay", doc: nestedDoc("Parent", "child") })).status).toBe(201);
    expect((await req("/compositions/parent/publish", "POST", { baseRev: 1 })).status).toBe(201);

    const row = db.query("SELECT dependency_manifest_json,dependency_manifest_hash FROM composition_publishes WHERE composition_id='parent' AND version=1").get() as { dependency_manifest_json: string; dependency_manifest_hash: string };
    const manifest = JSON.parse(row.dependency_manifest_json) as CompositionDependencyManifest;
    expect(row.dependency_manifest_hash).toBe(manifest.hash);
    expect(manifest.compositions.map((pin) => `${pin.id}@${pin.version}`)).toEqual(["child@1", "parent@1"]);
    expect(manifest.components).toEqual([{ id: "leaf", name: "Leaf", version: 1, bundleHash: "bundle-leaf" }]);
    expect(manifest.hash).toBe(compositionDependencyManifestHash(manifest));

    const resolved = resolveCompositionPins(db, ["parent"], "yandex-pay");
    expect(resolved.missing).toEqual([]);
    expect(resolved.pins.map((pin) => `${pin.id}@${pin.version}`)).toEqual(["child@1", "parent@1"]);
    expect(resolved.componentPins).toEqual(manifest.components);
    expect(resolved.docs.child!.name).toBe("Child");
    db.close();
  });

  test("keeps a parent on the child version it published against after the child is republished", () => {
    const db = openDatabase(":memory:");
    component(db, "leaf", "Leaf");
    const repo = new CompositionRepo(db);
    const child = leafDoc("Child") as CompositionDocV2;
    repo.create("child", child as never, "yandex-pay");
    expect(repo.publish("child", 1)).toEqual({ version: 1, rev: 1 });
    repo.create("parent", nestedDoc("Parent", "child") as never, "yandex-pay");
    expect(repo.publish("parent", 1)).toEqual({ version: 1, rev: 1 });

    repo.save("child", { ...child, description: "new child" } as never, 1);
    expect(repo.publish("child", 2)).toEqual({ version: 2, rev: 2 });

    const resolved = resolveCompositionPins(db, ["parent"], "yandex-pay");
    expect(resolved.pins.map((pin) => `${pin.id}@${pin.version}`)).toEqual(["child@1", "parent@1"]);
    expect(resolved.docs.child!.description).toBeUndefined();
    db.close();
  });
});

describe("Composition v2 publish validation", () => {
  test("validates nested parameter contracts against the fully expanded publication", () => {
    const db = openDatabase(":memory:");
    component(db, "leaf", "Leaf");
    const repo = new CompositionRepo(db);
    const child = {
      version: 2 as const,
      name: "Required child",
      atomicLevel: "molecule" as const,
      params: { label: { type: "string" as const, required: true } },
      slots: [],
      spec: { root: "leaf", elements: { leaf: { type: "Leaf", props: { value: { $param: "label" } } } } },
    };
    repo.create("required-child", child as never, "yandex-pay");
    expect(() => repo.publish("required-child", 1)).not.toThrow();
    const parent = nestedDoc("Missing child argument", "required-child");
    repo.create("missing-child-argument", parent as never, "yandex-pay");
    expect(() => repo.publish("missing-child-argument", 1)).toThrow(expect.objectContaining({ code: "validation_failed", status: 422 }));
    expect(db.query("SELECT COUNT(*) count FROM composition_publishes WHERE composition_id='missing-child-argument'").get()).toEqual({ count: 0 });
    db.close();
  });

  test("rejects a nested composition from another design system", () => {
    const db = openDatabase(":memory:");
    customDesignSystem(db, "foreign-ds");
    component(db, "foreign-leaf", "Leaf", "foreign-ds");
    const repo = new CompositionRepo(db);
    repo.create("foreign", leafDoc("Foreign", 1) as never, "foreign-ds");
    repo.publish("foreign", 1);
    const root = nestedDoc("Root", "foreign");
    try {
      buildCompositionDependencyManifest(db, {
        id: "root", name: root.name, designSystem: "yandex-pay", version: 1,
        sourceHash: compositionSourceHash(root), doc: root as never,
      }, "yandex-pay");
      throw new Error("expected design-system validation to fail");
    } catch (error) {
      expect((error as { details?: { issues?: { message?: string }[] } }).details?.issues?.[0]?.message).toMatch(/different design system/);
    }
    db.close();
  });

  test("reports the full cycle path", () => {
    const db = openDatabase(":memory:");
    seedPublishedComposition(db, "cycle-a", nestedDoc("CycleA", "cycle-b"));
    seedPublishedComposition(db, "cycle-b", nestedDoc("CycleB", "cycle-a"));
    const root = nestedDoc("CycleA", "cycle-b");
    try {
      buildCompositionDependencyManifest(db, {
        id: "cycle-a", name: root.name, designSystem: "yandex-pay", version: 1,
        sourceHash: compositionSourceHash(root), doc: root as never,
      }, "yandex-pay");
      throw new Error("expected cycle validation to fail");
    } catch (error) {
      expect((error as { details?: { issues?: { message?: string }[] } }).details?.issues?.[0]?.message).toMatch(/cycle-a@1.*cycle-b@1.*cycle-a@1/);
    }
    db.close();
  });

  test("accepts depth five and rejects depth six", () => {
    const db = openDatabase(":memory:");
    component(db, "leaf", "Leaf");
    const accepted = ["depth-a", "depth-b", "depth-c", "depth-d", "depth-e"];
    for (let index = accepted.length - 1; index >= 0; index -= 1) {
      const doc = index === accepted.length - 1 ? leafDoc("DepthLeaf") : nestedDoc(`Depth${index}`, accepted[index + 1]!);
      seedPublishedComposition(db, accepted[index]!, doc);
    }
    const acceptedRoot = nestedDoc("Depth0", accepted[1]!);
    expect(buildCompositionDependencyManifest(db, {
      id: accepted[0]!, name: acceptedRoot.name, designSystem: "yandex-pay", version: 1,
      sourceHash: compositionSourceHash(acceptedRoot), doc: acceptedRoot as never,
    }, "yandex-pay").pins).toHaveLength(5);

    const ids = ["depth-six-a", "depth-six-b", "depth-six-c", "depth-six-d", "depth-six-e", "depth-six-f"];
    for (let index = ids.length - 1; index >= 0; index -= 1) {
      const doc = index === ids.length - 1 ? leafDoc("DepthSixLeaf") : nestedDoc(`DepthSix${index}`, ids[index + 1]!);
      seedPublishedComposition(db, ids[index]!, doc);
    }
    const sixRoot = nestedDoc("DepthSix0", ids[1]!);
    try {
      buildCompositionDependencyManifest(db, {
        id: ids[0]!, name: sixRoot.name, designSystem: "yandex-pay", version: 1,
        sourceHash: compositionSourceHash(sixRoot), doc: sixRoot as never,
      }, "yandex-pay");
      throw new Error("expected depth validation to fail");
    } catch (error) {
      expect((error as { details?: { issues?: { message?: string }[] } }).details?.issues?.[0]?.message).toMatch(/depth.*5/);
    }
    db.close();
  });
});
