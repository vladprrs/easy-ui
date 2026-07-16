import type { Database } from "bun:sqlite";
import { ApiError } from "../http";
import type { DefinitionMeta } from "../components/types";
import { latestValidatedRev } from "../validationRecords";
import { parseFigmaStored } from "../figma";

const now=()=>new Date().toISOString();
// Statuses whose bundle is still executed by existing pins (K.3). rejected/archived/failed/staging do not serve.
const RENDERABLE_STATUS=new Set(["active","deprecated","superseded"]);
// Manual transition matrix (K.2). staging/failed are lifecycle-internal and cannot be set by hand.
const TRANSITIONS:Record<string,string[]>={active:["rejected","deprecated","superseded","archived"],deprecated:["archived","active"],superseded:["archived","active"],rejected:["archived"],archived:[],staging:[],failed:[]};
export type StatusChange={status:string;reason?:string;supersededBy?:number;baseStatusRev:number};
type Row={id:string;name:string;head_rev:number;design_system:string;owner_id:string;deleted_at:string|null;created_at:string;updated_at:string};
export class ComponentRepo {
  constructor(private db:Database) {}
  row(id:string,includeDeleted=false):Row { const r=this.db.query(`SELECT * FROM components WHERE id=? ${includeDeleted?"":"AND deleted_at IS NULL"}`).get(id) as Row|null; if(!r) throw new ApiError(404,"not_found","Component not found"); return r; }
  cas(id:string,baseRev:number):Row { const r=this.row(id); if(r.head_rev!==baseRev) throw new ApiError(409,"revision_conflict","Component revision has changed",{currentRev:r.head_rev}); return r; }
  create(id:string,name:string,source:string,designSystem:string,message?:string,figmaJson:string|null=null,ownerId:string|null=null) { return this.db.transaction(()=>{if(this.db.query("SELECT 1 FROM components WHERE id=? OR name=?").get(id,name)) throw new ApiError(409,"already_exists","Component id or name already exists"); const at=now(); this.db.query("INSERT INTO components (id,name,head_rev,design_system,deleted_at,created_at,updated_at,owner_id) VALUES (?,?,1,?,NULL,?,?,?)").run(id,name,designSystem,at,at,ownerId); this.db.query("INSERT INTO component_revisions (component_id,rev,source,design_system,figma_json,message,created_at) VALUES (?,1,?,?,?,?,?)").run(id,source,designSystem,figmaJson,message??null,at); return {id,rev:1 as const};})(); }
  save(id:string,source:string|undefined,designSystem:string|undefined,baseRev:number,message?:string,figmaJson:string|null=null) { return this.db.transaction(()=>{const r=this.cas(id,baseRev),head=this.source(id,r.head_rev),nextSource=source??head.source,nextSystem=designSystem??r.design_system,rev=r.head_rev+1,at=now();this.db.query("INSERT INTO component_revisions (component_id,rev,source,design_system,figma_json,message,created_at) VALUES (?,?,?,?,?,?,?)").run(id,rev,nextSource,nextSystem,figmaJson,message??null,at);this.db.query("UPDATE components SET head_rev=?,design_system=?,updated_at=? WHERE id=? AND deleted_at IS NULL").run(rev,nextSystem,at,id);return {rev};})(); }
  delete(id:string,baseRev:number) { this.db.transaction(()=>{this.cas(id,baseRev);this.db.query("UPDATE components SET deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL").run(now(),now(),id);})(); }
  list(){return (this.db.query(`SELECT c.*, (SELECT MAX(version) FROM component_publishes p WHERE p.component_id=c.id AND p.status='active') latest FROM components c WHERE deleted_at IS NULL ORDER BY updated_at DESC`).all() as (Row&{latest:number|null})[]).map(r=>({id:r.id,name:r.name,designSystem:r.design_system,headRev:r.head_rev,latestVersion:r.latest,updatedAt:r.updated_at}));}
  meta(id:string){
    const r=this.row(id); const versions=this.versions(id);
    const active=versions.filter(v=>v.status==="active");
    const publishedVersion=active.at(-1)?.version??null;
    const headActive=active.some(v=>v.rev===r.head_rev);
    return {
      id:r.id,name:r.name,designSystem:r.design_system,headRev:r.head_rev,versions,updatedAt:r.updated_at,
      draftRevision:r.head_rev,
      validatedRevision:latestValidatedRev(this.db,"component",id),
      publishedVersion,
      renderable:{head:headActive,published:publishedVersion!==null?true:null},
      figma:parseFigmaStored(this.figmaJsonForRev(id,r.head_rev)),
    };
  }
  source(id:string,rev?:number){const r=this.row(id); const n=rev??r.head_rev; const x=this.db.query("SELECT rev,source,design_system,figma_json,message,created_at FROM component_revisions WHERE component_id=? AND rev=?").get(id,n) as {rev:number;source:string;design_system:string;figma_json:string|null;message:string|null;created_at:string}|null;if(!x)throw new ApiError(404,"not_found","Component revision not found");return {rev:x.rev,source:x.source,designSystem:x.design_system,figma:parseFigmaStored(x.figma_json),message:x.message,createdAt:x.created_at};}
  private figmaJsonForRev(id:string,rev:number):string|null{return (this.db.query("SELECT figma_json FROM component_revisions WHERE component_id=? AND rev=?").get(id,rev) as {figma_json:string|null}|null)?.figma_json??null;}
  revisions(id:string){this.row(id);return (this.db.query("SELECT rev,design_system,message,created_at FROM component_revisions WHERE component_id=? ORDER BY rev DESC").all(id) as {rev:number;design_system:string;message:string|null;created_at:string}[]).map(x=>({rev:x.rev,designSystem:x.design_system,message:x.message,createdAt:x.created_at}));}
  restore(id:string,sourceRev:number,baseRev:number){const src=this.source(id,sourceRev);return this.save(id,src.source,src.designSystem,baseRev,`Restore revision ${sourceRev}`,this.figmaJsonForRev(id,sourceRev));}
  stage(id:string,baseRev:number,artifact:{compiledJs:string;bundleHash:string;sourceHash:string;meta:DefinitionMeta},message?:string){return this.db.transaction(()=>{const r=this.cas(id,baseRev);if(this.db.query("SELECT 1 FROM component_publishes WHERE component_id=? AND rev=?").get(id,r.head_rev))throw new ApiError(409,"already_published","This revision is already published",{currentRev:r.head_rev});const max=this.db.query("SELECT MAX(version) v FROM component_publishes WHERE component_id=?").get(id) as {v:number|null};const version=(max.v??0)+1;this.db.query(`INSERT INTO component_publishes (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,message,published_at) VALUES (?,?,?,'staging',?,?,?,?,1,?,?)`).run(id,version,r.head_rev,artifact.compiledJs,JSON.stringify(artifact.meta),artifact.sourceHash,artifact.bundleHash,message??null,now());return {version,rev:r.head_rev};})();}
  activate(id:string,version:number){this.db.transaction(()=>{const x=this.db.query("UPDATE component_publishes SET status='active' WHERE component_id=? AND version=? AND status='staging'").run(id,version);if(!x.changes)throw new Error("Staging publish disappeared");})();}
  pinAssets(id:string,version:number,assetIds:string[]){for(const assetId of assetIds){const exists=this.db.query("SELECT 1 ok FROM assets WHERE id=?").get(assetId);if(!exists)throw new ApiError(422,"asset_not_found","A referenced asset does not exist",{issues:[{path:["source"],message:`unknown asset: ${assetId}`}]});this.db.query("INSERT OR IGNORE INTO component_publish_assets (component_id,version,asset_id) VALUES (?,?,?)").run(id,version,assetId);}}
  assets(id:string,version:number){return this.db.query(`SELECT a.id,a.sha256,a.mime,a.size FROM component_publish_assets cpa JOIN assets a ON a.id=cpa.asset_id WHERE cpa.component_id=? AND cpa.version=? ORDER BY a.id`).all(id,version) as {id:string;sha256:string;mime:string;size:number}[];}
  fail(id:string,version:number){this.db.query("UPDATE component_publishes SET status='failed' WHERE component_id=? AND version=? AND status='staging'").run(id,version);}
  versions(id:string){this.row(id);return (this.db.query("SELECT p.version,p.rev,p.status,p.status_reason,p.superseded_by,p.status_rev,p.published_at,r.design_system FROM component_publishes p JOIN component_revisions r ON r.component_id=p.component_id AND r.rev=p.rev WHERE p.component_id=? ORDER BY p.version").all(id) as {version:number;rev:number;status:string;status_reason:string|null;superseded_by:number|null;status_rev:number;published_at:string;design_system:string}[]).map(x=>({version:x.version,rev:x.rev,status:x.status,statusReason:x.status_reason,supersededBy:x.superseded_by,statusRev:x.status_rev,designSystem:x.design_system,publishedAt:x.published_at}));}
  // Bundle bytes for a pinned version. Serves active|deprecated|superseded (K.3); other statuses 404 bundle_unavailable.
  bundle(id:string,version:number){const x=this.db.query("SELECT compiled_js js,bundle_hash hash,status,status_reason reason FROM component_publishes WHERE component_id=? AND version=?").get(id,version) as {js:string;hash:string;status:string;reason:string|null}|null;if(!x)throw new ApiError(404,"not_found","Component version not found");if(!RENDERABLE_STATUS.has(x.status))throw new ApiError(404,"bundle_unavailable",`Component version bundle is unavailable (status ${x.status}${x.reason?`: ${x.reason}`:""})`);return {js:x.js,hash:x.hash};}
  // Metadata of any version stays readable regardless of status (K.3).
  version(id:string,version:number){const x=this.db.query(`SELECT p.version,p.rev,p.status,p.status_reason,p.superseded_by,p.status_rev,p.definition_meta,p.bundle_hash,p.host_abi_version,p.published_at,r.source,r.design_system,r.figma_json FROM component_publishes p JOIN component_revisions r ON r.component_id=p.component_id AND r.rev=p.rev WHERE p.component_id=? AND p.version=?`).get(id,version) as {version:number;rev:number;status:string;status_reason:string|null;superseded_by:number|null;status_rev:number;definition_meta:string;bundle_hash:string;host_abi_version:number;published_at:string;source:string;design_system:string;figma_json:string|null}|null;if(!x)throw new ApiError(404,"not_found","Component version not found");return {version:x.version,rev:x.rev,status:x.status,statusReason:x.status_reason,supersededBy:x.superseded_by,statusRev:x.status_rev,source:x.source,designSystem:x.design_system,...JSON.parse(x.definition_meta),bundleHash:x.bundle_hash,hostAbiVersion:x.host_abi_version,assets:this.assets(id,version),figma:parseFigmaStored(x.figma_json),publishedAt:x.published_at};}
  // Manual status transition with CAS on status_rev (K.2). Returns the new {status,statusRev}.
  setStatus(id:string,version:number,change:StatusChange){return this.db.transaction(()=>{
    this.row(id);
    const cur=this.db.query("SELECT status,status_rev FROM component_publishes WHERE component_id=? AND version=?").get(id,version) as {status:string;status_rev:number}|null;
    if(!cur)throw new ApiError(404,"not_found","Component version not found");
    if(cur.status_rev!==change.baseStatusRev)throw new ApiError(409,"status_conflict","Component version status has changed",{currentStatusRev:cur.status_rev});
    const allowed=TRANSITIONS[cur.status]??[];
    if(!allowed.includes(change.status))throw new ApiError(422,"invalid_transition",`Cannot transition ${cur.status} → ${change.status}`,{issues:[{path:["status"],message:`invalid transition from ${cur.status}`}]});
    if(change.status==="rejected"&&!change.reason?.trim())throw new ApiError(422,"validation_failed","A reason is required to reject a version",{issues:[{path:["reason"],message:"reason is required for rejected"}]});
    let supersededBy:number|null=null;
    if(change.status==="superseded"){
      const target=change.supersededBy;
      if(typeof target!=="number"||!Number.isInteger(target)||target<1)throw new ApiError(422,"validation_failed","supersededBy is required to supersede a version",{issues:[{path:["supersededBy"],message:"supersededBy must reference a version"}]});
      if(target===version)throw new ApiError(422,"validation_failed","A version cannot supersede itself",{issues:[{path:["supersededBy"],message:"cannot supersede self"}]});
      if(!this.db.query("SELECT 1 ok FROM component_publishes WHERE component_id=? AND version=?").get(id,target))throw new ApiError(422,"validation_failed","supersededBy references a version that does not exist",{issues:[{path:["supersededBy"],message:`unknown version ${target}`}]});
      // Walk the superseded_by chain from the target; reaching `version` would create a cycle.
      let cursor:number|null=target; const seen=new Set<number>([version]);
      while(cursor!==null){if(seen.has(cursor))throw new ApiError(422,"validation_failed","supersededBy would create a cycle",{issues:[{path:["supersededBy"],message:"cycle detected"}]});seen.add(cursor);cursor=(this.db.query("SELECT superseded_by n FROM component_publishes WHERE component_id=? AND version=?").get(id,cursor) as {n:number|null}|null)?.n??null;}
      supersededBy=target;
    }
    const nextRev=cur.status_rev+1;
    this.db.query("UPDATE component_publishes SET status=?,status_reason=?,superseded_by=?,status_rev=? WHERE component_id=? AND version=?").run(change.status,change.reason?.trim()||null,supersededBy,nextRev,id,version);
    return {status:change.status,statusRev:nextRev};
  })();}
}

export function failStagingPublishes(db:Database){return db.query("UPDATE component_publishes SET status='failed' WHERE status='staging'").run().changes;}
