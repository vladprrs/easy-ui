import { Database, type SQLQueryBindings } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalStringify } from "../src/capture/canonicalJson";
import { inputPrototypeDocSchema, type PrototypeDoc } from "../src/prototype/schema";
import { compositionDocSchema, collectCompositionRefs, type CompositionDoc } from "../src/prototype/composition";
import { COMPOSITION_TYPE } from "../src/catalog/hostPrimitives/composition.definition";
import { hostPrimitiveNames } from "../src/catalog/hostPrimitives/definitions";
import { catalogRevision, type CatalogRevisionSource } from "./catalogRevision";
import {
  hashCatalogMigrationPlan,
  normalizeCatalogMigrationPlan,
  serializeCatalogMigrationPlan,
  type ArtifactKey,
  type ArtifactKind,
  type ArtifactMetadataRevision,
  type CatalogMigrationGroup,
  type CatalogMigrationPlan,
  type CompositionConversion,
  type DocumentedException,
  type MigrationAdapter,
  type PropMigration as MigrationAdapterProp,
  type EventMigration as MigrationAdapterEvent,
} from "./catalog/migrationPlan";
import { applyMigrationAdapter as applyDeclarativeMigrationAdapter } from "./catalog/adapters";
import { ApiError } from "./http";
import { acquireMaintenanceLock, assertMaintenanceLockOwner, releaseMaintenanceLock, type MaintenanceLock } from "./maintenance";
import { writeAuditEvent } from "./audit";
import { requireActiveDesignSystem } from "./designSystems";
import { buildCompositionDependencyManifest, COMPOSITION_NESTING_DEPTH_LIMIT, compositionDependencyManifestHash, compositionSourceHash, parseStoredCompositionDoc, resolveCompositionPins } from "./repos/compositions";

/** Backward-compatible names for callers of the runner; the canonical shapes live in catalog/migrationPlan. */
export type MigrationArtifactKind = ArtifactKind;
export type MigrationArtifactKey = ArtifactKey;
export type { ArtifactKey, ArtifactMetadataRevision, CatalogMigrationGroup, CompositionConversion, DocumentedException, MigrationAdapter, MigrationAdapterProp, MigrationAdapterEvent, CatalogMigrationPlan };
export type MigrationGroup = CatalogMigrationGroup;

export interface ChangedPath {
  path: string;
  from: unknown;
  to: unknown;
}

export interface AdapterResult<T> {
  value: T;
  changedPaths: ChangedPath[];
}

const sha256 = (value: string): string => new Bun.CryptoHasher("sha256").update(value).digest("hex");

export const migrationPlanHash = hashCatalogMigrationPlan;
export const migrationPlanJson = serializeCatalogMigrationPlan;

/**
 * Applies the canonical declarative adapter and keeps the historical runner return shape.
 * Refusals are fatal here; callers that need a report without throwing should use
 * `server/catalog/adapters.ts` directly.
 */
export function applyMigrationAdapter(doc: PrototypeDoc, adapter: MigrationAdapter): AdapterResult<PrototypeDoc> {
  const result = applyDeclarativeMigrationAdapter(doc, adapter);
  if (!result.ok) {
    throw new ApiError(422, "migration_adapter_refused", "Migration adapter cannot transform the document", {
      issues: result.refusals.map((refusal) => ({ path: refusal.path, message: `${refusal.code}: ${refusal.message}` })),
    });
  }
  return {
    value: result.value as PrototypeDoc,
    changedPaths: result.changedPaths.map((path) => ({ path, from: undefined, to: undefined })),
  };
}

/** Component-to-composition conversion is explicit in the plan and still uses the same pure adapter. */
export function applyCompositionConversion(doc: PrototypeDoc, conversion: CompositionConversion): AdapterResult<PrototypeDoc> {
  const adapter: MigrationAdapter = {
    ...conversion.adapter,
    typeMap: { ...conversion.adapter.typeMap, [conversion.from.id]: COMPOSITION_TYPE },
    composition: {
      ...(conversion.adapter.composition ?? {}),
      id: conversion.toCompositionId,
    },
  };
  return applyMigrationAdapter(doc, adapter);
}

function compositionMetaSource(row: { id: string; designSystem: string; version: number; doc: string }): CatalogRevisionSource | null {
  try {
    const doc = compositionDocSchema.parse(JSON.parse(row.doc)) as CompositionDoc;
    return {
      kind: "composition",
      designSystem: row.designSystem,
      id: row.id,
      version: row.version,
      description: doc.description ?? "",
      atomicLevel: doc.version === 2 ? doc.atomicLevel : undefined,
      scope: doc.version === 2 ? doc.scope : undefined,
      canonicalFor: doc.version === 2 ? doc.canonicalFor ?? [] : [],
      replacement: doc.version === 2 ? doc.replacement : undefined,
      meta: {
        propsJsonSchema: {
          type: "object",
          properties: Object.fromEntries(Object.entries(doc.params).map(([name, parameter]) => [name, { type: parameter.type }])),
        },
        events: [],
        slots: [...doc.slots],
      },
    };
  } catch {
    // A corrupt historical row must make a migration plan stale/unsafe rather than disappear
    // from its fingerprint. The raw document is represented as a stable unknown shape.
    return {
      kind: "composition",
      designSystem: row.designSystem,
      id: row.id,
      version: row.version,
      meta: { propsJsonSchema: { type: "unknown" }, events: [], slots: [] },
    };
  }
}

/** Active catalog revision including both components and compositions. */
export function currentCatalogRevision(db: Database): string {
  const sources: CatalogRevisionSource[] = [];
  const componentRows = db.query(`SELECT c.id,c.name,r.design_system designSystem,p.version,p.definition_meta definitionMeta
    FROM components c
    JOIN component_publishes p ON p.component_id=c.id AND p.status='active'
    JOIN component_revisions r ON r.component_id=p.component_id AND r.rev=p.rev
    WHERE c.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM component_publishes newer
        JOIN component_revisions newerRevision ON newerRevision.component_id=newer.component_id AND newerRevision.rev=newer.rev
        WHERE newer.component_id=p.component_id AND newer.status='active'
          AND newer.version>p.version AND newerRevision.design_system=r.design_system)
    ORDER BY r.design_system,c.id,p.version`).all() as { id: string; name: string; designSystem: string; version: number; definitionMeta: string }[];
  for (const row of componentRows) {
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(row.definitionMeta) as Record<string, unknown>; } catch { /* fingerprint remains deterministic */ }
    sources.push({
      kind: "component",
      designSystem: row.designSystem,
      id: row.id,
      version: row.version,
      description: typeof meta.description === "string" ? meta.description : "",
      atomicLevel: typeof meta.atomicLevel === "string" ? meta.atomicLevel : undefined,
      scope: typeof meta.scope === "string" ? meta.scope : undefined,
      canonicalFor: Array.isArray(meta.canonicalFor) ? meta.canonicalFor.filter((value): value is string => typeof value === "string") : [],
      replacement: typeof meta.replacement === "string" ? meta.replacement : undefined,
      meta: {
        propsJsonSchema: meta.propsJsonSchema,
        events: Array.isArray(meta.events) ? meta.events.filter((value): value is string => typeof value === "string") : [],
        slots: Array.isArray(meta.slots) ? meta.slots.filter((value): value is string => typeof value === "string") : [],
      },
    });
  }
  const compositionRows = db.query(`SELECT c.id,c.design_system designSystem,p.version,r.doc
    FROM compositions c
    JOIN composition_publishes p ON p.composition_id=c.id AND p.status='active'
    JOIN composition_revisions r ON r.composition_id=p.composition_id AND r.rev=p.rev
    WHERE c.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM composition_publishes newer
        WHERE newer.composition_id=p.composition_id AND newer.status='active' AND newer.version>p.version)
    ORDER BY c.design_system,c.id,p.version`).all() as { id: string; designSystem: string; version: number; doc: string }[];
  for (const row of compositionRows) {
    const source = compositionMetaSource(row);
    if (source) sources.push(source);
  }
  return catalogRevision(sources);
}

function activeRows(db: Database): unknown[] {
  return db.query(`SELECT 'component' kind,c.id,p.version,r.design_system designSystem,
      p.status,p.source_hash sourceHash,p.bundle_hash bundleHash,p.definition_meta payload
    FROM components c JOIN component_publishes p ON p.component_id=c.id
    JOIN component_revisions r ON r.component_id=p.component_id AND r.rev=p.rev
    WHERE c.deleted_at IS NULL AND p.status='active'
    UNION ALL
    SELECT 'composition' kind,c.id,p.version,r.design_system designSystem,
      p.status,p.source_hash sourceHash,p.dependency_manifest_hash bundleHash,p.dependency_manifest_json payload
    FROM compositions c JOIN composition_publishes p ON p.composition_id=c.id
    JOIN composition_revisions r ON r.composition_id=p.composition_id AND r.rev=p.rev
    WHERE c.deleted_at IS NULL AND p.status='active'
    ORDER BY kind,designSystem,id,version`).all();
}

/** Fingerprint of all mutable state that can invalidate a prepared cutover. */
export function currentDataFingerprint(db: Database): string {
  const rows = {
    catalogRevision: currentCatalogRevision(db),
    catalog: activeRows(db),
    components: db.query("SELECT id,name,head_rev,design_system,deleted_at,delete_reason,replacement_component_id,created_at,updated_at FROM components ORDER BY id").all(),
    componentRevisions: db.query("SELECT component_id,rev,source,design_system,message,author,created_at,figma_json FROM component_revisions ORDER BY component_id,rev").all(),
    componentPublishes: db.query("SELECT component_id,version,rev,status,status_reason,superseded_by,status_rev,source_hash,bundle_hash,definition_meta FROM component_publishes ORDER BY component_id,version").all(),
    componentPublishAssets: db.query("SELECT component_id,version,asset_id FROM component_publish_assets ORDER BY component_id,version,asset_id").all(),
    compositions: db.query("SELECT id,name,head_rev,design_system,deleted_at,delete_reason,created_at,updated_at FROM compositions ORDER BY id").all(),
    compositionRevisions: db.query("SELECT composition_id,rev,doc,design_system,message,author,created_at FROM composition_revisions ORDER BY composition_id,rev").all(),
    compositionPublishes: db.query("SELECT composition_id,version,rev,status,status_reason,superseded_by,status_rev,source_hash,dependency_manifest_json,dependency_manifest_hash FROM composition_publishes ORDER BY composition_id,version").all(),
    replacements: db.query("SELECT from_kind,from_id,from_design_system,to_kind,to_id,to_design_system,migration_run_id,reason,created_at FROM catalog_replacements ORDER BY from_kind,from_design_system,from_id").all(),
    prototypes: db.query("SELECT id,name,description,device,screen_count,head_rev,instance_id,design_system,status,kind,tags,derived_from,created_at,updated_at FROM prototypes ORDER BY id").all(),
    prototypeRevisions: db.query("SELECT prototype_id,rev,doc,builtin_catalog_hash,design_system_meta_version,figma_json,message,author,created_at FROM prototype_revisions ORDER BY prototype_id,rev").all(),
    prototypePublishes: db.query("SELECT prototype_id,version,rev,message FROM prototype_publishes ORDER BY prototype_id,version").all(),
    componentPins: db.query("SELECT prototype_id,rev,component_id,component_version FROM prototype_revision_components ORDER BY prototype_id,rev,component_id").all(),
    compositionPins: db.query("SELECT prototype_id,rev,composition_id,composition_version FROM prototype_revision_compositions ORDER BY prototype_id,rev,composition_id").all(),
    prototypeAssets: db.query("SELECT prototype_id,rev,asset_id FROM prototype_revision_assets ORDER BY prototype_id,rev,asset_id").all(),
  };
  return sha256(canonicalStringify(rows));
}

export function assertMigrationPlanFresh(db: Database, plan: CatalogMigrationPlan): void {
  const currentCatalog = currentCatalogRevision(db);
  const currentData = currentDataFingerprint(db);
  if (plan.catalogRevision !== currentCatalog || plan.dataFingerprint !== currentData) {
    throw new ApiError(409, "migration_plan_stale", "Catalog migration plan does not match the current production snapshot", {
      catalogRevision: currentCatalog,
      dataFingerprint: currentData,
    });
  }
}

type ActiveArtifactPublication = { version: number; rev: number };
type ReplacementRow = { toKind: ArtifactKind; toId: string; toDesignSystem: string; migrationRunId: string };

const artifactCoordinate = (key: ArtifactKey): string => `${key.kind}:${key.designSystem}:${key.id}`;

const sameArtifact = (left: ArtifactKey, right: ArtifactKey): boolean =>
  left.kind === right.kind && left.id === right.id && left.designSystem === right.designSystem;

function activeArtifactPublication(db: Database, key: ArtifactKey): ActiveArtifactPublication | null {
  const table = key.kind === "component" ? "components" : "compositions";
  const publicationTable = key.kind === "component" ? "component_publishes" : "composition_publishes";
  const idColumn = key.kind === "component" ? "component_id" : "composition_id";
  const row = db.query(`SELECT p.version,p.rev
    FROM ${table} c
    JOIN ${publicationTable} p ON p.${idColumn}=c.id AND p.status='active'
    JOIN ${key.kind === "component" ? "component_revisions" : "composition_revisions"} r
      ON r.${idColumn}=p.${idColumn} AND r.rev=p.rev
    WHERE c.id=? AND c.design_system=? AND c.deleted_at IS NULL
      AND r.design_system=? ${key.version === undefined ? "" : "AND p.version=?"}
    ORDER BY p.version DESC LIMIT 1`).get(
    ...(key.version === undefined ? [key.id, key.designSystem, key.designSystem] : [key.id, key.designSystem, key.designSystem, key.version]),
  ) as ActiveArtifactPublication | null;
  return row;
}

function existingReplacement(db: Database, key: ArtifactKey): ReplacementRow | null {
  return db.query(`SELECT to_kind toKind,to_id toId,to_design_system toDesignSystem,migration_run_id migrationRunId
    FROM catalog_replacements WHERE from_kind=? AND from_id=? AND from_design_system=?`)
    .get(key.kind, key.id, key.designSystem) as ReplacementRow | null;
}

function invalidMigrationPlan(message: string, issues: unknown[] = []): never {
  throw new ApiError(422, "migration_plan_invalid", message, { issues });
}

function invalidMigrationTarget(key: ArtifactKey, role: "canonical" | "retired" | "conversion", message: string): never {
  throw new ApiError(409, "migration_target_invalid", message, {
    issues: [{ path: [role, key.kind, key.designSystem, key.id], message }],
  });
}

function replacementConflict(message: string, issues: unknown[] = []): never {
  throw new ApiError(409, "migration_replacement_conflict", message, { issues });
}

function assertArtifactKeyShape(key: ArtifactKey, role: string): void {
  if (!key || (key.kind !== "component" && key.kind !== "composition") || typeof key.id !== "string" || key.id.length === 0 || typeof key.designSystem !== "string" || key.designSystem.length === 0) {
    invalidMigrationPlan(`${role} must identify a catalog artifact`);
  }
  if (key.version !== undefined && (!Number.isInteger(key.version) || key.version < 1)) {
    invalidMigrationPlan(`${role} version must be a positive integer`);
  }
}

/**
 * Validate all identities that the cutover is about to mutate. This is kept at
 * the runner boundary because the plan is also accepted from an admin HTTP
 * client and the catalog can change after the plan was generated.
 */
export function validateMigrationPlan(db: Database, input: CatalogMigrationPlan): void {
  const plan = normalizeCatalogMigrationPlan(input);
  const canonicalKeys = new Map<string, ArtifactKey>();
  const replacementTargets = new Map<string, ArtifactKey>();
  const conversionSources = new Map<string, string>();

  const validateLiveTarget = (key: ArtifactKey, role: "canonical" | "retired" | "conversion"): void => {
    assertArtifactKeyShape(key, `${role} artifact`);
    if (!activeArtifactPublication(db, key)) {
      invalidMigrationTarget(key, role, `${role} artifact ${artifactCoordinate(key)} does not have a matching active publication`);
    }
  };

  for (const [groupIndex, group] of plan.groups.entries()) {
    assertArtifactKeyShape(group.canonical, `groups[${groupIndex}].canonical`);
    if (group.retired.length === 0) invalidMigrationPlan(`groups[${groupIndex}] must retire at least one artifact`);
    if (group.canonical.kind !== group.retired[0]!.kind || group.canonical.designSystem !== group.retired[0]!.designSystem) {
      invalidMigrationPlan(`groups[${groupIndex}] canonical and retired artifacts must share kind and design system`);
    }
    const canonicalCoordinate = artifactCoordinate(group.canonical);
    if (canonicalKeys.has(canonicalCoordinate)) {
      replacementConflict(`Canonical artifact ${canonicalCoordinate} is claimed by multiple migration groups`);
    }
    canonicalKeys.set(canonicalCoordinate, group.canonical);
    validateLiveTarget(group.canonical, "canonical");

    for (const retired of group.retired) {
      assertArtifactKeyShape(retired, `groups[${groupIndex}].retired`);
      if (sameArtifact(retired, group.canonical)) {
        replacementConflict(`Artifact ${artifactCoordinate(retired)} cannot be both canonical and retired`);
      }
      if (retired.kind !== group.canonical.kind || retired.designSystem !== group.canonical.designSystem) {
        invalidMigrationPlan(`groups[${groupIndex}] contains a cross-kind or cross-design-system replacement`);
      }
      const sourceCoordinate = artifactCoordinate(retired);
      const previousTarget = replacementTargets.get(sourceCoordinate);
      if (previousTarget && !sameArtifact(previousTarget, group.canonical)) {
        replacementConflict(`Artifact ${sourceCoordinate} has conflicting replacement targets`);
      }
      if (previousTarget) replacementConflict(`Artifact ${sourceCoordinate} appears more than once in the migration plan`);
      replacementTargets.set(sourceCoordinate, group.canonical);
      validateLiveTarget(retired, "retired");

      const existing = existingReplacement(db, retired);
      if (existing) {
        replacementConflict(`Artifact ${sourceCoordinate} already has replacement ${existing.toKind}:${existing.toDesignSystem}:${existing.toId}`);
      }
    }
  }

  for (const [coordinate, canonical] of canonicalKeys) {
    const existing = existingReplacement(db, canonical);
    if (existing) {
      replacementConflict(`Canonical target ${coordinate} is itself already replaced by ${existing.toKind}:${existing.toDesignSystem}:${existing.toId}`);
    }
    if (replacementTargets.has(coordinate)) {
      replacementConflict(`Canonical target ${coordinate} is also retired by this migration`);
    }
  }

  for (const [conversionIndex, conversion] of plan.compositionConversions.entries()) {
    assertArtifactKeyShape(conversion.from, `compositionConversions[${conversionIndex}].from`);
    if (typeof conversion.toCompositionId !== "string" || conversion.toCompositionId.length === 0) {
      invalidMigrationPlan(`compositionConversions[${conversionIndex}].toCompositionId must be a non-empty id`);
    }
    const sourceCoordinate = artifactCoordinate(conversion.from);
    const previousTarget = conversionSources.get(sourceCoordinate);
    const existingTarget = replacementTargets.get(sourceCoordinate);
    if (existingTarget) {
      replacementConflict(`Artifact ${sourceCoordinate} is already claimed by another migration replacement`);
    }
    if (previousTarget !== undefined && previousTarget !== conversion.toCompositionId) {
      replacementConflict(`Conversion source ${sourceCoordinate} has conflicting composition targets`);
    }
    if (previousTarget !== undefined) replacementConflict(`Conversion source ${sourceCoordinate} appears more than once in the migration plan`);
    conversionSources.set(sourceCoordinate, conversion.toCompositionId);
    replacementTargets.set(sourceCoordinate, { kind: "composition", id: conversion.toCompositionId, designSystem: conversion.from.designSystem });
    validateLiveTarget(conversion.from, "conversion");
    const target: ArtifactKey = { kind: "composition", id: conversion.toCompositionId, designSystem: conversion.from.designSystem };
    validateLiveTarget(target, "conversion");
    if (sameArtifact(conversion.from, target)) replacementConflict(`Conversion source ${sourceCoordinate} cannot target itself`);
    const existingTargetReplacement = existingReplacement(db, target);
    if (existingTargetReplacement) replacementConflict(`Conversion target ${artifactCoordinate(target)} already has replacement ${existingTargetReplacement.toKind}:${existingTargetReplacement.toDesignSystem}:${existingTargetReplacement.toId}`);
    const existing = existingReplacement(db, conversion.from);
    if (existing) replacementConflict(`Artifact ${sourceCoordinate} already has replacement ${existing.toKind}:${existing.toDesignSystem}:${existing.toId}`);
    if (canonicalKeys.has(artifactCoordinate(conversion.from))) replacementConflict(`Conversion source ${sourceCoordinate} is a canonical target in this migration`);
    if (replacementTargets.has(artifactCoordinate(target)) && artifactCoordinate(target) !== sourceCoordinate) {
      replacementConflict(`Conversion target ${artifactCoordinate(target)} is also retired by this migration`);
    }
  }
}

export interface PreparedMigration {
  runId: string;
  planHash: string;
  status: "prepared" | "applied";
}

export interface CatalogBackup {
  id: string;
  sha256: string;
  bytes: number;
  path?: string;
  /** The serialized SQLite image is retained for an in-process rollback/test harness. */
  image: Buffer;
  createdAt: string;
}

const inProcessBackups = new Map<string, CatalogBackup>();

/**
 * Take a consistent SQLite image before the cutover transaction. Bun's sqlite serializer uses
 * SQLite's serialize API, so this is a complete database image (including schema and blobs), not
 * a best-effort row dump. A path is optional for local/production retention; the image is always
 * retained in the process cache until the caller's retention policy evicts it.
 */
export function createCatalogBackup(db: Database, id = `catalog-backup-${crypto.randomUUID()}`, path?: string): CatalogBackup {
  const image = db.serialize("main");
  const sha256 = new Bun.CryptoHasher("sha256").update(image).digest("hex");
  const createdAt = new Date().toISOString();
  if (path !== undefined) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, image);
    // Sidecar metadata makes the retained image self-describing: a rollback in a
    // *different* process (restart, redeploy) has no in-memory record to trust and
    // must be able to verify the checksum it was given at cutover time.
    writeFileSync(backupSidecarPath(path), `${JSON.stringify({ id, sha256, bytes: image.byteLength, createdAt })}\n`);
  }
  const backup: CatalogBackup = { id, sha256, bytes: image.byteLength, ...(path === undefined ? {} : { path }), image, createdAt };
  inProcessBackups.set(id, backup);
  return backup;
}

const backupSidecarPath = (path: string): string => `${path}.json`;

/**
 * Drops cached images. Production uses it as the retention policy; tests use it to
 * emulate the restarted process that must fall back to the retained image on disk.
 */
export function evictCatalogBackupCache(id?: string): void {
  if (id === undefined) inProcessBackups.clear();
  else inProcessBackups.delete(id);
}

/** Retention layout of cutover backups inside `DATA_DIR`. */
export const catalogBackupPath = (dataDir: string, id: string): string =>
  join(dataDir, "catalog-migrations", `${id}.sqlite`);

/**
 * Resolves a backup by id: the process cache first, then the retained image in
 * `dataDir`. Without the disk fallback a cutover applied before a restart would be
 * irreversible through the API, which §10 of the design forbids.
 */
export function getCatalogBackup(id: string, dataDir?: string): CatalogBackup | null {
  const cached = inProcessBackups.get(id);
  if (cached) return cached;
  if (dataDir === undefined) return null;
  const path = catalogBackupPath(dataDir, id);
  const sidecar = backupSidecarPath(path);
  if (!existsSync(path) || !existsSync(sidecar)) return null;
  let recorded: { id?: unknown; sha256?: unknown; bytes?: unknown; createdAt?: unknown };
  try {
    recorded = JSON.parse(readFileSync(sidecar, "utf8")) as typeof recorded;
  } catch {
    throw new ApiError(409, "migration_backup_corrupt", "Catalog migration backup metadata is unreadable");
  }
  if (recorded.id !== id || typeof recorded.sha256 !== "string") {
    throw new ApiError(409, "migration_backup_corrupt", "Catalog migration backup metadata does not describe this backup");
  }
  const image = readFileSync(path);
  // `sha256` comes from the sidecar written at cutover time, so the checksum
  // comparison in restoreCatalogBackup stays a real integrity check of the image.
  const backup: CatalogBackup = {
    id, sha256: recorded.sha256, bytes: image.byteLength, path, image,
    createdAt: typeof recorded.createdAt === "string" ? recorded.createdAt : new Date(0).toISOString(),
  };
  inProcessBackups.set(id, backup);
  return backup;
}

/** Mark a committed run as rolled back after an external backup restore. */
export function markMigrationRolledBack(db: Database, runId: string, reason = "catalog migration rolled back"): void {
  db.transaction(() => {
    db.query("UPDATE catalog_migration_staging SET status='aborted' WHERE run_id=? AND status<>'aborted'").run(runId);
    db.query("UPDATE catalog_migration_runs SET status='rolled_back',completed_at=?,reason=? WHERE id=? AND status IN ('prepared','applying','applied')")
      .run(new Date().toISOString(), reason, runId);
  })();
}

export interface RestoreCatalogBackupOptions {
  actorId?: string;
  reason?: string;
  /** Where retained cutover images live when the process cache no longer has them. */
  dataDir?: string;
}

export interface RestoredCatalogBackup {
  runId: string;
  backupId: string;
  backupSha256: string;
  bytes: number;
  status: "rolled_back";
}

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

function databaseTables(db: Database): string[] {
  return (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((row) => row.name);
}

function tableColumns(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as { name: string }[]).map((row) => row.name);
}

// These tables are append-only operational history. A rollback restores the catalog image
// while retaining the evidence that led to and recorded the rollback itself.
const appendOnlyRestoreTables = new Set(["audit_events", "catalog_reuse_decisions"]);

/** Copy a serialized SQLite image into the live connection without changing its schema. */
function restoreDatabaseImage(db: Database, image: Buffer, lock: MaintenanceLock, afterRestore: () => void): void {
  const source = Database.deserialize(image, { readonly: true, strict: true });
  try {
    const sourceTables = databaseTables(source);
    const targetTables = databaseTables(db);
    if (canonicalStringify(sourceTables) !== canonicalStringify(targetTables)) {
      throw new ApiError(409, "migration_backup_incompatible", "Catalog backup schema does not match the live database");
    }
    const tableData = sourceTables.filter((table) => !appendOnlyRestoreTables.has(table)).map((table) => {
      const columns = tableColumns(source, table);
      if (canonicalStringify(columns) !== canonicalStringify(tableColumns(db, table))) {
        throw new ApiError(409, "migration_backup_incompatible", `Catalog backup table schema does not match: ${table}`);
      }
      const rows = source.query(`SELECT ${columns.map(quoteIdentifier).join(",")} FROM ${quoteIdentifier(table)}`).all() as Record<string, unknown>[];
      return { table, columns, rows };
    });
    const foreignKeys = (db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys === 1;
    if (foreignKeys) db.exec("PRAGMA foreign_keys=OFF");
    try {
      db.transaction(() => {
        assertMaintenanceLockOwner(db, lock);
        for (const { table } of tableData) db.query(`DELETE FROM ${quoteIdentifier(table)}`).run();
        for (const { table, columns, rows } of tableData) {
          const insert = db.query(`INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
          for (const row of rows) {
            const values = columns.map((column) => row[column]) as SQLQueryBindings[];
            insert.run(...values);
          }
        }
        // The pre-cutover image normally has no lock. Keep the restore inside
        // the same protected window until rollback metadata is committed.
        db.query("DELETE FROM maintenance_locks WHERE id=1").run();
        db.query("INSERT INTO maintenance_locks (id,run_id,reason,acquired_at) VALUES (1,?,?,?)")
          .run(lock.runId, lock.reason, lock.acquiredAt);
        const violations = db.query("PRAGMA foreign_key_check").all();
        if (violations.length) throw new Error(`Catalog backup restore left foreign-key violations: ${JSON.stringify(violations)}`);
        afterRestore();
      }).immediate();
    } finally {
      if (foreignKeys) db.exec("PRAGMA foreign_keys=ON");
    }
  } finally {
    source.close();
  }
}

/** Restore a cutover backup and record the terminal rollback state in the restored ledger. */
export function restoreCatalogBackup(
  db: Database,
  runId: string,
  backup: string | CatalogBackup,
  options: RestoreCatalogBackupOptions = {},
): RestoredCatalogBackup {
  const resolved = typeof backup === "string" ? getCatalogBackup(backup, options.dataDir) : backup;
  if (!resolved) throw new ApiError(404, "migration_backup_not_found", "Catalog migration backup is not available in this process or its retention directory");
  const actualSha256 = new Bun.CryptoHasher("sha256").update(resolved.image).digest("hex");
  if (actualSha256 !== resolved.sha256) throw new ApiError(409, "migration_backup_corrupt", "Catalog migration backup checksum does not match");
  const run = db.query("SELECT backup_id backupId,status FROM catalog_migration_runs WHERE id=?").get(runId) as { backupId: string | null; status: string } | null;
  if (!run || run.backupId !== resolved.id) throw new ApiError(409, "migration_backup_mismatch", "Backup does not belong to this migration run");
  if (run.status !== "applied") throw new ApiError(409, "migration_run_not_rollbackable", `Migration run is ${run.status}`);

  const lock = acquireMaintenanceLock(db, runId, "catalog migration rollback");
  try {
    assertMaintenanceLockOwner(db, lock);
    const current = db.query("SELECT backup_id backupId,status FROM catalog_migration_runs WHERE id=?").get(runId) as { backupId: string | null; status: string } | null;
    if (!current || current.backupId !== resolved.id || current.status !== "applied") {
      throw new ApiError(409, "migration_run_not_rollbackable", "Migration run changed before rollback");
    }
    // The image copy and the ledger transition share one transaction;
    // a failed restore therefore cannot expose a half-restored catalog.
    restoreDatabaseImage(db, resolved.image, lock, () => {
      const at = new Date().toISOString();
      db.query("UPDATE catalog_migration_staging SET status='aborted' WHERE run_id=? AND status<>'aborted'").run(runId);
      const updated = db.query("UPDATE catalog_migration_runs SET status='rolled_back',completed_at=?,reason=? WHERE id=? AND status='prepared'")
        .run(at, options.reason?.trim() || "catalog migration rolled back", runId);
      if (updated.changes !== 1) throw new ApiError(409, "migration_run_not_rollbackable", "Restored migration ledger is not rollbackable");
      writeAuditEvent(db, {
        actorId: options.actorId ?? "system",
        action: "catalog.migration.rolled_back",
        subjectType: "catalog_migration",
        subjectId: runId,
        detail: { backupId: resolved.id, backupSha256: resolved.sha256, backupBytes: resolved.bytes },
      });
    });
    return { runId, backupId: resolved.id, backupSha256: resolved.sha256, bytes: resolved.bytes, status: "rolled_back" };
  } finally {
    releaseMaintenanceLock(db, runId, lock.acquiredAt);
  }
}

const stagingRows = (plan: CatalogMigrationPlan): Array<{ kind: string; artifactId: string; designSystem: string; payload: unknown }> => {
  const rows: Array<{ kind: string; artifactId: string; designSystem: string; payload: unknown }> = [];
  const seen = new Set<string>();
  const add = (row: { kind: string; artifactId: string; designSystem: string; payload: unknown }): void => {
    const key = `${row.kind}\0${row.artifactId}\0${row.designSystem}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(row);
  };
  for (const group of plan.groups) {
    add({ kind: group.canonical.kind, artifactId: group.canonical.id, designSystem: group.canonical.designSystem, payload: group });
    for (const retired of group.retired) add({ kind: retired.kind, artifactId: retired.id, designSystem: retired.designSystem, payload: group });
    for (const prototypeId of group.affectedPrototypeHeads) add({ kind: "prototype", artifactId: prototypeId, designSystem: group.canonical.designSystem, payload: group });
    for (const compositionId of group.affectedCompositionHeads) add({ kind: "composition", artifactId: compositionId, designSystem: group.canonical.designSystem, payload: group });
  }
  for (const conversion of plan.compositionConversions) {
    add({ kind: conversion.from.kind, artifactId: conversion.from.id, designSystem: conversion.from.designSystem, payload: conversion });
    add({ kind: "composition", artifactId: conversion.toCompositionId, designSystem: conversion.from.designSystem, payload: conversion });
  }
  for (const revision of plan.metadataRevisions) {
    add({ kind: revision.artifact.kind, artifactId: revision.artifact.id, designSystem: revision.artifact.designSystem, payload: revision });
  }
  return rows;
};

export function prepareMigration(db: Database, input: CatalogMigrationPlan, runId = `migration_${crypto.randomUUID()}`): PreparedMigration {
  const plan = normalizeCatalogMigrationPlan(input);
  validateMigrationPlan(db, plan);
  assertMigrationPlanFresh(db, plan);
  const planHash = hashCatalogMigrationPlan(plan);
  return db.transaction(() => {
    const existing = db.query("SELECT id,status FROM catalog_migration_runs WHERE plan_hash=?").get(planHash) as { id: string; status: string } | null;
    if (existing) {
      if (existing.status === "applied") return { runId: existing.id, planHash, status: "applied" as const };
      if (existing.status === "prepared") return { runId: existing.id, planHash, status: "prepared" as const };
      throw new ApiError(409, "migration_run_not_reusable", `Migration run is ${existing.status}`);
    }
    const at = new Date().toISOString();
    db.query(`INSERT INTO catalog_migration_runs (id,plan_hash,catalog_revision,data_fingerprint,status,generated_at)
      VALUES (?,?,?,?, 'prepared',?)`).run(runId, planHash, plan.catalogRevision, plan.dataFingerprint, plan.generatedAt || at);
    const insert = db.query(`INSERT INTO catalog_migration_staging
      (run_id,kind,artifact_id,design_system,payload_json,status,created_at)
      VALUES (?,?,?,?,?,'staged',?)`);
    for (const row of stagingRows(plan)) insert.run(runId, row.kind, row.artifactId, row.designSystem, canonicalStringify(row.payload), at);
    return { runId, planHash, status: "prepared" as const };
  })();
}

function currentPrototypeUsage(db: Database, kind: ArtifactKind, id: string): number {
  if (kind === "component") {
    const direct = db.query(`SELECT COUNT(*) n FROM prototype_revision_components prc
      JOIN prototypes p ON p.id=prc.prototype_id AND p.head_rev=prc.rev WHERE prc.component_id=?`).get(id) as { n: number };
    return direct.n;
  }
  const direct = db.query(`SELECT COUNT(*) n FROM prototype_revision_compositions prc
    JOIN prototypes p ON p.id=prc.prototype_id AND p.head_rev=prc.rev WHERE prc.composition_id=?`).get(id) as { n: number };
  return direct.n;
}

type UsageManifest = {
  version: 1;
  root: { id: string; version: number };
  compositions: Array<{ id: string; name: string; version: number; sourceHash: string }>;
  components: Array<{ id: string; name: string; version: number; bundleHash: string }>;
  hash: string;
};

function parseUsageManifest(value: string | null, hash: string | null): UsageManifest | null | "corrupt" {
  // [] and NULL are the deliberately supported v1/legacy representation.
  if (value === null || value === "[]") return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.version !== 1 || typeof parsed.hash !== "string" || parsed.hash !== hash) return "corrupt";
    const root = parsed.root as Record<string, unknown> | undefined;
    const compositions = parsed.compositions;
    const components = parsed.components;
    const validPin = (pin: unknown, field: "sourceHash" | "bundleHash"): boolean => {
      if (!pin || typeof pin !== "object" || Array.isArray(pin)) return false;
      const row = pin as Record<string, unknown>;
      return typeof row.id === "string" && typeof row.name === "string" && typeof row.version === "number" && typeof row[field] === "string";
    };
    if (!root || typeof root.id !== "string" || typeof root.version !== "number"
      || !Array.isArray(compositions) || !compositions.every((pin) => validPin(pin, "sourceHash"))
      || !Array.isArray(components) || !components.every((pin) => validPin(pin, "bundleHash"))) return "corrupt";
    const withoutHash = {
      version: 1 as const,
      root: { id: root.id, version: root.version },
      compositions: compositions as UsageManifest["compositions"],
      components: components as UsageManifest["components"],
    };
    if (compositionDependencyManifestHash(withoutHash) !== parsed.hash) return "corrupt";
    return { ...withoutHash, hash: parsed.hash };
  } catch {
    return "corrupt";
  }
}

function activeCompositionUses(db: Database, kind: ArtifactKind, id: string): number {
  const rows = db.query(`SELECT p.dependency_manifest_json manifest,p.dependency_manifest_hash manifestHash,r.doc,r.composition_id compositionId,r.rev
    FROM composition_publishes p
    JOIN composition_revisions r ON r.composition_id=p.composition_id AND r.rev=p.rev
    WHERE p.status='active'`).all() as { manifest: string | null; manifestHash: string | null; doc: string; compositionId: string; rev: number }[];
  const component = kind === "component" ? db.query("SELECT name,design_system designSystem FROM components WHERE id=?").get(id) as { name: string; designSystem: string } | null : null;
  let count = 0;
  for (const row of rows) {
    const manifest = parseUsageManifest(row.manifest, row.manifestHash);
    // A malformed non-legacy manifest is an unknown dependency closure. It is
    // never safe to interpret that unknown as zero usage before a tombstone.
    if (manifest === "corrupt") { count += 1; continue; }
    if (kind === "component") {
      if (manifest?.components.some((pin) => pin.id === id)) { count += 1; continue; }
      if (!component) continue;
      try {
        const document = JSON.parse(row.doc) as { spec?: { elements?: Record<string, { type?: unknown }> } };
        const elements = document.spec?.elements;
        if (!elements || typeof elements !== "object" || Object.values(elements).some((element) => !element || typeof element !== "object")) {
          count += 1;
          continue;
        }
        if (Object.values(elements).some((element) => element.type === component.name)) count += 1;
      } catch {
        // A legacy/corrupt authored document can still contain the retired
        // type. Conservatively retain the artifact until it is repaired.
        count += 1;
      }
    } else {
      if (manifest?.compositions.some((pin) => pin.id === id)) { count += 1; continue; }
      try {
        const document = JSON.parse(row.doc) as { spec?: { elements?: Record<string, { type?: unknown; props?: { composition?: unknown } }> } };
        const elements = document.spec?.elements;
        if (!elements || typeof elements !== "object" || Object.values(elements).some((element) => !element || typeof element !== "object")) {
          count += 1;
          continue;
        }
        if (Object.values(elements).some((element) => element.type === COMPOSITION_TYPE && element.props?.composition === id)) count += 1;
      } catch {
        count += 1;
      }
    }
  }
  return count;
}

function markRetired(db: Database, retired: ArtifactKey, target: ArtifactKey, runId: string, reason: string, at: string): void {
  const detail = `${reason || "Catalog migration"} (run ${runId})`;
  if (retired.kind === "component") {
    db.query(`UPDATE component_publishes SET status='deprecated',status_reason=?,status_rev=status_rev+1
      WHERE component_id=? AND status='active' AND EXISTS (
        SELECT 1 FROM component_revisions r WHERE r.component_id=component_publishes.component_id
          AND r.rev=component_publishes.rev AND r.design_system=?)`).run(detail, retired.id, retired.designSystem);
    const usage = currentPrototypeUsage(db, "component", retired.id) + activeCompositionUses(db, "component", retired.id);
    if (usage === 0) {
      db.query(`UPDATE components SET deleted_at=?,delete_reason=?,replacement_component_id=?,updated_at=?
        WHERE id=? AND design_system=? AND deleted_at IS NULL`).run(at, detail, target.kind === "component" ? target.id : null, at, retired.id, retired.designSystem);
    }
  } else {
    db.query(`UPDATE composition_publishes SET status='deprecated',status_reason=?,status_rev=status_rev+1
      WHERE composition_id=? AND status='active' AND EXISTS (
        SELECT 1 FROM composition_revisions r WHERE r.composition_id=composition_publishes.composition_id
          AND r.rev=composition_publishes.rev AND r.design_system=?)`).run(detail, retired.id, retired.designSystem);
    const usage = currentPrototypeUsage(db, "composition", retired.id) + activeCompositionUses(db, "composition", retired.id);
    if (usage === 0) db.query(`UPDATE compositions SET deleted_at=?,delete_reason=?,updated_at=? WHERE id=? AND design_system=? AND deleted_at IS NULL`).run(at, detail, at, retired.id, retired.designSystem);
  }
}

const replacementMapFor = (plan: CatalogMigrationPlan, kind: ArtifactKind): Map<string, ArtifactKey> => {
  const map = new Map<string, ArtifactKey>();
  for (const group of plan.groups) {
    for (const retired of group.retired) if (retired.kind === kind) map.set(`${retired.designSystem}\0${retired.id}`, group.canonical);
  }
  return map;
};

function artifactName(db: Database, key: ArtifactKey): string | null {
  const table = key.kind === "component" ? "components" : "compositions";
  const row = db.query(`SELECT name FROM ${table} WHERE id=?`).get(key.id) as { name: string } | null;
  return row?.name ?? null;
}

/** Add the obvious id→name mapping when a plan only carries artifact identities. */
function adapterWithCatalogNames(db: Database, group: CatalogMigrationGroup): MigrationAdapter {
  const typeMap: Record<string, string> = { ...group.adapter.typeMap };
  if (group.canonical.kind === "component") {
    const canonicalName = artifactName(db, group.canonical);
    if (canonicalName !== null) {
      for (const retired of group.retired) {
        if (retired.kind !== "component") continue;
        const retiredName = artifactName(db, retired);
        if (retiredName !== null && typeMap[retiredName] === undefined) typeMap[retiredName] = canonicalName;
      }
    }
  }
  return { ...group.adapter, typeMap };
}

function adapterWithConversionName(db: Database, conversion: CompositionConversion): MigrationAdapter {
  const typeMap: Record<string, string> = { ...conversion.adapter.typeMap, [conversion.from.id]: COMPOSITION_TYPE };
  if (conversion.from.kind === "component") {
    const name = artifactName(db, conversion.from);
    if (name !== null) typeMap[name] = COMPOSITION_TYPE;
  }
  return {
    ...conversion.adapter,
    typeMap,
    composition: { ...(conversion.adapter.composition ?? {}), id: conversion.toCompositionId },
  };
}

function replaceCompositionReferences<T extends PrototypeDoc | CompositionDoc>(db: Database, document: T, plan: CatalogMigrationPlan): T {
  const replacements = replacementMapFor(plan, "composition");
  for (const conversion of plan.compositionConversions) {
    if (conversion.from.kind === "composition") {
      replacements.set(`${conversion.from.designSystem}\0${conversion.from.id}`, {
        kind: "composition",
        id: conversion.toCompositionId,
        designSystem: conversion.from.designSystem,
      });
    }
  }
  if (replacements.size === 0) return document;
  const output = structuredClone(document);
  for (const screen of "screens" in output ? output.screens : [output as unknown as { spec: { elements: Record<string, { type: string; props: Record<string, unknown> }> } }]) {
    const elements = screen.spec.elements;
    for (const element of Object.values(elements)) {
      if (element.type !== COMPOSITION_TYPE || typeof element.props.composition !== "string") continue;
      const designSystem = "designSystem" in output ? output.designSystem : undefined;
      const target = replacements.get(`${designSystem ?? ""}\0${element.props.composition}`)
        ?? [...replacements.entries()].find(([key]) => key.endsWith(`\0${element.props.composition}`))?.[1];
      if (target !== undefined) element.props.composition = target.id;
    }
  }
  return output;
}

function transformPrototype(db: Database, document: PrototypeDoc, plan: CatalogMigrationPlan): PrototypeDoc {
  let output = structuredClone(document);
  for (const group of plan.groups) {
    const result = applyDeclarativeMigrationAdapter(output, adapterWithCatalogNames(db, group));
    if (!result.ok) throw new ApiError(422, "migration_adapter_refused", "A migration adapter refused a populated authored value", { issues: result.refusals.map((refusal) => ({ path: refusal.path, message: `${refusal.code}: ${refusal.message}` })) });
    output = result.value as PrototypeDoc;
  }
  for (const conversion of plan.compositionConversions) {
    const result = applyDeclarativeMigrationAdapter(output, adapterWithConversionName(db, conversion));
    if (!result.ok) throw new ApiError(422, "migration_adapter_refused", "A composition conversion adapter refused an authored value", { issues: result.refusals.map((refusal) => ({ path: refusal.path, message: `${refusal.code}: ${refusal.message}` })) });
    output = result.value as PrototypeDoc;
  }
  return validateMigratedPrototype(replaceCompositionReferences(db, output, plan));
}

function transformComposition(db: Database, document: CompositionDoc, plan: CatalogMigrationPlan): CompositionDoc {
  let output = structuredClone(document);
  for (const group of plan.groups) {
    const result = applyDeclarativeMigrationAdapter(output as never, adapterWithCatalogNames(db, group));
    if (!result.ok) throw new ApiError(422, "migration_adapter_refused", "A migration adapter refused a populated composition value", { issues: result.refusals.map((refusal) => ({ path: refusal.path, message: `${refusal.code}: ${refusal.message}` })) });
    output = result.value as unknown as CompositionDoc;
  }
  for (const conversion of plan.compositionConversions) {
    const result = applyDeclarativeMigrationAdapter(output as never, adapterWithConversionName(db, conversion));
    if (!result.ok) throw new ApiError(422, "migration_adapter_refused", "A composition conversion adapter refused a populated authored value", { issues: result.refusals.map((refusal) => ({ path: refusal.path, message: `${refusal.code}: ${refusal.message}` })) });
    output = result.value as unknown as CompositionDoc;
  }
  return compositionDocSchema.parse(replaceCompositionReferences(db, output, plan));
}

type MigrationPins = {
  components: Array<{ id: string; version: number }>;
  compositions: Array<{ id: string; version: number }>;
};

/** Resolve all pins afresh so a migrated head never carries the retired publication. */
function pinsForPrototype(db: Database, document: PrototypeDoc): MigrationPins {
  const compositions = collectCompositionRefs(document).map((ref) => ref.compositionId);
  const resolved = resolveCompositionPins(db, compositions, document.designSystem);
  if (resolved.missing.length) throw new ApiError(422, "validation_failed", "Migrated prototype references an unavailable composition", { issues: resolved.missing.map((entry) => ({ path: ["screens"], message: entry.reason })) });
  const componentPins = new Map<string, { id: string; version: number }>(resolved.componentPins.map((pin) => [pin.id, { id: pin.id, version: pin.version }]));
  const builtin = requireActiveDesignSystem(db, document.designSystem, ["designSystem"]).definitions;
  const types = new Set(document.screens.flatMap((screen) => Object.values(screen.spec.elements).map((element) => element.type)));
  for (const type of types) {
    if (hostPrimitiveNames.has(type) || Object.hasOwn(builtin, type)) continue;
    const row = db.query(`SELECT c.id,cp.version
      FROM components c JOIN component_publishes cp ON cp.component_id=c.id AND cp.status='active'
      JOIN component_revisions cr ON cr.component_id=cp.component_id AND cr.rev=cp.rev
      WHERE c.name=? AND c.deleted_at IS NULL AND cr.design_system=? ORDER BY cp.version DESC LIMIT 1`).get(type, document.designSystem) as { id: string; version: number } | null;
    if (!row) throw new ApiError(422, "validation_failed", `Migrated prototype references an unpublished component: ${type}`, { issues: [{ path: ["screens"], message: `Unknown or unpublished component type in design system '${document.designSystem}': ${type}` }] });
    componentPins.set(row.id, { id: row.id, version: row.version });
  }
  return {
    components: [...componentPins.values()].sort((left, right) => left.id.localeCompare(right.id)),
    compositions: resolved.pins.map((pin) => ({ id: pin.id, version: pin.version })).sort((left, right) => left.id.localeCompare(right.id) || left.version - right.version),
  };
}

function rewritePrototypeHeads(db: Database, plan: CatalogMigrationPlan, runId: string, at: string, changedCompositionIds: ReadonlySet<string>): string[] {
  const retiredComponents = new Set(plan.groups.flatMap((group) => group.retired.filter((key) => key.kind === "component").map((key) => key.id)));
  const retiredCompositions = new Set(plan.groups.flatMap((group) => group.retired.filter((key) => key.kind === "composition").map((key) => key.id)));
  const changed: string[] = [];
  const rows = db.query(`SELECT p.id,p.head_rev,p.design_system,r.doc,r.message,r.author,r.builtin_catalog_hash,r.design_system_meta_version,r.figma_json,r.created_at,
      p.name,p.description,p.device,p.screen_count
    FROM prototypes p JOIN prototype_revisions r ON r.prototype_id=p.id AND r.rev=p.head_rev
    ORDER BY p.id`).all() as Array<{
      id: string; head_rev: number; design_system: string; doc: string; message: string | null; author: string | null;
      builtin_catalog_hash: string; design_system_meta_version: number | null; figma_json: string | null; created_at: string;
      name: string; description: string | null; device: string; screen_count: number;
    }>;
  for (const row of rows) {
    const document = validateMigratedPrototype(JSON.parse(row.doc));
    const oldComponentIds = new Set((db.query("SELECT component_id id FROM prototype_revision_components WHERE prototype_id=? AND rev=?").all(row.id, row.head_rev) as { id: string }[]).map((pin) => pin.id));
    const oldCompositionIds = new Set((db.query("SELECT composition_id id FROM prototype_revision_compositions WHERE prototype_id=? AND rev=?").all(row.id, row.head_rev) as { id: string }[]).map((pin) => pin.id));
    const transformed = transformPrototype(db, document, plan);
    const needsRepin = [...oldComponentIds].some((id) => retiredComponents.has(id))
      || [...oldCompositionIds].some((id) => retiredCompositions.has(id) || changedCompositionIds.has(id));
    if (canonicalStringify(document) === canonicalStringify(transformed) && !needsRepin) continue;
    if (canonicalStringify(document) === canonicalStringify(transformed) && needsRepin && oldCompositionIds.size === 0 && oldComponentIds.size === 0) continue;
    const pins = pinsForPrototype(db, transformed);
    const nextRev = row.head_rev + 1;
    const message = `${row.message ? `${row.message}; ` : ""}Catalog migration ${runId}`;
    db.query(`INSERT INTO prototype_revisions
      (prototype_id,rev,doc,builtin_catalog_hash,design_system_meta_version,figma_json,message,author,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(row.id, nextRev, JSON.stringify(transformed), row.builtin_catalog_hash, row.design_system_meta_version, row.figma_json, message, row.author, at);
    for (const pin of pins.components) db.query("INSERT INTO prototype_revision_components (prototype_id,rev,component_id,component_version) VALUES (?,?,?,?)").run(row.id, nextRev, pin.id, pin.version);
    for (const pin of pins.compositions) db.query("INSERT INTO prototype_revision_compositions (prototype_id,rev,composition_id,composition_version) VALUES (?,?,?,?)").run(row.id, nextRev, pin.id, pin.version);
    db.query("INSERT INTO prototype_revision_assets (prototype_id,rev,asset_id) SELECT prototype_id,?,asset_id FROM prototype_revision_assets WHERE prototype_id=? AND rev=?").run(nextRev, row.id, row.head_rev);
    db.query(`UPDATE prototypes SET name=?,description=?,device=?,screen_count=?,head_rev=?,design_system=?,updated_at=? WHERE id=?`)
      .run(transformed.name, transformed.description ?? null, transformed.device, transformed.screens.length, nextRev, transformed.designSystem, at, row.id);
    const sourcePublish = db.query("SELECT version FROM prototype_publishes WHERE prototype_id=? AND rev=?").get(row.id, row.head_rev) as { version: number } | null;
    if (sourcePublish) {
      const latest = db.query("SELECT MAX(version) version FROM prototype_publishes WHERE prototype_id=?").get(row.id) as { version: number | null };
      if (sourcePublish.version === latest.version) db.query("INSERT INTO prototype_publishes (prototype_id,version,rev,message,published_at) VALUES (?,?,?,?,?)")
        .run(row.id, (latest.version ?? 0) + 1, nextRev, `Catalog migration ${runId}`, at);
    }
    changed.push(row.id);
  }
  return changed;
}

function rewriteCompositionHeads(db: Database, plan: CatalogMigrationPlan, runId: string, at: string): Set<string> {
  const changedIds = new Set<string>();
  const processed = new Set<string>();
  // A parent may appear before a child in id order. Revisit unprocessed parents after a child
  // closure changes so all current active closures get an exact new dependency manifest.
  for (let pass = 0; pass < COMPOSITION_NESTING_DEPTH_LIMIT; pass += 1) {
    const rows = db.query(`SELECT c.id,c.name,c.head_rev,c.design_system,c.owner_id,r.doc,r.message,r.author,r.created_at
      FROM compositions c JOIN composition_revisions r ON r.composition_id=c.id AND r.rev=c.head_rev
      WHERE c.deleted_at IS NULL ORDER BY c.id`).all() as Array<{ id: string; name: string; head_rev: number; design_system: string; owner_id: string | null; doc: string; message: string | null; author: string | null; created_at: string }>;
    let changedThisPass = false;
    for (const row of rows) {
      if (processed.has(row.id)) continue;
      const document = parseStoredCompositionDoc(row.doc, row.id, row.head_rev);
      const transformed = transformComposition(db, document, plan);
      const nestedIds = new Set(Object.values(transformed.spec.elements).filter((element) => element.type === COMPOSITION_TYPE && typeof element.props.composition === "string").map((element) => element.props.composition as string));
      const closureChanged = [...nestedIds].some((id) => changedIds.has(id));
      if (canonicalStringify(document) === canonicalStringify(transformed) && !closureChanged) continue;
      const nextRev = row.head_rev + 1;
      const message = `${row.message ? `${row.message}; ` : ""}Catalog migration ${runId}`;
      db.query(`INSERT INTO composition_revisions (composition_id,rev,doc,design_system,message,author,created_at) VALUES (?,?,?,?,?,?,?)`)
        .run(row.id, nextRev, JSON.stringify(transformed), row.design_system, message, row.author, at);
      db.query("UPDATE compositions SET name=?,head_rev=?,updated_at=? WHERE id=? AND deleted_at IS NULL").run(transformed.name, nextRev, at, row.id);
      const sourcePublish = db.query("SELECT version FROM composition_publishes WHERE composition_id=? AND rev=?").get(row.id, row.head_rev) as { version: number } | null;
      if (sourcePublish) {
        const latest = db.query("SELECT MAX(version) version FROM composition_publishes WHERE composition_id=?").get(row.id) as { version: number | null };
        if (sourcePublish.version === latest.version) {
          const version = (latest.version ?? 0) + 1;
          const closure = buildCompositionDependencyManifest(db, { id: row.id, name: transformed.name, designSystem: row.design_system, version, sourceHash: compositionSourceHash(transformed), doc: transformed }, row.design_system);
          db.query(`INSERT INTO composition_publishes
            (composition_id,version,rev,status,source_hash,dependency_manifest_json,dependency_manifest_hash,message,published_at)
            VALUES (?,?,?,'active',?,?,?,?,?)`).run(row.id, version, nextRev, compositionSourceHash(transformed), JSON.stringify(closure.manifest), closure.manifest.hash, `Catalog migration ${runId}`, at);
        }
      }
      changedIds.add(row.id);
      processed.add(row.id);
      changedThisPass = true;
    }
    if (!changedThisPass) break;
  }
  return changedIds;
}

export interface CutoverOptions {
  backupId?: string;
  backupPath?: string;
  actorId?: string;
  /** Hook for the prevalidated Stage A rewrite; it runs inside the single cutover transaction. */
  applyHeads?: (db: Database, plan: CatalogMigrationPlan) => void;
}

function abortMigrationRun(db: Database, runId: string, reason: string): void {
  try {
    db.transaction(() => {
      db.query("UPDATE catalog_migration_staging SET status='aborted' WHERE run_id=? AND status<>'aborted'").run(runId);
      db.query("UPDATE catalog_migration_runs SET status='aborted',completed_at=?,reason=? WHERE id=? AND status IN ('prepared','applying')")
        .run(new Date().toISOString(), reason, runId);
    })();
  } catch {
    // Preserve the original cutover error. The failed transaction itself is
    // already rolled back; a later operator can see the lock/run state.
  }
}

/**
 * Performs the protected Stage B bookkeeping atomically. Resource-specific bundle uploads and
 * validation belong to Stage A and are represented by `applyHeads`; any failure rolls back all
 * head/status/replacement writes and leaves only an aborted run record.
 */
export function applyMigration(db: Database, input: CatalogMigrationPlan, runId: string, options: CutoverOptions = {}): void {
  const plan = normalizeCatalogMigrationPlan(input);
  const planHash = hashCatalogMigrationPlan(plan);
  const existingRun = db.query("SELECT plan_hash,status FROM catalog_migration_runs WHERE id=?").get(runId) as { plan_hash: string; status: string } | null;
  // A committed run is idempotent even if the catalog has since moved on. The caller must
  // still present the same content-addressed plan, but a retry must not be turned into a
  // misleading stale-plan error after the very cutover it is retrying.
  if (existingRun?.status === "applied") {
    if (existingRun.plan_hash !== planHash) throw new ApiError(409, "migration_plan_mismatch", "Migration run does not own this plan");
    return;
  }
  if (!existingRun || existingRun.plan_hash !== planHash) throw new ApiError(409, "migration_plan_mismatch", "Migration run does not own this plan");
  if (existingRun.status !== "prepared") throw new ApiError(409, "migration_run_not_prepared", `Migration run is ${existingRun.status}`);
  const lock = acquireMaintenanceLock(db, runId, "catalog migration cutover");
  try {
    // Re-read after taking the lock: another caller may have completed the run
    // between the initial idempotency read and lock acquisition.
    const lockedRun = db.query("SELECT plan_hash,status FROM catalog_migration_runs WHERE id=?").get(runId) as { plan_hash: string; status: string } | null;
    if (!lockedRun || lockedRun.plan_hash !== planHash) throw new ApiError(409, "migration_plan_mismatch", "Migration run does not own this plan");
    if (lockedRun.status === "applied") return;
    if (lockedRun.status !== "prepared") throw new ApiError(409, "migration_run_not_prepared", `Migration run is ${lockedRun.status}`);
    validateMigrationPlan(db, plan);
    assertMigrationPlanFresh(db, plan);
    const backupId = options.backupId ?? `sqlite-cutover-${runId}`;
    const backup = createCatalogBackup(db, backupId, options.backupPath);
    db.transaction(() => {
      assertMaintenanceLockOwner(db, lock);
      const row = db.query("SELECT plan_hash,status FROM catalog_migration_runs WHERE id=?").get(runId) as { plan_hash: string; status: string } | null;
      if (!row || row.plan_hash !== planHash) throw new ApiError(409, "migration_plan_mismatch", "Migration run does not own this plan");
      if (row.status === "applied") return;
      if (row.status !== "prepared") throw new ApiError(409, "migration_run_not_prepared", `Migration run is ${row.status}`);
      assertMigrationPlanFresh(db, plan);
      const at = new Date().toISOString();
      const applying = db.query("UPDATE catalog_migration_runs SET status='applying',started_at=?,backup_id=? WHERE id=? AND plan_hash=? AND status='prepared'")
        .run(at, backup.id, runId, planHash);
      if (applying.changes !== 1) throw new ApiError(409, "migration_run_conflict", "Migration run changed during cutover");
      if (options.applyHeads) options.applyHeads(db, plan);
      else {
        const changedCompositions = rewriteCompositionHeads(db, plan, runId, at);
        rewritePrototypeHeads(db, plan, runId, at, changedCompositions);
      }
      assertMaintenanceLockOwner(db, lock);
      for (const group of plan.groups) {
        for (const retired of group.retired) {
          db.query(`INSERT INTO catalog_replacements
            (from_kind,from_id,from_design_system,to_kind,to_id,to_design_system,migration_run_id,reason,created_at)
            VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT(from_kind,from_id,from_design_system) DO UPDATE SET
              to_kind=excluded.to_kind,to_id=excluded.to_id,to_design_system=excluded.to_design_system,
              migration_run_id=excluded.migration_run_id,reason=excluded.reason,created_at=excluded.created_at`)
            .run(retired.kind, retired.id, retired.designSystem, group.canonical.kind, group.canonical.id,
              group.canonical.designSystem, runId, group.reasons.join("; ") || "catalog migration", at);
          markRetired(db, retired, group.canonical, runId, group.reasons.join("; "), at);
        }
      }
      for (const conversion of plan.compositionConversions) {
        const target: ArtifactKey = { kind: "composition", id: conversion.toCompositionId, designSystem: conversion.from.designSystem };
        const reason = `component-to-composition conversion to ${target.id}`;
        db.query(`INSERT INTO catalog_replacements
          (from_kind,from_id,from_design_system,to_kind,to_id,to_design_system,migration_run_id,reason,created_at)
          VALUES (?,?,?,?,?,?,?,?,?)
          ON CONFLICT(from_kind,from_id,from_design_system) DO UPDATE SET
            to_kind=excluded.to_kind,to_id=excluded.to_id,to_design_system=excluded.to_design_system,
            migration_run_id=excluded.migration_run_id,reason=excluded.reason,created_at=excluded.created_at`)
          .run(conversion.from.kind, conversion.from.id, conversion.from.designSystem, target.kind, target.id,
            target.designSystem, runId, reason, at);
        markRetired(db, conversion.from, target, runId, reason, at);
      }
      db.query("UPDATE catalog_migration_staging SET status='activated' WHERE run_id=? AND status='staged'").run(runId);
      assertMaintenanceLockOwner(db, lock);
      const applied = db.query("UPDATE catalog_migration_runs SET status='applied',completed_at=? WHERE id=? AND plan_hash=? AND status='applying'")
        .run(new Date().toISOString(), runId, planHash);
      if (applied.changes !== 1) throw new ApiError(409, "migration_run_conflict", "Migration run changed during cutover");
      writeAuditEvent(db, { actorId: options.actorId ?? "system", action: "catalog.migration.applied", subjectType: "catalog_migration", subjectId: runId, detail: { planHash, groups: plan.groups.length, backupId: backup.id, backupSha256: backup.sha256, backupBytes: backup.bytes } });
    }).immediate();
  } catch (error) {
    abortMigrationRun(db, runId, error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    releaseMaintenanceLock(db, runId, lock.acquiredAt);
  }
}

/** Schema validation seam used before a migrated authored document is staged or activated. */
export function validateMigratedPrototype(doc: unknown): PrototypeDoc {
  const parsed = inputPrototypeDocSchema.safeParse(doc);
  if (!parsed.success) throw new ApiError(422, "validation_failed", "Migrated prototype document is invalid", { issues: parsed.error.issues });
  return parsed.data as PrototypeDoc;
}
