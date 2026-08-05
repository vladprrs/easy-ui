import type { Database } from "bun:sqlite";
import type { PrototypeDoc } from "../../src/prototype/schema";
import { storedPrototypeDocSchema } from "../../src/prototype/schema";
import { builtinCatalogHashFor, emptyComponentManifestHash } from "../builtinHash";
import { getDesignSystemVersion, latestDesignSystemMetaVersion, requireActiveDesignSystem } from "../designSystems";
import { resolveSpacingScale } from "../../src/designSystems/spacingScale";
import { ApiError } from "../http";
import type { ComponentPin, CompositionPin } from "../validation";
import { pinnedCompositionDocs } from "./compositions";
import { collectCompositionRefs } from "../../src/prototype/composition";
import { latestValidatedRev } from "../validationRecords";
import { parseFigmaStored } from "../figma";
import { hostPrimitiveNames } from "../../src/catalog/hostPrimitives/definitions";
import type { Principal } from "../auth";
import { prototypeAccess, requirePrototypeRead } from "../authorization";
import { classifyRevision, type RevisionClassification } from "../classify";
import { isServicePrototypeDocKind } from "../../src/prototype/architectureLints";
import { docSurfaces, primarySurface, surfaceDesignSystem, type SurfaceAwareDoc } from "../../src/prototype/surfaces";

/**
 * ДС primary-поверхности (D3: у документа без `surfaces` — просто `doc.designSystem`).
 * Значение колонки `prototype_revisions.design_system_meta_version` и ключ read-правила
 * theme-pins — всегда про эту систему.
 */
export const primaryDesignSystem = (doc: PrototypeDoc): string =>
  surfaceDesignSystem(primarySurface(doc as SurfaceAwareDoc), doc as SurfaceAwareDoc) ?? doc.designSystem;

/**
 * Все ДС документа (план multi-surface-flows §4). Порядок — primary первой, дальше по
 * порядку поверхностей; дубликаты снимаются. Документ без `surfaces` даёт ровно
 * `[doc.designSystem]`, поэтому все производные (пины, хэш, allowlist) байт-в-байт как раньше.
 */
export function docDesignSystems(doc: PrototypeDoc): string[] {
  const seen = new Set<string>();
  for (const surface of docSurfaces(doc as SurfaceAwareDoc)) {
    const system = surfaceDesignSystem(surface, doc as SurfaceAwareDoc) ?? doc.designSystem;
    seen.add(system);
  }
  return [...seen];
}

/**
 * Карта пинов темы ревизии: `дизайн-система → версия темы`.
 *
 * **Read-правило (план §4, без бэкфила by design)**: если строк в
 * `prototype_revision_theme_pins` нет (ревизия записана до миграции v24), карта — это
 * `{ primaryDesignSystem(doc): design_system_meta_version }`, то есть ровно сегодняшний
 * скаляр. Колонка остаётся primary-значением и после миграции.
 */
export function themePinsOf(db: Database, id: string, rev: number, doc: PrototypeDoc, columnValue: number | null): Record<string, number | null> {
  const rows = db.query("SELECT design_system, meta_version FROM prototype_revision_theme_pins WHERE prototype_id=? AND rev=? ORDER BY design_system")
    .all(id, rev) as { design_system: string; meta_version: number | null }[];
  if (!rows.length) return { [primaryDesignSystem(doc)]: columnValue };
  return Object.fromEntries(rows.map((row) => [row.design_system, row.meta_version]));
}

// `status` — статус публикации закреплённой версии (волна 3): включает бейдж «устарел»
// в дереве компонентов редактора. Поле аддитивное, старые клиенты его игнорируют.
type Pin = { id: string; name: string; version: number; bundleUrl: string; bundleHash: string; status: string };
export type ResolvedPin = Pin;
/**
 * `componentManifestHash` ревизии — sha256 стабильной тройки `(id, version, bundleHash)` каждого
 * пина в их порядке. Экспортируется (план 2026-08-05 §B2.3), потому что prototypeCandidateOverlay
 * считает **тот же** хэш по подменённому списку пинов: у overlay-джобы и `expected`, и
 * `captureManifestHash` обязаны быть одной величиной, а формула — прежней (иначе handshake
 * поверхности сравнивал бы значения, вычисленные разными правилами).
 *
 * Пустой список сохраняет своё особое значение (`emptyComponentManifestHash`): это исторический
 * контракт read-путей, а не деталь реализации.
 */
export function componentManifestHashOf(pins: { id: string; version: number; bundleHash: string }[]): string {
  if (!pins.length) return emptyComponentManifestHash;
  const stable = pins.map(({ id, version, bundleHash }) => ({ id, version, bundleHash }));
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(stable)).digest("hex");
}
export type BundleReadiness = { resolvedPins: ResolvedPin[]; bundles: boolean; bundleStatus: "ready" | "failed"; warnings: { code: string; message: string }[]; errors: { code: string; message: string }[] };
// Statuses that still render (K adds deprecated/superseded later; tolerated ahead of that migration).
const RENDERABLE_PIN_STATUS = new Set(["active", "deprecated", "superseded"]);
type PrototypeRow = { id:string; name:string; description:string|null; device:string; screen_count:number; head_rev:number; design_system:string; instance_id:string; created_at:string; updated_at:string; owner_id:string; status:"private"|"published"|"archived"; kind:string; tags:string|null; derived_from:string|null; track:string };
type RevisionRow = { rev:number; doc:string; builtin_catalog_hash:string; design_system_meta_version:number|null; figma_json:string|null; message:string|null; created_at:string };

const now = () => new Date().toISOString();
const missing = () => new ApiError(404, "prototype_not_found", "Prototype not found");

// --- Lifecycle metadata (миграция v16) ---
export const DEFAULT_PROTOTYPE_KIND = "product-flow";
// --- Head-tracking служебных прототипов (миграция v22, план 2026-08-02 P2) ---
// `pinned` — сегодняшняя семантика: ревизия рендерит закреплённые пины. `head` — read-пути
// резолвят компонентные пины на последние active-публикации. Только компонентные пины:
// `designSystemMetaVersion` (и производный `builtinCatalogHash`, и allowlist ассетов темы)
// остаётся пином ревизии — после PATCH темы track-док по-прежнему требует пересохранения.
export const DEFAULT_PROTOTYPE_TRACK = "pinned";
export type PrototypeTrack = "pinned" | "head";
export const HEAD_TRACK: PrototypeTrack = "head";
export type PrototypeLifecyclePatch = { kind?:string; tags?:string[]; derivedFrom?:string|null; track?:PrototypeTrack };
export type PrototypeLifecycle = { kind:string; tags:string[]; derivedFrom:string|null; track:string };
/** Столбец `tags` хранит JSON-массив; повреждённое значение читается как «тегов нет». */
const parseTags = (raw:string|null):string[] => {
  if(!raw) return [];
  try { const parsed=JSON.parse(raw); return Array.isArray(parsed)?parsed.filter((tag):tag is string=>typeof tag==="string"):[]; }
  catch { return []; }
};
const lifecycleOf = (row:{kind?:string|null;tags?:string|null;derived_from?:string|null;track?:string|null}):PrototypeLifecycle =>
  ({ kind: row.kind ?? DEFAULT_PROTOTYPE_KIND, tags: parseTags(row.tags ?? null), derivedFrom: row.derived_from ?? null, track: row.track ?? DEFAULT_PROTOTYPE_TRACK });
/**
 * Единый 422 для операций, требующих воспроизводимого снимка прототипа (P2.2):
 * publish, share-грант, visual-baseline и bundle-export. Код стабилен; операция
 * называется в сообщении (ErrorDetails — закрытый набор полей).
 */
export const HEAD_TRACKING_ERROR_CODE = "prototype_head_tracking";
export const headTrackingError = (operation:string):ApiError =>
  new ApiError(422,HEAD_TRACKING_ERROR_CODE,`Operation '${operation}' is not available for a head-tracking prototype (track: head)`);
/** Гейт для роутов вне `PrototypeRepo` (share/baseline/export): читает колонку напрямую. */
export function assertPinnedTrack(db:Database,id:string,operation:string):void {
  const row=db.query("SELECT track FROM prototypes WHERE id=?").get(id) as {track:string|null}|null;
  if((row?.track??DEFAULT_PROTOTYPE_TRACK)===HEAD_TRACK) throw headTrackingError(operation);
}
export const parseStoredPrototypeDoc = (json:string,id:string,rev:number):PrototypeDoc => {
  try { return storedPrototypeDocSchema.parse(JSON.parse(json)); }
  catch { throw new ApiError(422,"invalid_stored_revision",`Stored prototype revision is invalid: ${id} rev ${rev}`); }
};

export class PrototypeRepo {
  constructor(private db: Database) {}

  private row(id: string): PrototypeRow {
    const row = this.db.query("SELECT * FROM prototypes WHERE id = ?").get(id) as PrototypeRow | null;
    if (!row) throw missing(); return row;
  }
  private cas(id: string, baseRev: number): PrototypeRow {
    const row = this.row(id);
    if (row.head_rev !== baseRev) throw new ApiError(409, "revision_conflict", "Prototype revision has changed", { currentRev: row.head_rev });
    return row;
  }
  /** Текущий track прототипа; используется read-путями, которым строка ещё не прочитана. */
  private trackOf(id: string): string {
    const row = this.db.query("SELECT track FROM prototypes WHERE id=?").get(id) as { track: string | null } | null;
    return row?.track ?? DEFAULT_PROTOTYPE_TRACK;
  }
  /**
   * Резолв пина на последнюю active-публикацию компонента (track:"head", P2.3). Компонент без
   * ни одной active-публикации остаётся на пине ревизии: «нет головы» не должно превращать
   * трекающий док в док без компонента.
   */
  private headPin<T extends { id: string; version: number; bundleHash: string; status: string }>(pin: T): T {
    const head = this.db.query("SELECT version,bundle_hash bundleHash,status FROM component_publishes WHERE component_id=? AND status='active' ORDER BY version DESC LIMIT 1")
      .get(pin.id) as { version: number; bundleHash: string; status: string } | null;
    return head ? { ...pin, version: head.version, bundleHash: head.bundleHash, status: head.status } : pin;
  }
  /**
   * Пины ревизии. Для `track:"head"` (P2) компонентные пины резолвятся на последние
   * active-публикации прямо на read-пути, поэтому `componentManifestHash` (он считается
   * из этого же списка) автоматически согласован с тем, что отрендерится. Скоуп резолва —
   * только компоненты: `designSystemMetaVersion`/`builtinCatalogHash` остаются пином ревизии.
   */
  private pins(id: string, rev: number, track?: string): Pin[] {
    const rows = this.db.query(`SELECT c.id, c.name, prc.component_version version, cp.bundle_hash bundleHash, cp.status
      FROM prototype_revision_components prc JOIN components c ON c.id=prc.component_id
      JOIN component_publishes cp ON cp.component_id=prc.component_id AND cp.version=prc.component_version
      WHERE prc.prototype_id=? AND prc.rev=? ORDER BY c.id`).all(id, rev) as Omit<Pin,"bundleUrl">[];
    const resolved = (track ?? this.trackOf(id)) === HEAD_TRACK ? rows.map((row) => this.headPin(row)) : rows;
    return resolved.map(p => ({ ...p, bundleUrl: `/api/components/${encodeURIComponent(p.id)}/versions/${p.version}/bundle.js` }));
  }
  /** Публичный вход для readiness-отчёта (волна 4): статусы пинов и их рендерабельность. */
  bundleReadiness(id: string, rev: number): BundleReadiness {
    const resolvedPins: ResolvedPin[] = this.pins(id, rev);
    const warnings: { code: string; message: string }[] = [];
    const errors: { code: string; message: string }[] = [];
    for (const pin of resolvedPins) {
      if (!RENDERABLE_PIN_STATUS.has(pin.status)) errors.push({ code: "bundle_failed", message: `Pinned component ${pin.name} v${pin.version} is not renderable (status ${pin.status})` });
      else if (pin.status === "deprecated") warnings.push({ code: "pin_deprecated", message: `Pinned component ${pin.name} v${pin.version} is deprecated` });
      else if (pin.status === "superseded") warnings.push({ code: "pin_superseded", message: `Pinned component ${pin.name} v${pin.version} is superseded` });
      // RFC candidate-acceptance §4.3 (M7): auto-supersede оставляет ровно одну active-версию,
      // и последующий ручной `deprecated` на неё убирает active-пул целиком. Компонент без
      // active-версии не резолвится ни каталогом, ни `track:"head"` — деградация обязана быть
      // видимой. Это **warning**, а не error: закреплённая версия (superseded/deprecated)
      // продолжает рендериться, и поднятие до error перевело бы такие доки в bundleStatus
      // "failed", то есть сломало бы render-status у прототипов, которые исправно работают.
      if (!this.db.query("SELECT 1 ok FROM component_publishes WHERE component_id=? AND status='active' LIMIT 1").get(pin.id)) {
        warnings.push({ code: "component_no_active_version", message: `Component ${pin.name} has no active version; the catalog and head-tracking docs cannot resolve it` });
      }
    }
    const bundles = errors.length === 0;
    return { resolvedPins, bundles, bundleStatus: bundles ? "ready" : "failed", warnings, errors };
  }
  // Whole-revision renderability (document present + bundles ready); no external route probe.
  classifyRevision(id:string,rev:number):RevisionClassification { return classifyRevision(this.db,id,rev); }
  renderableForRev(id: string, rev: number): boolean { return this.classifyRevision(id,rev).renderable; }
  // Per-screen readiness for the render-status endpoint. Throws typed 404s for missing targets.
  screenRenderStatus(id: string, screenId: string, selector: { rev?: number; version?: number }): BundleReadiness & { rev: number; version: number | null; document: boolean; publishedVersion: number | null } {
    const proto = this.db.query("SELECT head_rev FROM prototypes WHERE id=?").get(id) as { head_rev: number } | null;
    if (!proto) throw new ApiError(404, "prototype_not_found", "Prototype not found");
    let rev: number, version: number | null = null;
    if (selector.version !== undefined) {
      const pub = this.db.query("SELECT rev FROM prototype_publishes WHERE prototype_id=? AND version=?").get(id, selector.version) as { rev: number } | null;
      if (!pub) throw new ApiError(404, "version_not_found", "Prototype version not found");
      rev = pub.rev; version = selector.version;
    } else if (selector.rev !== undefined) {
      const row = this.db.query("SELECT 1 ok FROM prototype_revisions WHERE prototype_id=? AND rev=?").get(id, selector.rev);
      if (!row) throw new ApiError(404, "revision_not_found", "Prototype revision not found");
      rev = selector.rev;
    } else rev = proto.head_rev;
    const docRow = this.db.query("SELECT doc FROM prototype_revisions WHERE prototype_id=? AND rev=?").get(id, rev) as { doc: string };
    const doc = parseStoredPrototypeDoc(docRow.doc, id, rev);
    const document = doc.screens.some((screen) => screen.id === screenId);
    if (!document) throw new ApiError(404, "screen_not_found", "Screen not found");
    const publishedVersion = (this.db.query("SELECT MAX(version) version FROM prototype_publishes WHERE prototype_id=?").get(id) as { version: number | null }).version;
    const readiness=this.bundleReadiness(id,rev);
    const classification=this.classifyRevision(id,rev);
    if(!classification.renderable) readiness.errors.push({code:classification.error.code,message:classification.error.message});
    if(!classification.renderable) { readiness.bundles=false; readiness.bundleStatus="failed"; }
    return { rev, version, document, publishedVersion, ...readiness };
  }
  private manifestHash(pins: Pin[]): string { return componentManifestHashOf(pins); }
  // Pins the latest design-system theme version onto the revision (diagnostic, like builtinCatalogHash).
  // `metaVersion` is undefined for fresh saves (resolve latest now) and explicit for restore (copy source pin).
  private insertRevision(id:string, rev:number, doc:PrototypeDoc, message:string|null, createdAt:string, metaVersion?:number|null, figmaJson:string|null=null, themePins?:Record<string,number|null>): void {
    // Пин каждой ДС документа (план §4). `themePins` задан только restore'ом — он копирует
    // пины исходной ревизии; на свежем сохранении каждая ДС резолвит свою последнюю версию.
    const systems=docDesignSystems(doc);
    const primary=primaryDesignSystem(doc);
    const pins=new Map<string,number|null>();
    const hashes:[string,string][]=[];
    let primaryHash:string|null=null;
    for(const systemId of systems) {
      const explicit=themePins&&Object.hasOwn(themePins,systemId)?themePins[systemId]!:(systemId===primary?metaVersion:undefined);
      const pin=explicit===undefined?latestDesignSystemMetaVersion(this.db,systemId):explicit;
      const system=requireActiveDesignSystem(this.db,systemId,["designSystem"]);
      const pinnedTheme=pin===null?null:getDesignSystemVersion(this.db,systemId,pin);
      if(pin!==null&&!pinnedTheme) throw new ApiError(422,"validation_failed","Pinned design-system theme version does not exist",{issues:[{path:["designSystem"],message:`Unknown theme version ${pin} for ${systemId}`}]});
      // Резолвер spacing-шкалы — свойство пиннутой версии темы (миграция v23, план P6.3б).
      const resolvedSpaceScale=resolveSpacingScale(systemId,pinnedTheme?.tokens??{},pinnedTheme?.spacingResolver);
      const hash=builtinCatalogHashFor(systemId,system.definitions,resolvedSpaceScale);
      if(systemId===primary) primaryHash=hash;
      pins.set(systemId,pin);
      hashes.push([systemId,hash]);
    }
    // Одна ДС — байт-в-байт сегодняшнее значение. Две и больше — детерминированный хэш по
    // отсортированному множеству `(ds, metaVersion, per-ds hash)` (план §4, «производные пина»).
    const builtinHash=hashes.length===1?primaryHash!
      :new Bun.CryptoHasher("sha256").update(JSON.stringify([...hashes].sort(([a],[b])=>a.localeCompare(b)).map(([systemId,hash])=>[systemId,pins.get(systemId)??null,hash]))).digest("hex");
    this.db.query(`INSERT INTO prototype_revisions
      (prototype_id,rev,doc,builtin_catalog_hash,design_system_meta_version,figma_json,message,created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id,rev,JSON.stringify(doc),builtinHash,pins.get(primary)??null,figmaJson,message,createdAt);
    const insertPin=this.db.query("INSERT INTO prototype_revision_theme_pins (prototype_id,rev,design_system,meta_version) VALUES (?,?,?,?)");
    for(const [systemId,pin] of pins) insertPin.run(id,rev,systemId,pin);
  }
  private insertPins(id:string,rev:number,pins:ComponentPin[]):void {
    for(const pin of pins) {
      const alive=this.db.query("SELECT 1 ok FROM components WHERE id=? AND deleted_at IS NULL").get(pin.id);
      if(!alive) throw new ApiError(409,"component_changed","A component was deleted while saving");
      this.db.query("INSERT INTO prototype_revision_components (prototype_id,rev,component_id,component_version) VALUES (?,?,?,?)").run(id,rev,pin.id,pin.version);
    }
  }
  /**
   * Пины композиций ревизии (волна 5). FK RESTRICT на `composition_publishes`
   * гарантирует, что закреплённая публикация композиции не исчезнет из-под ревизии.
   */
  private insertCompositionPins(id:string,rev:number,pins:CompositionPin[]):void {
    for(const pin of pins) {
      const alive=this.db.query("SELECT 1 ok FROM compositions WHERE id=? AND deleted_at IS NULL").get(pin.id);
      if(!alive) throw new ApiError(409,"composition_changed","A composition was deleted while saving");
      this.db.query("INSERT INTO prototype_revision_compositions (prototype_id,rev,composition_id,composition_version) VALUES (?,?,?,?)").run(id,rev,pin.id,pin.version);
    }
  }
  /** Закреплённые композиции ревизии вместе с их документами (для раскрытия на клиенте). */
  private compositions(id:string,rev:number) {
    const {docs,pins}=pinnedCompositionDocs(this.db,id,rev);
    return pins.map(pin=>({...pin,doc:docs[pin.id]!}));
  }
  private insertAssetPins(id:string,rev:number,assetIds:string[]):void {
    for(const assetId of assetIds) {
      const exists=this.db.query("SELECT 1 ok FROM assets WHERE id=?").get(assetId);
      if(!exists) throw new ApiError(422,"asset_not_found","A referenced asset does not exist",{issues:[{path:["screens"],message:`unknown asset: ${assetId}`}]});
      this.db.query("INSERT OR IGNORE INTO prototype_revision_assets (prototype_id,rev,asset_id) VALUES (?,?,?)").run(id,rev,assetId);
    }
  }
  private assets(id:string,rev:number) {
    return this.db.query(`SELECT a.id,a.sha256,a.mime,a.size FROM prototype_revision_assets pra
      JOIN assets a ON a.id=pra.asset_id WHERE pra.prototype_id=? AND pra.rev=? ORDER BY a.id`).all(id,rev) as {id:string;sha256:string;mime:string;size:number}[];
  }
  create(doc: PrototypeDoc, message?: string,pins:ComponentPin[]=[],assetIds:string[]=[],figmaJson:string|null=null,ownerId:string|null=null,lifecycle:PrototypeLifecyclePatch={},compositionPins:CompositionPin[]=[]): {id:string;rev:1} {
    return this.db.transaction(() => {
      if (this.db.query("SELECT 1 ok FROM prototypes WHERE id=?").get(doc.id)) throw new ApiError(409,"already_exists","Prototype already exists");
      const at=now();
      this.db.query(`INSERT INTO prototypes (id,name,description,device,screen_count,head_rev,design_system,instance_id,created_at,updated_at,owner_id,kind,tags,derived_from)
        VALUES (?,?,?,?,?,1,?,?,?,?,?,?,?,?)`).run(doc.id,doc.name,doc.description??null,doc.device,doc.screens.length,doc.designSystem,crypto.randomUUID(),at,at,ownerId,
        lifecycle.kind??DEFAULT_PROTOTYPE_KIND,lifecycle.tags?.length?JSON.stringify(lifecycle.tags):null,lifecycle.derivedFrom??null);
      this.insertRevision(doc.id,1,doc,message??null,at,undefined,figmaJson);
      this.insertPins(doc.id,1,pins);
      this.insertCompositionPins(doc.id,1,compositionPins);
      this.insertAssetPins(doc.id,1,assetIds);
      return {id:doc.id,rev:1 as const};
    })();
  }
  save(id:string, doc:PrototypeDoc, baseRev:number, message?:string,pins:ComponentPin[]=[],assetIds:string[]=[],figmaJson:string|null=null,compositionPins:CompositionPin[]=[]): {rev:number} {
    return this.db.transaction(() => {
      const head=this.cas(id,baseRev); const rev=head.head_rev+1; const at=now();
      this.insertRevision(id,rev,doc,message??null,at,undefined,figmaJson);
      this.insertPins(id,rev,pins);
      this.insertCompositionPins(id,rev,compositionPins);
      this.insertAssetPins(id,rev,assetIds);
      this.db.query(`UPDATE prototypes SET name=?,description=?,device=?,screen_count=?,head_rev=?,design_system=?,updated_at=? WHERE id=?`)
        .run(doc.name,doc.description??null,doc.device,doc.screens.length,rev,doc.designSystem,at,id);
      return {rev};
    })();
  }
  restore(id:string, sourceRev:number, baseRev:number): {rev:number} {
    return this.db.transaction(() => {
      const head=this.cas(id,baseRev);
      const source=this.db.query("SELECT doc,design_system_meta_version,figma_json FROM prototype_revisions WHERE prototype_id=? AND rev=?").get(id,sourceRev) as {doc:string;design_system_meta_version:number|null;figma_json:string|null}|null;
      if (!source) throw new ApiError(404,"revision_not_found","Prototype revision not found");
      const doc=parseStoredPrototypeDoc(source.doc,id,sourceRev); const rev=head.head_rev+1; const at=now();
      // Принадлежность пина — **множеству** ДС документа (план §4): у мульти-поверхностного
      // дока компоненты второй поверхности законно живут в её собственной системе.
      const systems=docDesignSystems(doc);
      const mismatched=this.db.query(`SELECT c.name FROM prototype_revision_components prc
        JOIN components c ON c.id=prc.component_id
        JOIN component_publishes cp ON cp.component_id=prc.component_id AND cp.version=prc.component_version
        JOIN component_revisions cr ON cr.component_id=cp.component_id AND cr.rev=cp.rev
        WHERE prc.prototype_id=? AND prc.rev=? AND cr.design_system NOT IN (${systems.map(()=>"?").join(",")}) LIMIT 1`).get(id,sourceRev,...systems) as {name:string}|null;
      if(mismatched) throw new ApiError(422,"validation_failed","Prototype document is invalid",{issues:[{path:["screens"],message:`Component pin belongs to a different design system: ${mismatched.name}`}]});
      // Пины темы копируются из исходной ревизии (read-правило покрывает до-миграционные строки).
      this.insertRevision(id,rev,doc,`Restore revision ${sourceRev}`,at,source.design_system_meta_version,source.figma_json,
        themePinsOf(this.db,id,sourceRev,doc,source.design_system_meta_version));
      this.db.query(`INSERT INTO prototype_revision_components (prototype_id,rev,component_id,component_version)
        SELECT prototype_id,?,component_id,component_version FROM prototype_revision_components WHERE prototype_id=? AND rev=?`).run(rev,id,sourceRev);
      this.db.query(`INSERT INTO prototype_revision_assets (prototype_id,rev,asset_id)
        SELECT prototype_id,?,asset_id FROM prototype_revision_assets WHERE prototype_id=? AND rev=?`).run(rev,id,sourceRev);
      this.db.query(`INSERT INTO prototype_revision_compositions (prototype_id,rev,composition_id,composition_version)
        SELECT prototype_id,?,composition_id,composition_version FROM prototype_revision_compositions WHERE prototype_id=? AND rev=?`).run(rev,id,sourceRev);
      this.db.query(`UPDATE prototypes SET name=?,description=?,device=?,screen_count=?,head_rev=?,design_system=?,updated_at=? WHERE id=?`)
        .run(doc.name,doc.description??null,doc.device,doc.screens.length,rev,doc.designSystem,at,id);
      return {rev};
    })();
  }
  publish(id:string,baseRev:number,message?:string): {version:number;rev:number} {
    return this.db.transaction(() => {
      const head=this.cas(id,baseRev);
      // Трекающая ревизия резолвит пины на read-пути и потому не иммутабельна; публиковать
      // из неё нечего — версия обязана быть воспроизводимой (P2.2).
      if(head.track===HEAD_TRACK) throw headTrackingError("publish");
      const doc=parseStoredPrototypeDoc((this.db.query("SELECT doc FROM prototype_revisions WHERE prototype_id=? AND rev=?").get(id,head.head_rev) as {doc:string}).doc,id,head.head_rev);
      // Определения — объединение по всем ДС документа: тип второй поверхности резолвится
      // её системой (принадлежность конкретной поверхности проверяет валидация save-пути).
      const systems=docDesignSystems(doc);
      const definitions=Object.assign({},...systems.map(systemId=>requireActiveDesignSystem(this.db,systemId,["designSystem"]).definitions)) as Record<string,unknown>;
      const customTypes=new Set(doc.screens.flatMap(s=>Object.values(s.spec.elements).map(e=>e.type)));
      const pinRows=this.db.query(`SELECT c.name,cr.design_system designSystem FROM prototype_revision_components p
        JOIN components c ON c.id=p.component_id
        JOIN component_publishes cp ON cp.component_id=p.component_id AND cp.version=p.component_version
        JOIN component_revisions cr ON cr.component_id=cp.component_id AND cr.rev=cp.rev
        WHERE p.prototype_id=? AND p.rev=?`).all(id,head.head_rev) as {name:string;designSystem:string}[];
      const mismatched=pinRows.find(pin=>!systems.includes(pin.designSystem));
      if(mismatched) throw new ApiError(422,"validation_failed","Prototype document is invalid",{issues:[{path:["screens"],message:`Component pin belongs to a different design system: ${mismatched.name}`}]});
      const pinned=new Set(pinRows.map(x=>x.name));
      for(const type of customTypes) if(!Object.hasOwn(definitions,type)&&!hostPrimitiveNames.has(type)&&!pinned.has(type)) throw new ApiError(422,"validation_failed","Prototype references an unpublished custom component",{issues:[{path:["screens"],message:`Unpublished custom component: ${type}`}]});
      // Композиции публикуемой ревизии обязаны быть закреплены: раскрытие идёт в save-пути,
      // поэтому отсутствующий пин означает документ, сохранённый в обход (B3).
      const pinnedCompositions=new Set((this.db.query("SELECT composition_id id FROM prototype_revision_compositions WHERE prototype_id=? AND rev=?").all(id,head.head_rev) as {id:string}[]).map(row=>row.id));
      for(const ref of collectCompositionRefs(doc)) if(!pinnedCompositions.has(ref.compositionId)) throw new ApiError(422,"validation_failed","Prototype references an unpinned composition",{issues:[{path:["screens"],message:`Unpinned composition: ${ref.compositionId}`}]});
      const duplicate=this.db.query("SELECT version FROM prototype_publishes WHERE prototype_id=? AND rev=?").get(id,head.head_rev) as {version:number}|null;
      if (duplicate) throw new ApiError(409,"already_published","This revision is already published",{currentRev:head.head_rev,currentVersion:duplicate.version});
      const latest=this.db.query("SELECT MAX(version) version FROM prototype_publishes WHERE prototype_id=?").get(id) as {version:number|null};
      const version=(latest.version??0)+1;
      this.db.query("INSERT INTO prototype_publishes (prototype_id,version,rev,message,published_at) VALUES (?,?,?,?,?)").run(id,version,head.head_rev,message??null,now());
      return {version,rev:head.head_rev};
    })();
  }
  delete(id:string,baseRev:number): void { this.db.transaction(()=>{
    this.cas(id,baseRev);
    const sets=this.db.query("SELECT members_json FROM visual_baseline_sets WHERE prototype_id=?").all(id) as {members_json:string}[];
    const references=new Set<string>();
    for(const set of sets) for(const member of JSON.parse(set.members_json) as {referenceId:string}[]) references.add(member.referenceId);
    const tombstone=this.db.query("UPDATE visual_references SET deleted_at=? WHERE id=? AND deleted_at IS NULL");
    const at=now(); for(const referenceId of references) tombstone.run(at,referenceId);
    this.db.query("DELETE FROM visual_baseline_sets WHERE prototype_id=?").run(id);
    this.db.query("DELETE FROM prototypes WHERE id=?").run(id);
  })(); }
  // `kinds` — необязательный фильтр по lifecycle-виду (?kind= CSV на роуте). Пустой/отсутствующий
  // список означает «все виды», поэтому старые клиенты видят ровно то же, что и раньше.
  list(principal?: Principal, kinds?: readonly string[]) {
    const userId=principal?.kind==="user"?principal.userId:"";
    const filter=kinds?.length?` AND COALESCE(p.kind,'${DEFAULT_PROTOTYPE_KIND}') IN (${kinds.map(()=>"?").join(",")})`:"";
    // `flow_count` считается json1 прямо по документу головной ревизии: сценарии нужны
    // галерее в мете карточки, а отдельная колонка потребовала бы миграции и бэкфила
    // ради числа, которое SQLite достаёт из уже прочитанной строки.
    const rows=this.db.query(`SELECT p.*,u.id owner_user_id,u.name owner_name,
      (SELECT MAX(version) FROM prototype_publishes x WHERE x.prototype_id=p.id) latest_version,
      COALESCE((SELECT json_array_length(r.doc,'$.flows') FROM prototype_revisions r WHERE r.prototype_id=p.id AND r.rev=p.head_rev),0) flow_count
      FROM prototypes p JOIN users u ON u.id=p.owner_id
      WHERE (?=1 OR p.owner_id=? OR p.status='published')${filter} ORDER BY p.updated_at DESC,p.id`)
      .all(principal?0:1,userId,...(kinds??[])) as (PrototypeRow&{latest_version:number|null;flow_count:number;owner_user_id:string;owner_name:string})[];
    return rows.map(r=>({id:r.id,name:r.name,description:r.description??undefined,device:r.device,designSystem:r.design_system,screenCount:r.screen_count,flowCount:r.flow_count,headRev:r.head_rev,latestVersion:r.latest_version,updatedAt:r.updated_at,status:r.status,owner:{id:r.owner_user_id,name:r.owner_name},...lifecycleOf(r)}));
  }
  meta(id:string,principal?:Principal) {
    const access=principal?requirePrototypeRead(this.db,id,principal):{owner:true};
    const r=this.row(id); const versions=this.versions(id); const latest=versions.at(-1)??null;
    const publishedVersion=latest?.version??null;
    const headClassification=this.classifyRevision(id,r.head_rev);
    const publishedClassification=latest?this.classifyRevision(id,latest.rev):null;
    return {
      id:r.id,name:r.name,designSystem:r.design_system,headRev:r.head_rev,
      prototypeInstanceId:r.instance_id,
      latestVersion:publishedVersion,versions,updatedAt:r.updated_at,
      draftRevision:r.head_rev,
      validatedRevision:latestValidatedRev(this.db,"prototype",id),
      publishedVersion,
      renderable:{head:headClassification.renderable,published:publishedClassification?.renderable??null},
      renderErrors:{head:headClassification.error,published:publishedClassification?.error??null},
      status:r.status,owner:{id:r.owner_id??"",name:(this.db.query("SELECT name FROM users WHERE id=?").get(r.owner_id) as {name:string}|null)?.name??"Unknown"},
      ...lifecycleOf(r),
      ...(access.owner?{figma:parseFigmaStored(this.revisionRow(id,r.head_rev).figma_json)}:{}),
    };
  }
  lifecycle(id:string):PrototypeLifecycle { return lifecycleOf(this.row(id)); }
  /** Число опубликованных версий прототипа — точка контроля обоих гейтов P2/P9. */
  private publishCount(id:string):number {
    return (this.db.query("SELECT COUNT(*) n FROM prototype_publishes WHERE prototype_id=?").get(id) as {n:number}).n;
  }
  /**
   * Аддитивный патч: отсутствующее поле не меняется, `derivedFrom: null` очищает связь.
   *
   * Гейты волны W3 (план 2026-08-02):
   * - `track:"head"` — только служебный `kind` и только пока прототип не опубликован
   *   (трекающая ревизия перестаёт быть иммутабельной, а версия обязана ею остаться);
   * - переход в служебный `kind` при наличии публикаций запрещён — иначе это
   *   самообслуживаемое снятие валидаторов и readiness-порога задним числом (P9).
   */
  setLifecycle(id:string,patch:PrototypeLifecyclePatch):PrototypeLifecycle {
    const row=this.row(id);
    if(patch.derivedFrom===id) throw new ApiError(422,"validation_failed","Prototype lifecycle is invalid",{issues:[{path:["derivedFrom"],message:"must not reference the prototype itself"}]});
    const nextKind=patch.kind??row.kind??DEFAULT_PROTOTYPE_KIND;
    const nextTrack=patch.track??row.track??DEFAULT_PROTOTYPE_TRACK;
    const wasService=isServicePrototypeDocKind(row.kind??DEFAULT_PROTOTYPE_KIND);
    if(patch.kind!==undefined&&patch.kind!==row.kind&&isServicePrototypeDocKind(patch.kind)&&!wasService&&this.publishCount(id)>0)
      throw new ApiError(422,"service_kind_requires_unpublished",`Cannot switch a published prototype to the service kind '${patch.kind}'`);
    if(nextTrack===HEAD_TRACK) {
      if(!isServicePrototypeDocKind(nextKind)) throw new ApiError(422,"track_requires_service_kind",`Head tracking requires a service prototype kind, got '${nextKind}'`);
      if(this.publishCount(id)>0) throw new ApiError(422,"track_requires_unpublished","Head tracking is not allowed on a prototype that has published versions");
    }
    const next:PrototypeLifecycle={
      kind:patch.kind??row.kind??DEFAULT_PROTOTYPE_KIND,
      tags:patch.tags??parseTags(row.tags),
      derivedFrom:patch.derivedFrom===undefined?row.derived_from??null:patch.derivedFrom,
      track:patch.track??row.track??DEFAULT_PROTOTYPE_TRACK,
    };
    this.db.query("UPDATE prototypes SET kind=?,tags=?,derived_from=?,track=?,updated_at=? WHERE id=?")
      .run(next.kind,next.tags.length?JSON.stringify(next.tags):null,next.derivedFrom,next.track,now(),id);
    return next;
  }
  /**
   * `track`/`resolvedAt` в DTO ревизии (P2.3): `resolvedAt` — момент резолва head-пинов,
   * `null` для обычных (pinned) доков, где пины иммутабельны и «момента резолва» нет.
   */
  private trackFields(track:string) { return {track, resolvedAt: track===HEAD_TRACK?now():null}; }
  draft(id:string,principal?:Principal) { const r=this.row(id); const access=principal?requirePrototypeRead(this.db,id,principal):{owner:true}; const x=this.revisionRow(id,r.head_rev); const components=this.pins(id,r.head_rev,r.track); const classification=this.classifyRevision(id,r.head_rev); const doc=parseStoredPrototypeDoc(x.doc,id,x.rev); return {...this.trackFields(r.track),doc,designSystemMetaVersions:themePinsOf(this.db,id,x.rev,doc,x.design_system_meta_version),rev:x.rev,prototypeInstanceId:r.instance_id,builtinCatalogHash:x.builtin_catalog_hash,componentManifestHash:this.manifestHash(components),components,compositions:this.compositions(id,r.head_rev),assets:this.assets(id,r.head_rev),designSystemMetaVersion:x.design_system_meta_version,renderable:classification.renderable,renderError:classification.error,...(access.owner?{figma:parseFigmaStored(x.figma_json)}:{})}; }
  revisions(id:string,limit:number,before?:number) { this.row(id); const sql=`SELECT rev,message,created_at FROM prototype_revisions WHERE prototype_id=? ${before!==undefined?"AND rev < ?":""} ORDER BY rev DESC LIMIT ?`; const rows=(before!==undefined?this.db.query(sql).all(id,before,limit):this.db.query(sql).all(id,limit)) as {rev:number;message:string|null;created_at:string}[]; return rows.map(r=>({rev:r.rev,message:r.message,createdAt:r.created_at})); }
  private revisionRow(id:string,rev:number): RevisionRow { const r=this.db.query("SELECT rev,doc,builtin_catalog_hash,design_system_meta_version,figma_json,message,created_at FROM prototype_revisions WHERE prototype_id=? AND rev=?").get(id,rev) as RevisionRow|null; if(!r) throw new ApiError(404,"revision_not_found","Prototype revision not found"); return r; }
  revision(id:string,rev:number,principal?:Principal) { const proto=this.row(id); const owner=!principal||prototypeAccess(this.db,id,principal).owner; const r=this.revisionRow(id,rev); const components=this.pins(id,rev,proto.track); const classification=this.classifyRevision(id,rev); const doc=parseStoredPrototypeDoc(r.doc,id,r.rev); return {...this.trackFields(proto.track),rev:r.rev,prototypeInstanceId:proto.instance_id,doc,designSystemMetaVersions:themePinsOf(this.db,id,r.rev,doc,r.design_system_meta_version),builtinCatalogHash:r.builtin_catalog_hash,componentManifestHash:this.manifestHash(components),components,compositions:this.compositions(id,rev),assets:this.assets(id,rev),designSystemMetaVersion:r.design_system_meta_version,renderable:classification.renderable,renderError:classification.error,...(owner?{figma:parseFigmaStored(r.figma_json)}:{}),message:r.message,createdAt:r.created_at}; }
  versions(id:string) { this.row(id); return (this.db.query("SELECT version,rev,published_at FROM prototype_publishes WHERE prototype_id=? ORDER BY version").all(id) as {version:number;rev:number;published_at:string}[]).map(r=>{const classification=this.classifyRevision(id,r.rev);return {version:r.version,rev:r.rev,publishedAt:r.published_at,renderable:classification.renderable,renderError:classification.error};}); }
  version(id:string,version:number,principal?:Principal) { const proto=this.row(id); const owner=!principal||requirePrototypeRead(this.db,id,principal).owner; const p=this.db.query("SELECT rev,published_at FROM prototype_publishes WHERE prototype_id=? AND version=?").get(id,version) as {rev:number;published_at:string}|null; if(!p) throw new ApiError(404,"version_not_found","Prototype version not found"); const r=this.revisionRow(id,p.rev); const components=this.pins(id,p.rev,proto.track); const classification=this.classifyRevision(id,p.rev); const doc=parseStoredPrototypeDoc(r.doc,id,r.rev); return {...this.trackFields(proto.track),version,rev:p.rev,prototypeInstanceId:proto.instance_id,doc,designSystemMetaVersions:themePinsOf(this.db,id,r.rev,doc,r.design_system_meta_version),builtinCatalogHash:r.builtin_catalog_hash,componentManifestHash:this.manifestHash(components),components,compositions:this.compositions(id,p.rev),assets:this.assets(id,p.rev),designSystemMetaVersion:r.design_system_meta_version,renderable:classification.renderable,renderError:classification.error,...(owner?{figma:parseFigmaStored(r.figma_json)}:{}),publishedAt:p.published_at}; }
  setStatus(id:string,status:"private"|"published"|"archived") {
    const row=this.row(id); if(row.status===status) throw new ApiError(422,"invalid_transition",`Cannot transition ${row.status} → ${status}`);
    const allowed:Record<PrototypeRow["status"],PrototypeRow["status"][]>={private:["published","archived"],published:["private","archived"],archived:["private"]};
    if(!allowed[row.status].includes(status)) throw new ApiError(422,"invalid_transition",`Cannot transition ${row.status} → ${status}`);
    if(row.status==="archived"&&status==="private"&&!this.classifyRevision(id,row.head_rev).renderable) throw new ApiError(409,"prototype_not_renderable","Archived prototype head is not renderable");
    this.db.query("UPDATE prototypes SET status=?,updated_at=? WHERE id=?").run(status,now(),id);
    return {status};
  }
}
