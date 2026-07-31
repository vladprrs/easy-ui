import { z } from "zod";

/**
 * Shared wire contract for the human-confirmed reuse-gate override.
 *
 * `reason` is 20..500 characters after trim. The gate separately requires the catalog
 * revision to be current and candidateKeys to cover every freshly recomputed blocking key;
 * callers cannot submit scores or candidate bodies through this schema.
 *
 * Keep this module Zod-only: contracts and the gate both depend on it, so importing route,
 * database, corpus, or gate modules here would reintroduce a root-import cycle.
 */
export const reuseOverrideSchema = z.strictObject({
  catalogRevision: z.string().min(1).max(128),
  candidateKeys: z.array(z.string().min(1).max(256)).min(1),
  reason: z.string().trim().min(20).max(500),
});

export type ReuseOverride = z.infer<typeof reuseOverrideSchema>;
