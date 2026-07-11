import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { ComponentDefinition } from "../../src/catalog/definitions";
import { designSystems } from "../../src/designSystems";
import { prototypeDocSchema, type PrototypeDoc } from "../../src/prototype/schema";
import { validatePrototype } from "../../src/prototype/validate";
import { ApiError, immutable, json, noStore, readJson } from "../http";
import { PrototypeRepo } from "../repos/prototypes";
import { snapshotDefinitions } from "../validation";

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
  const resolved=definitions??designSystems[doc.designSystem as keyof typeof designSystems]?.definitions;
  if(!resolved) throw new ApiError(422,"validation_failed","Prototype document is invalid",{issues:[{path:["designSystem"],message:`unknown design system: ${doc.designSystem}`}]});
  const result=validatePrototype(doc,{definitions:resolved});
  if(result.errors.length) throw new ApiError(422,"validation_failed","Prototype document is invalid",{issues:result.errors,warnings:result.warnings});
  return result.warnings;
}

export async function routePrototypes(request:Request,db:Database,segments:string[],dataDir=process.env.DATA_DIR||"data"):Promise<Response> {
  const repo=new PrototypeRepo(db);
  if(segments.length===1) {
    if(request.method==="GET") return json(repo.list(),200,noStore);
    if(request.method==="POST") { const b=objectBody(await readJson(request)); const doc=parseDoc(b.doc); const snapshot=await snapshotDefinitions(db,doc,dataDir); const warnings=validatePrototypeForSave(doc,snapshot.definitions); const result=repo.create(doc,message(b),snapshot.pins); return json({...result,warnings},201,{...noStore,location:`/api/prototypes/${encodeURIComponent(result.id)}`}); }
    throw new ApiError(405,"method_not_allowed","Method not allowed");
  }
  const id=segments[1]!; const tail=segments.slice(2);
  if(!tail.length) {
    if(request.method==="GET") return json(repo.meta(id),200,noStore);
    if(request.method==="PUT") { const b=objectBody(await readJson(request)); const base=baseRev(b); const doc=parseDoc(b.doc,id); const snapshot=await snapshotDefinitions(db,doc,dataDir); const warnings=validatePrototypeForSave(doc,snapshot.definitions); return json({...repo.save(id,doc,base,message(b),snapshot.pins),warnings},200,noStore); }
    if(request.method==="DELETE") { const b=objectBody(await readJson(request)); repo.delete(id,baseRev(b)); return new Response(null,{status:204,headers:noStore}); }
    throw new ApiError(405,"method_not_allowed","Method not allowed");
  }
  if(tail[0]==="draft"&&tail.length===1) { if(request.method!=="GET") throw new ApiError(405,"method_not_allowed","Method not allowed"); return json(repo.draft(id),200,noStore); }
  if(tail[0]==="revisions") {
    if(request.method!=="GET") throw new ApiError(405,"method_not_allowed","Method not allowed");
    if(tail.length===2) return json(repo.revision(id,integer(Number(tail[1]),"rev")),200,noStore);
    const u=new URL(request.url); const limitRaw=u.searchParams.get("limit"); const beforeRaw=u.searchParams.get("before"); const limit=limitRaw===null?20:integer(Number(limitRaw),"limit"); if(limit>100) throw new ApiError(400,"invalid_request","limit must not exceed 100"); const before=beforeRaw===null?undefined:integer(Number(beforeRaw),"before"); return json(repo.revisions(id,limit,before),200,noStore);
  }
  if(tail[0]==="restore"&&tail.length===1) { if(request.method!=="POST") throw new ApiError(405,"method_not_allowed","Method not allowed"); const b=objectBody(await readJson(request)); return json(repo.restore(id,integer(b.rev,"rev"),baseRev(b)),200,noStore); }
  if(tail[0]==="publish"&&tail.length===1) { if(request.method!=="POST") throw new ApiError(405,"method_not_allowed","Method not allowed"); const b=objectBody(await readJson(request)); const result=repo.publish(id,baseRev(b),message(b)); return json(result,201,{...noStore,location:`/api/prototypes/${encodeURIComponent(id)}/versions/${result.version}`}); }
  if(tail[0]==="versions") {
    if(request.method!=="GET") throw new ApiError(405,"method_not_allowed","Method not allowed");
    if(tail.length===1) return json(repo.versions(id),200,noStore);
    if(tail.length===2) return json(repo.version(id,integer(Number(tail[1]),"version")),200,immutable);
  }
  throw new ApiError(404,"not_found","API route not found");
}
