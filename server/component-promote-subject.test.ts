import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { createTestHandler } from "./test-auth";
import { openDatabase } from "./db";
import { BOOTSTRAP_ADMIN_ID } from "./users";
import { AcceptanceOrchestrator } from "./acceptance/orchestrator";
import { CaseSetRepo } from "./acceptance/caseSets";
import { caseSetManifestSchema, type CaseSetSlotChild } from "../src/acceptance/caseSetSchema";
import { ACCEPTANCE_POLICIES, DEFAULT_ACCEPTANCE_POLICY_ID, policyProfileHash } from "./acceptance/policies";
import type { AcceptanceCaptureService } from "./acceptance/gates/types";
import type { AcceptanceCaseVerdict } from "./acceptance/repo";

/**
 * **BR-08, врезка субъектного promote в сагу** (план 2026-08-08 §8, волна V4).
 *
 * Предмет файла — ровно фаза A.1 promote: как сага судит **непромоутабельный** ран, набор которого
 * объявил `comparison.ownership`. Съёмка здесь не исполняется (заглушка капчура падает), раны и их
 * случаи создаются напрямую через repo: субъектный вердикт — это факт в `gates_json`, и проверять
 * надо его чтение, а не то, как визуальный гейт его посчитал (это `gates/visual-attribution.test.ts`).
 */

const dirs: string[] = [];
const databases: Database[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const noCapture: AcceptanceCaptureService = {
  enqueueComponentCandidate() { throw new Error("acceptance capture must not run in promote saga tests"); },
  get() { throw new Error("acceptance capture must not run in promote saga tests"); },
  outcome() { return undefined; },
  hasBackgroundCapacity() { return true; },
} as unknown as AcceptanceCaptureService;

const DEFAULT_POLICY = ACCEPTANCE_POLICIES[DEFAULT_ACCEPTANCE_POLICY_ID];
const POLICY_HASH = policyProfileHash(DEFAULT_POLICY);
const RENDERER = "r".repeat(64);

const req = (url: string, method = "GET", value?: unknown) =>
  new Request(`http://test/api${url}`, {
    method,
    headers: value === undefined ? undefined : { "content-type": "application/json" },
    body: value === undefined ? undefined : JSON.stringify(value),
  });

const fixture = (name: string) => Bun.file(resolve("server/fixtures", name)).text();

const codeOf = async (response: Response) => (await response.json() as { error: { code: string } }).error.code;
/** Детали `ApiError` уезжают **плоско** внутрь `error` (см. `errorResponse`), а не в `details`. */
const detailsOf = async (response: Response) =>
  (await response.json() as { error: Record<string, unknown> }).error;

/** Субъект приёмки: компонент + кандидат (тот же путь, что у `component-promote.test.ts`). */
async function subjectFixture(id: string, name: string) {
  const dir = await mkdtemp(resolve(process.cwd(), ".promote-subject-test-"));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  databases.push(db);
  const orchestrator = new AcceptanceOrchestrator({ db, dataDir: dir, service: noCapture, autoDrain: false });
  const handler = createTestHandler(db, { dataDir: dir, acceptance: orchestrator });
  const source = await fixture("rating-stars.tsx");
  const created = await handler(req("/components", "POST", {
    designSystem: "yandex-pay", id, name, source, intent: `Promotes ${name} for the BR-08 subject promote test`,
  }));
  expect(created.status, await created.clone().text()).toBe(201);
  const candidateResponse = await handler(req(`/components/${id}/candidates`, "POST"));
  expect(candidateResponse.status, await candidateResponse.clone().text()).toBe(200);
  const candidate = await candidateResponse.json() as { candidateId: string; sourceHash: string };
  return { db, dir, handler, orchestrator, id, candidate };
}

/**
 * Опубликованная runtime-зависимость: строки каталога + (опционально) её собственная приёмка на
 * строке версии. `evidence` — ровно тот вход, которым отличаются ветки условия 3.
 */
function publishDependency(
  db: Database, orchestrator: AcceptanceOrchestrator,
  options: { componentId: string; name: string; evidence: "promotable" | "failed" | "none"; status?: string },
): { componentId: string; runId: string | null } {
  db.run("INSERT INTO components (id,name,head_rev,design_system,created_at,updated_at) VALUES (?,?,1,'yandex-pay','now','now')",
    [options.componentId, options.name]);
  db.run("INSERT INTO component_revisions (component_id,rev,source,design_system,created_at) VALUES (?,1,'src','yandex-pay','now')",
    [options.componentId]);
  db.run(`INSERT INTO component_publishes
    (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,published_at)
    VALUES (?,1,1,?,'js','{}','dep-src','dep-bundle',2,'now')`, [options.componentId, options.status ?? "active"]);
  if (options.evidence === "none") return { componentId: options.componentId, runId: null };
  const candidate = orchestrator.repo.createCandidate({
    componentId: options.componentId, designSystem: "yandex-pay", rev: 1,
    sourceHash: "d".repeat(64), bundleHash: "e".repeat(64), hostAbiVersion: 2, themeVersion: null,
    observedCatalogRevision: "catalog-dep", policyProfileHash: POLICY_HASH, createdBy: BOOTSTRAP_ADMIN_ID,
  }).candidate;
  const run = orchestrator.repo.createRun({
    candidateId: candidate.candidate_id, componentId: options.componentId, createdBy: BOOTSTRAP_ADMIN_ID,
    policyProfileId: DEFAULT_POLICY.id, policyProfileHash: POLICY_HASH, cases: [],
  }).run;
  orchestrator.repo.terminalizeRun(run.run_id, { status: options.evidence === "promotable" ? "pass" : "fail" });
  db.run("UPDATE component_publishes SET acceptance_run_id=? WHERE component_id=? AND version=1",
    [run.run_id, options.componentId]);
  return { componentId: options.componentId, runId: run.run_id };
}

/** Набор с декларацией владения; `bindings` — runtime-зависимости дерева случая. */
function putCaseSet(
  db: Database, componentId: string,
  options: { ownership?: boolean; dependencyPolicy?: boolean; bindings?: CaseSetSlotChild[] } = {},
) {
  const comparison = {
    ...(options.ownership === false ? {} : { ownership: "subject-and-integration" }),
    ...(options.dependencyPolicy === false ? {} : { dependencyPolicy: "require-eligible-acceptance" }),
  };
  return new CaseSetRepo(db).put({
    componentId, designSystem: "yandex-pay", createdBy: BOOTSTRAP_ADMIN_ID,
    manifest: caseSetManifestSchema.parse({
      manifestVersion: 1, componentId,
      capture: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, theme: "light" },
      cases: [{
        id: "wrapper",
        props: { label: "wrapper" },
        ...(Object.keys(comparison).length === 0 ? {} : { comparison }),
        ...(options.bindings === undefined ? {} : { slotBindings: { default: options.bindings } }),
      }],
    }),
  }).row;
}

/**
 * Провальный по интеграции ран с одним случаем. `subjectFailed: null` — субъектного вердикта нет
 * вовсе (доволновой кадр / выключенная атрибуция).
 */
function failingRun(
  orchestrator: AcceptanceOrchestrator, candidateId: string, componentId: string, caseSetId: string,
  options: { subjectFailed?: boolean | null; nonVisualFailed?: boolean; verdict?: AcceptanceCaseVerdict } = {},
) {
  const run = orchestrator.repo.createRun({
    candidateId, componentId, createdBy: BOOTSTRAP_ADMIN_ID,
    policyProfileId: DEFAULT_POLICY.id, policyProfileHash: POLICY_HASH,
    caseSetId, rendererFingerprint: RENDERER,
    cases: [{ caseId: "wrapper", caseKey: "wrapper", propsHash: "p-wrapper", caseFingerprint: "fp-wrapper", casePolicyHash: "cp" }],
  }).run;
  const subjectFailed = options.subjectFailed === undefined ? false : options.subjectFailed;
  orchestrator.repo.updateCase(run.run_id, "wrapper", {
    status: "done", verdict: options.verdict ?? "fail",
    gates: [
      { gate: "contract", status: options.nonVisualFailed === true ? "fail" : "pass" },
      {
        gate: "visual", status: "fail",
        metrics: subjectFailed === null ? {} : {
          ownership: {
            subject: { rawDiffPct: subjectFailed ? 4.2 : 0.1, aaDiffPct: 0, failed: subjectFailed },
            integration: { rawDiffPct: 4.2, aaDiffPct: 0, failed: true },
            byDependency: [{ markerKey: "m1", componentId: "pay-dep", pixels: 4096 }],
            subjectComponentId: componentId,
          },
        },
      },
    ],
  });
  orchestrator.repo.terminalizeRun(run.run_id, { status: "fail" });
  return run;
}

describe("BR-08: subject promote of a run that failed the integration verdict", () => {
  test("happy path: subject clean + dependency with its own eligible acceptance → promote passes and the receipt keeps the integration fail", async () => {
    const { db, handler, orchestrator, id, candidate } = await subjectFixture("promote-subject-ok", "PromoteSubjectOk");
    const dependency = publishDependency(db, orchestrator, { componentId: "pay-subject-leaf", name: "PaySubjectLeaf", evidence: "promotable" });
    const set = putCaseSet(db, id, { bindings: [{ type: "PaySubjectLeaf", version: 1 }] });
    const run = failingRun(orchestrator, candidate.candidateId, id, set.case_set_id);

    const promoted = await handler(req(`/components/${id}/promote`, "POST", {
      baseRev: 1, sourceHash: candidate.sourceHash, candidateId: candidate.candidateId, acceptanceRunId: run.run_id,
    }));
    expect(promoted.status, await promoted.clone().text()).toBe(201);
    const body = await promoted.json() as {
      version: number; acceptanceRunId: string; warnings: string[];
      subjectPromotion: { runId: string; caseSetId: string; integrationVerdict: string; subjectVerdict: string; dependencies: unknown[] }[];
    };
    expect(body.version).toBe(1);
    // Квитанция §8 п.4: провальный интеграционный вердикт сохранён дословно, не заменён субъектным.
    expect(body.subjectPromotion).toEqual([{
      runId: run.run_id, caseSetId: set.case_set_id,
      integrationVerdict: "fail", subjectVerdict: "pass",
      dependencies: [{ componentId: dependency.componentId, name: "PaySubjectLeaf", version: 1, runId: dependency.runId! }],
    }]);
    expect(body.warnings.some((line) => line.includes("promoted by subject ownership"))).toBe(true);
    // Ран стал provenance версии на общих правах: субъектный путь не «половинчатая» публикация.
    expect(orchestrator.repo.requireCandidate(candidate.candidateId))
      .toMatchObject({ status: "promoted", promoted_version: 1, acceptance_run_id: run.run_id });
    // Вердикт самого рана не переписан — §8 меняет право на публикацию, а не факты приёмки.
    expect(orchestrator.repo.requireRun(run.run_id).status).toBe("fail");
  }, 180_000);

  test("условие 2: грязный субъект и провал невизуального гейта — subject_promotion_subject_failed", async () => {
    const { db, handler, orchestrator, id, candidate } = await subjectFixture("promote-subject-dirty", "PromoteSubjectDirty");
    publishDependency(db, orchestrator, { componentId: "pay-dirty-leaf", name: "PayDirtyLeaf", evidence: "promotable" });
    const set = putCaseSet(db, id, { bindings: [{ type: "PayDirtyLeaf", version: 1 }] });
    const promote = (runId: string) => handler(req(`/components/${id}/promote`, "POST", {
      baseRev: 1, sourceHash: candidate.sourceHash, candidateId: candidate.candidateId, acceptanceRunId: runId,
    }));

    // а) субъектные пиксели сами вне бюджета.
    const dirty = failingRun(orchestrator, candidate.candidateId, id, set.case_set_id, { subjectFailed: true });
    const dirtyResponse = await promote(dirty.run_id);
    expect(dirtyResponse.status).toBe(422);
    expect(await dirtyResponse.clone().json().then((value: unknown) => (value as { error: { code: string } }).error.code))
      .toBe("subject_promotion_subject_failed");
    expect((await detailsOf(dirtyResponse)).cases).toEqual([
      { caseId: "wrapper", verdict: "fail", subjectFailed: true, nonVisualFailed: false },
    ]);

    // б) субъект чист, но провален невизуальный гейт полного дерева — он не прощается никогда.
    const nonVisual = failingRun(orchestrator, candidate.candidateId, id, set.case_set_id, { nonVisualFailed: true });
    const nonVisualResponse = await promote(nonVisual.run_id);
    expect(nonVisualResponse.status).toBe(422);
    expect(await codeOf(nonVisualResponse)).toBe("subject_promotion_subject_failed");

    // в) субъектный вердикт не посчитан вовсе: «не измерено» не бывает «в допуске».
    const unmeasured = failingRun(orchestrator, candidate.candidateId, id, set.case_set_id, { subjectFailed: null });
    const unmeasuredResponse = await promote(unmeasured.run_id);
    expect(unmeasuredResponse.status).toBe(422);
    expect(await codeOf(unmeasuredResponse)).toBe("subject_promotion_subject_failed");

    // Ни один отказ не создал версии.
    expect(db.query("SELECT COUNT(*) n FROM component_publishes WHERE component_id=?").get(id)).toEqual({ n: 0 });
  }, 180_000);

  test("условие 1: объявлена половина контракта владения — subject_promotion_ownership_missing", async () => {
    const { db, handler, orchestrator, id, candidate } = await subjectFixture("promote-subject-half", "PromoteSubjectHalf");
    publishDependency(db, orchestrator, { componentId: "pay-half-leaf", name: "PayHalfLeaf", evidence: "promotable" });
    const promote = (runId: string) => handler(req(`/components/${id}/promote`, "POST", {
      baseRev: 1, sourceHash: candidate.sourceHash, candidateId: candidate.candidateId, acceptanceRunId: runId,
    }));

    // ownership без dependencyPolicy: promote-гейту нечего читать.
    const noPolicy = putCaseSet(db, id, { dependencyPolicy: false, bindings: [{ type: "PayHalfLeaf", version: 1 }] });
    const first = await promote(failingRun(orchestrator, candidate.candidateId, id, noPolicy.case_set_id).run_id);
    expect(first.status).toBe(422);
    expect(await first.clone().json().then((value: unknown) => (value as { error: { code: string } }).error.code))
      .toBe("subject_promotion_ownership_missing");
    expect(await detailsOf(first)).toMatchObject({ missing: "comparison.dependencyPolicy", caseSetId: noPolicy.case_set_id, cases: ["wrapper"] });

    // dependencyPolicy без ownership: двух вердиктов никто не считал, судить нечем.
    const noOwnership = putCaseSet(db, id, { ownership: false, bindings: [{ type: "PayHalfLeaf", version: 1 }] });
    const second = await promote(failingRun(orchestrator, candidate.candidateId, id, noOwnership.case_set_id).run_id);
    expect(second.status).toBe(422);
    expect(await second.clone().json().then((value: unknown) => (value as { error: { code: string } }).error.code))
      .toBe("subject_promotion_ownership_missing");
    expect(await detailsOf(second)).toMatchObject({ missing: "comparison.ownership" });
  }, 180_000);

  test("условие 3: неопубликованная зависимость, зависимость без приёмки, зависимость с провальной приёмкой и набор без зависимостей вовсе", async () => {
    const { db, handler, orchestrator, id, candidate } = await subjectFixture("promote-subject-deps", "PromoteSubjectDeps");
    publishDependency(db, orchestrator, { componentId: "pay-mute-leaf", name: "PayMuteLeaf", evidence: "none" });
    publishDependency(db, orchestrator, { componentId: "pay-failed-leaf", name: "PayFailedLeaf", evidence: "failed" });
    const promote = (runId: string) => handler(req(`/components/${id}/promote`, "POST", {
      baseRev: 1, sourceHash: candidate.sourceHash, candidateId: candidate.candidateId, acceptanceRunId: runId,
    }));
    const refuse = async (bindings: CaseSetSlotChild[] | undefined, reason: string | null) => {
      const set = putCaseSet(db, id, bindings === undefined ? {} : { bindings });
      const response = await promote(failingRun(orchestrator, candidate.candidateId, id, set.case_set_id).run_id);
      expect(response.status).toBe(422);
      expect(await response.clone().json().then((value: unknown) => (value as { error: { code: string } }).error.code))
        .toBe("subject_promotion_dependency_ineligible");
      const details = await detailsOf(response) as { dependencies: { reason: string }[] };
      expect(details.dependencies.map((item) => item.reason)).toEqual(reason === null ? [] : [reason]);
    };

    await refuse([{ type: "PayGhostLeaf", version: 1 }], "not_published");
    await refuse([{ type: "PayMuteLeaf", version: 1 }], "no_acceptance_evidence");
    await refuse([{ type: "PayFailedLeaf", version: 1 }], "acceptance_not_promotable");
    // Владение без единой зависимости: у остатка нет владельца, прощать его нечем.
    await refuse(undefined, null);
    expect(db.query("SELECT COUNT(*) n FROM component_publishes WHERE component_id=?").get(id)).toEqual({ n: 0 });
  }, 180_000);

  test("kill-switch и набор без деклараций: отказ доволновой — acceptance_run_not_passed", async () => {
    const { db, handler, orchestrator, id, candidate } = await subjectFixture("promote-subject-off", "PromoteSubjectOff");
    publishDependency(db, orchestrator, { componentId: "pay-off-leaf", name: "PayOffLeaf", evidence: "promotable" });
    const declared = putCaseSet(db, id, { bindings: [{ type: "PayOffLeaf", version: 1 }] });
    const silent = putCaseSet(db, id, { ownership: false, dependencyPolicy: false, bindings: [{ type: "PayOffLeaf", version: 1 }] });
    const promote = (runId: string) => handler(req(`/components/${id}/promote`, "POST", {
      baseRev: 1, sourceHash: candidate.sourceHash, candidateId: candidate.candidateId, acceptanceRunId: runId,
    }));

    // Набор без деклараций — доволновое поведение при включённой волне.
    const plain = await promote(failingRun(orchestrator, candidate.candidateId, id, silent.case_set_id).run_id);
    expect(plain.status).toBe(422);
    expect(await plain.clone().json().then((value: unknown) => (value as { error: { code: string } }).error.code))
      .toBe("acceptance_run_not_passed");

    // Тот же самый набор, который выше промоутился, под kill-switch'ем отказывает по-старому.
    process.env.EASYUI_COMPARISON_OWNERSHIP_DISABLED = "1";
    try {
      const killed = await promote(failingRun(orchestrator, candidate.candidateId, id, declared.case_set_id).run_id);
      expect(killed.status).toBe(422);
      expect(await killed.clone().json().then((value: unknown) => (value as { error: { code: string } }).error.code))
        .toBe("acceptance_run_not_passed");
    } finally { delete process.env.EASYUI_COMPARISON_OWNERSHIP_DISABLED; }

    expect(db.query("SELECT COUNT(*) n FROM component_publishes WHERE component_id=?").get(id)).toEqual({ n: 0 });
  }, 180_000);

  test("acceptance_policy_mismatch: `allowed` — предикат, а не сырой реестр профилей", async () => {
    const { handler, orchestrator, id, candidate } = await subjectFixture("promote-subject-allowed", "PromoteSubjectAllowed");
    const run = orchestrator.repo.createRun({
      candidateId: candidate.candidateId, componentId: id, createdBy: BOOTSTRAP_ADMIN_ID,
      // Профиль мимо роута (`startRun` чужие отвергает) — ветка отказа иначе недостижима.
      policyProfileId: "made-up-v1", policyProfileHash: POLICY_HASH, cases: [],
    }).run;
    orchestrator.repo.terminalizeRun(run.run_id, { status: "pass" });
    const promote = () => handler(req(`/components/${id}/promote`, "POST", {
      baseRev: 1, sourceHash: candidate.sourceHash, candidateId: candidate.candidateId, acceptanceRunId: run.run_id,
    }));

    const enabled = await promote();
    expect(enabled.status).toBe(422);
    expect(await enabled.clone().json().then((value: unknown) => (value as { error: { code: string } }).error.code))
      .toBe("acceptance_policy_mismatch");
    expect((await detailsOf(enabled)).allowed).toEqual(["default-v1", "pixel-strict-v1", "default-v1-exceptions"]);

    // BR-07: под выключенными профилями рендерера `default-v1-exceptions` публикацию не допускает —
    // и не имеет права называться допущенным в payload отказа.
    process.env.EASYUI_RENDERER_POLICY_PROFILES_DISABLED = "1";
    try {
      const narrowed = await promote();
      expect(narrowed.status).toBe(422);
      expect((await detailsOf(narrowed)).allowed).toEqual(["default-v1", "pixel-strict-v1"]);
    } finally { delete process.env.EASYUI_RENDERER_POLICY_PROFILES_DISABLED; }
  }, 180_000);
});
