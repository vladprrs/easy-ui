# Slot-aware acceptance: caseSetSlotBindings + prototypeCandidateOverlay (v3, после Stage 2 раунды 1–2)

## Context

`docs/component_feedback.md` (2026-08-05) reports that the pre-publish acceptance contour cannot exercise named slots, blocking server acceptance for PaySmsModule, PayLeadBlock, PayNavigationBar, PayProductCard, PayPaymentMethodCarousel:

1. Case-sets accept only the candidate's own props (strictObject, 9 fields) → the server renders candidates with **empty slots** (`CaptureComponent.tsx:79-88` builds a single-element tree; `easyUiRuntime` gets `slots: {}`).
2. Two Figma states differing only in slot content have identical parent props → `422 duplicate_case_props` (`caseSets.ts:291-301` keys on `propsHashOf(props)` only); `aliasOf` can't help (alias reuses one frame).
3. Prototypes resolve only `status='active'` publishes (`server/validation.ts:200-208`) → an unpublished candidate can't be exercised in a composite fixture ("prototype-candidate-overlay-missing").

The feedback asks for **both** mechanisms: slot bindings in case-sets (A) and candidate overrides for prototype fixtures (B). Verified against source; the two cited `artifacts/**.json` files are not in this repo (external workspace evidence) — everything they claim is confirmed directly in code.

**Scope decisions:**
- **B v1 = capture-time overlay only** — no acceptance run/verdict/promote binding, and (v2) **no durable asset**: overlay jobs force `deliver:"bytes"`, so the frame cannot enter the asset registry or become a visual baseline. Provenance = the enqueue/status response (pins with candidate bundleHash + `candidateOverlay` block). Deferred v2: `capture.fixture` case-set extension for promote-bound composite fixtures.
- **Migration v31 accepted** (`acceptance_cases.slots_hash TEXT`, additive/nullable/no-backfill) — promote coverage and the baseline-carry guard must not depend on silently-degrading reconstruction from manifests.

## Design invariants (bind every task)

- Case-set manifests are content-addressed: new fields `.optional()` **without** `.default()` (`caseSetSchema.ts:157-163` C6/C25; golden test `caseSets.test.ts:562` stays untouched and green).
- `FIELD_LAYERS` totality guard (`ids.ts:376-427`): every new `AcceptanceCase` field gets an explicit layer. **The guard proves declaration only** — the field must ALSO be added to `CaseFingerprintCase` (`ids.ts:251-263`) and threaded through `caseFingerprintsOf` (`ids.ts:318-347`, conditional-spread style of `:330-333`), or it silently never reaches a hash. Differential tests must sit at the `caseFingerprintsOf` level, not at `frameFingerprint` directly.
- `frameFingerprint` is not algo-versioned: slot-free cases must produce **byte-identical** frame hashes. Golden captured at pre-change HEAD (e3a93fc): `frameFingerprint({candidateId:'cand_golden-fixture', caseKey:'alpha', propsHash:'props-1', surface:{viewport:{width:390,height:844},dsf:2,theme:'light'}, readinessPolicyHash:'readiness-fixture', rendererFingerprint:'renderer-fixture'})` = **`f29b0c498389404e5e426486bbb6050add243c6c0d97eff579ef127ec9fabeb1`**. T1.2 asserts equality to this literal, plus the negative: a case with `slotBindings` present must NOT equal it. Resolved bindings must be **absent, never `[]`/`null`** — `canonicalStringify` drops only `undefined`; enforce with conditional spread and test that `[]` is normalized to absent.
- Other byte-identity criteria (T2.2 `readyToExpected`, T3.3 evidence manifest) use **test-first goldens**: the task writes the golden test against UNMODIFIED code, proves it green, then implements — never computes the reference after the change.
- `readyToExpected` (`scripts/screenshot-worker.mjs:108-115`) is an explicit whitelist: new fields added **conditionally**.
- Candidate-head-dependent facts (named-slot names, namedSlots capability) = warning at PUT, hard 422 at run start; published facts (child exists/version/props) = hard 422 at PUT.
- **Rollback policy (stated, accepted):** a stored manifest carrying `slotBindings` is unreadable by pre-change builds (strictObject reparse on read, `caseSets.ts:374-377`) — same latent property `referenceSurface`/`cropLineage.sourceSurface` already introduced. Mitigation: `manifestOfRow` throws a **named** `ApiError` (`case_set_manifest_unreadable`, with caseSetId) instead of a bare Error, so a future rollback degrades into a typed refusal, not an opaque 500 inside promote. W5 documents the blast radius (all `manifestOfRow` call sites: routes, `surfaceKeyOf`/runCoverage→promote, orchestrator :314/:478/:673).

## Feature A — slotBindings in case-sets

### A1. Schema (`src/acceptance/caseSetSchema.ts`)

```ts
export const CASE_SET_MAX_SLOT_CHILDREN = 12; // carousel needs 9
export const CASE_SET_MAX_SLOTS_PER_CASE = 8;
caseSetSlotChildSchema = z.strictObject({
  type: z.string().min(1).max(64),      // published component name (globally unique, never renamed)
  version: z.number().int().positive(), // exact pin, REQUIRED
  props: z.record(z.string(), z.unknown()).optional(),
});
caseSetSlotBindingsSchema = z.record(slotKey, z.array(caseSetSlotChildSchema).min(1).max(CASE_SET_MAX_SLOT_CHILDREN))
  .refine(≤ CASE_SET_MAX_SLOTS_PER_CASE slots);
// caseSetCaseSchema += slotBindings: caseSetSlotBindingsSchema.optional()  (no .default())
```

- `slotKey` = named-slot pattern `^[a-z0-9]+(?:-[a-z0-9]+)*$` (≤32). **The literal key `default` is reserved and legal** — see A2a.
- `bundleHash` NOT in manifest — resolved server-side from the immutable publish row.
- Depth-1 only (strictObject refuses nesting); cardinality not validated (documented as not-a-server-contract).

### A2. Validation (`validateManifest`, after aliases / before duplicate-props)

| Code | When | Where |
|---|---|---|
| `slot_component_not_published` 422 | type unknown / version missing / deleted / status not accepted | PUT + run start |
| `slot_component_design_system_mismatch` 422 | child from another DS | PUT |
| `slot_self_reference` 422 | child resolves to subject component | PUT |
| `slot_props_invalid` 422 | child props fail pinned version's propsJsonSchema | PUT |
| `slot_props_dynamic` 422 | child props contain `$`- or `__eui`-prefixed keys at any depth | PUT + re-checked in `pushDraftCapture` |
| `slot_unknown` 422 | **named** slot not in candidate's `extracted.meta.slots` | run start (warning at PUT) |
| `slot_bindings_unsupported` 422 | **named** keys present but candidate lacks `capabilities.namedSlots` | run start (warning at PUT) |

- **Accepted publish statuses (v3, symmetric):** `active|deprecated|superseded` at BOTH PUT and run start; non-active statuses produce warnings `slot_pin_deprecated`/`slot_pin_superseded` (house pattern `repos/prototypes.ts:155-158`). Hard 422 `slot_component_not_published` only for missing row / deleted component / `archived|rejected|staging|failed`. Rationale: promote auto-supersedes prior versions, and re-PUT of a byte-identical manifest is the documented idempotent flow (driver `case-set put`, `wouldBeCached`) — an asymmetric PUT gate would brick it the moment any child gets a new version.
- Child pin lookup: **new** `publishedPinByNameAndVersion(db, name, version, designSystem)` (neither `componentPinByVersion` (id-keyed, any status) nor the name-based active-latest sibling does name+exact-version). Query mirrors `validation.ts:203-208`: `c.deleted_at IS NULL`, design system from the **revision** (`cr.design_system`) — a soft-deleted component's reserved name must not resolve (T1.1 test: pinning a tombstoned component's version → `slot_component_not_published`). Memoize per `(name, version)` within one `validateManifest` call.
- **JSON-safety** (`slot_props_dynamic`): the same recursive `$`-walk as `validatePropsAgainstSchema` (`service.ts:1216-1231`) plus `__eui`-prefix refusal, applied at PUT AND re-applied in `pushDraftCapture` before child props enter `slotChildren`/bootstrap (manifests are immutable once published — belt and braces). Tests bind `{"$asset":…}` and `{"$cond":…}`.

### A2a. Default slot contract

The default slot is **implicit** in this codebase (`runtimeSpec.ts:253` `slotOf(child) ?? "default"`; components do not declare `default` in `definition.slots`; extraction excludes it). Contract:
- `slotBindings.default` is accepted and **exempt** from the `extracted.meta.slots` membership check and from the `capabilities.namedSlots` gate (any component that renders `children` qualifies; `slot_unknown`/`slot_bindings_unsupported` apply to named keys only).
- A6 emits default-slot children **without a `slot` field** (canonical representation; `runtimeSpec` collapses both forms into `slotIndices.default`, so this is a representation choice, documented).
- PUT-time warning if the subject's last published version declares neither `capabilities.namedSlots` nor renders children (undecidable precisely — warning, not refusal).
- Done-criteria (T3.1 + W5 e2e) include a **9-child default-slot carousel** capture. This is what unblocks PayPaymentMethodCarousel.

### A3. duplicate_case_props fix + hash identities

Two DISTINCT hash values, never compared to each other (named explicitly to avoid drift):
- **PUT-time dedup key** (in-memory only, never persisted): `${propsHashOf(props)}:${dedupSlotsKey ?? "-"}` where `dedupSlotsKey` hashes the **normalized** manifest bindings — each child as `{type, version, propsHash: propsHashOf(child.props)}` — so `props: {}` vs absent collide as they should.
- **`slotsHash`** (persisted v31 column, coverage key, handshake, evidence): sha256 of the **resolved** tuple list `[{slot,index,componentId,version,bundleHash,propsHash}]` — the same pre-image as the frame-fingerprint input, computed once in `resolveSlotBindings`. Binding the resolved value into the handshake mirrors the prototype path's frozen-pins rationale (`protocol.ts:177-186`).

Dedup rules: equal props + different bindings pass (SMS fix); equal props AND equal bindings refuse `duplicate_case_props` (message updated); alias must repeat both props and bindings (`invalid_alias_target` otherwise). `propsHash` itself unchanged.

**Second, implicit dedup (v3, blocker fix):** `buildCasesFromManifest` ALSO dedups — `byPropsHash` silently turns any later equal-props case into an alias (`caseSets.ts:467-490`, invariant comment "одна и та же props-пара никогда не снимается дважды"), and aliases are never captured (`orchestrator.ts:517`). Without fixing this, the SMS case-set passes PUT and then still collapses to one frame at run time. Fix: key the in-build map on `(propsHash, dedupSlotsKey)` — the normalized manifest-level key is resolution-free, so no ordering change is needed — and restate the invariant comment as "(props, slots) pair is never captured twice". Done-criterion (T1.1): a manifest with two equal-props/different-slots cases builds TWO entries with `aliasOfCaseId === null`; (T2.1) their frame fingerprints differ.

### A4. AcceptanceCase + fingerprint (`cases.ts`, `ids.ts`)

- `AcceptanceCase += slotBindings?: ResolvedSlotBinding[]` (`{slot,index,componentId,name,version,bundleHash,props,propsHash}`, ordered — render order) and `slotsHash?: string`. Absent, never `[]`.
- `FrameFingerprintInput += slotBindings?` (subset `{slot,index,componentId,version,bundleHash,propsHash}`), hashed conditionally (`definedOnly`).
- **`CaseFingerprintCase += slotBindings?`** and `caseFingerprintsOf` threads it with conditional spread — explicitly in scope of T1.2 (the totality guard alone cannot catch its omission).
- `FIELD_LAYERS`: `slotBindings: ["frame"]`; `slotsHash: ["report-only"]` (derivative — every pixel-relevant input already hashed by value in the frame layer).
- **ALGO 6 → 7** + honest history paragraph. Consequences: global verdict-reuse invalidation; recompute + re-diff, no recapture — **valid only while `EASYUI_ACCEPTANCE_VERDICT_RECOMPUTE=1`** (kill-switch short-circuits the cascade at `runner.ts:485`); W5 deploy checklist verifies the flag before rollout. Old algo-6 rows linger in `acceptance_case_results` until GC (noted).
- Differential tests at `caseFingerprintsOf` level: slot-free case === golden `f29b0c49…`; frame moves on child `bundleHash` change alone and on child ORDER change alone; `slotBindings: []` normalized to absent.

### A5. Run start + durable reconstruction (blocker fix)

Slot resolution is a property of **case construction, not one call site**. New `casesOfRun(manifest|run, candidateEntry, resolver)` in `caseSets.ts` wraps `buildCasesFromManifest` + `resolveSlotBindings`; raw `buildCasesFromManifest` is forbidden outside it (comment + lint-style test). Every consumer goes through it: `startRun`/createRun (`orchestrator.ts:316-318`), the durable reconstruction fallback `runCases` (`orchestrator.ts:481-482` — manifest is the authoritative durable source), evidence `manifestOf`, **and the dry-run/coverage routes (`server/routes/caseSets.ts:102` — the fourth call site round 1 missed; the endpoint's contract is PUT-parity)**. `baselineVerdictPolicies` (`orchestrator.ts:675`) stays resolution-free — justified per call site (verdict snapshot reads no slot field), guard comment added.

**Resolver modes (v3):** `resolveSlotBindings` has two modes. **Gating** (run start + PUT/dry-run): full status policy per A2, hard 422s. **Reconstruction** (`runCases` fallback — pins were already authorized at createRun): status-blind AND tombstone-blind (`c.deleted_at` ignored — a mid-flight soft-delete must not make the row "absent"), resolves `componentId/bundleHash/propsHash/slotsHash` from the publish row refusing only if the row is physically absent (publish rows are never deleted — v8 rebuild only copies; refusal is defensive). Refusal terminalizes with a **named** `statusReason` (supported: `TerminalizeRunInput.statusReason`, `repo.ts:226`), not a bare `gates.error` string. **v3.1 (round 3 F3):** status-blind reconstruction covers fingerprints/evidence; CAPTURE of an archived child still fails (`ComponentRepo.bundle` 404s non-renderable statuses) — that failure surfaces as a named capture-time refusal (`slot_component_not_published` in the case's gate error), not an opaque infra retry; T2.1 tests both the reconstructs-fine path (cache-hit run) and the named capture failure (run needing capture with archived child). **Regression tests (T2.1):** restart simulation (caseSets map entry deleted) → recomputed frame fingerprint equals persisted `acceptance_cases.frame_fingerprint`; same simulation with a child flipped to `archived` → reconstruction succeeds, capture (if needed) fails named.

**Dry-run/coverage surface (v3):** `server/routes/caseSets.ts` is added to T1.1 ownership. Dry-run (`POST …/case-sets/validate`) routes through `casesOfRun` in gating mode, reporting candidate-dependent facts as warnings (same as PUT); its `cases` must show both equal-props/different-slots cases as non-alias capture targets. Coverage responses (`coverageOf` + `GET /api/case-sets/:id/coverage`) expose the **slot-aware frame count** (non-alias case count) so an agent can derive `expectedCases` for promote under the A8 key.

### A5a. Baseline-carry / impact guard (blocker fix)

`carryBaselineCase` (`runner.ts:787-800`) deliberately skips the frame layer, and `computeImpact` knows nothing about case-sets — a changed slot child would silently carry a stale verdict and poison the cross-run cache under the new fingerprint. **v3: one per-case guard** (replaces round-2's blanket conservative-on-case_set_id, which would force a full-family recapture whenever one case is added to a content-addressed set): `carryBaselineCase` carries only when `(baseline.props_hash ?? null) === (item.propsHash ?? null) && (baseline.slots_hash ?? null) === (item.slotsHash ?? null)` — explicit `?? null` form (row NULL vs case `undefined`); a mismatched case falls through to live execution, the rest of the family still carries. This closes the pre-existing props hole per-case too. Mechanics: add `props_hash`/`slots_hash` to the `BaselineCaseSnapshot` Pick (`runner.ts:741-743`) and to the orchestrator fallback literal (`orchestrator.ts:548-551`).
Regression tests (T2.5): run A (case-set X, child v1) → run B (case-set Y, same case ids/props, child v2, baseline A) must NOT carry the changed case; the slot-free positive-carry suite (`impact.test.ts:346+`) stays green (NULL===NULL carries).

### A6. Capture path

- `gates/capture.ts` + `gates/types.ts`: pass `slotBindings` (conditional spread) into `enqueueComponentCandidate`.
- `service.ts`: `enqueueComponentCandidate`/`pushDraftCapture` accept bindings (re-run the `$`-walk here); `InternalJob += slotChildren?: CapturePin[]`, `slotTree?`; component-draft `expected += slotsHash?` (**resolved** hash, A3); `draftComponentAllowedUrls` += per distinct child: `/api/components/:childId/versions/:v/bundle.js` + `ComponentRepo.assets(childId, v)` asset URLs — **no child DTO URLs** (loader consumes only `{name,bundleUrl,bundleHash}`; meta rides in bootstrap; DTO would expose published `source` to the capture page). T2.2 asserts the allowlist as an **exact set**, not `toContain`.
- Bootstrap `+= slots: {children: CapturePin[], tree: [{slot?,index,name,props}]}` (default-slot entries carry no `slot`).
- `src/capture/protocol.ts`: optional `slotsHash` on ComponentDraftExpected/Ready; typed bootstrap `slots`.
- `scripts/screenshot-worker.mjs`: conditional `slotsHash` in `readyToExpected` (test-first golden for the slot-free byte-identity).
- `CaptureComponent.tsx`: multi-element runtimeSpec (`c` + `s0…sN`; named children get `slot`, default children don't; customTypes = parent + child names); one `loadCustomComponents` call for parent draft + child published bundles; `ready` echoes `slotsHash` from `bootstrap.expected` (house pattern — rev/sourceHash/bundleHash are already echoed, only propsHash is recomputed).

### A7. Evidence

`EvidenceCaseEntry += slotBindings?` (resolved tree incl. child props) and `slotsHash?` — written by `manifestOf` from the same `casesOfRun` computation as the fingerprints. RunManifest version stays 1. Promote binds `evidenceManifestHashes` — slot tree becomes promote-bound proof. Test-first golden: slot-free manifest byte-identical.

### A8. Coverage + migration v31

- Migration v31: `ALTER TABLE acceptance_cases ADD COLUMN slots_hash TEXT`; written by `repo.insertCase`.
- `runCoverage` key → `${props_hash}:${slots_hash ?? "-"}@${surfaceKey}`. Keys are in-memory, never persisted — the byte format may change; the **behavioural** invariant (T2.3 done-criterion): for slot-free runs, coverage SETS have the same cardinality and pairwise intersections as before, and `expectedCases` verdicts for an existing promote are unchanged. Same-props/different-slots runs stop colliding in `assertRunSetCoherent`.

### A9. Capabilities/contracts/docs

- `features.caseSetSlotBindings` (= `acceptanceMatrix === true`), `limits.caseSetMaxSlotChildren: 12`, `caseSetMaxSlotsPerCase: 8`.
- `server/contracts.ts`: capabilities schema + **`errors` arrays for all new refusal codes** on the affected contracts (undeclared codes never reach generated OpenAPI). `openapi.json` is **generated**: run `npm run generate:openapi`, verify `npm run verify:openapi` — never hand-edit.
- `docs/server-api.md`: slotBindings subsection (schema, pinning rationale, depth-1, default-slot contract, dedup/alias semantics, status policy, 422 table PUT-vs-run, both limits, ALGO-7 + recompute-flag note, cardinality disclaimer, rollback note, naming collision with composition analyze DTO).

## Feature B — prototypeCandidateOverlay (v1: capture-only, bytes-only)

### B1. API

**Precondition (v3, stated up front):** the overlay is a pin swap over the revision's existing pins — it substitutes a **candidate of a component that already has a published version pinned in the document** (`validation.ts:200-208` requires `status='active'` to save the document at all). A never-published component cannot be overlaid; the first-publish path for the feedback's components is Feature A (`slotBindings`). B's value = composite/interactive regression checks of new revisions of already-published components. W5 names which feedback components B unblocks (revN of published PaySmsModule etc., not first publishes).

`POST /api/prototypes/:id/screens/:screenId/screenshot` body += `candidateOverrides: [{candidateId}]` (≤ `prototypeCandidateOverlayMax: 2`). Refusals: `invalid_request` 400 (shape/limit/dup componentId); **uniform `not_found` 404** for unknown candidate AND foreign candidate; `candidate_component_not_in_prototype` 422 (candidate's component has no pin in the screen — distinct from generic "unused" so the message can explain the precondition); `candidate_evicted` 409; 404 when feature off.

**Authz (v3):** `requirePrototypeOwner` first; then per override an **inline** check — resolve candidate → `resourceOwner(db, "components", componentId)` compared against the principal (admin bypass kept, documented) — mapping BOTH "no such candidate" and "not yours" to one `404 not_found` with an **identical message**. Deliberately NOT `requireResourceOwner` (it 403s on foreign resources, re-creating the existence oracle B1 forbids). Same mapping on the read paths (B2.6). T2.4 oracle test: foreign-but-existing candidate and nonexistent candidate produce byte-identical responses.

### B2. Server

1. **Bytes-only + HTTP retrieval (v3, blocker fix; v3.1 precisions):** overlay jobs force `deliver:"bytes"` — no asset, no visual-baseline poisoning path, "capture-only" literally true. New **`GET /api/screenshot-jobs/:jobId/bytes`** returning `image/png` (RESULT_TTL = 10 min; contract declared via `contentType` without `responseSchema`, precedent `getComponentBundleContract`), and the job-status JSON exposes `{kind:"image-bytes", width, height, byteLength, pngSha256}` — metadata only. **v3.1 (round 3 F1):** `ScreenshotImageBytesResult` already exists and is what every acceptance capture returns; the acceptance gate reads `result.bytes` through the SAME accessor (`awaitJob` → `service.get()` → `result.bytes`, `gates/capture.ts:159,193-200`). Therefore: sanitize at the **HTTP boundary only** (`routes/screenshots.ts` JSON envelope) — never in `get()`/`job.result`; the sanitized variant applies to **all** image-bytes results incl. existing component-candidate bytes jobs (whose status bodies today leak the numeric-keyed array); T2.4 test: a component-candidate bytes job's HTTP status body carries no `bytes` while the in-process gate still receives them. `screenshotJobResultSchema` gains the variant; driver.mjs/skills get an overlay-aware fetch path. Done-criterion: an HTTP client fetches the overlay PNG end-to-end.
2. Pin swap in `enqueuePrototypeFrozen`: draft bundleUrl, candidate bundleHash, `status:"candidate"`, `candidate:{candidateId,rev,sourceHash}`.
3. **Handshake:** `componentManifestHash` keeps its published derivation computed over the **overridden** pin list — export it as `componentManifestHashOf(pins)` from `repos/prototypes.ts` (today a private method with a special empty case) and compute ONCE, assigning both `expected.componentManifestHash` and `captureManifestHash` (two write sites, `service.ts:578/:593` — divergence = silent handshake failure). No `{base, overrides}` re-derivation. Plus optional `candidateOverlay: [{componentId,candidateId,bundleHash}]` on PrototypeExpected/Ready + conditional `readyToExpected` entry. T2.4 asserts `expected.componentManifestHash === job.captureManifestHash` ≠ stored revision hash for overlay jobs. Client detection signal (documented): the response pin carries the candidate bundleHash; unchanged ⇒ override not applied ⇒ fail loudly.
4. Allowlist: overridden pin → draft bundle URL + candidate assetIds only; shadowed published version's URLs NOT added.
5. **GC pinning as a lease (v3):** register `{sourceHash, expiresAt: now + JOB_DEADLINE_MS + slack}` under a lease id BEFORE reading the candidate bundle; release in `try/finally` on every non-enqueued exit (`candidate_component_not_in_prototype`, `queue_full`, any throw — several refusals are only discoverable post-registration); on successful enqueue the lease hands over to the job-status filter (`status ∈ {queued, running}`); the provider drops expired leases unconditionally. Union with the orchestrator provider at registration; drop the explicit `{pinned:…}` arg at `main.ts:270`. Tests: GC between resolve and enqueue; failed route leaves pin set empty; abandoned lease expires.
6. **Read-path authz (blocker fix):** overlay jobs record the overridden componentIds; `GET /api/screenshot-jobs/:jobId` and `GET …/bytes` require `requirePrototypeRead` **AND** component ownership per override (inline uniform-404 mapping per B1) — candidate pixels must not leak to share-link/published-prototype principals. **Receipts (v3):** `storeReceipt` runs unconditionally for every job and its 7-day `ownerKey=prototype:<id>` link outlives the in-memory job, so B2.6's per-override check is unimplementable there — overlay jobs **suppress receipt writing** (short-circuit in `storeReceipt`; `server/capture/receiptStore.ts` in T2.4 ownership), documented in B3. Tests: non-owner on published prototype, share principal — status+bytes refused; receipt route 404 for overlay jobs.
7. Browser: `CapturePrototype.tsx` consumes frozen pins verbatim; echoes `candidateOverlay` into ready.
8. **HTTP contract (v3):** `candidateOverrides` added to `prototypeScreenshotContract.requestSchema`, `candidateOverlay: [{componentId,candidateId,bundleHash}]` + the new refusal codes added to its `responseSchema`/`errors` — the enqueue/status response (not the internal handshake) is the declared provenance surface (W4 regenerates openapi).

### B3. Capabilities/docs

`features.prototypeCandidateOverlay` (= acceptanceMatrix && !validateDisabled), `limits.prototypeCandidateOverlayMax: 2`; docs subsection: request/response (bytes delivery + `GET …/bytes`, 10-min TTL), refusal codes, manifest-hash semantics, detection signal, admin note, the **precondition** (already-published component only; first publishes = Feature A), and "что overlay НЕ делает": no verdict, no evidence run, no promote, no persistence (bytes-only, no receipt), not in the prototype document, cannot overlay a never-published component; use `slotBindings` for publish-backing proof.

## Stage 2 review triage (round 1: 3 reviewers + adversarial verify, wf_819455de-ce6)

**Accepted (fix in plan):**
1. [blocker→major] Durable reconstruction slot-blind → A5 `casesOfRun` + restart-simulation test.
2. [blocker] Baseline-carry skips frame layer → A5a two guards + regression test (also closes pre-existing props hole via conservative basis).
3. [major] `CaseFingerprintCase` omission uncatchable by FIELD_LAYERS → A4/T1.2 explicit, tests at `caseFingerprintsOf` level.
4. [major] Golden frame hash didn't exist → captured at HEAD e3a93fc (`f29b0c49…`); test-first goldens for other byte-identity criteria.
5. [blocker] Default slot unbindable (Carousel stays blocked) → A2a default-slot contract + 9-child done-criteria.
6. [major] `componentManifestHash` re-derivation breaks published contract → B2.3 same-formula-over-overridden-pins (verifier's improvement over the reviewer's own fix).
7. [major] Rollback 500s on slotBindings manifests → stated policy + named `case_set_manifest_unreadable` ApiError.
8. [blocker] Read-path authz leak of candidate pixels → B2.6 dual authz on reads.
9. [major] "No persistence" false / baseline poisoning → B2.1 bytes-only delivery (kills the asset path entirely; stronger than provenance-gating two reference routes).
10. [major] `$`-directive gate bypass → `slot_props_dynamic` at PUT + re-check in capture.
11. [major→minor] GC pin TOCTOU + startup-GC bypass → B2.5 pin-before-resolve, union at startup.

**Accepted minors:** absent-not-`[]` invariant; behavioural (not byte) coverage-key criteria; dedup normalization (`props:{}` ≡ absent); publish-status set + `publishedPinByNameAndVersion` + memoization; recompute-kill-switch note in W5; contracts `errors` arrays + generated openapi workflow; resolved-tree slotsHash in handshake (folded into A3); uniform-404 + admin doc; provenance ownership (superseded by bytes-only); drop child DTO URLs from allowlist; render-cost measurement of the maximal legal case added to W5 (limits revisited if the 60 s job deadline is threatened).

**Rejected (refuted by verify pass, recorded):**
- "slotsHash three incompatible definitions / unimplementable browser-side" — echo-from-bootstrap is the house pattern; residue folded into A3's explicit two-identity naming.
- "Old server silently ignores candidateOverrides" — flag-off returns 404 per B1; response pins already echo bundleHash (detection signal now documented in B2.3).
- "1 MB PUT → tens of thousands of lookups" — product ceiling is 64 cases (`acceptanceMaxCasesPerRun`), real ceiling ~6k lookups; residue = memoization (accepted above).

## Stage 2 review triage (round 2: targeted, wf_8a3bd059-875)

**Accepted (fixed in v3):**
1. [blocker] `buildCasesFromManifest`'s implicit props-only alias dedup still collapses the SMS case → A3 in-build `(propsHash, dedupSlotsKey)` key + non-alias done-criteria.
2. [major] Reconstruction re-applies the status gate → A5 two resolver modes (gating vs status-blind reconstruction) + named terminal reason + archived-mid-flight test.
3. [major] `routes/caseSets.ts` (4th `buildCasesFromManifest` call site) unowned → T1.1 ownership; dry-run through `casesOfRun`; coverage exposes slot-aware frame count for `expectedCases`.
4. [major] Asymmetric status policy breaks idempotent re-PUT (promote auto-supersedes children) → symmetric `active|deprecated|superseded` + `slot_pin_deprecated`/`slot_pin_superseded` warnings.
5. [blocker] Bytes-only frame unreachable over HTTP → B2.1 `GET …/bytes` + `image-bytes` result variant + driver/skill update + e2e fetch criterion.
6. [blocker→major] Pin-swap precondition unstated (first-publish components stay B-inert) → B1 precondition paragraph, `candidate_component_not_in_prototype`, honest W5 criterion; first-publish = Feature A.
7. [major] Receipt handle leaks under prototype-read authz, 7-day link can't carry per-override authz → B2.6 suppress receipts for overlay jobs; `receiptStore.ts` to T2.4.
8. [major] Pin registration leaks on pre-enqueue failure → B2.5 lease with expiry + try/finally release + tests.
9. [major] Uniform-404 contradicts `requireResourceOwner` (403 oracle) → B1 inline `resourceOwner` compare with identical-message 404 mapping, also on read paths.

**Accepted minors:** per-case carry guard instead of blanket conservative impact (A5a rewritten — avoids full-family recapture on content-addressed set change; `props_hash`/`slots_hash` into `BaselineCaseSnapshot` Pick + orchestrator fallback literal); `publishedPinByNameAndVersion` spec (tombstone + revision-DS); `componentManifestHashOf` exported, computed once for both write sites; `candidateOverrides`/`candidateOverlay` in the HTTP contract schemas.

**Rejected:** "carry guard not NULL-safe kills all slot-free carry" — the plan already said NULL-safe, and the slot-free positive-carry suite (`impact.test.ts:346+`) fails loudly on such a bug; residue (explicit `?? null` form, Pick extension, positive-carry test in T2.5) adopted.

## Stage 2 review triage (round 3: delta verification — CLOSED)

Round 3 (single reviewer over v3 deltas): **no blocking findings**; all six v3 deltas verified sound against source. Three residual findings patched as v3.1: F1 image-bytes sanitization at the HTTP boundary only + applies to all bytes jobs + gate-vs-HTTP test (B2.1); F2 T2.5 depends on T2.3, widened snapshot type (W2); F3 named capture-time failure for archived child + tombstone-blind reconstruction (A5). **Stage 2 complete — no open objections.**

## Execution

### Waves and file ownership (no file in two concurrent tasks)

- **W1 (parallel):**
  - T1.1+T1.3 (one agent, sequenced): `src/acceptance/caseSetSchema.ts` → `server/acceptance/caseSets.ts` + `caseSets.test.ts` + `server/routes/caseSets.ts` — schema incl. `default` key, limits, `publishedPinByNameAndVersion` (+memo, tombstone-safe), `$`-walk (`slot_props_dynamic`), dedup key (normalized) incl. **in-build alias dedup on `(propsHash, dedupSlotsKey)`**, status warnings `slot_pin_deprecated`/`slot_pin_superseded`, `slotsHashOf` (resolved), alias rule, `case_set_manifest_unreadable`, dry-run/coverage через `casesOfRun` + frame count. Done: golden `cset_` untouched-green; slot-free manifest hashes to historic id; equal-props/different-slots passes AND builds two non-alias entries; equal/equal refuses; alias mismatch refuses; `$asset`/`$cond` refused; `props:{}`≡absent collides; tombstoned pin refused; re-PUT with superseded child succeeds with warning.
  - T1.2: `server/acceptance/ids.ts` + `ids.test.ts` + `capture/renderer.test.ts` + field declarations in `cases.ts` — incl. `CaseFingerprintCase` + `caseFingerprintsOf` threading. Done: ALGO===7; `caseFingerprintsOf` slot-free frame === `f29b0c498389404e5e426486bbb6050add243c6c0d97eff579ef127ec9fabeb1`; moves on child bundleHash alone and order alone; `[]` normalized to absent.
- **W2 (after W1):**
  - T2.1: `casesOfRun` + `resolveSlotBindings` (two modes) in `caseSets.ts`, `orchestrator.ts` (createRun, runCases fallback, guard comments, `BaselineCaseSnapshot` fallback literal). Done: run-start refusals; restart-simulation fingerprint-equality test; archived-mid-flight reconstruction test; two slot-differing cases → distinct frame fingerprints; orchestrator tests green.
  - T2.2: `gates/capture.ts`, `gates/types.ts`, `service.ts` (draft path incl. `$`-recheck), `scripts/screenshot-worker.mjs`, `src/capture/protocol.ts`. Done: job carries child pins; allowlist exact-set (no DTO URLs); test-first golden for slot-free `readyToExpected`.
  - T2.3: `migrations.ts` + `migrations.test.ts` + `acceptance/repo.ts`. Done: populated-DB v31 test; behavioural coverage invariant for slot-free runs.
  - T2.5 (after T2.1 **and T2.3** — needs `slotsHash` on cases and the v31 `slots_hash` row type): `server/acceptance/runner.ts` (per-case carry guard; snapshot type widened to `Pick<…> & {props_hash: string|null; slots_hash: string|null}` — a bare Pick keeps `props_hash` non-nullable and breaks the orchestrator fallback literal) + `server/acceptance/impact.ts` if needed + their tests. Done: changed-slot case not carried while rest of family carries; slot-free positive-carry suite (`impact.test.ts:346+`) green.
  - T2.4 (after T2.2 — service.ts prototype path): `routes/screenshots.ts`, `components/candidates.ts`, `main.ts`, `enqueuePrototypeFrozen`, `server/capture/receiptStore.ts` — bytes-only + `GET …/bytes`, lease pinning, dual read authz (inline uniform-404), receipt suppression. Done: new `prototype-candidate-overlay.test.ts` covers refusal codes incl. byte-identical oracle test, `candidate_component_not_in_prototype`, manifest hash over overridden pins (=== captureManifestHash, ≠ revision hash), allowlist delta, GC-between-resolve-and-enqueue, failed-route-leaves-no-pin, lease expiry, non-owner/share-principal status+bytes refusals, receipt 404, no asset created, HTTP PNG fetch end-to-end.
- **W3 (parallel):**
  - T3.1: `src/capture/CaptureComponent.tsx` + tests + `named-slots.test.ts` extension. Done: named-slot 2-child routing; **9-child default-slot** rendering; `slotsHash` echoed.
  - T3.2: `components/promote.ts` + tests. Done: same-props/different-slots two-run promote passes; `expectedCases` counts two.
  - T3.3 (after T2.1): `evidence.ts` + tests + `manifestOf`. Done: slot run manifest carries resolved tree; test-first golden slot-free byte-identity.
- **W4 (single agent):** `routes/meta.ts`, `contracts.ts` (+`errors` arrays, `image-bytes` result variant, `candidateOverrides`/`candidateOverlay` fields), regenerate `openapi.json`, `docs/server-api.md`, affected skill docs + `.claude/skills/author/driver.mjs` overlay-aware result handling. Done: `npm run verify:openapi` green; docs checklist complete.
- **W5 (orchestrator):** `npm run verify`; `bun test server/`; `npm run e2e` + new e2e (publish child → slot-parent candidate → case-set with two slot-differing cases → run → two distinct frames → promote; + carousel default-slot capture); reverse-compat: prior build vs v31 DB starts; measure worst legal slot case (12×8) against the 60 s job deadline — lower limits if threatened; deploy checklist: `EASYUI_ACCEPTANCE_VERDICT_RECOMPUTE=1` confirmed before rollout.

## W5 verification results (2026-08-05 — EXECUTED, all green)

- `npm run verify` PASS; `npm run e2e` 151 passed / 1 pre-existing skip; full `bun test server/ scripts/` 1178 pass + vitest 1330 pass; `verify:openapi` clean.
- Reverse-compat: old runner's `for (index = current; index < migrations.length)` no-ops at user_version=31 → prior build starts against v31 DB; slot-manifests fail named (`case_set_manifest_unreadable`).
- **Runtime (real chromium, local server, DS slotlab):** case-set with two byte-identical-props cases differing only in `slotBindings` accepted (no `duplicate_case_props`) and run `pass` 3/3: frames A `fdab5abf…` ≠ B `9a60b78d…` (234×141), 9-child default rail C `118c4e26…` 478×141 (ширина арифметически точная: 32+9×44+8×8+2); `acceptance_cases.slots_hash` populated and distinct at equal `props_hash` (проверено оркестратором напрямую в sqlite). Overlay smoke: `--candidate` snap `7b933f94…` ≠ published `e96996f0…`, `GET /bytes` 200 image/png no-store, pins carry `status:"candidate"`.
- **Worst-case measurement:** 12-child и 12+12 (24 children) cases capture in ~3.7 s каждый — ~6% от 60 s deadline, плоская кривая 4→24 детей (стоимость — фикс-оверхед кадра, не дети). Лимиты 12×8 не пересматриваются.
- **Deploy checklist:** перед выкаткой подтвердить `EASYUI_ACCEPTANCE_VERDICT_RECOMPUTE=1` (иначе ALGO-7 bump = полная пересъёмка кэша). Деплой по отдельной команде пользователя.

**Follow-ups (не блокируют, зафиксированы):**
1. [DX, pre-existing] Капчур недоступен (worker 501 `screenshot_unavailable`) → ран терминалится `error` без какой-либо диагностики (statusReason null, artifacts пустые, лога нет) — оператору не за что зацепиться. Отдельная задача.
2. [docs] Статус-ручка overlay-джобы возвращает `candidateOverlay: null` — provenance живёт только в 202-ответе enqueue; поправить формулировку в docs/server-api.md («enqueue response», не «enqueue/status»).
3. [fixture] Публикация organism-парента требует `definition.ownership.reason` (`atomic_policy_violation`) — помнить в сценариях приёмки.

## Critical files

`src/acceptance/caseSetSchema.ts` · `server/acceptance/caseSets.ts` · `server/routes/caseSets.ts` · `server/acceptance/ids.ts` · `server/acceptance/cases.ts` · `server/acceptance/orchestrator.ts` · `server/acceptance/runner.ts` · `server/acceptance/impact.ts` · `server/acceptance/evidence.ts` · `server/acceptance/repo.ts` · `server/screenshot/service.ts` · `server/acceptance/gates/capture.ts` · `src/capture/CaptureComponent.tsx` · `src/capture/protocol.ts` · `scripts/screenshot-worker.mjs` · `server/components/promote.ts` · `server/routes/screenshots.ts` · `server/components/candidates.ts` · `server/capture/receiptStore.ts` · `server/repos/prototypes.ts` · `server/migrations.ts` · `server/routes/meta.ts` · `server/contracts.ts` · `docs/server-api.md`
