import type {Database} from "bun:sqlite";
import {builtinCatalogHashFor} from "../builtinHash";
import {catalogDefinitionDescriptor,getDesignSystemVersion,getLatestDesignSystemContent,getRegisteredDesignSystem,hostPrimitiveDescriptors,insertDesignSystemVersion,latestDesignSystemMetaVersion,listRegisteredDesignSystems,type RegisteredDesignSystem} from "../designSystems";
import {parseThemePatch,validateThemeAssets,type ThemeContent} from "../designSystemsMeta";
import {ApiError,json,noStore,readJson} from "../http";
import {resolveSpacingScale} from "../../src/designSystems/spacingScale";

function summary(db:Database,system:RegisteredDesignSystem) {
  const theme=getLatestDesignSystemContent(db,system.id);
  const resolvedSpaceScale=resolveSpacingScale(system.id,theme.tokens);
  return {
    id:system.id,name:system.name,description:system.description,
    builtinCatalogHash:builtinCatalogHashFor(system.id,system.definitions,resolvedSpaceScale),
    resolvedSpaceScale,
    components:Object.entries(system.definitions).map(([name,definition])=>catalogDefinitionDescriptor(name,definition)),
    hostPrimitives:hostPrimitiveDescriptors,
    latestMetaVersion:theme.latestMetaVersion,
    tokens:theme.tokens,fonts:theme.fonts,icons:theme.icons,
  };
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

// PATCH a custom system's theme: creates the immutable version baseVersion+1 (CAS on latest).
async function patchTheme(request:Request,db:Database,system:RegisteredDesignSystem):Promise<Response> {
  if(system.builtinProvider!==null) throw new ApiError(405,"method_not_allowed","Builtin design-system themes are immutable");
  const patch=parseThemePatch(await readObjectBody(request));
  const latest=latestDesignSystemMetaVersion(db,system.id)??0;
  if(patch.baseVersion!==latest) throw new ApiError(409,"version_conflict","Design-system theme version has changed",{currentVersion:latest});
  const previous:ThemeContent=latest===0?{tokens:{},fonts:[],icons:[]}:getDesignSystemVersion(db,system.id,latest)!;
  // PATCH semantics: a provided collection replaces the previous one; an omitted one is inherited.
  const content:ThemeContent={
    tokens:patch.tokens??previous.tokens,
    fonts:patch.fonts??previous.fonts,
    icons:patch.icons??previous.icons,
  };
  validateThemeAssets(db,content);
  const version=latest+1; const at=new Date().toISOString();
  db.transaction(()=>{ insertDesignSystemVersion(db,system.id,version,content,at); db.query("UPDATE design_systems SET updated_at=? WHERE id=?").run(at,system.id); })();
  return json(summary(db,getRegisteredDesignSystem(db,system.id)!),200,noStore);
}

export async function routeDesignSystems(request:Request,db:Database,segments:string[]):Promise<Response> {
  // segments: ["design-systems", id?, "versions"?, v?]
  if(segments.length>=3) {
    if(segments.length===4&&segments[2]==="versions") {
      if(request.method!=="GET") throw new ApiError(405,"method_not_allowed","Method not allowed");
      const system=getRegisteredDesignSystem(db,segments[1]!); if(!system) throw new ApiError(404,"not_found","Design system not found");
      const raw=segments[3]!; if(!/^[1-9][0-9]*$/.test(raw)) throw new ApiError(404,"not_found","Design system version not found");
      const content=getDesignSystemVersion(db,system.id,Number(raw));
      if(!content) throw new ApiError(404,"not_found","Design system version not found");
      return json({systemId:system.id,version:content.version,tokens:content.tokens,fonts:content.fonts,icons:content.icons,createdAt:content.createdAt},200,noStore);
    }
    throw new ApiError(404,"not_found","Design system not found");
  }
  const id=segments.length===2?segments[1]:null;
  if(request.method==="GET") {
    if(id) { const system=getRegisteredDesignSystem(db,id); if(!system) throw new ApiError(404,"not_found","Design system not found"); return json(summary(db,system),200,noStore); }
    return json({designSystems:listRegisteredDesignSystems(db).map((s)=>summary(db,s))},200,noStore);
  }
  if(request.method==="POST"&&!id) {
    const input=validate(await readObjectBody(request)); const at=new Date().toISOString();
    try { db.query("INSERT INTO design_systems (id,name,description,builtin_provider,created_at,updated_at) VALUES (?,?,?,NULL,?,?)").run(input.id,input.name,input.description,at,at); }
    catch(error) { if(String(error).includes("UNIQUE constraint failed")) throw new ApiError(409,"already_exists","Design system already exists"); throw error; }
    return json(summary(db,getRegisteredDesignSystem(db,input.id)!),201,{...noStore,location:`/api/design-systems/${input.id}`});
  }
  if(request.method==="PATCH"&&id) { const system=getRegisteredDesignSystem(db,id); if(!system) throw new ApiError(404,"not_found","Design system not found"); return patchTheme(request,db,system); }
  throw new ApiError(405,"method_not_allowed","Method not allowed");
}
