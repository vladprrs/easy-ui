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
