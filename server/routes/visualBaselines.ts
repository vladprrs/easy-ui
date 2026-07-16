import { z } from "zod";
import type { Database } from "bun:sqlite";
import { parseWith } from "../contracts";
import { ApiError, json, noStore, readJson } from "../http";
import { VisualBaselineRepo } from "../visual/baselines";
import type {Principal} from "../auth";
import {requirePrototypeOwner,requirePrototypeRead} from "../authorization";

export const baselineMemberInputSchema=z.strictObject({
  screenId:z.string().min(1),
  viewport:z.strictObject({width:z.number().int(),height:z.number().int()}),
  deviceScaleFactor:z.union([z.literal(1),z.literal(2),z.literal(3)]),
  theme:z.enum(["light","dark"]),
  assetId:z.string().min(1),
});
export const putVisualBaselineSchema=z.strictObject({
  rev:z.number().int().positive(),prototypeInstanceId:z.string().min(1),baseGeneration:z.number().int().positive().nullable(),members:z.array(baselineMemberInputSchema),
});

export async function routeVisualBaselines(request:Request,db:Database,dataDir:string,segments:string[],principal:Principal):Promise<Response|null> {
  if(segments[0]!=="visual-baselines") return null;
  if(segments.length!==3||segments[1]!=="prototypes") throw new ApiError(404,"not_found","API route not found");
  const repo=new VisualBaselineRepo(db,dataDir); const id=segments[2]!;
  if(request.method==="GET") { requirePrototypeRead(db,id,principal); return json(repo.get(id),200,noStore); }
  if(request.method==="PUT") {
    requirePrototypeOwner(db,id,principal);
    const body=parseWith(putVisualBaselineSchema,await readJson(request),"Visual baseline set is invalid");
    return json(repo.commit(id,body),200,noStore);
  }
  throw new ApiError(405,"method_not_allowed","Method not allowed");
}
