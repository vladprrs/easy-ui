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
import { routeMeta } from "./routes/meta";
import { exchangeShareToken, protectShareResponse, routeShares } from "./routes/share";
import { ShareRepo } from "./share/repo";
import { catalogManifestQuerySchema, parseQuery } from "./contracts";
import { getRegisteredDesignSystem } from "./designSystems";

type HandlerOptions = {ready?:()=>boolean;serveDist?:string;dataDir?:string;basicAuth?:string;publicOrigin?:URL|string;screenshots?:ScreenshotService;visual?:VisualService};

function isLoopbackHostname(hostname:string):boolean {
  return hostname==="localhost"||hostname==="::1"||hostname==="[::1]"||hostname.startsWith("127.");
}

export function resolvePublicOrigin(value:string|undefined,fallback:{host:string;port:number}):URL {
  if(!value) {
    if(!isLoopbackHostname(fallback.host)) throw new Error("PUBLIC_ORIGIN is required when HOST is non-loopback");
    value=`http://${fallback.host.includes(":")?`[${fallback.host}]`:fallback.host}:${fallback.port}`;
  }
  let origin:URL;
  try { origin=new URL(value); } catch { throw new Error("PUBLIC_ORIGIN must be an absolute http(s) URL"); }
  if(origin.protocol!=="http:"&&origin.protocol!=="https:") throw new Error("PUBLIC_ORIGIN must use http or https");
  if(origin.username||origin.password||origin.pathname!=="/"||origin.search||origin.hash) throw new Error("PUBLIC_ORIGIN must contain only scheme, host, and optional port");
  if(!isLoopbackHostname(origin.hostname)&&origin.protocol!=="https:") throw new Error("PUBLIC_ORIGIN must use https for a non-loopback host");
  return origin;
}

export function createHandler(db:Database,options:HandlerOptions={}):(request:Request,server?:Bun.Server<unknown>)=>Promise<Response> {
  const publicOrigin=options.publicOrigin instanceof URL?options.publicOrigin:new URL(options.publicOrigin??"http://localhost");
  const shares=new ShareRepo(db,{publicOrigin,serveDist:options.serveDist});
  return async (request,server)=>{
    const authEnabled=Boolean(options.basicAuth);
    let shareAuthorized=false;
    const finish=(response:Response)=>shareAuthorized?protectShareResponse(response):authEnabled?protectResponse(response):response;
    const requestUrl=new URL(request.url);
    let decodedPath:string|null=null;
    try { decodedPath=decodeURIComponent(requestUrl.pathname); } catch { /* handled by the normal router */ }
    // Bearer-token exchange is the sole public route ahead of BasicAuth. The redirect target
    // contains no token; every subsequent request is authorized by the opaque server session.
    if(decodedPath!==null) {
      const shareSegments=decodedPath.split("/").filter(Boolean);
      if(shareSegments[0]==="share"&&shareSegments.length===2) {
        try { return protectShareResponse(await exchangeShareToken(request,shareSegments[1]!,shares,publicOrigin)); }
        catch(error) { return protectShareResponse(errorResponse(error)); }
      }
      shareAuthorized=shares.authorize(request,decodedPath);
    }
    // Capture-session bearer: a live token from a loopback GET/HEAD on an allowlisted
    // path is the transport authorization for the worker's browser (bypasses BasicAuth).
    let captureAuthorized=false;
    const captureToken=request.headers.get("x-easyui-capture");
    if(captureToken&&options.screenshots) {
      const p=new URL(request.url).pathname; let path:string; try { path=decodeURIComponent(p); } catch { path=p; }
      const address=server?.requestIP?.(request)?.address ?? null;
      captureAuthorized=options.screenshots.sessions.authorize({token:captureToken,address,method:request.method,path});
    }
    if(authEnabled&&!captureAuthorized&&!shareAuthorized) {
      const health=request.method==="GET"&&requestUrl.pathname==="/api/health";
      if(!health&&!isAuthorized(request,options.basicAuth!)) return unauthorizedResponse();
    }
    const handle=async()=>{ try {
    const url=new URL(request.url); let segments:string[];
    try { segments=url.pathname.split("/").filter(Boolean).map(decodeURIComponent); } catch { throw new ApiError(400,"invalid_path","Malformed URL encoding"); }
    if(segments[0]==="api") {
      if(segments[1]==="health"&&segments.length===2) { if(request.method!=="GET") throw new ApiError(405,"method_not_allowed","Method not allowed"); const ready=options.ready?.()!==false; return json({status:ready?"ready":"starting"},ready?200:503,noStore); }
      const shot=await routeScreenshots(request,options.screenshots,segments.slice(1)); if(shot) return shot;
      const vis=await routeVisual(request,db,options.dataDir??process.env.DATA_DIR??"data",segments.slice(1),options.visual); if(vis) return vis;
      const share=await routeShares(request,db,segments.slice(1),{publicOrigin,serveDist:options.serveDist}); if(share) return share;
      if(segments[1]==="prototypes") return await routePrototypes(request,db,segments.slice(1),options.dataDir,options.serveDist);
      if(segments[1]==="components") return await routeComponents(request,db,segments.slice(1),options.dataDir??process.env.DATA_DIR??"data");
      if(segments[1]==="assets") return await routeAssets(request,db,segments.slice(1),options.dataDir??process.env.DATA_DIR??"data");
      if(segments[1]==="design-systems") return await routeDesignSystems(request,db,segments.slice(1));
      if(segments[1]==="catalog"&&segments[2]==="manifest"&&segments.length===3) { if(request.method!=="GET") throw new ApiError(405,"method_not_allowed","Method not allowed"); const {designSystem}=parseQuery(catalogManifestQuerySchema,url.searchParams); if(designSystem!==undefined&&!getRegisteredDesignSystem(db,designSystem)) throw new ApiError(404,"not_found","Design system not found"); return json({components:catalogManifest(db,designSystem)},200,noStore); }
      if(segments[1]==="shims"&&(segments[2]==="v1"||segments[2]==="v2"||segments[2]==="v3")) return routeShims(request,segments.slice(1));
      const meta=routeMeta(request,db,segments.slice(1)); if(meta) return meta;
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
  const port=options.port??Number(process.env.PORT||8787);
  // Validate the externally visible origin before opening/migrating the persistent database.
  const publicOrigin=resolvePublicOrigin(process.env.PUBLIC_ORIGIN||undefined,{host,port});
  let ready=false; const db=openDatabase(options.database); failStagingPublishes(db); await verifyShimAbi(); await seedPrototypes(db); ready=true;
  const serveDist=options.serveDist ?? (process.env.SERVE_DIST || undefined);
  const dataDir=process.env.DATA_DIR??"data";
  const captureHost=host==="0.0.0.0"||host==="::"?"127.0.0.1":host;
  const screenshots=new ScreenshotServiceImpl({db,dataDir,serveDist,captureOrigin:`http://${captureHost}:${port}`,chromiumAvailable:chromiumAvailable(),runJob:spawnWorker});
  const visual=new VisualServiceImpl({db,dataDir,screenshots});
  const server=Bun.serve({hostname:host,port,fetch:createHandler(db,{ready:()=>ready,serveDist,dataDir,basicAuth,publicOrigin,screenshots,visual})});
  return {server,db};
}

if(import.meta.main) { const {server}=await startServer(); console.log(`easy-ui server listening on http://${server.hostname}:${server.port}`); }
