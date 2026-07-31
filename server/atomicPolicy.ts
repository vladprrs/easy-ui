import type { Database } from "bun:sqlite";
import { ApiError } from "./http";

/** Metadata shared by published TSX components and v2 compositions. */
export type AtomicPolicyMetadata = {
  atomicLevel?: string;
  ownership?: { reason?: string };
};

export type AtomicPolicyArtifactKind = "component" | "composition";

/** Returns the persisted rollout boundary rather than reading process state. */
export function atomicPolicyActivation(db: Database): { activatedAt: string; policyVersion: number } {
  const row = db.query("SELECT activated_at activatedAt,policy_version policyVersion FROM atomic_policy WHERE id=1")
    .get() as { activatedAt: string; policyVersion: number } | null;
  // Databases created before v21 are upgraded by migrate(); this fallback keeps
  // direct unit-test databases useful when a caller deliberately supplies a mock.
  return row ?? { activatedAt: new Date(0).toISOString(), policyVersion: 1 };
}

/**
 * Enforces the new-artifact half of the Atomic Design policy. Legacy artifacts
 * remain publishable during the audited migration, while every newly authored
 * molecule/organism must explain why declarative composition is insufficient.
 */
export function assertAtomicPolicy(
  db: Database,
  kind: AtomicPolicyArtifactKind,
  id: string,
  metadata: AtomicPolicyMetadata,
): void {
  // Composition is the declarative representation prescribed by the policy. The
  // irreducibility exception applies only to standalone TSX bundles.
  if (kind !== "component") return;
  if (metadata.atomicLevel !== "molecule" && metadata.atomicLevel !== "organism") return;
  const created = db.query(`SELECT created_at createdAt FROM ${kind === "component" ? "components" : "compositions"} WHERE id=?`)
    .get(id) as { createdAt: string } | null;
  if (!created) return;
  const policy = atomicPolicyActivation(db);
  if (created.createdAt < policy.activatedAt) return;
  if (metadata.ownership?.reason?.trim()) return;
  throw new ApiError(422, "atomic_policy_violation", `${kind} ${metadata.atomicLevel} requires ownership.reason`, {
    issues: [{ path: ["ownership", "reason"], message: `${metadata.atomicLevel} artifacts created after atomic policy activation must explain why they are irreducible code` }],
  });
}
