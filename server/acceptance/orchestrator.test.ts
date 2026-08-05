import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import pngjs from "pngjs";
import { migrate } from "../migrations";
import { ApiError } from "../http";
import type { CandidateEntry } from "../components/candidates";
import type { CaptureProbe, JobOutcome, JobStatus, ScreenshotResult } from "../screenshot/service";
import type { CaptureCode } from "../../src/capture/failureCodes";
import type { InkBboxResult } from "./inkBbox";
import { canonicalStringify } from "../../src/capture/canonicalJson";
import { caseSetManifestSchema, type CaseSetManifest } from "../../src/acceptance/caseSetSchema";
import { CaseSetRepo } from "./caseSets";
import { readArtifact, readRunManifest } from "./evidence";
import type { AcceptanceCaptureService, CandidateSubject, GateResult } from "./gates/types";
import { readinessPolicyHashOf } from "./ids";
import {
  AcceptanceOrchestrator, impactRefreshPlan, requestedRefreshPlan, unionRefreshPlans,
  type RefreshAlgebra,
} from "./orchestrator";
import { ACCEPTANCE_POLICIES, policyProfileHash } from "./policies";
import { AcceptanceRepo, type CandidateRow } from "./repo";
import type { RunProgress } from "./runner";

/**
 * Каскад reuse, алгебра refresh и репро фидбэка 2026-08-04 (план, решение D-B, волна W1).
 *
 * Предмет файла — **поведение рана целиком**: что переиспользуется, что пересчитывается, что
 * пересравнивается и что снимается заново. Ровно здесь живут репро P0-3/P0-4 («поменяли пороги —
 * пересняли всю матрицу») и анти-репро C0 («поменяли эталон — не смейте пересчитывать, мерьте»).
 */

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const COMPONENT_ID = "acc-cascade-probe";
const { PNG } = pngjs;

/** Кадр случая: реальный PNG, позиция прямоугольника выводится из props (см. `runner.test.ts`). */
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

const READY_READINESS = {
  readinessMet: true as boolean | null,
  readinessReason: null as string | null,
  readinessCodes: [] as CaptureCode[] | null,
  readinessPolicyHash: readinessPolicyHashOf(ACCEPTANCE_POLICIES["default-v1"].readiness) as string | null,
  readinessEvidence: {
    fontFaces: [{ family: "Ya Sans", weight: "400", style: "normal", status: "loaded" }],
    images: { total: 1, decoded: 1, failed: 0 },
    pendingRequests: [] as string[],
    framesWaited: 2, animationsDisabled: true,
    themeResources: { tokens: ["--eui-color-bg"], icons: [], images: [] },
  } as Record<string, unknown> | null,
  observedCaptureEnvFingerprint: "env-fingerprint" as string | null,
  observedCaptureEnv: null as Record<string, unknown> | null,
};

const imageBytes = (bytes: Uint8Array): ScreenshotResult => ({
  kind: "image-bytes",
  bytes, width: 10, height: 10, imageProduced: true,
  consoleErrors: [], pageErrors: [], captureClean: true, productErrors: [], infraNoise: [], runtimeWarnings: [],
  rendererBuild: null, browserVersion: "test/1",
  ...READY_READINESS,
});

const PAINT_LAYOUT = { x: 64, y: 64, width: 140, height: 96 };
const paintResult = (bytes: Uint8Array): ScreenshotResult => ({
  kind: "paint", surface: "component", componentId: COMPONENT_ID, draftRev: 1, bundleHash: "bundle",
  designSystemMetaVersion: null, resolvedSpaceScale: {}, viewport: { width: 390, height: 844 }, dpr: 2,
  paintMargin: 64, bytes, width: 536, height: 448, imageProduced: true,
  captureClean: true, productErrors: [], infraNoise: [], runtimeWarnings: [],
  consoleErrors: [], pageErrors: [], rendererBuild: null, browserVersion: "test/1",
  ...READY_READINESS,
  rects: [], truncated: false, total: 0,
  details: [{ key: "root", instance: 0, layoutBounds: { ...PAINT_LAYOUT }, effectSources: [], clipChain: [] }],
} as unknown as ScreenshotResult);

const cleanInk = (): Promise<InkBboxResult> => Promise.resolve({
  ok: true, source: "alpha", image: { width: 536, height: 448 }, deviceScaleFactor: 2,
  pixelBounds: { x: 128, y: 128, width: 280, height: 192 }, bounds: { ...PAINT_LAYOUT },
  clamped: { left: false, right: false, top: false, bottom: false },
});

class FakeCapture implements AcceptanceCaptureService {
  calls: { probe?: CaptureProbe; props?: Record<string, unknown> }[] = [];
  private statuses = new Map<string, JobStatus>();
  private outcomes = new Map<string, JobOutcome>();

  enqueueComponentCandidate(
    _id: string,
    _candidate: { rev: number; sourceHash: string },
    opts: { props?: Record<string, unknown>; probe?: CaptureProbe; viewport: unknown },
  ): Promise<{ jobId: string }> {
    const call = this.calls.length + 1;
    this.calls.push({ probe: opts.probe, props: opts.props });
    const jobId = `job_${call}`;
    const bytes = framePng(opts.props);
    this.statuses.set(jobId, { status: "done", result: opts.probe === "paint" ? paintResult(bytes) : imageBytes(bytes) });
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
}

/**
 * Голова кандидата. `slots`/`namedSlots` — факты, по которым старт рана судит слот-биндинги
 * (план 2026-08-05 §A5): дефолт (пустые слоты, без capability) сохраняет прежнее поведение всех
 * тестов файла байт-в-байт.
 */
const candidateEntry = (options: SlotHead = {}): CandidateEntry => ({
  version: 1, sourceHash: "src-hash", componentIds: [COMPONENT_ID], createdAt: new Date().toISOString(), ok: true,
  extracted: {
    ok: true, warnings: [],
    meta: {
      events: [], slots: options.slots ?? [], description: "probe",
      ...(options.namedSlots === true ? { capabilities: { namedSlots: true } } : {}),
      examples: { alpha: { label: "a" }, beta: { label: "b" } }, propsJsonSchema: { type: "object" },
    },
  } as unknown as CandidateEntry["extracted"],
  parityWarnings: [], bundleHash: "bundle", hostAbiVersion: 4,
});

interface SlotHead { slots?: string[]; namedSlots?: boolean }

async function setup(head: SlotHead = {}) {
  const dir = await mkdtemp(resolve(process.cwd(), ".acc-cascade-test-"));
  dirs.push(dir);
  const db = new Database(":memory:");
  migrate(db);
  db.run("INSERT INTO components (id,name,head_rev,created_at,updated_at,design_system) VALUES (?,?,1,'now','now','yandex-pay')", [COMPONENT_ID, "AccCascadeProbe"]);
  const repo = new AcceptanceRepo(db);
  const { candidate } = repo.createCandidate({
    componentId: COMPONENT_ID, designSystem: "yandex-pay", rev: 1, sourceHash: "src-hash", bundleHash: "bundle",
    hostAbiVersion: 4, themeVersion: 1, observedCatalogRevision: "cat",
    policyProfileHash: policyProfileHash(ACCEPTANCE_POLICIES["default-v1"]), createdBy: "user_a",
  });
  const entry = candidateEntry(head);
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

type Harness = Awaited<ReturnType<typeof setup>>;

const sha256Of = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

async function putAsset(harness: Harness, bytes: Uint8Array): Promise<string> {
  const sha = sha256Of(bytes);
  await mkdir(resolve(harness.dir, "assets"), { recursive: true });
  await writeFile(resolve(harness.dir, "assets", sha), bytes);
  harness.db.run(
    "INSERT OR IGNORE INTO assets (id,sha256,mime,size,width,height,original_name,created_at) VALUES (?,?,?,?,?,?,?,?)",
    [`asset_${sha}`, sha, "image/png", bytes.byteLength, 24, 20, "reference.png", new Date().toISOString()],
  );
  return `asset_${sha}`;
}

interface CaseSpec {
  id: string;
  props: Record<string, unknown>;
  referenceAssetId: string;
  maxRawDiffPct?: number;
  expectedGeometry?: { width: number; height: number };
  cropLineage?: { rect: [number, number, number, number] };
}

/** Манифест набора: `requireVisual` делает визуальный гейт обязательным (иначе пороги ни на что не влияют). */
function manifestOf(cases: CaseSpec[]): CaseSetManifest {
  const perCase = Object.fromEntries(cases
    .filter((item) => item.maxRawDiffPct !== undefined)
    .map((item) => [item.id, { maxRawDiffPct: item.maxRawDiffPct! }]));
  return caseSetManifestSchema.parse({
    manifestVersion: 1,
    componentId: COMPONENT_ID,
    capture: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, theme: "light" },
    requireVisual: true,
    ...(Object.keys(perCase).length > 0 ? { policy: { perCase } } : {}),
    cases: cases.map((item) => ({
      id: item.id,
      props: item.props,
      referenceAssetId: item.referenceAssetId,
      ...(item.expectedGeometry ? { expectedGeometry: item.expectedGeometry } : {}),
      ...(item.cropLineage ? { cropLineage: item.cropLineage } : {}),
    })),
  });
}

interface RunOptions {
  refresh?: "none" | "failed" | "all" | { caseIds: string[] };
  baselineRunId?: string;
  recapture?: boolean;
  policyId?: string;
}

async function runWith(harness: Harness, manifest: CaseSetManifest, options: RunOptions = {}) {
  const { row } = new CaseSetRepo(harness.db).put({
    componentId: COMPONENT_ID, designSystem: "yandex-pay", manifest, createdBy: "user_a",
  });
  const started = await harness.orchestrator.startRun({
    candidateId: harness.candidateId, createdBy: "user_a", caseSetId: row.case_set_id,
    ...(options.policyId ? { policyId: options.policyId } : {}),
    ...(options.refresh ? { refresh: options.refresh } : {}),
    ...(options.recapture ? { recapture: options.recapture } : {}),
    ...(options.baselineRunId ? { baselineRunId: options.baselineRunId } : {}),
  });
  const run = await harness.orchestrator.executeRun(started.run.run_id);
  return { started, run };
}

const reuseReasons = (harness: Harness, runId: string): Record<string, string | null> =>
  Object.fromEntries(harness.repo.cases(runId).map((row) => [row.case_id, row.reuse_reason]));

const progressOfRun = (run: { progress_json: string }): RunProgress =>
  JSON.parse(run.progress_json) as RunProgress;

const gatesOfCase = (harness: Harness, runId: string, caseId: string): GateResult[] =>
  JSON.parse(harness.repo.cases(runId).find((row) => row.case_id === caseId)!.gates_json!) as GateResult[];

// ---------------------------------------------------------- алгебра refresh

test("алгебра refresh: --refresh failed — verdict-скоуп, --recapture поднимает его до кадра", () => {
  expect(requestedRefreshPlan("failed")).toEqual({
    frame: { all: false, failed: false, caseIds: [] },
    verdict: { all: false, failed: true, caseIds: [] },
  });
  expect(requestedRefreshPlan("failed", true).frame.failed).toBe(true);
  expect(requestedRefreshPlan("all").frame.all).toBe(true);
  expect(requestedRefreshPlan({ caseIds: ["b", "a", "a"] }).frame.caseIds).toEqual(["a", "b"]);

  // Объединение покомпонентное: скоупы не схлопываются друг в друга.
  const union = unionRefreshPlans(requestedRefreshPlan("failed"), impactRefreshPlan({
    basis: "asset-only", candidateId: "c", baselineRunId: "r", baselineCandidateId: "b",
    changedAssets: [], changedTokens: [], affectedCases: ["alpha"], unaffectedCases: ["beta"],
    recaptureCount: 1, reason: "",
  }));
  expect(union.verdict.failed).toBe(true);
  expect(union.frame.caseIds).toEqual(["alpha"]);
});

test("тройка refresh персистится и отдаётся на постановке", async () => {
  const harness = await setup();
  const reference = await putAsset(harness, framePng({ label: "a" }));
  const manifest = manifestOf([{ id: "alpha", props: { label: "a" }, referenceAssetId: reference }]);
  const { started, run } = await runWith(harness, manifest, { refresh: "failed" });
  expect(started.refresh.requested.verdict.failed).toBe(true);
  expect(started.refresh.effective.verdict.failed).toBe(true);
  const stored = JSON.parse(harness.repo.requireRun(run.run_id).refresh_json!) as RefreshAlgebra;
  expect(stored.effective.verdict.failed).toBe(true);
  harness.db.close();
});

// ------------------------------------------------------- репро фидбэка P0-3

test("репро фидбэка: смена только порогов + --refresh failed --baseline-run ⇒ кадры переиспользованы, recapture = 0", async () => {
  const harness = await setup();
  // alpha: эталон сдвинут на 6px ⇒ ~25% расхождения. beta: эталон точный ⇒ 0%.
  const shifted = await putAsset(harness, framePng({ label: "a" }, 6));
  const exact = await putAsset(harness, framePng({ label: "b" }));
  const strict = manifestOf([
    { id: "alpha", props: { label: "a" }, referenceAssetId: shifted, maxRawDiffPct: 10 },
    { id: "beta", props: { label: "b" }, referenceAssetId: exact },
  ]);
  const baseline = await runWith(harness, strict);
  expect(baseline.run.status).toBe("fail");
  expect(harness.repo.cases(baseline.run.run_id).find((row) => row.case_id === "alpha")!.verdict).toBe("fail");
  const capturedBefore = harness.service.calls.length;

  // Второй ран отличается **ровно одним числом** — порогом упавшего случая.
  const relaxed = manifestOf([
    { id: "alpha", props: { label: "a" }, referenceAssetId: shifted, maxRawDiffPct: 50 },
    { id: "beta", props: { label: "b" }, referenceAssetId: exact },
  ]);
  const second = await runWith(harness, relaxed, { refresh: "failed", baselineRunId: baseline.run.run_id });

  expect(second.run.status).toBe("pass");
  // Главный AC фидбэка: ни одной новой съёмки.
  expect(harness.service.calls.length).toBe(capturedBefore);
  const progress = progressOfRun(second.run);
  expect(progress.frameReused).toBe(2);
  expect(progress.verdictRecomputed).toBeGreaterThan(0);
  expect(progress.rediffed).toBe(0);
  expect(reuseReasons(harness, second.run.run_id).alpha).toBe("recompute:policy");
  // Вердикт пересчитан честно: 25% теперь укладывается в 50%.
  const visual = gatesOfCase(harness, second.run.run_id, "alpha").find((gate) => gate.gate === "visual")!;
  expect(visual.status).toBe("pass");
  expect(visual.metrics).toMatchObject({ maxRawDiffPct: 50 });
  harness.db.close();
});

test("ужесточение порога роняет случай без пересъёмки — пересчёт работает в обе стороны", async () => {
  const harness = await setup();
  const shifted = await putAsset(harness, framePng({ label: "a" }, 6));
  const loose = manifestOf([{ id: "alpha", props: { label: "a" }, referenceAssetId: shifted, maxRawDiffPct: 50 }]);
  const first = await runWith(harness, loose);
  expect(first.run.status).toBe("pass");
  const capturedBefore = harness.service.calls.length;

  const tight = manifestOf([{ id: "alpha", props: { label: "a" }, referenceAssetId: shifted, maxRawDiffPct: 1 }]);
  const second = await runWith(harness, tight);
  expect(second.run.status).toBe("fail");
  expect(harness.service.calls.length).toBe(capturedBefore);
  expect(reuseReasons(harness, second.run.run_id).alpha).toBe("recompute:policy");
  harness.db.close();
});

test("манифест evidence и пересчитанный visual.json говорят одно и то же (C2)", async () => {
  const harness = await setup();
  const shifted = await putAsset(harness, framePng({ label: "a" }, 6));
  await runWith(harness, manifestOf([{ id: "alpha", props: { label: "a" }, referenceAssetId: shifted, maxRawDiffPct: 50 }]));
  const second = await runWith(harness, manifestOf([{ id: "alpha", props: { label: "a" }, referenceAssetId: shifted, maxRawDiffPct: 1 }]));

  const manifest = await readRunManifest(harness.dir, second.run.run_id);
  const entry = manifest!.cases.find((item) => item.caseId === "alpha")!;
  expect(entry.verdict).toBe("fail");
  const visualJson = entry.artifacts.find((item) => item.name === "visual.json")!;
  const record = JSON.parse(new TextDecoder().decode((await readArtifact(harness.dir, visualJson.sha256))!)) as Record<string, unknown>;
  // Артефакт, на который ссылается манифест, обязан нести **новый** вердикт и происхождение.
  expect(record).toMatchObject({ verdict: "fail", maxRawDiffPct: 1, recomputed: true });
  expect(String(record.derivedFrom)).toMatch(/^[0-9a-f]{64}$/);
  harness.db.close();
});

// ------------------------------------------------------- анти-репро C0/D1

test("анти-репро: смена только эталона ⇒ re-diff, а не пересчёт по старым метрикам", async () => {
  const harness = await setup();
  const exact = await putAsset(harness, framePng({ label: "a" }));
  const first = await runWith(harness, manifestOf([{ id: "alpha", props: { label: "a" }, referenceAssetId: exact }]));
  expect(first.run.status).toBe("pass");
  const capturedBefore = harness.service.calls.length;

  const shifted = await putAsset(harness, framePng({ label: "a" }, 6));
  const second = await runWith(harness, manifestOf([{ id: "alpha", props: { label: "a" }, referenceAssetId: shifted }]));

  // Кадр не переснимался — но метрики **измерены заново**, а не пересчитаны: новый эталон.
  expect(harness.service.calls.length).toBe(capturedBefore);
  expect(reuseReasons(harness, second.run.run_id).alpha).toBe("rediff:comparison");
  const progress = progressOfRun(second.run);
  expect(progress).toMatchObject({ reused: 0, frameReused: 1, rediffed: 1, verdictRecomputed: 0 });
  const visual = gatesOfCase(harness, second.run.run_id, "alpha").find((gate) => gate.gate === "visual")!;
  expect(visual.status).toBe("fail");
  expect(visual.metrics).toMatchObject({ referenceAssetId: shifted });
  expect((visual.metrics as { rawDiffPct: number }).rawDiffPct).toBeGreaterThan(0);
  expect(second.run.status).toBe("fail");
  harness.db.close();
});

test("анти-репро: смена только expectedGeometry ⇒ re-diff (визуал пересчёту не подлежит, D1)", async () => {
  const harness = await setup();
  const exact = await putAsset(harness, framePng({ label: "a" }));
  const first = await runWith(harness, manifestOf([
    { id: "alpha", props: { label: "a" }, referenceAssetId: exact, expectedGeometry: { width: 140, height: 96 } },
  ]));
  expect(first.run.status).toBe("pass");
  const capturedBefore = harness.service.calls.length;

  const second = await runWith(harness, manifestOf([
    { id: "alpha", props: { label: "a" }, referenceAssetId: exact, expectedGeometry: { width: 200, height: 96 } },
  ]));
  expect(harness.service.calls.length).toBe(capturedBefore);
  expect(reuseReasons(harness, second.run.run_id).alpha).toBe("rediff:comparison");
  // Геометрия пересчитана от сырых контуров и назвала расхождение с новым заявленным размером.
  const geometry = gatesOfCase(harness, second.run.run_id, "alpha").find((gate) => gate.gate === "geometry")!;
  expect(geometry.status).toBe("fail");
  expect(geometry.metrics!.expectedGeometryDelta).toMatchObject({ widthDelta: -60 });
  expect(second.run.status).toBe("fail");
  harness.db.close();
});

test("анти-репро: смена только cropLineage.rect ⇒ re-diff", async () => {
  const harness = await setup();
  const exact = await putAsset(harness, framePng({ label: "a" }));
  await runWith(harness, manifestOf([
    { id: "alpha", props: { label: "a" }, referenceAssetId: exact, cropLineage: { rect: [0, 0, 24, 20] } },
  ]));
  const capturedBefore = harness.service.calls.length;
  const second = await runWith(harness, manifestOf([
    { id: "alpha", props: { label: "a" }, referenceAssetId: exact, cropLineage: { rect: [0, 0, 24, 16] } },
  ]));
  expect(harness.service.calls.length).toBe(capturedBefore);
  expect(reuseReasons(harness, second.run.run_id).alpha).toBe("rediff:comparison");
  harness.db.close();
});

// ------------------------------------------- отказы каскада (D0/D14/D17)

test("recompute без снимка политики ⇒ пересъёмка, никогда перенос (D0)", async () => {
  const harness = await setup();
  const shifted = await putAsset(harness, framePng({ label: "a" }, 6));
  await runWith(harness, manifestOf([{ id: "alpha", props: { label: "a" }, referenceAssetId: shifted, maxRawDiffPct: 50 }]));
  // Строка кэша без снимка — ровно то, что оставляет откат образа или ручная правка БД.
  harness.db.run("UPDATE acceptance_case_results SET verdict_policy_json=NULL");
  const capturedBefore = harness.service.calls.length;

  const second = await runWith(harness, manifestOf([{ id: "alpha", props: { label: "a" }, referenceAssetId: shifted, maxRawDiffPct: 1 }]));
  expect(harness.service.calls.length).toBeGreaterThan(capturedBefore);
  expect(reuseReasons(harness, second.run.run_id).alpha).toBe("recapture:policy_snapshot_missing");
  expect(second.run.status).toBe("fail");
  harness.db.close();
});

test("legacy-строка с NULL-слоями не участвует ни в пересчёте, ни в re-diff (D17)", async () => {
  const harness = await setup();
  const shifted = await putAsset(harness, framePng({ label: "a" }, 6));
  await runWith(harness, manifestOf([{ id: "alpha", props: { label: "a" }, referenceAssetId: shifted, maxRawDiffPct: 50 }]));
  // Форма строки до миграции v29: плоский `case_fingerprint`, слоёв нет.
  harness.db.run("UPDATE acceptance_case_results SET frame_fingerprint=NULL, comparison_fingerprint=NULL, verdict_policy_hash=NULL, verdict_policy_json=NULL");
  const capturedBefore = harness.service.calls.length;

  const second = await runWith(harness, manifestOf([{ id: "alpha", props: { label: "a" }, referenceAssetId: shifted, maxRawDiffPct: 1 }]));
  expect(harness.service.calls.length).toBeGreaterThan(capturedBefore);
  expect(reuseReasons(harness, second.run.run_id).alpha).toBeNull();
  harness.db.close();
});

test("kill-switch выключает и пересчёт, и re-diff: любой промах уводит в пересъёмку (D8)", async () => {
  const harness = await setup();
  const shifted = await putAsset(harness, framePng({ label: "a" }, 6));
  await runWith(harness, manifestOf([{ id: "alpha", props: { label: "a" }, referenceAssetId: shifted, maxRawDiffPct: 50 }]));
  const capturedBefore = harness.service.calls.length;

  process.env.EASYUI_ACCEPTANCE_VERDICT_RECOMPUTE = "0";
  try {
    const second = await runWith(harness, manifestOf([{ id: "alpha", props: { label: "a" }, referenceAssetId: shifted, maxRawDiffPct: 1 }]));
    expect(harness.service.calls.length).toBeGreaterThan(capturedBefore);
    expect(reuseReasons(harness, second.run.run_id).alpha).toBeNull();
  } finally {
    delete process.env.EASYUI_ACCEPTANCE_VERDICT_RECOMPUTE;
  }
  harness.db.close();
});

// ------------------------------------------------ refresh_scope_empty (C10)

test("первый ран с --refresh failed и пустым кэшем проходит: reuse не было вовсе", async () => {
  const harness = await setup();
  const exact = await putAsset(harness, framePng({ label: "a" }));
  const { run } = await runWith(harness, manifestOf([{ id: "alpha", props: { label: "a" }, referenceAssetId: exact }]), { refresh: "failed" });
  expect(run.status).toBe("pass");
  expect(run.status_reason).toBeNull();
  harness.db.close();
});

test("форс, который ничего не переоценил, роняет ран в error со статусом refresh_scope_empty (D2)", async () => {
  const harness = await setup();
  const exact = await putAsset(harness, framePng({ label: "a" }));
  const manifest = manifestOf([{ id: "alpha", props: { label: "a" }, referenceAssetId: exact }]);
  expect((await runWith(harness, manifest)).run.status).toBe("pass");

  // Ничего не падало и ничего не менялось: `--refresh failed` не имеет предмета работы. Молчаливый
  // `pass` здесь соврал бы про то, что приёмка что-то проверила.
  const second = await runWith(harness, manifest, { refresh: "failed" });
  expect(second.run.status).toBe("error");
  expect(second.run.status_reason).toBe("refresh_scope_empty");
  harness.db.close();
});

test("смена порога + --refresh failed без baseline-run даёт непустой effective (C19)", async () => {
  const harness = await setup();
  const shifted = await putAsset(harness, framePng({ label: "a" }, 6));
  const first = await runWith(harness, manifestOf([{ id: "alpha", props: { label: "a" }, referenceAssetId: shifted, maxRawDiffPct: 1 }]));
  expect(first.run.status).toBe("fail");
  const capturedBefore = harness.service.calls.length;

  // Без baseline-рана форс опирается на frame-lookup: кадровый слой переживает смену порога,
  // поэтому «этот случай падал» по-прежнему известно (раньше форс здесь молча снимался).
  const second = await runWith(harness, manifestOf([{ id: "alpha", props: { label: "a" }, referenceAssetId: shifted, maxRawDiffPct: 50 }]), { refresh: "failed" });
  expect(second.started.refresh.effective.verdict.failed).toBe(true);
  expect(second.run.status).toBe("pass");
  expect(harness.service.calls.length).toBe(capturedBefore);
  expect(reuseReasons(harness, second.run.run_id).alpha).toBe("recompute:policy");
  harness.db.close();
});

test("--recapture поднимает failed до кадрового скоупа: кадр снимается заново", async () => {
  const harness = await setup();
  const shifted = await putAsset(harness, framePng({ label: "a" }, 6));
  const first = await runWith(harness, manifestOf([{ id: "alpha", props: { label: "a" }, referenceAssetId: shifted, maxRawDiffPct: 1 }]));
  expect(first.run.status).toBe("fail");
  const capturedBefore = harness.service.calls.length;

  const second = await runWith(harness, manifestOf([{ id: "alpha", props: { label: "a" }, referenceAssetId: shifted, maxRawDiffPct: 1 }]), {
    refresh: "failed", recapture: true,
  });
  expect(harness.service.calls.length).toBeGreaterThan(capturedBefore);
  expect(reuseReasons(harness, second.run.run_id).alpha).toBe("refresh:failed");
  harness.db.close();
});

test("verdict-скоуп без дельты эскалируется до пересъёмки: флейк-ретрай не потерян (D4)", async () => {
  const harness = await setup();
  const shifted = await putAsset(harness, framePng({ label: "a" }, 6));
  const manifest = manifestOf([{ id: "alpha", props: { label: "a" }, referenceAssetId: shifted, maxRawDiffPct: 1 }]);
  const first = await runWith(harness, manifest);
  expect(first.run.status).toBe("fail");
  const capturedBefore = harness.service.calls.length;

  // Ни политика, ни эталон не менялись — пересчитывать нечего, и `--refresh failed` обязан
  // остаться тем, чем был: пересъёмкой упавшего случая.
  const second = await runWith(harness, manifest, { refresh: "failed" });
  expect(harness.service.calls.length).toBeGreaterThan(capturedBefore);
  expect(reuseReasons(harness, second.run.run_id).alpha).toBe("refresh:failed");
  harness.db.close();
});

// ------------------------------------------------------ отпечатки и квитанции

test("case_fingerprint строки рана совпадает с отпечатком строки результата (D7)", async () => {
  const harness = await setup();
  const exact = await putAsset(harness, framePng({ label: "a" }));
  const { run } = await runWith(harness, manifestOf([{ id: "alpha", props: { label: "a" }, referenceAssetId: exact }]));
  const row = harness.repo.cases(run.run_id)[0]!;
  const result = harness.repo.caseResult(row.case_fingerprint);
  // Постановка и раннер считают отпечатки одной функцией: расхождение означало бы, что reuse
  // промахивается всегда, а `acceptance_cases` описывает не тот случай, который сняли.
  expect(result).toBeDefined();
  expect(result!.frame_fingerprint).toBe(row.frame_fingerprint);
  expect(result!.comparison_fingerprint).toBe(row.comparison_fingerprint);
  expect(result!.verdict_policy_hash).toBe(row.verdict_policy_hash);
  expect(row.frame_fingerprint).toMatch(/^[0-9a-f]{64}$/);
  harness.db.close();
});

test("квитанция reuse пишется на каждый случай в форме W8", async () => {
  const harness = await setup();
  const exact = await putAsset(harness, framePng({ label: "a" }));
  const manifest = manifestOf([{ id: "alpha", props: { label: "a" }, referenceAssetId: exact }]);
  await runWith(harness, manifest);
  const { run } = await runWith(harness, manifest);
  const receipt = JSON.parse(harness.repo.cases(run.run_id)[0]!.reuse_receipt_json!) as {
    reuse: Record<string, boolean>; fingerprints: Record<string, string | null>;
  };
  expect(receipt.reuse).toMatchObject({ frame: true, verdict: true });
  expect(receipt.fingerprints.frame).toMatch(/^[0-9a-f]{64}$/);
  expect(receipt.fingerprints.case).toBe(harness.repo.cases(run.run_id)[0]!.case_fingerprint);
  harness.db.close();
});

// ------------------------------------------- слот-биндинги: старт рана и реконструкция (§A5)

/**
 * Опубликованный ребёнок слота: строка каталога + ревизия + публикация. Ровно эти три таблицы
 * читает `publishedPinByNameAndVersion`, и ДС берётся у **ревизии**.
 */
function seedChild(harness: Harness, input: { id: string; name: string; version?: number; status?: string }): void {
  const version = input.version ?? 1;
  if (!harness.db.query("SELECT 1 ok FROM components WHERE id=?").get(input.id)) {
    harness.db.run("INSERT INTO components (id,name,head_rev,design_system,deleted_at,created_at,updated_at) VALUES (?,?,?,'yandex-pay',NULL,'now','now')",
      [input.id, input.name, version]);
  }
  harness.db.run("INSERT INTO component_revisions (component_id,rev,source,design_system,message,created_at) VALUES (?,?,'src','yandex-pay',NULL,'now')",
    [input.id, version]);
  harness.db.run(`INSERT INTO component_publishes
    (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,message,published_at)
    VALUES (?,?,?,?,'js','{}',?,?,4,NULL,'now')`,
    [input.id, version, version, input.status ?? "active", `sh-${input.id}-${version}`, `bh-${input.id}-${version}`]);
}

/** Манифест со слот-биндингами: без эталонов и без `requireVisual` — предмет тестов здесь набор, а не пиксели. */
function slotManifest(cases: { id: string; props: Record<string, unknown>; slotBindings?: Record<string, { type: string; version: number; props?: Record<string, unknown> }[]> }[]): CaseSetManifest {
  return caseSetManifestSchema.parse({
    manifestVersion: 1,
    componentId: COMPONENT_ID,
    capture: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, theme: "light" },
    cases,
  });
}

const putSet = (harness: Harness, manifest: CaseSetManifest): string =>
  new CaseSetRepo(harness.db).put({ componentId: COMPONENT_ID, designSystem: "yandex-pay", manifest, createdBy: "user_a" }).row.case_set_id;

const startFailure = async (harness: Harness, manifest: CaseSetManifest): Promise<ApiError> => {
  const error = await harness.orchestrator.startRun({
    candidateId: harness.candidateId, createdBy: "user_a", caseSetId: putSet(harness, manifest),
  }).then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
};

/** Стирание набора из памяти процесса — симуляция рестарта: набор придётся восстановить из манифеста. */
const forgetCases = (harness: Harness, runId: string): void => {
  (harness.orchestrator as unknown as { caseSets: Map<string, unknown> }).caseSets.delete(runId);
  (harness.orchestrator as unknown as { surfaces: Map<string, unknown> }).surfaces.delete(runId);
};

test("старт рана отказывает по фактам головы кандидата: slot_unknown и slot_bindings_unsupported", async () => {
  // Кандидат объявляет `items`, манифест биндит `extra` — при PUT это был warning (голова могла
  // поменяться), на старте рана голова зафиксирована, и снимать пустой слот нельзя.
  const known = await setup({ slots: ["items"], namedSlots: true });
  seedChild(known, { id: "pay-child", name: "PayChild" });
  const unknownSlot = await startFailure(known, slotManifest([
    { id: "alpha", props: { label: "a" }, slotBindings: { extra: [{ type: "PayChild", version: 1 }] } },
  ]));
  expect(unknownSlot.code).toBe("slot_unknown");
  expect(unknownSlot.status).toBe(422);
  known.db.close();

  // Тот же манифест против кандидата без `capabilities.namedSlots` — другой отказ: именованные
  // слоты компонент не поддерживает вовсе, и предлагать «объяви слот» бессмысленно.
  const incapable = await setup({ slots: ["items"] });
  seedChild(incapable, { id: "pay-child", name: "PayChild" });
  const unsupported = await startFailure(incapable, slotManifest([
    { id: "alpha", props: { label: "a" }, slotBindings: { items: [{ type: "PayChild", version: 1 }] } },
  ]));
  expect(unsupported.code).toBe("slot_bindings_unsupported");

  // Дефолтный слот (§A2a) из обеих проверок исключён: он неявный, его не объявляет никто.
  const started = await incapable.orchestrator.startRun({
    candidateId: incapable.candidateId, createdBy: "user_a",
    caseSetId: putSet(incapable, slotManifest([
      { id: "alpha", props: { label: "a" }, slotBindings: { default: [{ type: "PayChild", version: 1 }] } },
    ])),
  });
  expect(started.cases[0]!.slotBindings).toHaveLength(1);
  expect(started.cases[0]!.slotBindings![0]).toMatchObject({ slot: "default", index: 0, name: "PayChild", bundleHash: "bh-pay-child-1" });
  incapable.db.close();
});

test("старт рана отказывает по нерендерабельному статусу пина (slot_component_not_published)", async () => {
  const harness = await setup({ slots: ["items"], namedSlots: true });
  seedChild(harness, { id: "pay-child", name: "PayChild", status: "archived" });
  const refusal = await startFailure(harness, slotManifest([
    { id: "alpha", props: { label: "a" }, slotBindings: { items: [{ type: "PayChild", version: 1 }] } },
  ]));
  expect(refusal.code).toBe("slot_component_not_published");
  expect(refusal.message).toContain("archived");
  harness.db.close();
});

test("два случая с одинаковыми props и разными слотами — два кадра с разными отпечатками (репро SMS)", async () => {
  const harness = await setup({ slots: ["items"], namedSlots: true });
  seedChild(harness, { id: "pay-child", name: "PayChild" });
  const manifest = slotManifest([
    { id: "one-message", props: { label: "a" }, slotBindings: { items: [{ type: "PayChild", version: 1, props: { text: "one" } }] } },
    { id: "two-messages", props: { label: "a" }, slotBindings: { items: [{ type: "PayChild", version: 1, props: { text: "one" } }, { type: "PayChild", version: 1, props: { text: "two" } }] } },
  ]);
  const started = await harness.orchestrator.startRun({
    candidateId: harness.candidateId, createdBy: "user_a", caseSetId: putSet(harness, manifest),
  });
  await harness.orchestrator.executeRun(started.run.run_id);

  const rows = harness.repo.cases(started.run.run_id);
  expect(rows).toHaveLength(2);
  // Ни один не схлопнулся в алиас: props одинаковые, но кадр — разный.
  expect(rows.every((row) => row.alias_of_case_id === null)).toBe(true);
  expect(rows[0]!.props_hash).toBe(rows[1]!.props_hash);
  expect(rows[0]!.frame_fingerprint).not.toBe(rows[1]!.frame_fingerprint);
  expect(rows[0]!.slots_hash).not.toBe(rows[1]!.slots_hash);
  expect(rows[0]!.slots_hash).toMatch(/^[0-9a-f]{64}$/);
  harness.db.close();
});

test("реконструкция набора после рестарта даёт тот же frame_fingerprint, что персистирован", async () => {
  const harness = await setup({ slots: ["items"], namedSlots: true });
  seedChild(harness, { id: "pay-child", name: "PayChild" });
  const started = await harness.orchestrator.startRun({
    candidateId: harness.candidateId, createdBy: "user_a",
    caseSetId: putSet(harness, slotManifest([
      { id: "alpha", props: { label: "a" }, slotBindings: { items: [{ type: "PayChild", version: 1, props: { text: "one" } }] } },
    ])),
  });
  const persisted = harness.repo.cases(started.run.run_id)[0]!;

  // Память процесса потеряна — набор восстанавливается из durable-манифеста вместе с пинами.
  forgetCases(harness, started.run.run_id);
  const run = await harness.orchestrator.executeRun(started.run.run_id);
  expect(run.status_reason).toBeNull();
  const result = harness.repo.caseResult(persisted.case_fingerprint);
  // Пересчитанный кадр обязан совпасть с персистированным: иначе восстановленный ран снимал бы
  // не тот случай, что описан в `acceptance_cases`, и reuse промахивался бы всегда.
  expect(result).toBeDefined();
  expect(result!.frame_fingerprint).toBe(persisted.frame_fingerprint);
  harness.db.close();
});

test("ребёнок заархивирован и удалён посреди рана — реконструкция всё равно строит тот же набор", async () => {
  const harness = await setup({ slots: ["items"], namedSlots: true });
  seedChild(harness, { id: "pay-child", name: "PayChild" });
  const started = await harness.orchestrator.startRun({
    candidateId: harness.candidateId, createdBy: "user_a",
    caseSetId: putSet(harness, slotManifest([
      { id: "alpha", props: { label: "a" }, slotBindings: { items: [{ type: "PayChild", version: 1 }] } },
    ])),
  });
  const persisted = harness.repo.cases(started.run.run_id)[0]!;

  // Статус и надгробие меняются **после** постановки: пины уже авторизованы, и режим
  // `"reconstruction"` слеп к обоим — иначе отпечатки уехали бы у уже созданных строк.
  harness.db.run("UPDATE component_publishes SET status='archived' WHERE component_id='pay-child'");
  harness.db.run("UPDATE components SET deleted_at='now' WHERE id='pay-child'");
  forgetCases(harness, started.run.run_id);
  const run = await harness.orchestrator.executeRun(started.run.run_id);

  expect(run.status_reason).toBeNull();
  expect(run.status).not.toBe("error");
  expect(harness.repo.caseResult(persisted.case_fingerprint)!.frame_fingerprint).toBe(persisted.frame_fingerprint);
  harness.db.close();
});

test("реконструкция отказывает названной причиной, когда строки публикации нет физически", async () => {
  const harness = await setup({ slots: ["items"], namedSlots: true });
  seedChild(harness, { id: "pay-child", name: "PayChild" });
  const started = await harness.orchestrator.startRun({
    candidateId: harness.candidateId, createdBy: "user_a",
    caseSetId: putSet(harness, slotManifest([
      { id: "alpha", props: { label: "a" }, slotBindings: { items: [{ type: "PayChild", version: 1 }] } },
    ])),
  });
  // Строки публикаций не удаляются (v8-rebuild только копирует) — отказ оборонительный, но он
  // обязан быть **названным**: «набор рана больше не восстановим» читается из `status_reason`.
  harness.db.run("DELETE FROM component_publishes WHERE component_id='pay-child'");
  forgetCases(harness, started.run.run_id);
  const run = await harness.orchestrator.executeRun(started.run.run_id);
  expect(run.status).toBe("error");
  expect(run.status_reason).toBe("slot_component_not_published");
  harness.db.close();
});

test("названный отказ постановки капчур-джобы доезжает до гейта случая, а не маскируется (v3.1 F3)", async () => {
  const harness = await setup({ slots: ["items"], namedSlots: true });
  seedChild(harness, { id: "pay-child", name: "PayChild" });
  const started = await harness.orchestrator.startRun({
    candidateId: harness.candidateId, createdBy: "user_a",
    caseSetId: putSet(harness, slotManifest([
      { id: "alpha", props: { label: "a" }, slotBindings: { items: [{ type: "PayChild", version: 1 }] } },
    ])),
  });
  // Съёмка архивированного ребёнка невозможна (`ComponentRepo.bundle` не отдаёт нерендерабельные
  // статусы): доменный отказ постановки джобы не ретраится и обязан стать **продуктовым**
  // провалом случая с читаемой причиной, а не инфраструктурным `error` без имени.
  harness.service.enqueueComponentCandidate = () => Promise.reject(new ApiError(422, "slot_component_not_published",
    "Slot child PayChild v1 is not published in a renderable status"));
  const run = await harness.orchestrator.executeRun(started.run.run_id);
  expect(run.status).toBe("fail");
  const details = gatesOfCase(harness, run.run_id, "alpha").map((gate) => gate.detail ?? "").join("\n");
  expect(details).toContain("PayChild");
  harness.db.close();
});

// ------------------------------------------------ evidence-манифест слот-рана (§A7, T3.3)

/**
 * Нормализация манифеста под golden: значения, уникальные для запуска (идентификаторы рана и
 * кандидата, времена, sha-адреса CAS), заменяются заглушками. Предмет сверки — **форма и значения
 * манифеста**, а не uuid'ы харнесса; всё, что осталось после нормализации, обязано быть стабильным.
 */
const normalizeManifest = (value: unknown): unknown => {
  if (typeof value === "string") {
    if (/^[0-9a-f]{64}$/.test(value)) return "<sha256>";
    if (/^(acc|cand)_/.test(value)) return "<id>";
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return "<ts>";
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeManifest);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, normalizeManifest(item)]));
  }
  return value;
};

const manifestShapeHash = (manifest: unknown): string =>
  new Bun.CryptoHasher("sha256").update(canonicalStringify(normalizeManifest(manifest))).digest("hex");

/**
 * **Golden slot-free манифеста** (§A7, test-first): снят на неизменённом коде ДО того, как
 * `manifestOf` научился писать `slotBindings`/`slotsHash`. Оба поля пишутся условным спредом,
 * поэтому у рана без слотов манифест обязан остаться прежним побайтово: `evidence_manifest_hash`
 * связан промоутом (`promote.ts:239`), и сдвиг формы обесценил бы уже принятые раны.
 */
const GOLDEN_SLOT_FREE_MANIFEST_SHAPE = "3001649a187ebe57a4103f21783604c86770f5dea00455ec976f3ecc0bf45a95";

test("evidence-манифест slot-free рана не меняется от появления слот-полей (golden §A7)", async () => {
  const harness = await setup();
  const reference = await putAsset(harness, framePng({ label: "a" }));
  const { run } = await runWith(harness, manifestOf([{ id: "alpha", props: { label: "a" }, referenceAssetId: reference }]));
  const manifest = (await readRunManifest(harness.dir, run.run_id))!;

  expect(manifest.cases[0]!.slotBindings).toBeUndefined();
  expect(manifest.cases[0]!.slotsHash).toBeUndefined();
  expect(Object.keys(manifest.cases[0]!)).not.toContain("slotBindings");
  expect(manifestShapeHash(manifest)).toBe(GOLDEN_SLOT_FREE_MANIFEST_SHAPE);
  harness.db.close();
});

test("evidence-манифест слот-рана несёт разрешённое дерево слотов и slotsHash случая", async () => {
  const harness = await setup({ slots: ["items"], namedSlots: true });
  seedChild(harness, { id: "pay-child", name: "PayChild" });
  const started = await harness.orchestrator.startRun({
    candidateId: harness.candidateId, createdBy: "user_a",
    caseSetId: putSet(harness, slotManifest([
      {
        id: "alpha",
        props: { label: "a" },
        slotBindings: {
          items: [{ type: "PayChild", version: 1, props: { text: "one" } }, { type: "PayChild", version: 1, props: { text: "two" } }],
          default: [{ type: "PayChild", version: 1 }],
        },
      },
    ])),
  });
  const run = await harness.orchestrator.executeRun(started.run.run_id);
  const manifest = (await readRunManifest(harness.dir, run.run_id))!;
  const entry = manifest.cases.find((item) => item.caseId === "alpha")!;

  // Плоский кортеж отпечатка сгруппирован по слотам, порядок детей — порядок рендера.
  expect(entry.slotBindings).toEqual([
    {
      slot: "items",
      children: [
        { componentId: "pay-child", name: "PayChild", version: 1, bundleHash: "bh-pay-child-1", props: { text: "one" }, propsHash: expect.any(String) },
        { componentId: "pay-child", name: "PayChild", version: 1, bundleHash: "bh-pay-child-1", props: { text: "two" }, propsHash: expect.any(String) },
      ],
    },
    {
      slot: "default",
      children: [
        { componentId: "pay-child", name: "PayChild", version: 1, bundleHash: "bh-pay-child-1", props: {}, propsHash: expect.any(String) },
      ],
    },
  ]);
  expect(entry.slotBindings![0]!.children[0]!.propsHash).not.toBe(entry.slotBindings![0]!.children[1]!.propsHash);
  // Один и тот же `slots_hash` в строке случая и в доказательстве: сверять нечего, если они разные.
  expect(entry.slotsHash).toBe(harness.repo.cases(run.run_id)[0]!.slots_hash!);
  expect(entry.slotsHash).toMatch(/^[0-9a-f]{64}$/);
  harness.db.close();
});

test("evidence_manifest_hash съезжает от одной лишь смены bundleHash ребёнка слота", async () => {
  /** Слот-ран поверх ребёнка с заданным билдом; отпечатки и артефакты нормализуются. */
  const shapeOf = async (bundleHash: string): Promise<string> => {
    const harness = await setup({ slots: ["items"], namedSlots: true });
    seedChild(harness, { id: "pay-child", name: "PayChild" });
    harness.db.run("UPDATE component_publishes SET bundle_hash=? WHERE component_id='pay-child'", [bundleHash]);
    const started = await harness.orchestrator.startRun({
      candidateId: harness.candidateId, createdBy: "user_a",
      caseSetId: putSet(harness, slotManifest([
        { id: "alpha", props: { label: "a" }, slotBindings: { items: [{ type: "PayChild", version: 1 }] } },
      ])),
    });
    const run = await harness.orchestrator.executeRun(started.run.run_id);
    const manifest = (await readRunManifest(harness.dir, run.run_id))!;
    expect(manifest.cases[0]!.slotBindings![0]!.children[0]!.bundleHash).toBe(bundleHash);
    harness.db.close();
    return manifestShapeHash(manifest);
  };

  // Пересобранный ребёнок — другое доказательство: приёмка, снятая со старым билдом, не описывает
  // новый, и промоут, связывающий `evidence_manifest_hash`, обязан это видеть.
  expect(await shapeOf("bh-child-a")).not.toBe(await shapeOf("bh-child-b"));
});
