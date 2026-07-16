import { ApiError, json, noStore, readJson } from "../http";
import type { ScreenshotService } from "../screenshot/service";
import type { Database } from "bun:sqlite";
import type { Principal } from "../auth";
import { requirePrototypeOwner, requirePrototypeRead, requireResourceOwner } from "../authorization";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function body(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new ApiError(400, "invalid_request", "Request body must be an object");
  return value;
}
function optionalPositiveInt(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new ApiError(400, "invalid_request", `${name} must be a positive integer`);
  return value;
}
function unavailable(): never { throw new ApiError(501, "screenshot_unavailable", "Screenshot capture requires SERVE_DIST and an installed chromium"); }

/**
 * Screenshot job routes. Returns `null` when the path is not a screenshot route
 * so the caller can fall through to the generic API router. When the path is a
 * screenshot route but the service is unavailable, POST returns 501 directly.
 */
export async function routeScreenshots(request: Request, db:Database, service: ScreenshotService | undefined, segments: string[], principal:Principal): Promise<Response | null> {
  // GET /api/screenshot-jobs/:jobId
  if (segments[0] === "screenshot-jobs" && segments.length === 2) {
    if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    if (!service) throw new ApiError(404, "job_not_found", "Screenshot job not found");
    const job=service.peek(segments[1]!);
    if(job?.kind==="prototype"){const match=/^\/capture\/([^/]+)\//.exec(job.captureUrl);if(match)requirePrototypeRead(db,decodeURIComponent(match[1]!),principal);}
    return json(service.get(segments[1]!), 200, noStore);
  }
  // POST /api/prototypes/:id/screens/:screenId/screenshot
  if (segments[0] === "prototypes" && segments.length === 5 && segments[2] === "screens" && segments[4] === "screenshot") {
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    if (!service) unavailable();
    requirePrototypeOwner(db,segments[1]!,principal);
    const b = body(await readJson(request));
    const rev = optionalPositiveInt(b.rev, "rev"), version = optionalPositiveInt(b.version, "version");
    if (rev !== undefined && version !== undefined) throw new ApiError(400, "invalid_request", "rev and version are mutually exclusive");
    if (b.probe !== undefined && b.probe !== "geometry") throw new ApiError(400, "invalid_request", "probe must be geometry");
    const result = service.enqueuePrototype(segments[1]!, segments[3]!, { rev, version, viewport: b.viewport, deviceScaleFactor: b.deviceScaleFactor, theme: typeof b.theme === "string" ? b.theme : undefined, waitForFonts: b.waitForFonts !== false, probe: b.probe as "geometry" | undefined });
    return json(result, 202, noStore);
  }
  // POST /api/components/:id/versions/:version/screenshot
  if (segments[0] === "components" && segments.length === 5 && segments[2] === "versions" && segments[4] === "screenshot") {
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    if (!service) unavailable();
    requireResourceOwner(db,"components",segments[1]!,principal);
    const versionNumber = optionalPositiveInt(Number(segments[3]), "version");
    if (versionNumber === undefined) throw new ApiError(400, "invalid_request", "version must be a positive integer");
    const b = body(await readJson(request));
    if (Object.hasOwn(b, "props") && Object.hasOwn(b, "exampleName")) throw new ApiError(400, "invalid_request", "props and exampleName are mutually exclusive");
    if (b.props !== undefined && !isObject(b.props)) throw new ApiError(422, "invalid_props", "props must be a JSON object");
    if (b.exampleName !== undefined && typeof b.exampleName !== "string") throw new ApiError(400, "invalid_request", "exampleName must be a string");
    const result = service.enqueueComponent(segments[1]!, versionNumber, { props: b.props as Record<string, unknown> | undefined, exampleName: b.exampleName as string | undefined, viewport: b.viewport, deviceScaleFactor: b.deviceScaleFactor, theme: typeof b.theme === "string" ? b.theme : undefined, waitForFonts: b.waitForFonts !== false });
    return json(result, 202, noStore);
  }
  return null;
}
