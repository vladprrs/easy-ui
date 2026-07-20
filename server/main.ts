import type { Database } from "bun:sqlite";
import { openDatabase } from "./db";
import { ApiError, errorResponse, json, noStore } from "./http";
import { routePrototypes } from "./routes/prototypes";
import { resolveStaticRequest, serveResolvedStatic } from "./static";
import { routeComponents, catalogManifest } from "./routes/components";
import { routeAssets } from "./routes/assets";
import { routeDesignSystems } from "./routes/designSystems";
import { routeShims } from "./routes/shims";
import { failStagingPublishes } from "./repos/components";
import { verifyShimAbi } from "./shims/abi-v1";
import { applicationUnauthorizedResponse, isLegacyBasicAuthorized, legacyBasicUnauthorizedResponse, protectLegacyBasicResponse, protectSessionResponse, resolvePrincipal, resolveSessionUser, type CapturePrincipal, type SharePrincipal } from "./auth";
import type { ScreenshotService } from "./screenshot/service";
import { ScreenshotService as ScreenshotServiceImpl } from "./screenshot/service";
import { chromiumAvailable, spawnWorker } from "./screenshot/worker-runner";
import { routeScreenshots } from "./routes/screenshots";
import type { VisualService } from "./visual/service";
import { VisualService as VisualServiceImpl } from "./visual/service";
import { routeVisual } from "./routes/visual";
import { routeMeta } from "./routes/meta";
import { exchangeShareToken, protectShareResponse, routeShares } from "./routes/share";
import { routeBundles } from "./routes/bundles";
import { ShareRepo } from "./share/repo";
import { catalogManifestQuerySchema, parseQuery } from "./contracts";
import { getIncludingRetired } from "./designSystems";
import { LoginRateLimiter, routeAuth } from "./routes/auth";
import { routeUsers } from "./routes/users";
import { assertOwnersPresent, ensureBootstrapAdmin } from "./users";

export type HandlerOptions = {
  ready?: () => boolean;
  serveDist?: string;
  dataDir?: string;
  /** Optional reverse-proxy compatibility barrier; application auth remains cookie-based. */
  legacyBasicAuth?: string;
  /** @deprecated test/backward-compatible alias for legacyBasicAuth. */
  basicAuth?: string;
  publicOrigin?: URL | string;
  screenshots?: ScreenshotService;
  visual?: VisualService;
  loginRateLimiter?: LoginRateLimiter;
};

export function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || hostname.startsWith("127.");
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

export function resolveLegacyBasicAuthEnv(
  env?: { LEGACY_BASIC_AUTH?: string; BASIC_AUTH?: string },
  warn: (message: string) => void = console.warn,
): string | undefined {
  const source = env ?? process.env;
  if (source.BASIC_AUTH) {
    warn("[deprecated] BASIC_AUTH is a compatibility alias; migrate to LEGACY_BASIC_AUTH plus ADMIN_NAME/ADMIN_PASSWORD sessions");
  }
  return source.LEGACY_BASIC_AUTH || source.BASIC_AUTH || undefined;
}

function isUnsafe(method: string): boolean { return method !== "GET" && method !== "HEAD" && method !== "OPTIONS"; }

function enforceOrigin(request: Request, publicOrigin: URL): void {
  if (!isUnsafe(request.method)) return;
  const value = request.headers.get("origin");
  if (!value) throw new ApiError(403, "origin_required", "Origin header is required");
  let origin: URL;
  try { origin = new URL(value); } catch { throw new ApiError(403, "origin_mismatch", "Origin is not allowed"); }
  const requestOrigin = new URL(request.url).origin;
  if (origin.origin !== requestOrigin && origin.origin !== publicOrigin.origin) throw new ApiError(403, "origin_mismatch", "Origin is not allowed");
}

const isHealth = (request: Request, path: string): boolean => request.method === "GET" && path === "/api/health";
const isLogin = (request: Request, path: string): boolean => request.method === "POST" && path === "/api/auth/login";

export function createHandler(db:Database,options:HandlerOptions={}):(request:Request,server?:Bun.Server<unknown>)=>Promise<Response> {
  const publicOrigin=options.publicOrigin instanceof URL?options.publicOrigin:new URL(options.publicOrigin??"http://localhost");
  const shares=new ShareRepo(db,{publicOrigin,serveDist:options.serveDist});
  const limiter=options.loginRateLimiter??new LoginRateLimiter();
  const legacyBasicAuth=options.legacyBasicAuth??options.basicAuth;
  return async (request,server)=>{
    const requestUrl=new URL(request.url);
    let decodedPath:string;
    try { decodedPath=decodeURIComponent(requestUrl.pathname); }
    catch { return errorResponse(new ApiError(400,"invalid_path","Malformed URL encoding")); }
    const shareSegments=decodedPath.split("/").filter(Boolean);
    const shareExchange=shareSegments[0]==="share"&&shareSegments.length===2;

    const shareScope=shares.authorizeScope(request,decodedPath);
    const sharePrincipal:SharePrincipal|undefined=shareScope?{kind:"share",scope:shareScope}:undefined;

    let capturePrincipal:CapturePrincipal|undefined;
    const captureToken=request.headers.get("x-easyui-capture");
    if(captureToken&&options.screenshots) {
      const address=server?.requestIP?.(request)?.address??null;
      if(options.screenshots.sessions.authorize({token:captureToken,address,method:request.method,path:decodedPath})) {
        const session=options.screenshots.sessions.get(captureToken);
        if(session) capturePrincipal={kind:"capture",scope:{token:captureToken,allowedUrls:session.allowedUrls}};
      }
    }
    const user=resolveSessionUser(db,request,publicOrigin.protocol==="https:");
    const principal=resolvePrincipal({capture:capturePrincipal,share:sharePrincipal,user});

    const legacyBypass=isHealth(request,decodedPath)||shareExchange||principal.kind==="share"||principal.kind==="capture";
    if(legacyBasicAuth&&!legacyBypass&&!isLegacyBasicAuthorized(request,legacyBasicAuth)) return legacyBasicUnauthorizedResponse();

    let staticResolution=null;
    try {
      enforceOrigin(request,publicOrigin);
      if(options.serveDist&&!decodedPath.startsWith("/api/")) staticResolution=await resolveStaticRequest(request,options.serveDist);
    } catch(error) {
      const response=errorResponse(error);
      return decodedPath.startsWith("/api/")?protectSessionResponse(response):response;
    }

    const anonymousAllowed=isHealth(request,decodedPath)||isLogin(request,decodedPath)||shareExchange||Boolean(staticResolution?.public);
    if(principal.kind==="anonymous"&&(decodedPath==="/share/p"||decodedPath.startsWith("/share/p/"))) return errorResponse(new ApiError(404,"not_found","Route not found"));
    if(principal.kind==="anonymous"&&!anonymousAllowed) {
      return applicationUnauthorizedResponse();
    }

    const finish=(response:Response):Response=>{
      let result=response;
      if(principal.kind==="share") result=protectShareResponse(result);
      else if(decodedPath.startsWith("/api/")) result=protectSessionResponse(result);
      if(legacyBasicAuth&&!legacyBypass) result=protectLegacyBasicResponse(result);
      return result;
    };

    try {
      if(shareExchange) return protectShareResponse(await exchangeShareToken(request,shareSegments[1]!,shares,publicOrigin));
      const segments=decodedPath.split("/").filter(Boolean);
      if(segments[0]==="api") {
        if(segments[1]==="health"&&segments.length===2) {
          if(request.method!=="GET") throw new ApiError(405,"method_not_allowed","Method not allowed");
          const ready=options.ready?.()!==false;
          return finish(json({status:ready?"ready":"starting"},ready?200:503,noStore));
        }
        const clientAddress=server?.requestIP?.(request)?.address??"direct";
        const auth=await routeAuth(request,db,segments.slice(1),{principal,publicOrigin,clientAddress,limiter}); if(auth) return finish(auth);
        const users=await routeUsers(request,db,segments.slice(1),principal); if(users) return finish(users);
        const shot=await routeScreenshots(request,db,options.screenshots,segments.slice(1),principal); if(shot) return finish(shot);
        const vis=await routeVisual(request,db,options.dataDir??process.env.DATA_DIR??"data",segments.slice(1),principal,options.visual); if(vis) return finish(vis);
        const share=await routeShares(request,db,segments.slice(1),principal,{publicOrigin,serveDist:options.serveDist}); if(share) return finish(share);
        const bundles=await routeBundles(request,db,segments.slice(1),principal,options.dataDir??process.env.DATA_DIR??"data"); if(bundles) return finish(bundles);
        if(segments[1]==="prototypes") return finish(await routePrototypes(request,db,segments.slice(1),principal,options.dataDir,options.serveDist));
        if(segments[1]==="components") return finish(await routeComponents(request,db,segments.slice(1),principal,options.dataDir??process.env.DATA_DIR??"data"));
        if(segments[1]==="assets") return finish(await routeAssets(request,db,segments.slice(1),principal,options.dataDir??process.env.DATA_DIR??"data"));
        if(segments[1]==="design-systems") return finish(await routeDesignSystems(request,db,segments.slice(1),principal));
        if(segments[1]==="catalog"&&segments[2]==="manifest"&&segments.length===3) { if(request.method!=="GET") throw new ApiError(405,"method_not_allowed","Method not allowed"); const {designSystem}=parseQuery(catalogManifestQuerySchema,requestUrl.searchParams); const system=designSystem===undefined?null:getIncludingRetired(db,designSystem); if(designSystem!==undefined&&(!system||system.retired)) throw new ApiError(404,"not_found","Design system not found"); return finish(json({components:catalogManifest(db,designSystem)},200,noStore)); }
        if(segments[1]==="shims"&&(segments[2]==="v1"||segments[2]==="v2"||segments[2]==="v3")) return finish(routeShims(request,segments.slice(1)));
        const meta=routeMeta(request,db,segments.slice(1)); if(meta) return finish(meta);
        throw new ApiError(404,"not_found","API route not found");
      }
      if(staticResolution) return finish(await serveResolvedStatic(request,staticResolution));
      throw new ApiError(404,"not_found","Route not found");
    } catch(error) { return finish(errorResponse(error)); }
  };
}

export async function startServer(options:{port?:number;database?:string;serveDist?:string;host?:string}={}) {
  const host=options.host??process.env.HOST??"127.0.0.1";
  const port=options.port??Number(process.env.PORT||8787);
  const publicOrigin=resolvePublicOrigin(process.env.PUBLIC_ORIGIN||undefined,{host,port});
  const db=openDatabase(options.database);
  try {
    const admin=await ensureBootstrapAdmin(db);
    if(!admin) throw new Error(isLoopbackHostname(host)?"At least one admin is required; set ADMIN_NAME and ADMIN_PASSWORD":"Refusing to start on a non-loopback host without an existing admin or ADMIN_NAME/ADMIN_PASSWORD");
    assertOwnersPresent(db);
    failStagingPublishes(db);
    await verifyShimAbi();
    const dataDir=process.env.DATA_DIR??"data";
    const serveDist=options.serveDist??(process.env.SERVE_DIST||undefined);
    const captureHost=host==="0.0.0.0"||host==="::"?"127.0.0.1":host;
    const screenshots=new ScreenshotServiceImpl({db,dataDir,serveDist,captureOrigin:`http://${captureHost}:${port}`,chromiumAvailable:chromiumAvailable(),runJob:spawnWorker});
    const visual=new VisualServiceImpl({db,dataDir,screenshots});
    const server=Bun.serve({hostname:host,port,fetch:createHandler(db,{ready:()=>true,serveDist,dataDir,legacyBasicAuth:resolveLegacyBasicAuthEnv(),publicOrigin,screenshots,visual})});
    return {server,db};
  } catch(error) { db.close(); throw error; }
}

if(import.meta.main) { const {server}=await startServer(); console.log(`easy-ui server listening on http://${server.hostname}:${server.port}`); }
