import type { Database } from "bun:sqlite";
import { z } from "zod";
import { componentDefinitions } from "../../src/catalog/definitions";
import { compileComponent, typecheckComponent } from "../components/compile";
import { extractDefinition } from "../components/extract-subprocess";
import { importPublished, materializeSource, sha256 } from "../components/pipeline";
import { ApiError, immutable, json, noStore, readJson } from "../http";
import { ComponentRepo } from "../repos/components";

const slug=/^[a-z0-9]+(?:-[a-z0-9]+)*$/, componentName=/^[A-Z][A-Za-z0-9]*$/;
function bad(message:string,path="source"):never{throw new ApiError(422,"validation_failed","Component is invalid",{issues:[{path:[path],message}]});}
function body(v:unknown){const p=z.record(z.string(),z.unknown()).safeParse(v);if(!p.success)throw new ApiError(400,"invalid_request","Request body must be an object");return p.data;}
function int(v:unknown,name:string){if(typeof v!=="number"||!Number.isInteger(v)||v<1)throw new ApiError(400,"invalid_request",`${name} must be a positive integer`);return v;}
function base(b:Record<string,unknown>){if(!Object.hasOwn(b,"baseRev"))throw new ApiError(400,"base_rev_required","baseRev is required");return int(b.baseRev,"baseRev");}
function text(v:unknown,name:string,required=true){if(v===undefined&&!required)return undefined;if(typeof v!=="string")throw new ApiError(400,"invalid_request",`${name} must be a string`);return v;}
async function checkSource(source:string,path:string,smoke=false){
  if(new TextEncoder().encode(source).byteLength>262144)throw new ApiError(413,"payload_too_large","Component source exceeds 256 KB");
  try { new Bun.Transpiler({loader:"tsx"}).transformSync(source); } catch(error){bad(`Syntax error: ${error instanceof Error?error.message:String(error)}`);}
  const extracted=await extractDefinition(path,{smoke}); if(!extracted.ok)bad(extracted.error??"Component extraction failed"); return extracted;
}

export type PublishHooks={afterStage?:(x:{id:string;version:number;rev:number})=>void|Promise<void>;beforeImport?:(x:{id:string;version:number;rev:number})=>void|Promise<void>};
export async function publishComponent(db:Database,repo:ComponentRepo,id:string,baseRev:number,dataDir:string,message?:string,hooks:PublishHooks={}){
  const revision=repo.source(id); const path=await materializeSource(dataDir,id,revision.rev,revision.source);
  const extracted=await checkSource(revision.source,path,true); await typecheckComponent(path); const compiled=await compileComponent(path);
  const staged=repo.stage(id,baseRev,{...compiled,sourceHash:sha256(revision.source),meta:extracted.meta!},message); await hooks.afterStage?.({id,...staged});
  try { await hooks.beforeImport?.({id,...staged}); await importPublished(id,staged.rev,path); repo.activate(id,staged.version); }
  catch(error){repo.fail(id,staged.version);throw new ApiError(422,"validation_failed","Published component import failed",{issues:[{path:["source"],message:error instanceof Error?error.message:String(error)}]});}
  return {version:staged.version,hostAbiVersion:1,warnings:extracted.warnings};
}

export function catalogManifest(db:Database){return (db.query(`SELECT c.id,c.name,p.version,p.bundle_hash,p.definition_meta,p.host_abi_version FROM components c JOIN component_publishes p ON p.component_id=c.id AND p.status='active' WHERE c.deleted_at IS NULL AND p.version=(SELECT MAX(x.version) FROM component_publishes x WHERE x.component_id=c.id AND x.status='active') ORDER BY c.id`).all() as {id:string;name:string;version:number;bundle_hash:string;definition_meta:string;host_abi_version:number}[]).map(r=>({id:r.id,name:r.name,version:r.version,bundleUrl:`/api/components/${encodeURIComponent(r.id)}/versions/${r.version}/bundle.js`,bundleHash:r.bundle_hash,...JSON.parse(r.definition_meta),hostAbiVersion:r.host_abi_version}));}

export async function routeComponents(request:Request,db:Database,segments:string[],dataDir:string):Promise<Response>{
  const repo=new ComponentRepo(db);
  if(segments.length===1){if(request.method==="GET")return json(repo.list(),200,noStore);if(request.method==="POST"){const b=body(await readJson(request));const id=text(b.id,"id")!,name=text(b.name,"name")!,source=text(b.source,"source")!;if(!slug.test(id))bad("id must be a slug","id");if(!componentName.test(name))bad("name must match ^[A-Z][A-Za-z0-9]*$","name");if(Object.hasOwn(componentDefinitions,name))throw new ApiError(409,"already_exists","Component name conflicts with a builtin component");const path=await materializeSource(dataDir,id,1,source);await checkSource(source,path);const result=repo.create(id,name,source,text(b.message,"message",false));return json(result,201,{...noStore,location:`/api/components/${id}`});}throw new ApiError(405,"method_not_allowed","Method not allowed");}
  const id=segments[1]!,tail=segments.slice(2);
  if(!tail.length){if(request.method==="GET")return json(repo.meta(id),200,noStore);if(request.method==="PUT"){const b=body(await readJson(request)),source=text(b.source,"source")!,baseRev=base(b);const current=repo.cas(id,baseRev);const next=current.head_rev+1,path=await materializeSource(dataDir,id,next,source);await checkSource(source,path);return json(repo.save(id,source,baseRev,text(b.message,"message",false)),200,noStore);}if(request.method==="DELETE"){const b=body(await readJson(request));repo.delete(id,base(b));return new Response(null,{status:204,headers:noStore});}throw new ApiError(405,"method_not_allowed","Method not allowed");}
  if(tail[0]==="source"&&tail.length===1){if(request.method!=="GET")throw new ApiError(405,"method_not_allowed","Method not allowed");return json(repo.source(id),200,noStore);}
  if(tail[0]==="draft"&&tail.length===1){if(request.method!=="GET")throw new ApiError(405,"method_not_allowed","Method not allowed");return json(repo.source(id),200,noStore);}
  if(tail[0]==="revisions"){if(tail.length===1)return json(repo.revisions(id),200,noStore);if(tail.length===2)return json(repo.source(id,int(Number(tail[1]),"rev")),200,noStore);}
  if(tail[0]==="restore"&&tail.length===1){const b=body(await readJson(request));return json(repo.restore(id,int(b.rev,"rev"),base(b)),200,noStore);}
  if(tail[0]==="publish"&&tail.length===1){if(request.method!=="POST")throw new ApiError(405,"method_not_allowed","Method not allowed");const b=body(await readJson(request));const result=await publishComponent(db,repo,id,base(b),dataDir,text(b.message,"message",false));return json(result,201,{...noStore,location:`/api/components/${id}/versions/${result.version}`});}
  if(tail[0]==="versions"){if(request.method!=="GET")throw new ApiError(405,"method_not_allowed","Method not allowed");if(tail.length===1)return json(repo.versions(id),200,noStore);if(tail.length===2)return json(repo.version(id,int(Number(tail[1]),"version")),200,immutable);if(tail.length===3&&tail[2]==="bundle.js")return new Response(repo.activeBundle(id,int(Number(tail[1]),"version")).js,{headers:{...immutable,"content-type":"text/javascript; charset=utf-8"}});}
  throw new ApiError(404,"not_found","API route not found");
}
