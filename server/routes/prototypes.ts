import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { ComponentDefinition } from "../../src/catalog/definitions";
import { designSystems } from "../../src/designSystems";
import { prototypeDocSchema, type PrototypeDoc } from "../../src/prototype/schema";
import { validatePrototype } from "../../src/prototype/validate";
import { ApiError, immutable, json, noStore, readJson } from "../http";
import { PrototypeRepo } from "../repos/prototypes";
import { collectAndValidateAssetRefs, snapshotDefinitions } from "../validation";
import { headScreenUrl, renderStatus, versionScreenUrl } from "./renderStatus";
import { recordValidation } from "../validationRecords";
import { parseFigmaInput } from "../figma";
import { diffPrototypeDocs } from "../../src/prototype/revisionDiff";
import type { Principal } from "../auth";
import { requirePrototypeOwner, requirePrototypeRead, requireUser } from "../authorization";
import { writeAuditEvent } from "../audit";

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

export async function routePrototypes(request:Request,db:Database,segments:string[],principal:Principal,dataDir=process.env.DATA_DIR||"data",serveDist?:string):Promise<Response> {
  const repo=new PrototypeRepo(db);
  if(segments.length===1) {
    if(request.method==="GET") return json(repo.list(principal),200,noStore);
    if(request.method==="POST") { const actor=requireUser(principal); const b=objectBody(await readJson(request)); const doc=parseDoc(b.doc); const snapshot=await snapshotDefinitions(db,doc,dataDir); const warnings=validatePrototypeForSave(doc,snapshot.definitions); const assetIds=collectAndValidateAssetRefs(db,doc); const figma=parseFigmaInput(db,b.figma,"figma"); const result=repo.create(doc,message(b),snapshot.pins,assetIds,figma,actor.userId); db.query("UPDATE prototype_revisions SET author=? WHERE prototype_id=? AND rev=?").run(actor.userId,doc.id,result.rev); writeAuditEvent(db,{actorId:actor.userId,action:"prototype.revision.saved",subjectType:"prototype",subjectId:doc.id,detail:{rev:result.rev}}); recordPrototypeValidation(db,doc.id,result.rev,warnings); return json({...result,warnings,screens:headScreens(doc)},201,{...noStore,location:`/api/prototypes/${encodeURIComponent(result.id)}`}); }
    throw new ApiError(405,"method_not_allowed","Method not allowed");
  }
  const id=segments[1]!; const tail=segments.slice(2);
  if(!tail.length) {
    if(request.method==="GET") return json(repo.meta(id,principal),200,noStore);
    if(request.method==="PUT") { const actor=requirePrototypeOwner(db,id,principal); const b=objectBody(await readJson(request)); const base=baseRev(b); const doc=parseDoc(b.doc,id); const snapshot=await snapshotDefinitions(db,doc,dataDir); const warnings=validatePrototypeForSave(doc,snapshot.definitions); const assetIds=collectAndValidateAssetRefs(db,doc); const figma=parseFigmaInput(db,b.figma,"figma"); const saved=repo.save(id,doc,base,message(b),snapshot.pins,assetIds,figma); db.query("UPDATE prototype_revisions SET author=? WHERE prototype_id=? AND rev=?").run(actor.userId,id,saved.rev); writeAuditEvent(db,{actorId:actor.userId,action:"prototype.revision.saved",subjectType:"prototype",subjectId:id,detail:{rev:saved.rev}}); recordPrototypeValidation(db,id,saved.rev,warnings); return json({...saved,warnings,screens:headScreens(doc)},200,noStore); }
    if(request.method==="DELETE") { requirePrototypeOwner(db,id,principal); const b=objectBody(await readJson(request)); repo.delete(id,baseRev(b)); return new Response(null,{status:204,headers:noStore}); }
    throw new ApiError(405,"method_not_allowed","Method not allowed");
  }
  if(tail[0]==="screens"&&tail.length===3&&tail[2]==="render-status") { if(request.method!=="GET") throw new ApiError(405,"method_not_allowed","Method not allowed"); requirePrototypeRead(db,id,principal); return renderStatus(request,db,id,tail[1]!,{serveDist}); }
  if(tail[0]==="draft"&&tail.length===1) { if(request.method!=="GET") throw new ApiError(405,"method_not_allowed","Method not allowed"); return json(repo.draft(id,principal),200,noStore); }
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
    try { const snapshot=await snapshotDefinitions(db,draft.doc,dataDir); const validation=validatePrototype(draft.doc,{definitions:snapshot.definitions}); ok=validation.errors.length===0; issues=[...validation.errors,...validation.warnings]; }
    catch(error) { ok=false; issues=[{path:"/",message:error instanceof ApiError?error.message:"Restored document failed validation"}]; }
    recordPrototypeValidation(db,id,result.rev,issues,ok);
    db.query("UPDATE prototype_revisions SET author=? WHERE prototype_id=? AND rev=?").run(actor.userId,id,result.rev); writeAuditEvent(db,{actorId:actor.userId,action:"prototype.revision.saved",subjectType:"prototype",subjectId:id,detail:{rev:result.rev,restore:true}});
    return json(result,200,noStore);
  }
  if(tail[0]==="publish"&&tail.length===1) { if(request.method!=="POST") throw new ApiError(405,"method_not_allowed","Method not allowed"); const actor=requirePrototypeOwner(db,id,principal); const b=objectBody(await readJson(request)); const result=repo.publish(id,baseRev(b),message(b)); writeAuditEvent(db,{actorId:actor.userId,action:"prototype.version.published",subjectType:"prototype",subjectId:id,detail:result}); const published=repo.version(id,result.version); return json({...result,screens:published.doc.screens.map(s=>({id:s.id,url:versionScreenUrl(id,result.version,s.id)}))},201,{...noStore,location:`/api/prototypes/${encodeURIComponent(id)}/versions/${result.version}`}); }
  if(tail[0]==="status"&&tail.length===1) { if(request.method!=="POST") throw new ApiError(405,"method_not_allowed","Method not allowed"); const actor=requirePrototypeOwner(db,id,principal); const b=objectBody(await readJson(request)); if(b.status!=="private"&&b.status!=="published"&&b.status!=="archived") throw new ApiError(422,"validation_failed","Invalid prototype status",{issues:[{path:["status"],message:"must be private, published, or archived"}]}); const result=repo.setStatus(id,b.status); writeAuditEvent(db,{actorId:actor.userId,action:"prototype.status.changed",subjectType:"prototype",subjectId:id,detail:result}); return json(result,200,noStore); }
  if(tail[0]==="versions") {
    if(request.method!=="GET") throw new ApiError(405,"method_not_allowed","Method not allowed");
    requirePrototypeRead(db,id,principal);
    if(tail.length===1) return json(repo.versions(id),200,noStore);
    if(tail.length===2) return json(repo.version(id,integer(Number(tail[1]),"version"),principal),200,immutable);
  }
  throw new ApiError(404,"not_found","API route not found");
}
