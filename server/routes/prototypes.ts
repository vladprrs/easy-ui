import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { ComponentDefinition } from "../../src/catalog/definitions";
import type { ComponentSchemaContext } from "../../src/prototype/types";
import { designSystems } from "../../src/designSystems";
import { inputPrototypeDocSchema, type PrototypeDoc } from "../../src/prototype/schema";
import { validatePrototype } from "../../src/prototype/validate";
import { ApiError, immutable, json, noStore, readJson } from "../http";
import { geometryOwnershipEnabled } from "../capture/geometryOwnership";
import { assertPinnedTrack, PrototypeRepo, type PrototypeLifecyclePatch } from "../repos/prototypes";
import { parseWith, prototypeKindSchema, prototypeLifecycleSchema } from "../contracts";
import { collectAndValidateAssetRefs, expandPrototypeForSave, schemaResolverV2Enabled, snapshotDefinitions, themesForDoc } from "../validation";
import type { ResolvedComponentGraph } from "../components/resolvedGraph";
import { headScreenUrl, renderStatus, versionScreenUrl } from "./renderStatus";
import { recordValidation } from "../validationRecords";
import { parseFigmaInput } from "../figma";
import { diffPrototypeDocs } from "../../src/prototype/revisionDiff";
import type { Principal } from "../auth";
import { requirePrototypeOwner, requirePrototypeRead, requireUser } from "../authorization";
import { writeAuditEvent } from "../audit";
import { BundleClosure } from "../bundle/exporter";
import { zipResponse } from "./bundles";
import { computeReadiness } from "../readiness";
import { buildSnapPlan, impactedSnapEnabled } from "../prototypes/screenFrames";
import { barrierAwareReadinessPolicy } from "../capture/resourceBarrier";
import { validateViewport } from "../screenshot/service";

const headScreens = (doc:PrototypeDoc) => doc.screens.map(s=>({id:s.id,url:headScreenUrl(doc.id,s.id)}));

/**
 * BR-01b (план 2026-08-08 §1): блок `components` save-ответа — проекция **того же** узла
 * `ResolvedComponentGraph`, который принял документ. `resolvedVersion`/`sourceHash`/
 * `propsSchemaHash` здесь обязаны совпадать с ответом `render-status` и с `componentPins` снапа:
 * мигратор сверяет тройки, а не доверяет им по отдельности.
 *
 * Поле условное: при `EASYUI_SCHEMA_RESOLVER_V2_DISABLED=1` его нет вовсе (доволновой ответ).
 */
function resolvedComponentsBlock(graph:ResolvedComponentGraph):{components:{id:string;name:string;resolvedVersion:number;sourceHash:string|null;propsSchemaHash:string|null;origin:string}[]}|Record<string,never> {
  if(!schemaResolverV2Enabled()) return {};
  return {components:graph.nodes.map(node=>({
    id:node.componentId,name:node.name,resolvedVersion:node.version,
    sourceHash:node.sourceHash,propsSchemaHash:node.propsSchemaHash,origin:node.origin,
  }))};
}

// Lifecycle-метаданные (миграция v16). На POST /api/prototypes они приезжают рядом с
// doc/message/figma, поэтому там их сначала вычленяют, а тело /lifecycle валидируется целиком
// (strictObject → неизвестный ключ даёт 422).
const parseLifecycle = (raw:Record<string,unknown>):PrototypeLifecyclePatch => parseWith(prototypeLifecycleSchema,raw,"Prototype lifecycle is invalid");
function lifecycleFields(body:Record<string,unknown>):PrototypeLifecyclePatch {
  const raw:Record<string,unknown>={};
  for(const key of ["kind","tags","derivedFrom"] as const) if(Object.hasOwn(body,key)) raw[key]=body[key];
  return parseLifecycle(raw);
}
// `?kind=` — CSV-список видов (повторение параметра не поддерживается; см. docs/server-api.md).
function kindFilter(url:URL):string[]|undefined {
  const raw=url.searchParams.get("kind");
  if(raw===null) return undefined;
  const kinds=raw.split(",").map(part=>part.trim()).filter(part=>part.length>0);
  if(!kinds.length) return undefined;
  return parseWith(z.array(prototypeKindSchema),kinds,"Query parameters are invalid");
}

// `?scope=all` — админская выдача списка (план 2026-08-05): без параметра предикат видимости
// прежний для всех, включая админов; не-админу параметр отвечает 403 admin_required, а не молча
// деградирует, чтобы клиент не показал урезанный список как полный.
function includeAllScope(url:URL,principal:Principal):boolean {
  const raw=url.searchParams.get("scope");
  if(raw===null) return false;
  if(raw!=="all") throw new ApiError(400,"invalid_request","scope must be 'all'");
  if(principal.kind!=="user"||!principal.isAdmin) throw new ApiError(403,"admin_required","Only an admin may list all prototypes");
  return true;
}

const bodyObject = z.record(z.string(),z.unknown());
function objectBody(value:unknown): Record<string,unknown> { const p=bodyObject.safeParse(value); if(!p.success) throw new ApiError(400,"invalid_request","Request body must be an object"); return p.data; }
function integer(value:unknown,name:string):number { if(typeof value!=="number"||!Number.isInteger(value)||value<1) throw new ApiError(400,"invalid_request",`${name} must be a positive integer`); return value; }
function baseRev(body:Record<string,unknown>):number { if(!Object.hasOwn(body,"baseRev")) throw new ApiError(400,"base_rev_required","baseRev is required"); return integer(body.baseRev,"baseRev"); }
function message(body:Record<string,unknown>):string|undefined { if(body.message===undefined) return; if(typeof body.message!=="string") throw new ApiError(400,"invalid_request","message must be a string"); return body.message; }
/**
 * Kill-switch D16 (план `docs/plans/2026-08-02-multi-surface-flows.md`): запись документа с
 * `doc.surfaces` разрешена только при `EASYUI_SURFACES=1`.
 *
 * **Полярность обратна `EASYUI_PUBLISH_GATES`** (там пустая переменная = ничего не блокируется):
 * здесь пусто = фича выключена, чтобы прод не накапливал мульти-поверхностные документы до
 * продуктовой приёмки — откат образа на версию без фичи иначе ломает чтение таких доков.
 * Гейтится **только запись** (create/save): чтение stored-документов не гейтится никогда.
 *
 * Env читается по месту (прецедент `parsePublishGates`, `server/readiness.ts`), поэтому
 * параметр `raw` существует для тестов.
 */
export const surfacesWriteEnabled = (raw:string|undefined=process.env.EASYUI_SURFACES):boolean => raw==="1";

/**
 * Первый элемент документа (в порядке экранов и ключей), объявивший `overflowOwnership` — путём для
 * `issues`. `null` — деклараций нет вовсе, и запись остаётся доволновой.
 *
 * Ищется и элементное поле (канон — в него компилируется и composition layout-токен), и
 * одноимённый prop — оборонительно: рукописный документ, положивший декларацию в props, обязан
 * упереться в тот же тумблер, а не проехать мимо него молча.
 */
function firstOverflowOwnershipPath(doc:PrototypeDoc):(string|number)[]|null {
  for(const screen of doc.screens??[]) {
    for(const [key,element] of Object.entries(screen.spec?.elements??{})) {
      const item=element as {overflowOwnership?:unknown;props?:Record<string,unknown>};
      if(item.overflowOwnership!==undefined) return ["screens",screen.id,"spec","elements",key,"overflowOwnership"];
      if(item.props?.overflowOwnership!==undefined) return ["screens",screen.id,"spec","elements",key,"props","overflowOwnership"];
    }
  }
  return null;
}

function parseDoc(value:unknown,pathId?:string):PrototypeDoc {
  const parsed=inputPrototypeDocSchema.safeParse(value);
  if(!parsed.success) throw new ApiError(422,"validation_failed","Prototype document is invalid",{issues:parsed.error.issues});
  if(parsed.data.surfaces&&!surfacesWriteEnabled()) throw new ApiError(422,"surfaces_disabled","Multi-surface documents are disabled on this server (EASYUI_SURFACES)",{issues:[{path:["surfaces"],message:"doc.surfaces requires EASYUI_SURFACES=1 on the server"}]});
  // BR-09 (план 2026-08-08 §9): `overflowOwnership` — персистируемая форма в строгом allowlist, и
  // документ с ней старый образ не прочитает вовсе. Поэтому **запись** гейтится kill-switch'ем
  // группы владения геометрией, а чтение stored-документов — никогда (канон `doc.surfaces`).
  const owner=firstOverflowOwnershipPath(parsed.data);
  if(owner!==null&&!geometryOwnershipEnabled()) throw new ApiError(422,"flow_overflow_ownership_disabled","FlowRoot overflow ownership is disabled on this server (EASYUI_GEOMETRY_OWNERSHIP_DISABLED=1)",{issues:[{path:owner,message:"elements[].overflowOwnership requires the geometry ownership wave to be enabled"}]});
  if(pathId!==undefined&&parsed.data.id!==pathId) throw new ApiError(422,"validation_failed","Document id must match path id",{issues:[{path:["id"],message:"must match path id"}]});
  return parsed.data;
}

// Task 3 can resolve exact custom-version pins and pass the merged definitions here.
// `kind` — вид прототипа (волна 0). Архитектурные линты волны 2 не применяются к служебным
// видам: галереи компонентов и evidence-экраны законно состоят из одного компонента.
export function validatePrototypeForSave(doc:PrototypeDoc, definitions?:Record<string,ComponentDefinition>, kind?:string,
  surfaces?:{definitionsBySurface?:Record<string,Record<string,ComponentDefinition>>;themes?:Record<string,{fonts?:{family?:unknown}[]}>;componentMeta?:Record<string,ComponentSchemaContext>}) {
  // API saves always pass the registry-backed snapshot. This fallback is only for
  // bundled seed documents, which support provider systems and no custom types.
  const resolved=definitions??designSystems[doc.designSystem as keyof typeof designSystems]?.definitions;
  if(!resolved) throw new ApiError(422,"validation_failed","Prototype document is invalid",{issues:[{path:["designSystem"],message:`unknown design system: ${doc.designSystem}`}]});
  const result=validatePrototype(doc,{definitions:resolved,kind,...(surfaces?.definitionsBySurface?{definitionsBySurface:surfaces.definitionsBySurface}:{}),...(surfaces?.componentMeta?{componentMeta:surfaces.componentMeta}:{}),...(surfaces?.themes?{themes:surfaces.themes}:{})});
  if(result.errors.length) throw new ApiError(422,"validation_failed","Prototype document is invalid",{issues:result.errors,warnings:result.warnings});
  return result.warnings;
}

// Record a validation ledger entry for a freshly saved/restored revision. The catalog hash
// is read back from the revision row so it stays consistent for provider-less systems too.
function recordPrototypeValidation(db:Database,id:string,rev:number,issues:{path:string;message:string}[],ok=true):void {
  const row=db.query("SELECT builtin_catalog_hash hash FROM prototype_revisions WHERE prototype_id=? AND rev=?").get(id,rev) as {hash:string}|null;
  recordValidation(db,{resourceType:"prototype",resourceId:id,rev,catalogHash:row?.hash??"",ok,issues});
}

// Create a prototype from a fully-formed document (extracted from the POST branch so the bundle
// importer reuses the exact snapshot/validation/audit/ledger sequence). Behaviour of POST is unchanged.
export async function createPrototypeFromDoc(db:Database,repo:PrototypeRepo,doc:PrototypeDoc,dataDir:string,ownerId:string,opts:{message?:string;figmaInput?:unknown;lifecycle?:PrototypeLifecyclePatch}={}) {
  // Композиции раскрываются ПЕРЕД снимком определений и сбором ассетов (B3): пины полны.
  const expansion=expandPrototypeForSave(db,doc);
  const snapshot=await snapshotDefinitions(db,expansion.doc,dataDir);
  const warnings=validatePrototypeForSave(expansion.doc,snapshot.definitions,opts.lifecycle?.kind,{definitionsBySurface:snapshot.definitionsBySurface,componentMeta:snapshot.componentMeta,themes:themesForDoc(db,expansion.doc)});
  const assetIds=collectAndValidateAssetRefs(db,expansion.doc);
  const figma=parseFigmaInput(db,opts.figmaInput,"figma");
  // В БД едет авторский документ, пины — от раскрытого.
  const result=repo.create(doc,opts.message,snapshot.pins,assetIds,figma,ownerId,opts.lifecycle,expansion.pins);
  db.query("UPDATE prototype_revisions SET author=? WHERE prototype_id=? AND rev=?").run(ownerId,doc.id,result.rev);
  writeAuditEvent(db,{actorId:ownerId,action:"prototype.revision.saved",subjectType:"prototype",subjectId:doc.id,detail:{rev:result.rev}});
  recordPrototypeValidation(db,doc.id,result.rev,warnings);
  return {id:result.id,rev:result.rev,warnings,...resolvedComponentsBlock(snapshot.graph)};
}

// Save a new head revision from a document (used by the bundle importer for an owned id whose
// document differs from head). Mirrors the PUT save sequence; the route's PUT branch is unchanged.
export async function updatePrototypeFromDoc(db:Database,repo:PrototypeRepo,id:string,doc:PrototypeDoc,baseRev:number,dataDir:string,ownerId:string,opts:{message?:string;figmaInput?:unknown}={}) {
  const expansion=expandPrototypeForSave(db,doc);
  const snapshot=await snapshotDefinitions(db,expansion.doc,dataDir);
  const warnings=validatePrototypeForSave(expansion.doc,snapshot.definitions,repo.lifecycle(id).kind,{definitionsBySurface:snapshot.definitionsBySurface,componentMeta:snapshot.componentMeta,themes:themesForDoc(db,expansion.doc)});
  const assetIds=collectAndValidateAssetRefs(db,expansion.doc);
  const figma=parseFigmaInput(db,opts.figmaInput,"figma");
  const saved=repo.save(id,doc,baseRev,opts.message,snapshot.pins,assetIds,figma,expansion.pins);
  db.query("UPDATE prototype_revisions SET author=? WHERE prototype_id=? AND rev=?").run(ownerId,id,saved.rev);
  writeAuditEvent(db,{actorId:ownerId,action:"prototype.revision.saved",subjectType:"prototype",subjectId:id,detail:{rev:saved.rev}});
  recordPrototypeValidation(db,id,saved.rev,warnings);
  return {rev:saved.rev,warnings,...resolvedComponentsBlock(snapshot.graph)};
}

export async function routePrototypes(request:Request,db:Database,segments:string[],principal:Principal,dataDir=process.env.DATA_DIR||"data",serveDist?:string):Promise<Response> {
  const repo=new PrototypeRepo(db);
  if(segments.length===1) {
    if(request.method==="GET") { const url=new URL(request.url); return json(repo.list(principal,kindFilter(url),{includeAll:includeAllScope(url,principal)}),200,noStore); }
    if(request.method==="POST") { const actor=requireUser(principal); const b=objectBody(await readJson(request)); const doc=parseDoc(b.doc); const result=await createPrototypeFromDoc(db,repo,doc,dataDir,actor.userId,{message:message(b),figmaInput:b.figma,lifecycle:lifecycleFields(b)}); return json({...result,screens:headScreens(doc)},201,{...noStore,location:`/api/prototypes/${encodeURIComponent(result.id)}`}); }
    throw new ApiError(405,"method_not_allowed","Method not allowed");
  }
  const id=segments[1]!; const tail=segments.slice(2);
  if(!tail.length) {
    if(request.method==="GET") return json(repo.meta(id,principal),200,noStore);
    if(request.method==="PUT") { const actor=requirePrototypeOwner(db,id,principal); const b=objectBody(await readJson(request)); const base=baseRev(b); const doc=parseDoc(b.doc,id); const expansion=expandPrototypeForSave(db,doc); const snapshot=await snapshotDefinitions(db,expansion.doc,dataDir); const warnings=validatePrototypeForSave(expansion.doc,snapshot.definitions,repo.lifecycle(id).kind,{definitionsBySurface:snapshot.definitionsBySurface,componentMeta:snapshot.componentMeta,themes:themesForDoc(db,expansion.doc)}); const assetIds=collectAndValidateAssetRefs(db,expansion.doc); const figma=parseFigmaInput(db,b.figma,"figma"); const saved=repo.save(id,doc,base,message(b),snapshot.pins,assetIds,figma,expansion.pins); db.query("UPDATE prototype_revisions SET author=? WHERE prototype_id=? AND rev=?").run(actor.userId,id,saved.rev); writeAuditEvent(db,{actorId:actor.userId,action:"prototype.revision.saved",subjectType:"prototype",subjectId:id,detail:{rev:saved.rev}}); recordPrototypeValidation(db,id,saved.rev,warnings); return json({...saved,warnings,screens:headScreens(doc),...resolvedComponentsBlock(snapshot.graph)},200,noStore); }
    if(request.method==="DELETE") { requirePrototypeOwner(db,id,principal); const b=objectBody(await readJson(request)); repo.delete(id,baseRev(b)); return new Response(null,{status:204,headers:noStore}); }
    throw new ApiError(405,"method_not_allowed","Method not allowed");
  }
  if(tail[0]==="screens"&&tail.length===3&&tail[2]==="render-status") { if(request.method!=="GET") throw new ApiError(405,"method_not_allowed","Method not allowed"); requirePrototypeRead(db,id,principal); return renderStatus(request,db,id,tail[1]!,{serveDist}); }
  if(tail[0]==="draft"&&tail.length===1) { if(request.method!=="GET") throw new ApiError(405,"method_not_allowed","Method not allowed"); return json(repo.draft(id,principal),200,noStore); }
  if(tail[0]==="export"&&tail.length===1) {
    if(request.method!=="GET") throw new ApiError(405,"method_not_allowed","Method not allowed");
    const access=requirePrototypeRead(db,id,principal);
    const versionRaw=new URL(request.url).searchParams.get("version"); const version=versionRaw===null?undefined:integer(Number(versionRaw),"version");
    const closure=new BundleClosure(db,dataDir); const exported=closure.addPrototype(id,{owner:access.owner,version});
    const bytes=await closure.buildZip("prototype",new URL(request.url).origin);
    const suffix=exported.selector==="draft"?`draft-r${exported.rev}`:`v${exported.version}`;
    return zipResponse(bytes,`easy-ui-prototype-${id}-${suffix}.zip`);
  }
  if(tail[0]==="revisions") {
    if(request.method!=="GET") throw new ApiError(405,"method_not_allowed","Method not allowed");
    if(tail.length===2&&principal.kind==="capture") { requirePrototypeRead(db,id,principal); return json(repo.revision(id,integer(Number(tail[1]),"rev"),principal),200,noStore); }
    requirePrototypeOwner(db,id,principal);
    if(tail.length===3&&tail[2]==="diff") {
      const rev=integer(Number(tail[1]),"rev"); const u=new URL(request.url); const againstRaw=u.searchParams.get("against");
      if(againstRaw===null&&rev===1) throw new ApiError(400,"invalid_request","against is required for revision 1");
      const against=againstRaw===null?rev-1:integer(Number(againstRaw),"against");
      if(against===rev) throw new ApiError(400,"invalid_request","against must differ from rev");
      const toDto=repo.revision(id,rev); const fromDto=repo.revision(id,against);
      // The schema parser used by ordinary revision reads can discard an own
      // `__proto__` key. Diff needs the already-validated row's original JSON so
      // adversarial map keys remain observable; pins and render inputs stay DTO-backed.
      const rawDoc=(revision:number) => JSON.parse((db.query("SELECT doc FROM prototype_revisions WHERE prototype_id=? AND rev=?").get(id,revision) as {doc:string}).doc);
      const to={...toDto,doc:rawDoc(rev)}; const from={...fromDto,doc:rawDoc(against)};
      return json(diffPrototypeDocs(from,to),200,noStore);
    }
    if(tail.length===2) return json(repo.revision(id,integer(Number(tail[1]),"rev")),200,noStore);
    const u=new URL(request.url); const limitRaw=u.searchParams.get("limit"); const beforeRaw=u.searchParams.get("before"); const limit=limitRaw===null?20:integer(Number(limitRaw),"limit"); if(limit>100) throw new ApiError(400,"invalid_request","limit must not exceed 100"); const before=beforeRaw===null?undefined:integer(Number(beforeRaw),"before"); return json(repo.revisions(id,limit,before),200,noStore);
  }
  if(tail[0]==="restore"&&tail.length===1) {
    if(request.method!=="POST") throw new ApiError(405,"method_not_allowed","Method not allowed");
    const actor=requirePrototypeOwner(db,id,principal);
    const b=objectBody(await readJson(request)); const result=repo.restore(id,integer(b.rev,"rev"),baseRev(b));
    // Re-validate the restored document against the live catalog and record the result.
    const draft=repo.draft(id); let ok=true; let issues:{path:string;message:string}[]=[];
    try { const expansion=expandPrototypeForSave(db,draft.doc); const snapshot=await snapshotDefinitions(db,expansion.doc,dataDir); const validation=validatePrototype(expansion.doc,{definitions:snapshot.definitions,definitionsBySurface:snapshot.definitionsBySurface,componentMeta:snapshot.componentMeta,themes:themesForDoc(db,expansion.doc)}); ok=validation.errors.length===0; issues=[...validation.errors,...validation.warnings]; }
    catch(error) { ok=false; issues=[{path:"/",message:error instanceof ApiError?error.message:"Restored document failed validation"}]; }
    recordPrototypeValidation(db,id,result.rev,issues,ok);
    db.query("UPDATE prototype_revisions SET author=? WHERE prototype_id=? AND rev=?").run(actor.userId,id,result.rev); writeAuditEvent(db,{actorId:actor.userId,action:"prototype.revision.saved",subjectType:"prototype",subjectId:id,detail:{rev:result.rev,restore:true}});
    return json(result,200,noStore);
  }
  // План импакт-съёмки галереи (план 2026-08-07 §W5): какие экраны обязаны быть сняты и почему,
  // а какие переиспользуются с доказательством. Ручка **ничего не пишет и ничего не ставит в
  // очередь** — это чистое чтение поверх уже записанных кадров.
  //
  // Гейта `EASYUI_ACCEPTANCE_MATRIX` здесь нет намеренно: план работает и без матричной приёмки —
  // галерейная съёмка к ней не относится. Единственный переключатель — kill-switch волны.
  if(tail[0]==="snap-plan"&&tail.length===1) {
    if(request.method!=="POST") throw new ApiError(405,"method_not_allowed","Method not allowed");
    if(!impactedSnapEnabled()) throw new ApiError(404,"not_found","Impacted snap planning is disabled (EASYUI_IMPACTED_SNAP_DISABLED)");
    requirePrototypeOwner(db,id,principal);
    const b=objectBody(await readJson(request));
    const rev=b.rev===undefined?undefined:integer(b.rev,"rev");
    const version=b.version===undefined?undefined:integer(b.version,"version");
    if(rev!==undefined&&version!==undefined) throw new ApiError(400,"invalid_request","rev and version are mutually exclusive");
    // Нормализация поверхности — общей функцией постановки джобы: план и съёмка обязаны считать
    // один и тот же отпечаток.
    const {viewport,dsf}=validateViewport(b.viewport,b.deviceScaleFactor);
    if(b.theme!==undefined&&b.theme!=="light"&&b.theme!=="dark") throw new ApiError(400,"invalid_request","theme must be light or dark");
    if(b.readiness!==undefined&&b.readiness!=="barrier") throw new ApiError(400,"invalid_request","readiness must be \"barrier\"");
    let screenIds:string[]|undefined;
    if(b.screens!==undefined) {
      if(!Array.isArray(b.screens)||b.screens.some(screen=>typeof screen!=="string"||screen.length===0)) throw new ApiError(400,"invalid_request","screens must be an array of screen ids");
      screenIds=b.screens as string[];
    }
    return json(buildSnapPlan(db,{
      prototypeId:id,rev,version,viewport,dsf,
      theme:b.theme==="dark"?"dark":"light",
      ...(b.readiness==="barrier"?{readinessPolicy:barrierAwareReadinessPolicy("gallery")}:{}),
      ...(screenIds?{screenIds}:{}),
    }),200,noStore);
  }
  if(tail[0]==="readiness"&&tail.length===1) {
    if(request.method!=="GET") throw new ApiError(405,"method_not_allowed","Method not allowed");
    requirePrototypeRead(db,id,principal);
    return json(await computeReadiness(db,id,{dataDir,serveDist}),200,noStore);
  }
  // Перепин головы на актуальные active-публикации. Тонкая обёртка: пины пересчитывает
  // `snapshotDefinitions` внутри `updatePrototypeFromDoc`, параллельного pin-writer'а нет.
  // `?dryRun=1` считает diff без записи; запись пропускается и когда diff пуст.
  if(tail[0]==="repin"&&tail.length===1) {
    if(request.method!=="POST") throw new ApiError(405,"method_not_allowed","Method not allowed");
    const actor=requirePrototypeOwner(db,id,principal);
    const dryRun=new URL(request.url).searchParams.get("dryRun")==="1";
    const head=repo.draft(id);
    const before=head.components;
    const snapshot=await snapshotDefinitions(db,expandPrototypeForSave(db,head.doc).doc,dataDir);
    const beforeByName=new Map(before.map(pin=>[pin.name,pin.version]));
    const afterByName=new Map(snapshot.pins.map(pin=>[pin.name,pin.version]));
    const names=[...new Set([...beforeByName.keys(),...afterByName.keys()])].sort();
    const changed=names.filter(name=>beforeByName.get(name)!==afterByName.get(name))
      .map(name=>({component:name,from:beforeByName.get(name)??null,to:afterByName.get(name)??null}));
    // `snapshotDefinitions` резолвит только active-публикации, поэтому статус проекции — active.
    const projected=snapshot.pins.map(pin=>({id:pin.id,name:pin.name,version:pin.version,bundleHash:pin.bundleHash,status:"active",
      bundleUrl:`/api/components/${encodeURIComponent(pin.id)}/versions/${pin.version}/bundle.js`}));
    if(dryRun||!changed.length) return json({dryRun,rev:head.rev,before,after:projected,changed},200,noStore);
    await updatePrototypeFromDoc(db,repo,id,head.doc,head.rev,dataDir,actor.userId,{message:"Repin components"});
    const after=repo.draft(id);
    writeAuditEvent(db,{actorId:actor.userId,action:"prototype.repinned",subjectType:"prototype",subjectId:id,detail:{rev:after.rev,changed}});
    return json({dryRun:false,rev:after.rev,before,after:after.components,changed},200,noStore);
  }
  if(tail[0]==="publish"&&tail.length===1) {
    if(request.method!=="POST") throw new ApiError(405,"method_not_allowed","Method not allowed");
    const actor=requirePrototypeOwner(db,id,principal);
    // Гейт track:head — до дорогого readiness-прогона (P2.2).
    assertPinnedTrack(db,id,"publish");
    const b=objectBody(await readJson(request));
    const base=baseRev(b);
    if(b.force!==undefined&&typeof b.force!=="boolean") throw new ApiError(400,"invalid_request","force must be a boolean");
    const force=b.force===true;
    // Readiness считается здесь, а не в `repo.publish`: тот — синхронная db.transaction,
    // а `snapshotDefinitions` асинхронен (M5 ревью). TOCTOU снимается сверкой rev.
    const report=await computeReadiness(db,id,{dataDir,serveDist});
    if(report.rev!==base) throw new ApiError(409,"revision_conflict","Prototype revision has changed",{currentRev:report.rev});
    if(report.blocking.length&&!force) throw new ApiError(409,"publish_blocked","Prototype is not ready to publish",{report});
    if(report.blocking.length&&force) writeAuditEvent(db,{actorId:actor.userId,action:"prototype.publish.forced",subjectType:"prototype",subjectId:id,detail:{rev:report.rev,blocking:report.blocking}});
    const result=repo.publish(id,base,message(b));
    writeAuditEvent(db,{actorId:actor.userId,action:"prototype.version.published",subjectType:"prototype",subjectId:id,detail:result});
    const published=repo.version(id,result.version);
    return json({...result,screens:published.doc.screens.map(s=>({id:s.id,url:versionScreenUrl(id,result.version,s.id)}))},201,{...noStore,location:`/api/prototypes/${encodeURIComponent(id)}/versions/${result.version}`});
  }
  if(tail[0]==="status"&&tail.length===1) { if(request.method!=="POST") throw new ApiError(405,"method_not_allowed","Method not allowed"); const actor=requirePrototypeOwner(db,id,principal); const b=objectBody(await readJson(request)); if(b.status!=="private"&&b.status!=="published"&&b.status!=="archived") throw new ApiError(422,"validation_failed","Invalid prototype status",{issues:[{path:["status"],message:"must be private, published, or archived"}]}); const result=repo.setStatus(id,b.status); writeAuditEvent(db,{actorId:actor.userId,action:"prototype.status.changed",subjectType:"prototype",subjectId:id,detail:result}); return json(result,200,noStore); }
  if(tail[0]==="lifecycle"&&tail.length===1) {
    if(request.method!=="POST") throw new ApiError(405,"method_not_allowed","Method not allowed");
    const actor=requirePrototypeOwner(db,id,principal);
    const patch=parseLifecycle(objectBody(await readJson(request)));
    // Пустой патч — read-back без записи и без audit-события.
    if(!Object.keys(patch).length) return json(repo.lifecycle(id),200,noStore);
    const before=repo.lifecycle(id);
    const result=repo.setLifecycle(id,patch);
    writeAuditEvent(db,{actorId:actor.userId,action:"prototype.lifecycle.changed",subjectType:"prototype",subjectId:id,detail:result});
    // P9(г): смена вида — отдельное аудит-событие с from/to. `kind` мутабелен и снимает
    // архитектурные линты и readiness-порог, поэтому переход обязан быть прослеживаемым.
    if(before.kind!==result.kind) writeAuditEvent(db,{actorId:actor.userId,action:"prototype.kind.changed",subjectType:"prototype",subjectId:id,detail:{from:before.kind,to:result.kind}});
    // P2: включение/выключение head-tracking — тоже отдельное событие.
    if(before.track!==result.track) writeAuditEvent(db,{actorId:actor.userId,action:"prototype.track.changed",subjectType:"prototype",subjectId:id,detail:{from:before.track,to:result.track}});
    return json(result,200,noStore);
  }
  if(tail[0]==="versions") {
    if(request.method!=="GET") throw new ApiError(405,"method_not_allowed","Method not allowed");
    requirePrototypeRead(db,id,principal);
    if(tail.length===1) return json(repo.versions(id),200,noStore);
    if(tail.length===2) return json(repo.version(id,integer(Number(tail[1]),"version"),principal),200,immutable);
  }
  throw new ApiError(404,"not_found","API route not found");
}
