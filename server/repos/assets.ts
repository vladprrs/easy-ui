import type { Database } from "bun:sqlite";
import { rename } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { ApiError } from "../http";
import { MAX_ASSET_BYTES, validateAsset } from "../assets/validate";
import type { Principal } from "../auth";

export type AssetRow = {
  id: string;
  sha256: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  original_name: string | null;
  created_at: string;
};

export type AssetPublic = { id: string; sha256: string; mime: string; size: number; width?: number; height?: number };
export type IngestResult = { asset: AssetRow; deduplicated: boolean };

export type AssetUsageCounts = {
  prototypes: number;
  components: number;
  visualReferences: number;
  visualRuns: number;
};

export type ListedAsset = AssetRow & AssetUsageCounts;
export type AssetCursor = { createdAt: string; id: string };

export type AssetUsage = {
  asset: AssetRow;
  prototypes: { id: string; name: string; revCount: number; lastRev: number; pinnedAtHead: boolean }[];
  components: { id: string; name: string; versions: number[] }[];
  visualReferences: { id: string; deleted: boolean }[];
  visualRuns: { id: string; referenceId: string; role: "reference" | "candidate" | "diff" }[];
};

const toPublic = (row: AssetRow): AssetPublic => ({
  id: row.id, sha256: row.sha256, mime: row.mime, size: row.size,
  ...(row.width !== null ? { width: row.width } : {}), ...(row.height !== null ? { height: row.height } : {}),
});

export class AssetRepo {
  constructor(private db: Database, private dataDir: string) {}

  private dir(): string { return resolve(this.dataDir, "assets"); }
  bytesPath(sha256: string): string { return resolve(this.dir(), sha256); }

  get(id: string): AssetRow | null {
    return this.db.query("SELECT * FROM assets WHERE id=?").get(id) as AssetRow | null;
  }
  publicById(id: string): AssetPublic | null { const row = this.get(id); return row ? toPublic(row) : null; }
  exists(id: string): boolean { return Boolean(this.db.query("SELECT 1 ok FROM assets WHERE id=?").get(id)); }

  private visiblePrototypeIds(principal:Principal):Set<string>{
    if(principal.kind==="capture") return new Set((this.db.query("SELECT id FROM prototypes").all() as {id:string}[]).map(x=>x.id));
    const scoped=principal.kind==="share"?principal.scope.prototypeId:""; const user=principal.kind==="user"?principal.userId:"";
    return new Set((this.db.query("SELECT id FROM prototypes WHERE status='published' OR owner_id=? OR id=?").all(user,scoped) as {id:string}[]).map(x=>x.id));
  }
  reachable(id:string,principal:Principal):boolean{
    if(principal.kind==="user"&&principal.isAdmin) return this.exists(id);
    if(this.db.query("SELECT 1 ok FROM component_publish_assets WHERE asset_id=? LIMIT 1").get(id)) return true;
    const visible=this.visiblePrototypeIds(principal);
    const prototypeRows=this.db.query("SELECT prototype_id id FROM prototype_revision_assets WHERE asset_id=?").all(id) as {id:string}[];
    if(prototypeRows.some(x=>visible.has(x.id))) return true;
    const refs=this.db.query(`SELECT fingerprint_json json FROM visual_references vr WHERE vr.asset_id=? OR EXISTS (
      SELECT 1 FROM visual_runs run WHERE run.reference_id=vr.id AND (run.reference_asset_id=? OR run.candidate_asset_id=? OR run.diff_asset_id=?))`).all(id,id,id,id) as {json:string}[];
    return refs.some(({json})=>{try{const fp=JSON.parse(json) as {scope?:string;prototypeId?:string};return fp.scope==="component"||(fp.prototypeId!==undefined&&visible.has(fp.prototypeId));}catch{return false;}});
  }
  list({ limit, before, principal }: { limit: number; before?: AssetCursor; principal?:Principal }): { assets: ListedAsset[]; nextCursor: AssetCursor | null } {
    const sql = `SELECT a.*,
      (SELECT COUNT(DISTINCT pra.prototype_id) FROM prototype_revision_assets pra WHERE pra.asset_id=a.id) prototypes,
      (SELECT COUNT(DISTINCT cpa.component_id) FROM component_publish_assets cpa WHERE cpa.asset_id=a.id) components,
      (SELECT COUNT(*) FROM visual_references vr WHERE vr.asset_id=a.id) visualReferences,
      ((SELECT COUNT(*) FROM visual_runs run WHERE run.reference_asset_id=a.id) +
       (SELECT COUNT(*) FROM visual_runs run WHERE run.candidate_asset_id=a.id) +
       (SELECT COUNT(*) FROM visual_runs run WHERE run.diff_asset_id=a.id)) visualRuns
      FROM assets a
      ${before ? "WHERE (a.created_at, a.id) < (?, ?)" : ""}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ?`;
    const fetchLimit=principal?100000:limit+1;
    let rows = (before
      ? this.db.query(sql).all(before.createdAt, before.id, fetchLimit)
      : this.db.query(sql).all(fetchLimit)) as ListedAsset[];
    if(principal) rows=rows.filter(row=>this.reachable(row.id,principal));
    const hasMore = rows.length > limit;
    const assets = rows.slice(0, limit);
    const last = hasMore ? assets.at(-1) : undefined;
    return { assets, nextCursor: last ? { createdAt: last.created_at, id: last.id } : null };
  }

  usage(id: string,principal?:Principal): AssetUsage | null {
    const asset = this.get(id);
    if (!asset) return null;

    let prototypes = this.db.query(`SELECT p.id,p.name,COUNT(*) revCount,MAX(pra.rev) lastRev,
      MAX(CASE WHEN pra.rev=p.head_rev THEN 1 ELSE 0 END) pinnedAtHead
      FROM prototype_revision_assets pra
      JOIN prototypes p ON p.id=pra.prototype_id
      WHERE pra.asset_id=?
      GROUP BY p.id,p.name,p.head_rev
      ORDER BY p.id`).all(id) as { id: string; name: string; revCount: number; lastRev: number; pinnedAtHead: number }[];
    if(principal){const visible=this.visiblePrototypeIds(principal);prototypes=prototypes.filter(row=>visible.has(row.id));}

    const componentRows = this.db.query(`SELECT c.id,c.name,cpa.version
      FROM component_publish_assets cpa
      JOIN components c ON c.id=cpa.component_id
      WHERE cpa.asset_id=?
      ORDER BY c.id,cpa.version`).all(id) as { id: string; name: string; version: number }[];
    const components: AssetUsage["components"] = [];
    for (const row of componentRows) {
      const previous = components.at(-1);
      if (previous?.id === row.id) previous.versions.push(row.version);
      else components.push({ id: row.id, name: row.name, versions: [row.version] });
    }

    let visualReferencesRaw = this.db.query(`SELECT id,deleted_at IS NOT NULL deleted,fingerprint_json json
      FROM visual_references WHERE asset_id=? ORDER BY id`).all(id) as { id: string; deleted: number;json:string }[];
    let visualRuns = this.db.query(`SELECT run.id,run.reference_id referenceId,'reference' role,vr.fingerprint_json json
        FROM visual_runs run JOIN visual_references vr ON vr.id=run.reference_id WHERE run.reference_asset_id=?
      UNION ALL SELECT run.id,run.reference_id referenceId,'candidate' role,vr.fingerprint_json json
        FROM visual_runs run JOIN visual_references vr ON vr.id=run.reference_id WHERE run.candidate_asset_id=?
      UNION ALL SELECT run.id,run.reference_id referenceId,'diff' role,vr.fingerprint_json json
        FROM visual_runs run JOIN visual_references vr ON vr.id=run.reference_id WHERE run.diff_asset_id=?
      `).all(id, id, id) as (AssetUsage["visualRuns"][number]&{json:string})[];
    if(principal){const visible=this.visiblePrototypeIds(principal);const ok=(json:string)=>{try{const fp=JSON.parse(json) as {scope?:string;prototypeId?:string};return fp.scope==="component"||!!fp.prototypeId&&visible.has(fp.prototypeId);}catch{return false;}};visualReferencesRaw=visualReferencesRaw.filter(x=>ok(x.json));visualRuns=visualRuns.filter(x=>ok((x as typeof x&{json:string}).json));}

    return {
      asset,
      prototypes: prototypes.map((row) => ({ ...row, pinnedAtHead: row.pinnedAtHead === 1 })),
      components,
      visualReferences: visualReferencesRaw.map((row) => ({ id: row.id, deleted: row.deleted === 1 })),
      visualRuns: visualRuns.map(({id,referenceId,role})=>({id,referenceId,role})).sort((a,b)=>a.id.localeCompare(b.id)||a.role.localeCompare(b.role)),
    };
  }

  // Content-addressed ingest: sha256 => id. Existing sha256 short-circuits (dedup); new bytes are
  // magic-byte/dimension validated, written atomically (temp + rename), then recorded.
  async ingest(bytes: Uint8Array, declaredMime: string, originalName?: string): Promise<IngestResult> {
    if (bytes.byteLength > MAX_ASSET_BYTES) throw new ApiError(413, "asset_too_large", `Asset exceeds ${MAX_ASSET_BYTES} bytes`);
    if (bytes.byteLength === 0) throw new ApiError(422, "asset_type_mismatch", "Asset body is empty");
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const id = `asset_${sha256}`;
    const existing = this.db.query("SELECT * FROM assets WHERE sha256=?").get(sha256) as AssetRow | null;
    if (existing) return { asset: existing, deduplicated: true };

    const validated = validateAsset(bytes, declaredMime);
    mkdirSync(this.dir(), { recursive: true });
    const target = this.bytesPath(sha256);
    const tmp = `${target}.${crypto.randomUUID()}.tmp`;
    await Bun.write(tmp, bytes);
    await rename(tmp, target);

    const created = new Date().toISOString();
    this.db.query("INSERT OR IGNORE INTO assets (id,sha256,mime,size,width,height,original_name,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, sha256, validated.mime, bytes.byteLength, validated.width ?? null, validated.height ?? null, originalName ?? null, created);
    const row = this.get(id)!;
    // A concurrent insert of the same sha256 loses the race but shares identical bytes: still a dedup.
    return { asset: row, deduplicated: row.created_at !== created };
  }
}

export const assetPublic = toPublic;
