import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import pngjs from "pngjs";
import { migrate } from "../migrations";
import { ApiError } from "../http";
import { acquireMaintenanceLock, maintenanceLockHeld } from "../maintenance";
import type { CandidateEntry } from "../components/candidates";
import type { CaptureProbe, JobOutcome, JobStatus, ScreenshotResult } from "../screenshot/service";
import type { InkBboxResult } from "./inkBbox";
import { caseSetManifestSchema, type CaseSetManifest } from "../../src/acceptance/caseSetSchema";
import { buildCases, propsHashOf } from "./cases";
import { CaseSetRepo } from "./caseSets";
import { artifactPresent, casPath, readRunManifest } from "./evidence";
import type { AcceptanceCaptureService, CandidateSubject, GateResult } from "./gates/types";
import { AcceptanceOrchestrator, type RefreshSpec } from "./orchestrator";
import { readinessPolicyHashOf } from "./ids";
import { ACCEPTANCE_POLICIES, policyProfileHash } from "./policies";
import { AcceptanceRepo, type CandidateRow } from "./repo";
import { caseVerdictOf, foldRunVerdict, progressOf, severityOf, type CaseExecution } from "./runner";

// W1a (план 2026-08-03 §3 D10/D11, §5 W1a): исполнение случаев, reuse, авто-retry и свёртка.

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const profile = ACCEPTANCE_POLICIES["default-v1"];
const COMPONENT_ID = "acc-runner-probe";

const { PNG } = pngjs;

/**
 * Кадр случая — **настоящий PNG**, а не восемь байт с magic-заголовком: с W5a кадр читает не
 * только CAS, но и визуальный гейт (pngjs-подпроцесс). Позиция прямоугольника выводится из props,
 * поэтому два случая по-прежнему дают разные артефакты, а один и тот же случай — байт в байт
 * одинаковые (это же свойство судит гейт `determinism`).
 */
function framePng(props: Record<string, unknown> | undefined, shift = 0): Uint8Array {
  const seed = [...JSON.stringify(props ?? {})].reduce((sum, char) => (sum + char.charCodeAt(0)) % 7, 0);
  const png = new PNG({ width: 24, height: 20 });
  png.data.fill(0);
  for (let y = 4; y < 14; y += 1) {
    for (let x = 4 + seed + shift; x < 12 + seed + shift; x += 1) {
      const offset = (y * 24 + x) * 4;
      png.data[offset] = 0x20; png.data[offset + 1] = 0x40; png.data[offset + 2] = 0xc0; png.data[offset + 3] = 0xff;
    }
  }
  return new Uint8Array(PNG.sync.write(png));
}

/**
 * Исход readiness «политика выполнена» (W4): хэш — тот же, что у политики профиля, иначе гейт
 * честно ответил бы `indeterminate` («поверхность ждала по другой политике»).
 */
const READY_READINESS = {
  readinessMet: true as boolean | null,
  readinessReason: null as string | null,
  readinessPolicyHash: readinessPolicyHashOf(ACCEPTANCE_POLICIES["default-v1"].readiness) as string | null,
  readinessEvidence: {
    fontFaces: [{ family: "Ya Sans", weight: "400", style: "normal", status: "loaded" }],
    images: { total: 1, decoded: 1, failed: 0 },
    pendingRequests: [] as string[],
    framesWaited: 2, animationsDisabled: true,
    themeResources: { tokens: ["--eui-color-bg"], icons: ["asset_icon"], images: [] },
  } as Record<string, unknown> | null,
  captureEnvFingerprint: "env-fingerprint" as string | null,
  captureEnv: null as Record<string, unknown> | null,
};

// ------------------------------------------------------------------ заглушки

type ReadinessFields = typeof READY_READINESS;

const imageBytes = (bytes: Uint8Array, productError = false, readiness: ReadinessFields = READY_READINESS): ScreenshotResult => ({
  kind: "image-bytes",
  bytes, width: 10, height: 10, imageProduced: true,
  consoleErrors: productError ? ["TypeError: props.label is not a function"] : [],
  pageErrors: [],
  captureClean: !productError,
  productErrors: productError ? ["TypeError: props.label is not a function"] : [],
  infraNoise: [], runtimeWarnings: [],
  rendererBuild: null, browserVersion: "test/1",
  ...readiness,
});

/**
 * Исход paint-джобы (W3): одна сессия отдаёт и layout-факты, и кадр. `layoutBounds` совпадает с
 * `PAINT_INK` заглушки ink-bbox, поэтому вердикт политики — `clean`, и геометрия (теперь
 * обязательный гейт) не роняет случаи, предмет которых — reuse/retry/свёртка.
 */
const PAINT_LAYOUT = { x: 64, y: 64, width: 140, height: 96 };
const paintResult = (bytes: Uint8Array, readiness: ReadinessFields = READY_READINESS): ScreenshotResult => ({
  kind: "paint", surface: "component", componentId: COMPONENT_ID, draftRev: 1, bundleHash: "bundle",
  designSystemMetaVersion: null, resolvedSpaceScale: {}, viewport: { width: 390, height: 844 }, dpr: 2,
  paintMargin: 64, bytes, width: 536, height: 448, imageProduced: true,
  captureClean: true, productErrors: [], infraNoise: [], runtimeWarnings: [],
  consoleErrors: [], pageErrors: [], rendererBuild: null, browserVersion: "test/1",
  ...readiness,
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
  /** Исход readiness кадров этого капчура (W4); тесты D5 подменяют его на `met: false`. */
  readiness: ReadinessFields = READY_READINESS;
  /** Кадр детерминирован по props: два разных случая обязаны давать разные артефакты. */
  bytesFor: (props: Record<string, unknown> | undefined) => Uint8Array = (props) => framePng(props);
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
      this.statuses.set(jobId, { status: "done", result: paintResult(this.bytesFor(opts.props), this.readiness) });
      this.outcomes.set(jobId, "ok");
    } else {
      this.statuses.set(jobId, { status: "done", result: imageBytes(this.bytesFor(opts.props), verdict === "product", this.readiness) });
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

// ------------------------------------------------------ readiness / D5 (W4)

test("readiness fail роняет случай, глушит сравнивающие гейты и не ретраится", async () => {
  const harness = await setup();
  harness.service.readiness = {
    ...READY_READINESS,
    readinessMet: false,
    readinessReason: "images_failed",
    readinessEvidence: {
      ...(READY_READINESS.readinessEvidence as Record<string, unknown>),
      images: { total: 1, decoded: 0, failed: 1 },
      pendingRequests: ["image:/api/assets/asset_late_icon"],
    },
  };
  const run = await startAndRun(harness);

  expect(run.status).toBe("fail");
  const rows = harness.repo.cases(run.run_id);
  const alpha = rows.find((row) => row.case_id === "alpha")!;
  expect(alpha.verdict).toBe("fail");
  const gates = JSON.parse(alpha.gates_json!) as GateResult[];
  const readiness = gates.find((gate) => gate.gate === "readiness")!;
  expect(readiness.status).toBe("fail");
  expect(readiness.detail).toContain("asset_late_icon");
  expect((readiness.metrics as { reason: string }).reason).toBe("images_failed");
  // Доказательство (включая themeResources — вход W6) уезжает в CAS даже у провала.
  expect(readiness.artifacts?.map((artifact) => artifact.name)).toEqual(["readiness.json"]);
  expect((readiness.metrics as { themeResources: { icons: string[] } }).themeResources.icons).toEqual(["asset_icon"]);

  // Инвариант D5: сравнивающие гейты вердикта не выдают вовсе.
  for (const name of ["geometry", "visual", "determinism"]) {
    const gate = gates.find((item) => item.gate === name);
    if (!gate) continue;
    expect(gate.status).toBe("indeterminate");
    expect((gate.metrics as { skippedByReadiness?: boolean }).skippedByReadiness).toBe(true);
  }
  // Не-ready — продуктовый исход: ретраев нет, а paint-джоба даже не ставится.
  expect(harness.service.calls.filter((call) => call.probe === "paint")).toHaveLength(0);
  expect(harness.service.renderCalls).toBe(2);
  harness.db.close();
});

test("капчур без доказательства readiness даёт indeterminate, а не молчаливый pass", async () => {
  const harness = await setup();
  harness.service.readiness = {
    ...READY_READINESS,
    readinessMet: null, readinessReason: null, readinessPolicyHash: null, readinessEvidence: null,
    captureEnvFingerprint: null,
  };
  const run = await startAndRun(harness);
  expect(run.status).toBe("fail");
  const gates = JSON.parse(harness.repo.cases(run.run_id)[0]!.gates_json!) as GateResult[];
  expect(gates.find((gate) => gate.gate === "readiness")!.status).toBe("indeterminate");
  // Вердикт не выдан — но и обвинения нет: severity класса `indeterminate`.
  expect(JSON.parse(harness.repo.cases(run.run_id)[0]!.severity_json!)).toMatchObject({ class: "indeterminate" });
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
  // Advisory-гейт (`visual` в `default-v1`) вердикта не даёт ни в какую сторону.
  expect(caseVerdictOf([{ gate: "visual", status: "fail" }], profile)).toBe("skipped");
  expect(severityOf([{ gate: "visual", status: "fail" }], profile)).toBeNull();
  // W5a: в профиле с обязательным визуалом тот же провал классифицируется по метрикам гейта.
  const strict = ACCEPTANCE_POLICIES["pixel-strict-v1"];
  expect(caseVerdictOf([{ gate: "visual", status: "fail" }], strict)).toBe("fail");
  expect(severityOf([{ gate: "visual", status: "fail", metrics: { severityClass: "raw" } }], strict)).toMatchObject({ class: "raw", rank: 2 });
  expect(severityOf([{ gate: "visual", status: "fail", metrics: { severityClass: "aa" } }], strict)).toMatchObject({ class: "aa", rank: 3 });
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

// ------------------------------------------------------ visual / A5 (W5a)

const sha256Of = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** Регистрирует байты в asset-store (строка `assets` + файл по sha) — так же, как ingest. */
async function putAsset(harness: Awaited<ReturnType<typeof setup>>, bytes: Uint8Array): Promise<string> {
  const sha = sha256Of(bytes);
  await mkdir(resolve(harness.dir, "assets"), { recursive: true });
  await writeFile(resolve(harness.dir, "assets", sha), bytes);
  harness.db.run(
    "INSERT OR IGNORE INTO assets (id,sha256,mime,size,width,height,original_name,created_at) VALUES (?,?,?,?,?,?,?,?)",
    [`asset_${sha}`, sha, "image/png", bytes.byteLength, 24, 20, "reference.png", new Date().toISOString()],
  );
  return `asset_${sha}`;
}

/** Case-set на один случай с эталоном; `requireVisual` включает обязательность гейта (A5). */
function caseSetOf(referenceAssetId: string, options: { requireVisual?: boolean } = {}): CaseSetManifest {
  return caseSetManifestSchema.parse({
    manifestVersion: 1,
    componentId: COMPONENT_ID,
    capture: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, theme: "light" },
    ...(options.requireVisual ? { requireVisual: true } : {}),
    cases: [{ id: "alpha", props: { label: "a" }, referenceAssetId }],
  });
}

async function runWithCaseSet(harness: Awaited<ReturnType<typeof setup>>, manifest: CaseSetManifest) {
  const { row } = new CaseSetRepo(harness.db).put({
    componentId: COMPONENT_ID, designSystem: "yandex-pay", manifest, createdBy: "user_a",
  });
  const started = await harness.orchestrator.startRun({
    candidateId: harness.candidateId, createdBy: "user_a", caseSetId: row.case_set_id,
  });
  const run = await harness.orchestrator.executeRun(started.run.run_id);
  const gates = JSON.parse(harness.repo.cases(run.run_id)[0]!.gates_json!) as GateResult[];
  return { run, gates, visual: gates.find((gate) => gate.gate === "visual") };
}

test("эталон, совпавший с paint-кадром, даёт visual pass с метриками и артефактами", async () => {
  const harness = await setup();
  // Эталон — тот самый кадр, который отдаст paint-джоба случая `alpha` (честный контур: сначала
  // снимок, потом он же как reference).
  const referenceAssetId = await putAsset(harness, framePng({ label: "a" }));
  const { run, visual } = await runWithCaseSet(harness, caseSetOf(referenceAssetId));

  expect(run.status).toBe("pass");
  expect(visual?.status).toBe("pass");
  expect(visual?.metrics).toMatchObject({ rawDiffPct: 0, aaDiffPct: 0, maxChannelDelta: 0, referenceAssetId, required: false });
  expect(visual?.artifacts?.map((item) => item.name).sort()).toEqual(["diff.png", "normalized-candidate.png", "visual.json"]);
  // Run-level агрегат видит гейт: «объявлен, посчитан» отличимо от «не считался».
  expect(JSON.parse(run.gates_json!) as Record<string, Record<string, number>>).toMatchObject({ visual: { pass: 1 } });
  harness.db.close();
});

test("сломанный эталон: visual fail с метриками; ран падает только при requireVisual", async () => {
  const advisory = await setup();
  const broken = await putAsset(advisory, framePng({ label: "a" }, 6));
  const soft = await runWithCaseSet(advisory, caseSetOf(broken));
  expect(soft.visual?.status).toBe("fail");
  expect((soft.visual?.metrics as { rawDiffPct: number }).rawDiffPct).toBeGreaterThan(2);
  // Эталон нарисован на 6px правее кандидата ⇒ кандидат «съехал» на -6px по X.
  expect((soft.visual?.metrics as { bestOffset: { dx: number } }).bestOffset.dx).toBe(-6);
  // `default-v1`: гейт advisory — метрики есть, но вердикт рана он не роняет.
  expect(soft.run.status).toBe("pass");
  advisory.db.close();

  const required = await setup();
  const brokenAgain = await putAsset(required, framePng({ label: "a" }, 6));
  const hard = await runWithCaseSet(required, caseSetOf(brokenAgain, { requireVisual: true }));
  expect(hard.visual?.status).toBe("fail");
  expect(hard.run.status).toBe("fail");
  const row = required.repo.cases(hard.run.run_id)[0]!;
  expect(row.verdict).toBe("fail");
  expect(JSON.parse(row.severity_json!) as { class: string }).toMatchObject({ class: "raw" });
  required.db.close();
});

test("requireVisual без эталона — indeterminate: skipped обязательному гейту не положен (D10)", async () => {
  const harness = await setup();
  const manifest = caseSetManifestSchema.parse({
    manifestVersion: 1,
    componentId: COMPONENT_ID,
    capture: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, theme: "light" },
    requireVisual: true,
    cases: [{ id: "alpha", props: { label: "a" } }],
  });
  const { run, visual } = await runWithCaseSet(harness, manifest);
  expect(visual?.status).toBe("indeterminate");
  expect(visual?.metrics).toMatchObject({ required: true, reason: "no_reference" });
  expect(run.status).toBe("fail");
  harness.db.close();
});

test("инвариант D5: кадр без readiness не доходит до визуального гейта", async () => {
  const harness = await setup();
  const referenceAssetId = await putAsset(harness, framePng({ label: "a" }));
  harness.service.readiness = {
    ...READY_READINESS,
    readinessMet: false,
    readinessReason: "fonts_pending",
    readinessEvidence: { ...(READY_READINESS.readinessEvidence as Record<string, unknown>), pendingRequests: ["font:Ya Sans"] },
  };
  const { run, visual } = await runWithCaseSet(harness, caseSetOf(referenceAssetId, { requireVisual: true }));

  expect(run.status).toBe("fail");
  // Гейт не исполнялся: вердикт — заглушка раннера, метрик сравнения нет вовсе.
  expect(visual?.status).toBe("indeterminate");
  expect(visual?.metrics).toEqual({ skippedByReadiness: true });
  expect(visual?.artifacts).toBeUndefined();
  harness.db.close();
});

test("смена requireVisual инвалидирует reuse: вердикт advisory-гейта не наследуется обязательным", async () => {
  const harness = await setup();
  const broken = await putAsset(harness, framePng({ label: "a" }, 6));
  const soft = await runWithCaseSet(harness, caseSetOf(broken));
  expect(soft.run.status).toBe("pass");

  // Тот же случай, тот же кадр, тот же эталон — но теперь визуал обязателен. Переиспользовать
  // прошлый `pass` нельзя: он посчитан по другой обязательности.
  const hard = await runWithCaseSet(harness, caseSetOf(broken, { requireVisual: true }));
  expect(hard.run.status).toBe("fail");
  expect(harness.repo.cases(hard.run.run_id)[0]!.reuse_reason).toBeNull();
  harness.db.close();
});

// ------------------------------------------ причины и ремедиации (W5b, §19.6)

test("W5b: провальный визуальный случай получает причины, прошедший — нет", async () => {
  const failing = await setup();
  // Эталон сдвинут на 6px: сигнал «съехало», а не «перерисовано» — классификатор обязан это назвать.
  const broken = await putAsset(failing, framePng({ label: "a" }, 6));
  const hard = await runWithCaseSet(failing, caseSetOf(broken, { requireVisual: true }));
  expect(hard.visual?.status).toBe("fail");
  const causes = hard.visual?.causes ?? [];
  expect(causes.length).toBeGreaterThan(0);
  expect(causes[0]!.code).toBe("geometry-shift");
  expect(causes[0]!.confidence).toBeGreaterThan(0.5);
  // Вердикт посчитан гейтами и классификацией не тронут (§2/§10 плана).
  expect(failing.repo.cases(hard.run.run_id)[0]!.verdict).toBe("fail");
  failing.db.close();

  const passing = await setup();
  const exact = await putAsset(passing, framePng({ label: "a" }));
  const soft = await runWithCaseSet(passing, caseSetOf(exact, { requireVisual: true }));
  expect(soft.visual?.status).toBe("pass");
  expect(soft.visual?.causes).toBeUndefined();
  passing.db.close();
});

test("W5b: терминальный ран несёт remediationGroups в отчёте", async () => {
  const harness = await setup();
  const broken = await putAsset(harness, framePng({ label: "a" }, 6));
  const { run } = await runWithCaseSet(harness, caseSetOf(broken, { requireVisual: true }));
  const progress = JSON.parse(run.progress_json) as { remediationGroups: { cause: { code: string }; cases: string[]; caseCount: number; suggestion: string }[] };
  expect(progress.remediationGroups).toHaveLength(1);
  expect(progress.remediationGroups[0]).toMatchObject({ cause: { code: "geometry-shift" }, caseCount: 1, cases: ["alpha"] });
  expect(progress.remediationGroups[0]!.suggestion.length).toBeGreaterThan(0);
  harness.db.close();
});

test("W5b: прошедший ран не выдумывает групп", async () => {
  const harness = await setup();
  const run = await startAndRun(harness);
  expect(run.status).toBe("pass");
  expect((JSON.parse(run.progress_json) as { remediationGroups: unknown[] }).remediationGroups).toEqual([]);
  harness.db.close();
});
