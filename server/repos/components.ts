import type { Database } from "bun:sqlite";
import { ApiError } from "../http";
import type { DefinitionMeta } from "../components/types";
import { latestValidatedRev } from "../validationRecords";
import { recordProvenance, resolveProvenance, resolveProvenanceRaw } from "../figma";

const now=()=>new Date().toISOString();
// Statuses whose bundle is still executed by existing pins (K.3). rejected/archived/failed/staging do not serve.
const RENDERABLE_STATUS=new Set(["active","deprecated","superseded"]);
// Manual transition matrix (K.2). staging/failed are lifecycle-internal and cannot be set by hand.
const TRANSITIONS:Record<string,string[]>={active:["rejected","deprecated","superseded","archived"],deprecated:["archived","active"],superseded:["archived","active"],rejected:["archived"],archived:[],staging:[],failed:[]};
export type StatusChange={status:string;reason?:string;supersededBy?:number;baseStatusRev:number};
type Row={id:string;name:string;head_rev:number;design_system:string;owner_id:string;deleted_at:string|null;delete_reason:string|null;replacement_component_id:string|null;created_at:string;updated_at:string};
/** Надгробие мягко удалённого компонента (волна 3 §3.2). Отдаётся только под `?includeDeleted=1`. */
export type ComponentTombstone={deleted:true;deletedAt:string;reason:string|null;replacement:string|null};
export class ComponentRepo {
  constructor(private db:Database) {}
  row(id:string,includeDeleted=false):Row { const r=this.db.query(`SELECT * FROM components WHERE id=? ${includeDeleted?"":"AND deleted_at IS NULL"}`).get(id) as Row|null; if(!r) throw new ApiError(404,"not_found","Component not found"); return r; }
  cas(id:string,baseRev:number):Row { const r=this.row(id); if(r.head_rev!==baseRev) throw new ApiError(409,"revision_conflict","Component revision has changed",{currentRev:r.head_rev}); return r; }
  create(id:string,name:string,source:string,designSystem:string,message?:string,figmaJson:string|null=null,ownerId:string|null=null) { return this.db.transaction(()=>{if(this.db.query("SELECT 1 FROM components WHERE id=? OR name=?").get(id,name)) throw new ApiError(409,"already_exists","Component id or name already exists"); const at=now(); this.db.query("INSERT INTO components (id,name,head_rev,design_system,deleted_at,created_at,updated_at,owner_id) VALUES (?,?,1,?,NULL,?,?,?)").run(id,name,designSystem,at,at,ownerId); this.db.query("INSERT INTO component_revisions (component_id,rev,source,design_system,figma_json,message,created_at) VALUES (?,1,?,?,?,?,?)").run(id,source,designSystem,figmaJson,message??null,at);
    // Правило B1 (RFC §6, триаж раунд3-BL-1): create с переданным `figma` — тоже write-путь
    // provenance. Без seq-строки первый же source-PUT без `figma` обнулил бы её: резолвер
    // провалился бы на пустую колонку новой ревизии. `baselineRev: 0` — «предыдущей правды» у
    // rev 1 нет, поэтому дедуп ничего не подавляет. Всё внутри той же транзакции (раунд3-m-2).
    if(figmaJson!==null) recordProvenance(this.db,{componentId:id,rev:1,figmaJson,author:ownerId,baselineRev:0});
    return {id,rev:1 as const};})(); }
  /**
   * `provenance` присутствует ⟺ вызывающий получил поле `figma` (в т.ч. `figma: null` —
   * явная очистка). Значение seq-строки — тот же `figmaJson`, что уходит в колонку ревизии:
   * колонка остаётся фолбэком резолвера для исторических ревизий (RFC §6).
   */
  save(id:string,source:string|undefined,designSystem:string|undefined,baseRev:number,message?:string,figmaJson:string|null=null,provenance?:{author:string|null}) { return this.db.transaction(()=>{const r=this.cas(id,baseRev),head=this.source(id,r.head_rev),nextSource=source??head.source,nextSystem=designSystem??r.design_system,rev=r.head_rev+1,at=now();this.db.query("INSERT INTO component_revisions (component_id,rev,source,design_system,figma_json,message,created_at) VALUES (?,?,?,?,?,?,?)").run(id,rev,nextSource,nextSystem,figmaJson,message??null,at);this.db.query("UPDATE components SET head_rev=?,design_system=?,updated_at=? WHERE id=? AND deleted_at IS NULL").run(rev,nextSystem,at,id);
    // Дедуп считается относительно **предыдущей** головы: колонка только что созданной ревизии
    // ещё не «предыдущая правда», и сравнение с ней подавило бы нужную запись у компонентов без
    // seq-истории (правило B1/m-1).
    if(provenance!==undefined) recordProvenance(this.db,{componentId:id,rev,figmaJson,author:provenance.author,baselineRev:r.head_rev});
    return {rev};})(); }
  delete(id:string,baseRev:number,tombstone:{reason?:string;replacement?:string}={}) { this.db.transaction(()=>{this.cas(id,baseRev);const at=now();this.db.query("UPDATE components SET deleted_at=?,delete_reason=?,replacement_component_id=?,updated_at=? WHERE id=? AND deleted_at IS NULL").run(at,tombstone.reason?.trim()||null,tombstone.replacement??null,at,id);})(); }
  /** Надгробие или null для живого компонента. */
  tombstone(id:string):ComponentTombstone|null { const r=this.row(id,true); return r.deleted_at===null?null:{deleted:true,deletedAt:r.deleted_at,reason:r.delete_reason,replacement:r.replacement_component_id}; }
  list(includeDeleted=false){return (this.db.query(`SELECT c.*, (SELECT MAX(version) FROM component_publishes p WHERE p.component_id=c.id AND p.status='active') latest FROM components c ${includeDeleted?"":"WHERE deleted_at IS NULL"} ORDER BY updated_at DESC`).all() as (Row&{latest:number|null})[]).map(r=>({id:r.id,name:r.name,designSystem:r.design_system,headRev:r.head_rev,latestVersion:r.latest,updatedAt:r.updated_at,...(r.deleted_at===null?{}:{deleted:true as const,deletedAt:r.deleted_at,reason:r.delete_reason,replacement:r.replacement_component_id})}));}
  meta(id:string,includeDeleted=false){
    const r=this.row(id,includeDeleted); const versions=this.versions(id,includeDeleted);
    const active=versions.filter(v=>v.status==="active");
    const publishedVersion=active.at(-1)?.version??null;
    const headActive=active.some(v=>v.rev===r.head_rev);
    return {
      id:r.id,name:r.name,designSystem:r.design_system,headRev:r.head_rev,versions,updatedAt:r.updated_at,
      draftRevision:r.head_rev,
      validatedRevision:latestValidatedRev(this.db,"component",id),
      publishedVersion,
      renderable:{head:headActive,published:publishedVersion!==null?true:null},
      figma:resolveProvenance(this.db,id,r.head_rev),
      // Надгробие приезжает только при includeDeleted (иначе row() уже бросил 404).
      ...(r.deleted_at===null?{}:{deleted:true as const,deletedAt:r.deleted_at,reason:r.delete_reason,replacement:r.replacement_component_id}),
    };
  }
  source(id:string,rev?:number){const r=this.row(id); const n=rev??r.head_rev; const x=this.db.query("SELECT rev,source,design_system,message,created_at FROM component_revisions WHERE component_id=? AND rev=?").get(id,n) as {rev:number;source:string;design_system:string;message:string|null;created_at:string}|null;if(!x)throw new ApiError(404,"not_found","Component revision not found");return {rev:x.rev,source:x.source,designSystem:x.design_system,figma:resolveProvenance(this.db,id,x.rev),message:x.message,createdAt:x.created_at};}
  revisions(id:string){this.row(id);return (this.db.query("SELECT rev,design_system,message,created_at FROM component_revisions WHERE component_id=? ORDER BY rev DESC").all(id) as {rev:number;design_system:string;message:string|null;created_at:string}[]).map(x=>({rev:x.rev,designSystem:x.design_system,message:x.message,createdAt:x.created_at}));}
  /**
   * Restore пишет **резолвнутое** provenance исходной ревизии в обе стороны — и в колонку новой
   * ревизии, и seq-строкой (триаж раунд2-M2/раунд3-m-3). Простой перенос колонки не работает:
   * seq-записи более поздних ревизий старше по `(rev, seq)` и затенили бы восстановленное, а
   * запись только в seq развела бы колонку и API. Tombstone (`null`) переносится наравне со
   * значением — иначе восстановление «пустого» состояния было бы невыразимо.
   */
  restore(id:string,sourceRev:number,baseRev:number,actorId:string|null=null){const src=this.source(id,sourceRev);const raw=resolveProvenanceRaw(this.db,id,sourceRev);return this.save(id,src.source,src.designSystem,baseRev,`Restore revision ${sourceRev}`,raw,{author:actorId});}
  /**
   * Ставит новую версию в `staging`.
   *
   * `already_published` проверяется по строкам ревизии **вне статуса `failed`** (RFC
   * candidate-acceptance §4.3.2, находка V1): крах саги оставляет `failed`-строку
   * (компенсация `fail()`/`failStagingPublishes`), и проверка «есть любая строка» навсегда
   * блокировала бы ревизию — ни publish, ни promote после сбоя уже не проходили.
   *
   * Отступление от буквы RFC: там re-stage «берёт следующий свободный номер версии, дырки в
   * нумерации допустимы». Схема этого не разрешает — у `component_publishes` есть
   * `UNIQUE (component_id, rev)` (миграция v8), а R1 по решению V3 идёт **без миграций**.
   * Поэтому повтор переписывает саму `failed`-строку: номер версии сохраняется, дырки не
   * возникает. Публичного состояния это не трогает — `failed` не отдаётся ни каталогом, ни
   * бандл-роутом, и FK-детей у него быть не может (пины ставятся только на active-версии;
   * если пин всё же есть, RESTRICT поднимет ошибку, а не испортит данные молча).
   *
   * `hostAbiVersion` приходит от вызывающего (по умолчанию 1): promote переиспользует ABI
   * кандидата, publish — свой compile-результат.
   */
  stage(id:string,baseRev:number,artifact:{compiledJs:string;bundleHash:string;sourceHash:string;meta:DefinitionMeta;hostAbiVersion?:number},message?:string){return this.db.transaction(()=>{
    const r=this.cas(id,baseRev);
    const existing=this.db.query("SELECT version,status FROM component_publishes WHERE component_id=? AND rev=?").get(id,r.head_rev) as {version:number;status:string}|null;
    if(existing&&existing.status!=="failed")throw new ApiError(409,"already_published","This revision is already published",{currentRev:r.head_rev});
    const meta=JSON.stringify(artifact.meta),at=now(),abi=artifact.hostAbiVersion??1;
    if(existing){this.db.query("UPDATE component_publishes SET status='staging',status_reason=NULL,superseded_by=NULL,compiled_js=?,definition_meta=?,source_hash=?,bundle_hash=?,host_abi_version=?,message=?,published_at=? WHERE component_id=? AND version=?").run(artifact.compiledJs,meta,artifact.sourceHash,artifact.bundleHash,abi,message??null,at,id,existing.version);return {version:existing.version,rev:r.head_rev};}
    const max=this.db.query("SELECT MAX(version) v FROM component_publishes WHERE component_id=?").get(id) as {v:number|null};const version=(max.v??0)+1;
    this.db.query(`INSERT INTO component_publishes (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,message,published_at) VALUES (?,?,?,'staging',?,?,?,?,?,?,?)`).run(id,version,r.head_rev,artifact.compiledJs,meta,artifact.sourceHash,artifact.bundleHash,abi,message??null,at);
    return {version,rev:r.head_rev};})();}
  /** Прочие active-версии компонента (кроме `exclude`) со свежим `status_rev` — вход auto-supersede. */
  otherActiveVersions(id:string,exclude:number){return this.db.query("SELECT version,status_rev statusRev FROM component_publishes WHERE component_id=? AND status='active' AND version<>? ORDER BY version").all(id,exclude) as {version:number;statusRev:number}[];}
  activate(id:string,version:number){this.db.transaction(()=>{const x=this.db.query("UPDATE component_publishes SET status='active' WHERE component_id=? AND version=? AND status='staging'").run(id,version);if(!x.changes)throw new Error("Staging publish disappeared");})();}
  pinAssets(id:string,version:number,assetIds:string[]){for(const assetId of assetIds){const exists=this.db.query("SELECT 1 ok FROM assets WHERE id=?").get(assetId);if(!exists)throw new ApiError(422,"asset_not_found","A referenced asset does not exist",{issues:[{path:["source"],message:`unknown asset: ${assetId}`}]});this.db.query("INSERT OR IGNORE INTO component_publish_assets (component_id,version,asset_id) VALUES (?,?,?)").run(id,version,assetId);}}
  assets(id:string,version:number){return this.db.query(`SELECT a.id,a.sha256,a.mime,a.size FROM component_publish_assets cpa JOIN assets a ON a.id=cpa.asset_id WHERE cpa.component_id=? AND cpa.version=? ORDER BY a.id`).all(id,version) as {id:string;sha256:string;mime:string;size:number}[];}
  fail(id:string,version:number){this.db.query("UPDATE component_publishes SET status='failed' WHERE component_id=? AND version=? AND status='staging'").run(id,version);}
  versions(id:string,includeDeleted=false){this.row(id,includeDeleted);return (this.db.query("SELECT p.version,p.rev,p.status,p.status_reason,p.superseded_by,p.status_rev,p.published_at,r.design_system FROM component_publishes p JOIN component_revisions r ON r.component_id=p.component_id AND r.rev=p.rev WHERE p.component_id=? ORDER BY p.version").all(id) as {version:number;rev:number;status:string;status_reason:string|null;superseded_by:number|null;status_rev:number;published_at:string;design_system:string}[]).map(x=>({version:x.version,rev:x.rev,status:x.status,statusReason:x.status_reason,supersededBy:x.superseded_by,statusRev:x.status_rev,designSystem:x.design_system,publishedAt:x.published_at}));}
  // Bundle bytes for a pinned version. Serves active|deprecated|superseded (K.3); other statuses 404 bundle_unavailable.
  bundle(id:string,version:number){const x=this.db.query("SELECT compiled_js js,bundle_hash hash,status,status_reason reason FROM component_publishes WHERE component_id=? AND version=?").get(id,version) as {js:string;hash:string;status:string;reason:string|null}|null;if(!x)throw new ApiError(404,"not_found","Component version not found");if(!RENDERABLE_STATUS.has(x.status))throw new ApiError(404,"bundle_unavailable",`Component version bundle is unavailable (status ${x.status}${x.reason?`: ${x.reason}`:""})`);return {js:x.js,hash:x.hash};}
  // Metadata of any version stays readable regardless of status (K.3).
  // `figma` версии резолвится по её ревизии и потому **мутабельна** (RFC §6): иммутабельна
  // только байтовая часть версии — `compiled_js`/`bundle_hash`/`definition_meta`.
  version(id:string,version:number){const x=this.db.query(`SELECT p.version,p.rev,p.status,p.status_reason,p.superseded_by,p.status_rev,p.definition_meta,p.bundle_hash,p.host_abi_version,p.published_at,r.source,r.design_system FROM component_publishes p JOIN component_revisions r ON r.component_id=p.component_id AND r.rev=p.rev WHERE p.component_id=? AND p.version=?`).get(id,version) as {version:number;rev:number;status:string;status_reason:string|null;superseded_by:number|null;status_rev:number;definition_meta:string;bundle_hash:string;host_abi_version:number;published_at:string;source:string;design_system:string}|null;if(!x)throw new ApiError(404,"not_found","Component version not found");return {version:x.version,rev:x.rev,status:x.status,statusReason:x.status_reason,supersededBy:x.superseded_by,statusRev:x.status_rev,source:x.source,designSystem:x.design_system,...JSON.parse(x.definition_meta),bundleHash:x.bundle_hash,hostAbiVersion:x.host_abi_version,assets:this.assets(id,version),figma:resolveProvenance(this.db,id,x.rev),publishedAt:x.published_at};}
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
