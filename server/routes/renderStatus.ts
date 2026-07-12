import type { Database } from "bun:sqlite";
import { parseQuery, renderStatusQuerySchema } from "../contracts";
import { json, noStore } from "../http";
import { PrototypeRepo } from "../repos/prototypes";

export const headScreenUrl = (id: string, screenId: string): string =>
  `/p/${encodeURIComponent(id)}/s/${encodeURIComponent(screenId)}`;
export const versionScreenUrl = (id: string, version: number, screenId: string): string =>
  `/p/${encodeURIComponent(id)}/v/${version}/s/${encodeURIComponent(screenId)}`;

// GET /api/prototypes/:id/screens/:screenId/render-status?version=n|rev=n
// Reports document / bundle / local-route readiness. Missing prototype/screen/version/revision
// are typed 404s; bundle_failed and route_not_ready are diagnostic entries in a 200 body.
export function renderStatus(request: Request, db: Database, id: string, screenId: string, options: { serveDist?: string }): Response {
  const query = parseQuery(renderStatusQuerySchema, new URL(request.url).searchParams);
  const repo = new PrototypeRepo(db);
  const result = repo.screenRenderStatus(id, screenId, { rev: query.rev, version: query.version });

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
  }, 200, noStore);
}
