import type { Database } from "bun:sqlite";
import { ApiError, json, noStore, readJson } from "../http";
import { parseWith } from "../contracts";
import { fingerprintSchema } from "../visual/fingerprint";
import { VisualRepo } from "../visual/repo";
import type { VisualService } from "../visual/service";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Visual regression routes. PUT/GET only touch the DB (via VisualRepo); the
 * check flow and run polling require the singleton {@link VisualService} that
 * owns candidate capture + diff orchestration.
 */
export async function routeVisual(request: Request, db: Database, dataDir: string, segments: string[], service?: VisualService): Promise<Response | null> {
  if (segments[0] === "visual-references") {
    const repo = new VisualRepo(db, dataDir);
    if (segments.length === 1) {
      if (request.method === "PUT") return await putReference(request, repo);
      if (request.method === "GET") return listReferences(request, repo);
      throw new ApiError(405, "method_not_allowed", "Method not allowed");
    }
    const id = segments[1]!;
    if (segments.length === 2) {
      if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Method not allowed");
      return getReference(repo, id);
    }
    if (segments.length === 3 && segments[2] === "check") {
      if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Method not allowed");
      return await checkReference(request, id, service);
    }
    throw new ApiError(404, "not_found", "API route not found");
  }
  if (segments[0] === "visual-runs" && segments.length === 2) {
    if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    return getRun(db, dataDir, segments[1]!, service);
  }
  return null;
}

async function putReference(request: Request, repo: VisualRepo): Promise<Response> {
  const raw = await readJson(request);
  if (!isObject(raw)) throw new ApiError(400, "invalid_request", "Request body must be an object");
  const fingerprint = parseWith(fingerprintSchema, raw.fingerprint, "Fingerprint is invalid");
  if (typeof raw.assetId !== "string" || !raw.assetId) throw new ApiError(400, "invalid_request", "assetId is required");
  if (raw.note !== undefined && typeof raw.note !== "string") throw new ApiError(400, "invalid_request", "note must be a string");
  const asset = repo.assetRepo().get(raw.assetId);
  if (!asset) throw new ApiError(422, "asset_not_found", "Reference asset does not exist");
  if (asset.mime !== "image/png") throw new ApiError(422, "invalid_reference_asset", "Reference asset must be a PNG");
  const row = repo.upsertReference(fingerprint, raw.assetId, (raw.note as string | undefined) ?? null);
  return json(repo.referencePublic(row), 200, noStore);
}

function listReferences(request: Request, repo: VisualRepo): Response {
  const url = new URL(request.url);
  const scope = url.searchParams.get("scope") ?? undefined;
  if (scope !== undefined && scope !== "prototype-screen" && scope !== "component") throw new ApiError(400, "invalid_request", "scope must be prototype-screen or component");
  const rows = repo.listReferences({ scope, prototypeId: url.searchParams.get("prototypeId") ?? undefined, componentId: url.searchParams.get("componentId") ?? undefined });
  return json({ references: rows.map((row) => repo.referencePublic(row)) }, 200, noStore);
}

function getReference(repo: VisualRepo, id: string): Response {
  const row = repo.getReference(id);
  if (!row) throw new ApiError(404, "reference_not_found", "Visual reference not found");
  const runs = repo.listRuns(id).map((run) => repo.runReport(run, row.asset_id));
  return json({ ...repo.referencePublic(row), runs }, 200, noStore);
}

async function checkReference(request: Request, id: string, service?: VisualService): Promise<Response> {
  if (!service) throw new ApiError(501, "screenshot_unavailable", "Visual checks require the screenshot pipeline (SERVE_DIST + chromium)");
  let threshold: number | undefined;
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType === "application/json") {
    const raw = await readJson(request);
    if (raw !== null && isObject(raw) && raw.threshold !== undefined) {
      if (typeof raw.threshold !== "number") throw new ApiError(400, "invalid_request", "threshold must be a number");
      threshold = raw.threshold;
    }
  }
  const result = service.check(id, { threshold });
  return json(result, 202, noStore);
}

function getRun(db: Database, dataDir: string, runId: string, service?: VisualService): Response {
  if (service) {
    const view = service.get(runId);
    if (!view) throw new ApiError(404, "run_not_found", "Visual run not found");
    return json(view.kind === "running" ? { runId: view.runId, referenceId: view.referenceId, status: view.status, jobId: view.jobId } : view.report, 200, noStore);
  }
  const repo = new VisualRepo(db, dataDir);
  const row = repo.getRun(runId);
  if (!row) throw new ApiError(404, "run_not_found", "Visual run not found");
  const reference = repo.getReference(row.reference_id);
  return json(repo.runReport(row, reference?.asset_id ?? null), 200, noStore);
}
