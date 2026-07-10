import type { Database } from "bun:sqlite";
import type { PrototypeDoc } from "../../src/prototype/schema";
import { builtinCatalogHash, emptyComponentManifestHash } from "../builtinHash";
import { ApiError } from "../http";

type Pin = { id: string; name: string; version: number; bundleUrl: string; bundleHash: string };
type PrototypeRow = { id:string; name:string; description:string|null; device:string; screen_count:number; head_rev:number; created_at:string; updated_at:string };
type RevisionRow = { rev:number; doc:string; builtin_catalog_hash:string; message:string|null; created_at:string };

const now = () => new Date().toISOString();
const missing = () => new ApiError(404, "not_found", "Prototype not found");

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
  private manifestHash(pins: Pin[]): string {
    if (!pins.length) return emptyComponentManifestHash;
    const stable = pins.map(({id,version,bundleHash}) => ({id,version,bundleHash}));
    return new Bun.CryptoHasher("sha256").update(JSON.stringify(stable)).digest("hex");
  }
  private insertRevision(id:string, rev:number, doc:PrototypeDoc, message:string|null, createdAt:string): void {
    this.db.query(`INSERT INTO prototype_revisions
      (prototype_id,rev,doc,builtin_catalog_hash,message,created_at) VALUES (?,?,?,?,?,?)`)
      .run(id,rev,JSON.stringify(doc),builtinCatalogHash,message,createdAt);
  }
  create(doc: PrototypeDoc, message?: string): {id:string;rev:1} {
    return this.db.transaction(() => {
      if (this.db.query("SELECT 1 ok FROM prototypes WHERE id=?").get(doc.id)) throw new ApiError(409,"already_exists","Prototype already exists");
      const at=now();
      this.db.query(`INSERT INTO prototypes (id,name,description,device,screen_count,head_rev,created_at,updated_at)
        VALUES (?,?,?,?,?,1,?,?)`).run(doc.id,doc.name,doc.description??null,doc.device,doc.screens.length,at,at);
      this.insertRevision(doc.id,1,doc,message??null,at);
      return {id:doc.id,rev:1 as const};
    })();
  }
  save(id:string, doc:PrototypeDoc, baseRev:number, message?:string): {rev:number} {
    return this.db.transaction(() => {
      const head=this.cas(id,baseRev); const rev=head.head_rev+1; const at=now();
      this.insertRevision(id,rev,doc,message??null,at);
      this.db.query(`UPDATE prototypes SET name=?,description=?,device=?,screen_count=?,head_rev=?,updated_at=? WHERE id=?`)
        .run(doc.name,doc.description??null,doc.device,doc.screens.length,rev,at,id);
      return {rev};
    })();
  }
  restore(id:string, sourceRev:number, baseRev:number): {rev:number} {
    return this.db.transaction(() => {
      const head=this.cas(id,baseRev);
      const source=this.db.query("SELECT doc FROM prototype_revisions WHERE prototype_id=? AND rev=?").get(id,sourceRev) as {doc:string}|null;
      if (!source) throw new ApiError(404,"not_found","Prototype revision not found");
      const doc=JSON.parse(source.doc) as PrototypeDoc; const rev=head.head_rev+1; const at=now();
      this.insertRevision(id,rev,doc,`Restore revision ${sourceRev}`,at);
      this.db.query(`INSERT INTO prototype_revision_components (prototype_id,rev,component_id,component_version)
        SELECT prototype_id,?,component_id,component_version FROM prototype_revision_components WHERE prototype_id=? AND rev=?`).run(rev,id,sourceRev);
      this.db.query(`UPDATE prototypes SET name=?,description=?,device=?,screen_count=?,head_rev=?,updated_at=? WHERE id=?`)
        .run(doc.name,doc.description??null,doc.device,doc.screens.length,rev,at,id);
      return {rev};
    })();
  }
  publish(id:string,baseRev:number,message?:string): {version:number;rev:number} {
    return this.db.transaction(() => {
      const head=this.cas(id,baseRev);
      const duplicate=this.db.query("SELECT version FROM prototype_publishes WHERE prototype_id=? AND rev=?").get(id,head.head_rev) as {version:number}|null;
      if (duplicate) throw new ApiError(409,"already_published","This revision is already published",{currentRev:head.head_rev,currentVersion:duplicate.version});
      const latest=this.db.query("SELECT MAX(version) version FROM prototype_publishes WHERE prototype_id=?").get(id) as {version:number|null};
      const version=(latest.version??0)+1;
      this.db.query("INSERT INTO prototype_publishes (prototype_id,version,rev,message,published_at) VALUES (?,?,?,?,?)").run(id,version,head.head_rev,message??null,now());
      return {version,rev:head.head_rev};
    })();
  }
  delete(id:string,baseRev:number): void { this.db.transaction(()=>{this.cas(id,baseRev);this.db.query("DELETE FROM prototypes WHERE id=?").run(id);})(); }
  list() {
    return (this.db.query(`SELECT p.*, (SELECT MAX(version) FROM prototype_publishes x WHERE x.prototype_id=p.id) latest_version
      FROM prototypes p ORDER BY p.updated_at DESC,p.id`).all() as (PrototypeRow&{latest_version:number|null})[]).map(r=>({id:r.id,name:r.name,description:r.description??undefined,device:r.device,screenCount:r.screen_count,headRev:r.head_rev,latestVersion:r.latest_version,updatedAt:r.updated_at}));
  }
  meta(id:string) { const r=this.row(id); const versions=this.versions(id); return {id:r.id,name:r.name,headRev:r.head_rev,latestVersion:versions.at(-1)?.version??null,versions,updatedAt:r.updated_at}; }
  draft(id:string) { const r=this.row(id); const x=this.revisionRow(id,r.head_rev); const components=this.pins(id,r.head_rev); return {doc:JSON.parse(x.doc),rev:x.rev,builtinCatalogHash:x.builtin_catalog_hash,componentManifestHash:this.manifestHash(components),components}; }
  revisions(id:string,limit:number,before?:number) { this.row(id); const sql=`SELECT rev,message,created_at FROM prototype_revisions WHERE prototype_id=? ${before!==undefined?"AND rev < ?":""} ORDER BY rev DESC LIMIT ?`; const rows=(before!==undefined?this.db.query(sql).all(id,before,limit):this.db.query(sql).all(id,limit)) as {rev:number;message:string|null;created_at:string}[]; return rows.map(r=>({rev:r.rev,message:r.message,createdAt:r.created_at})); }
  private revisionRow(id:string,rev:number): RevisionRow { const r=this.db.query("SELECT rev,doc,builtin_catalog_hash,message,created_at FROM prototype_revisions WHERE prototype_id=? AND rev=?").get(id,rev) as RevisionRow|null; if(!r) throw new ApiError(404,"not_found","Prototype revision not found"); return r; }
  revision(id:string,rev:number) { const r=this.revisionRow(id,rev); return {rev:r.rev,doc:JSON.parse(r.doc),components:this.pins(id,rev),message:r.message,createdAt:r.created_at}; }
  versions(id:string) { this.row(id); return (this.db.query("SELECT version,rev,published_at FROM prototype_publishes WHERE prototype_id=? ORDER BY version").all(id) as {version:number;rev:number;published_at:string}[]).map(r=>({version:r.version,rev:r.rev,publishedAt:r.published_at})); }
  version(id:string,version:number) { const p=this.db.query("SELECT rev,published_at FROM prototype_publishes WHERE prototype_id=? AND version=?").get(id,version) as {rev:number;published_at:string}|null; if(!p) throw new ApiError(404,"not_found","Prototype version not found"); const r=this.revisionRow(id,p.rev); const components=this.pins(id,p.rev); return {version,rev:p.rev,doc:JSON.parse(r.doc),builtinCatalogHash:r.builtin_catalog_hash,componentManifestHash:this.manifestHash(components),components,publishedAt:p.published_at}; }
}
