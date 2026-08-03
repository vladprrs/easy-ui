import type { Database } from "bun:sqlite";
import { normalizeDefinitions, type ComponentDefinition } from "../src/catalog/definitions";
import { normalizeEvents } from "../src/catalog/normalize";
import { isAssetId, type PrototypeDoc } from "../src/prototype/schema";
import { importPublished } from "./components/pipeline";
import { getLatestDesignSystemContent, requireActiveDesignSystem } from "./designSystems";
import { ApiError } from "./http";
import { hostPrimitiveDefinitions, hostPrimitiveNames } from "../src/catalog/hostPrimitives/definitions";
import { collectCompositionRefs, expandCompositions, type CompositionCatalogEntry } from "../src/prototype/composition";
import { resolveCompositionPins, type ComponentDependencyPin, type CompositionDependencyPin } from "./repos/compositions";
import { docSurfaces, surfaceDesignSystem, surfaceOf } from "../src/prototype/surfaces";
import type { ComponentLayout } from "../src/designSystems/types";

// Walks every element prop looking for {"$asset":"<id>"} directives, returning the referenced ids.
export function collectAssetIds(doc:PrototypeDoc):string[] {
  const ids=new Set<string>();
  const walk=(value:unknown):void => {
    if(Array.isArray(value)) { value.forEach(walk); return; }
    if(typeof value!=="object"||value===null) return;
    const record=value as Record<string,unknown>;
    if(Object.keys(record).length===1&&typeof record.$asset==="string") { if(isAssetId(record.$asset)) ids.add(record.$asset); return; }
    for(const item of Object.values(record)) walk(item);
  };
  for(const screen of doc.screens) for(const element of Object.values(screen.spec.elements)) walk(element.props);
  return [...ids];
}

// Collects and validates asset references in a document before its save transaction. A referenced
// asset that does not exist is a 422 (asset_not_found) so pins never dangle. Returns the ids to pin.
export function collectAndValidateAssetRefs(db:Database,doc:PrototypeDoc):string[] {
  const ids=collectAssetIds(doc);
  const missing=ids.filter(id=>!db.query("SELECT 1 ok FROM assets WHERE id=?").get(id));
  if(missing.length) throw new ApiError(422,"asset_not_found","Prototype references assets that do not exist",{issues:missing.map(id=>({path:["screens"],message:`unknown asset: ${id}`}))});
  return ids;
}

// Scans compiled/source text for /api/assets/asset_<sha256> string references (component publish).
const ASSET_URL_PATTERN=/\/api\/assets\/(asset_[0-9a-f]{64})/g;
export function collectAssetIdsFromSource(source:string):string[] {
  const ids=new Set<string>();
  for(const match of source.matchAll(ASSET_URL_PATTERN)) ids.add(match[1]!);
  return [...ids];
}

export function collectAndValidateComponentAssetRefs(db:Database,source:string):string[] {
  const ids=collectAssetIdsFromSource(source);
  const missing=ids.filter(id=>!db.query("SELECT 1 ok FROM assets WHERE id=?").get(id));
  if(missing.length) throw new ApiError(422,"asset_not_found","Component references assets that do not exist",{issues:missing.map(id=>({path:["source"],message:`unknown asset: ${id}`}))});
  return ids;
}

export type CompositionPin=CompositionDependencyPin;

// The composition expander in src/ is deliberately v1-shaped. Keeping the recursive orchestration
// here lets the server accept v2 documents without changing the v1 client/runtime contract.
const COMPOSITION_EXPANSION_PASSES = 5;
const compositionComponentPins = new WeakMap<object, Map<string, ComponentDependencyPin>>();

/**
 * Роли `canonicalFor` активных компонентов ДС по имени типа (W8c). Слоты композиции могут
 * требовать роль (`allowedRoles`), а глоссарий и `definition_meta` живут только на сервере —
 * поэтому карта собирается здесь и передаётся в раскрытие save-пути.
 */
export function componentCanonicalRoles(db: Database, designSystem: string): Record<string, string[]> {
  const rows = db.query(`SELECT c.name name, p.definition_meta definitionMeta
    FROM components c JOIN component_publishes p ON p.component_id=c.id AND p.status='active'
    JOIN component_revisions r ON r.component_id=p.component_id AND r.rev=p.rev
    WHERE r.design_system=? AND c.deleted_at IS NULL`).all(designSystem) as { name: string; definitionMeta: string }[];
  const roles: Record<string, string[]> = {};
  for (const row of rows) {
    try {
      const meta = JSON.parse(row.definitionMeta) as { canonicalFor?: unknown };
      if (Array.isArray(meta.canonicalFor)) roles[row.name] = meta.canonicalFor.filter((value): value is string => typeof value === "string");
    } catch { /* invalid legacy metadata is reported by its own validation path */ }
  }
  return roles;
}

/**
 * Layout-контракты v1 активных компонентов ДС по имени типа (W8e). Token layout элемента
 * тела v3 компилируется в props **детерминированно**, а эта карта нужна только для
 * диагностики `composition/layout-unsupported` в save-пути.
 */
export function componentLayoutContracts(db: Database, designSystem: string): Record<string, ComponentLayout | undefined> {
  const rows = db.query(`SELECT c.name name, p.definition_meta definitionMeta
    FROM components c JOIN component_publishes p ON p.component_id=c.id AND p.status='active'
    JOIN component_revisions r ON r.component_id=p.component_id AND r.rev=p.rev
    WHERE r.design_system=? AND c.deleted_at IS NULL`).all(designSystem) as { name: string; definitionMeta: string }[];
  const layouts: Record<string, ComponentLayout | undefined> = {};
  for (const row of rows) {
    try {
      const meta = JSON.parse(row.definitionMeta) as { layout?: ComponentLayout };
      if (meta.layout && typeof meta.layout === "object") layouts[row.name] = meta.layout;
    } catch { /* invalid legacy metadata is reported by its own validation path */ }
  }
  return layouts;
}

function expandNestedCompositions(doc: PrototypeDoc, compositions: Record<string, CompositionCatalogEntry>, componentRoles?: Record<string, string[]>, componentLayouts?: Record<string, ComponentLayout | undefined>): PrototypeDoc {
  let current = doc;
  for (let pass = 0; pass <= COMPOSITION_EXPANSION_PASSES; pass += 1) {
    const expanded = expandCompositions(current, { compositions, designSystem: current.designSystem, componentRoles, componentLayouts });
    if (expanded.issues.length) {
      throw new ApiError(422, "validation_failed", "Prototype document is invalid", {
        issues: expanded.issues.map((issue) => ({ path: issue.path.split("/").filter(Boolean), message: issue.message })),
      });
    }
    current = expanded.doc;
    if (!collectCompositionRefs(current).length) return current;
    if (pass === COMPOSITION_EXPANSION_PASSES) {
      throw new ApiError(422, "validation_failed", "Composition nesting exceeds the supported expansion depth", {
        issues: [{ path: ["screens"], message: "composition nesting exceeds the depth limit of 5" }],
      });
    }
  }
  return current;
}

/**
 * Композиции v1 допустимы только на экранах, чья ДС совпадает с `doc.designSystem`
 * (план §4, R1-M9/R2-M1/R3-M4): резолвер композиций (`resolveCompositionPins`) —
 * однодизайнсистемный, а per-screen резолв отложен в v2. Стабильный код 422.
 */
export const COMPOSITION_FOREIGN_DESIGN_SYSTEM_CODE="composition_foreign_design_system";
function assertCompositionsOnPrimarySurface(doc:PrototypeDoc,refs:{screenId:string;compositionId:string}[]):void {
  const foreign=refs.filter(ref=>(surfaceDesignSystem(surfaceOf(doc,ref.screenId),doc)??doc.designSystem)!==doc.designSystem);
  if(!foreign.length) return;
  throw new ApiError(422,COMPOSITION_FOREIGN_DESIGN_SYSTEM_CODE,
    "Compositions are only supported on screens whose design system matches the document design system",
    {issues:foreign.map(ref=>({path:["screens"],message:`composition ${ref.compositionId} is placed on screen '${ref.screenId}' of a foreign design system`}))});
}

/**
 * Раскрытие композиций в **save-пути** (волна 5, B3 адверсариального ревью).
 *
 * Порядок обязателен: сначала раскрытие, потом `snapshotDefinitions` и
 * `collectAndValidateAssetRefs`. Компонент или ассет, встречающийся только внутри
 * композиции, обязан попасть в `prototype_revision_components` /
 * `prototype_revision_assets` — иначе FK-RESTRICT инвариант этих таблиц обходится
 * и неизменяемая опубликованная версия ссылается на удаляемый компонент.
 *
 * В БД сохраняется **авторский** документ (с `@eui/Composition`), пины — от раскрытого.
 */
export function expandPrototypeForSave(db:Database,doc:PrototypeDoc):{doc:PrototypeDoc;pins:CompositionPin[];compositions:Record<string,CompositionCatalogEntry>} {
  const refs=collectCompositionRefs(doc);
  if(!refs.length) return {doc,pins:[],compositions:{}};
  assertCompositionsOnPrimarySurface(doc,refs);
  const {docs,sources,pins,componentPins,missing}=resolveCompositionPins(db,refs.map(ref=>ref.compositionId),doc.designSystem);
  if(missing.length) throw new ApiError(422,"validation_failed","Prototype references compositions that are unavailable",
    {issues:missing.map(entry=>({path:["screens"],message:entry.reason}))});
  const expanded=expandNestedCompositions(doc,sources,componentCanonicalRoles(db,doc.designSystem),componentLayoutContracts(db,doc.designSystem));
  if(componentPins.length) compositionComponentPins.set(expanded, new Map(componentPins.map((pin) => [pin.name, pin])));
  return {doc:expanded,pins,compositions:docs};
}

/**
 * Канал тем в валидацию (план D9): карта «ДС документа → её тема». Save-путь пинует
 * последние версии тем, поэтому здесь читается именно последнее содержимое. Warnings D9
 * эмитятся **только** когда эта карта передана — то есть только серверной валидацией.
 */
export function themesForDoc(db:Database,doc:PrototypeDoc):Record<string,{fonts?:{family?:unknown}[]}> {
  const themes:Record<string,{fonts?:{family?:unknown}[]}>={};
  for(const surface of docSurfaces(doc)) {
    const systemId=surfaceDesignSystem(surface,doc)??doc.designSystem;
    if(themes[systemId]) continue;
    try { const content=getLatestDesignSystemContent(db,systemId); themes[systemId]={fonts:content.fonts}; }
    catch { themes[systemId]={fonts:[]}; }
  }
  return themes;
}

export type ComponentPin={id:string;name:string;version:number;bundleHash:string;sourcePath:string};
/**
 * Снимок определений документа (план multi-surface-flows §4, «резолв компонентов при сохранении»).
 *
 * Резолв идёт **по множеству ДС документа**: тип экрана резолвится в ДС его поверхности.
 * `components.name` глобально UNIQUE (миграция v1), поэтому плоские name-keyed карты остаются
 * корректными, а per-surface резолв — это политика: тип, принадлежащий чужой ДС, на экране не
 * резолвится и даёт тот же 422, что неизвестный тип.
 *
 * Документ без `surfaces` даёт ровно одну группу (все экраны, ДС документа) — поведение,
 * порядок пинов и содержимое `definitions` байт-в-байт как раньше.
 */
export async function snapshotDefinitions(db:Database,doc:PrototypeDoc,dataDir:string):Promise<{definitions:Record<string,ComponentDefinition>;pins:ComponentPin[];definitionsBySurface:Record<string,Record<string,ComponentDefinition>>}> {
  const surfaces=docSurfaces(doc);
  const compositionPins=compositionComponentPins.get(doc);
  const pins:ComponentPin[]=[]; const pinnedIds=new Set<string>();
  const builtinBySurface=new Map<string,Record<string,ComponentDefinition>>();
  const customBySurface=new Map<string,Record<string,ComponentDefinition>>();
  const allCustom:Record<string,ComponentDefinition>={};
  for(const surface of surfaces) {
    const designSystem=surfaceDesignSystem(surface,doc)??doc.designSystem;
    const builtin=requireActiveDesignSystem(db,designSystem,["designSystem"]).definitions;
    builtinBySurface.set(surface.id,builtin);
    const screens=doc.screens.filter(screen=>surfaceOf(doc,screen.id).id===surface.id);
    const types=new Set(screens.flatMap(s=>Object.values(s.spec.elements).map(e=>e.type)).filter(t=>!Object.hasOwn(builtin,t)&&!hostPrimitiveNames.has(t)));
    const custom:Record<string,ComponentDefinition>={};
    for(const name of [...types].sort()) {
      const pinned=compositionPins?.get(name);
      const row=pinned
        ? db.query(`SELECT c.id,c.name,cp.version,cp.rev,cp.bundle_hash bundleHash,cr.source
            FROM components c JOIN component_publishes cp ON cp.component_id=c.id AND cp.version=?
            JOIN component_revisions cr ON cr.component_id=cp.component_id AND cr.rev=cp.rev
            WHERE c.id=? AND cr.design_system=?`).get(pinned.version,pinned.id,designSystem) as {id:string;name:string;version:number;rev:number;bundleHash:string;source:string}|null
        : db.query(`SELECT c.id,c.name,cp.version,cp.rev,cp.bundle_hash bundleHash,cr.source
            FROM components c JOIN component_publishes cp ON cp.component_id=c.id AND cp.status='active'
            JOIN component_revisions cr ON cr.component_id=cp.component_id AND cr.rev=cp.rev
            WHERE c.name=? AND cr.design_system=? AND c.deleted_at IS NULL ORDER BY cp.version DESC LIMIT 1`).get(name,designSystem) as {id:string;name:string;version:number;rev:number;bundleHash:string;source:string}|null;
      if(!row) throw new ApiError(422,"validation_failed","Prototype document is invalid",{issues:[{path:["screens"],message:`Unknown or unpublished component type in design system '${designSystem}': ${name}`}]});
      const {materializeSource}=await import("./components/pipeline"); const path=await materializeSource(dataDir,row.id,row.rev,row.source);
      const mod=await importPublished(row.id,row.rev,path);
      const raw=mod.definition as ComponentDefinition&{events?:unknown};
      const {events,eventPayloadSchemas}=normalizeEvents(raw.events as Parameters<typeof normalizeEvents>[0]);
      custom[name]={...raw,events,...(eventPayloadSchemas?{eventPayloadSchemas}:{})} as ComponentDefinition;
      allCustom[name]=custom[name]!;
      if(!pinnedIds.has(row.id)) { pinnedIds.add(row.id); pins.push({id:row.id,name:row.name,version:row.version,bundleHash:row.bundleHash,sourcePath:path}); }
    }
    customBySurface.set(surface.id,custom);
  }
  // Transitional B1-B2 order: host fallback first, then live builtins, then custom.
  const definitionsBySurface=Object.fromEntries(surfaces.map(surface=>[surface.id,
    {...hostPrimitiveDefinitions,...builtinBySurface.get(surface.id)!,...normalizeDefinitions(customBySurface.get(surface.id)!)}]));
  // Объединение для доковых линтов: при совпадении имени побеждает primary (surfaces[0]).
  const builtinUnion=Object.assign({},...[...surfaces].reverse().map(surface=>builtinBySurface.get(surface.id)!)) as Record<string,ComponentDefinition>;
  return {definitions:{...hostPrimitiveDefinitions,...builtinUnion,...normalizeDefinitions(allCustom)},pins,definitionsBySurface};
}
