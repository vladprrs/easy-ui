import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { ComponentDefinition } from "../../src/catalog/definitions";
import { designSystems } from "../../src/designSystems";
import { prototypeDocSchema, type PrototypeDoc } from "../../src/prototype/schema";
import { validatePrototype } from "../../src/prototype/validate";
import { ApiError, immutable, json, noStore, readJson } from "../http";
import { PrototypeRepo } from "../repos/prototypes";
import { snapshotDefinitions } from "../validation";
import { headScreenUrl, renderStatus, versionScreenUrl } from "./renderStatus";
import { recordValidation } from "../validationRecords";

const headScreens = (doc:PrototypeDoc) => doc.screens.map(s=>({id:s.id,url:headScreenUrl(doc.id,s.id)}));

const bodyObject = z.record(z.string(),z.unknown());
function objectBody(value:unknown): Record<string,unknown> { const p=bodyObject.safeParse(value); if(!p.success) throw new ApiError(400,"invalid_request","Request body must be an object"); return p.data; }
function integer(value:unknown,name:string):number { if(typeof value!=="number"||!Number.isInteger(value)||value<1) throw new ApiError(400,"invalid_request",`${name} must be a positive integer`); return value; }
function baseRev(body:Record<string,unknown>):number { if(!Object.hasOwn(body,"baseRev")) throw new ApiError(400,"base_rev_required","baseRev is required"); return integer(body.baseRev,"baseRev"); }
function message(body:Record<string,unknown>):string|undefined { if(body.message===undefined) return; if(typeof body.message!=="string") throw new ApiError(400,"invalid_request","message must be a string"); return body.message; }
function parseDoc(value:unknown,pathId?:string):PrototypeDoc {
  const parsed=prototypeDocSchema.safeParse(value);
  if(!parsed.success) throw new ApiError(422,"validation_failed","Prototype document is invalid",{issues:parsed.error.issues});
  if(pathId!==undefined&&parsed.data.id!==pathId) throw new ApiError(422,"validation_failed","Document id must match path id",{issues:[{path:["id"],message:"must match path id"}]});
  return parsed.data;
}

// Task 3 can resolve exact custom-version pins and pass the merged definitions here.
export function validatePrototypeForSave(doc:PrototypeDoc, definitions?:Record<string,ComponentDefinition>) {
  // API saves always pass the registry-backed snapshot. This fallback is only for
  // bundled seed documents, which support provider systems and no custom types.
  const resolved=definitions??designSystems[doc.designSystem as keyof typeof designSystems]?.definitions;
  if(!resolved) throw new ApiError(422,"validation_failed","Prototype document is invalid",{issues:[{path:["designSystem"],message:`unknown design system: ${doc.designSystem}`}]});
  const result=validatePrototype(doc,{definitions:resolved});
  if(result.errors.length) throw new ApiError(422,"validation_failed","Prototype document is invalid",{issues:result.errors,warnings:result.warnings});
  return result.warnings;
}

// Record a validation ledger entry for a freshly saved/restored revision. The catalog hash
// is read back from the revision row so it stays consistent for provider-less systems too.
function recordPrototypeValidation(db:Database,id:string,rev:number,issues:{path:string;message:string}[],ok=true):void {
  const row=db.query("SELECT builtin_catalog_hash hash FROM prototype_revisions WHERE prototype_id=? AND rev=?").get(id,rev) as {hash:string}|null;
  recordValidation(db,{resourceType:"prototype",resourceId:id,rev,catalogHash:row?.hash??"",ok,issues});
}

export async function routePrototypes(request:Request,db:Database,segments:string[],dataDir=process.env.DATA_DIR||"data",serveDist?:string):Promise<Response> {
  const repo=new PrototypeRepo(db);
  if(segments.length===1) {
    if(request.method==="GET") return json(repo.list(),200,noStore);
    if(request.method==="POST") { const b=objectBody(await readJson(request)); const doc=parseDoc(b.doc); const snapshot=await snapshotDefinitions(db,doc,dataDir); const warnings=validatePrototypeForSave(doc,snapshot.definitions); const result=repo.create(doc,message(b),snapshot.pins); recordPrototypeValidation(db,doc.id,result.rev,warnings); return json({...result,warnings,screens:headScreens(doc)},201,{...noStore,location:`/api/prototypes/${encodeURIComponent(result.id)}`}); }
    throw new ApiError(405,"method_not_allowed","Method not allowed");
  }
  const id=segments[1]!; const tail=segments.slice(2);
  if(!tail.length) {
    if(request.method==="GET") return json(repo.meta(id),200,noStore);
    if(request.method==="PUT") { const b=objectBody(await readJson(request)); const base=baseRev(b); const doc=parseDoc(b.doc,id); const snapshot=await snapshotDefinitions(db,doc,dataDir); const warnings=validatePrototypeForSave(doc,snapshot.definitions); const saved=repo.save(id,doc,base,message(b),snapshot.pins); recordPrototypeValidation(db,id,saved.rev,warnings); return json({...saved,warnings,screens:headScreens(doc)},200,noStore); }
    if(request.method==="DELETE") { const b=objectBody(await readJson(request)); repo.delete(id,baseRev(b)); return new Response(null,{status:204,headers:noStore}); }
    throw new ApiError(405,"method_not_allowed","Method not allowed");
  }
  if(tail[0]==="screens"&&tail.length===3&&tail[2]==="render-status") { if(request.method!=="GET") throw new ApiError(405,"method_not_allowed","Method not allowed"); return renderStatus(request,db,id,tail[1]!,{serveDist}); }
  if(tail[0]==="draft"&&tail.length===1) { if(request.method!=="GET") throw new ApiError(405,"method_not_allowed","Method not allowed"); return json(repo.draft(id),200,noStore); }
  if(tail[0]==="revisions") {
    if(request.method!=="GET") throw new ApiError(405,"method_not_allowed","Method not allowed");
    if(tail.length===2) return json(repo.revision(id,integer(Number(tail[1]),"rev")),200,noStore);
    const u=new URL(request.url); const limitRaw=u.searchParams.get("limit"); const beforeRaw=u.searchParams.get("before"); const limit=limitRaw===null?20:integer(Number(limitRaw),"limit"); if(limit>100) throw new ApiError(400,"invalid_request","limit must not exceed 100"); const before=beforeRaw===null?undefined:integer(Number(beforeRaw),"before"); return json(repo.revisions(id,limit,before),200,noStore);
  }
  if(tail[0]==="restore"&&tail.length===1) {
    if(request.method!=="POST") throw new ApiError(405,"method_not_allowed","Method not allowed");
    const b=objectBody(await readJson(request)); const result=repo.restore(id,integer(b.rev,"rev"),baseRev(b));
    // Re-validate the restored document against the live catalog and record the result.
    const draft=repo.draft(id); let ok=true; let issues:{path:string;message:string}[]=[];
    try { const snapshot=await snapshotDefinitions(db,draft.doc,dataDir); const validation=validatePrototype(draft.doc,{definitions:snapshot.definitions}); ok=validation.errors.length===0; issues=[...validation.errors,...validation.warnings]; }
    catch(error) { ok=false; issues=[{path:"/",message:error instanceof ApiError?error.message:"Restored document failed validation"}]; }
    recordPrototypeValidation(db,id,result.rev,issues,ok);
    return json(result,200,noStore);
  }
  if(tail[0]==="publish"&&tail.length===1) { if(request.method!=="POST") throw new ApiError(405,"method_not_allowed","Method not allowed"); const b=objectBody(await readJson(request)); const result=repo.publish(id,baseRev(b),message(b)); const published=repo.version(id,result.version); return json({...result,screens:published.doc.screens.map(s=>({id:s.id,url:versionScreenUrl(id,result.version,s.id)}))},201,{...noStore,location:`/api/prototypes/${encodeURIComponent(id)}/versions/${result.version}`}); }
  if(tail[0]==="versions") {
    if(request.method!=="GET") throw new ApiError(405,"method_not_allowed","Method not allowed");
    if(tail.length===1) return json(repo.versions(id),200,noStore);
    if(tail.length===2) return json(repo.version(id,integer(Number(tail[1]),"version")),200,immutable);
  }
  throw new ApiError(404,"not_found","API route not found");
}
