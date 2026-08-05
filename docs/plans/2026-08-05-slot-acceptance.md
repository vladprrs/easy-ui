# Slot-aware acceptance: caseSetSlotBindings + prototypeCandidateOverlay

## Context

`docs/component_feedback.md` (2026-08-05) reports that the pre-publish acceptance contour cannot exercise named slots, blocking server acceptance for PaySmsModule, PayLeadBlock, PayNavigationBar, PayProductCard, PayPaymentMethodCarousel:

1. Case-sets accept only the candidate's own props (strictObject, 9 fields) → the server renders candidates with **empty slots** (`CaptureComponent.tsx:79-88` builds a single-element tree; `easyUiRuntime` gets `slots: {}`).
2. Two Figma states differing only in slot content have identical parent props → `422 duplicate_case_props` (`caseSets.ts:291-301` keys on `propsHashOf(props)` only); `aliasOf` can't help (alias reuses one frame).
3. Prototypes resolve only `status='active'` publishes (`server/validation.ts:200-208`) → an unpublished candidate can't be exercised in a composite fixture ("prototype-candidate-overlay-missing").

The feedback asks for **both** mechanisms: slot bindings in case-sets (A) and candidate overrides for prototype fixtures (B). Verified against source; the two cited `artifacts/**.json` files are not in this repo (external workspace evidence) — everything they claim is confirmed directly in code.

**Decisions taken (were the plan agent's open questions; recommended defaults adopted):**
- **B v1 = capture-time overlay only** — no acceptance run/verdict/promote binding. Rendering by the server from the server's candidate bundle under the server's allowlist, with the existing capture receipt recording overlay pins, is real provenance; a verdict would need a second run kind + coverage model (deferred v2: `capture.fixture` case-set extension). A delivers promote-bound evidence for component matrices.
- **Migration v31 is accepted** (`acceptance_cases.slots_hash TEXT`, additive/nullable/no-backfill) — promote coverage must not depend on silently-degrading reconstruction from manifests.

## Design invariants (bind every task)

- Case-set manifests are content-addressed: new fields `.optional()` **without** `.default()` (`caseSetSchema.ts:157-163` C6/C25 rule; golden test `caseSets.test.ts:562` must stay untouched and green).
- `FIELD_LAYERS` totality guard (`ids.ts:376-427`): every new `AcceptanceCase` field must be assigned a layer explicitly.
- `frameFingerprint` is not algo-versioned: slot-free cases must produce **byte-identical** frame hashes after the change (hash new inputs conditionally via the `definedOnly` pattern) — so the ALGO bump costs verdict-reuse recompute, not a global re-shoot.
- `readyToExpected` in `scripts/screenshot-worker.mjs:108-115` is an explicit whitelist: add new fields **conditionally** so legacy jobs map byte-identically.
- Candidate-head-dependent facts (slot names, namedSlots capability) = **warning at PUT, hard 422 at run start**; published facts (child exists/version/props) = hard 422 at PUT (house style `caseSets.ts:17-20,99-115`).

## Feature A — slotBindings in case-sets

### A1. Schema (`src/acceptance/caseSetSchema.ts`)

```ts
export const CASE_SET_MAX_SLOT_CHILDREN = 12; // carousel needs 9
export const CASE_SET_MAX_SLOTS_PER_CASE = 8;
caseSetSlotChildSchema = z.strictObject({
  type: z.string().min(1).max(64),      // published component name (globally unique)
  version: z.number().int().positive(), // exact pin, REQUIRED — "active" would float the cset_ meaning
  props: z.record(z.string(), z.unknown()).optional(),
});
caseSetSlotBindingsSchema = z.record(slotName /* ^[a-z0-9]+(-[a-z0-9]+)*$, ≤32 */,
  z.array(caseSetSlotChildSchema).min(1).max(CASE_SET_MAX_SLOT_CHILDREN))
  .refine(≤ CASE_SET_MAX_SLOTS_PER_CASE slots);
// caseSetCaseSchema += slotBindings: caseSetSlotBindingsSchema.optional()  (no .default())
```

- `bundleHash` NOT in manifest — server resolves it from the immutable `(name, version)` publish row.
- **Depth-1 only** (children have no own slotBindings/children — strictObject refuses): all blocked components are depth-1; deep/interactive composition is Feature B's job; v2 can add nesting additively.
- **Cardinality not validated** (nothing declares it; `slots?: string[]` in `server/components/types.ts:32`) — documented as not-a-server-contract; future `slotCardinality` out of scope.

### A2. Validation (`server/acceptance/caseSets.ts#validateManifest`, after aliases / before duplicate-props)

| Code | When | Where |
|---|---|---|
| `slot_component_not_published` 422 | type unknown / version missing / deleted | PUT + run start |
| `slot_component_design_system_mismatch` 422 | child from another DS | PUT |
| `slot_self_reference` 422 | child resolves to subject component | PUT |
| `slot_props_invalid` 422 | child props fail pinned version's propsJsonSchema | PUT |
| `slot_unknown` 422 | slot not in candidate's `extracted.meta.slots` | run start (warning at PUT) |
| `slot_bindings_unsupported` 422 | candidate lacks `capabilities.namedSlots` | run start (warning at PUT) |

Child pin lookup mirrors `componentPinByVersion` (`server/repos/compositions.ts:309-316`); factor a shared helper if DS-scoping matches.

### A3. duplicate_case_props fix

- `slotsHashOf(bindings) = bindings === undefined ? null : sha256(canonicalStringify(bindings))`.
- Dedup key in `validateManifest:291-301` and `buildCasesFromManifest` → `${propsHash}:${slotsHash ?? "-"}`. Equal props + different bindings now pass (SMS Focused/Typing fix); equal props **and** equal bindings still refuse.
- Alias must repeat both props **and** bindings (`invalid_alias_target` otherwise) — alias inherits a frame; a different slot tree is a different frame.
- `propsHash` itself unchanged (browser handshake + persisted column).

### A4. AcceptanceCase + fingerprint (`cases.ts`, `ids.ts`)

- `AcceptanceCase += slotBindings?: ResolvedSlotBinding[]` (`{slot,index,componentId,name,version,bundleHash,props,propsHash}`, ordered — order is render order) and `slotsHash?: string`.
- `FrameFingerprintInput += slotBindings?` (subset `{slot,index,componentId,version,bundleHash,propsHash}`), hashed **conditionally** → slot-free frame hashes byte-identical.
- `FIELD_LAYERS`: `slotBindings: ["frame"]`; `slotsHash: ["report-only"]` (derivative, justification comment like `casePolicyHash`).
- **`CASE_FINGERPRINT_ALGO_VERSION = 6 → 7`** + honest history paragraph ("a case's frame may contain pinned published children"). Consequence: global verdict-reuse invalidation (recompute + re-diff, no recapture — asserted by test). Update `ids.test.ts` / `capture/renderer.test.ts` (`=== 6` → `=== 7`).

### A5. Run start (`orchestrator.createRun`)

New `resolveSlotBindings(db, componentId, ds, candidateEntry, cases)` in `caseSets.ts`: re-resolve pins, check names vs `extracted.meta.slots` (`slot_unknown`), check `capabilities.namedSlots` (`slot_bindings_unsupported`), fill bundleHash/propsHash/slotsHash. `baselineVerdictPolicies` stays resolution-free (slots are frame-layer only) — add a guard comment.

### A6. Capture path

- `gates/capture.ts` + `gates/types.ts`: pass `slotBindings` (conditional spread) into `enqueueComponentCandidate`.
- `server/screenshot/service.ts`: `enqueueComponentCandidate`/`pushDraftCapture` accept bindings; `InternalJob += slotChildren?: CapturePin[]`, `slotTree?`; `expected` (component-draft) `+= slotsHash?`; `draftComponentAllowedUrls` += per child: `/api/components/:childId/versions/:v/bundle.js`, component DTO URLs, child version assets — nothing else; bootstrap `+= slots: {children, tree}`.
- `src/capture/protocol.ts`: optional `slotsHash` on ComponentDraftExpected/Ready; typed bootstrap `slots`.
- `scripts/screenshot-worker.mjs`: conditional `slotsHash` in `readyToExpected`.
- `src/capture/CaptureComponent.tsx`: multi-element runtimeSpec (`c` + `s0…sN` children with `slot` fields, customTypes = parent + child names) — `runtimeSpec` slotIndices + `easyUiRuntime` routing already work; load parent draft bundle + child published bundles in one `loadCustomComponents` call; publish `slotsHash` in `ready`.

### A7. Evidence (`server/acceptance/evidence.ts`, `orchestrator.manifestOf`)

`EvidenceCaseEntry += slotBindings?` (resolved tree incl. props) and `slotsHash?` — written from the same computation as the fingerprint input. RunManifest version stays 1 (additive optional). Promote already binds `evidenceManifestHashes` → slot tree becomes promote-bound proof with no promote change beyond A8.

### A8. Coverage + migration v31

- **Migration v31**: `ALTER TABLE acceptance_cases ADD COLUMN slots_hash TEXT` (additive/nullable/no-backfill); written by `repo.insertCase`.
- `repo.runCoverage` key → `${props_hash}:${slots_hash ?? "-"}@${surfaceKey}` — legacy keys byte-identical; multi-run promote of same-props/different-slots runs no longer trips `acceptance_coverage_overlap`; `expectedCases` counts them separately (`promote.ts` `assertRunSetCoherent` semantics otherwise unchanged).

### A9. Capabilities/docs

- `features.caseSetSlotBindings` (= `acceptanceMatrix === true`), `limits.caseSetMaxSlotChildren: 12`, `caseSetMaxSlotsPerCase: 8` (`routes/meta.ts`), + `contracts.ts` capabilitiesResponseSchema, `openapi.json`, `docs/server-api.md` (schema, pinning rationale, depth-1, extended dedup/alias semantics, 422 table PUT-vs-run, ALGO-7 note, cardinality disclaimer). Note naming collision with composition analyze DTO's `slotBindings` (different shape, different resource).

## Feature B — prototypeCandidateOverlay (v1: capture-only)

### B1. API

`POST /api/prototypes/:id/screens/:screenId/screenshot` body += `candidateOverrides: [{candidateId}]` (≤ `prototypeCandidateOverlayMax: 2`). Array of candidateIds, not a name→id map (candidateId already resolves to component/rev/sourceHash/bundleHash; a map key would be a second source of truth). Refusals: `invalid_request` 400 (shape/limit/dup componentId), `not_found` 404 (unknown candidate / not visible / feature off), `candidate_override_unused` 422 (component not among screen's pins), `candidate_evicted` 409 (bundle GC'd). Authz: `requirePrototypeOwner` **plus** `requireResourceOwner(components, candidate.component_id)` per override.

### B2. Server (`enqueuePrototypeFrozen` region of `service.ts`, `routes/screenshots.ts`)

1. Swap matching `CapturePin`: `bundleUrl = /api/components/:id/draft/:sourceHash/bundle.js`, candidate bundleHash, `status: "candidate"`, `candidate: {candidateId, rev, sourceHash}`.
2. Overlay handshake: `componentManifestHash' = sha256(canonicalStringify({base, overrides: [{componentId, candidateId, bundleHash}]}))` in expected/bootstrap/response; optional `candidateOverlay` on PrototypeExpected/Ready + conditional `readyToExpected` entry.
3. Allowlist: overridden pin gets draft bundle URL + candidate assetIds; the shadowed published version's URLs are **not** added (minimality is a security property).
4. GC pinning: `ScreenshotService.pinnedCandidateSourceHashes()` (queued+running override jobs), composed as a union with the orchestrator's provider at `setCandidatePinProvider` registration in `main.ts`.
5. Browser: `CapturePrototype.tsx` consumes pins verbatim; only echoes `candidateOverlay` in ready.
- Capture receipt (`GET /api/screenshot-jobs/:jobId/receipt`) records overlay pins → auditable provenance "these pixels came from candidate X". Explicitly **not** a verdict.

### B3. Capabilities/docs

`features.prototypeCandidateOverlay` (= acceptanceMatrix && !validateDisabled), `limits.prototypeCandidateOverlayMax: 2`; docs subsection incl. "что overlay НЕ делает" (no verdict/evidence/promote/persistence; use slotBindings for publish-backing proof).

## Execution (project workflow)

**Stage 1 (after approval):** save this plan to `docs/plans/2026-08-05-slot-acceptance.md`, commit.
**Stage 2:** adversarial plan review — Workflow with 2-3 Opus reviewers (lenses: fingerprint/reuse correctness; API-contract/compat; security/allowlist+authz) + triage recorded in the plan; iterate until no blockers.
**Stage 3:** delegated execution (Opus subagents), waves below; orchestrator verifies done-criteria and commits per zone.

### Waves and file ownership (no file in two concurrent tasks)

- **W1 (parallel):**
  - T1.1+T1.3 (one agent, sequenced): `src/acceptance/caseSetSchema.ts` → `server/acceptance/caseSets.ts` + `caseSets.test.ts` (schema, limits, slotsHashOf, identity key, alias rule). Done: golden `cset_` test untouched-green; slot-free manifest hashes to historic id; equal-props/different-slots passes; equal/equal refuses; alias mismatch refuses.
  - T1.2: `server/acceptance/ids.ts` + `ids.test.ts` + `capture/renderer.test.ts` + field declarations in `cases.ts`. Done: ALGO===7; slot-free frame hash equals hardcoded historic value; hash changes on child bundleHash and on child order.
- **W2 (after W1):**
  - T2.1: `resolveSlotBindings` in `caseSets.ts` + `orchestrator.ts` createRun/comment. Done: run-start refusals slot_unknown/slot_bindings_unsupported against candidate fixture; orchestrator tests green.
  - T2.2: `gates/capture.ts`, `gates/types.ts`, `screenshot/service.ts` (draft path), `scripts/screenshot-worker.mjs`, `src/capture/protocol.ts`. Done: service-acceptance tests assert job carries child pins, allowlist exact, slot-free readyToExpected byte-identical.
  - T2.3: `migrations.ts` + `migrations.test.ts` + `acceptance/repo.ts`. Done: populated-DB v31 test; legacy runCoverage keys byte-identical.
  - T2.4 (after T2.2 — shares service.ts; owns prototype path): `routes/screenshots.ts`, `components/candidates.ts` provider union, `main.ts`, `enqueuePrototypeFrozen`. Done: new `prototype-candidate-overlay.test.ts` covers all refusal codes, overlay hash, allowlist delta, pin-provider union.
- **W3 (parallel):**
  - T3.1: `src/capture/CaptureComponent.tsx` + tests + `named-slots.test.ts` extension. Done: draft parent + 2 children in named slot renders routed; slotsHash published.
  - T3.2: `components/promote.ts` + tests. Done: two-run promote same-props/different-slots no longer trips coverage_overlap; expectedCases counts two.
  - T3.3 (after T2.1 — shares orchestrator.ts): `evidence.ts` + tests + `manifestOf`. Done: slot run manifest carries resolved tree; slot-free manifest byte-identical.
- **W4 (single agent):** `routes/meta.ts`, `contracts.ts`, `openapi.json`, `docs/server-api.md`, affected skill docs. Done: capabilities validates; docs checklist covers all new codes/limits/flags/ALGO-7/B-limitations.
- **W5 verification (orchestrator):** `npm run verify`; `bun test server/` (caseSets, ids, acceptance-routes, service-acceptance, named-slots, migrations, screenshot-worker, orchestrator); `npm run e2e` + new e2e (publish child → candidate for slot parent → case-set with two slot-differing cases → run → two distinct frames → promote); prior-build-vs-v31-DB reverse-compat check; runtime pass per `/verify` skill.

## Critical files

`src/acceptance/caseSetSchema.ts` · `server/acceptance/caseSets.ts` · `server/acceptance/ids.ts` · `server/acceptance/cases.ts` · `server/acceptance/orchestrator.ts` · `server/acceptance/evidence.ts` · `server/acceptance/repo.ts` · `server/screenshot/service.ts` · `server/acceptance/gates/capture.ts` · `src/capture/CaptureComponent.tsx` · `src/capture/protocol.ts` · `scripts/screenshot-worker.mjs` · `server/components/promote.ts` · `server/routes/screenshots.ts` · `server/components/candidates.ts` · `server/migrations.ts` · `server/routes/meta.ts` · `server/contracts.ts` · `docs/server-api.md`
