import type { Database } from "bun:sqlite";
import { rename } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { ApiError } from "../http";
import { MAX_ASSET_BYTES, validateAsset } from "../assets/validate";

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

  list({ limit, before }: { limit: number; before?: AssetCursor }): { assets: ListedAsset[]; nextCursor: AssetCursor | null } {
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
    const rows = (before
      ? this.db.query(sql).all(before.createdAt, before.id, limit + 1)
      : this.db.query(sql).all(limit + 1)) as ListedAsset[];
    const hasMore = rows.length > limit;
    const assets = rows.slice(0, limit);
    const last = hasMore ? assets.at(-1) : undefined;
    return { assets, nextCursor: last ? { createdAt: last.created_at, id: last.id } : null };
  }

  usage(id: string): AssetUsage | null {
    const asset = this.get(id);
    if (!asset) return null;

    const prototypes = this.db.query(`SELECT p.id,p.name,COUNT(*) revCount,MAX(pra.rev) lastRev,
      MAX(CASE WHEN pra.rev=p.head_rev THEN 1 ELSE 0 END) pinnedAtHead
      FROM prototype_revision_assets pra
      JOIN prototypes p ON p.id=pra.prototype_id
      WHERE pra.asset_id=?
      GROUP BY p.id,p.name,p.head_rev
      ORDER BY p.id`).all(id) as { id: string; name: string; revCount: number; lastRev: number; pinnedAtHead: number }[];

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

    const visualReferences = this.db.query(`SELECT id,deleted_at IS NOT NULL deleted
      FROM visual_references WHERE asset_id=? ORDER BY id`).all(id) as { id: string; deleted: number }[];
    const visualRuns = this.db.query(`SELECT id,reference_id referenceId,'reference' role
        FROM visual_runs WHERE reference_asset_id=?
      UNION ALL SELECT id,reference_id referenceId,'candidate' role
        FROM visual_runs WHERE candidate_asset_id=?
      UNION ALL SELECT id,reference_id referenceId,'diff' role
        FROM visual_runs WHERE diff_asset_id=?
      ORDER BY id,role`).all(id, id, id) as AssetUsage["visualRuns"];

    return {
      asset,
      prototypes: prototypes.map((row) => ({ ...row, pinnedAtHead: row.pinnedAtHead === 1 })),
      components,
      visualReferences: visualReferences.map((row) => ({ id: row.id, deleted: row.deleted === 1 })),
      visualRuns,
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
