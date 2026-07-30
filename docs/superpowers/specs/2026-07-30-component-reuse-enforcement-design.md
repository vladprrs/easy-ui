# Component Reuse Enforcement and Agent Discovery Design

Date: 2026-07-30  
Parent: [`2026-07-30-library-reuse-architecture-design.md`](./2026-07-30-library-reuse-architecture-design.md)  
Status: approved in conversation

## 1. Objective

Make “reuse before create” enforceable at the API boundary and efficient for an
agent with limited context. A new id or component name must not bypass semantic
duplicate detection.

The same discovery index covers components and, after Composition v2 ships,
compositions.

## 2. Discovery API

Add:

```http
POST /api/catalog/candidates
```

Input:

```ts
interface CatalogCandidateRequest {
  designSystem: string;
  intent: string;
  proposed?: {
    kind: "component" | "composition";
    id?: string;
    name?: string;
    description?: string;
    atomicLevel?: string;
    scope?: string;
    canonicalFor?: string[];
    propsJsonSchema?: unknown;
    events?: string[];
    slots?: string[];
    source?: string;
    compositionDoc?: unknown;
  };
  limit?: number; // 1..20, default 8
}
```

Output:

```ts
interface CatalogCandidateResponse {
  catalogRevision: string;
  candidates: Array<{
    kind: "component" | "composition";
    id: string;
    name: string;
    designSystem: string;
    version: number;
    description: string;
    atomicLevel?: string;
    scope?: string;
    canonicalFor: string[];
    replacement?: string;
    deprecated: boolean;
    headUsageCount: number;
    score: number; // 0..1
    blocking: boolean;
    reasons: string[];
  }>;
}
```

The response is compact and never includes source or all props schemas.
Authors fetch exact details only for selected candidates through existing
version routes or a selective driver command.

`intent` is required, trimmed, 8–500 characters. After tokenization it must
contain at least one token outside the versioned generic stop set
`component`, `компонент`, `element`, `элемент`, `ui`. It is used for FTS
ranking and stored in decision audit records.

## 3. Deterministic candidate matcher

Matching is local and explainable. No external embedding or nondeterministic
model call is part of a create decision.

Candidates are limited to the requested active design system and include active
components and published compositions. Replaced/deprecated artifacts may be
returned for explanation but cannot be recommended as the target.

Signals:

| Signal | Contribution |
|---|---:|
| Any exact `canonicalFor` overlap | blocking independently of score |
| Exact normalized structural fingerprint | blocking independently of score |
| Props schema signature similarity | 0.25 |
| Event and slot signature similarity | 0.15 |
| Normalized source/composition token-shingle similarity | 0.20 |
| Name-token similarity | 0.15 |
| Description/intent FTS rank | 0.15 |
| Same atomic level and scope | 0.10 |

Structural fingerprints contain only canonical metadata:

- sorted JSON Schema property names, required flags, primitive/enum shapes, and
  additional-properties policy;
- sorted events and named slots;
- normalized TSX tokens with comments, whitespace, local identifiers, and
  literal values removed;
- for compositions, normalized artifact types and parent/slot topology.

Two artifacts are blocking when:

- they share a canonical role;
- their structural fingerprints are equal; or
- the weighted score is at least `0.82`.

Scores from `0.65` through `0.819999…` are non-blocking review candidates.
Lower scores are returned only when needed to fill the requested limit.

The matcher returns human-readable reasons such as:

- `same canonical role: payment-success`;
- `same props/events/slots signature`;
- `92% normalized source structure`;
- `same organism scope with matching product-job description`.

The thresholds are contract constants covered by fixtures. Production shadow
analysis runs before enforcement is enabled; changing thresholds later is a
versioned policy change with a report and tests.

## 4. Non-bypassable create gate

`POST /api/components` parses and extracts the proposed source in an ephemeral
staging directory first. Before `ComponentRepo.create` or durable module
materialization, the server runs the candidate matcher using the extracted
definition and proposed source. Staging cleanup runs on success, rejection,
abort, and extraction failure.

The create request adds two fields:

```ts
interface ComponentCreateReuseFields {
  intent: string; // required, same 8–500 character contract as candidate search
  reuseOverride?: ReuseOverride;
}
```

This is an intentional contract tightening. The driver, OpenAPI, SDK examples,
fixtures, and every repository caller migrate in the same release. The server
itself performs the mandatory search, so a caller does not have to invoke
`/catalog/candidates` first and cannot bypass matching by skipping that
endpoint.

When blocking candidates exist and there is no valid override:

```http
409 component_reuse_required
```

The error body contains `catalogRevision`, candidates, scores, and reasons.
There is no component/resource row or durable module write. The append-only
blocked-attempt audit record is the only permitted database effect.

Add an optional request field:

```ts
interface ReuseOverride {
  catalogRevision: string;
  candidateKeys: string[];
  reason: string;
}
```

Rules:

- override is accepted only for an authenticated administrator;
- `reason` is trimmed and 20–500 characters;
- all currently blocking candidate keys must be acknowledged;
- the supplied `catalogRevision` must equal the current revision, otherwise
  `409 catalog_changed` returns fresh candidates;
- the server recomputes candidates; it never trusts a prior search response;
- component creation and the accepted decision audit row commit together.

The same gate is added to `POST /api/compositions` after Composition v2. A
composition proposal may be blocked by an existing component and vice versa.

Updates to an existing artifact do not run the create gate, but a change to its
`canonicalFor` values must preserve canonical-role uniqueness or use the same
admin override flow.

## 5. Decision audit

Add an append-only `catalog_reuse_decisions` table:

```text
id
actor_id
artifact_kind
artifact_id
design_system
source_or_doc_hash
catalog_revision
intent
candidates_json
decision             accepted_no_match | blocked | force_new
reason               nullable except force_new
created_at
```

Blocked decisions are written best-effort outside the failed create
transaction so repeated agent behavior remains observable. Accepted and
force-new decisions are written atomically with artifact creation.

The admin audit response and CLI expose:

- force-new decisions;
- repeated blocked attempts by actor/artifact;
- canonical-role conflicts;
- artifacts created before the gate that have never received a reuse review.

No source, props values, credentials, or session tokens are stored in the audit
record.

## 6. Driver and SDK workflow

Add commands:

```text
driver.mjs catalog search <designSystem> <intent> [--limit N] [--json]
driver.mjs catalog get <designSystem> <artifact...> [--json]
driver.mjs composition <id> <doc.json> --design-system <id>
driver.mjs composition publish <id>
driver.mjs component ... --intent <text>
driver.mjs component ... --intent <text> --force-new --reason <text>
```

`catalog search` calls `/catalog/candidates`. `catalog get` returns exact
definitions only for named artifacts, including architecture metadata,
deprecation/replacement, props schema, events, slots, examples, and usage.

`driver component` requires `--intent`, performs candidate search for early
feedback, then relies on the server's recomputation for enforcement. It prints
blocking candidates and exits with the product-error exit code. `--force-new`
without `--reason`, a stale catalog revision, or a non-admin session fails.

The old full `catalog <system>` command remains for compatibility but now
includes `scope`, `canonicalFor`, `replacement`, `deprecated`, and usage
metadata. Agent documentation directs authors to selective search/get instead.

The generated SDK continues to provide exact prop/event/slot types. Its
documentation adds a generated discovery summary grouped by canonical role and
atomic level; no production snapshot containing credentials or mutable server
state is committed automatically.

## 7. Cross-agent policy

Create one canonical repository document,
`docs/agent-authoring-policy.md`, containing the enforced workflow and examples.
Thin platform entry points link to it:

- root `AGENTS.md`;
- the existing `CLAUDE.md`;
- `.claude/skills/author/SKILL.md`;
- `.claude/skills/yp-prototype/SKILL.md`;
- SDK authoring documentation.

The policy states:

1. Search is mandatory before creating an artifact.
2. Retrieve exact details for selected candidates only.
3. Prefer a component, then a composition of existing artifacts.
4. TSX is reserved for irreducible new behavior.
5. Agents must not use `force-new`; they surface candidates and request an
   administrator decision.
6. A molecule/organism/page made only of existing visual parts is a composition,
   not a new TSX component.

Because the server enforces the gate, missing or ignored instruction files
cannot create a silent duplicate.

## 8. Metadata completeness

The production check found no `canonicalFor` or `scope` values on 115 Yandex
Pay entries. Search cannot rely on absent metadata, so the production audit
must backfill:

- correct `atomicLevel`;
- `scope`;
- one or more `canonicalFor` product-job slugs when the artifact is canonical;
- `ownership` for shell/screen owners;
- `replacement` for superseded artifacts.

Backfill is performed as new component or composition revisions and versions.
It is not a direct edit of persisted `definition_meta`.

Canonical roles use a versioned glossary stored in the repository. Each slug
has a concise RU/EN description and at most one active canonical artifact per
design system unless an audited admin override exists.

## 9. Error handling

- Candidate search failure prevents create; the system never “fails open.”
- A catalog race returns `catalog_changed` and fresh candidates.
- Extraction failure remains a 422 and does not run semantic matching on
  untrusted partial metadata.
- FTS/index corruption falls back to a deterministic in-memory scan and emits a
  server error metric; create remains protected.
- An unavailable deprecated candidate does not block when its declared active
  replacement is the candidate.
- A force-new audit write failure rolls back component creation and removes its
  staged module artifacts.

## 10. Test strategy

### Matcher

- canonical overlap;
- exact schema/source/composition fingerprints;
- renamed copy/paste source;
- similar name but incompatible props;
- same structure in different design systems;
- deprecated artifact with replacement;
- RU/EN descriptions and stable ordering;
- threshold boundaries at 0.65 and 0.82.

### API/security

- a duplicate direct POST is blocked even when the caller skipped the
  candidate-search endpoint;
- a genuinely novel direct POST succeeds because the server performed the same
  mandatory matching internally;
- direct POST cannot forge scores or candidates;
- regular user cannot override;
- admin override requires all candidates and a valid reason;
- catalog race returns fresh candidates;
- accepted create and audit row are atomic;
- source is absent from audit JSON;
- canonical-role uniqueness applies to creates and updates.

### Driver/docs

- selective search/get output shapes;
- full catalog no longer strips reuse metadata;
- exit codes and human-readable candidate output;
- composition create/publish workflow;
- instruction-file drift test ensures all thin entry points reference the
  canonical policy.

### Integration

- an agent-style test searches, reuses a candidate, and publishes a prototype
  without creating a component;
- an agent-style duplicate attempt is blocked through both driver and raw API;
- an admin force-new creates one attributable audit record;
- search results match Library results for the same intent.

## 11. Rollout

1. Deploy schema, search endpoint, audit table, driver, and policy with create
   decisions in shadow/report mode.
2. Run the full production catalog through the matcher and resolve false
   positives in deterministic fixtures.
3. Enable the hard gate.
4. Verify no new unresolved high-confidence duplicate appears during the
   Composition v2 and migration work.

Shadow mode is time-bounded to the pre-enforcement audit; it is not a permanent
configuration or a bypass available to clients.
