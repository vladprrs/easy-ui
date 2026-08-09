import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { migrate } from "../migrations";
import { ApiError } from "../http";
import type { CandidateEntry } from "../components/candidates";
import type { CaptureProbe, JobOutcome, JobStatus, ScreenshotResult } from "../screenshot/service";
import { ALLOCATE_JOB_OUTCOMES, isTerminalJobOutcome, classifyJobFailure, jobOutcomeOfError } from "../screenshot/service";
import type { AcceptanceCaptureService, CandidateSubject, GateResult } from "./gates/types";
import { readinessPolicyHashOf } from "./ids";
import {
  ALLOCATE_BREAKER_THRESHOLD, AcceptanceOrchestrator, acceptanceResumeEnabled,
  lastCompletedPhaseOfGates, runLastCompletedPhase,
} from "./orchestrator";
import { gateFingerprintOf, resumableGatesOf, type GateEnvelope } from "./runner";
import { ACCEPTANCE_POLICIES, policyProfileHash } from "./policies";
import { AcceptanceRepo, type CandidateRow } from "./repo";

/**
 * Возобновляемая приёмка (EUI-BR-06, план `docs/plans/2026-08-08-blocker-removal-eui-br.md` §6).
 *
 * Предмет файла — **то, чего у приёмки не было вовсе**: причина падения случая, отличимая фаза
 * аллокации рендерера, обрыв бессмысленной работы по circuit breaker'у и продолжение
 * остановленного рана новым раном с lineage. Репро исходного наблюдения мигратора (V0-D4, путь B):
 * рестарт процесса уносит ран в `error`, кейсы залипают навсегда, и продолжить его нечем.
 *
 * Капчур — заглушка (прецедент `runner.test.ts`/`orchestrator.test.ts`): предмет здесь не пиксели,
 * а жизненный цикл рана.
 */

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const COMPONENT_ID = "acc-resume-probe";

const READY_READINESS = {
  readinessMet: true,
  readinessReason: null,
  readinessCodes: [],
  readinessPolicyHash: readinessPolicyHashOf(ACCEPTANCE_POLICIES["default-v1"].readiness),
  readinessEvidence: {
    fontFaces: [], images: { total: 0, decoded: 0, failed: 0 }, pendingRequests: [],
    framesWaited: 2, animationsDisabled: true,
    themeResources: { tokens: [], icons: [], images: [] },
    resourceBarrier: { expected: 1, decoded: 1, fontsReady: true, stableFrames: 2, lateAfterBarrier: [], durationMs: 12 },
  },
  observedCaptureEnvFingerprint: "env-fingerprint",
  observedCaptureEnv: null,
};

const imageBytes = (): ScreenshotResult => ({
  kind: "image-bytes",
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]), width: 10, height: 10, imageProduced: true,
  consoleErrors: [], pageErrors: [], captureClean: true,
  productErrors: [], infraNoise: [], runtimeWarnings: [], suppressedCount: 0,
  rendererBuild: null, browserVersion: "test/1",
  ...READY_READINESS,
} as unknown as ScreenshotResult);

/**
 * Капчур-двойник с управляемым отказом. Три режима, ровно по трём фактам, которые волна и
 * различает: съёмка идёт; рендерера в процессе нет вовсе (`available:false`); очередь не даёт
 * слот (`capacity:false` — исход класса аллокации `queue_full`).
 */
class FakeCapture implements AcceptanceCaptureService {
  calls = 0;
  capacity = true;
  rendererAvailable = true;
  /** `true` — enqueue отвечает 501, как настоящий `ScreenshotService.requireAvailable`. */
  refuse501 = false;
  private statuses = new Map<string, JobStatus>();
  private outcomes = new Map<string, JobOutcome>();

  /** Пробы последней постановки — вход утверждений «капчур стартовал заново». */
  probes: (CaptureProbe | undefined)[] = [];

  enqueueComponentCandidate(
    _id: string,
    _candidate: { rev: number; sourceHash: string },
    opts: { props?: Record<string, unknown>; probe?: CaptureProbe; viewport: unknown },
  ): Promise<{ jobId: string }> {
    this.probes.push(opts.probe);
    if (this.refuse501) {
      return Promise.reject(new ApiError(501, "screenshot_unavailable", "Screenshot capture requires SERVE_DIST and an installed chromium"));
    }
    this.calls += 1;
    const jobId = `job_${this.calls}`;
    this.statuses.set(jobId, { status: "done", result: imageBytes() });
    this.outcomes.set(jobId, "ok");
    return Promise.resolve({ jobId });
  }

  get(jobId: string): JobStatus {
    const status = this.statuses.get(jobId);
    if (!status) throw new ApiError(404, "job_not_found", "Screenshot job not found");
    return status;
  }
  outcome(jobId: string): JobOutcome | undefined { return this.outcomes.get(jobId); }
  hasBackgroundCapacity(): boolean { return this.capacity; }
  available(): boolean { return this.rendererAvailable; }
}

const candidateEntry = (): CandidateEntry => ({
  version: 1, sourceHash: "src-hash", componentIds: [COMPONENT_ID], createdAt: new Date().toISOString(), ok: true,
  extracted: {
    ok: true, warnings: [],
    meta: {
      events: [], slots: [], description: "resume probe",
      examples: { alpha: { label: "a" }, beta: { label: "b" }, gamma: { label: "c" }, delta: { label: "d" } },
      propsJsonSchema: { type: "object" },
    },
  } as unknown as CandidateEntry["extracted"],
  parityWarnings: [], bundleHash: "bundle", hostAbiVersion: 4,
});

async function setup() {
  const dir = await mkdtemp(resolve(process.cwd(), ".acc-resume-test-"));
  dirs.push(dir);
  const db = new Database(":memory:");
  migrate(db);
  db.run("INSERT INTO components (id,name,head_rev,created_at,updated_at,design_system) VALUES (?,?,1,'now','now','yandex-pay')", [COMPONENT_ID, "AccResumeProbe"]);
  const repo = new AcceptanceRepo(db);
  const { candidate } = repo.createCandidate({
    componentId: COMPONENT_ID, designSystem: "yandex-pay", rev: 1, sourceHash: "src-hash", bundleHash: "bundle",
    hostAbiVersion: 4, themeVersion: 1, observedCatalogRevision: "cat",
    policyProfileHash: policyProfileHash(ACCEPTANCE_POLICIES["default-v1"]), createdBy: "user_a",
  });
  const entry = candidateEntry();
  const service = new FakeCapture();
  const subject = (row: CandidateRow): CandidateSubject => ({
    candidateId: row.candidate_id, componentId: row.component_id, designSystem: row.design_system, rev: row.rev,
    sourceHash: row.source_hash, bundleHash: row.bundle_hash, hostAbiVersion: row.host_abi_version,
    themeVersion: row.theme_version, entry,
  });
  const orchestrator = new AcceptanceOrchestrator({
    db, dataDir: dir, service, autoDrain: false, sleep: () => Promise.resolve(),
    resolveCandidate: (row) => Promise.resolve(subject(row)),
  });
  return { db, dir, repo, service, orchestrator, candidateId: candidate.candidate_id };
}

type Harness = Awaited<ReturnType<typeof setup>>;

async function runOnce(harness: Harness) {
  const started = await harness.orchestrator.startRun({ candidateId: harness.candidateId, createdBy: "user_a" });
  const run = await harness.orchestrator.executeRun(started.run.run_id);
  return run;
}

const gatesOf = (harness: Harness, runId: string, caseId: string): GateEnvelope[] =>
  JSON.parse(harness.repo.cases(runId).find((row) => row.case_id === caseId)?.gates_json ?? "[]") as GateEnvelope[];

// ------------------------------------------------------ 1. причина падения

/**
 * Дефект V0-D4: `execution.error` не персистился нигде. Сегодня причина — колонка `error_json`
 * (v37), и она переживает и терминализацию, и рестарт процесса.
 */
test("причина инфраструктурного падения случая персистится в error_json с попытками и фазой", async () => {
  const harness = await setup();
  harness.service.refuse501 = true;
  const run = await runOnce(harness);

  expect(run.status).toBe("error");
  const rows = harness.repo.cases(run.run_id);
  const failed = rows.find((row) => row.status === "error");
  expect(failed).toBeDefined();
  const error = JSON.parse(failed!.error_json!) as { outcome: string; attempts: number; phase: string; elapsedMs: number };
  // Терминальный исход не тратит бюджет ретраев: одна попытка, а не `maxInfraRetries + 1`.
  expect(error).toMatchObject({ outcome: "renderer_unavailable", attempts: 1, phase: "allocate-renderer" });
  expect(typeof error.elapsedMs).toBe("number");
  harness.db.close();
});

/** 501 `screenshot_unavailable` — не продуктовый провал компонента и не повод для ретраев. */
test("501 screenshot_unavailable классифицируется как терминальный renderer_unavailable", () => {
  const refusal = new ApiError(501, "screenshot_unavailable", "Screenshot capture requires SERVE_DIST and an installed chromium");
  expect(jobOutcomeOfError(refusal)).toBe("renderer_unavailable");
  expect(isTerminalJobOutcome("renderer_unavailable")).toBe(true);
  // `allocate_timeout` терминальным НЕ является: аллокация могла не успеть под нагрузкой.
  expect(isTerminalJobOutcome("allocate_timeout")).toBe(false);
  expect([...ALLOCATE_JOB_OUTCOMES].sort()).toEqual(["allocate_timeout", "queue_full", "renderer_unavailable"]);
  // Шов различает две фазы по дословным маркерам раннера — и различает их ДО общего `timeout`.
  expect(classifyJobFailure("renderer allocation timed out after 15000ms")).toBe("allocate_timeout");
  expect(classifyJobFailure("capture timed out after 60000ms")).toBe("timeout");
  // Спавн node-воркера остаётся ретраибельным: это не отсутствующий браузер.
  expect(classifyJobFailure("worker spawn failed: ENOENT")).toBe("subprocess_error");
});

// ------------------------------------------- 2. прекондиция рендерера и breaker

test("недоступный рендерер терминализует ран до цикла случаев, а не через N×ретраев", async () => {
  const harness = await setup();
  harness.service.rendererAvailable = false;
  const run = await runOnce(harness);

  expect(run.status).toBe("error");
  expect(run.status_reason).toBe("renderer_unavailable");
  // Ни одной постановки джобы: прекондиция сработала до первого случая.
  expect(harness.service.calls).toBe(0);
  const rows = harness.repo.cases(run.run_id);
  expect(rows.every((row) => row.status === "skipped")).toBe(true);
  expect(rows.every((row) => JSON.parse(row.error_json!).outcome === "renderer_unavailable")).toBe(true);
  const resume = harness.repo.runResume(run)!;
  expect(resume).toMatchObject({ resumable: true, phase: "allocate-renderer", lastCompletedPhase: "resolve" });
  harness.db.close();
});

/**
 * Circuit breaker: `queue_full` подряд означает, что слот не достаётся вовсе. До волны это
 * съедало все попытки всех случаев без единого различимого `statusReason`.
 */
test("три подряд исхода класса аллокации терминализуют ран, остальные случаи — skipped", async () => {
  const harness = await setup();
  harness.service.capacity = false;
  const run = await runOnce(harness);

  expect(run.status).toBe("error");
  expect(run.status_reason).toBe("queue_starvation");
  const rows = harness.repo.cases(run.run_id);
  const errored = rows.filter((row) => row.status === "error");
  // Ровно порог, ни одним случаем больше: breaker обрывает цикл, а не досчитывает набор.
  expect(errored).toHaveLength(ALLOCATE_BREAKER_THRESHOLD);
  expect(rows.filter((row) => row.status === "skipped").length).toBe(rows.length - ALLOCATE_BREAKER_THRESHOLD);
  expect(JSON.parse(errored[0]!.error_json!).outcome).toBe("queue_full");
  expect(harness.repo.runResume(run)).toMatchObject({ resumable: true, phase: "allocate-renderer" });
  harness.db.close();
});

// ------------------------------------------------- 3. фазы и per-gate отпечатки

test("гейты несут отпечаток и границы исполнения, а фаза рана — минимум по незавершённым случаям", async () => {
  const harness = await setup();
  const run = await runOnce(harness);
  expect(run.status).not.toBe("error");

  const gates = gatesOf(harness, run.run_id, "alpha");
  expect(gates.length).toBeGreaterThan(0);
  for (const gate of gates) {
    expect(typeof gate.fingerprint).toBe("string");
    expect(typeof gate.startedAt).toBe("string");
    expect(typeof gate.finishedAt).toBe("string");
  }
  // Все гейты случая завершены ⇒ его фаза — последняя, `determinism`; ран без незавершённых
  // случаев отдаёт `verdict`.
  expect(lastCompletedPhaseOfGates(gates)).toBe("determinism");
  expect(runLastCompletedPhase([])).toBe("verdict");
  // Минимум, а не максимум: «дальше этой фазы ран целиком не продвинулся».
  expect(runLastCompletedPhase(["capture", "validate", "geometry"])).toBe("validate");
  // Незавершённый гейт обрывает шкалу на предыдущей фазе.
  expect(lastCompletedPhaseOfGates([
    { gate: "contract", status: "pass", finishedAt: "t" },
    { gate: "defaults", status: "pass" },
  ] as GateEnvelope[])).toBe("validate");
  harness.db.close();
});

// -------------------------------------------------------- 4. рестарт и sweep

test("стартовая уборка называет себя interrupted и объявляет ран продолжаемым", async () => {
  const harness = await setup();
  const started = await harness.orchestrator.startRun({ candidateId: harness.candidateId, createdBy: "user_a" });
  // Ран остался `queued` — ровно то состояние, в котором его застаёт рестарт процесса.
  expect(harness.repo.sweepNonTerminalRuns()).toBe(1);

  const row = harness.repo.requireRun(started.run.run_id);
  expect(row.status).toBe("error");
  expect(row.status_reason).toBe("interrupted");
  expect(harness.repo.runResume(row)).toMatchObject({ resumable: true, reason: "interrupted" });
  // Причина, названная самим раном, уборкой не переименовывается.
  harness.db.close();
});

// ------------------------------------------------------------- 5. resume

test("resume создаёт новый ран с lineage, переиспользует завершённые structural-гейты и снимает заново", async () => {
  const harness = await setup();
  // Ран встаёт на аллокации: structural-гейты успели пройти, кадра нет ни у одного случая —
  // ровно то состояние, ради которого resume и заводился (частично исполненный случай).
  harness.service.capacity = false;
  const first = await runOnce(harness);
  expect(first.status_reason).toBe("queue_starvation");
  expect(harness.service.calls).toBe(0);
  // Строки кэша результатов у упавшего случая нет: полный reuse-каскад его не найдёт, и перенос
  // гейтов — единственный способ не считать `contract`/`defaults`/`audit` заново.
  expect(gatesOf(harness, first.run_id, "alpha").some((gate) => gate.gate === "contract")).toBe(true);
  harness.service.capacity = true;

  const resumed = await harness.orchestrator.resumeRun(first.run_id, { createdBy: "user_a" });
  expect(resumed.run.run_id).not.toBe(first.run_id);
  expect(resumed.run.resumed_from_run_id).toBe(first.run_id);
  expect(resumed.run.attempt).toBe(2);
  // Идемпотентность — детерминированная формула, а не NULL-ключ (NULL-ы в SQLite различны).
  expect(resumed.run.idempotency_key).toBe(`resume:${first.run_id}:2`);
  const lineage = harness.repo.runResume(resumed.run)!;
  expect(lineage.resumedFrom).toMatchObject({ runId: first.run_id, statusReason: "queue_starvation", phase: "allocate-renderer" });

  const second = await harness.orchestrator.executeRun(resumed.run.run_id);
  expect(second.status).not.toBe("error");
  const gates = gatesOf(harness, second.run_id, "alpha");
  // AC фидбэка §9: contract/defaults/audit не переисполняются — они переехали из предка.
  for (const name of ["contract", "defaults", "audit"]) {
    expect(gates.find((gate) => gate.gate === name)?.reusedFromRunId).toBe(first.run_id);
  }
  // …а капчур стартовал заново: кадр предка доказательством не является.
  expect(gates.find((gate) => gate.gate === "render")?.reusedFromRunId).toBeUndefined();
  expect(harness.service.calls).toBeGreaterThan(0);
  harness.db.close();
});

test("resume отказывает на ране с вердиктом и на уже продолженном ране", async () => {
  const harness = await setup();
  const first = await runOnce(harness);
  // Ран дал вердикт и продолжаемым себя не объявлял.
  await expect(harness.orchestrator.resumeRun(first.run_id, { createdBy: "user_a" }))
    .rejects.toMatchObject({ status: 409, code: "run_not_resumable" });

  harness.db.run("UPDATE acceptance_runs SET status_reason='interrupted', resume_json=? WHERE run_id=?",
    [JSON.stringify({ resumable: true }), first.run_id]);
  const resumed = await harness.orchestrator.resumeRun(first.run_id, { createdBy: "user_a" });
  await harness.orchestrator.executeRun(resumed.run.run_id);

  // Повторное продолжение того же предка называет живое/последнее продолжение.
  await expect(harness.orchestrator.resumeRun(first.run_id, { createdBy: "user_a" }))
    .rejects.toMatchObject({ status: 409, code: "run_already_resumed", details: { runId: resumed.run.run_id } });
  harness.db.close();
});

test("продолжение не создаёт второго живого рана: in-flight-индекс остаётся арбитром", async () => {
  const harness = await setup();
  const first = await runOnce(harness);
  harness.db.run("UPDATE acceptance_runs SET status_reason='interrupted', resume_json=? WHERE run_id=?",
    [JSON.stringify({ resumable: true }), first.run_id]);
  const resumed = await harness.orchestrator.resumeRun(first.run_id, { createdBy: "user_a" });
  // Продолжение ещё `queued` — второй ран того же кандидата невозможен по построению.
  expect(resumed.run.status).toBe("queued");
  await expect(harness.orchestrator.startRun({ candidateId: harness.candidateId, createdBy: "user_a" }))
    .rejects.toMatchObject({ status: 409, code: "acceptance_run_in_flight" });
  harness.db.close();
});

// --------------------------------------------------- 6. отпечатки гейтов

test("гейт переезжает только при совпавшем отпечатке и завершённости", () => {
  const fps = {
    case: "case-1", frame: "frame-1", comparison: "comparison-1", verdictPolicy: "policy-1",
    verdictPolicySnapshot: {} as never,
  };
  const other = { ...fps, frame: "frame-2" };
  const stored: GateResult[] = [
    { gate: "contract", status: "pass", fingerprint: gateFingerprintOf("contract", fps), finishedAt: "t" } as GateResult,
    // Незавершённый (процесс умер посреди гейта) — не переезжает.
    { gate: "defaults", status: "pass", fingerprint: gateFingerprintOf("defaults", fps) } as GateResult,
    // Отпечаток из другого кадра — не переезжает.
    { gate: "audit", status: "pass", fingerprint: gateFingerprintOf("audit", other), finishedAt: "t" } as GateResult,
    // Гейт не фазы `validate` — не переезжает НИКОГДА, даже с совпавшим отпечатком.
    { gate: "render", status: "pass", fingerprint: gateFingerprintOf("render", fps), finishedAt: "t" } as GateResult,
  ];
  expect([...resumableGatesOf(stored, fps).keys()]).toEqual(["contract"]);
  // Отпечаток — функция всех трёх слоёв: смена любого делает гейт непереиспользуемым.
  expect(gateFingerprintOf("contract", fps)).not.toBe(gateFingerprintOf("contract", other));
  expect(gateFingerprintOf("contract", fps)).not.toBe(gateFingerprintOf("defaults", fps));
});

// ------------------------------------------------------------ 7. kill-switch

test("kill-switch читается по месту вызова", () => {
  expect(acceptanceResumeEnabled()).toBe(true);
  process.env.EASYUI_ACCEPTANCE_RESUME_DISABLED = "1";
  try { expect(acceptanceResumeEnabled()).toBe(false); }
  finally { delete process.env.EASYUI_ACCEPTANCE_RESUME_DISABLED; }
});
