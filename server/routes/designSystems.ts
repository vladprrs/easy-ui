import type {Database} from "bun:sqlite";
import {builtinCatalogHashFor} from "../builtinHash";
import {catalogDefinitionDescriptor,getDesignSystemVersion,getLatestDesignSystemContent,getIncludingRetired,hostPrimitiveDescriptors,insertDesignSystemVersion,latestDesignSystemMetaVersion,listActiveDesignSystems,type RegisteredDesignSystem} from "../designSystems";
import {applySparsePatch,inheritSpaceTokens,parseThemePatch,spaceTokenIssues,themeContentEqual,themeDiff,validateThemeAssets,type ThemeContent} from "../designSystemsMeta";
import {ApiError,json,noStore,readJson} from "../http";
import {CURRENT_SPACING_RESOLVER,LEGACY_SPACING_RESOLVER,resolveSpacingScale,type SpacingResolver} from "../../src/designSystems/spacingScale";
import type {Principal} from "../auth";
import {requireResourceOwner,requireUser} from "../authorization";
import {writeAuditEvent} from "../audit";

/** Опции роута; env читается один раз на входе процесса (см. server/main.ts), как у reuseGateMode. */
export type DesignSystemRouteOptions={
  /** Kill-switch P6.3: `EASYUI_THEME_RESOLVER_V2_DISABLED=1` — новые версии тем пишутся с legacy-резолвером и без наследования `space.*`. */
  spacingResolverV2Disabled?:boolean;
};

type ThemeView=ThemeContent&{latestMetaVersion:number|null;spacingResolver:SpacingResolver};

function summaryOf(system:RegisteredDesignSystem,theme:ThemeView) {
  const resolvedSpaceScale=resolveSpacingScale(system.id,theme.tokens,theme.spacingResolver);
  return {
    id:system.id,name:system.name,description:system.description,
    retired:system.retired,
    builtinCatalogHash:builtinCatalogHashFor(system.id,system.definitions,resolvedSpaceScale),
    resolvedSpaceScale,
    components:Object.entries(system.definitions).map(([name,definition])=>catalogDefinitionDescriptor(name,definition)),
    hostPrimitives:hostPrimitiveDescriptors,
    latestMetaVersion:theme.latestMetaVersion,
    tokens:theme.tokens,fonts:theme.fonts,icons:theme.icons,
  };
}

function summary(db:Database,system:RegisteredDesignSystem) {
  return summaryOf(system,getLatestDesignSystemContent(db,system.id));
}

/**
 * Прототипы этой системы, чья головная ревизия пинует устаревшую версию темы (P6.4). Дёшево —
 * один join по головным ревизиям; список ограничен, полный размер отдаётся счётчиком.
 */
const STALE_PIN_LIMIT=50;
function stalePins(db:Database,systemId:string,currentVersion:number):{total:number;limit:number;prototypes:{id:string;name:string;pinnedVersion:number|null}[]} {
  const rows=db.query(`SELECT p.id id,p.name name,r.design_system_meta_version pinnedVersion
    FROM prototypes p JOIN prototype_revisions r ON r.prototype_id=p.id AND r.rev=p.head_rev
    WHERE p.design_system=? AND (r.design_system_meta_version IS NULL OR r.design_system_meta_version<?)
    ORDER BY p.id`).all(systemId,currentVersion) as {id:string;name:string;pinnedVersion:number|null}[];
  return {total:rows.length,limit:STALE_PIN_LIMIT,prototypes:rows.slice(0,STALE_PIN_LIMIT)};
}

function validate(value:unknown):{id:string;name:string;description:string} {
  if(!value||typeof value!=="object"||Array.isArray(value)) throw new ApiError(400,"invalid_request","Request body must be an object");
  const input=value as Record<string,unknown>,issues:{path:string[];message:string}[]=[];
  for(const key of Object.keys(input)) if(!["id","name","description"].includes(key)) issues.push({path:[key],message:"Unknown field"});
  const id=input.id,name=input.name,description=input.description;
  if(typeof id!=="string"||!id.length||id.length>120||id!==id.trim()||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) issues.push({path:["id"],message:"Must be a lowercase slug"});
  if(typeof name!=="string"||!name.trim()||name.length>120||name!==name.trim()) issues.push({path:["name"],message:"Must be a trimmed non-empty string of at most 120 characters"});
  if(typeof description!=="string"||!description.trim()||description.length>500||description!==description.trim()) issues.push({path:["description"],message:"Must be a trimmed non-empty string of at most 500 characters"});
  if(issues.length) throw new ApiError(422,"validation_failed","Design system validation failed",{issues});
  return {id:id as string,name:name as string,description:description as string};
}

async function readObjectBody(request:Request):Promise<unknown> {
  try { return await readJson(request); }
  catch(error) { if(error instanceof ApiError&&error.code==="invalid_json") throw new ApiError(400,"invalid_request","Request body must be valid JSON"); throw error; }
}

/**
 * PATCH темы кастомной системы: создаёт неизменяемую версию `baseVersion+1` (CAS на latest).
 *
 * План 2026-08-02 P6:
 *  - `dryRun: true` — валидация, дифф и итоговая `resolvedSpaceScale` без записи версии;
 *  - no-op detection — контент, семантически равный `baseVersion`, версию не создаёт;
 *  - sparse `addTokens`/`addFonts`/`addIcons` — append-only мердж поверх `baseVersion`,
 *    конфликт значения → `409 theme_append_conflict`;
 *  - под резолвером 2 полный патч токенов без `space.*` наследует шкалу базовой версии
 *    (дыра «а») и мердж идёт на базовую шкалу DS (дыра «б», версионируется в строке версии).
 */
async function patchTheme(request:Request,db:Database,system:RegisteredDesignSystem,options:DesignSystemRouteOptions):Promise<Response> {
  if(system.builtinProvider!==null) throw new ApiError(405,"method_not_allowed","Builtin design-system themes are immutable");
  const patch=parseThemePatch(await readObjectBody(request));
  const latest=latestDesignSystemMetaVersion(db,system.id)??0;
  if(patch.baseVersion!==latest) throw new ApiError(409,"version_conflict","Design-system theme version has changed",{currentVersion:latest});
  const previousRow=latest===0?null:getDesignSystemVersion(db,system.id,latest)!;
  const previous:ThemeContent=previousRow??{tokens:{},fonts:[],icons:[]};
  const resolverV2=options.spacingResolverV2Disabled!==true;

  // Append-only слой резолвится строго против baseVersion — тот же снимок, что прошёл CAS.
  const appended=applySparsePatch(previous,patch);
  if(appended.conflicts.length) {
    throw new ApiError(409,"theme_append_conflict",`Append-only theme operation conflicts with base version ${latest} (policy appendOnly: existing entries are never overwritten)`,{
      currentVersion:latest,
      issues:appended.conflicts.map((conflict)=>({path:conflict.path,message:conflict.message,existing:conflict.existing,incoming:conflict.incoming})),
    });
  }
  // PATCH semantics: a provided collection replaces the previous one; an omitted one is inherited.
  let tokens=patch.tokens??appended.content.tokens;
  let inheritedSpaceTokens:string[]=[];
  if(patch.tokens&&resolverV2) { const inherited=inheritSpaceTokens(previous,patch.tokens); tokens=inherited.tokens; inheritedSpaceTokens=inherited.inherited; }
  const content:ThemeContent={tokens,fonts:patch.fonts??appended.content.fonts,icons:patch.icons??appended.content.icons};
  // Полнота/монотонность шкалы для sparse-режима проверяется на смердженном наборе: тело
  // append-операции по определению частично.
  if(patch.addTokens&&Object.keys(patch.addTokens).some((key)=>key.startsWith("space."))) {
    const issues=spaceTokenIssues(content.tokens);
    if(issues.length) throw new ApiError(422,"validation_failed","Design-system theme is invalid",{issues:issues.map((issue)=>({path:["tokens",...issue.path],message:`${issue.message} (checked on the merged base ${latest} + addTokens result)`}))});
  }
  validateThemeAssets(db,content);

  const noop=themeContentEqual(previous,content);
  const diff=themeDiff(previous,content);
  // No-op не создаёт версию, поэтому и резолвер остаётся тот, что записан у baseVersion.
  const spacingResolver:SpacingResolver=noop
    ?(previousRow?.spacingResolver??LEGACY_SPACING_RESOLVER)
    :(resolverV2?CURRENT_SPACING_RESOLVER:LEGACY_SPACING_RESOLVER);
  const dryRun=patch.dryRun===true;
  const nextVersion=noop?null:latest+1;
  if(!dryRun&&nextVersion!==null) {
    const at=new Date().toISOString();
    db.transaction(()=>{ insertDesignSystemVersion(db,system.id,nextVersion,content,at,spacingResolver); db.query("UPDATE design_systems SET updated_at=? WHERE id=?").run(at,system.id); })();
  }
  const appliedVersion=dryRun?latest:(nextVersion??latest);
  const view:ThemeView={...content,latestMetaVersion:appliedVersion===0?null:appliedVersion,spacingResolver};
  return json({
    ...summaryOf(getIncludingRetired(db,system.id)!,view),
    dryRun,noop,nextVersion,spacingResolver,diff,inheritedSpaceTokens,
    stalePins:stalePins(db,system.id,appliedVersion),
  },200,noStore);
}

// Артефакты, удерживающие систему живой. Ретайр — не удаление, поэтому пустоту считаем по
// «живым» строкам: компоненты и композиции имеют надгробия (deleted_at), прототипы удаляются
// физически. Триггеры v15 запрещают запись новых артефактов в ретайрнутую систему, но не
// умеют рассказать, почему ретайр невозможен, — счётчики отдаёт 409.
const RETIRE_BLOCKERS=[
  {key:"components",sql:"SELECT COUNT(*) n FROM components WHERE design_system=? AND deleted_at IS NULL"},
  {key:"prototypes",sql:"SELECT COUNT(*) n FROM prototypes WHERE design_system=?"},
  {key:"compositions",sql:"SELECT COUNT(*) n FROM compositions WHERE design_system=? AND deleted_at IS NULL"},
] as const;

function retireBlockers(db:Database,id:string):{counts:Record<string,number>;total:number} {
  const counts:Record<string,number>={};let total=0;
  for(const blocker of RETIRE_BLOCKERS) {
    const n=(db.query(blocker.sql).get(id) as {n:number}).n;
    counts[blocker.key]=n;total+=n;
  }
  return {counts,total};
}

/** Мягкий ретайр кастомной системы: retired=1, без физического удаления и без миграций. */
function retire(db:Database,id:string,principal:Principal):Response {
  requireUser(principal);
  const system=getIncludingRetired(db,id);
  if(!system) throw new ApiError(404,"not_found","Design system not found");
  if(system.builtinProvider!==null) throw new ApiError(405,"method_not_allowed","Builtin design systems cannot be retired");
  const actor=requireResourceOwner(db,"design_systems",id,principal);
  if(system.retired) throw new ApiError(409,"design_system_retired","Design system is already retired");
  const blockers=retireBlockers(db,id);
  if(blockers.total>0) throw new ApiError(409,"design_system_in_use","Design system still owns components, prototypes or compositions",{blockers:{...blockers.counts,total:blockers.total}});
  const at=new Date().toISOString();
  db.query("UPDATE design_systems SET retired=1,updated_at=? WHERE id=?").run(at,id);
  writeAuditEvent(db,{actorId:actor.userId,action:"design_system.retired",subjectType:"design_system",subjectId:id,detail:{at}});
  return new Response(null,{status:204,headers:noStore});
}

export async function routeDesignSystems(request:Request,db:Database,segments:string[],principal:Principal,options:DesignSystemRouteOptions={}):Promise<Response> {
  // segments: ["design-systems", id?, "versions"?, v?]
  if(segments.length>=3) {
    if(segments.length===4&&segments[2]==="versions") {
      if(request.method!=="GET") throw new ApiError(405,"method_not_allowed","Method not allowed");
      const system=getIncludingRetired(db,segments[1]!); if(!system) throw new ApiError(404,"not_found","Design system not found");
      const raw=segments[3]!; if(!/^[1-9][0-9]*$/.test(raw)) throw new ApiError(404,"not_found","Design system version not found");
      const content=getDesignSystemVersion(db,system.id,Number(raw));
      if(!content) throw new ApiError(404,"not_found","Design system version not found");
      return json({systemId:system.id,version:content.version,tokens:content.tokens,fonts:content.fonts,icons:content.icons,createdAt:content.createdAt,
        spacingResolver:content.spacingResolver,resolvedSpaceScale:resolveSpacingScale(system.id,content.tokens,content.spacingResolver)},200,noStore);
    }
    throw new ApiError(404,"not_found","Design system not found");
  }
  const id=segments.length===2?segments[1]:null;
  if(request.method==="GET") {
    if(id) { const system=getIncludingRetired(db,id); if(!system) throw new ApiError(404,"not_found","Design system not found"); return json(summary(db,system),200,noStore); }
    return json({designSystems:listActiveDesignSystems(db).map((s)=>summary(db,s))},200,noStore);
  }
  if(request.method==="POST"&&!id) {
    const actor=requireUser(principal);
    const input=validate(await readObjectBody(request)); const at=new Date().toISOString();
    try { db.query("INSERT INTO design_systems (id,name,description,builtin_provider,created_at,updated_at,owner_id) VALUES (?,?,?,NULL,?,?,?)").run(input.id,input.name,input.description,at,at,actor.userId); }
    catch(error) { if(String(error).includes("UNIQUE constraint failed")) throw new ApiError(409,"already_exists","Design system already exists"); throw error; }
    return json(summary(db,getIncludingRetired(db,input.id)!),201,{...noStore,location:`/api/design-systems/${input.id}`});
  }
  if(request.method==="DELETE"&&id) return retire(db,id,principal);
  if(request.method==="PATCH"&&id) { requireResourceOwner(db,"design_systems",id,principal); const system=getIncludingRetired(db,id); if(!system) throw new ApiError(404,"not_found","Design system not found"); if(system.retired) throw new ApiError(409,"design_system_retired","Retired design-system themes cannot be changed"); return patchTheme(request,db,system,options); }
  throw new ApiError(405,"method_not_allowed","Method not allowed");
}
