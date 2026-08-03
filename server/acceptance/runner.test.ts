import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { migrate } from "../migrations";
import { ApiError } from "../http";
import { acquireMaintenanceLock, maintenanceLockHeld } from "../maintenance";
import type { CandidateEntry } from "../components/candidates";
import type { CaptureProbe, JobOutcome, JobStatus, ScreenshotResult } from "../screenshot/service";
import type { InkBboxResult } from "./inkBbox";
import { buildCases, propsHashOf } from "./cases";
import { artifactPresent, casPath, readRunManifest } from "./evidence";
import type { AcceptanceCaptureService, CandidateSubject, GateResult } from "./gates/types";
import { AcceptanceOrchestrator, type RefreshSpec } from "./orchestrator";
import { ACCEPTANCE_POLICIES, policyProfileHash } from "./policies";
import { AcceptanceRepo, type CandidateRow } from "./repo";
import { caseVerdictOf, foldRunVerdict, progressOf, severityOf, type CaseExecution } from "./runner";

// W1a (план 2026-08-03 §3 D10/D11, §5 W1a): исполнение случаев, reuse, авто-retry и свёртка.

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const profile = ACCEPTANCE_POLICIES["default-v1"];
const COMPONENT_ID = "acc-runner-probe";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

// ------------------------------------------------------------------ заглушки

const imageBytes = (bytes: Uint8Array, productError = false): ScreenshotResult => ({
  kind: "image-bytes",
  bytes, width: 10, height: 10, imageProduced: true,
  consoleErrors: productError ? ["TypeError: props.label is not a function"] : [],
  pageErrors: [],
  captureClean: !productError,
  productErrors: productError ? ["TypeError: props.label is not a function"] : [],
  infraNoise: [], runtimeWarnings: [],
  rendererBuild: null, browserVersion: "test/1",
});

/**
 * Исход paint-джобы (W3): одна сессия отдаёт и layout-факты, и кадр. `layoutBounds` совпадает с
 * `PAINT_INK` заглушки ink-bbox, поэтому вердикт политики — `clean`, и геометрия (теперь
 * обязательный гейт) не роняет случаи, предмет которых — reuse/retry/свёртка.
 */
const PAINT_LAYOUT = { x: 64, y: 64, width: 140, height: 96 };
const paintResult = (bytes: Uint8Array): ScreenshotResult => ({
  kind: "paint", surface: "component", componentId: COMPONENT_ID, draftRev: 1, bundleHash: "bundle",
  designSystemMetaVersion: null, resolvedSpaceScale: {}, viewport: { width: 390, height: 844 }, dpr: 2,
  paintMargin: 64, bytes, width: 536, height: 448, imageProduced: true,
  captureClean: true, productErrors: [], infraNoise: [], runtimeWarnings: [],
  consoleErrors: [], pageErrors: [], rendererBuild: null, browserVersion: "test/1",
  rects: [], truncated: false, total: 0,
  details: [{ key: "root", instance: 0, layoutBounds: { ...PAINT_LAYOUT }, effectSources: [], clipChain: [] }],
} as unknown as ScreenshotResult);

/** Заглушка ink-bbox: чернила ровно по layout-контуру ⇒ `policyVerdict: "clean"`. */
const cleanInk = (): Promise<InkBboxResult> => Promise.resolve({
  ok: true, source: "alpha", image: { width: 536, height: 448 }, deviceScaleFactor: 2,
  pixelBounds: { x: 128, y: 128, width: 280, height: 192 }, bounds: { ...PAINT_LAYOUT },
  clamped: { left: false, right: false, top: false, bottom: false },
});

type Script = (call: number, opts: { probe?: CaptureProbe; props?: Record<string, unknown> }) => "ok" | "crash" | "product";

class FakeCapture implements AcceptanceCaptureService {
  calls: { probe?: CaptureProbe; props?: Record<string, unknown> }[] = [];
  script: Script = () => "ok";
  /** Хук «что-то случилось снаружи, пока шла съёмка» (kill/resume-тест). */
  onEnqueue: (props: Record<string, unknown> | undefined) => void = () => {};
  /** Кадр детерминирован по props: два разных случая обязаны давать разные артефакты. */
  bytesFor: (props: Record<string, unknown> | undefined) => Uint8Array =
    (props) => new Uint8Array([...PNG, ...new TextEncoder().encode(JSON.stringify(props ?? {}))]);
  private statuses = new Map<string, JobStatus>();
  private outcomes = new Map<string, JobOutcome>();

  get renderCalls(): number { return this.calls.filter((call) => call.probe === undefined).length; }

  enqueueComponentCandidate(
    _id: string,
    _candidate: { rev: number; sourceHash: string },
    opts: { props?: Record<string, unknown>; probe?: CaptureProbe; deliver?: "asset" | "bytes"; background?: boolean; viewport: unknown },
  ): Promise<{ jobId: string }> {
    const call = this.calls.length + 1;
    this.calls.push({ probe: opts.probe, props: opts.props });
    this.onEnqueue(opts.props);
    const jobId = `job_${call}`;
    const verdict = this.script(call, { probe: opts.probe, props: opts.props });
    if (verdict === "crash") {
      this.statuses.set(jobId, { status: "error", error: { code: "capture_failed", message: "worker produced no result: killed" } });
      this.outcomes.set(jobId, "worker_crash");
    } else if (opts.probe === "paint") {
      this.statuses.set(jobId, { status: "done", result: paintResult(this.bytesFor(opts.props)) });
      this.outcomes.set(jobId, "ok");
    } else {
      this.statuses.set(jobId, { status: "done", result: imageBytes(this.bytesFor(opts.props), verdict === "product") });
      this.outcomes.set(jobId, "ok");
    }
    return Promise.resolve({ jobId });
  }

  get(jobId: string): JobStatus {
    const status = this.statuses.get(jobId);
    if (!status) throw new ApiError(404, "job_not_found", "Screenshot job not found");
    return status;
  }
  outcome(jobId: string): JobOutcome | undefined { return this.outcomes.get(jobId); }
  hasBackgroundCapacity(): boolean { return true; }
}

const EXAMPLES = {
  alpha: { label: "a" },
  beta: { label: "b" },
  // Дубликат props `alpha` — обязан стать алиасом, а не второй съёмкой (A7).
  zeta: { label: "a" },
};

const candidateEntry = (): CandidateEntry => ({
  version: 1, sourceHash: "src-hash", componentIds: [COMPONENT_ID], createdAt: new Date().toISOString(), ok: true,
  extracted: { ok: true, warnings: [], meta: { events: [], slots: [], description: "probe", examples: EXAMPLES, propsJsonSchema: { type: "object" } } } as unknown as CandidateEntry["extracted"],
  parityWarnings: [], bundleHash: "bundle", hostAbiVersion: 4,
});

async function setup(options: { entry?: CandidateEntry } = {}) {
  const dir = await mkdtemp(resolve(process.cwd(), ".acc-runner-test-"));
  dirs.push(dir);
  const db = new Database(":memory:");
  migrate(db);
  db.run("INSERT INTO components (id,name,head_rev,created_at,updated_at,design_system) VALUES (?,?,1,'now','now','yandex-pay')", [COMPONENT_ID, "AccRunnerProbe"]);
  const repo = new AcceptanceRepo(db);
  const { candidate } = repo.createCandidate({
    componentId: COMPONENT_ID, designSystem: "yandex-pay", rev: 1, sourceHash: "src-hash", bundleHash: "bundle",
    hostAbiVersion: 4, themeVersion: 1, observedCatalogRevision: "cat", policyProfileHash: policyProfileHash(profile),
    createdBy: "user_a",
  });
  const entry = options.entry ?? candidateEntry();
  const service = new FakeCapture();
  const subject = (row: CandidateRow): CandidateSubject => ({
    candidateId: row.candidate_id, componentId: row.component_id, designSystem: row.design_system, rev: row.rev,
    sourceHash: row.source_hash, bundleHash: row.bundle_hash, hostAbiVersion: row.host_abi_version,
    themeVersion: row.theme_version, entry,
  });
  const orchestrator = new AcceptanceOrchestrator({
    db, dataDir: dir, service, autoDrain: false, sleep: () => Promise.resolve(),
    inkBbox: cleanInk,
    resolveCandidate: (row) => Promise.resolve(subject(row)),
  });
  return { db, dir, repo, service, orchestrator, candidateId: candidate.candidate_id };
}

const startAndRun = async (
  harness: Awaited<ReturnType<typeof setup>>,
  refresh: RefreshSpec = "none",
  cases?: { key: string; props: Record<string, unknown> }[],
) => {
  const started = await harness.orchestrator.startRun({
    candidateId: harness.candidateId, createdBy: "user_a", refresh, ...(cases ? { cases } : {}),
  });
  return harness.orchestrator.executeRun(started.run.run_id);
};

const reuseReasons = (harness: Awaited<ReturnType<typeof setup>>, runId: string): Record<string, string | null> =>
  Object.fromEntries(harness.repo.cases(runId).map((row) => [row.case_id, row.reuse_reason]));

// ------------------------------------------------------------------- случаи

test("case set comes from candidate examples: duplicate props become an alias, empty and oversized sets are refused", () => {
  const cases = buildCases(candidateEntry());
  expect(cases.map((item) => item.caseId)).toEqual(["alpha", "beta", "zeta"]);
  expect(cases[2]!.aliasOfCaseId).toBe("alpha");
  expect(cases[0]!.propsHash).toBe(propsHashOf({ label: "a" }));

  const empty = { ...candidateEntry(), extracted: { ok: true, warnings: [], meta: { events: [], slots: [], description: "x" } } as unknown as CandidateEntry["extracted"] };
  expect(() => buildCases(empty)).toThrow(expect.objectContaining({ code: "empty_case_set" }));
  expect(() => buildCases(candidateEntry(), { maxCases: 2 })).toThrow(expect.objectContaining({ code: "case_set_too_large" }));
});

test("cold run captures each target once per gate, aliases inherit the verdict, and evidence is written", async () => {
  const harness = await setup();
  const run = await startAndRun(harness);

  expect(run.status).toBe("pass");
  const cases = harness.repo.cases(run.run_id);
  expect(cases).toHaveLength(3);
  const byId = Object.fromEntries(cases.map((row) => [row.case_id, row]));
  expect(byId.alpha!.verdict).toBe("pass");
  expect(byId.zeta!.alias_of_case_id).toBe("alpha");
  expect(byId.zeta!.reuse_reason).toBe("alias_of:alpha");
  // Две цели × (render + paint-probe + determinism) — алиас не снимается вовсе.
  expect(harness.service.renderCalls).toBe(4);
  expect(harness.service.calls.filter((call) => call.probe === "paint")).toHaveLength(2);

  const manifest = await readRunManifest(harness.dir, run.run_id);
  expect(manifest?.verdict).toBe("pass");
  expect(manifest?.cases).toHaveLength(3);
  expect(run.evidence_manifest_hash).toMatch(/^[0-9a-f]{64}$/);
  const sha = manifest!.cases.flatMap((item) => item.artifacts).find((item) => item.name === "render.png")!.sha256;
  expect(await artifactPresent(harness.dir, sha)).toBe(true);

  const progress = JSON.parse(run.progress_json) as ReturnType<typeof progressOf>;
  expect(progress).toMatchObject({ total: 3, completed: 3, reused: 0, failed: 0, running: 0 });
  expect(progress.eta.basis).toBe("measured");
  harness.db.close();
});

test("a second run over the same cases reuses every verdict and captures nothing", async () => {
  const harness = await setup();
  const first = await startAndRun(harness);
  expect(first.status).toBe("pass");
  const captured = harness.service.calls.length;

  const second = await startAndRun(harness);
  expect(second.status).toBe("pass");
  expect(harness.service.calls.length).toBe(captured);
  const cases = harness.repo.cases(second.run_id);
  expect(cases.filter((row) => row.reuse_reason === "case_fingerprint")).toHaveLength(2);
  const progress = JSON.parse(second.progress_json) as ReturnType<typeof progressOf>;
  expect(progress.reused).toBe(2);
  expect(progress.eta.basis).toBe("estimate");
  harness.db.close();
});

test("reuse is refused when the CAS artifact is gone: the case is captured again", async () => {
  const harness = await setup();
  const first = await startAndRun(harness);
  const captured = harness.service.calls.length;
  const manifest = await readRunManifest(harness.dir, first.run_id);
  for (const item of manifest!.cases) {
    for (const artifact of item.artifacts) await rm(casPath(harness.dir, artifact.sha256), { force: true });
  }

  const second = await startAndRun(harness);
  expect(second.status).toBe("pass");
  expect(harness.service.calls.length).toBeGreaterThan(captured);
  expect(harness.repo.cases(second.run_id).filter((row) => row.reuse_reason === "case_fingerprint")).toHaveLength(0);
  harness.db.close();
});

// ------------------------------------------------------- refresh (W1b, A3)

test('refresh:"all" пересуёмывает всё и пишет причину в reuse_reason', async () => {
  const harness = await setup();
  await startAndRun(harness);
  const captured = harness.service.calls.length;

  const forced = await startAndRun(harness, "all");
  expect(forced.status).toBe("pass");
  expect(harness.service.calls.length).toBeGreaterThan(captured);
  expect(reuseReasons(harness, forced.run_id)).toEqual({ alpha: "refresh:all", beta: "refresh:all", zeta: "alias_of:alpha" });
  const progress = JSON.parse(forced.progress_json) as ReturnType<typeof progressOf>;
  expect(progress.reused).toBe(0);

  const manifest = await readRunManifest(harness.dir, forced.run_id);
  expect(manifest!.cases.find((item) => item.caseId === "alpha")!.refreshReason).toBe("refresh:all");
  harness.db.close();
});

test('refresh:"failed" пересуёмывает только провальные случаи, остальные приезжают из кэша', async () => {
  const harness = await setup();
  // Продуктовая ошибка только у props alpha (её же наследует алиас zeta).
  harness.service.script = (_call, opts) => (opts.props?.label === "a" && opts.probe === undefined ? "product" : "ok");
  const first = await startAndRun(harness);
  expect(first.status).toBe("fail");
  expect(harness.repo.cases(first.run_id).find((row) => row.case_id === "alpha")!.verdict).toBe("fail");

  harness.service.script = () => "ok";
  const captured = harness.service.calls.length;
  const second = await startAndRun(harness, "failed");
  expect(second.status).toBe("pass");
  // Снят заново ровно один случай: beta прошёл и переиспользован.
  expect(reuseReasons(harness, second.run_id)).toEqual({ alpha: "refresh:failed", beta: "case_fingerprint", zeta: "alias_of:alpha" });
  expect(harness.repo.cases(second.run_id).find((row) => row.case_id === "alpha")!.verdict).toBe("pass");
  const progress = JSON.parse(second.progress_json) as ReturnType<typeof progressOf>;
  expect(progress.reused).toBe(1);
  // Одна цель × (render + paint + determinism) = 3 капчура вместо шести на два случая.
  expect(harness.service.calls.length - captured).toBe(3);
  harness.db.close();
});

test("refresh:{caseIds} пересуёмывает только перечисленные случаи; алиас форсит свою цель", async () => {
  const harness = await setup();
  await startAndRun(harness);
  const captured = harness.service.calls.length;

  const partial = await startAndRun(harness, { caseIds: ["beta"] });
  expect(partial.status).toBe("pass");
  expect(reuseReasons(harness, partial.run_id)).toEqual({ alpha: "case_fingerprint", beta: "refresh:cases", zeta: "alias_of:alpha" });
  expect(harness.service.calls.length - captured).toBe(3);

  // Алиас своей съёмки не имеет — форс уезжает на цель alpha.
  const viaAlias = await startAndRun(harness, { caseIds: ["zeta"] });
  expect(reuseReasons(harness, viaAlias.run_id)).toEqual({ alpha: "refresh:cases", beta: "case_fingerprint", zeta: "alias_of:alpha" });

  await expect(harness.orchestrator.startRun({ candidateId: harness.candidateId, createdBy: "user_a", refresh: { caseIds: ["nope"] } }))
    .rejects.toMatchObject({ status: 422, code: "unknown_case_id" });
  harness.db.close();
});

// ------------------------------------------------------- kill/resume (§4.6)

test("kill/resume: ран, умерший посередине, досуёмывается — завершённые случаи переиспользуются", async () => {
  const harness = await setup();
  const cases = [1, 2, 3, 4].map((index) => ({ key: `c${index}`, props: { label: `l${index}` } }));

  // «Смерть процесса» на третьем случае: ран терминализуется извне тем же sweep'ом, что делает
  // стартовая уборка после рестарта, а сам третий случай не доживает до записи результата.
  harness.service.onEnqueue = (props) => {
    if (props?.label === "l3") harness.repo.sweepNonTerminalRuns();
  };
  harness.service.script = (_call, opts) => (opts.props?.label === "l3" ? "crash" : "ok");
  const killed = await startAndRun(harness, "none", cases);
  expect(killed.status).toBe("error");
  const doneBefore = harness.repo.cases(killed.run_id).filter((row) => row.status === "done" && row.verdict !== null);
  expect(doneBefore.map((row) => row.case_id)).toEqual(["c1", "c2"]);

  harness.service.onEnqueue = () => {};
  harness.service.script = () => "ok";
  const captured = harness.service.calls.length;
  const resumed = await startAndRun(harness, "none", cases);
  expect(resumed.status).toBe("pass");
  const reasons = reuseReasons(harness, resumed.run_id);
  // Точный ассерт §4.6: переиспользовано ровно то, что успело завершиться, снято — остаток.
  expect(Object.entries(reasons).filter(([, reason]) => reason === "case_fingerprint").map(([caseId]) => caseId)).toEqual(["c1", "c2"]);
  expect(Object.entries(reasons).filter(([, reason]) => reason === null).map(([caseId]) => caseId)).toEqual(["c3", "c4"]);
  const progress = JSON.parse(resumed.progress_json) as ReturnType<typeof progressOf>;
  expect(progress).toMatchObject({ total: 4, completed: 4, reused: 2, failed: 0 });
  // Две недостающие цели × (render + geometry + determinism-сампл там, где он есть).
  expect(harness.service.calls.length - captured).toBeGreaterThanOrEqual(4);
  harness.db.close();
});

test("infrastructure outcomes are retried inside the budget; product errors are not retried", async () => {
  const crashOnce = await setup();
  // Первая джоба падает крэшем воркера, дальше всё в порядке — случай обязан пройти.
  crashOnce.service.script = (call) => (call === 1 ? "crash" : "ok");
  const run = await startAndRun(crashOnce);
  expect(run.status).toBe("pass");
  expect(crashOnce.service.calls.length).toBe(7);
  crashOnce.db.close();

  const product = await setup();
  product.service.script = () => "product";
  const failed = await startAndRun(product);
  expect(failed.status).toBe("fail");
  const rendered = product.service.calls.filter((call) => call.probe === undefined);
  // Продуктовая ошибка не ретраится: по одному render-капчуру на цель (determinism до сравнения
  // доходит, но повторную съёмку делает только сампл — здесь она тоже одна на цель).
  expect(rendered.length).toBeLessThanOrEqual(4);
  const cases = product.repo.cases(failed.run_id);
  expect(cases.every((row) => row.verdict === "fail")).toBe(true);
  const severity = JSON.parse(cases[0]!.severity_json!) as { class: string; rank: number };
  expect(severity).toMatchObject({ class: "structural", rank: 0 });
  const quality = JSON.parse(cases[0]!.capture_quality_json!) as { captureClean: boolean; productErrors: string[] };
  expect(quality.captureClean).toBe(false);
  expect(quality.productErrors).toHaveLength(1);
  product.db.close();
});

test("infrastructure failures beyond the retry budget terminalize the run as error, not fail", async () => {
  const harness = await setup();
  harness.service.script = () => "crash";
  const run = await startAndRun(harness);
  expect(run.status).toBe("error");
  const cases = harness.repo.cases(run.run_id);
  expect(cases[0]!.status).toBe("error");
  expect(cases[0]!.verdict).toBeNull();
  harness.db.close();
});

// -------------------------------------------------------------- свёртка D10

const execution = (overrides: Partial<CaseExecution>): CaseExecution => ({
  caseId: "c", caseKey: "c", caseFingerprint: "fp", status: "done", verdict: "pass", gates: [],
  severity: null, captureQuality: null, artifacts: [], aliasOfCaseId: null, reused: false,
  reuseReason: null, durationMs: 1, ...overrides,
});

test("D10: reused, skipped and aliased cases never mask a fail; indeterminate of a required gate blocks the run", () => {
  const pass = execution({ caseId: "ok", verdict: "pass", reused: true });
  const skipped = execution({ caseId: "skip", verdict: "skipped" });
  const alias = execution({ caseId: "alias", verdict: "pass", aliasOfCaseId: "ok", reuseReason: "alias_of:ok" });
  const failed = execution({ caseId: "bad", verdict: "fail" });
  const indeterminate = execution({ caseId: "ind", verdict: "indeterminate" });
  const errored = execution({ caseId: "err", status: "error", verdict: null });

  expect(foldRunVerdict([pass, skipped, alias], profile)).toBe("pass");
  expect(foldRunVerdict([pass, skipped, alias, failed], profile)).toBe("fail");
  expect(foldRunVerdict([pass, alias, indeterminate], profile)).toBe("fail");
  expect(foldRunVerdict([pass, errored], profile)).toBe("error");
  // fail старше error: инфраструктурный сбой не прячет продуктовый провал.
  expect(foldRunVerdict([failed, errored], profile)).toBe("fail");
  // Исключения без `allowExceptions` роняют ран (в обоих профилях фазы 1 они выключены).
  expect(foldRunVerdict([execution({ gates: [{ gate: "render", status: "pass", exceptions: ["waived"] }] })], profile)).toBe("fail");
});

test("case verdict and severity follow the required-gate set of the policy", () => {
  const gates = (status: GateResult["status"]): GateResult[] => [
    { gate: "contract", status: "pass" },
    { gate: "visual", status: "skipped" },
    { gate: "render", status },
  ];
  expect(caseVerdictOf(gates("pass"), profile)).toBe("pass");
  expect(caseVerdictOf(gates("fail"), profile)).toBe("fail");
  expect(caseVerdictOf(gates("indeterminate"), profile)).toBe("indeterminate");
  // Не реализованный фазой гейт вердикта не даёт ни в какую сторону.
  expect(caseVerdictOf([{ gate: "visual", status: "fail" }], profile)).toBe("skipped");
  expect(severityOf([{ gate: "visual", status: "fail" }], profile)).toBeNull();
  // W3: геометрия — обязательный гейт, её провал классифицируется отдельным классом severity.
  expect(caseVerdictOf([{ gate: "geometry", status: "fail" }], profile)).toBe("fail");
  expect(severityOf([{ gate: "geometry", status: "fail" }], profile)).toMatchObject({ class: "geometry" });
  expect(severityOf(gates("indeterminate"), profile)).toMatchObject({ class: "indeterminate" });
});

// ------------------------------------------------- оркестрация: жизнь ранов

test("startup sweep terminalizes runs that survived a restart, and the watchdog closes stale running runs", async () => {
  const harness = await setup();
  const started = await harness.orchestrator.startRun({ candidateId: harness.candidateId, createdBy: "user_a" });
  expect(started.run.status).toBe("queued");

  // Новый оркестратор поверх той же БД = рестарт процесса.
  const restarted = new AcceptanceOrchestrator({ db: harness.db, dataDir: harness.dir, service: harness.service, autoDrain: false });
  expect(restarted.repo.requireRun(started.run.run_id).status).toBe("error");

  // Watchdog: `running` дольше дедлайна политики.
  const again = await harness.orchestrator.startRun({ candidateId: harness.candidateId, createdBy: "user_a" });
  harness.repo.startRun(again.run.run_id, new Date(Date.now() - profile.runDeadlineMs - 60_000).toISOString());
  expect(harness.orchestrator.sweepStaleRuns()).toBe(1);
  expect(harness.repo.requireRun(again.run.run_id).status).toBe("error");
  harness.db.close();
});

test("cancel is allowed only from queued, and candidate pins cover non-terminal runs", async () => {
  const harness = await setup();
  const started = await harness.orchestrator.startRun({ candidateId: harness.candidateId, createdBy: "user_a" });
  expect(harness.orchestrator.candidatePins()).toEqual(new Set(["src-hash"]));

  const cancelled = harness.orchestrator.cancelQueuedRun(started.run.run_id);
  expect(cancelled.status).toBe("cancelled");
  expect(harness.orchestrator.candidatePins().size).toBe(0);
  expect(() => harness.orchestrator.cancelQueuedRun(started.run.run_id)).toThrow(expect.objectContaining({ code: "run_not_cancellable" }));
  // Терминальный ран не исполняется повторно.
  expect((await harness.orchestrator.executeRun(started.run.run_id)).status).toBe("cancelled");
  harness.db.close();
});

test("maintenance lock and acceptance runs are mutually exclusive", async () => {
  const harness = await setup();
  expect(maintenanceLockHeld(harness.db)).toBe(false);
  const started = await harness.orchestrator.startRun({ candidateId: harness.candidateId, createdBy: "user_a" });
  expect(() => acquireMaintenanceLock(harness.db, "mig_1", "catalog migration"))
    .toThrow(expect.objectContaining({ code: "acceptance_run_in_flight" }));

  harness.orchestrator.cancelQueuedRun(started.run.run_id);
  acquireMaintenanceLock(harness.db, "mig_1", "catalog migration");
  expect(maintenanceLockHeld(harness.db)).toBe(true);
  harness.db.close();
});
