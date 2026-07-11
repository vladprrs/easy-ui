import type {Database} from "bun:sqlite";
import {builtinCatalogHashFor} from "../builtinHash";
import {getRegisteredDesignSystem,listRegisteredDesignSystems,type RegisteredDesignSystem} from "../designSystems";
import {ApiError,json,noStore,readJson} from "../http";

function summary(system:RegisteredDesignSystem) {
  return {id:system.id,name:system.name,description:system.description,builtinCatalogHash:builtinCatalogHashFor(system.id,system.definitions),components:Object.entries(system.definitions).map(([name,definition])=>({name,atomicLevel:definition.atomicLevel,layoutNeutral:definition.layoutNeutral??false,description:definition.description,events:definition.events??[],slots:definition.slots??[]}))};
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

export async function routeDesignSystems(request:Request,db:Database,segments:string[]):Promise<Response> {
  const id=segments.length===2?segments[1]:null;
  if(segments.length>2) throw new ApiError(404,"not_found","Design system not found");
  if(request.method==="GET") {
    if(id) { const system=getRegisteredDesignSystem(db,id); if(!system) throw new ApiError(404,"not_found","Design system not found"); return json(summary(system),200,noStore); }
    return json({designSystems:listRegisteredDesignSystems(db).map(summary)},200,noStore);
  }
  if(request.method==="POST"&&!id) {
    let body:unknown; try { body=await readJson(request); } catch(error) { if(error instanceof ApiError&&error.code==="invalid_json") throw new ApiError(400,"invalid_request","Request body must be valid JSON"); throw error; }
    const input=validate(body); const at=new Date().toISOString();
    try { db.query("INSERT INTO design_systems (id,name,description,builtin_provider,created_at,updated_at) VALUES (?,?,?,NULL,?,?)").run(input.id,input.name,input.description,at,at); }
    catch(error) { if(String(error).includes("UNIQUE constraint failed")) throw new ApiError(409,"already_exists","Design system already exists"); throw error; }
    return json(summary(getRegisteredDesignSystem(db,input.id)!),201,{...noStore,location:`/api/design-systems/${input.id}`});
  }
  throw new ApiError(405,"method_not_allowed","Method not allowed");
}
