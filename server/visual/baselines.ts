import type { Database } from "bun:sqlite";
import { canonicalStringify } from "../../src/capture/canonicalJson";
import { ApiError } from "../http";
import { parseStoredPrototypeDoc } from "../repos/prototypes";
import { parseFingerprint, type Fingerprint } from "./fingerprint";
import { resolveReferenceRenderer, VisualRepo, type ReferenceRendererRecord } from "./repo";

export interface BaselineViewport { width:number; height:number }
export interface BaselineMemberInput { screenId:string; viewport:BaselineViewport; deviceScaleFactor:1|2|3; theme:"light"|"dark"; assetId:string }
export interface BaselineMember { screenId:string; viewport:BaselineViewport; deviceScaleFactor:1|2|3; theme:"light"|"dark"; referenceId:string }
export interface BaselineSet { generation:number; rev:number; prototypeInstanceId:string; createdAt:string; members:BaselineMember[] }
export interface BaselineCommitInput { rev:number; prototypeInstanceId:string; baseGeneration:number|null; members:BaselineMemberInput[] }

type PrototypeRow={instance_id:string};
type SetRow={generation:number;rev:number;prototype_instance_id:string;created_at:string;members_json:string};

const conflict=(error:unknown)=>error instanceof Error&&/(locked|busy|unique constraint)/i.test(error.message);

function viewport(value:BaselineViewport,dsf:number):void {
  if(!Number.isInteger(value.width)||value.width<64||value.width>2000) throw new ApiError(422,"invalid_viewport","viewport.width must be an integer in [64, 2000]");
  if(!Number.isInteger(value.height)||value.height<64||value.height>4000) throw new ApiError(422,"invalid_viewport","viewport.height must be an integer in [64, 4000]");
  if(!Number.isInteger(dsf)||![1,2,3].includes(dsf)) throw new ApiError(422,"invalid_viewport","deviceScaleFactor must be 1, 2, or 3");
  if(value.width*value.height*dsf*dsf>20_000_000) throw new ApiError(422,"invalid_viewport","width × height × dsf² must not exceed 20 megapixels");
}

function normalized(members:BaselineMember[]):BaselineMember[] {
  return [...members].sort((a,b)=>canonicalStringify({screenId:a.screenId,viewport:a.viewport,deviceScaleFactor:a.deviceScaleFactor,theme:a.theme})
    .localeCompare(canonicalStringify({screenId:b.screenId,viewport:b.viewport,deviceScaleFactor:b.deviceScaleFactor,theme:b.theme})));
}

export class VisualBaselineRepo {
  constructor(private readonly db:Database,private readonly dataDir:string) {}

  get(prototypeId:string):BaselineSet {
    const proto=this.db.query("SELECT instance_id FROM prototypes WHERE id=?").get(prototypeId) as PrototypeRow|null;
    if(!proto) throw new ApiError(404,"prototype_not_found","Prototype not found");
    const row=this.db.query("SELECT generation,rev,prototype_instance_id,created_at,members_json FROM visual_baseline_sets WHERE prototype_id=? ORDER BY generation DESC LIMIT 1").get(prototypeId) as SetRow|null;
    if(!row) throw new ApiError(404,"baseline_not_found","Visual baseline set not found");
    return {generation:row.generation,rev:row.rev,prototypeInstanceId:row.prototype_instance_id,createdAt:row.created_at,members:JSON.parse(row.members_json) as BaselineMember[]};
  }

  /**
   * Резолв рендерера для каждого кадра набора — **до** транзакции (R6).
   *
   * Почему отдельным шагом, а не внутри `commit`: чтение receipt'а — файловый ввод-вывод, а
   * коммит набора живёт в синхронном `BEGIN IMMEDIATE`, где `await` невозможен. Порядок
   * «сначала резолв, потом транзакция» заодно означает, что медленный диск не держит write-lock.
   *
   * `receiptSha256` (опционально, по assetId) — фолбэк массовой пересъёмки (V-N8): скрипт знает
   * адрес receipt'а из результата джобы и не зависит от свежести индекса `assetId → receiptSha`.
   */
  async resolveRenderers(members:BaselineMemberInput[],receipts?:Record<string,string>):Promise<Map<string,ReferenceRendererRecord|null>> {
    const resolved=new Map<string,ReferenceRendererRecord|null>();
    for(const member of members) {
      if(resolved.has(member.assetId)) continue;
      resolved.set(member.assetId,await resolveReferenceRenderer(this.dataDir,member.assetId,receipts?.[member.assetId]??null));
    }
    return resolved;
  }

  commit(prototypeId:string,input:BaselineCommitInput,hook?:()=>void,renderers?:ReadonlyMap<string,ReferenceRendererRecord|null>):Omit<BaselineSet,"prototypeInstanceId"|"createdAt"> {
    let began=false;
    try {
      this.db.run("BEGIN IMMEDIATE"); began=true;
      const proto=this.db.query("SELECT instance_id FROM prototypes WHERE id=?").get(prototypeId) as PrototypeRow|null;
      if(!proto) throw new ApiError(404,"prototype_not_found","Prototype not found");
      if(proto.instance_id!==input.prototypeInstanceId) throw new ApiError(409,"instance_conflict","Prototype instance has changed");
      const current=this.db.query("SELECT generation,members_json FROM visual_baseline_sets WHERE prototype_id=? ORDER BY generation DESC LIMIT 1").get(prototypeId) as {generation:number;members_json:string}|null;
      const currentGeneration=current?.generation??null;
      if(input.baseGeneration!==currentGeneration) throw new ApiError(409,"generation_conflict","Visual baseline generation has changed",{currentGeneration});
      const revision=this.db.query("SELECT doc FROM prototype_revisions WHERE prototype_id=? AND rev=?").get(prototypeId,input.rev) as {doc:string}|null;
      if(!revision) throw new ApiError(404,"revision_not_found","Prototype revision not found");
      const doc=parseStoredPrototypeDoc(revision.doc,prototypeId,input.rev);
      const screens=new Set(doc.screens.map((screen)=>screen.id));
      const supplied=new Set(input.members.map((member)=>member.screenId));
      if(input.members.length!==screens.size||supplied.size!==input.members.length||[...supplied].some((id)=>!screens.has(id))||[...screens].some((id)=>!supplied.has(id))) {
        throw new ApiError(422,"incomplete_baseline","Baseline members must cover every revision screen exactly once");
      }
      const visual=new VisualRepo(this.db,this.dataDir);
      for(const member of input.members) {
        viewport(member.viewport,member.deviceScaleFactor);
        const asset=visual.assetRepo().get(member.assetId);
        if(!asset) throw new ApiError(422,"asset_not_found","Baseline asset does not exist");
        if(asset.mime!=="image/png") throw new ApiError(422,"invalid_reference_asset","Baseline asset must be a PNG");
      }
      const tombstone=this.db.query("UPDATE visual_references SET deleted_at=? WHERE id=? AND deleted_at IS NULL");
      const at=new Date().toISOString();
      if(current) for(const member of JSON.parse(current.members_json) as BaselineMember[]) tombstone.run(at,member.referenceId);
      hook?.();
      const members=normalized(input.members.map((member)=>{
        const fp=parseFingerprint({scope:"prototype-screen",prototypeId,prototypeInstanceId:proto.instance_id,screenId:member.screenId,refRevision:input.rev,viewport:member.viewport,deviceScaleFactor:member.deviceScaleFactor,theme:member.theme} satisfies Fingerprint);
        const row=visual.upsertReferencePrivileged(fp,member.assetId,null,renderers?.get(member.assetId)??null);
        return {screenId:member.screenId,viewport:member.viewport,deviceScaleFactor:member.deviceScaleFactor,theme:member.theme,referenceId:row.id};
      }));
      const generation=(currentGeneration??0)+1;
      this.db.query("INSERT INTO visual_baseline_sets (id,prototype_id,prototype_instance_id,generation,rev,members_json,created_at) VALUES (?,?,?,?,?,?,?)")
        .run(`vbset_${crypto.randomUUID()}`,prototypeId,proto.instance_id,generation,input.rev,JSON.stringify(members),at);
      this.db.run("COMMIT"); began=false;
      return {generation,rev:input.rev,members};
    } catch(error) {
      if(began) this.db.run("ROLLBACK");
      if(conflict(error)) throw new ApiError(409,"generation_conflict","Concurrent baseline commit conflict");
      throw error;
    }
  }
}
