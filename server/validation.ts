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
import { COMPOSITION_KEY_SEPARATOR } from "../src/catalog/hostPrimitives/composition.definition";
import { canonicalStringify } from "../src/capture/canonicalJson";
import { currentCatalogRevision } from "./migrationRunner";
import type { ComponentSchemaContext } from "../src/prototype/validate";

/**
 * Kill-switch BR-01a (план `docs/plans/2026-08-08-blocker-removal-eui-br.md` §1):
 * `EASYUI_SCHEMA_RESOLVER_V2_DISABLED=1` возвращает **все четыре** фикса волны в доволновое
 * состояние byte-for-byte:
 *
 * 1. composition-пины снова применяются по имени ко всему документу (H1);
 * 2. readiness снова резолвит определения по нераскрытому документу (H2);
 * 3. `headPin` снова резолвит голову без фильтра дизайн-системы (H4);
 * 4. неизвестный prop снова даёт нетипизированный issue без диагностического контекста.
 *
 * Env читается по месту вызова (прецедент `sourcePackageEnabled`), поэтому параметр `raw`
 * существует для тестов и переключение не требует рестарта процесса.
 */
export const schemaResolverV2Enabled = (raw: string | undefined = process.env.EASYUI_SCHEMA_RESOLVER_V2_DISABLED): boolean =>
  raw !== "1";

/** Версия контракта резолвера схемы, публикуемая в `/api/capabilities` (фидбэк §4). */
export const PROTOTYPE_SCHEMA_RESOLVER_VERSION = 2;
export const LEGACY_PROTOTYPE_SCHEMA_RESOLVER_VERSION = 1;

/**
 * `422 component_pin_conflict` (BR-01a): один тип нужен документу в двух версиях — раскрытие
 * композиции пинует @M, авторский элемент вне композиции требует активную @N. Карта определений
 * name-keyed (`components.name` глобально UNIQUE), двух схем одного имени в ней не выразить,
 * поэтому единственный честный исход — типизированный отказ с обеими версиями и путями.
 */
export const COMPONENT_PIN_CONFLICT_CODE = "component_pin_conflict";

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

type PublishRow={id:string;name:string;version:number;rev:number;bundleHash:string;source:string;sourceHash:string|null;definitionMeta:string|null};

/** Ключи, которые схема props компонента действительно принимает (`acceptedKeys` фидбэка §4). */
function acceptedPropKeys(definitionMeta:string|null,definition:ComponentDefinition|undefined):string[] {
  const fromJsonSchema=(()=>{
    if(!definitionMeta) return null;
    try {
      const meta=JSON.parse(definitionMeta) as {propsJsonSchema?:unknown};
      const schema=meta.propsJsonSchema;
      if(!schema||typeof schema!=="object"||Array.isArray(schema)) return null;
      const properties=(schema as {properties?:unknown}).properties;
      if(!properties||typeof properties!=="object"||Array.isArray(properties)) return null;
      return Object.keys(properties as Record<string,unknown>).sort();
    } catch { return null; }
  })();
  if(fromJsonSchema) return fromJsonSchema;
  // Фолбэк — живая zod-схема, по которой валидация и отвергла prop (у неё shape есть всегда,
  // когда определение объявлено объектом; иначе честный пустой список).
  const shape=(definition?.props as {shape?:unknown}|undefined)?.shape;
  if(shape&&typeof shape==="object"&&!Array.isArray(shape)) return Object.keys(shape as Record<string,unknown>).sort();
  return [];
}

/** `propsSchemaHash` — sha256 канонизированного `definition_meta.propsJsonSchema`; `null` при отсутствии. */
export function propsSchemaHashOf(definitionMeta:string|null):string|null {
  if(!definitionMeta) return null;
  try {
    const meta=JSON.parse(definitionMeta) as {propsJsonSchema?:unknown};
    if(meta.propsJsonSchema===undefined||meta.propsJsonSchema===null) return null;
    return new Bun.CryptoHasher("sha256").update(canonicalStringify(meta.propsJsonSchema)).digest("hex");
  } catch { return null; }
}
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
export async function snapshotDefinitions(db:Database,doc:PrototypeDoc,dataDir:string):Promise<{definitions:Record<string,ComponentDefinition>;pins:ComponentPin[];definitionsBySurface:Record<string,Record<string,ComponentDefinition>>;componentMeta:Record<string,ComponentSchemaContext>}> {
  const surfaces=docSurfaces(doc);
  const compositionPins=compositionComponentPins.get(doc);
  const resolverV2=schemaResolverV2Enabled();
  const pins:ComponentPin[]=[]; const pinnedIds=new Set<string>();
  const builtinBySurface=new Map<string,Record<string,ComponentDefinition>>();
  const customBySurface=new Map<string,Record<string,ComponentDefinition>>();
  const allCustom:Record<string,ComponentDefinition>={};
  const componentMeta:Record<string,ComponentSchemaContext>={};
  // Ревизия каталога — вход ключа кэша схемы (фидбэк §4). Считается **лениво**: она нужна
  // только тому issue, который реально отвергает prop, и полный скан каталога на каждом save
  // был бы платой за диагностику, которой в норме нет.
  let catalogRevisionCache:string|null|undefined;
  const readCatalogRevision=():string|null => {
    if(catalogRevisionCache===undefined) { try { catalogRevisionCache=currentCatalogRevision(db); } catch { catalogRevisionCache=null; } }
    return catalogRevisionCache;
  };
  const pinnedRowOf=(pin:ComponentDependencyPin,designSystem:string):PublishRow|null =>
    db.query(`SELECT c.id,c.name,cp.version,cp.rev,cp.bundle_hash bundleHash,cr.source,cp.source_hash sourceHash,cp.definition_meta definitionMeta
      FROM components c JOIN component_publishes cp ON cp.component_id=c.id AND cp.version=?
      JOIN component_revisions cr ON cr.component_id=cp.component_id AND cr.rev=cp.rev
      WHERE c.id=? AND cr.design_system=?`).get(pin.version,pin.id,designSystem) as PublishRow|null;
  const activeRowOf=(name:string,designSystem:string):PublishRow|null =>
    db.query(`SELECT c.id,c.name,cp.version,cp.rev,cp.bundle_hash bundleHash,cr.source,cp.source_hash sourceHash,cp.definition_meta definitionMeta
      FROM components c JOIN component_publishes cp ON cp.component_id=c.id AND cp.status='active'
      JOIN component_revisions cr ON cr.component_id=cp.component_id AND cr.rev=cp.rev
      WHERE c.name=? AND cr.design_system=? AND c.deleted_at IS NULL ORDER BY cp.version DESC LIMIT 1`).get(name,designSystem) as PublishRow|null;
  for(const surface of surfaces) {
    const designSystem=surfaceDesignSystem(surface,doc)??doc.designSystem;
    const builtin=requireActiveDesignSystem(db,designSystem,["designSystem"]).definitions;
    builtinBySurface.set(surface.id,builtin);
    const screens=doc.screens.filter(screen=>surfaceOf(doc,screen.id).id===surface.id);
    // H1: разделяем элементы, **порождённые раскрытием композиции** (ключ вида `<host>$<inner>`),
    // и авторские. Пин композиции легитимен только для первых — по имени он бы навязал схему
    // манифеста всему документу, включая элементы, которых композиция не создавала.
    const usage=new Map<string,{expanded:string[];authored:string[]}>();
    for(const screen of screens) {
      const screenIndex=doc.screens.indexOf(screen);
      for(const [key,element] of Object.entries(screen.spec.elements)) {
        if(Object.hasOwn(builtin,element.type)||hostPrimitiveNames.has(element.type)) continue;
        const entry=usage.get(element.type)??{expanded:[],authored:[]};
        (key.includes(COMPOSITION_KEY_SEPARATOR)?entry.expanded:entry.authored).push(`/screens/${screenIndex}/spec/elements/${key}`);
        usage.set(element.type,entry);
      }
    }
    const custom:Record<string,ComponentDefinition>={};
    for(const name of [...usage.keys()].sort()) {
      const pinned=compositionPins?.get(name);
      const use=usage.get(name)!;
      // Доволновое поведение: пин по имени применяется ко всему документу.
      const usePin=pinned!==undefined&&(!resolverV2||use.expanded.length>0);
      let row=usePin?pinnedRowOf(pinned!,designSystem):activeRowOf(name,designSystem);
      if(resolverV2&&usePin&&use.authored.length>0) {
        const active=activeRowOf(name,designSystem);
        // Компонент без active-публикации в этой ДС резолвится пином: «нет головы» не повод
        // отказать документу, который раньше сохранялся (деградацию видит гейт `pins`).
        if(active&&row&&active.version!==row.version) {
          throw new ApiError(422,COMPONENT_PIN_CONFLICT_CODE,
            `Component '${name}' is required in two versions by the same document: the composition pins v${row.version}, an authored element resolves the active v${active.version}`,
            {componentId:row.id,componentName:name,
              issues:[
                ...use.expanded.map(path=>({path,message:`composition-expanded element requires ${name}@${row!.version} (composition pin)`})),
                ...use.authored.map(path=>({path,message:`authored element resolves ${name}@${active.version} (active publication)`})),
              ]});
        }
        if(active&&!row) row=active;
      }
      if(!row) throw new ApiError(422,"validation_failed","Prototype document is invalid",{issues:[{path:["screens"],message:`Unknown or unpublished component type in design system '${designSystem}': ${name}`}]});
      const {materializeSource}=await import("./components/pipeline"); const path=await materializeSource(dataDir,row.id,row.rev,row.source);
      const mod=await importPublished(row.id,row.rev,path);
      const raw=mod.definition as ComponentDefinition&{events?:unknown};
      const {events,eventPayloadSchemas}=normalizeEvents(raw.events as Parameters<typeof normalizeEvents>[0]);
      custom[name]={...raw,events,...(eventPayloadSchemas?{eventPayloadSchemas}:{})} as ComponentDefinition;
      allCustom[name]=custom[name]!;
      if(resolverV2) componentMeta[name]=Object.defineProperty({
        componentId:row.id,
        resolvedVersion:row.version,
        sourceHash:row.sourceHash??null,
        propsSchemaHash:propsSchemaHashOf(row.definitionMeta),
        catalogRevision:null as string|null,
        acceptedKeys:acceptedPropKeys(row.definitionMeta,custom[name]),
      },"catalogRevision",{enumerable:true,configurable:true,get:readCatalogRevision});
      if(!pinnedIds.has(row.id)) { pinnedIds.add(row.id); pins.push({id:row.id,name:row.name,version:row.version,bundleHash:row.bundleHash,sourcePath:path}); }
    }
    customBySurface.set(surface.id,custom);
  }
  // Transitional B1-B2 order: host fallback first, then live builtins, then custom.
  const definitionsBySurface=Object.fromEntries(surfaces.map(surface=>[surface.id,
    {...hostPrimitiveDefinitions,...builtinBySurface.get(surface.id)!,...normalizeDefinitions(customBySurface.get(surface.id)!)}]));
  // Объединение для доковых линтов: при совпадении имени побеждает primary (surfaces[0]).
  const builtinUnion=Object.assign({},...[...surfaces].reverse().map(surface=>builtinBySurface.get(surface.id)!)) as Record<string,ComponentDefinition>;
  return {definitions:{...hostPrimitiveDefinitions,...builtinUnion,...normalizeDefinitions(allCustom)},pins,definitionsBySurface,componentMeta};
}
