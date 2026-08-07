import type { Database } from "bun:sqlite";
import { openDatabase } from "./db";
import { ApiError, errorResponse, json, noStore } from "./http";
import { routePrototypes } from "./routes/prototypes";
import { resolveStaticRequest, serveResolvedStatic } from "./static";
import { routeComponents, catalogManifest, routeCatalogUsages } from "./routes/components";
import { routeLibraryCatalog } from "./routes/libraryCatalog";
import { routeCatalogCandidates } from "./routes/catalogCandidates";
import { routeReuseDecisions } from "./routes/reuseDecisions";
import { routeCompositions } from "./routes/compositions";
import { routeAssets } from "./routes/assets";
import { routeDesignSystems } from "./routes/designSystems";
import { routeShims } from "./routes/shims";
import { failStagingPublishes } from "./repos/components";
import { verifyShimAbi } from "./shims/abi-v1";
import { applicationUnauthorizedResponse, isLegacyBasicAuthorized, legacyBasicUnauthorizedResponse, protectLegacyBasicResponse, protectSessionResponse, resolvePrincipal, resolveSessionUser, type CapturePrincipal, type SharePrincipal } from "./auth";
import type { ScreenshotService } from "./screenshot/service";
import { ScreenshotService as ScreenshotServiceImpl } from "./screenshot/service";
import { chromiumAvailable, spawnWorker } from "./screenshot/worker-runner";
import { initRenderer, rendererReport } from "./capture/renderer";
import { routeScreenshots } from "./routes/screenshots";
import type { VisualService } from "./visual/service";
import { VisualService as VisualServiceImpl } from "./visual/service";
import { routeVisual } from "./routes/visual";
import { routeMeta } from "./routes/meta";
import { exchangeShareToken, protectShareResponse, routeShares } from "./routes/share";
import { routeBundles } from "./routes/bundles";
import { routeScenarios } from "./routes/scenarios";
import { ShareRepo } from "./share/repo";
import { catalogManifestQuerySchema, parseQuery } from "./contracts";
import { getIncludingRetired } from "./designSystems";
import { LoginRateLimiter, routeAuth } from "./routes/auth";
import { routeUsers } from "./routes/users";
import { routeAdminSnapshot } from "./routes/adminSnapshot";
import { assertOwnersPresent, ensureBootstrapAdmin } from "./users";
import { sweepStagingModules } from "./components/pipeline";
import { gcCandidates, overlayLeasePins, setCandidatePinProvider } from "./components/candidates";
import { gcReceipts, setReceiptPinProvider } from "./capture/receiptStore";
import { DEFAULT_REUSE_GATE_MODE, resolveReuseGateMode, type ReuseGateMode } from "./catalog/gate";
import { assertMutationAllowed } from "./maintenance";
import { routeCatalogMigrations } from "./routes/catalogMigrations";
import { AcceptanceOrchestrator } from "./acceptance/orchestrator";
import { AcceptanceRepo } from "./acceptance/repo";
import { referencedArtifactShas } from "./acceptance/evidence";
import { routeAcceptance } from "./routes/acceptance";
import { routeCaseSets } from "./routes/caseSets";
import { RESOURCE_BARRIER_DISABLED } from "./capture/resourceBarrier";

export type HandlerOptions = {
  ready?: () => boolean;
  serveDist?: string;
  dataDir?: string;
  /** Режим reuse-гейта; дефолт `enforce`. Env читается только на входе процесса (см. startServer). */
  reuseGateMode?: ReuseGateMode;
  /** Kill-switch P8: `EASYUI_VALIDATE_DISABLED=1` гасит POST /api/components/:id/validate (404 + features.componentValidate=false). */
  validateDisabled?: boolean;
  /**
   * Kill-switch RFC candidate-acceptance R1: `EASYUI_ACCEPTANCE_DISABLED=1` гасит
   * POST /api/components/:id/promote (404 + features.acceptancePromote=false).
   * Publish-путь при этом остаётся рабочим — гашение приёмки не делает DS неопубликуемой.
   */
  acceptanceDisabled?: boolean;
  /**
   * Kill-switch P6.3: `EASYUI_THEME_RESOLVER_V2_DISABLED=1` — новые версии тем пишутся с legacy-резолвером
   * spacing-шкалы (`spacing_resolver=1`) и без наследования выпавших `space.*`
   * (features.themeSpacingResolverV2=false). Существующие версии не затрагиваются в любом случае.
   */
  spacingResolverV2Disabled?: boolean;
  /** Optional reverse-proxy compatibility barrier; application auth remains cookie-based. */
  legacyBasicAuth?: string;
  /** @deprecated test/backward-compatible alias for legacyBasicAuth. */
  basicAuth?: string;
  publicOrigin?: URL | string;
  screenshots?: ScreenshotService;
  visual?: VisualService;
  /**
   * Оркестратор матричной приёмки (план 2026-08-03 §5 W1a). Присутствие инстанса **и есть**
   * kill-switch `EASYUI_ACCEPTANCE_MATRIX=1`: без него acceptance-роутов нет (404), а
   * `capabilities.features.acceptance*` рапортуют false. Env читается один раз в `startServer` —
   * тот же канон, что у `reuseGateMode`/`validateDisabled`.
   */
  acceptance?: AcceptanceOrchestrator;
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
          // Секция `renderer` (план renderer-contract-2 §3 E2): расхождение образа и манифеста
          // обязано быть видно деплою, а не первому капчуру.
          return finish(json({status:ready?"ready":"starting",renderer:rendererReport()},ready?200:503,noStore));
        }
        const clientAddress=server?.requestIP?.(request)?.address??"direct";
        const auth=await routeAuth(request,db,segments.slice(1),{principal,publicOrigin,clientAddress,limiter}); if(auth) return finish(auth);
        assertMutationAllowed(db,request.method,decodedPath);
        const users=await routeUsers(request,db,segments.slice(1),principal); if(users) return finish(users);
        // Физический снимок БД для бэкапа (admin-only, VACUUM INTO): рядом с админскими users-роутами.
        const snapshot=await routeAdminSnapshot(request,db,segments.slice(1),principal,options.dataDir??process.env.DATA_DIR??"data"); if(snapshot) return finish(snapshot);
        const shot=await routeScreenshots(request,db,options.screenshots,segments.slice(1),principal,{validateDisabled:options.validateDisabled===true,acceptanceMatrix:options.acceptance!==undefined}); if(shot) return finish(shot);
        const vis=await routeVisual(request,db,options.dataDir??process.env.DATA_DIR??"data",segments.slice(1),principal,options.visual); if(vis) return finish(vis);
        const share=await routeShares(request,db,segments.slice(1),principal,{publicOrigin,serveDist:options.serveDist}); if(share) return finish(share);
        const bundles=await routeBundles(request,db,segments.slice(1),principal,options.dataDir??process.env.DATA_DIR??"data",options.reuseGateMode??DEFAULT_REUSE_GATE_MODE); if(bundles) return finish(bundles);
        const scenarios=await routeScenarios(request,db,segments.slice(1),principal); if(scenarios) return finish(scenarios);
        // Приёмка кандидатов (план 2026-08-03 §5 W1a). Диспатчится ДО `components`, потому что
        // `POST /api/components/:id/candidates` живёт в компонентном namespace, а владеет им
        // acceptance-модуль. Без `options.acceptance` (флаг OFF) роут отвечает 404 на весь набор.
        const acceptance=await routeAcceptance(request,db,segments.slice(1),principal,options.dataDir??process.env.DATA_DIR??"data",options.acceptance); if(acceptance) return finish(acceptance);
        // Case-set-манифесты (план 2026-08-03 §5 W2). Диспатчится рядом с приёмкой и по той же
        // причине: `PUT /api/components/:id/case-sets` живёт в компонентном namespace, а владеет
        // им acceptance-модуль; без `options.acceptance` весь набор отвечает 404.
        const caseSets=await routeCaseSets(request,db,segments.slice(1),principal,options.acceptance); if(caseSets) return finish(caseSets);
        if(segments[1]==="prototypes") return finish(await routePrototypes(request,db,segments.slice(1),principal,options.dataDir,options.serveDist));
        if(segments[1]==="components") return finish(await routeComponents(request,db,segments.slice(1),principal,options.dataDir??process.env.DATA_DIR??"data",options.reuseGateMode??DEFAULT_REUSE_GATE_MODE,{disabled:options.validateDisabled===true},{disabled:options.acceptanceDisabled===true,matrix:options.acceptance!==undefined,...(options.acceptance?{repo:options.acceptance.repo}:{})}));
        if(segments[1]==="compositions") return finish(await routeCompositions(request,db,segments.slice(1),principal));
        if(segments[1]==="assets") return finish(await routeAssets(request,db,segments.slice(1),principal,options.dataDir??process.env.DATA_DIR??"data"));
        if(segments[1]==="design-systems") return finish(await routeDesignSystems(request,db,segments.slice(1),principal,{spacingResolverV2Disabled:options.spacingResolverV2Disabled===true}));
        if(segments[1]==="catalog"&&segments[2]==="manifest"&&segments.length===3) { if(request.method!=="GET") throw new ApiError(405,"method_not_allowed","Method not allowed"); const {designSystem}=parseQuery(catalogManifestQuerySchema,requestUrl.searchParams); const system=designSystem===undefined?null:getIncludingRetired(db,designSystem); if(designSystem!==undefined&&(!system||system.retired)) throw new ApiError(404,"not_found","Design system not found"); return finish(json({components:catalogManifest(db,designSystem)},200,noStore)); }
        if(segments[1]==="catalog"&&segments[2]==="library"&&segments.length===3) return finish(routeLibraryCatalog(request,db));
        if(segments[1]==="catalog"&&segments[2]==="usages"&&segments.length===3) return finish(routeCatalogUsages(request,db));
        // Discovery кандидатов на переиспользование (проект 2 §4 T4). `requireUser` — внутри
        // роута: share/capture проходят проверку анонимности выше и обязаны получить 403.
        if(segments[1]==="catalog"&&segments[2]==="candidates"&&segments.length===3) return finish(await routeCatalogCandidates(request,db,principal,options.dataDir??process.env.DATA_DIR??"data"));
        // Админское чтение аудита гейта (проект 2 §4 T10); admin-проверка — внутри роута.
        if(segments[1]==="catalog"&&segments[2]==="reuse-decisions"&&segments.length===3) return finish(routeReuseDecisions(request,db,principal));
        if(segments[1]==="catalog"&&segments[2]==="migrations") return finish(await routeCatalogMigrations(request,db,segments.slice(2),principal,options.dataDir??process.env.DATA_DIR??"data"));
        if(segments[1]==="shims"&&segments[2]!==undefined&&/^v[1-9]\d*$/.test(segments[2])) return finish(routeShims(request,segments.slice(1)));
        // Режим гейта — часть discovery: `/api/capabilities` обязан рапортовать фактическую
        // фазу процесса, иначе агент узнаёт её только сломав собственный create.
        const meta=routeMeta(request,db,segments.slice(1),options.reuseGateMode??DEFAULT_REUSE_GATE_MODE,{validateDisabled:options.validateDisabled===true,acceptanceDisabled:options.acceptanceDisabled===true,spacingResolverV2Disabled:options.spacingResolverV2Disabled===true,acceptanceMatrix:options.acceptance!==undefined}); if(meta) return finish(meta);
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
    // Self-check рендерера (план renderer-contract-2 §3 E2): манифест читается и замораживается
    // здесь, до первой джобы, а расхождения печатаются в лог деплоя. Отказом старта это
    // намеренно не является — недоступный манифест деградирует до dev-режима, а не роняет прод.
    const renderer=await initRenderer();
    for(const warning of renderer.warnings) console.warn(`[renderer] ${warning}`);
    console.log(`[renderer] ${renderer.declaration.rendererVersion} ${renderer.declaration.browserName}@${renderer.declaration.browserVersion ?? "unknown"} (${renderer.declaration.source}) fingerprint=${renderer.fingerprint}`);
    // W2 (план 2026-08-07 §W2): kill-switch барьера ресурсов читается один раз на процесс
    // (`server/capture/resourceBarrier.ts`) и меняет readiness-политику обоих профилей приёмки,
    // режима `reference` и галерейного опт-ина. Он render-affecting через отпечатки
    // (`policyProfileHash`/`readinessPolicyHash`/`rendererFingerprint`), поэтому факт включения
    // обязан быть виден в логе старта, а не только в env контейнера.
    if(RESOURCE_BARRIER_DISABLED) console.warn("[capture] EASYUI_RESOURCE_BARRIER_DISABLED=1: resource barrier off, profiles fall back to their pre-wave readiness policies (default-v1 → v1, pixel-strict-v1 → v2, reference → v2)");
    const dataDir=process.env.DATA_DIR??"data";
    // Сироты staging-извлечения после SIGKILL при редеплое: `finally` их не переживает,
    // а DATA_DIR в проде — постоянный том (план 2026-07-31 §3.5).
    await sweepStagingModules(dataDir);
    const serveDist=options.serveDist??(process.env.SERVE_DIST||undefined);
    const captureHost=host==="0.0.0.0"||host==="::"?"127.0.0.1":host;
    const screenshots=new ScreenshotServiceImpl({db,dataDir,serveDist,captureOrigin:`http://${captureHost}:${port}`,chromiumAvailable:chromiumAvailable(),runJob:spawnWorker});
    const visual=new VisualServiceImpl({db,dataDir,screenshots});
    // Матричная приёмка — opt-in (план 2026-08-03 §5 W0/W1a). Оркестратор создаётся **до**
    // `gcCandidates`: его конструктор делает стартовую уборку нетерминальных ранов (иначе
    // переживший рестарт ран вечно держал бы кандидата partial-индексом), а `candidatePins`
    // после неё честно описывает то, что нельзя вытеснять (A10).
    const acceptance=process.env.EASYUI_ACCEPTANCE_MATRIX==="1"
      ? new AcceptanceOrchestrator({db,dataDir,service:screenshots})
      : undefined;
    // A10: пины действуют и для GC-on-write (writeCandidate) — не только для стартового вызова.
    // Провайдер процесса — **объединение** трёх источников (план 2026-08-05 §B2.5): кандидаты
    // нетерминальных acceptance-ранов, кандидаты нетерминальных overlay-джоб и незакрытые аренды
    // роута (окно между резолвом кандидата и постановкой джобы). Композиция здесь, а не в
    // candidates.ts: провайдер один на процесс, и его состав — решение точки сборки.
    setCandidatePinProvider(async()=>{
      const pins=new Set<string>(overlayLeasePins());
      for(const sha of screenshots.pinnedCandidateSourceHashes()) pins.add(sha);
      if(acceptance) for(const sha of await acceptance.candidatePins()) pins.add(sha);
      return pins;
    });
    // P8: GC candidate-кэша на старте (TTL/потолок байт) и при каждой записи. Явный `pinned`
    // не передаётся намеренно: стартовый проход обязан видеть то же объединение, что и GC-on-write.
    await gcCandidates(dataDir);
    // R5: свипер receipt'ов — та же схема, что у кандидатов (GC на старте и при записи), с пином
    // живых job-результатов: пока джоба жива, её receipt обязан быть читаем ручкой.
    // Пины: живые job-результаты **и** адреса, на которые ссылаются per-run манифесты приёмки —
    // у receipt'а и его CAS-копии один адрес (см. `referencedArtifactShas`).
    setReceiptPinProvider(()=>{
      const pins=screenshots.liveReceiptShas();
      try { for(const sha of referencedArtifactShas(new AcceptanceRepo(db))) pins.add(sha); }
      catch { /* приёмка выключена или таблиц ещё нет — пины живых джоб остаются в силе */ }
      // R6 (T-M12): receipt, на который ссылается визуальный эталон, — его evidence. TTL стора
      // (7 суток) короче жизни эталона, поэтому без пина ссылка бы протухала, а diagnostic bundle
      // рана (R7b) указывал бы в пустоту. Тумбстоны включены намеренно: у мёртвого эталона тоже
      // есть раны, которые расследуют.
      try { for(const row of db.query("SELECT receipt_sha256 sha FROM visual_references WHERE receipt_sha256 IS NOT NULL").all() as {sha:string}[]) pins.add(row.sha); }
      catch { /* таблицы ещё нет — остальные пины остаются в силе */ }
      return pins;
    });
    await gcReceipts(dataDir);
    const server=Bun.serve({hostname:host,port,fetch:createHandler(db,{ready:()=>true,serveDist,dataDir,reuseGateMode:resolveReuseGateMode(process.env.REUSE_GATE),validateDisabled:process.env.EASYUI_VALIDATE_DISABLED==="1",acceptanceDisabled:process.env.EASYUI_ACCEPTANCE_DISABLED==="1",spacingResolverV2Disabled:process.env.EASYUI_THEME_RESOLVER_V2_DISABLED==="1",legacyBasicAuth:resolveLegacyBasicAuthEnv(),publicOrigin,screenshots,visual,...(acceptance?{acceptance}:{})})});
    return {server,db};
  } catch(error) { db.close(); throw error; }
}

if(import.meta.main) { const {server}=await startServer(); console.log(`easy-ui server listening on http://${server.hostname}:${server.port}`); }
