import type { Database } from "bun:sqlite";
import { ApiError, json, noStore, readJson } from "../http";
import { parseWith } from "../contracts";
import { fingerprintSchema } from "../visual/fingerprint";
import { VisualRepo } from "../visual/repo";
import type { VisualService } from "../visual/service";
import { routeVisualBaselines } from "./visualBaselines";
import type {Principal} from "../auth";
import {requirePrototypeOwner,requirePrototypeRead,requireResourceOwner} from "../authorization";
import type {Fingerprint} from "../visual/fingerprint";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Visual regression routes. PUT/GET/DELETE only touch the DB (via VisualRepo); the
 * check flow and run polling require the singleton {@link VisualService} that
 * owns candidate capture + diff orchestration.
 */
export async function routeVisual(request: Request, db: Database, dataDir: string, segments: string[], principal:Principal, service?: VisualService): Promise<Response | null> {
  const baseline=await routeVisualBaselines(request,db,dataDir,segments,principal); if(baseline) return baseline;
  if (segments[0] === "visual-references") {
    const repo = new VisualRepo(db, dataDir);
    if (segments.length === 1) {
      if (request.method === "PUT") return await putReference(request, db,repo,principal);
      if (request.method === "GET") return listReferences(request,db,repo,principal);
      throw new ApiError(405, "method_not_allowed", "Method not allowed");
    }
    const id = segments[1]!;
    if (segments.length === 2) {
      if (request.method === "GET") return getReference(db,repo,id,principal);
      if (request.method === "DELETE") return deleteReference(db,repo,id,principal);
      throw new ApiError(405, "method_not_allowed", "Method not allowed");
    }
    if (segments.length === 3 && segments[2] === "check") {
      if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Method not allowed");
      assertReferenceMutation(db,repo,id,principal); return await checkReference(request, id, service);
    }
    throw new ApiError(404, "not_found", "API route not found");
  }
  if (segments[0] === "visual-runs" && segments.length === 2) {
    if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    return getRun(db, dataDir, segments[1]!, principal,service);
  }
  return null;
}

function assertFingerprintRead(db:Database,fp:Record<string,unknown>,principal:Principal):void { if(principal.kind==="user"&&principal.isAdmin)return; if(fp.scope==="prototype-screen"&&typeof fp.prototypeId==="string") requirePrototypeRead(db,fp.prototypeId,principal); }
function assertFingerprintMutation(db:Database,fp:Record<string,unknown>,principal:Principal):void { if(principal.kind==="user"&&principal.isAdmin)return; if(fp.scope==="prototype-screen"&&typeof fp.prototypeId==="string") requirePrototypeOwner(db,fp.prototypeId,principal); else if(fp.scope==="component"&&typeof fp.componentId==="string") requireResourceOwner(db,"components",fp.componentId,principal); else throw new ApiError(422,"invalid_fingerprint","Fingerprint target is invalid"); }
function referenceFingerprint(repo:VisualRepo,id:string):Record<string,unknown>{const row=repo.getReference(id,true);if(!row)throw new ApiError(404,"reference_not_found","Visual reference not found");return JSON.parse(row.fingerprint_json) as Record<string,unknown>;}
function assertReferenceMutation(db:Database,repo:VisualRepo,id:string,principal:Principal):void{assertFingerprintMutation(db,referenceFingerprint(repo,id),principal);}

async function putReference(request: Request, db:Database,repo: VisualRepo,principal:Principal): Promise<Response> {
  const raw = await readJson(request);
  if (!isObject(raw)) throw new ApiError(400, "invalid_request", "Request body must be an object");
  const fingerprint = parseWith(fingerprintSchema, raw.fingerprint, "Fingerprint is invalid");
  assertFingerprintMutation(db,fingerprint as Fingerprint & Record<string,unknown>,principal);
  if (typeof raw.assetId !== "string" || !raw.assetId) throw new ApiError(400, "invalid_request", "assetId is required");
  if (raw.note !== undefined && typeof raw.note !== "string") throw new ApiError(400, "invalid_request", "note must be a string");
  const asset = repo.assetRepo().get(raw.assetId);
  if (!asset) throw new ApiError(422, "asset_not_found", "Reference asset does not exist");
  if (asset.mime !== "image/png") throw new ApiError(422, "invalid_reference_asset", "Reference asset must be a PNG");
  const row = repo.upsertReferenceGeneric(fingerprint, raw.assetId, (raw.note as string | undefined) ?? null);
  return json(repo.referencePublic(row), 200, noStore);
}

function listReferences(request: Request,db:Database, repo: VisualRepo,principal:Principal): Response {
  const url = new URL(request.url);
  const scope = url.searchParams.get("scope") ?? undefined;
  if (scope !== undefined && scope !== "prototype-screen" && scope !== "component") throw new ApiError(400, "invalid_request", "scope must be prototype-screen or component");
  const rows = repo.listReferences({ scope, prototypeId: url.searchParams.get("prototypeId") ?? undefined, componentId: url.searchParams.get("componentId") ?? undefined }).filter(row=>{try{assertFingerprintRead(db,JSON.parse(row.fingerprint_json) as Record<string,unknown>,principal);return true;}catch{return false;}});
  return json({ references: rows.map((row) => repo.referencePublic(row)) }, 200, noStore);
}

function getReference(db:Database,repo: VisualRepo, id: string,principal:Principal): Response {
  const row = repo.getReference(id);
  if (!row) throw new ApiError(404, "reference_not_found", "Visual reference not found");
  assertFingerprintRead(db,JSON.parse(row.fingerprint_json) as Record<string,unknown>,principal);
  const runs = repo.listRuns(id).map((run) => repo.runReport(run));
  return json({ ...repo.referencePublic(row), runs }, 200, noStore);
}

function deleteReference(db:Database,repo: VisualRepo, id: string,principal:Principal): Response {
  assertReferenceMutation(db,repo,id,principal);
  if (!repo.deleteReferenceGeneric(id)) throw new ApiError(404, "reference_not_found", "Visual reference not found");
  return new Response(null, { status: 204, headers: noStore });
}

async function checkReference(request: Request, id: string, service?: VisualService): Promise<Response> {
  if (!service) throw new ApiError(501, "screenshot_unavailable", "Visual checks require the screenshot pipeline (SERVE_DIST + chromium)");
  let threshold: number | undefined,rev:number|undefined,version:number|undefined;
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType === "application/json") {
    const raw = await readJson(request);
    if (raw !== null && isObject(raw)) {
      if(Object.keys(raw).some(key=>!["threshold","rev","version"].includes(key))) throw new ApiError(422,"invalid_candidate_target","Check body contains unsupported fields");
      if(raw.threshold!==undefined) threshold=raw.threshold as number;
      for(const key of ["rev","version"] as const) if(raw[key]!==undefined&&(typeof raw[key]!=="number"||!Number.isInteger(raw[key])||(raw[key] as number)<1)) throw new ApiError(422,"invalid_candidate_target",`${key} must be a positive integer`);
      rev=raw.rev as number|undefined; version=raw.version as number|undefined;
    }
  }
  const result = service.check(id, { threshold,rev,version });
  return json(result, 202, noStore);
}

function getRun(db: Database, dataDir: string, runId: string, principal:Principal,service?: VisualService): Response {
  if (service) {
    const view = service.get(runId);
    if (!view) throw new ApiError(404, "run_not_found", "Visual run not found");
    const repo=new VisualRepo(db,dataDir); const referenceId=view.kind==="running"?view.referenceId:view.report.referenceId; assertFingerprintRead(db,referenceFingerprint(repo,referenceId),principal); return json(view.kind === "running" ? { runId: view.runId, referenceId: view.referenceId, status: view.status, jobId: view.jobId } : view.report, 200, noStore);
  }
  const repo = new VisualRepo(db, dataDir);
  const row = repo.getRun(runId);
  if (!row) throw new ApiError(404, "run_not_found", "Visual run not found");
  assertFingerprintRead(db,referenceFingerprint(repo,row.reference_id),principal);
  return json(repo.runReport(row), 200, noStore);
}
