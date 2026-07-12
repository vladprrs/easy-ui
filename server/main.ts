import type { Database } from "bun:sqlite";
import { openDatabase } from "./db";
import { ApiError, errorResponse, json, noStore } from "./http";
import { routePrototypes } from "./routes/prototypes";
import { seedPrototypes } from "./seed";
import { serveStatic } from "./static";
import { routeComponents, catalogManifest } from "./routes/components";
import { routeAssets } from "./routes/assets";
import { routeDesignSystems } from "./routes/designSystems";
import { routeShims } from "./routes/shims";
import { failStagingPublishes } from "./repos/components";
import { verifyShimAbi } from "./shims/abi-v1";
import { isAuthorized, protectResponse, unauthorizedResponse } from "./auth";
import type { ScreenshotService } from "./screenshot/service";
import { ScreenshotService as ScreenshotServiceImpl } from "./screenshot/service";
import { chromiumAvailable, spawnWorker } from "./screenshot/worker-runner";
import { routeScreenshots } from "./routes/screenshots";
import type { VisualService } from "./visual/service";
import { VisualService as VisualServiceImpl } from "./visual/service";
import { routeVisual } from "./routes/visual";

export function createHandler(db:Database,options:{ready?:()=>boolean;serveDist?:string;dataDir?:string;basicAuth?:string;screenshots?:ScreenshotService;visual?:VisualService}={}):(request:Request,server?:Bun.Server<unknown>)=>Promise<Response> {
  return async (request,server)=>{
    const authEnabled=Boolean(options.basicAuth);
    const finish=(response:Response)=>authEnabled?protectResponse(response):response;
    // Capture-session bearer: a live token from a loopback GET/HEAD on an allowlisted
    // path is the transport authorization for the worker's browser (bypasses BasicAuth).
    let captureAuthorized=false;
    const captureToken=request.headers.get("x-easyui-capture");
    if(captureToken&&options.screenshots) {
      const p=new URL(request.url).pathname; let path:string; try { path=decodeURIComponent(p); } catch { path=p; }
      const address=server?.requestIP?.(request)?.address ?? null;
      captureAuthorized=options.screenshots.sessions.authorize({token:captureToken,address,method:request.method,path});
    }
    if(authEnabled&&!captureAuthorized) {
      const url=new URL(request.url);
      const health=request.method==="GET"&&url.pathname==="/api/health";
      if(!health&&!isAuthorized(request,options.basicAuth!)) return unauthorizedResponse();
    }
    const handle=async()=>{ try {
    const url=new URL(request.url); let segments:string[];
    try { segments=url.pathname.split("/").filter(Boolean).map(decodeURIComponent); } catch { throw new ApiError(400,"invalid_path","Malformed URL encoding"); }
    if(segments[0]==="api") {
      if(segments[1]==="health"&&segments.length===2) { if(request.method!=="GET") throw new ApiError(405,"method_not_allowed","Method not allowed"); const ready=options.ready?.()!==false; return json({status:ready?"ready":"starting"},ready?200:503,noStore); }
      const shot=await routeScreenshots(request,options.screenshots,segments.slice(1)); if(shot) return shot;
      const vis=await routeVisual(request,db,options.dataDir??process.env.DATA_DIR??"data",segments.slice(1),options.visual); if(vis) return vis;
      if(segments[1]==="prototypes") return await routePrototypes(request,db,segments.slice(1),options.dataDir,options.serveDist);
      if(segments[1]==="components") return await routeComponents(request,db,segments.slice(1),options.dataDir??process.env.DATA_DIR??"data");
      if(segments[1]==="assets") return await routeAssets(request,db,segments.slice(1),options.dataDir??process.env.DATA_DIR??"data");
      if(segments[1]==="design-systems") return await routeDesignSystems(request,db,segments.slice(1));
      if(segments[1]==="catalog"&&segments[2]==="manifest"&&segments.length===3) { if(request.method!=="GET") throw new ApiError(405,"method_not_allowed","Method not allowed"); return json({components:catalogManifest(db)},200,noStore); }
      if(segments[1]==="shims"&&(segments[2]==="v1"||segments[2]==="v2")) return routeShims(request,segments.slice(1));
      throw new ApiError(404,"not_found","API route not found");
    }
    if(options.serveDist) return await serveStatic(request,options.serveDist);
    throw new ApiError(404,"not_found","Route not found");
  } catch(error) { return errorResponse(error); } };
    return finish(await handle());
  };
}

export async function startServer(options:{port?:number;database?:string;serveDist?:string;host?:string}={}) {
  const host=options.host??process.env.HOST??"127.0.0.1";
  const basicAuth=process.env.BASIC_AUTH||undefined;
  if(host!=="127.0.0.1"&&host!=="localhost"&&!basicAuth) {
    console.error(`Refusing to start easy-ui on non-loopback host ${JSON.stringify(host)} without BASIC_AUTH`);
    process.exit(1);
  }
  let ready=false; const db=openDatabase(options.database); failStagingPublishes(db); await verifyShimAbi(); await seedPrototypes(db); ready=true;
  const serveDist=options.serveDist ?? (process.env.SERVE_DIST || undefined);
  const dataDir=process.env.DATA_DIR??"data";
  const port=options.port??Number(process.env.PORT||8787);
  const captureHost=host==="0.0.0.0"||host==="::"?"127.0.0.1":host;
  const screenshots=new ScreenshotServiceImpl({db,dataDir,serveDist,captureOrigin:`http://${captureHost}:${port}`,chromiumAvailable:chromiumAvailable(),runJob:spawnWorker});
  const visual=new VisualServiceImpl({db,dataDir,screenshots});
  const server=Bun.serve({hostname:host,port,fetch:createHandler(db,{ready:()=>ready,serveDist,dataDir,basicAuth,screenshots,visual})});
  return {server,db};
}

if(import.meta.main) { const {server}=await startServer(); console.log(`easy-ui server listening on http://${server.hostname}:${server.port}`); }
