import type { Database } from "bun:sqlite";
import type { PrototypeDoc } from "../../src/prototype/schema";
import { storedPrototypeDocSchema } from "../../src/prototype/schema";
import { builtinCatalogHashFor, emptyComponentManifestHash } from "../builtinHash";
import { getDesignSystemVersion, latestDesignSystemMetaVersion, requireActiveDesignSystem } from "../designSystems";
import { resolveSpacingScale } from "../../src/designSystems/spacingScale";
import { ApiError } from "../http";
import type { ComponentPin } from "../validation";
import { latestValidatedRev } from "../validationRecords";
import { parseFigmaStored } from "../figma";
import { hostPrimitiveNames } from "../../src/catalog/hostPrimitives/definitions";
import type { Principal } from "../auth";
import { prototypeAccess, requirePrototypeRead } from "../authorization";
import { classifyRevision, type RevisionClassification } from "../classify";

type Pin = { id: string; name: string; version: number; bundleUrl: string; bundleHash: string };
export type ResolvedPin = Pin & { status: string };
export type BundleReadiness = { resolvedPins: ResolvedPin[]; bundles: boolean; bundleStatus: "ready" | "failed"; warnings: { code: string; message: string }[]; errors: { code: string; message: string }[] };
// Statuses that still render (K adds deprecated/superseded later; tolerated ahead of that migration).
const RENDERABLE_PIN_STATUS = new Set(["active", "deprecated", "superseded"]);
type PrototypeRow = { id:string; name:string; description:string|null; device:string; screen_count:number; head_rev:number; design_system:string; instance_id:string; created_at:string; updated_at:string; owner_id:string; status:"private"|"published"|"archived" };
type RevisionRow = { rev:number; doc:string; builtin_catalog_hash:string; design_system_meta_version:number|null; figma_json:string|null; message:string|null; created_at:string };

const now = () => new Date().toISOString();
const missing = () => new ApiError(404, "prototype_not_found", "Prototype not found");
export const parseStoredPrototypeDoc = (json:string,id:string,rev:number):PrototypeDoc => {
  try { return storedPrototypeDocSchema.parse(JSON.parse(json)); }
  catch { throw new ApiError(422,"invalid_stored_revision",`Stored prototype revision is invalid: ${id} rev ${rev}`); }
};

export class PrototypeRepo {
  constructor(private db: Database) {}

  private row(id: string): PrototypeRow {
    const row = this.db.query("SELECT * FROM prototypes WHERE id = ?").get(id) as PrototypeRow | null;
    if (!row) throw missing(); return row;
  }
  private cas(id: string, baseRev: number): PrototypeRow {
    const row = this.row(id);
    if (row.head_rev !== baseRev) throw new ApiError(409, "revision_conflict", "Prototype revision has changed", { currentRev: row.head_rev });
    return row;
  }
  private pins(id: string, rev: number): Pin[] {
    const rows = this.db.query(`SELECT c.id, c.name, prc.component_version version, cp.bundle_hash bundleHash
      FROM prototype_revision_components prc JOIN components c ON c.id=prc.component_id
      JOIN component_publishes cp ON cp.component_id=prc.component_id AND cp.version=prc.component_version
      WHERE prc.prototype_id=? AND prc.rev=? ORDER BY c.id`).all(id, rev) as Omit<Pin,"bundleUrl">[];
    return rows.map(p => ({ ...p, bundleUrl: `/api/components/${encodeURIComponent(p.id)}/versions/${p.version}/bundle.js` }));
  }
  private bundleReadiness(id: string, rev: number): BundleReadiness {
    const rows = this.db.query(`SELECT c.id, c.name, prc.component_version version, cp.bundle_hash bundleHash, cp.status
      FROM prototype_revision_components prc JOIN components c ON c.id=prc.component_id
      JOIN component_publishes cp ON cp.component_id=prc.component_id AND cp.version=prc.component_version
      WHERE prc.prototype_id=? AND prc.rev=? ORDER BY c.id`).all(id, rev) as { id: string; name: string; version: number; bundleHash: string; status: string }[];
    const resolvedPins: ResolvedPin[] = rows.map((p) => ({ id: p.id, name: p.name, version: p.version, bundleHash: p.bundleHash, status: p.status, bundleUrl: `/api/components/${encodeURIComponent(p.id)}/versions/${p.version}/bundle.js` }));
    const warnings: { code: string; message: string }[] = [];
    const errors: { code: string; message: string }[] = [];
    for (const pin of resolvedPins) {
      if (!RENDERABLE_PIN_STATUS.has(pin.status)) errors.push({ code: "bundle_failed", message: `Pinned component ${pin.name} v${pin.version} is not renderable (status ${pin.status})` });
      else if (pin.status === "deprecated") warnings.push({ code: "pin_deprecated", message: `Pinned component ${pin.name} v${pin.version} is deprecated` });
      else if (pin.status === "superseded") warnings.push({ code: "pin_superseded", message: `Pinned component ${pin.name} v${pin.version} is superseded` });
    }
    const bundles = errors.length === 0;
    return { resolvedPins, bundles, bundleStatus: bundles ? "ready" : "failed", warnings, errors };
  }
  // Whole-revision renderability (document present + bundles ready); no external route probe.
  classifyRevision(id:string,rev:number):RevisionClassification { return classifyRevision(this.db,id,rev); }
  renderableForRev(id: string, rev: number): boolean { return this.classifyRevision(id,rev).renderable; }
  // Per-screen readiness for the render-status endpoint. Throws typed 404s for missing targets.
  screenRenderStatus(id: string, screenId: string, selector: { rev?: number; version?: number }): BundleReadiness & { rev: number; version: number | null; document: boolean; publishedVersion: number | null } {
    const proto = this.db.query("SELECT head_rev FROM prototypes WHERE id=?").get(id) as { head_rev: number } | null;
    if (!proto) throw new ApiError(404, "prototype_not_found", "Prototype not found");
    let rev: number, version: number | null = null;
    if (selector.version !== undefined) {
      const pub = this.db.query("SELECT rev FROM prototype_publishes WHERE prototype_id=? AND version=?").get(id, selector.version) as { rev: number } | null;
      if (!pub) throw new ApiError(404, "version_not_found", "Prototype version not found");
      rev = pub.rev; version = selector.version;
    } else if (selector.rev !== undefined) {
      const row = this.db.query("SELECT 1 ok FROM prototype_revisions WHERE prototype_id=? AND rev=?").get(id, selector.rev);
      if (!row) throw new ApiError(404, "revision_not_found", "Prototype revision not found");
      rev = selector.rev;
    } else rev = proto.head_rev;
    const docRow = this.db.query("SELECT doc FROM prototype_revisions WHERE prototype_id=? AND rev=?").get(id, rev) as { doc: string };
    const doc = parseStoredPrototypeDoc(docRow.doc, id, rev);
    const document = doc.screens.some((screen) => screen.id === screenId);
    if (!document) throw new ApiError(404, "screen_not_found", "Screen not found");
    const publishedVersion = (this.db.query("SELECT MAX(version) version FROM prototype_publishes WHERE prototype_id=?").get(id) as { version: number | null }).version;
    const readiness=this.bundleReadiness(id,rev);
    const classification=this.classifyRevision(id,rev);
    if(!classification.renderable) readiness.errors.push({code:classification.error.code,message:classification.error.message});
    if(!classification.renderable) { readiness.bundles=false; readiness.bundleStatus="failed"; }
    return { rev, version, document, publishedVersion, ...readiness };
  }
  private manifestHash(pins: Pin[]): string {
    if (!pins.length) return emptyComponentManifestHash;
    const stable = pins.map(({id,version,bundleHash}) => ({id,version,bundleHash}));
    return new Bun.CryptoHasher("sha256").update(JSON.stringify(stable)).digest("hex");
  }
  // Pins the latest design-system theme version onto the revision (diagnostic, like builtinCatalogHash).
  // `metaVersion` is undefined for fresh saves (resolve latest now) and explicit for restore (copy source pin).
  private insertRevision(id:string, rev:number, doc:PrototypeDoc, message:string|null, createdAt:string, metaVersion?:number|null, figmaJson:string|null=null): void {
    const pin=metaVersion===undefined?latestDesignSystemMetaVersion(this.db,doc.designSystem):metaVersion;
    const system=requireActiveDesignSystem(this.db,doc.designSystem,["designSystem"]);
    const pinnedTheme=pin===null?null:getDesignSystemVersion(this.db,doc.designSystem,pin);
    if(pin!==null&&!pinnedTheme) throw new ApiError(422,"validation_failed","Pinned design-system theme version does not exist",{issues:[{path:["designSystem"],message:`Unknown theme version ${pin} for ${doc.designSystem}`}]});
    const resolvedSpaceScale=resolveSpacingScale(doc.designSystem,pinnedTheme?.tokens??{});
    this.db.query(`INSERT INTO prototype_revisions
      (prototype_id,rev,doc,builtin_catalog_hash,design_system_meta_version,figma_json,message,created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id,rev,JSON.stringify(doc),builtinCatalogHashFor(doc.designSystem,system.definitions,resolvedSpaceScale),pin,figmaJson,message,createdAt);
  }
  private insertPins(id:string,rev:number,pins:ComponentPin[]):void {
    for(const pin of pins) {
      const alive=this.db.query("SELECT 1 ok FROM components WHERE id=? AND deleted_at IS NULL").get(pin.id);
      if(!alive) throw new ApiError(409,"component_changed","A component was deleted while saving");
      this.db.query("INSERT INTO prototype_revision_components (prototype_id,rev,component_id,component_version) VALUES (?,?,?,?)").run(id,rev,pin.id,pin.version);
    }
  }
  private insertAssetPins(id:string,rev:number,assetIds:string[]):void {
    for(const assetId of assetIds) {
      const exists=this.db.query("SELECT 1 ok FROM assets WHERE id=?").get(assetId);
      if(!exists) throw new ApiError(422,"asset_not_found","A referenced asset does not exist",{issues:[{path:["screens"],message:`unknown asset: ${assetId}`}]});
      this.db.query("INSERT OR IGNORE INTO prototype_revision_assets (prototype_id,rev,asset_id) VALUES (?,?,?)").run(id,rev,assetId);
    }
  }
  private assets(id:string,rev:number) {
    return this.db.query(`SELECT a.id,a.sha256,a.mime,a.size FROM prototype_revision_assets pra
      JOIN assets a ON a.id=pra.asset_id WHERE pra.prototype_id=? AND pra.rev=? ORDER BY a.id`).all(id,rev) as {id:string;sha256:string;mime:string;size:number}[];
  }
  create(doc: PrototypeDoc, message?: string,pins:ComponentPin[]=[],assetIds:string[]=[],figmaJson:string|null=null,ownerId:string|null=null): {id:string;rev:1} {
    return this.db.transaction(() => {
      if (this.db.query("SELECT 1 ok FROM prototypes WHERE id=?").get(doc.id)) throw new ApiError(409,"already_exists","Prototype already exists");
      const at=now();
      this.db.query(`INSERT INTO prototypes (id,name,description,device,screen_count,head_rev,design_system,instance_id,created_at,updated_at,owner_id)
        VALUES (?,?,?,?,?,1,?,?,?,?,?)`).run(doc.id,doc.name,doc.description??null,doc.device,doc.screens.length,doc.designSystem,crypto.randomUUID(),at,at,ownerId);
      this.insertRevision(doc.id,1,doc,message??null,at,undefined,figmaJson);
      this.insertPins(doc.id,1,pins);
      this.insertAssetPins(doc.id,1,assetIds);
      return {id:doc.id,rev:1 as const};
    })();
  }
  save(id:string, doc:PrototypeDoc, baseRev:number, message?:string,pins:ComponentPin[]=[],assetIds:string[]=[],figmaJson:string|null=null): {rev:number} {
    return this.db.transaction(() => {
      const head=this.cas(id,baseRev); const rev=head.head_rev+1; const at=now();
      this.insertRevision(id,rev,doc,message??null,at,undefined,figmaJson);
      this.insertPins(id,rev,pins);
      this.insertAssetPins(id,rev,assetIds);
      this.db.query(`UPDATE prototypes SET name=?,description=?,device=?,screen_count=?,head_rev=?,design_system=?,updated_at=? WHERE id=?`)
        .run(doc.name,doc.description??null,doc.device,doc.screens.length,rev,doc.designSystem,at,id);
      return {rev};
    })();
  }
  restore(id:string, sourceRev:number, baseRev:number): {rev:number} {
    return this.db.transaction(() => {
      const head=this.cas(id,baseRev);
      const source=this.db.query("SELECT doc,design_system_meta_version,figma_json FROM prototype_revisions WHERE prototype_id=? AND rev=?").get(id,sourceRev) as {doc:string;design_system_meta_version:number|null;figma_json:string|null}|null;
      if (!source) throw new ApiError(404,"revision_not_found","Prototype revision not found");
      const doc=parseStoredPrototypeDoc(source.doc,id,sourceRev); const rev=head.head_rev+1; const at=now();
      const mismatched=this.db.query(`SELECT c.name FROM prototype_revision_components prc
        JOIN components c ON c.id=prc.component_id
        JOIN component_publishes cp ON cp.component_id=prc.component_id AND cp.version=prc.component_version
        JOIN component_revisions cr ON cr.component_id=cp.component_id AND cr.rev=cp.rev
        WHERE prc.prototype_id=? AND prc.rev=? AND cr.design_system<>? LIMIT 1`).get(id,sourceRev,doc.designSystem) as {name:string}|null;
      if(mismatched) throw new ApiError(422,"validation_failed","Prototype document is invalid",{issues:[{path:["screens"],message:`Component pin belongs to a different design system: ${mismatched.name}`}]});
      this.insertRevision(id,rev,doc,`Restore revision ${sourceRev}`,at,source.design_system_meta_version,source.figma_json);
      this.db.query(`INSERT INTO prototype_revision_components (prototype_id,rev,component_id,component_version)
        SELECT prototype_id,?,component_id,component_version FROM prototype_revision_components WHERE prototype_id=? AND rev=?`).run(rev,id,sourceRev);
      this.db.query(`INSERT INTO prototype_revision_assets (prototype_id,rev,asset_id)
        SELECT prototype_id,?,asset_id FROM prototype_revision_assets WHERE prototype_id=? AND rev=?`).run(rev,id,sourceRev);
      this.db.query(`UPDATE prototypes SET name=?,description=?,device=?,screen_count=?,head_rev=?,design_system=?,updated_at=? WHERE id=?`)
        .run(doc.name,doc.description??null,doc.device,doc.screens.length,rev,doc.designSystem,at,id);
      return {rev};
    })();
  }
  publish(id:string,baseRev:number,message?:string): {version:number;rev:number} {
    return this.db.transaction(() => {
      const head=this.cas(id,baseRev);
      const doc=parseStoredPrototypeDoc((this.db.query("SELECT doc FROM prototype_revisions WHERE prototype_id=? AND rev=?").get(id,head.head_rev) as {doc:string}).doc,id,head.head_rev);
      const definitions=requireActiveDesignSystem(this.db,doc.designSystem,["designSystem"]).definitions;
      const customTypes=new Set(doc.screens.flatMap(s=>Object.values(s.spec.elements).map(e=>e.type)));
      const pinRows=this.db.query(`SELECT c.name,cr.design_system designSystem FROM prototype_revision_components p
        JOIN components c ON c.id=p.component_id
        JOIN component_publishes cp ON cp.component_id=p.component_id AND cp.version=p.component_version
        JOIN component_revisions cr ON cr.component_id=cp.component_id AND cr.rev=cp.rev
        WHERE p.prototype_id=? AND p.rev=?`).all(id,head.head_rev) as {name:string;designSystem:string}[];
      const mismatched=pinRows.find(pin=>pin.designSystem!==doc.designSystem);
      if(mismatched) throw new ApiError(422,"validation_failed","Prototype document is invalid",{issues:[{path:["screens"],message:`Component pin belongs to a different design system: ${mismatched.name}`}]});
      const pinned=new Set(pinRows.map(x=>x.name));
      for(const type of customTypes) if(!Object.hasOwn(definitions,type)&&!hostPrimitiveNames.has(type)&&!pinned.has(type)) throw new ApiError(422,"validation_failed","Prototype references an unpublished custom component",{issues:[{path:["screens"],message:`Unpublished custom component: ${type}`}]});
      const duplicate=this.db.query("SELECT version FROM prototype_publishes WHERE prototype_id=? AND rev=?").get(id,head.head_rev) as {version:number}|null;
      if (duplicate) throw new ApiError(409,"already_published","This revision is already published",{currentRev:head.head_rev,currentVersion:duplicate.version});
      const latest=this.db.query("SELECT MAX(version) version FROM prototype_publishes WHERE prototype_id=?").get(id) as {version:number|null};
      const version=(latest.version??0)+1;
      this.db.query("INSERT INTO prototype_publishes (prototype_id,version,rev,message,published_at) VALUES (?,?,?,?,?)").run(id,version,head.head_rev,message??null,now());
      return {version,rev:head.head_rev};
    })();
  }
  delete(id:string,baseRev:number): void { this.db.transaction(()=>{
    this.cas(id,baseRev);
    const sets=this.db.query("SELECT members_json FROM visual_baseline_sets WHERE prototype_id=?").all(id) as {members_json:string}[];
    const references=new Set<string>();
    for(const set of sets) for(const member of JSON.parse(set.members_json) as {referenceId:string}[]) references.add(member.referenceId);
    const tombstone=this.db.query("UPDATE visual_references SET deleted_at=? WHERE id=? AND deleted_at IS NULL");
    const at=now(); for(const referenceId of references) tombstone.run(at,referenceId);
    this.db.query("DELETE FROM visual_baseline_sets WHERE prototype_id=?").run(id);
    this.db.query("DELETE FROM prototypes WHERE id=?").run(id);
  })(); }
  list(principal?: Principal) {
    const userId=principal?.kind==="user"?principal.userId:"";
    return (this.db.query(`SELECT p.*,u.id owner_user_id,u.name owner_name,
      (SELECT MAX(version) FROM prototype_publishes x WHERE x.prototype_id=p.id) latest_version
      FROM prototypes p JOIN users u ON u.id=p.owner_id
      WHERE ?=1 OR p.owner_id=? OR p.status='published' ORDER BY p.updated_at DESC,p.id`).all(principal?0:1,userId) as (PrototypeRow&{latest_version:number|null;owner_user_id:string;owner_name:string})[])
      .map(r=>({id:r.id,name:r.name,description:r.description??undefined,device:r.device,designSystem:r.design_system,screenCount:r.screen_count,headRev:r.head_rev,latestVersion:r.latest_version,updatedAt:r.updated_at,status:r.status,owner:{id:r.owner_user_id,name:r.owner_name}}));
  }
  meta(id:string,principal?:Principal) {
    const access=principal?requirePrototypeRead(this.db,id,principal):{owner:true};
    const r=this.row(id); const versions=this.versions(id); const latest=versions.at(-1)??null;
    const publishedVersion=latest?.version??null;
    const headClassification=this.classifyRevision(id,r.head_rev);
    const publishedClassification=latest?this.classifyRevision(id,latest.rev):null;
    return {
      id:r.id,name:r.name,designSystem:r.design_system,headRev:r.head_rev,
      prototypeInstanceId:r.instance_id,
      latestVersion:publishedVersion,versions,updatedAt:r.updated_at,
      draftRevision:r.head_rev,
      validatedRevision:latestValidatedRev(this.db,"prototype",id),
      publishedVersion,
      renderable:{head:headClassification.renderable,published:publishedClassification?.renderable??null},
      renderErrors:{head:headClassification.error,published:publishedClassification?.error??null},
      status:r.status,owner:{id:r.owner_id??"",name:(this.db.query("SELECT name FROM users WHERE id=?").get(r.owner_id) as {name:string}|null)?.name??"Unknown"},
      ...(access.owner?{figma:parseFigmaStored(this.revisionRow(id,r.head_rev).figma_json)}:{}),
    };
  }
  draft(id:string,principal?:Principal) { const r=this.row(id); const access=principal?requirePrototypeRead(this.db,id,principal):{owner:true}; const x=this.revisionRow(id,r.head_rev); const components=this.pins(id,r.head_rev); const classification=this.classifyRevision(id,r.head_rev); return {doc:parseStoredPrototypeDoc(x.doc,id,x.rev),rev:x.rev,prototypeInstanceId:r.instance_id,builtinCatalogHash:x.builtin_catalog_hash,componentManifestHash:this.manifestHash(components),components,assets:this.assets(id,r.head_rev),designSystemMetaVersion:x.design_system_meta_version,renderable:classification.renderable,renderError:classification.error,...(access.owner?{figma:parseFigmaStored(x.figma_json)}:{})}; }
  revisions(id:string,limit:number,before?:number) { this.row(id); const sql=`SELECT rev,message,created_at FROM prototype_revisions WHERE prototype_id=? ${before!==undefined?"AND rev < ?":""} ORDER BY rev DESC LIMIT ?`; const rows=(before!==undefined?this.db.query(sql).all(id,before,limit):this.db.query(sql).all(id,limit)) as {rev:number;message:string|null;created_at:string}[]; return rows.map(r=>({rev:r.rev,message:r.message,createdAt:r.created_at})); }
  private revisionRow(id:string,rev:number): RevisionRow { const r=this.db.query("SELECT rev,doc,builtin_catalog_hash,design_system_meta_version,figma_json,message,created_at FROM prototype_revisions WHERE prototype_id=? AND rev=?").get(id,rev) as RevisionRow|null; if(!r) throw new ApiError(404,"revision_not_found","Prototype revision not found"); return r; }
  revision(id:string,rev:number,principal?:Principal) { const proto=this.row(id); const owner=!principal||prototypeAccess(this.db,id,principal).owner; const r=this.revisionRow(id,rev); const components=this.pins(id,rev); const classification=this.classifyRevision(id,rev); return {rev:r.rev,prototypeInstanceId:proto.instance_id,doc:parseStoredPrototypeDoc(r.doc,id,r.rev),builtinCatalogHash:r.builtin_catalog_hash,componentManifestHash:this.manifestHash(components),components,assets:this.assets(id,rev),designSystemMetaVersion:r.design_system_meta_version,renderable:classification.renderable,renderError:classification.error,...(owner?{figma:parseFigmaStored(r.figma_json)}:{}),message:r.message,createdAt:r.created_at}; }
  versions(id:string) { this.row(id); return (this.db.query("SELECT version,rev,published_at FROM prototype_publishes WHERE prototype_id=? ORDER BY version").all(id) as {version:number;rev:number;published_at:string}[]).map(r=>{const classification=this.classifyRevision(id,r.rev);return {version:r.version,rev:r.rev,publishedAt:r.published_at,renderable:classification.renderable,renderError:classification.error};}); }
  version(id:string,version:number,principal?:Principal) { const proto=this.row(id); const owner=!principal||requirePrototypeRead(this.db,id,principal).owner; const p=this.db.query("SELECT rev,published_at FROM prototype_publishes WHERE prototype_id=? AND version=?").get(id,version) as {rev:number;published_at:string}|null; if(!p) throw new ApiError(404,"version_not_found","Prototype version not found"); const r=this.revisionRow(id,p.rev); const components=this.pins(id,p.rev); const classification=this.classifyRevision(id,p.rev); return {version,rev:p.rev,prototypeInstanceId:proto.instance_id,doc:parseStoredPrototypeDoc(r.doc,id,r.rev),builtinCatalogHash:r.builtin_catalog_hash,componentManifestHash:this.manifestHash(components),components,assets:this.assets(id,p.rev),designSystemMetaVersion:r.design_system_meta_version,renderable:classification.renderable,renderError:classification.error,...(owner?{figma:parseFigmaStored(r.figma_json)}:{}),publishedAt:p.published_at}; }
  setStatus(id:string,status:"private"|"published"|"archived") {
    const row=this.row(id); if(row.status===status) throw new ApiError(422,"invalid_transition",`Cannot transition ${row.status} → ${status}`);
    const allowed:Record<PrototypeRow["status"],PrototypeRow["status"][]>={private:["published","archived"],published:["private","archived"],archived:["private"]};
    if(!allowed[row.status].includes(status)) throw new ApiError(422,"invalid_transition",`Cannot transition ${row.status} → ${status}`);
    if(row.status==="archived"&&status==="private"&&!this.classifyRevision(id,row.head_rev).renderable) throw new ApiError(409,"prototype_not_renderable","Archived prototype head is not renderable");
    this.db.query("UPDATE prototypes SET status=?,updated_at=? WHERE id=?").run(status,now(),id);
    return {status};
  }
}
