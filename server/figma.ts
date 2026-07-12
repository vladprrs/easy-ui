import type { Database } from "bun:sqlite";
import { z } from "zod";
import { ApiError } from "./http";

// Figma provenance (plan §J). Immutable per-revision link back to the source Figma file:
// a strict, url-safe file key, 1..50 node ids, optional reference screenshot asset ids
// (validated against the asset registry), and an optional ISO sync timestamp. Stored as a
// JSON string in prototype_revisions.figma_json / component_revisions.figma_json.

const ASSET_ID = /^asset_[0-9a-f]{64}$/;

export const figmaSchema = z.strictObject({
  fileKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, "fileKey must be url-safe"),
  nodeIds: z.array(z.string().min(1).max(64).regex(/^[A-Za-z0-9:._-]+$/, "nodeId must be safe")).min(1).max(50),
  referenceScreenshots: z.array(z.string().regex(ASSET_ID, "must be an asset id")).max(50).optional(),
  lastSyncedAt: z.string().min(1).max(40).refine((value) => !Number.isNaN(Date.parse(value)), "must be an ISO date").optional(),
});

export type FigmaProvenance = z.infer<typeof figmaSchema>;

// Validate an optional `figma` request field into a persist-ready JSON string (or null when the
// field is absent/null). referenceScreenshots must exist in the asset registry (422 asset_not_found).
export function parseFigmaInput(db: Database, value: unknown, pathRoot: string): string | null {
  if (value === undefined || value === null) return null;
  const parsed = figmaSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(422, "validation_failed", "Figma provenance is invalid", { issues: parsed.error.issues });
  for (const assetId of parsed.data.referenceScreenshots ?? []) {
    if (!db.query("SELECT 1 ok FROM assets WHERE id=?").get(assetId)) {
      throw new ApiError(422, "asset_not_found", "A referenced screenshot asset does not exist", { issues: [{ path: [pathRoot, "referenceScreenshots"], message: `unknown asset: ${assetId}` }] });
    }
  }
  return JSON.stringify(parsed.data);
}

// Parse a stored figma_json blob for read-back. Returns null for NULL/corrupt rows so read-back
// never fails on a legacy revision.
export function parseFigmaStored(json: string | null | undefined): FigmaProvenance | null {
  if (json === null || json === undefined) return null;
  try { return figmaSchema.parse(JSON.parse(json)); } catch { return null; }
}
