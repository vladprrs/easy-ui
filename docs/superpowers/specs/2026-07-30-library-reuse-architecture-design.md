# Library Performance and Design-System Reuse — Architecture Design

Date: 2026-07-30  
Status: approved in conversation  
Scope: umbrella design for three independently deliverable projects

## 1. Goal

Make Library fast at production catalog size, make design-system reuse the
default for humans and agents, prevent semantic component duplicates at the
server boundary, and migrate the current production catalog toward a strict
Atomic Design composition model without rewriting immutable history.

The work is split into three specifications:

1. [`2026-07-30-library-performance-design.md`](./2026-07-30-library-performance-design.md)
   — compact Library index, inline previews, display tiers, and performance
   gates.
2. [`2026-07-30-component-reuse-enforcement-design.md`](./2026-07-30-component-reuse-enforcement-design.md)
   — searchable component discovery, non-bypassable duplicate prevention,
   agent tooling, and authoring policy.
3. [`2026-07-30-composition-v2-dedup-migration-design.md`](./2026-07-30-composition-v2-dedup-migration-design.md)
   — nested compositions, Atomic Design audit, deterministic canonicalization,
   and production migration.

Each project receives its own implementation plan, adversarial review, test
cycle, and commit sequence. Production migration starts only after all three
projects are deployed and their gates are green.

## 2. Evidence and root causes

### 2.1 Library performance

The current Library has two independent fan-outs:

- `loadLibraryStatuses()` loads visual references and then calls
  `GET /api/components/:id` once per visible catalog entry.
- Every card near the viewport creates a same-origin
  `/capture/component/:id/:version` iframe. Each iframe boots the complete SPA,
  fetches component metadata and version metadata, fetches the design-system
  theme, and imports the component bundle.

The `IntersectionObserver` is one-way: after an iframe has been mounted it is
never unmounted when the card leaves the viewport.

Measured against a copied 79-component dataset with 44 visual references,
production build, cold cache, 40 ms RTT, 5 Mbit/s download, and a 1440×900
viewport:

| Metric | Current result |
|---|---:|
| Library shell ready | 3,026 ms |
| First live preview ready | 16,315 ms |
| Initial requests | 169 |
| Initial transferred bytes | 10,031,237 |
| Per-component metadata requests | 85: 79 from Library + 6 from iframes |
| Initial iframe count | 6 |

After scrolling through all 79 cards on an unthrottled local run:

| Metric | Before | After |
|---|---:|---:|
| Iframes | 6 | 79 |
| Total requests | — | 1,117 |
| JavaScript heap | 24.0 MiB | 263.6 MiB |
| Live/retained documents reported by CDP | 7 | 150 |

The 2026-07-30 production read-only check contained 115 active Yandex Pay
entries: 41 atoms, 37 molecules, 35 organisms, and 2 pages. Opening Library
produced 210 requests, including 121 exact component-metadata requests, before
six initial previews had settled.

These results identify the root cause as the per-card application runtime, not
React card markup or client-side filtering.

### 2.2 Agent reuse

The documented authoring workflow says to retrieve the catalog before
authoring, but the available machine interface works against that goal:

- production `yandex-pay` had `canonicalFor` on 0 of 115 entries and `scope` on
  0 of 115 entries;
- `driver.mjs catalog` deliberately removes `canonicalFor`, `scope`,
  `replacement`, `deprecated`, and usage information from its compact output;
- the command returns the entire catalog including every props schema
  (195,536 bytes in the production check), with no task-oriented search command;
- `POST /api/components` rejects identifier collisions but accepts a semantic
  duplicate under a new id and name;
- the typed SDK has only the tracked `sdk-demo` snapshot, not a production
  design-system discovery artifact;
- repository instructions are Claude-oriented; there is no root `AGENTS.md`
  enforcing the same workflow for Codex and other repository agents.

The server therefore validates whether a proposed component is syntactically
legal, but never asks whether it should exist.

### 2.3 Atomic composition

Published custom components are standalone single-file bundles. Imports from
another published design-system component are forbidden. Composition v1 is the
existing declarative reuse mechanism, but it forbids composition nesting.

As a result, the system cannot naturally express the desired hierarchy:

```text
atoms → molecules → organisms → templates/pages
```

A molecule cannot be a reusable composition of atoms if an organism then needs
to reuse that molecule. Agents frequently resolve this limitation by creating
new TSX components with repeated native markup.

## 3. Architectural decision

Adopt a shared inline preview runtime for Library and make versioned,
acyclic nested compositions the default representation for assemblies above an
irreducible primitive.

At the same time, move duplicate detection into the server:

```text
author intent/source
        │
        ▼
catalog candidate matcher ──► existing components + compositions
        │
        ├─ no blocking candidate ──► create
        │
        └─ blocking candidate ─────► 409 component_reuse_required
                                      │
                                      └─ admin force-new + reason + audit
```

This decision deliberately rejects three weaker alternatives:

- optimizing the existing iframe fan-out retains the memory architecture;
- prompt-only reuse rules are bypassable and cannot protect direct API calls;
- server-generated PNGs add storage, invalidation, and screenshot-queue
  dependencies while removing the live-preview property.

Server-rendered thumbnails remain a possible future cache, not part of this
work.

## 4. Product behavior

### 4.1 Library

Library becomes reuse-first rather than taxonomy-first:

1. Recommended canonical, used, verified artifacts.
2. Pages and organisms with large live previews.
3. Molecules with regular, viewport-scheduled previews.
4. Atoms and layout primitives in a compact, collapsed index. Their preview is
   loaded only after explicit keyboard/pointer selection.

Search covers every tier, searches components and compositions, and promotes
the selected result to the highest loading priority.

### 4.2 Authoring

The supported authoring sequence is:

1. describe the product job;
2. search the selected design system;
3. inspect exact definitions for the small candidate set;
4. reuse a component or composition;
5. create a composition when existing pieces can express the result;
6. create TSX only for irreducible new behavior;
7. use `force-new` only as an administrator with a recorded reason.

### 4.3 Existing catalog

Every production molecule and organism is reviewed for:

- semantic duplicates;
- repeated native implementations of existing lower-level artifacts;
- incorrect atomic level or scope;
- monolithic ownership;
- missing canonical and replacement metadata;
- zero current-head usage;
- deprecated usage.

Every finding ends in a canonical mapping, a composition migration, a metadata
correction, or a documented exception. Ambiguity blocks automated cutover; it
does not silently preserve a likely duplicate.

## 5. Cross-project contracts

All three projects share these identities and invariants:

- A catalog artifact is identified by `{kind, id, designSystem, version}` where
  `kind` is `component` or `composition`.
- Component ids remain globally unique in current storage, but matching and
  status resolution always include `designSystem` because a component may have
  active versions in multiple systems.
- `catalogRevision` is a deterministic hash of the active component and
  composition versions plus their discovery metadata. It protects candidate
  decisions and migration plans against catalog races.
- `canonicalFor` is unique by policy within one design system unless an audited
  admin override explains the exception.
- Cross-id and component-to-composition replacements use the
  `catalog_replacements` registry; numeric version-level `supersededBy` remains
  scoped to versions of one artifact.
- A hard-deleted artifact must have zero current and immutable usages. The
  production migration uses soft deletion because immutable versions still pin
  historical bundles.
- No existing prototype revision, component version, or composition version is
  mutated in place.

## 6. Delivery order

```text
Library index + inline runtime
              │
              ▼
search + server hard gate + agent tools
              │
              ▼
Composition v2 + audit + staged migration
              │
              ▼
production cutover and evidence report
```

The first project may deploy before the remaining work. The hard gate deploys
before production deduplication so new duplicates cannot enter during cleanup.
Composition v2 deploys before any component-to-composition rewrite.

## 7. Global success criteria

- Library meets the deterministic performance budgets in the performance
  specification.
- Initial Library navigation performs zero
  `GET /api/components/:id` requests.
- Direct API creation cannot bypass duplicate matching.
- Every admin override is attributable and queryable.
- Agents have selective search/get commands and a composition publishing path.
- The active production catalog has no unresolved high-confidence duplicate
  groups.
- Migrated production head revisions contain no references to retired
  duplicates.
- Every molecule/organism has either a lower-level dependency graph or an
  explicit reason why it is irreducible TSX.
- All immutable revisions remain renderable after migration.
- `npm run verify`, complete e2e, runtime verification, performance gates, and
  affected-screen visual checks are green before production completion.

## 8. Out of scope

- Rewriting immutable historical revisions.
- Physically deleting bundles that historical versions still pin.
- Treating screenshots as the primary Library preview.
- Untrusted third-party component sandboxing. Published component code retains
  the repository-equivalent trust model already used by Component Page.
- General-purpose vector search or an external embedding service. Candidate
  matching is deterministic, local, explainable, and testable.
