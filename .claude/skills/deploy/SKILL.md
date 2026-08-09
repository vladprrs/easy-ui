---
name: deploy
description: Deploy easy-ui to production (easy-ui.pay-offline.ru on Dokploy) — push to main builds the image in GitHub Actions (GHCR) and auto-deploys; check deploy status, trigger a manual redeploy, watch progress, and verify health, session auth, and SPA.
---

# Deploy easy-ui to Dokploy

Production runs at **https://easy-ui.pay-offline.ru** — a Dokploy compose service running the prebuilt image `ghcr.io/vladprrs/easy-ui:latest` (`docker-compose.yml` at repo root, single container: Bun server serving API + `dist` static, named volume `easy-ui-data:/app/data` for SQLite + published component modules). Application auth uses named cookie sessions bootstrapped by `ADMIN_NAME`/`ADMIN_PASSWORD`. The outer Basic barrier (`LEGACY_BASIC_AUTH`, deprecated alias `BASIC_AUTH`) was removed from the prod env on 2026-07-20 — the server code still honors those vars, so setting them in Dokploy re-enables the barrier if ever needed. The image is built by GitHub Actions (`.github/workflows/build-image.yml`) — **never on the prod server**: server-side builds (npm ci + chromium + vite + storybook) starved the 1-CPU host and took the whole box down three times on 2026-07-14. Full deployment contract: `docs/server-api.md#deployment`; plan/history: `docs/plans/2026-07-11-dokploy-deploy.md`.

All paths below are relative to the repo root. The driver is `.claude/skills/deploy/driver.mjs` (plain node, zero deps).

## Prerequisites

Secrets in `.env` at repo root (gitignored; template in `.env.example`):

```
DOKPLOY_API_KEY=...          # Dokploy UI -> Settings -> API/CLI
EASYUI_USERNAME=admin        # named account for post-deploy API/SPA verification
EASYUI_PASSWORD=...          # named-account password
```

Without `DOKPLOY_API_KEY` the driver exits with code 2.

## Deploy (normal path)

Auto-deploy is on: **any push to `main`** runs the `build-image` workflow (build image in Actions → push `ghcr.io/vladprrs/easy-ui:{latest,<sha>}` → call `compose.deploy` via the Dokploy API (`DOKPLOY_API_KEY` Actions secret; the refreshToken deploy-URL rejects non-GitHub payloads with "Branch Not Match")). Dokploy then only does `docker compose pull` + `up` (`pull_policy: always`), ~1-2 min, no load on the host. The old direct GitHub→Dokploy webhook (hook id 651559498) is **disabled** — do not re-enable it: it makes Dokploy build from source on the server. So the deploy itself is:

```bash
git push origin main
gh run watch --repo vladprrs/easy-ui $(gh run list --repo vladprrs/easy-ui --workflow build-image --limit 1 --json databaseId --jq '.[0].databaseId')   # ~3-6 min CI build
node .claude/skills/deploy/driver.mjs watch    # poll Dokploy until done/error (~1-2 min pull+up)
node .claude/skills/deploy/driver.mjs verify   # health/auth/SPA checks against prod
```

Before pushing a feature wave, check the plan's deploy checklist and the `environment:` block in `docker-compose.yml` — feature flags default there (e.g. `EASYUI_ACCEPTANCE_MATRIX`, `EASYUI_ACCEPTANCE_VERDICT_RECOMPUTE`, `EASYUI_RENDERER_POOL` all default to `1`; a Dokploy env override wins over the compose default).

The legacy deploy driver still checks infrastructure state; use the author driver for the session-auth read-back after it reports healthy. The author driver reads `EASYUI_USERNAME`/`EASYUI_PASSWORD` from the environment, not from `.env` — source it first:

```bash
set -a; source .env; set +a
EASYUI_API=https://easy-ui.pay-offline.ru/api node .claude/skills/author/driver.mjs get prototypes
```

Expected auth gates:

```
PASS  health open, ready (200 ready)
PASS  API requires auth (401, www-authenticate=null)
PASS  SPA open (200)
PASS  login sets session cookie (200)
PASS  API with session cookie (200)
```

To smoke-check feature flags after a wave, read `GET /api/capabilities` **with a session cookie** — the endpoint is behind auth, and an unauthenticated curl returns a 401 JSON body in which every feature key is simply absent (looks like "flags missing", is actually "not logged in"):

```bash
set -a; source .env; set +a; jar=$(mktemp)
curl -s -c "$jar" -X POST https://easy-ui.pay-offline.ru/api/auth/login \
  -H 'Content-Type: application/json' -H 'Origin: https://easy-ui.pay-offline.ru' \
  -d "{\"name\":\"$EASYUI_USERNAME\",\"password\":\"$EASYUI_PASSWORD\"}" -o /dev/null -w '%{http_code}\n'
curl -s -b "$jar" https://easy-ui.pay-offline.ru/api/capabilities   # flags in .features, limits in .limits
```

### Wave 2026-08-06 (feedback-3 platform capabilities)

Smoke keys after that wave: `features.figmaMultiSource/geometryContractV2/overlayScrollOwnership` are unconditional `true`; `features.geometryCaseTolerances/comparisonMatte/nestedSlotBindings/captureViewportSurface` follow `EASYUI_ACCEPTANCE_MATRIX`; plus top-level `textAaPresets["live-text-v1"]` and `acceptance.geometryContractVersion: 2`. Post-deploy expectations, not defects:

- **First acceptance run of any existing case-set is a full recapture** — `geometryContractVersion` is a frame-fingerprint input, every pre-wave frame is invalidated by design (~4-6 s/case cold).
- Live-text/clip measurement changed: case-sets that pinned an exact `expectedGeometry` under the old semantics may now honestly fail geometry. Inventory them with `bun scripts/audit-geometry-contract.mjs --db <copy-of-prod-db>` (logical backups don't carry case-sets — take the volume DB) and re-issue manifests with `policy.perCase.sizeDeltaPx` where the delta is proven.
- `Overlay` overflow now clips (or scrolls with `scroll:true`) instead of leaking past the stage; the only pre-wave prod usage (hug-sheet below viewport) is unaffected, but audit new usages after content edits.
- `builtinCatalogHash` shifted (new `scroll` prop is hashed): new prototype revisions get a new catalog hash and `renderInputDiff` legitimately reports it; pre-wave bundle imports decorate `formatTooNew` without blocking.

### Wave 2026-08-07 (migration-retrospective wave, plan `docs/plans/2026-08-07-migration-feedback-wave.md`)

> **Выполнено 2026-08-08** (деплоймент `d2fdd59`, verify 5×PASS, все смоук-ключи PASS; `receiptEnvelopeVersion` живёт **внутри `features`**). Бэкап и прод-аудиты — `.backups/prod-migration-feedback-20260808/NOTES.md` (geometry: 0 семей `legacy-branch-order-sensitive`; runtime-defaults: 156/174 дрейфуют; барьер GO). Гейт `renderer-corpus` при первом пуше честно упал об доволновые outcome-ожидания (W10 убрал `auth/me`-шум из сервисной съёмки, consoleErrors −1) — ожидания адоптированы CI-артефактом (`d2fdd59`).

Five migrations (**v32–v36**) and eight kill-switches. Do the pre-deploy block first — two of its items are go/no-go gates, not paperwork.

**Smoke keys** (`GET /api/capabilities` with a session cookie, see above):

- `features.geometrySurfacesV3`, `candidateDependencyOverlay`, `suggestedPolicy`, `migrationCommit` — `true` while `EASYUI_ACCEPTANCE_MATRIX=1` and the wave's own switch is clear.
- `features.resourceBarrier`, `impactedSnap`, `figmaSourcePackage`, `runtimeSchemaDefaults` — `true`, matrix-independent; `captureNoiseSummary` — unconditional `true`; `receiptEnvelopeVersion: 1`.
- `acceptance.readinessPolicyVersion: 3` — the **default profile's** policy, i.e. what frames are actually captured with. `1` here means `EASYUI_RESOURCE_BARRIER_DISABLED` is set somewhere (Dokploy env wins over the compose default).
- `acceptance.geometryContractVersion: 2` — **not 3, and that is not a defect**: the wave's `rootBounds`/`referenceExportDims` measurements are additive facts, no frame fingerprint input was added and no capture corpus is invalidated by W1.
- `limits.caseSetMaxOverlayNodes: 8`, `prototypeCandidateOverlayMax: 2`, `snapPlanMaxScreens: 256`, `sourcePackageMaxExports: 256`, `migrationCommitPhaseTimeoutMs: 600000`, `resourceBarrierMaxResources: 256`, `resourceBarrierBudgetMs: 8000`.

**Before the deploy:**

- **Named volume backup** `.backups/prod-migration-feedback-<YYYYMMDD>` — one object: `easy-ui.db` + `-wal` + `-shm` + `DATA_DIR/assets/`. Five forward-only migrations ride in this wave; logical backups do **not** carry case sets, so a logical dump is not a substitute.
- **Prod audits on a restored copy of the volume** (never against live prod): `bun scripts/audit-geometry-contract.mjs --db <copy>` (W1b — which stored cases would now get a per-surface verdict / an honest `size-mismatch`) and `bun scripts/audit-runtime-defaults.mjs --db <copy>` (W9 — which published families drift between `??` defaults in code and `.default()` in the schema). Both are read-only inventories; run them **before** shipping, so a post-deploy failure is expected rather than investigated.
- **Barrier cost go/no-go (W2).** The numeric gate is 64 cases x (~6 s + barrier) < `runDeadlineMs` 30 min, target <= 2 s/case. A local measurement on a restored volume copy gave **~0.5 s for 256 resources** — the reference figure; ship if the prod-shaped measurement stays in that order, hold if a case pays more than ~2 s.
- **`EASYUI_PROMOTE_POLICY_STRICT` must stay off for the re-capture window.** W2 moves the readiness policy of both acceptance profiles, and that lands on **two independent axes** (plan §1.5): `policyProfileHash` (strict promote compares the run's hash with the *candidate's*, so a mixed pair — pre-wave run + post-wave candidate — refuses) and `rendererFingerprint` (the readiness policy is an input, so a multi-run promote mixing pre- and post-wave runs is `422 acceptance_renderer_mismatch`). Operational rule either way: **a family is promoted wholly from pre-wave artifacts, or wholly re-built (candidate + all its runs) after the wave** — never half of each.
- **Full re-capture of the acceptance corpus is already pending** from the 2026-08-06 wave (`geometryContractVersion` moved). W2 deliberately ships **before** that re-capture is amortised, so the corpus is paid for once, not twice.

**Rollback windows (per migration; the window is "the image can still be rolled back without restoring the volume"):**

- **v32 (W1a, `expectedSurfaces` on manifests)** — while the window is open, do not persist manifests declaring `expectedSurfaces`/`comparisonSurface`/`clipExpectation`. The old image rejects such a manifest as `422 validation_failed` (strictObject), so a set published in the window becomes unrepublishable after a rollback.
- **v33 (W3, `acceptance_runs.overlay_manifest_json`/`overlay_hash`)** — do **not** create overlay runs in the window: the old image would promote an overlay run **without** verifying the dependency graph. After the first overlay run, rolling the image back requires restoring the volume backup.
- **v34 (W5, `prototype_screen_frames`)** — safe: the old image ignores the receipts and simply stops proving reuse. `EASYUI_IMPACTED_SNAP_DISABLED=1` additionally stops writing frames if the rollback has to happen with the new image still up.
- **v35 (W4, `migration_commits`)** — do not start sagas in the window: a saga interrupted by a rollback keeps its phase row in a table the old image does not know, and promote (an irreversible phase) may already have happened with no receipt reachable.
- **v36 (W8, `figma_source_packages`)** — do not upload packages and do not set `figma.sourcePackageId` in the window: the reference would survive the rollback pointing at a row the old image cannot read. `EASYUI_SOURCE_PACKAGE_DISABLED=1` is exactly this mode.

**Kill-switches** (all eight are declared in `docker-compose.yml` with an empty default = feature on; set to `1` in Dokploy env to disable, and remember a Dokploy override beats the compose default): `EASYUI_GEOMETRY_SURFACES_DISABLED`, `EASYUI_RESOURCE_BARRIER_DISABLED` (**restart required** — the policy is read once per process and feeds three fingerprints), `EASYUI_CANDIDATE_OVERLAY_DISABLED`, `EASYUI_IMPACTED_SNAP_DISABLED`, `EASYUI_MIGRATION_COMMIT_DISABLED`, `EASYUI_SUGGESTED_POLICY_DISABLED`, `EASYUI_SOURCE_PACKAGE_DISABLED`, `EASYUI_RUNTIME_DEFAULTS_DISABLED` (**render-affecting and outside every fingerprint**: while it is set, acceptance of families declaring `capabilities.runtimeSchemaDefaults` is invalid — `runtime_defaults_disabled` shows up in `accept-status`; the supported per-component rollback is republishing the source without the capability).

### KPI baseline of the 2026-08-07 wave (measure before deploying, re-measure after)

No new telemetry was built — every number below comes out of data that already exists. Take the baseline **before** the wave ships; without it the after-number proves nothing.

| KPI | Where the number comes from | Command |
|---|---|---|
| Revisions per shipped component | `summary.revision` of the `accept`/`accept-status` envelope — the candidate rev the family was accepted at, i.e. how many revisions it cost. Aggregate over the harness client cache: `<cache>/links.json` holds candidate → run → cases per component (`--cache-dir` / `EASYUI_CACHE_DIR`, see `.claude/skills/author/cache.mjs`); a five-line `jq`/node pass over that file is the whole "script" — do not build storage for it | `EASYUI_API=… node .claude/skills/author/driver.mjs accept-status <runId> --summary-json` → `summary.revision` |
| Typed-cause coverage (`typedCausePct`) | W7: share of failed cases whose top cause is a typed code rather than an unclassified residual — `summary.topCauses[]` of the same envelope, or `causes[0].code` per case in `--json` | `node .claude/skills/author/driver.mjs accept-status <runId> --json` |
| Captured vs reused screens | W5 snap plan — `captured`/`reused` of the `snap` summary; the plan itself names the reason per screen | `node .claude/skills/author/driver.mjs snap <prototype> --impacted --summary-json` |
| Schema discovery calls = 0 | W6b: the envelope is self-describing, so an agent needs no extra schema fetch | `--summary-json` on any verb returns the full envelope; count `GET /api/schemas/*` in the session |
| Publication tail | W4: target is **1 resumable server workflow + 1 agent receipt write**, not "zero manual steps" — the coordinator's own `WORKFLOW_STATE.md`/`BUILD_ORDER.md` are never written by the server | `migration-commit` receipt: `phasesDone` + one driver receipt file |
| Inexpressible geometry surfaces = 0 | W1: every surface a case needs is declarable (`root`/`layoutUnion`/`paint`/`referenceExport`) | `acceptance.comparisonSurfaces` in capabilities; audit script for the stored corpus |

"Premature publications = 0" has no server-side proxy and is measured by hand off the coordinator's `BUILD_ORDER.md` (share of lanes where a leaf was published only to accept its parent).

### Wave EUI-BR (blocker removal, plan `docs/plans/2026-08-08-blocker-removal-eui-br.md`)

> **Not deployed yet.** The whole wave lives on branch `wave/eui-br`; the single merge into `main` (= auto-deploy) happens **after the v32–v36 rollback window is closed**, or on an explicit instruction. Release package for the migration coordinator: `docs/EASYUI_BLOCKER_REMOVAL_RELEASE_PACKAGE.md`.

One migration (**v37**, BR-06) and **nine kill-switches**. The wave ships **all-off**: every switch is set to `1` in the Dokploy env at deploy time and is cleared one at a time afterwards. There is no staging — the ordered clearing below *is* the canary, and each step is a `redeploy` without a rebuild.

**Compose defaults are OFF (`:-1`) for all nine wave switches** — the plain merge deploys all-off with no Dokploy prep. To *enable* a step, set its variable to `0` in the Dokploy env (an empty value does **not** enable: `${VAR:-1}` substitutes `1` for both unset and empty). To roll a step back, set it back to `1` (or remove the override).

**Deploy all-off, then clear one switch at a time.** After every step: `GET /api/capabilities` with a session cookie (see above) and check the named smoke key; the rollback of a step is putting its switch back.

| # | Step | Switch to clear | Smoke key | Cost |
|---|---|---|---|---|
| 0 | deploy all-off | — | every wave flag `false`; `acceptance.readinessPolicyVersion: 3`, `features.prototypeSchemaResolverVersion: 1`, `features.comparisonPolicyVersion: 1`, `features.geometryOwnershipPolicyVersion: null`, `acceptance.geometryContractVersion: 2` | none — the image must be indistinguishable from the pre-wave one (proved by `server/kill-switch-matrix.test.ts`) |
| 1 | BR-10a/10b — blocker fingerprint + retry disposition | `EASYUI_BLOCKER_FINGERPRINT_DISABLED` | `features.blockerFingerprintV1: true`; `GET /api/acceptance-runs/<terminal run>/retry-disposition` answers 200 | read-only, no invalidation. First, so every later step can be checked with `driver.mjs retry-disposition` |
| 2 | BR-01a **and BR-01b** — schema resolver | `EASYUI_SCHEMA_RESOLVER_V2_DISABLED` | `features.prototypeSchemaResolverV2: true`, `prototypeSchemaResolverVersion: 2` | save/readiness path of **all** documents. **Trap: 01a and 01b share one switch** — the plan's "01a early, 01b late" is not achievable by env, only by build, so this step ships the full resolver. Verify with a save of a composition document + `GET …/render-status` naming the same `resolvedVersion`/`sourceHash`/`propsSchemaHash` |
| 3 | BR-06 — resumable acceptance | `EASYUI_ACCEPTANCE_RESUME_DISABLED` | `features.acceptanceResumeV1: true`; `POST /acceptance-runs/<terminal>/resume` → typed `409 run_not_resumable` | v37 columns only; no fingerprint moves |
| 4 | **Window 1 — re-capture.** BR-02+BR-04 (capture group) and BR-03 (barrier v4) | `EASYUI_CAPTURE_V4_DISABLED`, then `EASYUI_RESOURCE_BARRIER_V4_DISABLED` (**restart required**) | `features.paintCapturePaddingV1/exactContentHugCanvasV1: true`, `comparisonPolicyVersion: 2`; then `resourceBarrierV4: true`, `resourceBarrierPolicyVersion: 4` **and** `acceptance.readinessPolicyVersion: 4` | capture: **re-diff** of every case (comparison layer). Barrier: **full re-capture** of the acceptance corpus — the readiness policy is an input of `readinessPolicyHash`/`policyProfileHash`/`rendererFingerprint`. Do the go/no-go below **before** this step |
| 5 | **Window 2 — geometry semantics.** BR-05+BR-09 | `EASYUI_GEOMETRY_OWNERSHIP_DISABLED` | `features.geometryDecorationOwnershipV1/flowOverflowOwnershipV1: true`, `geometryOwnershipPolicyVersion: 1` | **recompute** (verdict layer), not a re-capture: the auto decoration rule changes the reading of facts, not a single pixel. A pre-wave frame that lacks `preTransformBounds` refuses recompute and honestly asks for a re-capture of that case |
| 6 | BR-07 attribution (S1 + element-level ownership) | `EASYUI_VISUAL_ATTRIBUTION_V2_DISABLED` | `features.visualAttributionV2: true`; `element-map.json` appears in evidence | report-only layer: no verdict depends on it |
| 7 | BR-07 renderer policy profiles — **changes promote-eligibility** | `EASYUI_RENDERER_POLICY_PROFILES_DISABLED` | `features.rendererPolicyProfilesV2: true`, `acceptance.promotionPolicyProfiles` gains `default-v1-exceptions`, `acceptance.rendererPolicyProfiles[]` non-empty | **the only step that widens the set of promotable runs** (`pass_with_exceptions`). Its own axis, its own window: clear it separately and audit what became promotable |
| 8 | BR-08 comparison ownership (subject/integration) | `EASYUI_COMPARISON_OWNERSHIP_DISABLED` | `features.comparisonOwnershipV1: true` | comparison layer, and only for case-sets that declare `comparison.ownership` |

**Planned-but-superseded: there is no `CASE_FINGERPRINT_ALGO_VERSION` bump.** §13 of the plan asked for 7→8 in window 1 as the anti-silent-reuse mechanism. The implementation replaced it with two **conditional** per-layer versions — `comparisonPolicyVersion` (BR-04, comparison layer) and `geometryOwnershipPolicyVersion` (BR-05, verdict layer). The result is strictly better and must not be "fixed" back: an ALGO bump invalidates reuse for the **whole** corpus including cases the wave never touches, whereas the conditional inputs move exactly the cases that are now judged by new rules. `CASE_FINGERPRINT_ALGO_VERSION` stays **7**.

**Rollback window of the new persisted forms** (the window is "the image can still be rolled back without restoring the volume"). Migration **v37** (BR-06) adds `acceptance_cases.error_json`, `acceptance_runs.resumed_from_run_id/attempt/resume_json` and a partial index — additive columns, so a rolled-back image still reads the rows and only loses the lineage.

| Form | Appears with | Forbidden while the window is open | Held off by |
|---|---|---|---|
| case-set with `cases[].paintPaddingPx` / `cases[].preloadAssets` | BR-02 / BR-03 | do not publish such manifests — the old image answers `422 validation_failed` (strictObject), and a set published in the window becomes unrepublishable after a rollback | `EASYUI_CAPTURE_V4_DISABLED=1` (`422 capture_padding_disabled` on `case-sets put`) |
| case-set with `comparison.ownership`/`subjectComponentId`/`dependencyPolicy` | BR-08 | same | `EASYUI_COMPARISON_OWNERSHIP_DISABLED=1` |
| **document** with `elements[].overflowOwnership` (and the composition layout token) | BR-09 | **write only after the window closes** — the old server cannot parse the revision at all (precedent: `region`). Reads are never gated | `EASYUI_GEOMETRY_OWNERSHIP_DISABLED=1` (`422 flow_overflow_ownership_disabled` on save) |
| definition meta with `geometryOwnership` (case-set declarations) | BR-05 | do not publish components/manifests carrying the declaration in the window | `EASYUI_GEOMETRY_OWNERSHIP_DISABLED=1` (`422 geometry_ownership_disabled`) |
| v37 lineage rows (resume) | BR-06 | do not run `resume` in the window — the columns survive a rollback, the lineage does not | `EASYUI_ACCEPTANCE_RESUME_DISABLED=1` |

**Two-push corpus gate arming.** Any change that moves `rendererFingerprint` (window 1 is exactly that) must go through the two-push procedure, not a single push:

1. **push 1** — the change lands with the `renderer-corpus` gate in **bootstrap** mode: it compares nothing and only records the new expectations as a CI artifact;
2. review the bootstrap artifact by hand — diff the pixel-sha of the old and new expectations and confirm every moved case has a reason;
3. **adopt** the expectations in a separate commit;
4. **push 2** — the gate is armed and now actually compares.

**Deploying is forbidden while the job summary still carries `::warning:: bootstrap`** — an unarmed gate proves nothing, and shipping under it converts a review step into a silent adopt.

**Family rule (unchanged canon of the 2026-08-07 wave, extended by this one).** A family is promoted **wholly from pre-wave artifacts, or wholly re-built** — never half of each. Mixed sets refuse with `422 acceptance_renderer_mismatch`. This wave adds a second boundary of the same kind: window 1 moves the **re-diff** boundary (`comparisonPolicyVersion`), so a family whose cases were partly judged under `comparisonPolicyVersion: 1` and partly under `2` is mixed even though its renderer never moved. A pre-deploy audit of mixed families on the restored volume copy is a **go/no-go** step, not paperwork. `EASYUI_PROMOTE_POLICY_STRICT` stays off for the whole re-capture window (same argument as the 2026-08-07 wave: `policyProfileHash` and `rendererFingerprint` move on two independent axes).

**Backup before the merge.** `.backups/prod-eui-br-<YYYYMMDD>/` by the current canon — **no SSH**: `GET /api/admin/db-snapshot` with an admin session (a `VACUUM INTO` standalone file, no `-wal`/`-shm` needed) plus a per-asset pull of `GET /api/assets/:id` for every id in the snapshot's `assets` table (verify sha256). The same snapshot is the `--db` input of the pre-deploy audits. Note the logical-export trap: bulk `GET /api/bundles/export` refuses wholesale with `422 prototype_head_tracking` while the caller owns any `track:"head"` document.

**Go/no-go before window 1:**

- **Re-capture cost.** Estimate on the restored prod copy, not by guess: `POST /api/prototypes/:id/snap-plan` and the `impact` verb say how many cases/screens a barrier switch actually re-captures. Barrier v4 invalidates the **whole** acceptance corpus by construction — the number to produce is "how many cases × ~6 s + barrier", checked against `runDeadlineMs` (30 min per run) so that a family still fits one run.
- **Barrier cost per case — GO on the V0 measurement (V0-D5, real chromium):** the widened crawl costs **+7…32 ms/case** against the 2000 ms/case gate (a pessimistic upper bound of 0.12 s/case at the retained cap of 400 elements). The number was measured on the diagnostic fixture, **not** on the real cascade, so it must be re-measured end-to-end (`settleResourceBarrier` with the `registry` phase) at window 1 before the switch is cleared. Hold the step if a case pays more than ~2 s.
- **`retry-disposition` as the step's own check.** After each step, ask a terminal pre-wave run: `node .claude/skills/author/driver.mjs retry-disposition <runId>`. The expected answer is exactly the invalidation the step promises — `rediff` after capture-v4, `recapture` after barrier-v4, `recompute` after geometry-ownership, `unchanged` after the read-only steps. A step that moves more than it promised is visible here before any corpus is spent.

## Manual deploy / redeploy (no new commit)

```bash
node .claude/skills/deploy/driver.mjs deploy "reason for redeploy"
```

Triggers `compose.deploy` (pull `ghcr.io/vladprrs/easy-ui:latest` + up) and watches until terminal state. Exit 1 on failed deployment (error message printed; full logs only in Dokploy UI → project easy-ui → deployments). This redeploys whatever `latest` currently points to — to ship new code, push to `main` and let the workflow build the image first. To rebuild the image without a code change: `gh workflow run build-image --repo vladprrs/easy-ui` (workflow_dispatch does not auto-trigger the Dokploy deploy — run `deploy` after it finishes).

## Status

```bash
node .claude/skills/deploy/driver.mjs status   # composeStatus + last 3 deployments
```

## Backup (перед волнами с миграциями)

Канон с 2026-08-08 — **без SSH**: `GET /api/admin/db-snapshot` (admin-сессия) отдаёт консистентный физический снимок SQLite (`VACUUM INTO` ⇒ standalone-файл, `-wal`/`-shm` не нужны; пишет audit-событие `admin.db_snapshot`). Ассеты добираются по `GET /api/assets/:id` (список id + sha256 — из таблицы `assets` снимка, sha сверять). Материализованные модули компонентов в снимок не входят — их пересоздаёт публикация из исходников в БД. Снимок + assets класть одним объектом в `.backups/<имя>`; этот же снимок — вход для прод-аудитов (`--db`).

Ловушка логического экспорта: bulk `GET /api/bundles/export` отвергается целиком (`422 prototype_head_tracking`), пока у вызывающего есть хоть один `track:"head"`-док — 143-байтовый «zip» в старых бэкапах это тело этой ошибки. Экспортировать поэлементно, трекающие доки пропускать.

## Rollback

No first-class rollback. Point the compose file at a known-good image tag (`ghcr.io/vladprrs/easy-ui:<sha>` — every main commit is tagged) and redeploy, or revert the offending commit and push (workflow rebuilds and redeploys). DB migrations are forward-only — if a schema change is involved, restoring the `easy-ui-data` volume from a backup is the only way back (mind SQLite WAL: `easy-ui.db` + `-wal` + `-shm` are one unit).

## Gotchas

- **Deploy happens on every push to main** — pushing an unfinished commit deploys it (after the CI build). There is no staging environment.
- **Never build on the prod server.** The image comes prebuilt from GHCR (public package, anonymous pull). If Dokploy ever reports a source build, the disabled webhook was re-enabled or `docker-compose.yml` regained a `build:` section — fix that first.
- Keep `ADMIN_NAME`/`ADMIN_PASSWORD` paired. `LEGACY_BASIC_AUTH`/`BASIC_AUTH` are no longer set in prod; the code still accepts them (new name wins when both are set) if the barrier ever needs to come back.
- A failing CI build or failed pull leaves the previous container running — prod stays up.
- `compose.deploy` only **queues**; `watch` polls `compose.one` every 15 s. Deployment status `running` with no progress for >10 min = check Dokploy UI logs.
- The API returns `deployments` unsorted and `composeStatus` can hold a stale `error` — the driver sorts by `createdAt` and trusts only the newest deployment's status.
- The app enforces named cookie sessions; auth lives in the app (not Traefik).
- `curl` against SPA routes without `Accept: text/html` returns 404 — the static server's SPA fallback is HTML-only. Browsers are unaffected; the driver sends the header.
- `/api/health`, share exchange/share-scope and capture-scope are open without a session; everything else on `/api` requires one.
- Publishing custom components in prod exercises `tsc` + `Bun.build` inside the container — that's why the image keeps full devDependencies; don't "optimize" `npm ci --omit=dev`.

## Troubleshooting

- `DOKPLOY_API_KEY is not set` → create `.env` from `.env.example` (the key is in the Dokploy service owner's settings).
- `deployment failed: ...` from watch → pull/up error on the server; read logs in Dokploy UI (API doesn't expose logPath contents). Check `docker manifest inspect ghcr.io/vladprrs/easy-ui:latest` — if the manifest is missing or the package went private, the pull fails.
- `verify` FAIL on "health open, ready" right after deploy → server seeds on startup (healthcheck `start_period` 90 s); wait ~30 s and re-run.
