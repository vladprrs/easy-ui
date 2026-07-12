import type { Database } from "bun:sqlite";
import { AssetRepo, type AssetPublic } from "../repos/assets";
import { fingerprintId, fingerprintJson, type Fingerprint } from "./fingerprint";

export interface VisualReferenceRow {
  id: string;
  fingerprint_json: string;
  asset_id: string;
  note: string | null;
  created_at: string;
}

export type RunStatus = "pass" | "fail" | "error" | "reference_missing";

export interface VisualRunRow {
  id: string;
  reference_id: string;
  candidate_asset_id: string | null;
  diff_asset_id: string | null;
  metric: string | null;
  metric_options_json: string | null;
  diff_pixels: number | null;
  total_pixels: number | null;
  diff_percent: number | null;
  status: RunStatus;
  candidate_meta_json: string | null;
  created_at: string;
}

export interface MetricResult { diffPixels: number; totalPixels: number; diffPercent: number }
export interface CandidateMeta {
  rev?: number;
  version?: number;
  pins?: { id: string; version: number; bundleHash: string }[];
  bundleHash?: string;
  rendererBuild?: string | null;
  browserVersion?: string;
}

export interface RunReport {
  runId: string;
  referenceId: string;
  status: RunStatus;
  createdAt: string;
  metric: string | null;
  metricOptions: Record<string, unknown> | null;
  diffPixels: number | null;
  totalPixels: number | null;
  diffPercent: number | null;
  metrics: { "exact-rgba"?: MetricResult; "pixelmatch-v1"?: MetricResult };
  reference: EvidenceAsset | null;
  candidate: EvidenceAsset | null;
  diff: { assetId: string; url: string } | null;
  candidateMeta: CandidateMeta | null;
}

export interface EvidenceAsset { assetId: string; url: string; sha256: string; width: number | null; height: number | null; mime: string }

export interface VisualReferencePublic {
  id: string;
  fingerprint: unknown;
  note: string | null;
  createdAt: string;
  asset: (AssetPublic & { url: string }) | null;
  lastRun: RunReport | null;
}

/**
 * DB access for visual references + runs. Kept out of `server/repos` so the T7
 * feature owns its own persistence surface; reads reuse {@link AssetRepo} for
 * content-addressed asset evidence (sha256, dimensions).
 */
export class VisualRepo {
  private readonly assets: AssetRepo;
  constructor(private readonly db: Database, dataDir: string) {
    this.assets = new AssetRepo(db, dataDir);
  }

  assetRepo(): AssetRepo { return this.assets; }

  upsertReference(fingerprint: Fingerprint, assetId: string, note: string | null): VisualReferenceRow {
    const json = fingerprintJson(fingerprint);
    const id = fingerprintId(json);
    const existing = this.getReference(id);
    if (existing) {
      this.db.query("UPDATE visual_references SET asset_id=?, note=? WHERE id=?").run(assetId, note, id);
    } else {
      this.db.query("INSERT INTO visual_references (id,fingerprint_json,asset_id,note,created_at) VALUES (?,?,?,?,?)")
        .run(id, json, assetId, note, new Date().toISOString());
    }
    return this.getReference(id)!;
  }

  getReference(id: string): VisualReferenceRow | null {
    return this.db.query("SELECT * FROM visual_references WHERE id=?").get(id) as VisualReferenceRow | null;
  }

  listReferences(filter: { scope?: string; prototypeId?: string; componentId?: string }): VisualReferenceRow[] {
    const rows = this.db.query("SELECT * FROM visual_references ORDER BY created_at DESC, id DESC").all() as VisualReferenceRow[];
    return rows.filter((row) => {
      if (!filter.scope && !filter.prototypeId && !filter.componentId) return true;
      let fp: Record<string, unknown>;
      try { fp = JSON.parse(row.fingerprint_json) as Record<string, unknown>; } catch { return false; }
      if (filter.scope && fp.scope !== filter.scope) return false;
      if (filter.prototypeId && fp.prototypeId !== filter.prototypeId) return false;
      if (filter.componentId && fp.componentId !== filter.componentId) return false;
      return true;
    });
  }

  insertRun(row: VisualRunRow): void {
    this.db.query(`INSERT INTO visual_runs
      (id,reference_id,candidate_asset_id,diff_asset_id,metric,metric_options_json,diff_pixels,total_pixels,diff_percent,status,candidate_meta_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(row.id, row.reference_id, row.candidate_asset_id, row.diff_asset_id, row.metric, row.metric_options_json,
        row.diff_pixels, row.total_pixels, row.diff_percent, row.status, row.candidate_meta_json, row.created_at);
  }

  getRun(id: string): VisualRunRow | null {
    return this.db.query("SELECT * FROM visual_runs WHERE id=?").get(id) as VisualRunRow | null;
  }

  listRuns(referenceId: string): VisualRunRow[] {
    return this.db.query("SELECT * FROM visual_runs WHERE reference_id=? ORDER BY created_at DESC, id DESC").all(referenceId) as VisualRunRow[];
  }

  private evidenceAsset(assetId: string | null): EvidenceAsset | null {
    if (!assetId) return null;
    const row = this.assets.get(assetId);
    if (!row) return null;
    return { assetId: row.id, url: `/api/assets/${row.id}`, sha256: row.sha256, width: row.width, height: row.height, mime: row.mime };
  }

  /** Assemble the honest evidence report for a run row (evidence guard §E.6). */
  runReport(row: VisualRunRow, referenceAssetId: string | null): RunReport {
    const meta: (Record<string, unknown> & { exactRgba?: MetricResult }) | null = row.candidate_meta_json ? JSON.parse(row.candidate_meta_json) : null;
    const options = row.metric_options_json ? JSON.parse(row.metric_options_json) as Record<string, unknown> : null;
    const metrics: RunReport["metrics"] = {};
    if (meta?.exactRgba) metrics["exact-rgba"] = meta.exactRgba;
    if (row.metric === "pixelmatch-v1" && row.diff_pixels !== null && row.total_pixels !== null && row.diff_percent !== null) {
      metrics["pixelmatch-v1"] = { diffPixels: row.diff_pixels, totalPixels: row.total_pixels, diffPercent: row.diff_percent };
    }
    const candidateMeta: CandidateMeta | null = meta ? { ...meta } as CandidateMeta : null;
    if (candidateMeta) delete (candidateMeta as { exactRgba?: unknown }).exactRgba;
    return {
      runId: row.id,
      referenceId: row.reference_id,
      status: row.status,
      createdAt: row.created_at,
      metric: row.metric,
      metricOptions: options,
      diffPixels: row.diff_pixels,
      totalPixels: row.total_pixels,
      diffPercent: row.diff_percent,
      metrics,
      reference: this.evidenceAsset(referenceAssetId),
      candidate: this.evidenceAsset(row.candidate_asset_id),
      diff: row.diff_asset_id ? { assetId: row.diff_asset_id, url: `/api/assets/${row.diff_asset_id}` } : null,
      candidateMeta,
    };
  }

  referencePublic(row: VisualReferenceRow): VisualReferencePublic {
    const asset = this.assets.publicById(row.asset_id);
    const runs = this.listRuns(row.id);
    const lastRun = runs[0] ? this.runReport(runs[0], row.asset_id) : null;
    return {
      id: row.id,
      fingerprint: JSON.parse(row.fingerprint_json),
      note: row.note,
      createdAt: row.created_at,
      asset: asset ? { ...asset, url: `/api/assets/${asset.id}` } : null,
      lastRun,
    };
  }
}
