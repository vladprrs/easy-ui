import { z } from "zod";
import type { Database } from "bun:sqlite";
import { parseWith } from "../contracts";
import { ApiError, json, noStore, readJson } from "../http";
import { VisualBaselineRepo } from "../visual/baselines";
import type {Principal} from "../auth";
import {requirePrototypeOwner,requirePrototypeRead} from "../authorization";
import {assertPinnedTrack} from "../repos/prototypes";

export const baselineMemberInputSchema=z.strictObject({
  screenId:z.string().min(1),
  viewport:z.strictObject({width:z.number().int(),height:z.number().int()}),
  deviceScaleFactor:z.union([z.literal(1),z.literal(2),z.literal(3)]),
  theme:z.enum(["light","dark"]),
  assetId:z.string().min(1),
});
export const putVisualBaselineSchema=z.strictObject({
  rev:z.number().int().positive(),prototypeInstanceId:z.string().min(1),baseGeneration:z.number().int().positive().nullable(),members:z.array(baselineMemberInputSchema),
  /**
   * R6, V-N8: карта `assetId → receiptSha256` для массовой пересъёмки. Клиент указывает **адрес**
   * receipt'а (он знает его из `JobStatus.result`), а факты рендерера сервер всё равно читает из
   * своего стора — подделать происхождение кадра этим полем нельзя. Используется только как
   * фолбэк: индекс `assetId → receiptSha` авторитетнее и проверяется первым.
   */
  receipts:z.record(z.string(),z.string().regex(/^[0-9a-f]{64}$/)).optional(),
});

export async function routeVisualBaselines(request:Request,db:Database,dataDir:string,segments:string[],principal:Principal):Promise<Response|null> {
  if(segments[0]!=="visual-baselines") return null;
  if(segments.length!==3||segments[1]!=="prototypes") throw new ApiError(404,"not_found","API route not found");
  const repo=new VisualBaselineRepo(db,dataDir); const id=segments[2]!;
  if(request.method==="GET") { requirePrototypeRead(db,id,principal); return json(repo.get(id),200,noStore); }
  if(request.method==="PUT") {
    requirePrototypeOwner(db,id,principal);
    // Эталоны трекающего дока несравнимы: пины уезжают под ними без новой ревизии (P2.2).
    // Гейт стоит до разбора тела — он не зависит от его содержимого.
    assertPinnedTrack(db,id,"visual-baseline");
    const body=parseWith(putVisualBaselineSchema,await readJson(request),"Visual baseline set is invalid");
    // Рендерер каждого кадра резолвится до транзакции коммита (R6): внутри `BEGIN IMMEDIATE`
    // читать receipt'ы нечем — метод синхронный.
    const renderers=await repo.resolveRenderers(body.members,body.receipts);
    return json(repo.commit(id,body,undefined,renderers),200,noStore);
  }
  throw new ApiError(405,"method_not_allowed","Method not allowed");
}
