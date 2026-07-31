import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase } from "./db";
import { currentDataFingerprint, currentCatalogRevision, applyMigration, catalogBackupPath, evictCatalogBackupCache, getCatalogBackup, prepareMigration, restoreCatalogBackup } from "./migrationRunner";
import type { CatalogMigrationPlan } from "./catalog/migrationPlan";

const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const source = (name: string) => `export const definition = { props: {}, events: [], slots: [], description: "${name}" }; export default function ${name}(){ return null; }`;

function component(db: ReturnType<typeof openDatabase>, id: string, name: string): void {
  db.query("INSERT INTO components (id,name,head_rev,design_system,created_at,updated_at) VALUES (?,?,1,'yandex-pay','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')").run(id, name);
  db.query("INSERT INTO component_revisions (component_id,rev,source,design_system,created_at) VALUES (?,?,?,'yandex-pay','2026-01-01T00:00:00.000Z')").run(id, 1, source(name));
  db.query(`INSERT INTO component_publishes
    (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,published_at)
    VALUES (?,1,1,'active','',?, ?, ?,1,'2026-01-01T00:00:00.000Z')`).run(id, JSON.stringify({ description: name, events: [], slots: [], propsJsonSchema: { type: "object" } }), `source-${id}`, `bundle-${id}`);
}

function prototype(db: ReturnType<typeof openDatabase>): void {
  const doc = { version: 1, id: "migration-prototype", name: "Migration prototype", designSystem: "yandex-pay", device: "mobile", startScreen: "home", state: {}, screens: [{ id: "home", name: "Home", spec: { root: "root", elements: { root: { type: "OldCard", props: {} } } } }] };
  db.query(`INSERT INTO prototypes (id,name,device,screen_count,head_rev,design_system,instance_id,created_at,updated_at,status)
    VALUES ('migration-prototype','Migration prototype','mobile',1,1,'yandex-pay','migration-instance','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','published')`).run();
  db.query("INSERT INTO prototype_revisions (prototype_id,rev,doc,builtin_catalog_hash,created_at) VALUES ('migration-prototype',1,?,'hash','2026-01-01T00:00:00.000Z')").run(JSON.stringify(doc));
  db.query("INSERT INTO prototype_revision_components (prototype_id,rev,component_id,component_version) VALUES ('migration-prototype',1,'old-card',1)").run();
  db.query("INSERT INTO prototype_publishes (prototype_id,version,rev,published_at) VALUES ('migration-prototype',1,1,'2026-01-01T00:00:00.000Z')").run();
}

function compositionTarget(db: ReturnType<typeof openDatabase>): void {
  const doc = {
    version: 2,
    name: "Card composition",
    atomicLevel: "molecule",
    params: {},
    slots: [],
    spec: { root: "root", elements: { root: { type: "Image", props: { src: "/card.png", alt: "Card" } } } },
  };
  db.query(`INSERT INTO compositions (id,name,head_rev,design_system,created_at,updated_at)
    VALUES ('card-composition','Card composition',1,'yandex-pay','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run();
  db.query(`INSERT INTO composition_revisions (composition_id,rev,doc,design_system,created_at)
    VALUES ('card-composition',1,?,'yandex-pay','2026-01-01T00:00:00.000Z')`).run(JSON.stringify(doc));
  db.query(`INSERT INTO composition_publishes
    (composition_id,version,rev,status,source_hash,dependency_manifest_json,dependency_manifest_hash,published_at)
    VALUES ('card-composition',1,1,'active','composition-source','[]','', '2026-01-01T00:00:00.000Z')`).run();
}

function plan(db: ReturnType<typeof openDatabase>): CatalogMigrationPlan {
  return {
    version: 1,
    generatedAt: "2026-07-31T00:00:00.000Z",
    catalogRevision: currentCatalogRevision(db),
    dataFingerprint: currentDataFingerprint(db),
    groups: [{
      canonical: { kind: "component", id: "new-card", designSystem: "yandex-pay", version: 1 },
      retired: [{ kind: "component", id: "old-card", designSystem: "yandex-pay", version: 1 }],
      confidence: 1,
      reasons: ["same structure"],
      adapter: { typeMap: { OldCard: "NewCard" }, props: { OldCard: {} } },
      affectedPrototypeHeads: ["migration-prototype"],
      affectedCompositionHeads: [],
      immutableUsages: [],
    }],
    compositionConversions: [],
    metadataRevisions: [],
    documentedExceptions: [],
  };
}

describe("catalog migration runner", () => {
  test("rewrites current heads, publishes only a migrated published head, records replacement and keeps a backup", () => {
    const db = openDatabase(":memory:");
    component(db, "old-card", "OldCard");
    component(db, "new-card", "NewCard");
    prototype(db);
    const migrationPlan = plan(db);
    const prepared = prepareMigration(db, migrationPlan, "migration-test-run");
    expect(prepared.status).toBe("prepared");

    applyMigration(db, migrationPlan, prepared.runId);

    expect(db.query("SELECT head_rev FROM prototypes WHERE id='migration-prototype'").get()).toEqual({ head_rev: 2 });
    expect(JSON.parse((db.query("SELECT doc FROM prototype_revisions WHERE prototype_id='migration-prototype' AND rev=2").get() as { doc: string }).doc).screens[0].spec.elements.root.type).toBe("NewCard");
    expect(db.query("SELECT component_id FROM prototype_revision_components WHERE prototype_id='migration-prototype' AND rev=2").get()).toEqual({ component_id: "new-card" });
    expect(db.query("SELECT version FROM prototype_publishes WHERE prototype_id='migration-prototype' ORDER BY version DESC LIMIT 1").get()).toEqual({ version: 2 });
    expect(db.query("SELECT status FROM component_publishes WHERE component_id='old-card' AND version=1").get()).toEqual({ status: "deprecated" });
    expect(db.query("SELECT deleted_at IS NOT NULL deleted FROM components WHERE id='old-card'").get()).toEqual({ deleted: 1 });
    expect(db.query("SELECT to_id FROM catalog_replacements WHERE from_kind='component' AND from_id='old-card'").get()).toEqual({ to_id: "new-card" });
    const run = db.query("SELECT status,backup_id FROM catalog_migration_runs WHERE id=?").get(prepared.runId) as { status: string; backup_id: string };
    expect(run.status).toBe("applied");
    expect(run.backup_id).toBe("sqlite-cutover-migration-test-run");
    expect(db.query("SELECT COUNT(*) count FROM maintenance_locks").get()).toEqual({ count: 0 });
    db.close();
  });

  test("rejects a changed data fingerprint before staging writes", () => {
    const db = openDatabase(":memory:");
    component(db, "old-card", "OldCard");
    component(db, "new-card", "NewCard");
    prototype(db);
    const migrationPlan = plan(db);
    db.run("UPDATE prototypes SET name='changed' WHERE id='migration-prototype'");
    expect(() => prepareMigration(db, migrationPlan, "stale-run")).toThrow(expect.objectContaining({ code: "migration_plan_stale", status: 409 }));
    expect(db.query("SELECT COUNT(*) count FROM catalog_migration_runs").get()).toEqual({ count: 0 });
    db.close();
  });

  test("recognizes an applied run before checking the now-stale snapshot", () => {
    const db = openDatabase(":memory:");
    component(db, "old-card", "OldCard");
    component(db, "new-card", "NewCard");
    prototype(db);
    const migrationPlan = plan(db);
    const prepared = prepareMigration(db, migrationPlan, "idempotent-run");
    applyMigration(db, migrationPlan, prepared.runId);
    const head = db.query("SELECT head_rev FROM prototypes WHERE id='migration-prototype'").get() as { head_rev: number };
    db.run("UPDATE prototypes SET name='changed after cutover' WHERE id='migration-prototype'");
    expect(() => applyMigration(db, migrationPlan, prepared.runId)).not.toThrow();
    expect(db.query("SELECT head_rev FROM prototypes WHERE id='migration-prototype'").get()).toEqual(head);
    db.close();
  });

  test("aborts every staging row when cutover fails", () => {
    const db = openDatabase(":memory:");
    component(db, "old-card", "OldCard");
    component(db, "new-card", "NewCard");
    const migrationPlan = plan(db);
    const prepared = prepareMigration(db, migrationPlan, "failed-run");
    expect(() => applyMigration(db, migrationPlan, prepared.runId, { applyHeads: () => { throw new Error("injected cutover failure"); } })).toThrow("injected cutover failure");
    expect(db.query("SELECT status FROM catalog_migration_runs WHERE id=?").get(prepared.runId)).toEqual({ status: "aborted" });
    expect(db.query("SELECT DISTINCT status FROM catalog_migration_staging WHERE run_id=?").all(prepared.runId)).toEqual([{ status: "aborted" }]);
    expect(db.query("SELECT COUNT(*) count FROM maintenance_locks").get()).toEqual({ count: 0 });
    db.close();
  });

  test("rejects missing canonical targets and existing replacement mappings", () => {
    const db = openDatabase(":memory:");
    component(db, "old-card", "OldCard");
    component(db, "new-card", "NewCard");
    const missingTarget = plan(db);
    missingTarget.groups[0]!.canonical = { kind: "component", id: "missing", designSystem: "yandex-pay", version: 1 };
    expect(() => prepareMigration(db, missingTarget, "missing-target-run")).toThrow(expect.objectContaining({ code: "migration_target_invalid", status: 409 }));

    const conflictPlan = plan(db);
    db.query(`INSERT INTO catalog_replacements
      (from_kind,from_id,from_design_system,to_kind,to_id,to_design_system,migration_run_id,reason,created_at)
      VALUES ('component','old-card','yandex-pay','component','other-card','yandex-pay','previous-run','existing','2026-01-01T00:00:00.000Z')`).run();
    expect(() => prepareMigration(db, conflictPlan, "replacement-conflict-run")).toThrow(expect.objectContaining({ code: "migration_replacement_conflict", status: 409 }));
    db.close();
  });

  test("keeps a retired component when an active composition manifest is corrupt", () => {
    const db = openDatabase(":memory:");
    component(db, "old-card", "OldCard");
    component(db, "new-card", "NewCard");
    db.query(`INSERT INTO compositions (id,name,head_rev,design_system,created_at,updated_at)
      VALUES ('legacy-composition','Legacy composition',1,'yandex-pay','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run();
    db.query(`INSERT INTO composition_revisions (composition_id,rev,doc,design_system,created_at)
      VALUES ('legacy-composition',1,'not-json','yandex-pay','2026-01-01T00:00:00.000Z')`).run();
    db.query(`INSERT INTO composition_publishes
      (composition_id,version,rev,status,source_hash,dependency_manifest_json,dependency_manifest_hash,published_at)
      VALUES ('legacy-composition',1,1,'active','legacy-source','{broken','wrong','2026-01-01T00:00:00.000Z')`).run();
    const migrationPlan = plan(db);
    const prepared = prepareMigration(db, migrationPlan, "corrupt-manifest-run");
    applyMigration(db, migrationPlan, prepared.runId, { applyHeads: () => {} });
    expect(db.query("SELECT deleted_at IS NOT NULL deleted FROM components WHERE id='old-card'").get()).toEqual({ deleted: 0 });
    db.close();
  });

  test("restores the cutover image and records a rolled-back run", () => {
    const db = openDatabase(":memory:");
    component(db, "old-card", "OldCard");
    component(db, "new-card", "NewCard");
    prototype(db);
    const migrationPlan = plan(db);
    const prepared = prepareMigration(db, migrationPlan, "rollback-run");
    applyMigration(db, migrationPlan, prepared.runId);
    const applied = db.query("SELECT backup_id backupId FROM catalog_migration_runs WHERE id=?").get(prepared.runId) as { backupId: string };
    expect(getCatalogBackup(applied.backupId)).not.toBeNull();
    expect(restoreCatalogBackup(db, prepared.runId, applied.backupId)).toMatchObject({ runId: prepared.runId, backupId: applied.backupId, status: "rolled_back" });
    expect(db.query("SELECT deleted_at IS NOT NULL deleted FROM components WHERE id='old-card'").get()).toEqual({ deleted: 0 });
    expect(db.query("SELECT status FROM catalog_migration_runs WHERE id=?").get(prepared.runId)).toEqual({ status: "rolled_back" });
    expect(db.query("SELECT DISTINCT status FROM catalog_migration_staging WHERE run_id=?").all(prepared.runId)).toEqual([{ status: "aborted" }]);
    expect(db.query("SELECT COUNT(*) count FROM maintenance_locks").get()).toEqual({ count: 0 });
    db.close();
  });

  test("restores from the retained image after the process cache is gone", () => {
    const dataDir = mkdtempSync(resolve(process.cwd(), ".migration-runner-test-"));
    tempDirs.push(dataDir);
    // A file-backed database, not `:memory:`: production runs in WAL mode and a WAL image
    // cannot be reopened read-only, which an in-memory fixture would never reveal.
    const db = openDatabase(resolve(dataDir, "easy-ui.db"));
    component(db, "old-card", "OldCard");
    component(db, "new-card", "NewCard");
    prototype(db);
    const migrationPlan = plan(db);
    const prepared = prepareMigration(db, migrationPlan, "retained-rollback-run");
    const backupId = `sqlite-cutover-${prepared.runId}`;
    applyMigration(db, migrationPlan, prepared.runId, { backupId, backupPath: catalogBackupPath(dataDir, backupId) });
    // A restart drops the in-memory image; the retained one plus its sidecar must still resolve.
    evictCatalogBackupCache();
    expect(getCatalogBackup(backupId)).toBeNull();
    expect(getCatalogBackup(backupId, dataDir)).toMatchObject({ id: backupId });
    evictCatalogBackupCache();
    expect(restoreCatalogBackup(db, prepared.runId, backupId, { dataDir }))
      .toMatchObject({ runId: prepared.runId, backupId, status: "rolled_back" });
    expect(db.query("SELECT deleted_at IS NOT NULL deleted FROM components WHERE id='old-card'").get()).toEqual({ deleted: 0 });
    expect(db.query("SELECT COUNT(*) count FROM catalog_replacements").get()).toEqual({ count: 0 });
    db.close();
  });

  test("records and applies a component-to-composition replacement", () => {
    const db = openDatabase(":memory:");
    component(db, "old-card", "OldCard");
    compositionTarget(db);
    prototype(db);
    const migrationPlan: CatalogMigrationPlan = {
      version: 1,
      generatedAt: "2026-07-31T00:00:00.000Z",
      catalogRevision: currentCatalogRevision(db),
      dataFingerprint: currentDataFingerprint(db),
      groups: [],
      compositionConversions: [{
        from: { kind: "component", id: "old-card", designSystem: "yandex-pay", version: 1 },
        toCompositionId: "card-composition",
        doc: {
          version: 2,
          name: "Card composition",
          atomicLevel: "molecule",
          params: {},
          slots: [],
          spec: { root: "root", elements: { root: { type: "Image", props: { src: "/card.png", alt: "Card" } } } },
        },
        adapter: { typeMap: { OldCard: "@eui/Composition" }, props: { OldCard: {} }, composition: { id: "card-composition" } },
      }],
      metadataRevisions: [],
      documentedExceptions: [],
    };
    const prepared = prepareMigration(db, migrationPlan, "component-composition-run");
    applyMigration(db, migrationPlan, prepared.runId);
    const transformed = JSON.parse((db.query("SELECT doc FROM prototype_revisions WHERE prototype_id='migration-prototype' AND rev=2").get() as { doc: string }).doc);
    expect(transformed.screens[0].spec.elements.root).toMatchObject({ type: "@eui/Composition", props: { composition: "card-composition" } });
    expect(db.query("SELECT composition_id,composition_version FROM prototype_revision_compositions WHERE prototype_id='migration-prototype' AND rev=2").get()).toEqual({ composition_id: "card-composition", composition_version: 1 });
    expect(db.query("SELECT to_kind,to_id FROM catalog_replacements WHERE from_kind='component' AND from_id='old-card'").get()).toEqual({ to_kind: "composition", to_id: "card-composition" });
    expect(db.query("SELECT deleted_at IS NOT NULL deleted FROM components WHERE id='old-card'").get()).toEqual({ deleted: 1 });
    db.close();
  });
});
