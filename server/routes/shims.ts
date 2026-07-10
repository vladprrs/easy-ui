import { immutable } from "../http";
import { ABI_V1,emitShim,type ShimName } from "../shims/abi-v1";
export function routeShims(request:Request,segments:string[]):Response {
  if(request.method!=="GET") return new Response(JSON.stringify({error:{code:"method_not_allowed",message:"Method not allowed"}}),{status:405,headers:{"content-type":"application/json","cache-control":"no-store"}});
  const file=segments[2]; if(!file?.endsWith(".js")) return new Response("Not found",{status:404}); const name=file.slice(0,-3) as ShimName;
  if(!Object.hasOwn(ABI_V1,name)) return new Response("Not found",{status:404});
  return new Response(emitShim(name),{headers:{...immutable,"content-type":"text/javascript; charset=utf-8"}});
}
