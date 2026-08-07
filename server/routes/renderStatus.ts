import type { Database } from "bun:sqlite";
import { parseQuery, renderStatusQuerySchema } from "../contracts";
import { ApiError, json, noStore } from "../http";
import { parseCandidateOverlayInput, resolveOverlayMap } from "../acceptance/caseSets";
import { PrototypeRepo } from "../repos/prototypes";

/**
 * `componentId:candidateId` → карта. GET не несёт тела, поэтому форма пары фиксирована здесь и
 * задокументирована в контракте ручки; двоеточие не входит ни в `components.id`, ни в `cand_`.
 */
function overlayMapOf(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const at = pair.indexOf(":");
    if (at <= 0 || at === pair.length - 1) {
      throw new ApiError(400, "invalid_request", `candidateOverlay must be "<componentId>:<candidateId>", got ${JSON.stringify(pair)}`);
    }
    const node = pair.slice(0, at);
    if (out[node] !== undefined && out[node] !== pair.slice(at + 1)) {
      throw new ApiError(400, "invalid_request", `candidateOverlay declares ${node} twice with different candidates`);
    }
    out[node] = pair.slice(at + 1);
  }
  return out;
}

export const headScreenUrl = (id: string, screenId: string): string =>
  `/p/${encodeURIComponent(id)}/s/${encodeURIComponent(screenId)}`;
export const versionScreenUrl = (id: string, version: number, screenId: string): string =>
  `/p/${encodeURIComponent(id)}/v/${version}/s/${encodeURIComponent(screenId)}`;

// GET /api/prototypes/:id/screens/:screenId/render-status?version=n|rev=n
// Reports document / bundle / local-route readiness. Missing prototype/screen/version/revision
// are typed 404s; bundle_failed and route_not_ready are diagnostic entries in a 200 body.
export function renderStatus(request: Request, db: Database, id: string, screenId: string, options: { serveDist?: string }): Response {
  const params = new URL(request.url).searchParams;
  const query = parseQuery(renderStatusQuerySchema, params);
  const repo = new PrototypeRepo(db);
  const result = repo.screenRenderStatus(id, screenId, { rev: query.rev, version: query.version });
  // §W3 (план 2026-08-07), диагностическая поверхность: `?candidateOverlay=<componentId>:<candidateId>`
  // (повторяемый параметр) резолвится и возвращается **эхом** — «во что превратится эта карта, если
  // её объявит case-set». Документ, пины и вердикт `renderable` она не трогает: prototype-путь
  // остаётся swap-only (`candidateOverrides`), а вставки неопубликованного в прототип не бывает.
  const overlay = params.getAll("candidateOverlay");
  const candidateOverlay = overlay.length === 0 ? null : resolveOverlayMap({
    db, overlay: parseCandidateOverlayInput(overlayMapOf(overlay)), designSystem: null, mode: "gating",
  });

  const warnings = [...result.warnings];
  const errors = [...result.errors];
  const routeReady = Boolean(options.serveDist);
  if (!routeReady) errors.push({ code: "route_not_ready", message: "SPA static assets are not served by this process (SERVE_DIST unset); use the Vite dev origin for the local route" });

  const url = result.version !== null ? versionScreenUrl(id, result.version, screenId) : headScreenUrl(id, screenId);
  // renderable = document + bundles (content readiness), independent of local-route serving.
  const renderable = result.document && result.bundles;
  return json({
    status: { document: result.document, bundles: result.bundles, route: routeReady },
    renderable,
    url,
    revision: result.rev,
    publishedVersion: result.publishedVersion,
    resolvedPins: result.resolvedPins,
    bundleStatus: result.bundleStatus,
    warnings,
    errors,
    ...(candidateOverlay === null ? {} : { candidateOverlay }),
  }, 200, noStore);
}
