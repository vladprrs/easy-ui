import { describe, expect, test } from "bun:test";
import {
  canonicalSelectionOrdering,
  createCatalogMigrationPlan,
  hashCatalogMigrationPlan,
  selectCanonicalArtifact,
  serializeCatalogMigrationPlan,
  type ArtifactKey,
  type CanonicalSelectionCandidate,
  type CatalogMigrationPlanInput,
} from "./migrationPlan";

const key = (id: string, version?: number): ArtifactKey => ({ kind: "component", id, designSystem: "yandex-pay", ...(version === undefined ? {} : { version }) });

const candidate = (id: string, overrides: Partial<CanonicalSelectionCandidate> = {}): CanonicalSelectionCandidate => ({
  artifact: key(id),
  active: true,
  deprecated: false,
  canonicalRoleValid: false,
  currentHeadUsageCount: 0,
  visualReferencePass: false,
  architectureMetadataComplete: false,
  ...overrides,
});

const adapter = { typeMap: {}, props: {} } as const;

const planInput = (overrides: Partial<CatalogMigrationPlanInput> = {}): CatalogMigrationPlanInput => ({
  generatedAt: "2026-07-31T00:00:00.000Z",
  catalogRevision: "catalog-rev",
  dataFingerprint: "data-fingerprint",
  groups: [{
    canonical: key("canonical", 2),
    retired: [key("z-retired"), key("a-retired")],
    confidence: 0.9,
    reasons: ["source", "canonical role", "source"],
    adapter,
    affectedPrototypeHeads: ["proto-b", "proto-a", "proto-a"],
    affectedCompositionHeads: ["comp-b", "comp-a"],
    immutableUsages: [{ resourceId: "proto-b", version: 2 }, { resourceId: "proto-a", version: 1 }],
  }],
  compositionConversions: [],
  metadataRevisions: [],
  documentedExceptions: [],
  ...overrides,
});

describe("canonical selection", () => {
  test("uses the specified priority order and never uses input order", () => {
    const deprecatedButBusy = candidate("deprecated-busy", { active: false, deprecated: true, currentHeadUsageCount: 100 });
    const validRole = candidate("valid-role", { canonicalRoleValid: true, currentHeadUsageCount: 1 });
    const busy = candidate("busy", { currentHeadUsageCount: 2 });
    const visual = candidate("visual", { visualReferencePass: true, currentHeadUsageCount: 2 });
    const complete = candidate("complete", { visualReferencePass: true, architectureMetadataComplete: true, currentHeadUsageCount: 2 });
    const old = candidate("old", {
      visualReferencePass: true,
      architectureMetadataComplete: true,
      currentHeadUsageCount: 2,
      stablePublication: { version: 1, publishedAt: "2026-01-01T00:00:00.000Z" },
    });
    const newest = candidate("newest", {
      visualReferencePass: true,
      architectureMetadataComplete: true,
      currentHeadUsageCount: 2,
      stablePublication: { version: 2, publishedAt: "2026-02-01T00:00:00.000Z" },
    });

    expect(canonicalSelectionOrdering([newest, deprecatedButBusy, old, complete, visual, busy, validRole]).map((item) => item.artifact.id))
      .toEqual(["valid-role", "old", "newest", "complete", "visual", "busy", "deprecated-busy"]);
    expect(selectCanonicalArtifact([newest, old]).artifact.id).toBe("old");
  });

  test("breaks a complete tie by the artifact key, not by input order", () => {
    const first = candidate("a");
    const second = candidate("b");
    expect(canonicalSelectionOrdering([second, first]).map((item) => item.artifact.id)).toEqual(["a", "b"]);
  });
});

describe("CatalogMigrationPlan serialization", () => {
  test("normalizes unordered collections and hashes the stable representation", () => {
    const first = createCatalogMigrationPlan(planInput());
    const second = createCatalogMigrationPlan(planInput({
      groups: [{
        ...first.groups[0]!,
        retired: [...first.groups[0]!.retired].reverse(),
        reasons: ["source", "canonical role"],
        affectedPrototypeHeads: ["proto-a", "proto-b"],
        affectedCompositionHeads: ["comp-a", "comp-b", "comp-a"],
        immutableUsages: [...first.groups[0]!.immutableUsages, { resourceId: "proto-a", version: 1 }].reverse(),
      }],
      generatedAt: "2026-08-01T00:00:00.000Z",
    }));

    expect(first.groups[0]!.retired.map((item) => item.id)).toEqual(["a-retired", "z-retired"]);
    expect(first.groups[0]!.affectedPrototypeHeads).toEqual(["proto-a", "proto-b"]);
    expect(first.groups[0]!.immutableUsages).toEqual([{ resourceId: "proto-a", version: 1 }, { resourceId: "proto-b", version: 2 }]);
    expect(second.groups[0]!.affectedCompositionHeads).toEqual(["comp-a", "comp-b"]);
    expect(serializeCatalogMigrationPlan(first)).not.toBe(serializeCatalogMigrationPlan(second));
    expect(hashCatalogMigrationPlan(first)).toBe(hashCatalogMigrationPlan(second));
    expect(hashCatalogMigrationPlan(first)).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("dedupes repeated artifact and usage coordinates", () => {
    const plan = createCatalogMigrationPlan(planInput({
      groups: [{
        ...planInput().groups[0]!,
        retired: [key("a-retired"), key("a-retired"), key("z-retired")],
        immutableUsages: [{ resourceId: "proto-a", version: 1 }, { resourceId: "proto-a", version: 1 }, { resourceId: "proto-b", version: 2 }],
      }],
    }));
    expect(plan.groups[0]!.retired.map((item) => item.id)).toEqual(["a-retired", "z-retired"]);
    expect(plan.groups[0]!.immutableUsages).toEqual([{ resourceId: "proto-a", version: 1 }, { resourceId: "proto-b", version: 2 }]);
  });

  test("rejects a confidence outside the executable plan range", () => {
    expect(() => createCatalogMigrationPlan(planInput({ groups: [{ ...planInput().groups[0]!, confidence: 1.1 }] }))).toThrow(RangeError);
  });
});
