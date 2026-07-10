import type { Database } from "bun:sqlite";
import { openDatabase } from "./db";
import { ApiError, errorResponse, json, noStore } from "./http";
import { routePrototypes } from "./routes/prototypes";
import { seedPrototypes } from "./seed";
import { serveStatic } from "./static";
import { routeComponents, catalogManifest } from "./routes/components";
import { routeShims } from "./routes/shims";
import { failStagingPublishes } from "./repos/components";
import { verifyShimAbi } from "./shims/abi-v1";

export function createHandler(db:Database,options:{ready?:()=>boolean;serveDist?:string;dataDir?:string}={}):(request:Request)=>Promise<Response> {
  return async request=>{ try {
    const url=new URL(request.url); let segments:string[];
    try { segments=url.pathname.split("/").filter(Boolean).map(decodeURIComponent); } catch { throw new ApiError(400,"invalid_path","Malformed URL encoding"); }
    if(segments[0]==="api") {
      if(segments[1]==="health"&&segments.length===2) { if(request.method!=="GET") throw new ApiError(405,"method_not_allowed","Method not allowed"); const ready=options.ready?.()!==false; return json({status:ready?"ready":"starting"},ready?200:503,noStore); }
      if(segments[1]==="prototypes") return await routePrototypes(request,db,segments.slice(1),options.dataDir);
      if(segments[1]==="components") return await routeComponents(request,db,segments.slice(1),options.dataDir??process.env.DATA_DIR??"data");
      if(segments[1]==="catalog"&&segments[2]==="manifest"&&segments.length===3) { if(request.method!=="GET") throw new ApiError(405,"method_not_allowed","Method not allowed"); return json({components:catalogManifest(db)},200,noStore); }
      if(segments[1]==="shims"&&segments[2]==="v1") return routeShims(request,segments.slice(1));
      throw new ApiError(404,"not_found","API route not found");
    }
    if(options.serveDist) return await serveStatic(request,options.serveDist);
    throw new ApiError(404,"not_found","Route not found");
  } catch(error) { return errorResponse(error); } };
}

export async function startServer(options:{port?:number;database?:string;serveDist?:string}={}) {
  let ready=false; const db=openDatabase(options.database); failStagingPublishes(db); await verifyShimAbi(); await seedPrototypes(db); ready=true;
  const serveDist=options.serveDist ?? (process.env.SERVE_DIST || undefined);
  const dataDir=process.env.DATA_DIR??"data"; const server=Bun.serve({hostname:"127.0.0.1",port:options.port??Number(process.env.PORT||8787),fetch:createHandler(db,{ready:()=>ready,serveDist,dataDir})});
  return {server,db};
}

if(import.meta.main) { const {server}=await startServer(); console.log(`easy-ui server listening on http://${server.hostname}:${server.port}`); }
