import type { Database } from "bun:sqlite";
import { z } from "zod";
import { designSystems } from "../../src/designSystems";
import { compileComponent, typecheckComponent } from "../components/compile";
import { extractDefinition } from "../components/extract-subprocess";
import { EVENT_SCHEMA_NOT_SERIALIZABLE, importPublished, materializeClientSource, materializeSource, sha256 } from "../components/pipeline";
import { ApiError, immutable, json, noStore, readJson } from "../http";
import { ComponentRepo } from "../repos/components";
import { requireActiveDesignSystem } from "../designSystems";
import { recordValidation } from "../validationRecords";
import { collectAndValidateComponentAssetRefs } from "../validation";
import { parseFigmaInput } from "../figma";
import { hostPrimitiveNames } from "../../src/catalog/hostPrimitives/definitions";
import type { Principal } from "../auth";
import { requireResourceOwner, requireUser } from "../authorization";
import { writeAuditEvent } from "../audit";
import { BundleClosure } from "../bundle/exporter";
import { zipResponse } from "./bundles";
import { catalogUsages, componentUsages, componentUsageTree, headUsageCounts } from "../usageGraph";
import { catalogUsagesQuerySchema, componentUsagesQuerySchema, parseQuery, parseWith, reuseIntentSchema } from "../contracts";
import { parsePreviewSelector } from "../components/previewSelector";
import type { DefinitionMeta } from "../components/types";
import {
  assertPublishRoleAvailable, cacheSourceShingles, duplicateWarnings, matchAndDecide, recordBlockedAttempt,
  ReuseGateRejection, reuseOverrideSchema, stageAndExtract, synthesizeIntent, DEFAULT_REUSE_GATE_MODE,
  type ReuseGateMode,
} from "../catalog/gate";
import { assertAtomicPolicy } from "../atomicPolicy";
import { getCandidateBundle, readCandidate } from "../components/candidates";
import { validateComponentHead } from "../components/validate";
import { promoteComponent } from "../components/promote";

const slug=/^[a-z0-9]+(?:-[a-z0-9]+)*$/, componentName=/^[A-Z][A-Za-z0-9]*$/;
function bad(message:string,path="source"):never{throw new ApiError(422,"validation_failed","Component is invalid",{issues:[{path:[path],message}]});}
function body(v:unknown){const p=z.record(z.string(),z.unknown()).safeParse(v);if(!p.success)throw new ApiError(400,"invalid_request","Request body must be an object");return p.data;}
function int(v:unknown,name:string){if(typeof v!=="number"||!Number.isInteger(v)||v<1)throw new ApiError(400,"invalid_request",`${name} must be a positive integer`);return v;}
function base(b:Record<string,unknown>){if(!Object.hasOwn(b,"baseRev"))throw new ApiError(400,"base_rev_required","baseRev is required");return int(b.baseRev,"baseRev");}
function text(v:unknown,name:string,required=true){if(v===undefined&&!required)return undefined;if(typeof v!=="string")throw new ApiError(400,"invalid_request",`${name} must be a string`);return v;}
export function reserveHostPrimitiveName(name:string):void{if(hostPrimitiveNames.has(name))throw new ApiError(409,"already_exists","Component name is reserved for a host primitive");}
export async function checkSource(source:string,path:string,smoke=false){
  if(new TextEncoder().encode(source).byteLength>262144)throw new ApiError(413,"payload_too_large","Component source exceeds 256 KB");
  try { new Bun.Transpiler({loader:"tsx"}).transformSync(source); } catch(error){bad(`Syntax error: ${error instanceof Error?error.message:String(error)}`);}
  const extracted=await extractDefinition(path,{smoke});
  if(!extracted.ok){
    const detail=extracted.error??"Component extraction failed";
    if(detail.startsWith(EVENT_SCHEMA_NOT_SERIALIZABLE)) throw new ApiError(422,"event_schema_not_serializable","A typed event payload schema could not be serialized to JSON Schema",{issues:[{path:["events"],message:detail}]});
    bad(detail);
  }
  return extracted;
}

// Screen-geometry маркеры в исходнике. Скан включается **только** при
// sourceBounded:true: канонические каркасы (yp-screen/yp-panel/yp-app-home-shell/
// yp-scroll-area) законно несут геометрию экрана и предупреждать о ней нельзя.
const SCREEN_GEOMETRY_PATTERNS:ReadonlyArray<readonly [label:string,pattern:RegExp]>=[
  ["h-screen",/\bh-screen\b/],["min-h-screen",/\bmin-h-screen\b/],["100vh",/100vh/],["100dvh",/100dvh/],["fixed inset-0",/fixed\s+inset-0/],
];

/** Publish-time архитектурные предупреждения (волна 2 §2.4) — warn-only, никогда не блокируют. */
export function architectureWarnings(db:Database,id:string,meta:{scope?:string;ownership?:{reason?:string};sourceBounded?:boolean;replacement?:string},source:string):string[]{
  const warnings:string[]=[];
  if((meta.scope==="screen"||meta.scope==="shell")&&!meta.ownership?.reason){
    warnings.push(`Component declares scope "${meta.scope}" without ownership.reason; document why it owns the whole ${meta.scope}`);
  }
  if(meta.replacement){
    const designSystem=(db.query("SELECT design_system FROM component_revisions WHERE component_id=? ORDER BY rev DESC LIMIT 1").get(id) as {design_system:string}|null)?.design_system;
    const found=designSystem===undefined?null:db.query("SELECT 1 ok FROM components c JOIN component_revisions cr ON cr.component_id=c.id WHERE c.name=? AND cr.design_system=? AND c.deleted_at IS NULL LIMIT 1").get(meta.replacement,designSystem);
    if(!found) warnings.push(`definition.replacement references an unknown component in this design system: ${meta.replacement}`);
  }
  if(meta.sourceBounded===true){
    const hits=SCREEN_GEOMETRY_PATTERNS.filter(([,pattern])=>pattern.test(source)).map(([label])=>label);
    if(hits.length) warnings.push(`Component declares sourceBounded: true but its source carries screen geometry (${hits.join(", ")}); a bounded component must not size itself to the viewport`);
  }
  return warnings;
}

export type PublishHooks={afterStage?:(x:{id:string;version:number;rev:number})=>void|Promise<void>;beforeImport?:(x:{id:string;version:number;rev:number})=>void|Promise<void>};
/**
 * Reuse-контекст публикации (план §3.5/D4): уникальность канонической роли проверяется и здесь,
 * а дубликат печатается предупреждением. Необязателен — прямые вызовы из тестов и скриптов
 * проверяют роль от имени системного актора в `enforce`.
 */
export type PublishReuseContext={actor:{userId:string;isAdmin:boolean};mode:ReuseGateMode;override?:import("../catalog/gate").ReuseOverride};
/**
 * Уже посчитанное извлечение того же исходника (план §3.7, A7). Импортёр бандла обязан
 * извлечь мету **до** `repo.create` — иначе гейту переиспользования нечего сопоставлять, — и
 * без этого параметра платил бы второй subprocess-спавн (таймаут 10 с) на каждый компонент.
 *
 * Переиспользуется **только** при совпадении sha256 публикуемой ревизии: расхождение
 * (чужой/устаревший результат) молча игнорируется и публикация извлекает заново. Результат
 * обязан быть получен тем же `checkSource(source,path,true)` — со smoke-рендером, иначе
 * потеряются его предупреждения.
 */
export type PublishExtraction={sourceHash:string;extracted:Awaited<ReturnType<typeof checkSource>>};
export async function publishComponent(db:Database,repo:ComponentRepo,id:string,baseRev:number,dataDir:string,message?:string,hooks:PublishHooks={},reuse:PublishReuseContext={actor:{userId:"system",isAdmin:false},mode:DEFAULT_REUSE_GATE_MODE},preExtracted?:PublishExtraction){
  reserveHostPrimitiveName(repo.meta(id).name);
  const revision=repo.source(id); const path=await materializeSource(dataDir,id,revision.rev,revision.source);
  // Validate /api/assets/asset_<sha256> literals in source before staging so a dangling ref fails fast.
  const assetIds=collectAndValidateComponentAssetRefs(db,revision.source);
  const extracted=preExtracted!==undefined&&preExtracted.sourceHash===sha256(revision.source)?preExtracted.extracted:await checkSource(revision.source,path,true);
  assertAtomicPolicy(db,"component",id,extracted.meta!);
  // Роль проверяется **до** `repo.stage`: после 409 не должно оставаться ни staging-публикации,
  // ни материализованного клиентского модуля.
  assertPublishRoleAvailable(db,{designSystem:revision.designSystem,id,canonicalFor:extracted.meta!.canonicalFor??[],actor:reuse.actor,mode:reuse.mode,sourceHash:sha256(revision.source),intent:extracted.meta!.description,...(reuse.override===undefined?{}:{override:reuse.override})});
  await typecheckComponent(path); let clientPath=path;if(extracted.serverOnly?.conformanceProps===true)try{clientPath=await materializeClientSource(dataDir,id,revision.rev,revision.source,true);}catch(error){bad(error instanceof Error?error.message:String(error));}const compiled=await compileComponent(clientPath,{capabilities:extracted.meta!.capabilities});
  // Фактический ABI (max по импортам/capabilities) пишется прямо в `stage` — той же дорогой,
  // что и у promote (RFC candidate-acceptance §4.3.4, находка V2).
  const staged=repo.stage(id,baseRev,{compiledJs:compiled.compiledJs,bundleHash:compiled.bundleHash,sourceHash:sha256(revision.source),meta:extracted.meta!,hostAbiVersion:compiled.hostAbiVersion},message);
  await hooks.afterStage?.({id,...staged});
  try { await hooks.beforeImport?.({id,...staged}); await importPublished(id,staged.rev,path); repo.activate(id,staged.version); repo.pinAssets(id,staged.version,assetIds); }
  catch(error){repo.fail(id,staged.version);const detail=error instanceof Error?error.message:String(error);recordValidation(db,{resourceType:"component",resourceId:id,rev:staged.rev,catalogHash:compiled.bundleHash,ok:false,issues:[{path:"/source",message:detail}]});throw new ApiError(422,"validation_failed","Published component import failed",{issues:[{path:["source"],message:detail}]});}
  recordValidation(db,{resourceType:"component",resourceId:id,rev:staged.rev,catalogHash:compiled.bundleHash,ok:true,issues:extracted.warnings.map(message=>({path:"/",message}))});
  const warnings=[...extracted.warnings];
  if(!extracted.meta!.atomicLevel) warnings.push("Atomic design level is not provided; component will be classified as Other");
  warnings.push(...architectureWarnings(db,id,extracted.meta!,revision.source));
  // D4: publish — это update, гейт создания на нём не стоит, но обход «PUT → publish» обязан
  // быть наблюдаем. Warn-only и с обязательным исключением самого артефакта из корпуса.
  warnings.push(...duplicateWarnings(db,{designSystem:revision.designSystem,id,name:repo.meta(id).name,source:revision.source,meta:extracted.meta!}));
  return {version:staged.version,hostAbiVersion:compiled.hostAbiVersion,warnings};
}

/**
 * `deprecated` манифеста (волна 3 §3.3). Строка манифеста по построению всегда `active`,
 * поэтому «статус активной версии» читается как статус **последней** публикации компонента:
 * когда свежая версия переведена в deprecated/superseded, компонент продолжает жить в
 * манифесте старой active-версией, и именно это состояние нужно показать в библиотеке.
 */
const DEPRECATED_LATEST_STATUS=new Set(["deprecated","superseded"]);
function deprecatedComponentIds(db:Database):Set<string>{
  const rows=db.query(`SELECT p.component_id id,p.status FROM component_publishes p
    WHERE p.version=(SELECT MAX(x.version) FROM component_publishes x WHERE x.component_id=p.component_id)`).all() as {id:string;status:string}[];
  return new Set(rows.filter(row=>DEPRECATED_LATEST_STATUS.has(row.status)).map(row=>row.id));
}

export type ActiveCatalogRow={id:string;name:string;design_system:string;version:number;bundle_hash:string;definition_meta:string;host_abi_version:number};
/**
 * Строки последних активных публикаций по каждой паре `(компонент, дизайн-система)`.
 * Общий источник для `/api/catalog/manifest` и `/api/catalog/library`, чтобы семантика
 * «активной версии» не разъехалась между двумя read-model.
 */
export function activeCatalogRows(db:Database,designSystem?:string):ActiveCatalogRow[]{return db.query(`SELECT c.id,c.name,r.design_system,p.version,p.bundle_hash,p.definition_meta,p.host_abi_version FROM components c JOIN component_publishes p ON p.component_id=c.id AND p.status='active' JOIN component_revisions r ON r.component_id=p.component_id AND r.rev=p.rev JOIN design_systems ds ON ds.id=r.design_system AND ds.retired=0 WHERE c.deleted_at IS NULL${designSystem===undefined?"":" AND r.design_system=?"} AND p.version=(SELECT MAX(x.version) FROM component_publishes x JOIN component_revisions xr ON xr.component_id=x.component_id AND xr.rev=x.rev WHERE x.component_id=c.id AND x.status='active' AND xr.design_system=r.design_system) ORDER BY c.id,r.design_system`).all(...(designSystem===undefined?[]:[designSystem])) as ActiveCatalogRow[];}

export function catalogManifest(db:Database,designSystem?:string){const usage=headUsageCounts(db),deprecated=deprecatedComponentIds(db);return activeCatalogRows(db,designSystem).map(r=>({id:r.id,name:r.name,designSystem:r.design_system,version:r.version,bundleUrl:`/api/components/${encodeURIComponent(r.id)}/versions/${r.version}/bundle.js`,bundleHash:r.bundle_hash,...JSON.parse(r.definition_meta),hostAbiVersion:r.host_abi_version,headUsageCount:usage.get(r.id)??0,deprecated:deprecated.has(r.id)}));}

// Статусы, чей бандл ещё исполняется существующими пинами — зеркало `RENDERABLE_STATUS`
// (`server/repos/components.ts:9`): за бандлом такой версии следующий запрос всё равно придёт.
const PREVIEW_RENDERABLE_STATUS=new Set(["active","deprecated","superseded"]);
type PreviewRow={name:string;design_system:string;status:string;status_reason:string|null;definition_meta:string;bundle_hash:string;host_abi_version:number};

/**
 * `GET /api/components/:id/versions/:version/preview?selector=legacy|named&name=` — данные
 * для инлайн-превью библиотеки. Узкий SELECT вместо `repo.version()`: тот отдаёт `source`
 * и весь `definition_meta`, включая `propsJsonSchema` и все примеры.
 */
export function componentPreview(db:Database,id:string,version:number,params:URLSearchParams){
  const selector=parsePreviewSelector(params);
  const row=db.query("SELECT c.name,r.design_system,p.status,p.status_reason,p.definition_meta,p.bundle_hash,p.host_abi_version FROM component_publishes p JOIN components c ON c.id=p.component_id JOIN component_revisions r ON r.component_id=p.component_id AND r.rev=p.rev WHERE p.component_id=? AND p.version=?").get(id,version) as PreviewRow|null;
  if(!row)throw new ApiError(404,"not_found","Component version not found");
  if(!PREVIEW_RENDERABLE_STATUS.has(row.status))throw new ApiError(404,"bundle_unavailable",`Component version bundle is unavailable (status ${row.status}${row.status_reason?`: ${row.status_reason}`:""})`);
  const meta=JSON.parse(row.definition_meta) as DefinitionMeta;
  let props:Record<string,unknown>;
  if(selector.selector==="legacy"){if(!meta.example)throw new ApiError(422,"example_unavailable","Component version has no legacy example");props=meta.example;}
  else{const examples=meta.examples??{};if(!Object.hasOwn(examples,selector.name))throw new ApiError(422,"unknown_example",`Unknown component example: ${selector.name}`);props=examples[selector.name]!;}
  return {componentId:id,name:row.name,version,designSystem:row.design_system,bundleUrl:`/api/components/${encodeURIComponent(id)}/versions/${version}/bundle.js`,bundleHash:row.bundle_hash,hostAbiVersion:row.host_abi_version,props,slots:meta.slots??[],...(meta.capabilities?{capabilities:meta.capabilities}:{})};
}

/** `GET /api/catalog/usages?designSystem=` — агрегированный индекс использования (волна 3 §3.1). */
export function routeCatalogUsages(request:Request,db:Database):Response{
  if(request.method!=="GET")throw new ApiError(405,"method_not_allowed","Method not allowed");
  const {designSystem}=parseQuery(catalogUsagesQuerySchema,new URL(request.url).searchParams);
  if(designSystem!==undefined&&!db.query("SELECT 1 ok FROM design_systems WHERE id=?").get(designSystem))throw new ApiError(404,"not_found","Design system not found");
  return json(catalogUsages(db,designSystem),200,noStore);
}

/**
 * Тело `409` гейта переиспользования (план §3.5). Конверт ошибки — общий для всего API
 * (`{error:{code,message,…}}`), поэтому поля плана лежат внутри `error`: `driver.mjs` и
 * `src/api/client.ts` читают именно `body.error.code`.
 *
 * `decisionId`/`repeatedAttempts` знает только аудит, который пишется **снаружи** транзакции и
 * best-effort: при его отказе оба поля уходят `null` (именно `null`, а не `0`).
 */
function reuseRejectionResponse(db:Database,rejection:ReuseGateRejection):Response{
  const audit=recordBlockedAttempt(db,rejection.attempt);
  return json({error:{code:rejection.code,message:rejection.message,...rejection.payload,decisionId:audit?.decisionId??null,repeatedAttempts:audit?.repeatedAttempts??null}},409,noStore);
}

/**
 * Шов P8 «validate → publish»: extraction успешного префлайта того же исходника. TTL кэша
 * здесь намеренно не проверяется — extraction источнико-чист (сверку sha256 делает
 * `publishComponent`), а TTL существует ради гигиены хранилища, не ради корректности.
 */
async function validatedExtractionForPublish(dataDir:string,sourceHash:string):Promise<PublishExtraction|undefined>{
  const entry=await readCandidate(dataDir,sourceHash);
  if(entry===null||!entry.ok||entry.extracted===undefined)return undefined;
  return {sourceHash,extracted:entry.extracted};
}

export async function routeComponents(request:Request,db:Database,segments:string[],principal:Principal,dataDir:string,reuseGateMode:ReuseGateMode=DEFAULT_REUSE_GATE_MODE,validate:{disabled?:boolean}={},acceptance:{disabled?:boolean;matrix?:boolean}={}):Promise<Response>{
  const repo=new ComponentRepo(db);
  // `?includeDeleted=1` — единственный способ увидеть надгробия: голый GET по-прежнему
  // отдаёт 404 для мягко удалённого компонента (совместимость с driver.mjs и src/api/client.ts).
  const includeDeleted=new URL(request.url).searchParams.get("includeDeleted")==="1";
  if(segments.length===1){if(request.method==="GET")return json(repo.list(includeDeleted),200,noStore);if(request.method==="POST"){const actor=requireUser(principal);const b=body(await readJson(request));for(const key of Object.keys(b))if(!["id","name","source","designSystem","message","figma","intent","reuseOverride"].includes(key))throw new ApiError(400,"invalid_request",`Unknown field: ${key}`);const id=text(b.id,"id")!,name=text(b.name,"name")!,source=text(b.source,"source")!,designSystem=text(b.designSystem,"designSystem")!;requireResourceOwner(db,"design_systems",designSystem,principal);if(!slug.test(id))bad("id must be a slug","id");if(!componentName.test(name))bad("name must match ^[A-Z][A-Za-z0-9]*$","name");reserveHostPrimitiveName(name);requireActiveDesignSystem(db,designSystem,["designSystem"]);if(Object.values(designSystems).some(system=>Object.hasOwn(system.definitions,name)))throw new ApiError(409,"already_exists","Component name conflicts with a builtin component");
    // Занятость id/name — тем же условием, что и `repo.create` (`repos/components.ts:20`:
    // `name` глобально UNIQUE, надгробия считаются занятыми), но **до** дорогого извлечения.
    if(db.query("SELECT 1 FROM components WHERE id=? OR name=?").get(id,name))throw new ApiError(409,"already_exists","Component id or name already exists");
    // `reuseOverride` — только админ и только валидной формы (спека §4). Проверка дешёвая и
    // потому стоит **до** извлечения: не-админу незачем платить за subprocess.
    const override=b.reuseOverride===undefined?undefined:parseWith(reuseOverrideSchema,b.reuseOverride,"reuseOverride is invalid");
    if(override!==undefined&&!actor.isAdmin)throw new ApiError(403,"admin_required","Only an admin may override the reuse gate");
    // `intent` по фазе гейта (план §3.5.2): в enforce обязателен, в shadow синтезируется из
    // имени, а ответ несёт `warnings[]` и аудит помечается `intent_missing`. Присланный intent
    // валидируется в обеих фазах — поле есть поле.
    const intentProvided=b.intent!==undefined;
    if(reuseGateMode==="enforce"&&!intentProvided)throw new ApiError(400,"invalid_request","intent is required: describe the product job this component does (8..500 characters)");
    const intent=intentProvided?parseWith(reuseIntentSchema,b.intent,"intent is invalid"):synthesizeIntent(name);
    const figma=parseFigmaInput(db,b.figma,"figma");
    // Извлечение — над одноразовым staging-модулем. Durable-модуль на create не пишется вовсе:
    // `publishComponent` материализует его заново из `repo.source(id)` (см. :71), а путь
    // content-addressed и идемпотентен, поэтому предварительная запись ничего не экономила.
    // Ошибка извлечения остаётся 422 и матчинг не запускает (спека §9).
    const extracted=await stageAndExtract(dataDir,id,source,path=>checkSource(source,path));
    let outcome;
    try {
      // Матчинг + create + аудит — одна **синхронная** транзакция: пересчёт закрывает TOCTOU
      // между конкурентными POST, а 409 бросается изнутри, поэтому откат гарантирован.
      outcome=matchAndDecide(db,{
        mode:reuseGateMode,actor:{userId:actor.userId,isAdmin:actor.isAdmin},userAgent:request.headers.get("user-agent"),
        designSystem,artifactId:id,name,source,meta:extracted.meta!,intent,intentProvided,...(override===undefined?{}:{override}),
      },()=>{
        const created=repo.create(id,name,source,designSystem,text(b.message,"message",false),figma,actor.userId);
        db.query("UPDATE component_revisions SET author=? WHERE component_id=? AND rev=1").run(actor.userId,id);
        // Write-through кэша шинглов: свежий драфт обязан участвовать в корпусе с первой же
        // проверки, иначе обход «создать N драфтов → опубликовать» переоткрывается.
        cacheSourceShingles(db,id,1,source);
        writeAuditEvent(db,{actorId:actor.userId,action:"component.revision.saved",subjectType:"component",subjectId:id,detail:{rev:1}});
        return created;
      });
    } catch(error){
      if(error instanceof ReuseGateRejection) return reuseRejectionResponse(db,error);
      throw error;
    }
    return json({...outcome.created,...(outcome.warnings.length?{warnings:outcome.warnings}:{})},201,{...noStore,location:`/api/components/${id}`});}throw new ApiError(405,"method_not_allowed","Method not allowed");}
  const id=segments[1]!,tail=segments.slice(2);
  if(!tail.length){if(request.method==="GET")return json(repo.meta(id,includeDeleted),200,noStore);if(request.method==="PUT"){const actor=requireResourceOwner(db,"components",id,principal);reserveHostPrimitiveName(repo.meta(id).name);const b=body(await readJson(request)),source=text(b.source,"source",false),designSystem=text(b.designSystem,"designSystem",false),baseRev=base(b);const figmaProvided=Object.hasOwn(b,"figma");const figma=figmaProvided?parseFigmaInput(db,b.figma,"figma"):null;if(source===undefined&&designSystem===undefined&&!figmaProvided)throw new ApiError(400,"invalid_request","source, designSystem or figma is required");if(designSystem!==undefined){requireActiveDesignSystem(db,designSystem,["designSystem"]);requireResourceOwner(db,"design_systems",designSystem,principal);}const current=repo.cas(id,baseRev),head=repo.source(id,current.head_rev),nextSource=source??head.source,nextSystem=designSystem??current.design_system;const coreUnchanged=nextSource===head.source&&nextSystem===current.design_system;if(coreUnchanged&&!figmaProvided)throw new ApiError(400,"invalid_request","Component source and design system are unchanged");
      // P5.1 (план 2026-08-02): no-op PUT с figma-only изменением — и source, и figma
      // byte-идентичны head (figma сравнивается каноническим JSON: обе стороны —
      // `JSON.stringify(figmaSchema.parse(…))`). Ответ несёт `rev` головы: PUT всегда
      // возвращал `{rev}`, старые драйверы зависят именно на нём. Изменившийся figma
      // по-прежнему создаёт ревизию (ветка ниже).
      if(coreUnchanged&&figmaProvided){const headFigma=(db.query("SELECT figma_json FROM component_revisions WHERE component_id=? AND rev=?").get(id,current.head_rev) as {figma_json:string|null}).figma_json;if(figma===headFigma)return json({unchanged:true as const,rev:current.head_rev},200,noStore);}const next=current.head_rev+1,path=await materializeSource(dataDir,id,next,nextSource);await checkSource(nextSource,path);const result=repo.save(id,source,designSystem,baseRev,text(b.message,"message",false),figma);db.query("UPDATE component_revisions SET author=? WHERE component_id=? AND rev=?").run(actor.userId,id,result.rev);
    // Write-through кэша шинглов и на PUT: head-драфт участвует в корпусе, поэтому «сохранил
    // дубликат в драфт → опубликовал» ловится тем же матчером (§3.6, план §3.1).
    cacheSourceShingles(db,id,result.rev,nextSource);writeAuditEvent(db,{actorId:actor.userId,action:"component.revision.saved",subjectType:"component",subjectId:id,detail:{rev:result.rev}});return json(result,200,noStore);}if(request.method==="DELETE"){const actor=requireResourceOwner(db,"components",id,principal);const b=body(await readJson(request));const baseRev=base(b);const reason=text(b.reason,"reason",false);const replacement=text(b.replacement,"replacement",false);if(b.force!==undefined&&typeof b.force!=="boolean")throw new ApiError(400,"invalid_request","force must be a boolean");
    if(replacement!==undefined&&!db.query("SELECT 1 ok FROM components WHERE id=? AND deleted_at IS NULL").get(replacement))bad(`replacement references an unknown component: ${replacement}`,"replacement");
    // Компонент, живущий в головных ревизиях, нельзя убрать молча: 409 с графом использования.
    // Обход — force от админа, по образцу admin-гейта на смену статуса пиннутой версии.
    const usages=componentUsages(db,id);
    if(usages.currentHeadUsages.length){
      if(b.force!==true)throw new ApiError(409,"component_in_use","Component is used by head revisions of prototypes",{usages});
      if(!actor.isAdmin)throw new ApiError(403,"admin_required","Only an admin may force-delete a component that is still in use");
    }
    repo.delete(id,baseRev,{reason,replacement});
    writeAuditEvent(db,{actorId:actor.userId,action:"component.deleted",subjectType:"component",subjectId:id,detail:{reason:reason??null,replacement:replacement??null,forced:b.force===true,headUsages:usages.currentHeadUsages.length}});
    return new Response(null,{status:204,headers:noStore});}throw new ApiError(405,"method_not_allowed","Method not allowed");}
  if(tail[0]==="usages"&&tail.length===1){if(request.method!=="GET")throw new ApiError(405,"method_not_allowed","Method not allowed");const {format}=parseQuery(componentUsagesQuerySchema,new URL(request.url).searchParams);return json(format==="tree"?componentUsageTree(db,id):componentUsages(db,id),200,noStore);}
  if(tail[0]==="source"&&tail.length===1){if(request.method!=="GET")throw new ApiError(405,"method_not_allowed","Method not allowed");return json(repo.source(id),200,noStore);}
  if(tail[0]==="draft"&&tail.length===1){if(request.method!=="GET")throw new ApiError(405,"method_not_allowed","Method not allowed");return json(repo.source(id),200,noStore);}
  // GET /draft/:sourceHash/bundle.js — эфемерный candidate-bundle префлайта P8 для draft-preview
  // (P1b). Путь content-addressed и попадает в capture-allowlist только enqueue'нувшей джобы;
  // записи нет/протухла/собрана под другой компонент → 404. Каталог и bundle-export его не
  // видят: они читают publishes. Публичного контракта у URL нет (эфемерный кэш, см. P8).
  if(tail[0]==="draft"&&tail.length===3&&tail[2]==="bundle.js"){
    if(request.method!=="GET")throw new ApiError(405,"method_not_allowed","Method not allowed");
    // RFC candidate-acceptance §2 (M5/V11): байты непубличного драфта закрыты владельцем.
    // `capture` пропускается по allowlist сессии (путь уже сверен в `createHandler`) — это
    // прецедент прототипного драфт-роута; лобовой `requireResourceOwner` сломал бы съёмку,
    // потому что capture-воркер не user. Проверка идёт ДО lookup'а, чтобы чужой sourceHash
    // нельзя было прощупать разницей 403/404.
    if(principal.kind!=="capture") requireResourceOwner(db,"components",id,principal);
    if(!/^[0-9a-f]{64}$/.test(tail[1]!))throw new ApiError(404,"not_found","Candidate bundle not found");
    const candidate=await getCandidateBundle(dataDir,id,tail[1]!);
    if(!candidate)throw new ApiError(404,"not_found","Candidate bundle not found");
    return new Response(candidate.bundleJs,{headers:{...noStore,"content-type":"text/javascript; charset=utf-8"}});
  }
  if(tail[0]==="export"&&tail.length===1){if(request.method!=="GET")throw new ApiError(405,"method_not_allowed","Method not allowed");requireUser(principal);repo.row(id);const versionRaw=new URL(request.url).searchParams.get("version");const version=versionRaw===null?undefined:int(Number(versionRaw),"version");const closure=new BundleClosure(db,dataDir);const exported=closure.addComponent(id,version);const bytes=await closure.buildZip("component",new URL(request.url).origin);const suffix=exported.version!==null?`v${exported.version}`:`draft-r${exported.rev}`;return zipResponse(bytes,`easy-ui-component-${id}-${suffix}.zip`);}
  if(tail[0]==="revisions"){if(tail.length===1)return json(repo.revisions(id),200,noStore);if(tail.length===2)return json(repo.source(id,int(Number(tail[1]),"rev")),200,noStore);}
  if(tail[0]==="restore"&&tail.length===1){const actor=requireResourceOwner(db,"components",id,principal);const b=body(await readJson(request));const result=repo.restore(id,int(b.rev,"rev"),base(b));db.query("UPDATE component_revisions SET author=? WHERE component_id=? AND rev=?").run(actor.userId,id,result.rev);writeAuditEvent(db,{actorId:actor.userId,action:"component.revision.saved",subjectType:"component",subjectId:id,detail:{rev:result.rev,restore:true}});return json(result,200,noStore);}
  // P8 (план 2026-08-02): validate-префлайт head-ревизии — publish-проверки без создания
  // версии и без изменения public state. Kill-switch: EASYUI_VALIDATE_DISABLED=1 → ручки
  // нет (404), фича гаснет и в /api/capabilities.features. Тело запроса не читается.
  if(tail[0]==="validate"&&tail.length===1){if(validate.disabled)throw new ApiError(404,"not_found","Component validate is disabled");if(request.method!=="POST")throw new ApiError(405,"method_not_allowed","Method not allowed");const actor=requireResourceOwner(db,"components",id,principal);return json(await validateComponentHead(db,dataDir,id,actor.userId),200,noStore);}
  if(tail[0]==="publish"&&tail.length===1){if(request.method!=="POST")throw new ApiError(405,"method_not_allowed","Method not allowed");const actor=requireResourceOwner(db,"components",id,principal);const systemId=repo.row(id).design_system;requireActiveDesignSystem(db,systemId,["designSystem"]);requireResourceOwner(db,"design_systems",systemId,principal);const b=body(await readJson(request));
    for(const key of Object.keys(b))if(!["baseRev","message","reuseOverride"].includes(key))throw new ApiError(400,"invalid_request",`Unknown field: ${key}`);
    const publishOverride=b.reuseOverride===undefined?undefined:parseWith(reuseOverrideSchema,b.reuseOverride,"reuseOverride is invalid");
    if(publishOverride!==undefined&&!actor.isAdmin)throw new ApiError(403,"admin_required","Only an admin may override the reuse gate");
    // P8: publish после validate не платит второй раз за checkSource/smoke-рендер — extraction
    // приезжает из candidate-кэша через шов `PublishExtraction` (сверка sha256 внутри
    // `publishComponent`: расхождение с head молча отправляет публикацию извлекать заново).
    const headSource=repo.source(id);const preExtracted=await validatedExtractionForPublish(dataDir,sha256(headSource.source));
    let result;
    try { result=await publishComponent(db,repo,id,base(b),dataDir,text(b.message,"message",false),{},{actor:{userId:actor.userId,isAdmin:actor.isAdmin},mode:reuseGateMode,...(publishOverride===undefined?{}:{override:publishOverride})},preExtracted); }
    catch(error){ if(error instanceof ReuseGateRejection) return reuseRejectionResponse(db,error); throw error; }
    writeAuditEvent(db,{actorId:actor.userId,action:"component.version.published",subjectType:"component",subjectId:id,detail:{version:result.version}});return json(result,201,{...noStore,location:`/api/components/${id}/versions/${result.version}`});}
  // RFC candidate-acceptance-pipeline (R1): promote — приёмка провалидированной head-ревизии
  // одной командой. Никаких durable-таблиц и миграций: идентификация кандидата — пара
  // `{baseRev, sourceHash}` из validate-receipt. Kill-switch EASYUI_ACCEPTANCE_DISABLED=1 →
  // ручки нет (404) и `features.acceptancePromote=false`.
  if(tail[0]==="promote"&&tail.length===1){if(acceptance.disabled)throw new ApiError(404,"not_found","Component promote is disabled");if(request.method!=="POST")throw new ApiError(405,"method_not_allowed","Method not allowed");const actor=requireResourceOwner(db,"components",id,principal);const systemId=repo.row(id).design_system;requireActiveDesignSystem(db,systemId,["designSystem"]);requireResourceOwner(db,"design_systems",systemId,principal);const b=body(await readJson(request));
    for(const key of Object.keys(b))if(!["baseRev","sourceHash","expectedCatalogRevision","supersede","reuseOverride","message","candidateId","acceptanceRunId"].includes(key))throw new ApiError(400,"invalid_request",`Unknown field: ${key}`);
    // A7 (план 2026-08-03 §5 W1a/W1c): ссылки на durable-кандидата и его ран принимаются формой,
    // но не работают без матричной приёмки. Отказ типизован: агент обязан отличать «фича выключена
    // в этой сборке» от «сервер не знает такого поля» — второе он чинил бы удалением параметра.
    if(b.candidateId!==undefined||b.acceptanceRunId!==undefined){
      if(!acceptance.matrix)throw new ApiError(422,"acceptance_matrix_disabled","candidateId/acceptanceRunId require EASYUI_ACCEPTANCE_MATRIX=1");
      throw new ApiError(422,"unsupported_option","candidateId/acceptanceRunId are accepted by promote from wave W1c");
    }
    const sourceHash=text(b.sourceHash,"sourceHash")!;
    if(!/^[0-9a-f]{64}$/.test(sourceHash))throw new ApiError(400,"invalid_request","sourceHash must be a sha256 hex digest");
    const expectedCatalogRevision=text(b.expectedCatalogRevision,"expectedCatalogRevision",false);
    if(b.supersede!==undefined&&b.supersede!=="auto"&&b.supersede!=="none")throw new ApiError(400,"invalid_request","supersede must be \"auto\" or \"none\"");
    const promoteOverride=b.reuseOverride===undefined?undefined:parseWith(reuseOverrideSchema,b.reuseOverride,"reuseOverride is invalid");
    if(promoteOverride!==undefined&&!actor.isAdmin)throw new ApiError(403,"admin_required","Only an admin may override the reuse gate");
    let promoted;
    try { promoted=await promoteComponent(db,dataDir,{id,baseRev:base(b),sourceHash,supersede:(b.supersede as "auto"|"none"|undefined)??"auto",actor:{userId:actor.userId,isAdmin:actor.isAdmin},mode:reuseGateMode,...(expectedCatalogRevision===undefined?{}:{expectedCatalogRevision}),...(text(b.message,"message",false)===undefined?{}:{message:text(b.message,"message",false)!}),...(promoteOverride===undefined?{}:{override:promoteOverride})}); }
    catch(error){ if(error instanceof ReuseGateRejection) return reuseRejectionResponse(db,error); throw error; }
    // KPI §9: fingerprints промоушена — единственный источник измерения churn'а постфактум.
    writeAuditEvent(db,{actorId:actor.userId,action:"component.promoted",subjectType:"component",subjectId:id,detail:{version:promoted.version,rev:promoted.rev,sourceHash:promoted.sourceHash,bundleHash:promoted.bundleHash,hostAbiVersion:promoted.hostAbiVersion,themeVersion:promoted.themeVersion,catalogRevision:promoted.catalogRevision,superseded:promoted.superseded,supersede:(b.supersede as string|undefined)??"auto",cached:promoted.cached}});
    return json(promoted,201,{...noStore,location:`/api/components/${id}/versions/${promoted.version}`});}
  if(tail[0]==="versions"){
    // POST /versions/:version/status — manual lifecycle transition with CAS on statusRev (K.2).
    // TODO(T9): register this endpoint in server/contracts.ts (owned by T9; contract left unregistered here).
    if(tail.length===3&&tail[2]==="status"){if(request.method!=="POST")throw new ApiError(405,"method_not_allowed","Method not allowed");const actor=requireResourceOwner(db,"components",id,principal);const version=int(Number(tail[1]),"version");const b=body(await readJson(request));const status=text(b.status,"status")!;const current=db.query("SELECT status FROM component_publishes WHERE component_id=? AND version=?").get(id,version) as {status:string}|null;const pinned=Boolean(db.query("SELECT 1 ok FROM prototype_revision_components WHERE component_id=? AND component_version=? LIMIT 1").get(id,version));if(current?.status==="active"&&pinned&&(status==="archived"||status==="rejected")&&!actor.isAdmin)throw new ApiError(403,"admin_required","Only an admin may make a pinned active bundle unavailable");if(!Object.hasOwn(b,"baseStatusRev"))throw new ApiError(400,"invalid_request","baseStatusRev is required");const baseStatusRev=int(b.baseStatusRev,"baseStatusRev");const reason=text(b.reason,"reason",false);const supersededBy=b.supersededBy===undefined?undefined:int(b.supersededBy,"supersededBy");const result=repo.setStatus(id,version,{status,reason,supersededBy,baseStatusRev});writeAuditEvent(db,{actorId:actor.userId,action:"component.status.changed",subjectType:"component",subjectId:id,detail:{version,...result}});return json(result,200,noStore);}
    if(request.method!=="GET")throw new ApiError(405,"method_not_allowed","Method not allowed");if(tail.length===1)return json(repo.versions(id),200,noStore);if(tail.length===2)return json(repo.version(id,int(Number(tail[1]),"version")),200,immutable);if(tail.length===3&&tail[2]==="bundle.js")return new Response(repo.bundle(id,int(Number(tail[1]),"version")).js,{headers:{...immutable,"content-type":"text/javascript; charset=utf-8"}});
    if(tail.length===3&&tail[2]==="preview")return json(componentPreview(db,id,int(Number(tail[1]),"version"),new URL(request.url).searchParams),200,noStore);}
  throw new ApiError(404,"not_found","API route not found");
}
