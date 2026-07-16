import type { Database } from "bun:sqlite";
import { z } from "zod";
import { DEFAULT_DESIGN_SYSTEM_ID, designSystems } from "../../src/designSystems";
import { compileComponent, typecheckComponent } from "../components/compile";
import { extractDefinition } from "../components/extract-subprocess";
import { EVENT_SCHEMA_NOT_SERIALIZABLE, importPublished, materializeClientSource, materializeSource, sha256 } from "../components/pipeline";
import { ApiError, immutable, json, noStore, readJson } from "../http";
import { ComponentRepo } from "../repos/components";
import { requireRegisteredDesignSystem } from "../designSystems";
import { recordValidation } from "../validationRecords";
import { collectAndValidateComponentAssetRefs } from "../validation";
import { parseFigmaInput } from "../figma";

const slug=/^[a-z0-9]+(?:-[a-z0-9]+)*$/, componentName=/^[A-Z][A-Za-z0-9]*$/;
function bad(message:string,path="source"):never{throw new ApiError(422,"validation_failed","Component is invalid",{issues:[{path:[path],message}]});}
function body(v:unknown){const p=z.record(z.string(),z.unknown()).safeParse(v);if(!p.success)throw new ApiError(400,"invalid_request","Request body must be an object");return p.data;}
function int(v:unknown,name:string){if(typeof v!=="number"||!Number.isInteger(v)||v<1)throw new ApiError(400,"invalid_request",`${name} must be a positive integer`);return v;}
function base(b:Record<string,unknown>){if(!Object.hasOwn(b,"baseRev"))throw new ApiError(400,"base_rev_required","baseRev is required");return int(b.baseRev,"baseRev");}
function text(v:unknown,name:string,required=true){if(v===undefined&&!required)return undefined;if(typeof v!=="string")throw new ApiError(400,"invalid_request",`${name} must be a string`);return v;}
async function checkSource(source:string,path:string,smoke=false){
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

export type PublishHooks={afterStage?:(x:{id:string;version:number;rev:number})=>void|Promise<void>;beforeImport?:(x:{id:string;version:number;rev:number})=>void|Promise<void>};
export async function publishComponent(db:Database,repo:ComponentRepo,id:string,baseRev:number,dataDir:string,message?:string,hooks:PublishHooks={}){
  const revision=repo.source(id); const path=await materializeSource(dataDir,id,revision.rev,revision.source);
  // Validate /api/assets/asset_<sha256> literals in source before staging so a dangling ref fails fast.
  const assetIds=collectAndValidateComponentAssetRefs(db,revision.source);
  const extracted=await checkSource(revision.source,path,true); await typecheckComponent(path); let clientPath=path;if(extracted.serverOnly?.conformanceProps===true)try{clientPath=await materializeClientSource(dataDir,id,revision.rev,revision.source,true);}catch(error){bad(error instanceof Error?error.message:String(error));}const compiled=await compileComponent(clientPath,{capabilities:extracted.meta!.capabilities});
  const staged=repo.stage(id,baseRev,{compiledJs:compiled.compiledJs,bundleHash:compiled.bundleHash,sourceHash:sha256(revision.source),meta:extracted.meta!},message);
  // stage() persists host_abi_version=1; update to the computed ABI (max of imports/capabilities).
  if(compiled.hostAbiVersion!==1) db.query("UPDATE component_publishes SET host_abi_version=? WHERE component_id=? AND version=?").run(compiled.hostAbiVersion,id,staged.version);
  await hooks.afterStage?.({id,...staged});
  try { await hooks.beforeImport?.({id,...staged}); await importPublished(id,staged.rev,path); repo.activate(id,staged.version); repo.pinAssets(id,staged.version,assetIds); }
  catch(error){repo.fail(id,staged.version);const detail=error instanceof Error?error.message:String(error);recordValidation(db,{resourceType:"component",resourceId:id,rev:staged.rev,catalogHash:compiled.bundleHash,ok:false,issues:[{path:"/source",message:detail}]});throw new ApiError(422,"validation_failed","Published component import failed",{issues:[{path:["source"],message:detail}]});}
  recordValidation(db,{resourceType:"component",resourceId:id,rev:staged.rev,catalogHash:compiled.bundleHash,ok:true,issues:extracted.warnings.map(message=>({path:"/",message}))});
  const warnings=[...extracted.warnings];
  if(!extracted.meta!.atomicLevel) warnings.push("Atomic design level is not provided; component will be classified as Other");
  return {version:staged.version,hostAbiVersion:compiled.hostAbiVersion,warnings};
}

export function catalogManifest(db:Database,designSystem?:string){return (db.query(`SELECT c.id,c.name,r.design_system,p.version,p.bundle_hash,p.definition_meta,p.host_abi_version FROM components c JOIN component_publishes p ON p.component_id=c.id AND p.status='active' JOIN component_revisions r ON r.component_id=p.component_id AND r.rev=p.rev WHERE c.deleted_at IS NULL${designSystem===undefined?"":" AND r.design_system=?"} AND p.version=(SELECT MAX(x.version) FROM component_publishes x JOIN component_revisions xr ON xr.component_id=x.component_id AND xr.rev=x.rev WHERE x.component_id=c.id AND x.status='active' AND xr.design_system=r.design_system) ORDER BY c.id,r.design_system`).all(...(designSystem===undefined?[]:[designSystem])) as {id:string;name:string;design_system:string;version:number;bundle_hash:string;definition_meta:string;host_abi_version:number}[]).map(r=>({id:r.id,name:r.name,designSystem:r.design_system,version:r.version,bundleUrl:`/api/components/${encodeURIComponent(r.id)}/versions/${r.version}/bundle.js`,bundleHash:r.bundle_hash,...JSON.parse(r.definition_meta),hostAbiVersion:r.host_abi_version}));}

export async function routeComponents(request:Request,db:Database,segments:string[],dataDir:string):Promise<Response>{
  const repo=new ComponentRepo(db);
  if(segments.length===1){if(request.method==="GET")return json(repo.list(),200,noStore);if(request.method==="POST"){const b=body(await readJson(request));const id=text(b.id,"id")!,name=text(b.name,"name")!,source=text(b.source,"source")!,designSystem=text(b.designSystem,"designSystem",false)??DEFAULT_DESIGN_SYSTEM_ID;if(!slug.test(id))bad("id must be a slug","id");if(!componentName.test(name))bad("name must match ^[A-Z][A-Za-z0-9]*$","name");requireRegisteredDesignSystem(db,designSystem,["designSystem"]);if(Object.values(designSystems).some(system=>Object.hasOwn(system.definitions,name)))throw new ApiError(409,"already_exists","Component name conflicts with a builtin component");const path=await materializeSource(dataDir,id,1,source);await checkSource(source,path);const figma=parseFigmaInput(db,b.figma,"figma");const result=repo.create(id,name,source,designSystem,text(b.message,"message",false),figma);return json(result,201,{...noStore,location:`/api/components/${id}`});}throw new ApiError(405,"method_not_allowed","Method not allowed");}
  const id=segments[1]!,tail=segments.slice(2);
  if(!tail.length){if(request.method==="GET")return json(repo.meta(id),200,noStore);if(request.method==="PUT"){const b=body(await readJson(request)),source=text(b.source,"source",false),designSystem=text(b.designSystem,"designSystem",false),baseRev=base(b);const figmaProvided=Object.hasOwn(b,"figma");const figma=figmaProvided?parseFigmaInput(db,b.figma,"figma"):null;if(source===undefined&&designSystem===undefined&&!figmaProvided)throw new ApiError(400,"invalid_request","source, designSystem or figma is required");if(designSystem!==undefined)requireRegisteredDesignSystem(db,designSystem,["designSystem"]);const current=repo.cas(id,baseRev),head=repo.source(id,current.head_rev),nextSource=source??head.source,nextSystem=designSystem??current.design_system;if(nextSource===head.source&&nextSystem===current.design_system&&!figmaProvided)throw new ApiError(400,"invalid_request","Component source and design system are unchanged");const next=current.head_rev+1,path=await materializeSource(dataDir,id,next,nextSource);await checkSource(nextSource,path);return json(repo.save(id,source,designSystem,baseRev,text(b.message,"message",false),figma),200,noStore);}if(request.method==="DELETE"){const b=body(await readJson(request));repo.delete(id,base(b));return new Response(null,{status:204,headers:noStore});}throw new ApiError(405,"method_not_allowed","Method not allowed");}
  if(tail[0]==="source"&&tail.length===1){if(request.method!=="GET")throw new ApiError(405,"method_not_allowed","Method not allowed");return json(repo.source(id),200,noStore);}
  if(tail[0]==="draft"&&tail.length===1){if(request.method!=="GET")throw new ApiError(405,"method_not_allowed","Method not allowed");return json(repo.source(id),200,noStore);}
  if(tail[0]==="revisions"){if(tail.length===1)return json(repo.revisions(id),200,noStore);if(tail.length===2)return json(repo.source(id,int(Number(tail[1]),"rev")),200,noStore);}
  if(tail[0]==="restore"&&tail.length===1){const b=body(await readJson(request));return json(repo.restore(id,int(b.rev,"rev"),base(b)),200,noStore);}
  if(tail[0]==="publish"&&tail.length===1){if(request.method!=="POST")throw new ApiError(405,"method_not_allowed","Method not allowed");const b=body(await readJson(request));const result=await publishComponent(db,repo,id,base(b),dataDir,text(b.message,"message",false));return json(result,201,{...noStore,location:`/api/components/${id}/versions/${result.version}`});}
  if(tail[0]==="versions"){
    // POST /versions/:version/status — manual lifecycle transition with CAS on statusRev (K.2).
    // TODO(T9): register this endpoint in server/contracts.ts (owned by T9; contract left unregistered here).
    if(tail.length===3&&tail[2]==="status"){if(request.method!=="POST")throw new ApiError(405,"method_not_allowed","Method not allowed");const version=int(Number(tail[1]),"version");const b=body(await readJson(request));const status=text(b.status,"status")!;if(!Object.hasOwn(b,"baseStatusRev"))throw new ApiError(400,"invalid_request","baseStatusRev is required");const baseStatusRev=int(b.baseStatusRev,"baseStatusRev");const reason=text(b.reason,"reason",false);const supersededBy=b.supersededBy===undefined?undefined:int(b.supersededBy,"supersededBy");return json(repo.setStatus(id,version,{status,reason,supersededBy,baseStatusRev}),200,noStore);}
    if(request.method!=="GET")throw new ApiError(405,"method_not_allowed","Method not allowed");if(tail.length===1)return json(repo.versions(id),200,noStore);if(tail.length===2)return json(repo.version(id,int(Number(tail[1]),"version")),200,immutable);if(tail.length===3&&tail[2]==="bundle.js")return new Response(repo.bundle(id,int(Number(tail[1]),"version")).js,{headers:{...immutable,"content-type":"text/javascript; charset=utf-8"}});}
  throw new ApiError(404,"not_found","API route not found");
}
