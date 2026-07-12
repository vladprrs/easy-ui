import { z } from "zod";
import { canonicalStringify } from "../../src/capture/canonicalJson";

/**
 * Visual-reference fingerprint. It identifies the exact rendered surface a
 * baseline belongs to so a candidate can never be compared against an
 * incomparable image. Canonicalisation (sorted keys, dropped `undefined`)
 * yields a stable string that is both the UNIQUE key and the seed of the
 * reference id, so two semantically-equal fingerprints hash identically.
 */

const viewportSchema = z.strictObject({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

const hex = /^[0-9a-f]+$/;

const baseFields = {
  viewport: viewportSchema,
  deviceScaleFactor: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  theme: z.enum(["light", "dark"]),
  propsHash: z.string().regex(hex).optional(),
  stateHash: z.string().regex(hex).optional(),
};

export const fingerprintSchema = z.discriminatedUnion("scope", [
  z.strictObject({
    scope: z.literal("prototype-screen"),
    prototypeId: z.string().min(1),
    screenId: z.string().min(1),
    refRevision: z.number().int().positive(),
    ...baseFields,
  }),
  z.strictObject({
    scope: z.literal("component"),
    componentId: z.string().min(1),
    refVersion: z.number().int().positive(),
    ...baseFields,
  }),
]);

export type Fingerprint = z.infer<typeof fingerprintSchema>;

/** Parse + validate an untrusted fingerprint into the normalized shape. */
export function parseFingerprint(input: unknown): Fingerprint {
  return fingerprintSchema.parse(input);
}

/**
 * Deterministic canonical serialization: keys sorted at every depth and
 * `undefined`-valued optional fields (propsHash/stateHash) dropped so their
 * absence and an explicit `undefined` fingerprint the same surface.
 */
export function fingerprintJson(fingerprint: Fingerprint): string {
  const dense: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fingerprint)) if (value !== undefined) dense[key] = value;
  return canonicalStringify(dense);
}

/** Content-addressed reference id derived from the canonical fingerprint. */
export function fingerprintId(json: string): string {
  return `vref_${new Bun.CryptoHasher("sha256").update(json).digest("hex")}`;
}
