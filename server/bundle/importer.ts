import type { Database } from "bun:sqlite";
import { unzipSync, type UnzipFileInfo } from "fflate";
import { z } from "zod";
import {
  bundleManifestSchema,
  type BundleComponent,
  type BundleComposition,
  type BundleDesignSystem,
  type BundleManifest,
  type BundlePrototype,
  type ImportReport,
  type ImportReportItem,
} from "../../src/bundle/schema";
import { inputPrototypeDocSchema, type PrototypeDoc } from "../../src/prototype/schema";
import { collectCompositionRefs, compositionDocSchema, type CompositionDoc } from "../../src/prototype/composition";
import { hostPrimitiveNames } from "../../src/catalog/hostPrimitives/definitions";
import { designSystems } from "../../src/designSystems";
import { ApiError } from "../http";
import { RENDER_CONTRACT_VERSION, builtinCatalogHash } from "../builtinHash";
import { AssetRepo } from "../repos/assets";
import { ComponentRepo } from "../repos/components";
import { CompositionRepo, compositionSourceHash } from "../repos/compositions";
import { PrototypeRepo } from "../repos/prototypes";
import { sha256 } from "../components/pipeline";
import type { ExtractResult } from "../components/extract-subprocess";
import { getDesignSystemVersion, getIncludingRetired, latestDesignSystemMetaVersion } from "../designSystems";
import { validateThemeAssets, type ThemeContent } from "../designSystemsMeta";
import { checkSource, publishComponent } from "../routes/components";
import { createPrototypeFromDoc, updatePrototypeFromDoc } from "../routes/prototypes";
import {
  cacheSourceShingles, matchAndDecide, recordBlockedAttempt, ReuseGateRejection, stageAndExtract,
  DEFAULT_REUSE_GATE_MODE, type ReuseGateMode, type ReuseOverride,
} from "../catalog/gate";

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
  /^(manifest\.json|prototypes\/[a-z0-9]+(?:-[a-z0-9]+)*\.json|compositions\/[a-z0-9]+(?:-[a-z0-9]+)*\.json|components\/[a-z0-9]+(?:-[a-z0-9]+)*\/source\.tsx|assets\/[0-9a-f]{64})$/;

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
  for (const composition of manifest.compositions) { referenced.add(composition.docPath); if (!files[composition.docPath]) invalid(`Bundle is missing ${composition.docPath}`); }
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

function activeCompositionVersion(db: Database, id: string): number | null {
  return (db.query("SELECT MAX(version) v FROM composition_publishes WHERE composition_id=? AND status='active'").get(id) as { v: number | null }).v;
}

/** An importable composition on the target: alive, of the same design system and actively published. */
function activeCompositionById(db: Database, id: string, designSystem: string): boolean {
  return Boolean(db.query(`SELECT 1 ok FROM compositions c
    JOIN composition_publishes cp ON cp.composition_id=c.id AND cp.status='active'
    WHERE c.id=? AND c.design_system=? AND c.deleted_at IS NULL LIMIT 1`).get(id, designSystem));
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

/**
 * Извлечение меты для гейта — **до** `repo.create`, над одноразовым staging-модулем. Тот же
 * `checkSource`, что и на публикации, и с тем же `smoke:true`: результат отдаётся дальше в
 * `publishComponent` как `preExtracted`, поэтому обязан быть побайтово тем же, что публикация
 * посчитала бы сама (план §3.7, A7) — иначе импорт сотни компонентов платит второй спавн по 10 с.
 */
const extractForImport = (dataDir: string, id: string, source: string): Promise<ExtractResult> =>
  stageAndExtract(dataDir, id, source, (path) => checkSource(source, path, true));

/**
 * `dry-run` обязан **предсказывать** решение гейта, но не оставлять следов: иначе любой
 * аутентифицированный пользователь бесконечно засоряет append-only `catalog_reuse_decisions`,
 * и `repeatedAttempts` в теле 409 начинает врать (план §3.7, A15). Прогон идёт по тому же
 * коду, что и apply, и целиком откатывается — второй реализации матчинга не появляется.
 */
const DRY_RUN_ROLLBACK = Symbol("bundle import dry-run rollback");
function withRollback<T>(db: Database, run: () => T): T {
  let result: T | undefined;
  try { db.transaction(() => { result = run(); throw DRY_RUN_ROLLBACK; })(); }
  catch (error) { if (error !== DRY_RUN_ROLLBACK) throw error; }
  return result as T;
}

/** Контекст гейта переиспользования на импорте (план §3.7). */
export interface ImportReuseContext {
  mode: ReuseGateMode;
  actor: { userId: string; isAdmin: boolean };
  /** Синтезированный intent per-item: бандл его не несёт (`src/bundle/schema.ts`). */
  intent: string;
  /** Подтверждённые ключи именно этой позиции; только от админа (см. `routes/bundles.ts`). */
  override?: ReuseOverride;
}

/** Позиция отчёта для заблокированной попытки: машинные поля — вход второй фазы override. */
function rejectionReport(db: Database, rejection: ReuseGateRejection, audit: boolean): Pick<ImportReportItem, "detail" | "catalogRevision" | "candidateKeys" | "decisionId" | "reuseCode"> {
  const recorded = audit ? recordBlockedAttempt(db, rejection.attempt) : null;
  return {
    detail: "reuse_blocked",
    reuseCode: rejection.code,
    catalogRevision: rejection.payload.catalogRevision,
    candidateKeys: rejection.payload.overrideTemplate.candidateKeys,
    decisionId: recorded?.decisionId ?? null,
  };
}

/** Предупреждения гейта/публикации доезжают до вызывающего единственным свободным полем отчёта. */
const warningDetail = (warnings: readonly string[]): { detail?: string } =>
  warnings.length === 0 ? {} : { detail: warnings.join(" | ").slice(0, 1000) };

async function importComponent(db: Database, dataDir: string, component: BundleComponent, source: string, importerId: string, mode: ImportMode, reuse: ImportReuseContext, report: Report): Promise<void> {
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
    // Существующий компонент — это **update**, и гейт создания на нём не стоит (отступление D4).
    // Но обход «завести компонент → импортом подменить исходник» обязан быть наблюдаем, поэтому
    // publish-предупреждение о дубликате доезжает до отчёта.
    try {
      let baseRev = head.rev;
      if (!sameSource) {
        baseRev = repo.save(liveId, source, component.designSystem, head.rev).rev;
        cacheSourceShingles(db, liveId, baseRev, source);
      }
      const result = await publishComponent(db, repo, liveId, baseRev, dataDir, undefined, {}, { actor: reuse.actor, mode: reuse.mode, ...(reuse.override === undefined ? {} : { override: reuse.override }) });
      report.push({ ...base, action: "created", version: result.version, ...(remappedTo ? { remappedTo } : {}), ...warningDetail(result.warnings) });
    } catch (error) {
      if (error instanceof ReuseGateRejection) { report.push({ ...base, action: "error", ...rejectionReport(db, error, true) }); return; }
      report.push({ ...base, action: "error", detail: error instanceof ApiError ? error.message : String(error) });
    }
    return;
  }

  // Оба id и name свободны: create + publish — это **создание активного компонента**, и оно
  // обязано проходить тот же гейт, что `POST /api/components`. Без этого любой пользователь
  // экспортировал бы чужой компонент и импортировал его под свободным id мимо гейта
  // (план §1.1, B2). Извлечение делается **до** create — иначе гейту нечего сопоставлять —
  // и переиспользуется публикацией (план §3.7, A7).
  let extracted: ExtractResult;
  try { extracted = await extractForImport(dataDir, component.id, source); }
  catch (error) { report.push({ ...base, action: "error", detail: error instanceof ApiError ? error.message : String(error) }); return; }

  const gate = {
    mode: reuse.mode, actor: reuse.actor, userAgent: "bundle-import",
    designSystem: component.designSystem, artifactId: component.id, name: component.name,
    source, meta: extracted.meta!, intent: reuse.intent, intentProvided: true,
    ...(reuse.override === undefined ? {} : { override: reuse.override }),
  };
  let outcome;
  try {
    // Матчинг, create и аудит — одна синхронная транзакция гейта. В dry-run она целиком
    // откатывается: решение предсказано, но ни компонента, ни аудит-строки не остаётся.
    outcome = mode === "dry-run"
      ? withRollback(db, () => matchAndDecide(db, gate, () => null))
      : matchAndDecide(db, gate, () => {
        const created = repo.create(component.id, component.name, source, component.designSystem, undefined, null, importerId);
        cacheSourceShingles(db, component.id, 1, source);
        return created;
      });
  } catch (error) {
    // Блокировка — позиция отчёта, а не отказ запроса: импорт по-элементный, остальные
    // позиции обязаны доехать.
    if (error instanceof ReuseGateRejection) { report.push({ ...base, action: "error", ...rejectionReport(db, error, mode === "apply") }); return; }
    report.push({ ...base, action: "error", detail: error instanceof ApiError ? error.message : String(error) });
    return;
  }
  if (mode === "dry-run") { report.push({ ...base, action: "created", version: 1, ...warningDetail(outcome.warnings) }); return; }
  try {
    const result = await publishComponent(db, repo, component.id, 1, dataDir, undefined, {}, { actor: reuse.actor, mode: reuse.mode, ...(reuse.override === undefined ? {} : { override: reuse.override }) }, { sourceHash: sha256(source), extracted });
    report.push({ ...base, action: "created", version: result.version, ...warningDetail([...outcome.warnings, ...result.warnings]) });
  } catch (error) {
    if (error instanceof ReuseGateRejection) { report.push({ ...base, action: "error", ...rejectionReport(db, error, true) }); return; }
    report.push({ ...base, action: "error", detail: error instanceof ApiError ? error.message : String(error) });
  }
}

// --- Phase: compositions ----------------------------------------------------

interface CompositionRow { id: string; name: string; head_rev: number; deleted_at: string | null; owner_id: string | null }

/**
 * Композиции восстанавливаются между фазой компонентов и фазой прототипов: их документ
 * ссылается на published-компоненты цели, а save-путь прототипа резолвит композицию к
 * последней active-публикации. Конфликт-политика — компонентная, с одним отличием:
 * прототип адресует композицию **по id**, поэтому remap id невозможен и занятый чужой
 * id/name — это `name_conflict`, а не `<id>-imported-<n>`.
 */
function importComposition(db: Database, bundle: BundleComposition, docJson: string, importerId: string, mode: ImportMode, availableComponents: Set<string>, availableDs: Set<string>, report: Report): boolean {
  const base = { type: "composition" as const, id: bundle.id, name: bundle.name };
  let doc: CompositionDoc;
  try { doc = compositionDocSchema.parse(JSON.parse(docJson)); }
  catch (error) { report.push({ ...base, action: "error", detail: `invalid_document: ${error instanceof Error ? error.message : String(error)}` }); return false; }

  const system = getIncludingRetired(db, bundle.designSystem);
  const systemUsable = (system !== null && !system.retired) || availableDs.has(bundle.designSystem);
  if (!systemUsable) { report.push({ ...base, action: "error", detail: "dependency_failed: design system unavailable" }); return false; }

  // Каждый внутренний тип обязан быть host-примитивом либо активным компонентом цели
  // (в том числе только что импортированным) — иначе раскрытие прототипа не найдёт пин.
  const missing = [...new Set(Object.values(doc.spec.elements).map((element) => element.type))]
    .filter((type) => !hostPrimitiveNames.has(type))
    .filter((type) => !availableComponents.has(`${bundle.designSystem}::${type}`) && !activeComponentByName(db, type, bundle.designSystem));
  if (missing.length) { report.push({ ...base, action: "error", detail: `dependency_failed: ${missing.join(", ")}` }); return false; }

  const repo = new CompositionRepo(db);
  const byId = db.query("SELECT id,name,head_rev,deleted_at,owner_id FROM compositions WHERE id=?").get(bundle.id) as CompositionRow | null;
  const byName = db.query("SELECT id,name,head_rev,deleted_at,owner_id FROM compositions WHERE name=?").get(bundle.name) as CompositionRow | null;
  if (byId?.deleted_at || byName?.deleted_at) { report.push({ ...base, action: "error", detail: "deleted_conflict" }); return false; }
  const target = byId ?? byName;
  if (target) {
    if (target.owner_id !== importerId || target.id !== bundle.id) { report.push({ ...base, action: "error", detail: "name_conflict" }); return false; }
    const head = repo.revision(target.id);
    const sameDoc = compositionSourceHash(head.doc) === bundle.sourceHash;
    const active = activeCompositionVersion(db, target.id);
    if (sameDoc && active !== null) { report.push({ ...base, action: "reused", version: active }); return true; }
    if (mode === "dry-run") { report.push({ ...base, action: "created", version: (active ?? 0) + 1 }); return true; }
    try {
      const baseRev = sameDoc ? head.rev : repo.save(target.id, doc, head.rev, "Imported from bundle", importerId).rev;
      const result = repo.publish(target.id, baseRev, "Imported from bundle");
      report.push({ ...base, action: "created", version: result.version });
      return true;
    } catch (error) {
      report.push({ ...base, action: "error", detail: error instanceof ApiError ? error.message : String(error) });
      return false;
    }
  }
  if (mode === "dry-run") { report.push({ ...base, action: "created", version: 1 }); return true; }
  try {
    repo.create(bundle.id, doc, bundle.designSystem, "Imported from bundle", importerId);
    const result = repo.publish(bundle.id, 1, "Imported from bundle");
    report.push({ ...base, action: "created", version: result.version });
    return true;
  } catch (error) {
    report.push({ ...base, action: "error", detail: error instanceof ApiError ? error.message : String(error) });
    return false;
  }
}

// --- Phase: prototypes ------------------------------------------------------

function nextFreeId(db: Database, id: string): string {
  for (let n = 1; ; n += 1) {
    const candidate = `${id}-imported-${n}`;
    if (!db.query("SELECT 1 ok FROM prototypes WHERE id=?").get(candidate)) return candidate;
  }
}

async function importPrototype(db: Database, dataDir: string, bundle: BundlePrototype, docBytes: Uint8Array, manifest: BundleManifest, importerId: string, mode: ImportMode, available: Set<string>, availableDs: Set<string>, availableCompositions: Set<string>, report: Report): Promise<void> {
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
  // Композиции: `@eui/Composition` — host-примитив, поэтому в customTypes его нет; ссылка
  // адресует ресурс по id и обязана резолвиться в active-публикацию той же системы.
  const missingCompositions = [...new Set(collectCompositionRefs(doc).map((ref) => ref.compositionId))]
    .filter((id) => !availableCompositions.has(id) && !activeCompositionById(db, id, doc.designSystem));
  if (missingCompositions.length) { report.push({ ...base, action: "error", detail: `dependency_failed: composition ${missingCompositions.join(", ")}` }); return; }

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

/**
 * Двухфазный override гейта на импорте (план §3.7, отступление D9, находка A6).
 *
 * Бланкетного флага «пропусти гейт» здесь нет: он был бы контрактом слабее спеки §4. Фаза 1 —
 * `mode=dry-run`, она возвращает per-item `reuse_blocked` с `candidateKeys` и текущим
 * `catalogRevision`. Фаза 2 — `apply` с этим объектом **в теле** (поле `reuseOverride`
 * multipart-формы): каждый подтверждаемый компонент называет свои ключи, ревизия обязана
 * совпасть с сегодняшней, `reason` — 20..500 после trim. Проверку выполняет сам гейт;
 * админский барьер стоит на маршруте (`routes/bundles.ts`).
 *
 * Ревизия каталога может сдвинуться между фазами — тогда гейт бросает `catalog_changed`, и это
 * попадает в отчёт позицией `reuse_override_stale`, а не игнорируется (D9).
 */
export const bundleReuseOverrideSchema = z.strictObject({
  catalogRevision: z.string().min(1).max(128),
  reason: z.string().trim().min(20).max(500),
  components: z.array(z.strictObject({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
    candidateKeys: z.array(z.string().min(1).max(256)).min(1).max(64),
  })).min(1).max(256),
}).superRefine((value, ctx) => {
  const seen = new Set<string>();
  value.components.forEach((component, index) => {
    if (seen.has(component.id)) ctx.addIssue({ code: "custom", path: ["components", index, "id"], message: "component id must be unique" });
    seen.add(component.id);
  });
});
export type BundleReuseOverride = z.infer<typeof bundleReuseOverrideSchema>;

export interface ImportReuseOptions {
  /** Фаза гейта процесса. По умолчанию — `enforce` в коде, как и на `POST /api/components`. */
  mode?: ReuseGateMode;
  /** Админ ли импортирующий: без этого `override` не имеет силы. */
  isAdmin?: boolean;
  override?: BundleReuseOverride;
}

export async function importBundle(db: Database, dataDir: string, zip: Uint8Array, importerId: string, mode: ImportMode, reuse: ImportReuseOptions = {}): Promise<ImportReport> {
  const files = inflate(zip);
  const manifest = parseManifest(files);
  crossCheck(manifest, files);
  if (reuse.override !== undefined) {
    if (reuse.isAdmin !== true) throw new ApiError(403, "admin_required", "Only an admin may override the reuse gate");
    const manifestIds = new Set(manifest.components.map((component) => component.id));
    const unknown = reuse.override.components.map((component) => component.id).filter((id) => !manifestIds.has(id));
    if (unknown.length) throw new ApiError(422, "validation_failed", "reuseOverride references components absent from the bundle", { issues: unknown.map((id) => ({ path: ["reuseOverride", "components"], message: `unknown component: ${id}` })) });
  }
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
  // Бандл не несёт intent (`src/bundle/schema.ts`), поэтому он синтезируется из происхождения
  // архива: аудит обязан отвечать на вопрос «откуда это приехало».
  const intent = `imported from ${manifest.source.origin || "an exported bundle"}`.slice(0, 500);
  const actor = { userId: importerId, isAdmin: reuse.isAdmin === true };
  const overrideFor = (id: string): ReuseOverride | undefined => {
    const entry = reuse.override?.components.find((item) => item.id === id);
    return entry === undefined ? undefined
      : { catalogRevision: reuse.override!.catalogRevision, candidateKeys: entry.candidateKeys, reason: reuse.override!.reason };
  };
  const available = new Set<string>();
  for (const component of manifest.components) {
    const before = report.items.length;
    const override = overrideFor(component.id);
    const context: ImportReuseContext = { mode: reuse.mode ?? DEFAULT_REUSE_GATE_MODE, actor, intent, ...(override === undefined ? {} : { override }) };
    await importComponent(db, dataDir, component, new TextDecoder().decode(files[component.sourcePath]!), importerId, mode, context, report);
    const outcome = report.items[before];
    if (outcome && (outcome.action === "created" || outcome.action === "reused")) available.add(`${component.designSystem}::${component.name}`);
  }

  // Compositions sit between components and prototypes: they consume published components
  // and are consumed by the prototype save path (which resolves them to their active version).
  const availableCompositions = new Set<string>();
  for (const composition of manifest.compositions) {
    const resolved = importComposition(db, composition, new TextDecoder().decode(files[composition.docPath]!), importerId, mode, available, availableDs, report);
    if (resolved) availableCompositions.add(composition.id);
  }

  for (const bundle of manifest.prototypes) {
    await importPrototype(db, dataDir, bundle, files[bundle.docPath]!, manifest, importerId, mode, available, availableDs, availableCompositions, report);
  }
  return report.finish(mode);
}
