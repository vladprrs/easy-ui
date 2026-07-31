import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { canonicalStringify } from "../../src/capture/canonicalJson";
import { sourceShingles, structuralFingerprint } from "./fingerprint";
import { currentCatalogRevision, currentDataFingerprint } from "../migrationRunner";
import { collectCorpus } from "./corpus";
import { matchCandidates, type ProposedArtifact } from "./matcher";
import { CALIBRATED_POLICY } from "./policy";
import { compareArtifactKeys, createCatalogMigrationPlan, selectCanonicalArtifact, type ArtifactKey, type CanonicalSelectionCandidate, type CatalogMigrationPlan } from "./migrationPlan";

const canonicalRoleSlugs = new Set<string>((JSON.parse(readFileSync(new URL("./roles.json", import.meta.url), "utf8")) as { roles?: Array<{ slug?: unknown }> }).roles
  ?.map((role) => role.slug).filter((slug): slug is string => typeof slug === "string") ?? []);

export type AuditClassification =
  | "irreducible-code"
  | "composition-candidate"
  | "semantic-duplicate"
  | "metadata-only-fix"
  | "deprecated-unused"
  | "documented-exception";

export interface CatalogAuditArtifact {
  artifact: ArtifactKey;
  name: string;
  version: number;
  active: boolean;
  deprecated: boolean;
  atomicLevel?: string;
  scope?: string;
  canonicalFor: string[];
  /** Declared justification for keeping a composite artifact as code (atomic policy §5). */
  ownershipReason?: string;
  currentHeadUsageCount: number;
  immutableUsageCount: number;
  classification: AuditClassification;
  dependencyGraph: ArtifactKey[];
}

export interface CatalogDuplicateGroup {
  canonical: ArtifactKey;
  retired: ArtifactKey[];
  confidence: number;
  reason: string;
}

export interface CatalogAuditReport {
  generatedAt: string;
  catalogRevision: string;
  dataFingerprint: string;
  artifacts: CatalogAuditArtifact[];
  duplicateGroups: CatalogDuplicateGroup[];
  plan: CatalogMigrationPlan;
}

type ComponentRow = {
  id: string;
  name: string;
  designSystem: string;
  version: number;
  status: string;
  source: string;
  definitionMeta: string;
  publishedAt: string;
};

type CompositionRow = {
  id: string;
  name: string;
  designSystem: string;
  version: number;
  status: string;
  doc: string;
  dependencyManifest: string | null;
  publishedAt: string;
};

type ManifestDependencyEntry = { id: string; version?: number };
type CompositionUsageIndex = {
  components: Map<string, Set<string>>;
  compositions: Map<string, Set<string>>;
};

const parseObject = (value: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

const strings = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.filter((item): item is string => typeof item === "string"))].sort()
  : [];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const elementsOf = (document: Record<string, unknown>): Record<string, unknown> => {
  const spec = isRecord(document.spec) ? document.spec : {};
  return isRecord(spec.elements) ? spec.elements : {};
};

const manifestEntries = (raw: string | null, field: "components" | "compositions"): ManifestDependencyEntry[] => {
  if (raw === null || raw === "[]") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed[field])) return [];
    return parsed[field].flatMap((entry): ManifestDependencyEntry[] => {
      if (!isRecord(entry) || typeof entry.id !== "string") return [];
      return typeof entry.version === "number" && Number.isFinite(entry.version)
        ? [{ id: entry.id, version: entry.version }]
        : [{ id: entry.id }];
    });
  } catch {
    // A malformed historical manifest must not make a read-only audit fail. The caller falls
    // back to authored references below, which is conservative for the safe-to-remove decision.
    return [];
  }
};

const usageKey = (id: string, version?: number): string => `${id}\u0000${version === undefined ? "*" : version}`;

const addUsage = (index: Map<string, Set<string>>, id: string, consumerId: string, version?: number): void => {
  const key = usageKey(id, version);
  const consumers = index.get(key) ?? new Set<string>();
  consumers.add(consumerId);
  index.set(key, consumers);
};

const usageCount = (index: Map<string, Set<string>>, id: string, version: number): number =>
  new Set([
    ...(index.get(usageKey(id, version)) ?? []),
    ...(index.get(usageKey(id)) ?? []),
  ]).size;

const metaOf = (row: ComponentRow): Record<string, unknown> => parseObject(row.definitionMeta);

const componentSignature = (row: ComponentRow): string => {
  const meta = metaOf(row);
  // The audit intentionally compares normalized structure and IO, never runtime values.
  const source = row.source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/\s+/g, " ").trim();
  return canonicalStringify({
    kind: "component",
    source,
    props: meta.propsJsonSchema ?? null,
    events: strings(meta.events),
    slots: strings(meta.slots),
  });
};

const compositionSignature = (row: CompositionRow): string => {
  const doc = parseObject(row.doc);
  const spec = isRecord(doc.spec) ? doc.spec : {};
  const elements = elementsOf(doc);
  return canonicalStringify({
    kind: "composition",
    params: doc.params ?? {},
    slots: doc.slots ?? [],
    root: typeof spec.root === "string" ? spec.root : "",
    elements,
  });
};

const ownershipReason = (value: unknown): string | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const reason = (value as { reason?: unknown }).reason;
  return typeof reason === "string" && reason.trim() ? reason.trim() : undefined;
};

const artifactMeta = (artifact: ArtifactKey, row: ComponentRow | CompositionRow): { atomicLevel?: string; scope?: string; canonicalFor: string[]; ownershipReason?: string } => {
  if (artifact.kind === "component") {
    const meta = metaOf(row as ComponentRow);
    return {
      atomicLevel: typeof meta.atomicLevel === "string" ? meta.atomicLevel : undefined,
      scope: typeof meta.scope === "string" ? meta.scope : undefined,
      canonicalFor: strings(meta.canonicalFor),
      ownershipReason: ownershipReason(meta.ownership),
    };
  }
  const doc = parseObject((row as CompositionRow).doc);
  return {
    atomicLevel: typeof doc.atomicLevel === "string" ? doc.atomicLevel : undefined,
    scope: typeof doc.scope === "string" ? doc.scope : undefined,
    canonicalFor: strings(doc.canonicalFor),
    ownershipReason: ownershipReason(doc.ownership),
  };
};

/**
 * Atomic Design classification of a published TSX component.
 *
 * `scope` deliberately plays no part: it is optional architecture metadata that no production
 * component declares, and the codebase forbids inferring it (`src/designSystems/scope.ts`).
 * Gating on it would label every molecule and organism `metadata-only-fix` and hide the whole
 * point of the audit — which artifacts should become compositions.
 */
const classifyComponent = (
  meta: { atomicLevel?: string; ownershipReason?: string },
  deprecatedAndUnused: boolean,
): AuditClassification => {
  if (deprecatedAndUnused) return "deprecated-unused";
  if (meta.atomicLevel === undefined) return "metadata-only-fix";
  if (meta.atomicLevel === "atom") return "irreducible-code";
  // A composite level in TSX is a candidate for declarative composition unless its author
  // already justified the irreducibility the atomic policy asks for.
  return meta.ownershipReason === undefined ? "composition-candidate" : "documented-exception";
};

const componentUsage = (db: Database, artifact: ArtifactKey, compositionUsages: CompositionUsageIndex): { current: number; immutable: number } => {
  const current = db.query(`SELECT COUNT(*) n FROM prototype_revision_components prc
    JOIN prototypes p ON p.id=prc.prototype_id AND p.head_rev=prc.rev
    WHERE prc.component_id=? AND prc.component_version=?`).get(artifact.id, artifact.version!) as { n: number };
  return { current: current.n + usageCount(compositionUsages.components, artifact.id, artifact.version!), immutable: immutableUsages(db, artifact).length };
};

const compositionUsage = (db: Database, artifact: ArtifactKey, compositionUsages: CompositionUsageIndex): { current: number; immutable: number } => {
  const current = db.query(`SELECT COUNT(*) n FROM prototype_revision_compositions prc
    JOIN prototypes p ON p.id=prc.prototype_id AND p.head_rev=prc.rev
    WHERE prc.composition_id=? AND prc.composition_version=?`).get(artifact.id, artifact.version!) as { n: number };
  return { current: current.n + usageCount(compositionUsages.compositions, artifact.id, artifact.version!), immutable: immutableUsages(db, artifact).length };
};

const immutableUsages = (db: Database, artifact: ArtifactKey): Array<{ resourceId: string; version: number }> => {
  const table = artifact.kind === "component" ? "prototype_revision_components" : "prototype_revision_compositions";
  const idColumn = artifact.kind === "component" ? "component_id" : "composition_id";
  const pinVersionColumn = artifact.kind === "component" ? "component_version" : "composition_version";
  const rows = db.query(`SELECT DISTINCT pp.prototype_id resourceId,pp.version
    FROM ${table} pins JOIN prototype_publishes pp ON pp.prototype_id=pins.prototype_id AND pp.rev=pins.rev
    WHERE pins.${idColumn}=? AND pins.${pinVersionColumn}=? ORDER BY pp.prototype_id,pp.version`).all(artifact.id, artifact.version!) as Array<{ resourceId: string; version: number }>;
  return rows;
};

const currentHeadUsages = (db: Database, artifact: ArtifactKey): string[] => {
  const table = artifact.kind === "component" ? "prototype_revision_components" : "prototype_revision_compositions";
  const idColumn = artifact.kind === "component" ? "component_id" : "composition_id";
  const pinVersionColumn = artifact.kind === "component" ? "component_version" : "composition_version";
  const rows = db.query(`SELECT DISTINCT pins.prototype_id resourceId FROM ${table} pins
    JOIN prototypes p ON p.id=pins.prototype_id AND p.head_rev=pins.rev
    WHERE pins.${idColumn}=? AND pins.${pinVersionColumn}=? ORDER BY pins.prototype_id`).all(artifact.id, artifact.version!) as Array<{ resourceId: string }>;
  return [...new Set(rows.map((row) => row.resourceId))];
};

const visualReferencePass = (db: Database, artifact: ArtifactKey): boolean => {
  if (artifact.kind !== "component") return false;
  const rows = db.query(`SELECT vr.fingerprint_json fingerprint,run.status,run.diff_percent diffPercent
    FROM visual_references vr LEFT JOIN visual_runs run ON run.reference_id=vr.id AND run.reference_asset_id=vr.asset_id
    WHERE vr.deleted_at IS NULL ORDER BY run.created_at DESC,run.id DESC`).all() as Array<{ fingerprint: string; status: string | null; diffPercent: number | null }>;
  return rows.some((row) => {
    if (row.status !== "pass" || (row.diffPercent !== null && row.diffPercent !== 0)) return false;
    const fingerprint = parseObject(row.fingerprint);
    return fingerprint.scope === "component" && fingerprint.componentId === artifact.id && fingerprint.refVersion === artifact.version;
  });
};

const jaccard = (left: Set<string>, right: Set<string>): number => {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
};

const activeCompositionRows = (rows: readonly CompositionRow[]): CompositionRow[] => rows.filter((row) =>
  row.status === "active" && !rows.some((newer) =>
    newer.id === row.id && newer.status === "active" && newer.version > row.version));

const currentCompositionUsageIndex = (components: readonly ComponentRow[], compositions: readonly CompositionRow[]): CompositionUsageIndex => {
  const activeComponentsByName = new Map<string, { id: string; version: number }>();
  for (const row of components) {
    if (row.status !== "active") continue;
    const key = `${row.designSystem}\u0000${row.name}`;
    const previous = activeComponentsByName.get(key);
    if (previous === undefined || row.version > previous.version) activeComponentsByName.set(key, { id: row.id, version: row.version });
  }

  const activeCompositions = activeCompositionRows(compositions);
  const activeCompositionVersions = new Map<string, number>();
  for (const row of activeCompositions) activeCompositionVersions.set(`${row.designSystem}\u0000${row.id}`, row.version);

  const index: CompositionUsageIndex = { components: new Map(), compositions: new Map() };
  for (const row of activeCompositions) {
    const document = parseObject(row.doc);
    const elements = elementsOf(document);
    const manifestComponentEntries = manifestEntries(row.dependencyManifest, "components");
    const manifestComponentIds = new Set(manifestComponentEntries.map((entry) => entry.id));
    for (const entry of manifestComponentEntries) addUsage(index.components, entry.id, row.id, entry.version);

    for (const raw of Object.values(elements)) {
      if (!isRecord(raw) || typeof raw.type !== "string") continue;
      const component = activeComponentsByName.get(`${row.designSystem}\u0000${raw.type}`);
      if (component !== undefined && !manifestComponentIds.has(component.id)) addUsage(index.components, component.id, row.id, component.version);
    }

    const manifestCompositionEntries = manifestEntries(row.dependencyManifest, "compositions");
    const manifestCompositionIds = new Set(manifestCompositionEntries.map((entry) => entry.id));
    for (const entry of manifestCompositionEntries) {
      if (entry.id !== row.id) addUsage(index.compositions, entry.id, row.id, entry.version);
    }

    for (const raw of Object.values(elements)) {
      if (!isRecord(raw) || raw.type !== "@eui/Composition" || !isRecord(raw.props) || typeof raw.props.composition !== "string") continue;
      const childId = raw.props.composition;
      if (childId === row.id || manifestCompositionIds.has(childId)) continue;
      addUsage(index.compositions, childId, row.id, activeCompositionVersions.get(`${row.designSystem}\u0000${childId}`));
    }
  }
  return index;
};

const currentCompositionUsesComponent = (index: CompositionUsageIndex, id: string, version: number): string[] =>
  [...new Set([
    ...(index.components.get(usageKey(id, version)) ?? []),
    ...(index.components.get(usageKey(id)) ?? []),
  ])].sort();

const currentCompositionUsesComposition = (index: CompositionUsageIndex, id: string, version: number): string[] =>
  [...new Set([
    ...(index.compositions.get(usageKey(id, version)) ?? []),
    ...(index.compositions.get(usageKey(id)) ?? []),
  ])].sort();

const compositionDependencies = (row: CompositionRow): ArtifactKey[] => {
  const doc = parseObject(row.doc);
  const dependencies = Object.values(elementsOf(doc)).flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const element = raw;
    if (element.type !== "@eui/Composition") return [];
    const props = isRecord(element.props) ? element.props : {};
    return typeof props.composition === "string" ? [{ kind: "composition" as const, id: props.composition, designSystem: row.designSystem }] : [];
  });
  const unique = new Map(dependencies.map((dependency) => [canonicalStringify(dependency), dependency]));
  return [...unique.values()].sort(compareArtifactKeys);
};

const selectionCandidate = (artifact: CatalogAuditArtifact, publishedAt?: string, visualReference = false): CanonicalSelectionCandidate => ({
  artifact: artifact.artifact,
  active: artifact.active,
  deprecated: artifact.deprecated,
  canonicalRoleValid: artifact.canonicalFor.length > 0 && artifact.canonicalFor.every((role) => canonicalRoleSlugs.has(role)),
  currentHeadUsageCount: artifact.currentHeadUsageCount,
  visualReferencePass: visualReference,
  architectureMetadataComplete: artifact.atomicLevel !== undefined && artifact.scope !== undefined,
  ...(publishedAt === undefined ? {} : { stablePublication: { version: artifact.version, publishedAt } }),
});

/** Order-independent identity of an unordered artifact pair. */
const pairKey = (left: ArtifactKey, right: ArtifactKey): string => {
  const a = `${left.kind}\0${left.designSystem}\0${left.id}`;
  const b = `${right.kind}\0${right.designSystem}\0${right.id}`;
  return a < b ? `${a}${b}` : `${b}${a}`;
};

/**
 * Blocking pairs according to the enforcement project's calibrated matcher (`CALIBRATED_POLICY`).
 * Every published component is scored against the corpus of its own design system with itself
 * excluded; head drafts in the corpus are ignored because the audit only retires published
 * artifacts. The score is symmetric in practice but not by construction, so a pair blocking in
 * either direction counts — the matcher is the gate's own definition of "already exists".
 */
function calibratedDuplicatePairs(
  db: Database,
  candidates: readonly CatalogAuditArtifact[],
  componentRowsByKey: ReadonlyMap<string, ComponentRow>,
): Map<string, number> {
  const pairs = new Map<string, number>();
  const componentCandidates = candidates.filter((candidate) => candidate.artifact.kind === "component");
  const published = new Set(componentCandidates.map((candidate) => `${candidate.artifact.designSystem}\0${candidate.artifact.id}`));
  const designSystems = [...new Set(componentCandidates.map((candidate) => candidate.artifact.designSystem))].sort();
  for (const designSystem of designSystems) {
    const corpus = collectCorpus(db, designSystem).candidates;
    if (corpus.length < 2) continue;
    for (const candidate of componentCandidates) {
      if (candidate.artifact.designSystem !== designSystem) continue;
      const row = componentRowsByKey.get(`${candidate.artifact.id}\0${designSystem}\0${candidate.version}`);
      if (row === undefined) continue;
      const meta = metaOf(row);
      const proposed: ProposedArtifact = {
        kind: "component",
        id: candidate.artifact.id,
        name: candidate.name,
        designSystem,
        description: typeof meta.description === "string" ? meta.description : "",
        source: row.source,
        ...(candidate.atomicLevel === undefined ? {} : { atomicLevel: candidate.atomicLevel }),
        ...(candidate.scope === undefined ? {} : { scope: candidate.scope }),
        ...(candidate.canonicalFor.length ? { canonicalFor: candidate.canonicalFor } : {}),
        meta: { propsJsonSchema: meta.propsJsonSchema, events: strings(meta.events), slots: strings(meta.slots) },
      };
      const result = matchCandidates(corpus, proposed, CALIBRATED_POLICY, { exclude: { designSystem, id: candidate.artifact.id } });
      for (const blocking of result.blocking) {
        if (blocking.draft || !published.has(`${designSystem}\0${blocking.id}`)) continue;
        const key = pairKey(candidate.artifact, { kind: "component", id: blocking.id, designSystem });
        pairs.set(key, Math.max(pairs.get(key) ?? 0, blocking.score));
      }
    }
  }
  return pairs;
}

/**
 * Read-only production audit. All reads execute in one SQLite transaction and the function does
 * not populate caches or write an audit row; the returned plan is the only materialized output.
 */
export function auditCatalog(db: Database): CatalogAuditReport {
  return db.transaction(() => {
    const generatedAt = new Date().toISOString();
    const catalogRevision = currentCatalogRevision(db);
    const dataFingerprint = currentDataFingerprint(db);
    const components = db.query(`SELECT c.id,c.name,r.design_system designSystem,p.version,p.status,r.source,p.definition_meta definitionMeta,p.published_at publishedAt
      FROM components c JOIN component_publishes p ON p.component_id=c.id
      JOIN component_revisions r ON r.component_id=p.component_id AND r.rev=p.rev
      WHERE c.deleted_at IS NULL AND p.status IN ('active','deprecated','superseded')
      ORDER BY r.design_system,c.id,p.version`).all() as ComponentRow[];
    const compositions = db.query(`SELECT c.id,c.name,c.design_system designSystem,p.version,p.status,r.doc,p.dependency_manifest_json dependencyManifest,p.published_at publishedAt
      FROM compositions c JOIN composition_publishes p ON p.composition_id=c.id
      JOIN composition_revisions r ON r.composition_id=p.composition_id AND r.rev=p.rev
      WHERE c.deleted_at IS NULL AND p.status IN ('active','deprecated','superseded')
      ORDER BY c.design_system,c.id,p.version`).all() as CompositionRow[];
    const compositionUsages = currentCompositionUsageIndex(components, compositions);
    const artifacts: CatalogAuditArtifact[] = [];
    for (const row of components) {
      const artifact: ArtifactKey = { kind: "component", id: row.id, designSystem: row.designSystem, version: row.version };
      const meta = artifactMeta(artifact, row);
      const usage = componentUsage(db, artifact, compositionUsages);
      const classification = classifyComponent(meta, row.status !== "active" && usage.current === 0);
      const entry = { artifact, name: row.name, version: row.version, active: row.status === "active", deprecated: row.status !== "active", ...meta, currentHeadUsageCount: usage.current, immutableUsageCount: usage.immutable, classification, dependencyGraph: [] } satisfies CatalogAuditArtifact;
      artifacts.push(entry);
    }
    for (const row of compositions) {
      const artifact: ArtifactKey = { kind: "composition", id: row.id, designSystem: row.designSystem, version: row.version };
      const meta = artifactMeta(artifact, row);
      const usage = compositionUsage(db, artifact, compositionUsages);
      const classification: AuditClassification = row.status !== "active" && usage.current === 0 ? "deprecated-unused" : meta.atomicLevel === undefined ? "metadata-only-fix" : "irreducible-code";
      const entry = { artifact, name: row.name, version: row.version, active: row.status === "active", deprecated: row.status !== "active", ...meta, currentHeadUsageCount: usage.current, immutableUsageCount: usage.immutable, classification, dependencyGraph: compositionDependencies(row) } satisfies CatalogAuditArtifact;
      artifacts.push(entry);
    }

    const duplicateGroups: CatalogDuplicateGroup[] = [];
    const planGroups: CatalogMigrationPlan["groups"] = [];
    const componentRowsByKey = new Map(components.map((row) => [`${row.id}\0${row.designSystem}\0${row.version}`, row]));
    const compositionRowsByKey = new Map(compositions.map((row) => [`${row.id}\0${row.designSystem}\0${row.version}`, row]));
    const latestByArtifact = new Map<string, CatalogAuditArtifact>();
    for (const artifact of artifacts) {
      const key = `${artifact.artifact.kind}\0${artifact.artifact.designSystem}\0${artifact.artifact.id}`;
      const previous = latestByArtifact.get(key);
      if (previous === undefined || artifact.version > previous.version) latestByArtifact.set(key, artifact);
    }
    const candidates = [...latestByArtifact.values()].sort((left, right) => compareArtifactKeys(left.artifact, right.artifact));
    // Design §6.1: the audit applies the *calibrated* matcher of the enforcement project rather
    // than a private similarity rule, so what the gate refuses to create is exactly what the
    // audit proposes to retire. Exact-signature grouping below stays as a cheap superset.
    const matcherPairs = calibratedDuplicatePairs(db, candidates, componentRowsByKey);
    const groups: CatalogAuditArtifact[][] = [];
    const sameSignature = (left: CatalogAuditArtifact, right: CatalogAuditArtifact): boolean => {
      if (left.artifact.kind !== right.artifact.kind || left.artifact.designSystem !== right.artifact.designSystem || left.artifact.id === right.artifact.id) return false;
      if (left.artifact.kind === "composition") {
        const leftRow = compositionRowsByKey.get(`${left.artifact.id}\0${left.artifact.designSystem}\0${left.version}`);
        const rightRow = compositionRowsByKey.get(`${right.artifact.id}\0${right.artifact.designSystem}\0${right.version}`);
        return leftRow !== undefined && rightRow !== undefined && compositionSignature(leftRow) === compositionSignature(rightRow);
      }
      const leftRow = componentRowsByKey.get(`${left.artifact.id}\0${left.artifact.designSystem}\0${left.version}`);
      const rightRow = componentRowsByKey.get(`${right.artifact.id}\0${right.artifact.designSystem}\0${right.version}`);
      if (leftRow === undefined || rightRow === undefined) return false;
      if (componentSignature(leftRow) === componentSignature(rightRow)) return true;
      if (matcherPairs.has(pairKey(left.artifact, right.artifact))) return true;
      const leftStructural = structuralFingerprint(metaOf(leftRow));
      const rightStructural = structuralFingerprint(metaOf(rightRow));
      return leftStructural !== undefined && leftStructural === rightStructural && jaccard(sourceShingles(leftRow.source), sourceShingles(rightRow.source)) >= 0.82;
    };
    for (const candidate of candidates) {
      const group = groups.find((members) => members.some((member) => sameSignature(candidate, member)));
      if (group) group.push(candidate);
      else groups.push([candidate]);
    }
    for (const candidatesInGroup of groups) {
      if (candidatesInGroup.length < 2) continue;
      const visual = (candidate: CatalogAuditArtifact): boolean => visualReferencePass(db, candidate.artifact);
      const selected = selectCanonicalArtifact(candidatesInGroup.map((candidate) => {
        const row = candidate.artifact.kind === "component"
          ? componentRowsByKey.get(`${candidate.artifact.id}\0${candidate.artifact.designSystem}\0${candidate.version}`)
          : compositionRowsByKey.get(`${candidate.artifact.id}\0${candidate.artifact.designSystem}\0${candidate.version}`);
        return selectionCandidate(candidate, row?.publishedAt, visual(candidate));
      }));
      const canonical = candidatesInGroup.find((candidate) => candidate.artifact.id === selected.artifact.id && candidate.artifact.kind === selected.artifact.kind)!;
      const retiredCandidates = candidatesInGroup.filter((candidate) => candidate !== canonical);
      const retired = retiredCandidates.map((candidate) => candidate.artifact);
      const exact = retiredCandidates.every((candidate) => {
        const left = candidate.artifact.kind === "component" ? componentRowsByKey.get(`${candidate.artifact.id}\0${candidate.artifact.designSystem}\0${candidate.version}`) : undefined;
        const right = canonical.artifact.kind === "component" ? componentRowsByKey.get(`${canonical.artifact.id}\0${canonical.artifact.designSystem}\0${canonical.version}`) : undefined;
        return left !== undefined && right !== undefined && componentSignature(left) === componentSignature(right);
      });
      // A group found only by the calibrated matcher carries that matcher's own score, so the
      // plan never claims more certainty than the gate had: 0.9 is reserved for the structural
      // near-duplicate rule, and the exact rule for identical normalized structure and IO.
      const matcherScore = Math.max(0, ...retiredCandidates.map((candidate) => matcherPairs.get(pairKey(candidate.artifact, canonical.artifact)) ?? 0));
      const confidence = exact ? 1 : matcherScore > 0 ? matcherScore : 0.9;
      const reason = exact ? "normalized source/composition structure and IO are identical"
        : matcherScore > 0 ? `calibrated reuse matcher (policy ${CALIBRATED_POLICY.policyVersion}) scores the pair blocking at ${matcherScore.toFixed(4)}`
          : "normalized structure and token shingles indicate a near-duplicate";
      duplicateGroups.push({ canonical: canonical.artifact, retired, confidence, reason });
      const typeMap = Object.fromEntries(candidatesInGroup.filter((candidate) => candidate.artifact.kind === "component" && candidate !== canonical).map((candidate) => [candidate.name, canonical.name]));
      const affectedPrototypeHeads = [...new Set(retired.flatMap((artifact) => currentHeadUsages(db, artifact)))].sort();
      const affectedCompositionHeads = [...new Set(retired.flatMap((artifact) => artifact.kind === "component"
        ? currentCompositionUsesComponent(compositionUsages, artifact.id, artifact.version!)
        : currentCompositionUsesComposition(compositionUsages, artifact.id, artifact.version!)))].sort();
      planGroups.push({
        canonical: canonical.artifact,
        retired,
        confidence,
        reasons: [reason],
        adapter: { typeMap, props: {} },
        affectedPrototypeHeads,
        affectedCompositionHeads,
        immutableUsages: retiredCandidates.flatMap((candidate) => immutableUsages(db, candidate.artifact)),
      });
      for (const candidate of retiredCandidates) candidate.classification = "semantic-duplicate";
    }
    artifacts.sort((left, right) => left.artifact.kind < right.artifact.kind ? -1 : left.artifact.kind > right.artifact.kind ? 1 : left.artifact.designSystem < right.artifact.designSystem ? -1 : left.artifact.designSystem > right.artifact.designSystem ? 1 : left.artifact.id < right.artifact.id ? -1 : left.artifact.id > right.artifact.id ? 1 : left.version - right.version);
    const plan = createCatalogMigrationPlan({ generatedAt, catalogRevision, dataFingerprint, groups: planGroups, compositionConversions: [], metadataRevisions: [], documentedExceptions: [] });
    return { generatedAt, catalogRevision, dataFingerprint, artifacts, duplicateGroups, plan };
  })();
}

export const runCatalogAudit = auditCatalog;
