import type { Database } from "bun:sqlite";
import { AssetRepo, type AssetPublic } from "../repos/assets";
import { fingerprintId, fingerprintJson, type Fingerprint } from "./fingerprint";
import { ApiError } from "../http";

export interface VisualReferenceRow {
  id: string;
  fingerprint_json: string;
  asset_id: string;
  note: string | null;
  created_at: string;
  deleted_at: string | null;
}

export type RunStatus = "pass" | "fail" | "error" | "reference_missing";

export interface VisualRunRow {
  id: string;
  reference_id: string;
  reference_asset_id: string | null;
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
  kind?: "prototype" | "component";
  outcome?: "captured" | "capture_failed";
  requestedTarget?: { rev?: number; version?: number };
  resolvedTarget?: { rev?: number; version?: number };
  expected?: unknown;
  browser?: { browserVersion: string; rendererBuild: string | null; consoleErrors: string[]; pageErrors: string[] } | null;
  error?: string;
}

export interface RunReport {
  runId: string;
  referenceId: string;
  status: RunStatus | "reference_unknown";
  createdAt: string;
  metric: string | null;
  metricOptions: Record<string, unknown> | null;
  diffPixels: number | null;
  totalPixels: number | null;
  diffPercent: number | null;
  metrics: { "exact-rgba"?: MetricResult; "pixelmatch-v1"?: MetricResult };
  referenceStatus: "known" | "unknown";
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

  /** Internal privileged mutation used by the atomic baseline-set transaction. */
  upsertReferencePrivileged(fingerprint: Fingerprint, assetId: string, note: string | null): VisualReferenceRow {
    const json = fingerprintJson(fingerprint);
    const id = fingerprintId(json);
    const existing = this.getReference(id, true);
    if (existing) {
      this.db.query("UPDATE visual_references SET asset_id=?, note=?, deleted_at=NULL WHERE id=?").run(assetId, note, id);
    } else {
      this.db.query("INSERT INTO visual_references (id,fingerprint_json,asset_id,note,created_at) VALUES (?,?,?,?,?)")
        .run(id, json, assetId, note, new Date().toISOString());
    }
    return this.getReference(id)!;
  }

  private latestManagedIds(): Set<string> {
    const latestByPrototype = this.db.query(`SELECT s.members_json FROM visual_baseline_sets s
      WHERE s.generation=(SELECT MAX(x.generation) FROM visual_baseline_sets x WHERE x.prototype_id=s.prototype_id)`).all() as {members_json:string}[];
    return new Set(latestByPrototype.flatMap((set) => (JSON.parse(set.members_json) as {referenceId:string}[]).map((member) => member.referenceId)));
  }

  private assertNotManaged(id: string): void {
    if (this.latestManagedIds().has(id)) throw new ApiError(409, "baseline_managed", "Visual reference is managed by a committed baseline set");
  }

  upsertReferenceGeneric(fingerprint: Fingerprint, assetId: string, note: string | null): VisualReferenceRow {
    let began=false;
    try {
      this.db.run("BEGIN IMMEDIATE"); began=true;
      this.assertNotManaged(fingerprintId(fingerprintJson(fingerprint)));
      const row=this.upsertReferencePrivileged(fingerprint,assetId,note);
      this.db.run("COMMIT"); began=false;
      return row;
    } catch(error) {
      if(began) this.db.run("ROLLBACK");
      throw error;
    }
  }

  getReference(id: string, includeDeleted = false): VisualReferenceRow | null {
    return this.db.query(`SELECT * FROM visual_references WHERE id=?${includeDeleted ? "" : " AND deleted_at IS NULL"}`).get(id) as VisualReferenceRow | null;
  }

  listReferences(filter: { scope?: string; prototypeId?: string; componentId?: string }): VisualReferenceRow[] {
    const rows = this.db.query("SELECT * FROM visual_references WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC").all() as VisualReferenceRow[];
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

  deleteReference(id: string): boolean {
    const result = this.db.query("UPDATE visual_references SET deleted_at=? WHERE id=? AND deleted_at IS NULL").run(new Date().toISOString(), id);
    return result.changes === 1;
  }

  deleteReferenceGeneric(id:string):boolean {
    let began=false;
    try {
      this.db.run("BEGIN IMMEDIATE"); began=true;
      this.assertNotManaged(id);
      const deleted=this.deleteReference(id);
      this.db.run("COMMIT"); began=false;
      return deleted;
    } catch(error) {
      if(began) this.db.run("ROLLBACK");
      throw error;
    }
  }

  insertRun(row: VisualRunRow): void {
    this.db.query(`INSERT INTO visual_runs
      (id,reference_id,reference_asset_id,candidate_asset_id,diff_asset_id,metric,metric_options_json,diff_pixels,total_pixels,diff_percent,status,candidate_meta_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(row.id, row.reference_id, row.reference_asset_id, row.candidate_asset_id, row.diff_asset_id, row.metric, row.metric_options_json,
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
  runReport(row: VisualRunRow): RunReport {
    const referenceKnown = row.reference_asset_id !== null;
    const meta: (Record<string, unknown> & { exactRgba?: MetricResult }) | null = row.candidate_meta_json ? JSON.parse(row.candidate_meta_json) : null;
    const options = row.metric_options_json ? JSON.parse(row.metric_options_json) as Record<string, unknown> : null;
    const metrics: RunReport["metrics"] = {};
    if (referenceKnown && meta?.exactRgba) metrics["exact-rgba"] = meta.exactRgba;
    if (referenceKnown && row.metric === "pixelmatch-v1" && row.diff_pixels !== null && row.total_pixels !== null && row.diff_percent !== null) {
      metrics["pixelmatch-v1"] = { diffPixels: row.diff_pixels, totalPixels: row.total_pixels, diffPercent: row.diff_percent };
    }
    const candidateMeta: CandidateMeta | null = meta ? { ...meta } as CandidateMeta : null;
    if (candidateMeta) delete (candidateMeta as { exactRgba?: unknown }).exactRgba;
    return {
      runId: row.id,
      referenceId: row.reference_id,
      status: referenceKnown ? row.status : "reference_unknown",
      createdAt: row.created_at,
      metric: referenceKnown ? row.metric : null,
      metricOptions: referenceKnown ? options : null,
      diffPixels: referenceKnown ? row.diff_pixels : null,
      totalPixels: referenceKnown ? row.total_pixels : null,
      diffPercent: referenceKnown ? row.diff_percent : null,
      metrics,
      referenceStatus: referenceKnown ? "known" : "unknown",
      reference: this.evidenceAsset(row.reference_asset_id),
      candidate: this.evidenceAsset(row.candidate_asset_id),
      diff: referenceKnown && row.diff_asset_id ? { assetId: row.diff_asset_id, url: `/api/assets/${row.diff_asset_id}` } : null,
      candidateMeta,
    };
  }

  referencePublic(row: VisualReferenceRow): VisualReferencePublic {
    const asset = this.assets.publicById(row.asset_id);
    const runs = this.listRuns(row.id);
    // A pass/fail against an older baseline must not verify the newly-upserted active baseline.
    const matchingRun = runs.find((run) => run.reference_asset_id === row.asset_id);
    const lastRun = matchingRun ? this.runReport(matchingRun) : null;
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
