import { canonicalStringify } from "../../src/capture/canonicalJson";
import type { JsonValue } from "../../src/prototype/schema";

/** The two catalog artifact kinds that can participate in a replacement. */
export type ArtifactKind = "component" | "composition";

/** A catalog identity. Version is optional because replacement rows are artifact-scoped. */
export interface ArtifactKey {
  kind: ArtifactKind;
  id: string;
  designSystem: string;
  version?: number;
}

export interface PropMigration {
  rename?: Readonly<Record<string, string>>;
  defaults?: Readonly<Record<string, JsonValue>>;
  enumMap?: Readonly<Record<string, Readonly<Record<string, JsonValue>>>>;
  drop?: readonly string[];
}

export interface EventMigration {
  rename?: Readonly<Record<string, string>>;
  payloadMap?: Readonly<Record<string, string>>;
  /** Optional extension used by an explicitly approved exception. */
  drop?: readonly string[];
}

export interface SlotMigration {
  rename?: Readonly<Record<string, string>>;
  defaultTarget?: string;
  /** Optional extension used by an explicitly approved exception. */
  drop?: readonly string[];
}

/** Extra declarative data needed when a component is converted to a composition reference. */
export interface CompositionMigration {
  id: string;
  /** Source prop name → declared composition parameter name. */
  paramMap?: Readonly<Record<string, string>>;
  /** Existing child slot name → declared composition slot name. */
  slotMap?: Readonly<Record<string, string>>;
  /** Target for unassigned children and unmapped source slots. */
  defaultSlot?: string;
  /** Optional target contract used by the pure adapter to catch invalid routing early. */
  declaredSlots?: readonly string[];
}

/** A serializable, artifact-specific migration program. */
export interface MigrationAdapter {
  /** Source element type → target element type. */
  typeMap: Readonly<Record<string, string>>;
  /** Rules are keyed by the source type, which makes a second application a no-op. */
  props: Readonly<Record<string, PropMigration>>;
  /** Rules are keyed by the source type. */
  events?: Readonly<Record<string, EventMigration>>;
  slots?: SlotMigration;
  composition?: CompositionMigration;
}

export interface CatalogMigrationGroup {
  canonical: ArtifactKey;
  retired: ArtifactKey[];
  confidence: number;
  reasons: string[];
  adapter: MigrationAdapter;
  affectedPrototypeHeads: string[];
  affectedCompositionHeads: string[];
  immutableUsages: Array<{ resourceId: string; version: number }>;
}

export interface CompositionConversion {
  from: ArtifactKey;
  toCompositionId: string;
  doc: CompositionDocV2;
  adapter: MigrationAdapter;
}

export interface ArtifactMetadataRevision {
  artifact: ArtifactKey;
  revision?: number;
  patch: Record<string, JsonValue>;
  reason: string;
}

export interface DocumentedException {
  id: string;
  reason: string;
  artifact?: ArtifactKey;
  scope?: string;
  provenance?: string;
}

export interface CompositionParamV2 {
  type: "string" | "number" | "boolean" | "json" | "asset";
  required?: boolean;
  default?: JsonValue;
  description?: string;
}

export interface CompositionElementV2 {
  type: string;
  props: Record<string, unknown>;
  children?: string[];
  visible?: unknown;
  on?: Record<string, unknown>;
  region?: string;
  slot?: string;
  repeat?: Record<string, unknown>;
}

export interface CompositionDocV2 {
  version: 2;
  name: string;
  description?: string;
  atomicLevel: "molecule" | "organism" | "template" | "page";
  scope?: "section" | "shell" | "screen";
  canonicalFor?: string[];
  ownership?: { reason: string; provenance?: string };
  replacement?: string;
  params: Record<string, CompositionParamV2>;
  slots: string[];
  spec: { root: string; elements: Record<string, CompositionElementV2> };
  provenance?: { source?: string; figmaNodeId?: string };
}

export interface CatalogMigrationPlan {
  version: 1;
  generatedAt: string;
  catalogRevision: string;
  dataFingerprint: string;
  groups: CatalogMigrationGroup[];
  compositionConversions: CompositionConversion[];
  metadataRevisions: ArtifactMetadataRevision[];
  documentedExceptions: DocumentedException[];
}

export type CatalogMigrationPlanInput = Omit<CatalogMigrationPlan, "version">;

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareOptionalNumber = (left: number | undefined, right: number | undefined): number => {
  const a = left ?? -1;
  const b = right ?? -1;
  return a - b;
};

/** Stable ordering for artifact identities, independent of host locale. */
export function compareArtifactKeys(left: ArtifactKey, right: ArtifactKey): number {
  return compareText(left.kind, right.kind)
    || compareText(left.designSystem, right.designSystem)
    || compareText(left.id, right.id)
    || compareOptionalNumber(left.version, right.version);
}

const clone = <T>(value: T): T => structuredClone(value);

const sortUnique = (values: readonly string[] | undefined): string[] =>
  [...new Set(values ?? [])].sort(compareText);

const uniqueByCanonical = <T>(values: readonly T[]): T[] => {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identity = canonicalStringify(value);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
};

const sortedRecord = <T>(record: Readonly<Record<string, T>> | undefined, map: (value: T) => T = clone): Record<string, T> =>
  Object.fromEntries(Object.entries(record ?? {}).sort(([left], [right]) => compareText(left, right)).map(([key, value]) => [key, map(value)]));

const normalizePropMigration = (rule: PropMigration): PropMigration => ({
  ...(rule.rename === undefined ? {} : { rename: sortedRecord(rule.rename, (value) => value) }),
  ...(rule.defaults === undefined ? {} : { defaults: sortedRecord(rule.defaults) }),
  ...(rule.enumMap === undefined ? {} : {
    enumMap: sortedRecord(rule.enumMap, (value) => sortedRecord(value)),
  }),
  ...(rule.drop === undefined ? {} : { drop: sortUnique(rule.drop) }),
});

const normalizeEventMigration = (rule: EventMigration): EventMigration => ({
  ...(rule.rename === undefined ? {} : { rename: sortedRecord(rule.rename, (value) => value) }),
  ...(rule.payloadMap === undefined ? {} : { payloadMap: sortedRecord(rule.payloadMap, (value) => value) }),
  ...(rule.drop === undefined ? {} : { drop: sortUnique(rule.drop) }),
});

const normalizeAdapter = (adapter: MigrationAdapter): MigrationAdapter => ({
  typeMap: sortedRecord(adapter.typeMap, (value) => value),
  props: sortedRecord(adapter.props, normalizePropMigration),
  ...(adapter.events === undefined ? {} : { events: sortedRecord(adapter.events, normalizeEventMigration) }),
  ...(adapter.slots === undefined ? {} : {
    slots: {
      ...(adapter.slots.rename === undefined ? {} : { rename: sortedRecord(adapter.slots.rename, (value) => value) }),
      ...(adapter.slots.defaultTarget === undefined ? {} : { defaultTarget: adapter.slots.defaultTarget }),
      ...(adapter.slots.drop === undefined ? {} : { drop: sortUnique(adapter.slots.drop) }),
    },
  }),
  ...(adapter.composition === undefined ? {} : {
    composition: {
      id: adapter.composition.id,
      ...(adapter.composition.paramMap === undefined ? {} : { paramMap: sortedRecord(adapter.composition.paramMap, (value) => value) }),
      ...(adapter.composition.slotMap === undefined ? {} : { slotMap: sortedRecord(adapter.composition.slotMap, (value) => value) }),
      ...(adapter.composition.defaultSlot === undefined ? {} : { defaultSlot: adapter.composition.defaultSlot }),
      ...(adapter.composition.declaredSlots === undefined ? {} : { declaredSlots: sortUnique(adapter.composition.declaredSlots) }),
    },
  }),
});

const normalizeKey = (key: ArtifactKey): ArtifactKey => ({
  kind: key.kind,
  id: key.id,
  designSystem: key.designSystem,
  ...(key.version === undefined ? {} : { version: key.version }),
});

const normalizeArtifactKeys = (keys: readonly ArtifactKey[]): ArtifactKey[] =>
  uniqueByCanonical(keys.map(normalizeKey)).sort(compareArtifactKeys);

const compareUsages = (left: { resourceId: string; version: number }, right: { resourceId: string; version: number }): number =>
  compareText(left.resourceId, right.resourceId) || left.version - right.version;

const normalizeUsages = (usages: readonly { resourceId: string; version: number }[]): Array<{ resourceId: string; version: number }> =>
  uniqueByCanonical(usages.map((usage) => ({ resourceId: usage.resourceId, version: usage.version }))).sort(compareUsages);

const compareGroups = (left: CatalogMigrationGroup, right: CatalogMigrationGroup): number => {
  const byCanonical = compareArtifactKeys(left.canonical, right.canonical);
  if (byCanonical) return byCanonical;
  const leftRetired = left.retired.map((key) => canonicalStringify(key)).join("\u0000");
  const rightRetired = right.retired.map((key) => canonicalStringify(key)).join("\u0000");
  return compareText(leftRetired, rightRetired) || compareText(canonicalStringify(left), canonicalStringify(right));
};

/**
 * Returns a fresh plan with all set-like collections sorted. Document/spec arrays retain their
 * authored order; only migration-plan collections are reordered.
 */
export function normalizeCatalogMigrationPlan(plan: CatalogMigrationPlan): CatalogMigrationPlan {
  const groups = plan.groups.map((group) => ({
    canonical: normalizeKey(group.canonical),
    retired: normalizeArtifactKeys(group.retired),
    confidence: group.confidence,
    reasons: sortUnique(group.reasons),
    adapter: normalizeAdapter(group.adapter),
    affectedPrototypeHeads: sortUnique(group.affectedPrototypeHeads),
    affectedCompositionHeads: sortUnique(group.affectedCompositionHeads),
    immutableUsages: normalizeUsages(group.immutableUsages),
  })).sort(compareGroups);

  const compositionConversions = plan.compositionConversions.map((conversion) => ({
    from: normalizeKey(conversion.from),
    toCompositionId: conversion.toCompositionId,
    doc: clone(conversion.doc),
    adapter: normalizeAdapter(conversion.adapter),
  })).sort((left, right) => compareArtifactKeys(left.from, right.from)
    || compareText(left.toCompositionId, right.toCompositionId)
    || compareText(canonicalStringify(left), canonicalStringify(right)));

  const metadataRevisions = plan.metadataRevisions.map((revision) => ({
    artifact: normalizeKey(revision.artifact),
    ...(revision.revision === undefined ? {} : { revision: revision.revision }),
    patch: clone(revision.patch),
    reason: revision.reason,
  })).sort((left, right) => compareArtifactKeys(left.artifact, right.artifact)
    || (left.revision ?? -1) - (right.revision ?? -1)
    || compareText(left.reason, right.reason)
    || compareText(canonicalStringify(left), canonicalStringify(right)));

  const documentedExceptions = plan.documentedExceptions.map((exception) => ({
    id: exception.id,
    reason: exception.reason,
    ...(exception.artifact === undefined ? {} : { artifact: normalizeKey(exception.artifact) }),
    ...(exception.scope === undefined ? {} : { scope: exception.scope }),
    ...(exception.provenance === undefined ? {} : { provenance: exception.provenance }),
  })).sort((left, right) => compareText(left.id, right.id)
    || compareArtifactKeys(left.artifact ?? { kind: "component", id: "", designSystem: "" }, right.artifact ?? { kind: "component", id: "", designSystem: "" })
    || compareText(canonicalStringify(left), canonicalStringify(right)));

  return {
    version: 1,
    generatedAt: plan.generatedAt,
    catalogRevision: plan.catalogRevision,
    dataFingerprint: plan.dataFingerprint,
    groups,
    compositionConversions,
    metadataRevisions,
    documentedExceptions,
  };
}

/** Canonical JSON used for audit artifacts and plan identity checks. */
export function serializeCatalogMigrationPlan(plan: CatalogMigrationPlan): string {
  return canonicalStringify(normalizeCatalogMigrationPlan(plan));
}

/**
 * Plan identity excludes report timing metadata. The snapshot fingerprints and normalized
 * operations identify the executable plan; `generatedAt` remains available in the serialized
 * plan and audit report for operator-facing metadata.
 */
const serializeCatalogMigrationPlanIdentity = (plan: CatalogMigrationPlan): string => {
  const normalized = normalizeCatalogMigrationPlan(plan);
  const identity = {
    version: normalized.version,
    catalogRevision: normalized.catalogRevision,
    dataFingerprint: normalized.dataFingerprint,
    groups: normalized.groups,
    compositionConversions: normalized.compositionConversions,
    metadataRevisions: normalized.metadataRevisions,
    documentedExceptions: normalized.documentedExceptions,
  };
  return canonicalStringify(identity);
};

/** SHA-256 of the canonical serialized migration plan. */
export function hashCatalogMigrationPlan(plan: CatalogMigrationPlan): string {
  return new Bun.CryptoHasher("sha256").update(serializeCatalogMigrationPlanIdentity(plan)).digest("hex");
}

/** Alias used by callers that treat the hash as the plan's content address. */
export const catalogMigrationPlanHash = hashCatalogMigrationPlan;

/** Build and normalize a version-1 plan, rejecting malformed confidence values early. */
export function createCatalogMigrationPlan(input: CatalogMigrationPlanInput): CatalogMigrationPlan {
  for (const group of input.groups) {
    if (!Number.isFinite(group.confidence) || group.confidence < 0 || group.confidence > 1) {
      throw new RangeError(`migration confidence must be between 0 and 1: ${group.confidence}`);
    }
    if (group.adapter === undefined || group.adapter.typeMap === undefined || group.adapter.props === undefined) {
      throw new TypeError("every migration group requires a concrete adapter");
    }
  }
  return normalizeCatalogMigrationPlan({ version: 1, ...input });
}

// ───────────────────────────── canonical selection ─────────────────────────

export interface StablePublication {
  version: number;
  publishedAt: string;
}

/** Normalized audit input for deterministic canonical selection. */
export interface CanonicalSelectionCandidate {
  artifact: ArtifactKey;
  active: boolean;
  deprecated: boolean;
  canonicalRoleValid: boolean;
  currentHeadUsageCount: number;
  visualReferencePass: boolean;
  architectureMetadataComplete: boolean;
  stablePublication?: StablePublication;
}

const boolRank = (value: boolean): number => value ? 1 : 0;

/**
 * Comparator implementing the production audit order:
 * active, valid canonical role, current-head usage, visual pass, complete metadata,
 * then the oldest stable publication and finally the artifact key.
 */
export function compareCanonicalSelection(left: CanonicalSelectionCandidate, right: CanonicalSelectionCandidate): number {
  const active = boolRank(right.active && !right.deprecated) - boolRank(left.active && !left.deprecated);
  if (active) return active;
  const role = boolRank(right.canonicalRoleValid) - boolRank(left.canonicalRoleValid);
  if (role) return role;
  const usage = right.currentHeadUsageCount - left.currentHeadUsageCount;
  if (usage) return usage;
  const visual = boolRank(right.visualReferencePass) - boolRank(left.visualReferencePass);
  if (visual) return visual;
  const metadata = boolRank(right.architectureMetadataComplete) - boolRank(left.architectureMetadataComplete);
  if (metadata) return metadata;

  const leftPublication = left.stablePublication;
  const rightPublication = right.stablePublication;
  if (leftPublication === undefined || rightPublication === undefined) {
    if (leftPublication !== rightPublication) return leftPublication === undefined ? 1 : -1;
  } else {
    const date = compareText(leftPublication.publishedAt, rightPublication.publishedAt);
    if (date) return date;
    const version = leftPublication.version - rightPublication.version;
    if (version) return version;
  }
  return compareArtifactKeys(left.artifact, right.artifact);
}

/** Returns a new array; the caller's candidate order is never used as a tie-breaker. */
export function canonicalSelectionOrdering(candidates: readonly CanonicalSelectionCandidate[]): CanonicalSelectionCandidate[] {
  return [...candidates].sort(compareCanonicalSelection);
}

export const orderCanonicalCandidates = canonicalSelectionOrdering;

export function selectCanonicalArtifact(candidates: readonly CanonicalSelectionCandidate[]): CanonicalSelectionCandidate {
  const [canonical] = canonicalSelectionOrdering(candidates);
  if (canonical === undefined) throw new RangeError("cannot select a canonical artifact from an empty set");
  return canonical;
}

export const canonicalSelection = selectCanonicalArtifact;
