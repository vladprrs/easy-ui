import type { Database } from "bun:sqlite";
import { unzipSync, type UnzipFileInfo } from "fflate";
import {
  bundleManifestSchema,
  type BundleComponent,
  type BundleDesignSystem,
  type BundleManifest,
  type BundlePrototype,
  type ImportReport,
  type ImportReportItem,
} from "../../src/bundle/schema";
import { inputPrototypeDocSchema, type PrototypeDoc } from "../../src/prototype/schema";
import { hostPrimitiveNames } from "../../src/catalog/hostPrimitives/definitions";
import { designSystems } from "../../src/designSystems";
import { ApiError } from "../http";
import { RENDER_CONTRACT_VERSION, builtinCatalogHash } from "../builtinHash";
import { AssetRepo } from "../repos/assets";
import { ComponentRepo } from "../repos/components";
import { PrototypeRepo } from "../repos/prototypes";
import { sha256 } from "../components/pipeline";
import { getDesignSystemVersion, getIncludingRetired, latestDesignSystemMetaVersion } from "../designSystems";
import { validateThemeAssets, type ThemeContent } from "../designSystemsMeta";
import { publishComponent } from "../routes/components";
import { createPrototypeFromDoc, updatePrototypeFromDoc } from "../routes/prototypes";

// ZIP bundle importer (plan T3). Reconstructs assets, design systems, components and prototypes
// from an exported bundle. There is no global rollback (component publishing shells out): every
// item is reported individually. dry-run predicts each action from hashes/names/ids and writes
// nothing. Untrusted input is bounded before inflation (upload cap + central-directory budget)
// and every path is allowlisted.

export type ImportMode = "dry-run" | "apply";

const UPLOAD_LIMIT = 256 * 1024 * 1024;
const INFLATE_BUDGET = 512 * 1024 * 1024;
const MAX_ENTRIES = 4096;

// The only paths a well-formed bundle may contain; anything else (traversal, absolute, symlink) is rejected.
const PATH_ALLOWLIST =
  /^(manifest\.json|prototypes\/[a-z0-9]+(?:-[a-z0-9]+)*\.json|components\/[a-z0-9]+(?:-[a-z0-9]+)*\/source\.tsx|assets\/[0-9a-f]{64})$/;

const invalid = (message: string): never => { throw new ApiError(400, "invalid_bundle", message); };

/** Inflate the archive under strict budgets. Declared uncompressed sizes are read from the central
 *  directory (fflate's filter hook) and rejected before inflation; actual lengths are re-checked after. */
function inflate(zip: Uint8Array): Record<string, Uint8Array> {
  if (zip.byteLength > UPLOAD_LIMIT) throw new ApiError(413, "payload_too_large", `Bundle exceeds ${UPLOAD_LIMIT} bytes`);
  let entries = 0;
  let declaredTotal = 0;
  const declared = new Map<string, number>();
  const filter = (file: UnzipFileInfo): boolean => {
    if (++entries > MAX_ENTRIES) throw new ApiError(413, "payload_too_large", `Bundle has more than ${MAX_ENTRIES} entries`);
    if (!PATH_ALLOWLIST.test(file.name)) invalid(`Illegal bundle path: ${file.name}`);
    declaredTotal += file.originalSize;
    if (declaredTotal > INFLATE_BUDGET) throw new ApiError(413, "payload_too_large", `Bundle inflates beyond ${INFLATE_BUDGET} bytes`);
    declared.set(file.name, file.originalSize);
    return true;
  };
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(zip, { filter }); }
  catch (error) { if (error instanceof ApiError) throw error; return invalid("Bundle is not a valid ZIP archive"); }
  // Post-inflation sanity: a lying central directory (declared != actual) is a malformed archive.
  for (const [name, bytes] of Object.entries(files)) {
    if (bytes.byteLength !== declared.get(name)) invalid(`Bundle entry ${name} does not match its declared size`);
  }
  return files;
}

function parseManifest(files: Record<string, Uint8Array>): BundleManifest {
  const raw = files["manifest.json"];
  if (!raw) invalid("Bundle is missing manifest.json");
  let json: unknown;
  try { json = JSON.parse(new TextDecoder().decode(raw!)); }
  catch { return invalid("Bundle manifest is not valid JSON"); }
  const parsed = bundleManifestSchema.safeParse(json);
  if (!parsed.success) throw new ApiError(400, "invalid_bundle", "Bundle manifest is invalid", { issues: parsed.error.issues });
  return parsed.data;
}

/** Cross-check that manifest and archive reference exactly the same set of payload files. */
function crossCheck(manifest: BundleManifest, files: Record<string, Uint8Array>): void {
  const referenced = new Set<string>(["manifest.json"]);
  for (const proto of manifest.prototypes) { referenced.add(proto.docPath); if (!files[proto.docPath]) invalid(`Bundle is missing ${proto.docPath}`); }
  for (const component of manifest.components) { referenced.add(component.sourcePath); if (!files[component.sourcePath]) invalid(`Bundle is missing ${component.sourcePath}`); }
  for (const asset of manifest.assets) { const path = `assets/${asset.sha256}`; referenced.add(path); if (!files[path]) invalid(`Bundle is missing ${path}`); }
  for (const name of Object.keys(files)) if (!referenced.has(name)) invalid(`Bundle contains an unreferenced file: ${name}`);
}

// --- Report accumulation ----------------------------------------------------

class Report {
  readonly items: ImportReportItem[] = [];
  ok = true;
  push(item: ImportReportItem): void {
    if (item.action === "error") this.ok = false;
    this.items.push(item);
  }
  finish(mode: ImportMode): ImportReport {
    const summary = { created: 0, reused: 0, skipped: 0, errors: 0 };
    for (const item of this.items) {
      if (item.action === "created") summary.created += 1;
      else if (item.action === "reused") summary.reused += 1;
      else if (item.action === "skipped") summary.skipped += 1;
      else summary.errors += 1;
    }
    return { mode, ok: this.ok, items: this.items, summary };
  }
}

// --- Helpers ----------------------------------------------------------------

const themeKey = (theme: { tokens: unknown; fonts: unknown; icons: unknown }) =>
  JSON.stringify([theme.tokens, theme.fonts, theme.icons]);

function latestActiveVersion(db: Database, id: string): number | null {
  return (db.query("SELECT MAX(version) v FROM component_publishes WHERE component_id=? AND status='active'").get(id) as { v: number | null }).v;
}

function activeComponentByName(db: Database, name: string, designSystem: string): boolean {
  return Boolean(db.query(`SELECT 1 ok FROM components c
    JOIN component_publishes cp ON cp.component_id=c.id AND cp.status='active'
    JOIN component_revisions cr ON cr.component_id=cp.component_id AND cr.rev=cp.rev
    WHERE c.name=? AND cr.design_system=? AND c.deleted_at IS NULL LIMIT 1`).get(name, designSystem));
}

function builtinNameReserved(name: string): boolean {
  return hostPrimitiveNames.has(name) || Object.values(designSystems).some((system) => Object.hasOwn(system.definitions, name));
}

// --- Phase: assets ----------------------------------------------------------

async function importAssets(db: Database, dataDir: string, manifest: BundleManifest, files: Record<string, Uint8Array>, mode: ImportMode, report: Report): Promise<void> {
  const repo = new AssetRepo(db, dataDir);
  for (const asset of manifest.assets) {
    const bytes = files[`assets/${asset.sha256}`]!;
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    if (digest !== asset.sha256 || asset.id !== `asset_${asset.sha256}`) {
      report.push({ type: "asset", id: asset.id, action: "error", detail: "asset bytes do not match the declared sha256" });
      continue;
    }
    if (mode === "dry-run") {
      const exists = db.query("SELECT 1 ok FROM assets WHERE sha256=?").get(asset.sha256);
      report.push({ type: "asset", id: asset.id, action: exists ? "reused" : "created" });
      continue;
    }
    try {
      const { deduplicated } = await repo.ingest(bytes, asset.mime, asset.originalName ?? undefined);
      report.push({ type: "asset", id: asset.id, action: deduplicated ? "reused" : "created" });
    } catch (error) {
      report.push({ type: "asset", id: asset.id, action: "error", detail: error instanceof ApiError ? error.message : String(error) });
    }
  }
}

// --- Phase: design systems --------------------------------------------------

function importDesignSystem(db: Database, ds: BundleDesignSystem, importerId: string, mode: ImportMode, report: Report): void {
  const base = { type: "designSystem" as const, id: ds.id, name: ds.name };
  const local = getIncludingRetired(db, ds.id);
  if (ds.builtin) {
    if (!local || local.builtinProvider === null) report.push({ ...base, action: "error", detail: "design_system_missing" });
    else report.push({ ...base, action: "reused" });
    return;
  }
  const at = new Date().toISOString();
  try {
    if (!local) {
      if (mode === "apply") {
        db.query("INSERT INTO design_systems (id,name,description,builtin_provider,created_at,updated_at,owner_id) VALUES (?,?,?,NULL,?,?,?)")
          .run(ds.id, ds.name, ds.description ?? "", at, at, importerId);
        if (ds.theme) { validateThemeAssets(db, ds.theme as unknown as ThemeContent); insertThemeVersion(db, ds.id, 1, ds.theme, at); }
      }
      report.push({ ...base, action: "created" });
      return;
    }
    // Reuse by reference. A theme version is written only when this importer owns the system and the theme differs.
    if (!ds.theme) { report.push({ ...base, action: "reused" }); return; }
    const localLatest = latestDesignSystemMetaVersion(db, ds.id);
    const localContent = localLatest === null ? null : getDesignSystemVersion(db, ds.id, localLatest);
    const differs = localContent === null || themeKey(localContent) !== themeKey(ds.theme);
    if (!differs) { report.push({ ...base, action: "reused" }); return; }
    const owner = (db.query("SELECT owner_id o FROM design_systems WHERE id=?").get(ds.id) as { o: string | null } | null)?.o ?? null;
    if (owner !== importerId) { report.push({ ...base, action: "reused", detail: "theme drift: not owner, theme left unchanged" }); return; }
    if (mode === "apply") { validateThemeAssets(db, ds.theme as unknown as ThemeContent); insertThemeVersion(db, ds.id, (localLatest ?? 0) + 1, ds.theme, at); }
    report.push({ ...base, action: "reused", detail: "theme updated to a new version", version: (localLatest ?? 0) + 1 });
  } catch (error) {
    report.push({ ...base, action: "error", detail: error instanceof ApiError ? error.message : String(error) });
  }
}

function insertThemeVersion(db: Database, systemId: string, version: number, theme: BundleDesignSystem["theme"], at: string): void {
  db.transaction(() => {
    db.query("INSERT INTO design_system_versions (system_id,version,tokens_json,fonts_json,icons_json,created_at) VALUES (?,?,?,?,?,?)")
      .run(systemId, version, JSON.stringify(theme!.tokens), JSON.stringify(theme!.fonts), JSON.stringify(theme!.icons), at);
    db.query("UPDATE design_systems SET updated_at=? WHERE id=?").run(at, systemId);
  })();
}

// --- Phase: components ------------------------------------------------------

interface ComponentRow { id: string; name: string; head_rev: number; deleted_at: string | null; owner_id: string | null }

async function importComponent(db: Database, dataDir: string, component: BundleComponent, source: string, importerId: string, mode: ImportMode, report: Report): Promise<void> {
  const repo = new ComponentRepo(db);
  const base = { type: "component" as const, id: component.id, name: component.name };
  if (builtinNameReserved(component.name)) { report.push({ ...base, action: "error", detail: "builtin_name_reserved" }); return; }

  const byId = db.query("SELECT id,name,head_rev,deleted_at,owner_id FROM components WHERE id=?").get(component.id) as ComponentRow | null;
  const byName = db.query("SELECT id,name,head_rev,deleted_at,owner_id FROM components WHERE name=?").get(component.name) as ComponentRow | null;
  if (byId?.deleted_at || byName?.deleted_at) { report.push({ ...base, action: "error", detail: "deleted_conflict" }); return; }

  const target = byId && byId.deleted_at === null ? byId : byName && byName.deleted_at === null ? byName : null;
  if (target) {
    if (target.owner_id !== importerId) { report.push({ ...base, action: "error", detail: "name_conflict" }); return; }
    const liveId = target.id;
    const remappedTo = liveId !== component.id ? liveId : undefined;
    const head = repo.source(liveId);
    const sameSource = sha256(head.source) === component.sourceHash;
    const active = latestActiveVersion(db, liveId);
    if (sameSource && active !== null) { report.push({ ...base, action: "reused", version: active, ...(remappedTo ? { remappedTo } : {}) }); return; }
    if (mode === "dry-run") { report.push({ ...base, action: "created", version: (latestActiveVersion(db, liveId) ?? 0) + 1, ...(remappedTo ? { remappedTo } : {}) }); return; }
    try {
      let baseRev = head.rev;
      if (!sameSource) baseRev = repo.save(liveId, source, component.designSystem, head.rev).rev;
      const result = await publishComponent(db, repo, liveId, baseRev, dataDir);
      report.push({ ...base, action: "created", version: result.version, ...(remappedTo ? { remappedTo } : {}) });
    } catch (error) {
      report.push({ ...base, action: "error", detail: error instanceof ApiError ? error.message : String(error) });
    }
    return;
  }
  // Both id and name are free: create fresh and publish.
  if (mode === "dry-run") { report.push({ ...base, action: "created", version: 1 }); return; }
  try {
    repo.create(component.id, component.name, source, component.designSystem, undefined, null, importerId);
    const result = await publishComponent(db, repo, component.id, 1, dataDir);
    report.push({ ...base, action: "created", version: result.version });
  } catch (error) {
    report.push({ ...base, action: "error", detail: error instanceof ApiError ? error.message : String(error) });
  }
}

// --- Phase: prototypes ------------------------------------------------------

function nextFreeId(db: Database, id: string): string {
  for (let n = 1; ; n += 1) {
    const candidate = `${id}-imported-${n}`;
    if (!db.query("SELECT 1 ok FROM prototypes WHERE id=?").get(candidate)) return candidate;
  }
}

async function importPrototype(db: Database, dataDir: string, bundle: BundlePrototype, docBytes: Uint8Array, manifest: BundleManifest, importerId: string, mode: ImportMode, available: Set<string>, availableDs: Set<string>, report: Report): Promise<void> {
  const repo = new PrototypeRepo(db);
  const base = { type: "prototype" as const, id: bundle.id, name: bundle.name };
  const formatTooNew = manifest.source.renderContractVersion > RENDER_CONTRACT_VERSION || manifest.source.builtinCatalogHash !== builtinCatalogHash;

  let doc: PrototypeDoc;
  try { doc = inputPrototypeDocSchema.parse(JSON.parse(new TextDecoder().decode(docBytes))); }
  catch (error) { report.push({ ...base, action: "error", detail: `${formatTooNew ? "format_too_new: " : ""}${error instanceof Error ? error.message : String(error)}` }); return; }

  // Dependency check: the design system and every referenced custom type must be resolvable on the target.
  const system = getIncludingRetired(db, doc.designSystem);
  let builtin: Record<string, unknown>;
  if (system && !system.retired) builtin = system.definitions;
  else if (availableDs.has(doc.designSystem)) builtin = {}; // a bundle custom system not yet written (dry-run)
  else { report.push({ ...base, action: "error", detail: "dependency_failed: design system unavailable" }); return; }
  const customTypes = new Set(doc.screens.flatMap((screen) => Object.values(screen.spec.elements).map((element) => element.type))
    .filter((type) => !Object.hasOwn(builtin, type) && !hostPrimitiveNames.has(type)));
  const missing = [...customTypes].filter((type) => !available.has(`${doc.designSystem}::${type}`) && !activeComponentByName(db, type, doc.designSystem));
  if (missing.length) { report.push({ ...base, action: "error", detail: `dependency_failed: ${missing.join(", ")}` }); return; }

  const existing = db.query("SELECT owner_id o,head_rev h FROM prototypes WHERE id=?").get(bundle.id) as { o: string | null; h: number } | null;
  try {
    if (!existing) {
      if (mode === "apply") await createPrototypeFromDoc(db, repo, doc, dataDir, importerId);
      report.push({ ...base, action: "created" });
      return;
    }
    if (existing.o === importerId) {
      const headJson = (db.query("SELECT doc FROM prototype_revisions WHERE prototype_id=? AND rev=?").get(bundle.id, existing.h) as { doc: string }).doc;
      const sameDoc = canonical(doc) === canonical(inputPrototypeDocSchema.parse(JSON.parse(headJson)));
      if (sameDoc) { report.push({ ...base, action: "skipped" }); return; }
      if (mode === "apply") { const saved = await updatePrototypeFromDoc(db, repo, bundle.id, doc, existing.h, dataDir, importerId); report.push({ ...base, action: "created", version: saved.rev }); return; }
      report.push({ ...base, action: "created", version: existing.h + 1 });
      return;
    }
    // Foreign id: remap to a free `<id>-imported-<n>`.
    const remappedTo = nextFreeId(db, bundle.id);
    if (mode === "apply") await createPrototypeFromDoc(db, repo, { ...doc, id: remappedTo }, dataDir, importerId);
    report.push({ ...base, action: "created", remappedTo });
  } catch (error) {
    report.push({ ...base, action: "error", detail: `${formatTooNew ? "format_too_new: " : ""}${error instanceof ApiError ? error.message : String(error)}` });
  }
}

const canonical = (doc: PrototypeDoc): string => JSON.stringify(doc);

// --- Orchestration ----------------------------------------------------------

export async function importBundle(db: Database, dataDir: string, zip: Uint8Array, importerId: string, mode: ImportMode): Promise<ImportReport> {
  const files = inflate(zip);
  const manifest = parseManifest(files);
  crossCheck(manifest, files);
  const report = new Report();

  await importAssets(db, dataDir, manifest, files, mode, report);
  const availableDs = new Set<string>();
  for (const ds of manifest.designSystems) {
    const before = report.items.length;
    importDesignSystem(db, ds, importerId, mode, report);
    const outcome = report.items[before];
    if (outcome && outcome.action !== "error") availableDs.add(ds.id);
  }

  // Components resolved created/reused become available to prototype dependency checks (by name+DS).
  const available = new Set<string>();
  for (const component of manifest.components) {
    const before = report.items.length;
    await importComponent(db, dataDir, component, new TextDecoder().decode(files[component.sourcePath]!), importerId, mode, report);
    const outcome = report.items[before];
    if (outcome && (outcome.action === "created" || outcome.action === "reused")) available.add(`${component.designSystem}::${component.name}`);
  }

  for (const bundle of manifest.prototypes) {
    await importPrototype(db, dataDir, bundle, files[bundle.docPath]!, manifest, importerId, mode, available, availableDs, report);
  }
  return report.finish(mode);
}
