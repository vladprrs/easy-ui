# Composition v2, Atomic Audit, and Production Deduplication Design

Date: 2026-07-30  
Parent: [`2026-07-30-library-reuse-architecture-design.md`](./2026-07-30-library-reuse-architecture-design.md)  
Status: approved in conversation

## 1. Objective

Provide a first-class, versioned way to build molecules from atoms and
organisms from molecules, then use it to remove semantic duplicates from the
active production catalog and rewrite every affected current-head usage.

Immutable revisions and bundles remain readable. “Remove duplicates” means:

- zero duplicate entries in the active catalog;
- zero duplicate references in current prototype/composition heads;
- an explicit canonical replacement;
- soft deletion after successful cutover.

Physical deletion is allowed only in a later garbage-collection operation when
both current and immutable usage counts are zero.

Cross-artifact replacement is recorded in a dedicated registry rather than
overloading a component version's numeric `supersededBy` field:

```text
catalog_replacements
  from_kind, from_id, from_design_system
  to_kind, to_id, to_design_system
  migration_run_id, reason, created_at
```

The `from_*` tuple is unique. The registry supports component→component,
component→composition, and composition→composition mappings and remains
queryable after the source artifact is soft-deleted.

## 2. Why Composition v2 is required

Custom components are isolated single-file bundles and cannot import other
published components. Composition v1 can reference published components but
forbids nested compositions. That permits one flat reusable assembly, not an
Atomic Design dependency graph.

Composition v2 adds acyclic nesting while retaining server-side expansion and
exact version pins:

```text
YpText + YpIcon + YpButton
          │
          ▼
PaymentMethodRow (molecule composition)
          │
          ▼
PaymentMethodPicker (organism composition)
          │
          ▼
CheckoutPage (page composition)
```

Assemblies are represented as data and remain visible to validation, usage
analysis, architecture lints, the editor tree, and migration tools.

## 3. Composition v2 document

`compositionDocSchema` accepts versions 1 and 2. Version 1 behavior is frozen.

Version 2 extends the root:

```ts
interface CompositionDocV2 {
  version: 2;
  name: string;
  description?: string;
  atomicLevel: "molecule" | "organism" | "template" | "page";
  scope?: "section" | "shell" | "screen";
  canonicalFor?: string[];
  ownership?: { reason: string; provenance?: string };
  replacement?: string;
  params: Record<string, CompositionParam>;
  slots: string[];
  spec: CompositionSpec;
  provenance?: {
    source?: string;
    figmaNodeId?: string;
  };
}
```

Rules:

- A v2 spec may contain `@eui/Composition`.
- Every nested reference points to a published composition in the same active
  design system.
- The published dependency graph must be acyclic.
- Maximum composition nesting depth is five, counting the outer composition.
- Expanded output must satisfy the existing per-screen 500-element and
  depth-50 limits.
- A composition does not contain `@eui/FlowRoot` or region markers; those remain
  screen-owned.
- `@eui/Slot` and `$param` preserve current semantics at every nesting level.
- Canonical roles follow the same uniqueness policy as components.
- A composition may reference components and compositions, but never a
  deprecated artifact when an active replacement exists.

Version 1 remains non-nesting and is expanded exactly as today. It can be
published and pinned indefinitely.

## 4. Expansion and pinning

Expansion is deterministic, depth-first, and version-pinned.

At publish time the server:

1. resolves each nested composition to its latest active version;
2. records direct and transitive dependency pins;
3. validates cycles and maximum depth;
4. expands parameters and slots;
5. validates the fully expanded component tree;
6. stores a deterministic dependency-manifest hash with the published version.

Keys keep using the reserved `$` separator and include each host segment:

```text
checkout$picker$row$label
```

Authored keys continue to forbid `$`, so expanded origins remain reversible.
`expandedFrom` records every layer:

```ts
interface ExpandedOrigin {
  chain: Array<{
    compositionId: string;
    version: number;
    hostKey: string;
    innerKey: string;
  }>;
}
```

Prototype revisions pin the top-level composition versions. Their stored
composition closure contains exact transitive versions, and component pins are
collected from the fully expanded tree. A later composition publication cannot
change an existing prototype revision.

Cycle diagnostics include the full path, for example:

```text
checkout-page@2 → payment-picker@4 → payment-row@3 → checkout-page@2
```

## 5. Atomic Design policy

Artifact representation is selected by responsibility:

| Level | Default representation |
|---|---|
| Atom | TSX component only for an irreducible primitive/behavior |
| Molecule | Composition of atoms; TSX requires an irreducibility reason |
| Organism | Composition of molecules/atoms |
| Template/page | Composition of organisms/molecules/atoms |

A TSX molecule or organism is allowed only when behavior cannot be represented
by existing events, state directives, params, or slots. It must declare
`ownership.reason` explaining that behavior. A missing reason is a publish
error for newly created artifacts after rollout, not a warning. “New” is
defined by `components.created_at >= atomic_policy.activated_at`, persisted by
the activation migration; older ids remain publishable during their audited
migration but are reported until classified.

The audit classifies every active artifact as:

- `irreducible-code`;
- `composition-candidate`;
- `semantic-duplicate`;
- `metadata-only-fix`;
- `deprecated-unused`;
- `documented-exception`.

The result includes the lower-level dependency graph or the exact reason no
such graph is possible.

## 6. Production audit

The audit runs read-only against a consistent production snapshot and writes a
tracked report plus a machine-readable migration plan.

Inputs:

- active and historical component/composition metadata;
- source or composition documents;
- props schemas, events, and slots;
- current-head and immutable usage graphs;
- Figma provenance and visual references;
- render status for current-head prototype screens.

Analysis:

1. Apply the reuse matcher from the enforcement project.
2. Compare normalized source/composition structure.
3. Detect repeated native implementations of known atoms and molecules.
4. Verify atomic level and scope against actual ownership and children.
5. Identify monolithic organisms/pages.
6. Identify current and immutable usages.
7. Select a canonical artifact deterministically:
   - active before deprecated;
   - valid canonical role;
   - greater current-head usage;
   - passing visual reference;
   - complete architecture metadata;
   - older stable publication as the final tie-breaker.
8. Define compatibility and migration adapters.

Migration plan shape:

```ts
interface CatalogMigrationPlan {
  version: 1;
  generatedAt: string;
  catalogRevision: string;
  dataFingerprint: string;
  groups: Array<{
    canonical: ArtifactKey;
    retired: ArtifactKey[];
    confidence: number;
    reasons: string[];
    adapter: MigrationAdapter;
    affectedPrototypeHeads: string[];
    affectedCompositionHeads: string[];
    immutableUsages: Array<{ resourceId: string; version: number }>;
  }>;
  compositionConversions: Array<{
    from: ArtifactKey;
    toCompositionId: string;
    doc: CompositionDocV2;
    adapter: MigrationAdapter;
  }>;
  metadataRevisions: ArtifactMetadataRevision[];
  documentedExceptions: DocumentedException[];
}
```

The canonical serialized plan is hashed. Apply refuses a plan whose
`catalogRevision`, `dataFingerprint`, or hash differs from the current
production snapshot.

High-confidence groups are not silently applied if their schemas are
incompatible. Every group requires a concrete adapter. Lower-confidence groups
must be resolved into a mapping or a documented exception before the plan is
executable.

## 7. Migration adapters

An adapter is declarative and artifact-specific:

```ts
interface MigrationAdapter {
  typeMap: Record<string, string>;
  props: Record<string, {
    rename?: Record<string, string>;
    defaults?: Record<string, JsonValue>;
    enumMap?: Record<string, Record<string, JsonValue>>;
    drop?: string[];
  }>;
  events?: Record<string, {
    rename?: Record<string, string>;
    payloadMap?: Record<string, string>;
  }>;
  slots?: {
    rename?: Record<string, string>;
    defaultTarget?: string;
  };
}
```

Rules:

- Type-only replacement is allowed only when props, events, and slots are
  structurally compatible.
- Dropping a populated prop, event handler, or slot is forbidden unless the
  plan contains an artifact-specific documented exception.
- Adapter application is pure and deterministic.
- Applying the same adapter twice is idempotent.
- Every changed path is recorded in the migration report.
- The transformed authored document must pass normal server validation; the
  migration does not bypass schemas or lints.

When an organism becomes a composition, the adapter replaces its element with
`@eui/Composition`, maps props to `props.params`, and routes existing children
to declared slots.

## 8. Staged production migration

### Stage A: prepare without cutover

1. Deploy Library performance, hard reuse gate, and Composition v2.
2. Run the read-only audit and generate the exact migration plan.
3. Materialize new canonical components, v2 compositions, metadata-only
   revisions, and transformed prototype/composition candidates in an isolated
   clone of the production data.
4. Validate every candidate and capture every affected screen.
5. Compare candidates with pre-migration visual evidence.
6. Upload the validated component bundles and composition closures into
   migration-specific staging storage bound to the plan hash. Staged artifacts
   are not active catalog versions and are inaccessible to ordinary authoring.

No production head, active catalog entry, or consumer reference changes during
Stage A. Staging rows/files are plan-owned and are deleted on abort or after the
rollback retention window.

### Stage B: protected cutover

1. Enable an application maintenance write-lock. Reads and playback continue;
   unrelated mutating endpoints return `503 maintenance_in_progress`.
2. Drain in-flight writes and verify the plan's catalog/data fingerprints.
3. Create a full SQLite online backup and copy the data artifacts required by
   published bundles, composition closures, and visual evidence.
4. In one database transaction:
   - activate the prevalidated staged component/composition versions required
     by the plan;
   - create new head revisions for affected compositions;
   - create new head revisions for affected prototypes;
   - preserve authorship/lifecycle metadata and attach a migration audit
     message;
   - publish a new version only when the pre-migration head was the source of
     the latest published version;
   - leave an existing unpublished draft unpublished;
   - insert the cross-artifact replacement registry entries;
   - mark duplicate latest versions deprecated or superseded with an audit
     reason, without putting a cross-artifact id into numeric `supersededBy`;
   - soft-delete duplicate artifact heads after current-head usage reaches
     zero;
   - write the migration-run and per-resource audit records.
5. Commit and release the write-lock.

If a resource changed after plan generation, fingerprint validation aborts the
whole transaction. The migration never merges concurrent edits.

### Stage C: post-cutover verification

1. Verify catalog search and Library show only canonical active artifacts.
2. Verify current-head usage of every retired id is zero.
3. Run render-status for every changed screen.
4. Capture and compare every changed screen again from committed production
   state.
5. Render a sample of immutable historical versions that still pin retired
   bundles.
6. Run production read-only smoke for Library, player, editor, compositions,
   catalog search, and audit endpoints.
7. Publish the final evidence report.

## 9. Visual acceptance

For a type-only duplicate replacement expected to be visually identical,
`diffPercent` must be exactly zero against the captured pre-cutover candidate.

For an intentional consistency correction:

- the migration plan includes the affected screen and reason;
- before/after images are retained;
- any non-zero result is listed explicitly in the final report;
- product errors, missing images, capture errors, or unexpected changed screens
  block cutover.

No global percentage threshold can silently approve an intentional visual
change.

## 10. Rollback

Failure before Stage B has no production effect.

Failure inside the cutover transaction rolls back automatically and retains the
backup for investigation.

Failure after commit:

1. re-enable the maintenance write-lock;
2. stop mutating traffic;
3. restore the database and data artifacts from the cutover backup;
4. deploy the previous compatible application version if the failure is
   code-related;
5. run health, immutable playback, and auth checks;
6. release the lock only after verification.

The schema changes are additive and the previous application version must
tolerate their presence, allowing database restore and application rollback to
be ordered safely.

## 11. Test strategy

### Composition v2

- v1 behavior and hashes remain unchanged.
- Nested params and default propagation.
- Default and named slots through two or more levels.
- Stable expanded keys and origin chains.
- Same-system enforcement.
- Cycle path diagnostics.
- Depth 5 accepted; depth 6 rejected.
- Expanded element and tree-depth budgets.
- Exact direct/transitive composition and component pins.
- Old prototype versions stay stable after dependency republish.

### Atomic policy

- Atom accepted as irreducible TSX.
- New TSX molecule/organism without reason rejected.
- Composition molecule/organism accepted with valid lower-level dependencies.
- Deprecated dependency with active replacement rejected.
- Metadata backfill on an existing legacy artifact remains possible.

### Audit and adapters

- Canonical selection ordering.
- Exact and near-duplicate grouping.
- Prop rename/default/enum/drop behavior.
- Event and slot mapping.
- Populated data cannot be silently dropped.
- Component-to-composition replacement.
- Idempotency and deterministic plan hash.
- Current-head and immutable usage accounting.

### Migration

- Stale catalog/data fingerprint aborts before writes.
- Concurrent head revision aborts the full cutover.
- New revisions preserve old revisions and lifecycle metadata.
- Published-head and unpublished-draft behavior.
- Zero-usage requirement before soft delete.
- Failure halfway through the transaction leaves no partial rewrite.
- Backup restore returns hashes and render output to the pre-cutover state.

### End-to-end

- Agent builds a molecule from atoms and an organism from that molecule.
- Prototype save expands the nested closure and pins exact versions.
- Library search presents the composition before suggesting a new component.
- A migrated production-shaped fixture contains no retired current-head types.
- Immutable fixture versions still render their retired pinned bundles.
- Visual evidence and final report contain every changed screen.

## 12. Completion report

The production completion artifact contains:

- catalog counts before and after by artifact kind and atomic level;
- every canonical mapping and retired artifact;
- every rewritten prototype/composition head and new revision/version;
- every metadata correction and documented exception;
- current and immutable usage counts;
- every force-new decision that remains active;
- Library performance before and after;
- visual results and links to retained evidence;
- backup identifier, cutover timestamps, application versions, and rollback
  result (`not-needed` or the completed recovery record).
