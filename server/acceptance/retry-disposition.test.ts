import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { migrate } from "../migrations";
import { ApiError } from "../http";
import { sha256 } from "../components/pipeline";
import type { CandidateEntry } from "../components/candidates";
import type { CaptureProbe, JobOutcome, JobStatus, ScreenshotResult } from "../screenshot/service";
import type { AcceptanceCaptureService, CandidateSubject } from "./gates/types";
import type { CaseSetManifest } from "../../src/acceptance/caseSetSchema";
import { CaseSetRepo } from "./caseSets";
import { readinessPolicyHashOf } from "./ids";
import { AcceptanceOrchestrator } from "./orchestrator";
import { ACCEPTANCE_POLICIES, policyProfileHash } from "./policies";
import { AcceptanceRepo, type AcceptanceRunRow, type CandidateRow } from "./repo";
import {
  BASIS_FIELDS, blockerCodesOf, blockerFingerprintEnabled, blockerFingerprintOf,
  retryDispositionOf, runHasBlocker, storedBasisOf, suggestedActionOf,
} from "./disposition";

/**
 * Отпечаток блокера и retry-disposition (EUI-BR-10a, план
 * `docs/plans/2026-08-08-blocker-removal-eui-br.md` §10; фидбэк §13).
 *
 * Предмет файла — **дифференциальный**: не «какое число выдаёт хэш», а «двигается ли disposition
 * ровно тем слоем, который на стенде поменяли». Поэтому каждый тест меняет **один** вход и
 * проверяет одну глубину: политика вердикта ⇒ recompute, эталон ⇒ rediff, readiness/рендерер ⇒
 * recapture, голова компонента ⇒ rebuild.
 *
 * Стенд-двойник для «сервер изменился» — реестр профилей приёмки (`ACCEPTANCE_POLICIES`): он и
 * есть то самое текущее состояние сервера, с которым сравниваются сохранённые отпечатки. Каждая
 * мутация откатывается в `finally` — иначе следующий тест мерил бы чужой стенд.
 *
 * Раны здесь **не исполняются**: слои отпечатков персистируются постановкой (`createRun`), а
 * предмет disposition — именно они. Исполнение рана и HTTP-поверхность живут в
 * `server/acceptance-routes.test.ts`.
 */

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const COMPONENT_ID = "acc-disposition-probe";
const SOURCE = "export const definition = { examples: { alpha: {}, beta: {} } };";
const REFERENCE_A = `asset_${"a".repeat(64)}`;
const REFERENCE_B = `asset_${"b".repeat(64)}`;

const READY_READINESS = {
  readinessMet: true, readinessReason: null, readinessCodes: [],
  readinessPolicyHash: readinessPolicyHashOf(ACCEPTANCE_POLICIES["default-v1"].readiness),
  readinessEvidence: {
    fontFaces: [], images: { total: 0, decoded: 0, failed: 0 }, pendingRequests: [],
    framesWaited: 2, animationsDisabled: true, themeResources: { tokens: [], icons: [], images: [] },
  },
  observedCaptureEnvFingerprint: "env-fingerprint", observedCaptureEnv: null,
};

const imageBytes = (seed: string): ScreenshotResult => ({
  kind: "image-bytes",
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new TextEncoder().encode(seed)]),
  width: 10, height: 10, imageProduced: true,
  consoleErrors: [], pageErrors: [], captureClean: true,
  productErrors: [], infraNoise: [], runtimeWarnings: [],
  rendererBuild: null, browserVersion: "test/1",
  ...READY_READINESS,
} as unknown as ScreenshotResult);

class FakeCapture implements AcceptanceCaptureService {
  private statuses = new Map<string, JobStatus>();
  private outcomes = new Map<string, JobOutcome>();
  calls = 0;

  enqueueComponentCandidate(
    _id: string,
    _candidate: { rev: number; sourceHash: string },
    opts: { props?: Record<string, unknown>; probe?: CaptureProbe; viewport: unknown },
  ): Promise<{ jobId: string }> {
    const jobId = `job_${++this.calls}`;
    // Кадр зависит от props — раны здесь не исполняются, но двойник обязан быть честным.
    this.statuses.set(jobId, { status: "done", result: imageBytes(JSON.stringify(opts.props ?? {})) });
    this.outcomes.set(jobId, "ok");
    return Promise.resolve({ jobId });
  }
  get(jobId: string): JobStatus {
    const status = this.statuses.get(jobId);
    if (!status) throw new ApiError(404, "job_not_found", "Screenshot job not found");
    return status;
  }
  outcome(jobId: string): JobOutcome | undefined { return this.outcomes.get(jobId); }
  hasBackgroundCapacity(): boolean { return true; }
  available(): boolean { return true; }
}

const candidateEntry = (): CandidateEntry => ({
  version: 1, sourceHash: sha256(SOURCE), componentIds: [COMPONENT_ID], createdAt: new Date().toISOString(), ok: true,
  extracted: {
    ok: true, warnings: [],
    meta: {
      events: [], slots: [], description: "disposition probe",
      examples: { alpha: { label: "a" }, beta: { label: "b" } },
      propsJsonSchema: { type: "object" },
    },
  } as unknown as CandidateEntry["extracted"],
  parityWarnings: [], bundleHash: "bundle", hostAbiVersion: 4,
});

/** Манифест набора с эталоном: без него слой сравнения нечем сдвинуть (эталон — его вход). */
const manifestWithReference = (assetId: string): CaseSetManifest => ({
  manifestVersion: 1,
  componentId: COMPONENT_ID,
  capture: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, theme: "light" },
  cases: [
    { id: "default", props: { tone: "neutral" }, referenceAssetId: assetId },
    { id: "accent", props: { tone: "accent" } },
  ],
} as unknown as CaseSetManifest);

async function setup() {
  const dir = await mkdtemp(resolve(process.cwd(), ".acc-disposition-test-"));
  dirs.push(dir);
  const db = new Database(":memory:");
  migrate(db);
  db.run("INSERT INTO components (id,name,head_rev,created_at,updated_at,design_system) VALUES (?,?,1,'now','now','yandex-pay')", [COMPONENT_ID, "AccDispositionProbe"]);
  // Ревизия головы — источник `sourceHash`, с которым disposition сверяет кандидата: без неё
  // «кандидат другой» было бы недоказуемо, а не ложно.
  db.run("INSERT INTO component_revisions (component_id,rev,source,design_system,message,created_at) VALUES (?,1,?,'yandex-pay',NULL,'now')", [COMPONENT_ID, SOURCE]);
  db.run("INSERT INTO assets (id,sha256,mime,size,width,height,created_at) VALUES (?,?,'image/png',10,4,4,'now')", [REFERENCE_A, "a".repeat(64)]);
  db.run("INSERT INTO assets (id,sha256,mime,size,width,height,created_at) VALUES (?,?,'image/png',10,4,4,'now')", [REFERENCE_B, "b".repeat(64)]);
  const repo = new AcceptanceRepo(db);
  const { candidate } = repo.createCandidate({
    componentId: COMPONENT_ID, designSystem: "yandex-pay", rev: 1, sourceHash: sha256(SOURCE), bundleHash: "bundle",
    hostAbiVersion: 4, themeVersion: 1, observedCatalogRevision: "cat",
    policyProfileHash: policyProfileHash(ACCEPTANCE_POLICIES["default-v1"]), createdBy: "user_a",
  });
  const entry = candidateEntry();
  const subject = (row: CandidateRow): CandidateSubject => ({
    candidateId: row.candidate_id, componentId: row.component_id, designSystem: row.design_system, rev: row.rev,
    sourceHash: row.source_hash, bundleHash: row.bundle_hash, hostAbiVersion: row.host_abi_version,
    themeVersion: row.theme_version, entry,
  });
  const orchestrator = new AcceptanceOrchestrator({
    db, dataDir: dir, service: new FakeCapture(), autoDrain: false, sleep: () => Promise.resolve(),
    resolveCandidate: (row) => Promise.resolve(subject(row)),
  });
  return { db, dir, repo, orchestrator, candidateId: candidate.candidate_id };
}

type Harness = Awaited<ReturnType<typeof setup>>;

/** Ран examples-пути (набор — именованные примеры кандидата), поставленный и не исполненный. */
async function queueRun(harness: Harness, caseSetId?: string): Promise<AcceptanceRunRow> {
  const started = await harness.orchestrator.startRun({
    candidateId: harness.candidateId, createdBy: "user_a",
    ...(caseSetId === undefined ? {} : { caseSetId }),
  });
  return started.run;
}

const dispositionOf = (harness: Harness, run: AcceptanceRunRow) =>
  retryDispositionOf({ db: harness.db, repo: harness.repo, run, cases: harness.repo.cases(run.run_id) });

/** Профиль приёмки — двойник «текущего состояния сервера»; правка обязана быть обратимой. */
function withProfile<T>(mutate: (profile: typeof ACCEPTANCE_POLICIES["default-v1"]) => () => void, body: () => T): T {
  const restore = mutate(ACCEPTANCE_POLICIES["default-v1"]);
  try { return body(); } finally { restore(); }
}

// ------------------------------------------------------- 1. неизменившийся стенд

test("на неизменном стенде disposition — unchanged, а совет — не ретраить", async () => {
  const harness = await setup();
  const run = await queueRun(harness);

  const view = dispositionOf(harness, run);
  expect(view.disposition).toBe("unchanged");
  expect(view.suggestedAction).toBe("do-not-retry");
  expect(view.changed).toEqual([]);
  expect(view.unchanged).toEqual([...BASIS_FIELDS]);
  expect(view.basisIncomplete).toBeUndefined();
  // Ни один случай не двинулся ни одним слоем — иначе «unchanged» было бы усреднением.
  expect(view.cases.every((item) => item.disposition === "unchanged" && item.layers.length === 0)).toBe(true);
  expect(view.cases.map((item) => item.caseId).sort()).toEqual(["alpha", "beta"]);
  // Basis агрегирован канонизированно: сортированные наборы различных значений случаев.
  expect(view.basis.comparisonFingerprint).toEqual([...view.basis.comparisonFingerprint].sort());
  expect(view.basis.candidateSourceHash).toBe(sha256(SOURCE));
  harness.db.close();
});

// ------------------------------------------------------------ 2. слой вердикта

test("смена только вердиктной политики даёт recompute и не трогает кадр со сравнением", async () => {
  const harness = await setup();
  const run = await queueRun(harness);

  const view = withProfile((profile) => {
    const before = profile.geometry.offsetPx;
    profile.geometry.offsetPx = before + 3;
    return () => { profile.geometry.offsetPx = before; };
  }, () => dispositionOf(harness, run));

  expect(view.disposition).toBe("recompute");
  expect(view.suggestedAction).toBe("new-run");
  expect(view.changed).toContain("verdictPolicyFingerprint");
  // Идентичность профиля тоже поменялась — это тот же факт, названный вторым именем.
  expect(view.changed).toContain("policyProfileHash");
  expect(view.changed).not.toContain("rendererFingerprint");
  expect(view.changed).not.toContain("comparisonFingerprint");
  expect(view.cases.every((item) => item.layers.join() === "verdict")).toBe(true);
  harness.db.close();
});

// ---------------------------------------------------------- 3. слой сравнения

test("подмена эталона набора даёт rediff: кадр переиспользуем, метрики — нет", async () => {
  const harness = await setup();
  const { row } = new CaseSetRepo(harness.db).put({
    componentId: COMPONENT_ID, designSystem: "yandex-pay",
    manifest: manifestWithReference(REFERENCE_A), createdBy: "user_a",
  });
  const run = await queueRun(harness, row.case_set_id);
  expect(dispositionOf(harness, run).disposition).toBe("unchanged");

  // Двойник «эталон подменили»: контентный адрес набора запрещает править манифест через API,
  // поэтому подмена делается по строке — ровно тот эффект, который на проде даёт новый набор
  // под тем же раном (перезалитый ассет эталона).
  harness.db.run("UPDATE component_case_sets SET manifest_json=? WHERE case_set_id=?",
    [JSON.stringify(manifestWithReference(REFERENCE_B)), row.case_set_id]);

  const view = dispositionOf(harness, run);
  expect(view.disposition).toBe("rediff");
  expect(view.suggestedAction).toBe("new-run");
  expect(view.changed).toEqual(["comparisonFingerprint"]);
  // Двинулся ровно тот случай, у которого эталон и был.
  expect(view.cases.find((item) => item.caseId === "default")).toMatchObject({ disposition: "rediff", layers: ["comparison"] });
  expect(view.cases.find((item) => item.caseId === "accent")).toMatchObject({ disposition: "unchanged", layers: [] });
  harness.db.close();
});

// ------------------------------------------------------------- 4. слой кадра

test("смена readiness-политики профиля даёт recapture: кадр снят другим ожиданием готовности", async () => {
  const harness = await setup();
  const run = await queueRun(harness);

  const view = withProfile((profile) => {
    const before = profile.readiness;
    profile.readiness = { ...before, frames: before.frames + 5 };
    return () => { profile.readiness = before; };
  }, () => dispositionOf(harness, run));

  expect(view.disposition).toBe("recapture");
  expect(view.suggestedAction).toBe("new-run");
  // Readiness персистируется только через отпечаток рендерера (и через хэш профиля, чьим полем
  // она является) — собственного хэша readiness строка рана не хранит, поэтому в `changed` он не
  // появляется by construction, а живёт в basis отчётом «каким ожиданием готовности мерили».
  expect(view.changed).toEqual(["rendererFingerprint", "policyProfileHash"]);
  expect(view.unchanged).toContain("readinessPolicyHash");
  expect(view.cases.every((item) => item.layers.includes("frame"))).toBe(true);
  harness.db.close();
});

// --------------------------------------------------------- 5. другой кандидат

test("новая ревизия головы даёт rebuild и совет обновить исходник, а не ретраить ран", async () => {
  const harness = await setup();
  const run = await queueRun(harness);

  harness.db.run("UPDATE component_revisions SET source=? WHERE component_id=? AND rev=1",
    [`${SOURCE}\n// автор уже переписал компонент`, COMPONENT_ID]);

  const view = dispositionOf(harness, run);
  expect(view.disposition).toBe("rebuild");
  expect(view.suggestedAction).toBe("update-source");
  expect(view.changed).toEqual(["candidateSourceHash"]);
  // Basis остаётся отчётом о **сохранённом** состоянии: кандидат рана не переписывается задним числом.
  expect(view.basis.candidateSourceHash).toBe(sha256(SOURCE));
  expect(view.cases.every((item) => item.disposition === "rebuild")).toBe(true);
  harness.db.close();
});

// -------------------------------------------------- 6. неполный basis (§13)

test("исчезнувший набор и вытесненный кандидат — типизированный ответ, а не 500", async () => {
  const harness = await setup();
  const { row } = new CaseSetRepo(harness.db).put({
    componentId: COMPONENT_ID, designSystem: "yandex-pay",
    manifest: manifestWithReference(REFERENCE_A), createdBy: "user_a",
  });
  const run = await queueRun(harness, row.case_set_id);
  harness.db.run("DELETE FROM component_case_sets WHERE case_set_id=?", [row.case_set_id]);

  const gone = dispositionOf(harness, run);
  expect(gone).toMatchObject({ disposition: "unchanged", suggestedAction: "do-not-retry", basisIncomplete: "case_set_evicted" });
  expect(gone.cases).toEqual([]);
  // Basis всё равно печатается: он сохранённый, и его хватает, чтобы узнать блокер в лицо.
  expect(gone.basis.policyProfileHash).toBe(run.policy_profile_hash);

  // Кандидата вытеснил GC: строка рана переживает его (FK снят на время двойника — на проде это
  // делает каскад свипера, который сносит кандидата вместе с ранами только когда ему можно).
  harness.db.run("PRAGMA foreign_keys=OFF");
  harness.db.run("DELETE FROM component_candidates WHERE candidate_id=?", [harness.candidateId]);
  const evicted = dispositionOf(harness, run);
  expect(evicted).toMatchObject({ disposition: "unchanged", suggestedAction: "do-not-retry", basisIncomplete: "candidate_evicted" });
  expect(evicted.basis.candidateSourceHash).toBeNull();
  harness.db.close();
});

// ------------------------------------------------------- 7. отпечаток блокера

test("blockerFingerprint стабилен между вызовами, зависит от кодов и молчит у прошедшего рана", async () => {
  const harness = await setup();
  const run = await queueRun(harness);
  const rows = () => harness.repo.cases(run.run_id);

  // Нетерминальный ран блокера не имеет: его никто не судил.
  expect(runHasBlocker(run, rows())).toBe(false);
  expect(blockerFingerprintOf(run, rows(), harness.repo.candidate(harness.candidateId))).toBeNull();

  harness.repo.updateCase(run.run_id, "alpha", {
    status: "done", verdict: "fail",
    gates: [{ gate: "visual", status: "fail", metrics: { codes: [{ code: "raw_diff_over_budget" }] } }],
  });
  const failed = harness.repo.terminalizeRun(run.run_id, { status: "fail" });
  const candidate = harness.repo.candidate(harness.candidateId);

  const first = blockerFingerprintOf(failed, rows(), candidate);
  expect(first).toMatch(/^blk_[0-9a-f]{64}$/);
  // Стабильность: время и повторный вызов в пре-образ не входят.
  expect(blockerFingerprintOf(failed, rows(), candidate)).toBe(first);
  expect(blockerCodesOf(rows())).toEqual(["visual:fail", "visual:raw_diff_over_budget"]);

  // Другой код — другой блокер: иначе «тот же самый» соврало бы на первом же новом дефекте.
  harness.repo.updateCase(run.run_id, "alpha", {
    gates: [{ gate: "visual", status: "fail", metrics: { codes: [{ code: "geometry_shifted" }] } }],
  });
  expect(blockerFingerprintOf(failed, rows(), candidate)).not.toBe(first);

  // …а порядок случаев и гейтов — нет: коды сортируются.
  expect(blockerCodesOf([...rows()].reverse())).toEqual(blockerCodesOf(rows()));
  harness.db.close();
});

test("basis блокера собирается только из сохранённых данных", async () => {
  const harness = await setup();
  const run = await queueRun(harness);
  const rows = harness.repo.cases(run.run_id);
  const basis = storedBasisOf(run, rows, harness.repo.candidate(harness.candidateId));

  expect(basis.rendererFingerprint).toBe(run.renderer_fingerprint);
  expect(basis.policyProfileHash).toBe(run.policy_profile_hash);
  expect(basis.comparisonFingerprint).toEqual([...new Set(rows.map((row) => row.comparison_fingerprint!))].sort());
  expect(basis.verdictPolicyFingerprint).toEqual([...new Set(rows.map((row) => row.verdict_policy_hash!))].sort());
  // Правка стенда сохранённый basis не двигает — иначе run view и disposition разошлись бы.
  const under = withProfile((profile) => {
    const before = profile.geometry.offsetPx;
    profile.geometry.offsetPx = before + 3;
    return () => { profile.geometry.offsetPx = before; };
  }, () => storedBasisOf(run, rows, harness.repo.candidate(harness.candidateId)));
  expect(under.verdictPolicyFingerprint).toEqual(basis.verdictPolicyFingerprint);
  harness.db.close();
});

// ---------------------------------------------------------- 8. продолжаемость

test("продолжаемый ран советует resume-run, а пересборка перебивает и его", () => {
  expect(suggestedActionOf("unchanged", false)).toBe("do-not-retry");
  expect(suggestedActionOf("recapture", false)).toBe("new-run");
  // BR-06: у остановленного рана есть более дешёвый путь, чем новый ран, — и он честнее совета
  // «не ретраить», хотя basis и не двигался.
  expect(suggestedActionOf("unchanged", true)).toBe("resume-run");
  expect(suggestedActionOf("rediff", true)).toBe("resume-run");
  // …но продолжать ран, снятый с исходника, которого больше нет, бессмысленно.
  expect(suggestedActionOf("rebuild", true)).toBe("update-source");
});

test("продолжаемость читается из resume_json рана", async () => {
  const harness = await setup();
  const run = await queueRun(harness);
  harness.repo.sweepNonTerminalRuns();
  const interrupted = harness.repo.requireRun(run.run_id);
  expect(interrupted.status_reason).toBe("interrupted");

  const view = dispositionOf(harness, interrupted);
  expect(view.disposition).toBe("unchanged");
  expect(view.suggestedAction).toBe("resume-run");
  // Блокер у него есть: `error` — терминальный статус, и его отпечаток обязан существовать.
  expect(view.blockerFingerprint).toMatch(/^blk_[0-9a-f]{64}$/);
  harness.db.close();
});

// ------------------------------------------------------------- 9. kill-switch

test("kill-switch читается по месту вызова и гасит отпечаток", async () => {
  const harness = await setup();
  const run = await queueRun(harness);
  harness.repo.sweepNonTerminalRuns();
  const interrupted = harness.repo.requireRun(run.run_id);

  expect(blockerFingerprintEnabled()).toBe(true);
  process.env.EASYUI_BLOCKER_FINGERPRINT_DISABLED = "1";
  try {
    expect(blockerFingerprintEnabled()).toBe(false);
    expect(blockerFingerprintOf(interrupted, harness.repo.cases(run.run_id), harness.repo.candidate(harness.candidateId))).toBeNull();
    expect(dispositionOf(harness, interrupted).blockerFingerprint).toBeNull();
  } finally { delete process.env.EASYUI_BLOCKER_FINGERPRINT_DISABLED; }
  harness.db.close();
});
