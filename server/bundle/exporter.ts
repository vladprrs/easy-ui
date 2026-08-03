import type { Database } from "bun:sqlite";
import { strToU8, zipSync, type Zippable } from "fflate";
import type {
  BundleAsset,
  BundleComponent,
  BundleComposition,
  BundleDesignSystem,
  BundleKind,
  BundleManifest,
  BundlePrototype,
} from "../../src/bundle/schema";
import {
  BUNDLE_FORMAT_VERSION_COMPOSITIONS, BUNDLE_FORMAT_VERSION_LEGACY, bundleManifestSchema,
} from "../../src/bundle/schema";
import type { PrototypeDoc } from "../../src/prototype/schema";
import { RENDER_CONTRACT_VERSION, builtinCatalogHash } from "../builtinHash";
import { getDesignSystemVersion, getIncludingRetired, latestDesignSystemMetaVersion } from "../designSystems";
import { sha256 } from "../components/pipeline";
import { ApiError } from "../http";
import { ComponentRepo } from "../repos/components";
import { CompositionRepo, compositionSourceHash } from "../repos/compositions";
import type { CompositionDoc } from "../../src/prototype/composition";
import { assertPinnedTrack, PrototypeRepo } from "../repos/prototypes";
import { AssetRepo } from "../repos/assets";
import { collectAssetIdsFromSource } from "../validation";
import { themeAssetIds } from "../share/repo";

/**
 * Стабильный код отказа экспорта мульти-поверхностного документа (план §4, v1).
 * Импортёр отвергает такой документ тем же кодом: манифест адресует компоненты ключом
 * `${designSystem}::${type}` и не умеет описать вторую ДС.
 */
export const SURFACES_NOT_EXPORTABLE_CODE = "surfaces_not_exportable";
export const surfacesNotExportableError = (id: string): ApiError =>
  new ApiError(422, SURFACES_NOT_EXPORTABLE_CODE, `Prototype '${id}' declares doc.surfaces; the bundle format v1 cannot carry multi-surface documents`);
/** Проверка по головной ревизии/версиям прототипа: `doc.surfaces` в любой из них — отказ. */
function assertExportableSurfaces(db: Database, id: string): void {
  const row = db.query(`SELECT 1 ok FROM prototype_revisions r
    WHERE r.prototype_id=? AND json_type(r.doc,'$.surfaces')='array' LIMIT 1`).get(id);
  if (row) throw surfacesNotExportableError(id);
}

// ZIP bundle exporter (plan T2). Builds the closure of a prototype / component / bulk export
// in memory: manifest.json plus prototype docs, component TSX and content-addressed asset
// bytes. The 512 MiB raw-size ceiling is checked from DB-recorded sizes before any bytes are
// read, so an oversized export fails fast without materializing the archive.

const EXPORT_RAW_LIMIT = 512 * 1024 * 1024;
// Fixed mtime keeps archives stable for identical input (fflate requires a 1980-2099 date).
const FIXED_MTIME = new Date("2020-01-01T00:00:00Z");

export interface PrototypeSelector {
  /** Owner draft when true and no explicit version; otherwise the latest / requested published version. */
  owner: boolean;
  version?: number;
}

export interface ExportedResource {
  selector: "draft" | "version";
  rev: number;
  version: number | null;
}

interface AssetEntry { entry: BundleAsset; sha256: string }

export class BundleClosure {
  private readonly prototypes: BundlePrototype[] = [];
  private readonly components = new Map<string, BundleComponent>();
  private readonly compositions = new Map<string, BundleComposition>();
  private readonly designSystems = new Map<string, BundleDesignSystem>();
  private readonly assets = new Map<string, AssetEntry>();
  private readonly docs = new Map<string, string>();
  private readonly sources = new Map<string, string>();
  private readonly assetRepo: AssetRepo;
  private readonly componentRepo: ComponentRepo;
  private readonly compositionRepo: CompositionRepo;
  private readonly prototypeRepo: PrototypeRepo;
  private rawBytes = 0;

  constructor(private readonly db: Database, dataDir: string) {
    this.assetRepo = new AssetRepo(db, dataDir);
    this.componentRepo = new ComponentRepo(db);
    this.compositionRepo = new CompositionRepo(db);
    this.prototypeRepo = new PrototypeRepo(db);
  }

  private componentName(id: string): string {
    const row = this.db.query("SELECT name FROM components WHERE id=?").get(id) as { name: string } | null;
    return row?.name ?? id;
  }

  private addAsset(assetId: string): void {
    if (this.assets.has(assetId)) return;
    const row = this.assetRepo.get(assetId);
    if (!row) return; // A dangling reference is silently skipped; pins are validated on save.
    this.assets.set(assetId, {
      entry: { id: row.id, sha256: row.sha256, mime: row.mime, size: row.size, originalName: row.original_name },
      sha256: row.sha256,
    });
    this.rawBytes += row.size;
  }

  private addDesignSystem(systemId: string, metaVersion: number | null): void {
    if (this.designSystems.has(systemId)) return;
    const system = getIncludingRetired(this.db, systemId);
    if (!system) return;
    const resolved = metaVersion ?? latestDesignSystemMetaVersion(this.db, systemId);
    const content = resolved === null ? null : getDesignSystemVersion(this.db, systemId, resolved);
    const theme = content === null ? null : { metaVersion: content.version, tokens: content.tokens, fonts: content.fonts, icons: content.icons };
    this.designSystems.set(systemId, {
      id: system.id,
      name: system.name,
      description: system.description,
      builtin: system.builtinProvider !== null,
      theme,
    });
    for (const assetId of themeAssetIds(content)) this.addAsset(assetId);
  }

  private addComponentVersion(id: string, version: number): void {
    if (this.components.has(id)) return;
    const detail = this.componentRepo.version(id, version);
    const assets = detail.assets as { id: string }[];
    const sourcePath = `components/${id}/source.tsx`;
    this.components.set(id, {
      id,
      name: this.componentName(id),
      designSystem: detail.designSystem,
      sourcePath,
      sourceHash: sha256(detail.source),
      exported: { rev: detail.rev, version: detail.version },
      assetIds: assets.map((asset) => asset.id),
    });
    this.sources.set(sourcePath, detail.source);
    this.rawBytes += strToU8(detail.source).byteLength;
    this.addDesignSystem(detail.designSystem, null);
    for (const asset of assets) this.addAsset(asset.id);
  }

  private addComponentDraft(id: string): void {
    if (this.components.has(id)) return;
    const src = this.componentRepo.source(id);
    const sourcePath = `components/${id}/source.tsx`;
    const assetIds = collectAssetIdsFromSource(src.source).filter((assetId) => this.assetRepo.exists(assetId));
    this.components.set(id, {
      id,
      name: this.componentName(id),
      designSystem: src.designSystem,
      sourcePath,
      sourceHash: sha256(src.source),
      exported: { rev: src.rev, version: null },
      assetIds,
    });
    this.sources.set(sourcePath, src.source);
    this.rawBytes += strToU8(src.source).byteLength;
    this.addDesignSystem(src.designSystem, null);
    for (const assetId of assetIds) this.addAsset(assetId);
  }

  /**
   * Adds a component by an explicit version, else its latest active version, else the head draft.
   * Returns the exported revision/version for filename and manifest diagnostics.
   */
  addComponent(id: string, version?: number): { rev: number; version: number | null } {
    if (version !== undefined) this.addComponentVersion(id, version);
    else {
      const latest = this.latestActiveVersion(id);
      if (latest !== null) this.addComponentVersion(id, latest);
      else this.addComponentDraft(id);
    }
    return this.components.get(id)!.exported;
  }

  private latestActiveVersion(id: string): number | null {
    return (this.db.query("SELECT MAX(version) v FROM component_publishes WHERE component_id=? AND status='active'").get(id) as { v: number | null }).v;
  }

  /**
   * Adds one pinned composition version (bundle format 2). The artifact is the frozen
   * document itself — there is nothing to compile. Components and assets used *only*
   * inside a composition need no extra walk here: the prototype's pins are computed
   * from the **expanded** document on save, so they already cover them.
   */
  private addCompositionVersion(id: string, version: number): void {
    if (this.compositions.has(id)) return;
    const detail = this.compositionRepo.version(id, version);
    this.storeComposition(id, detail.designSystem, detail.doc, detail.sourceHash, { rev: detail.rev, version: detail.version });
  }

  private addCompositionDraft(id: string): void {
    if (this.compositions.has(id)) return;
    const row = this.compositionRepo.row(id);
    const head = this.compositionRepo.revision(id);
    this.storeComposition(id, row.design_system, head.doc, compositionSourceHash(head.doc), { rev: head.rev, version: null });
  }

  private storeComposition(id: string, designSystem: string, doc: CompositionDoc, sourceHash: string, exported: { rev: number; version: number | null }): void {
    const docPath = `compositions/${id}.json`;
    const docJson = JSON.stringify(doc);
    this.compositions.set(id, { id, name: doc.name, designSystem, docPath, sourceHash, exported });
    this.docs.set(docPath, docJson);
    this.rawBytes += strToU8(docJson).byteLength;
    this.addDesignSystem(designSystem, null);
  }

  /** Adds a composition by its latest active version, falling back to the head draft. */
  addComposition(id: string, version?: number): { rev: number; version: number | null } {
    if (version !== undefined) this.addCompositionVersion(id, version);
    else {
      const latest = this.latestActiveCompositionVersion(id);
      if (latest !== null) this.addCompositionVersion(id, latest);
      else this.addCompositionDraft(id);
    }
    return this.compositions.get(id)!.exported;
  }

  private latestActiveCompositionVersion(id: string): number | null {
    return (this.db.query("SELECT MAX(version) v FROM composition_publishes WHERE composition_id=? AND status='active'").get(id) as { v: number | null }).v;
  }

  /** Adds a prototype revision (owner draft or a published version) and its full dependency closure. */
  addPrototype(id: string, selector: PrototypeSelector): ExportedResource {
    // Экспорт трекающего дока запрещён (план 2026-08-02, P2.2): манифест пинует версии
    // компонентов, а у track:head они резолвятся на момент чтения — архив был бы снимком
    // «на секунду», необратимо расходящимся с источником при импорте.
    assertPinnedTrack(this.db, id, "bundle-export");
    // Мульти-поверхностный документ не выражается манифестом v1 (скалярные `designSystem`/
    // `designSystemMetaVersion`, ключ импортёра `${designSystem}::${type}`), поэтому экспорт
    // отклоняется стабильным 422 (план §4, R3-B3). Мульти-ДС манифест — v2.
    assertExportableSurfaces(this.db, id);
    let snapshot: { doc: PrototypeDoc; rev: number; components: { id: string; version: number }[]; compositions: { id: string; version: number }[]; assets: { id: string }[]; designSystemMetaVersion: number | null };
    let exported: ExportedResource;
    if (selector.version !== undefined) {
      const version = this.prototypeRepo.version(id, selector.version);
      snapshot = version;
      exported = { selector: "version", rev: version.rev, version: selector.version };
    } else if (selector.owner) {
      const draft = this.prototypeRepo.draft(id);
      snapshot = draft;
      exported = { selector: "draft", rev: draft.rev, version: null };
    } else {
      const latest = this.latestPublishedVersion(id);
      if (latest === null) throw new ApiError(404, "version_not_found", "Prototype has no published version to export");
      const version = this.prototypeRepo.version(id, latest);
      snapshot = version;
      exported = { selector: "version", rev: version.rev, version: latest };
    }
    const doc = snapshot.doc;
    const docPath = `prototypes/${doc.id}.json`;
    const docJson = JSON.stringify(doc);
    this.prototypes.push({
      id: doc.id,
      name: doc.name,
      designSystem: doc.designSystem,
      exported,
      docPath,
      componentPins: snapshot.components.map((pin) => ({ id: pin.id, version: pin.version })),
      compositionPins: snapshot.compositions.map((pin) => ({ id: pin.id, version: pin.version })),
      assetIds: snapshot.assets.map((asset) => asset.id),
      designSystemMetaVersion: snapshot.designSystemMetaVersion,
    });
    this.docs.set(docPath, docJson);
    this.rawBytes += strToU8(docJson).byteLength;
    this.addDesignSystem(doc.designSystem, snapshot.designSystemMetaVersion);
    for (const pin of snapshot.compositions) this.addCompositionVersion(pin.id, pin.version);
    for (const pin of snapshot.components) this.addComponentVersion(pin.id, pin.version);
    for (const asset of snapshot.assets) this.addAsset(asset.id);
    return exported;
  }

  /** Bulk selector: the latest published version, falling back to the head draft only when unpublished. */
  addOwnedPrototype(id: string): ExportedResource {
    const latest = this.latestPublishedVersion(id);
    return this.addPrototype(id, latest === null ? { owner: true } : { owner: false, version: latest });
  }

  private latestPublishedVersion(id: string): number | null {
    return (this.db.query("SELECT MAX(version) v FROM prototype_publishes WHERE prototype_id=?").get(id) as { v: number | null }).v;
  }

  private manifest(kind: BundleKind, origin: string): BundleManifest {
    const manifest: BundleManifest = {
      // Format 2 only when the bundle actually carries compositions, so composition-free
      // exports stay readable by servers that predate wave 5.
      formatVersion: this.compositions.size ? BUNDLE_FORMAT_VERSION_COMPOSITIONS : BUNDLE_FORMAT_VERSION_LEGACY,
      kind,
      exportedAt: new Date().toISOString(),
      source: { origin, apiVersion: 1, renderContractVersion: RENDER_CONTRACT_VERSION, builtinCatalogHash },
      prototypes: this.prototypes,
      components: [...this.components.values()],
      compositions: [...this.compositions.values()],
      designSystems: [...this.designSystems.values()],
      assets: [...this.assets.values()].map((asset) => asset.entry),
    };
    // Guarantee the emitted manifest is valid against the shared schema (also strips surprises).
    return bundleManifestSchema.parse(manifest);
  }

  /** Materializes the ZIP archive. Enforces the raw-size ceiling before reading any asset bytes. */
  async buildZip(kind: BundleKind, origin: string): Promise<Uint8Array> {
    if (this.rawBytes > EXPORT_RAW_LIMIT) {
      throw new ApiError(413, "export_too_large", `Export exceeds ${EXPORT_RAW_LIMIT} bytes of raw content`);
    }
    const manifest = this.manifest(kind, origin);
    const files: Zippable = { "manifest.json": strToU8(JSON.stringify(manifest)) };
    for (const [path, json] of this.docs) files[path] = strToU8(json);
    for (const [path, source] of this.sources) files[path] = strToU8(source);
    for (const { sha256: sha } of this.assets.values()) {
      files[`assets/${sha}`] = [await Bun.file(this.assetRepo.bytesPath(sha)).bytes(), { level: 0 }];
    }
    return zipSync(files, { mtime: FIXED_MTIME });
  }
}
