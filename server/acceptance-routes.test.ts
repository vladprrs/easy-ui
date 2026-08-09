import { afterEach, expect, test } from "bun:test";
import { unzipSync, strFromU8 } from "fflate";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { openDatabase } from "./db";
import { createTestHandler } from "./test-auth";
import { ApiError } from "./http";
import { BOOTSTRAP_ADMIN_ID, UserRepo } from "./users";
import { acquireMaintenanceLock, releaseMaintenanceLock } from "./maintenance";
import type { Principal } from "./auth";
import { AcceptanceOrchestrator } from "./acceptance/orchestrator";
import { routeAcceptance } from "./routes/acceptance";
import { routeCaseSets } from "./routes/caseSets";
import type { AcceptanceCaptureService } from "./acceptance/gates/types";
import type { CaptureProbe, JobOutcome, JobStatus, ScreenshotResult } from "./screenshot/service";
import type { InkBboxResult } from "./acceptance/inkBbox";
import { readinessPolicyHashOf, verdictPolicyHashOf } from "./acceptance/ids";
import { readRunManifest } from "./acceptance/evidence";
import { ACCEPTANCE_POLICIES } from "./acceptance/policies";

/**
 * Роуты матричной приёмки (план 2026-08-03 §5 W1a, RFC §4.1–4.2).
 *
 * Капчур — заглушка (прецедент `acceptance/runner.test.ts`): исполнение джоб проверяет
 * `screenshot/service-acceptance.test.ts`, а здесь предмет — HTTP-поверхность: гейт флага,
 * авторизация, коды отказов и полный путь кандидат → ран → cases → evidence-zip.
 *
 * Компонент создаётся **настоящим** POST /api/components и проходит настоящий validate:
 * кандидат обязан описывать реальный билд, иначе `getCandidateForRev` не нашёл бы бандла.
 */

const dirs: string[] = [];
const dbs: Database[] = [];
afterEach(async () => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const COMPONENT_ID = "acc-routes-probe";

const SOURCE = `import { z } from "zod";
export const definition = {
  props: z.strictObject({ label: z.string().default("alpha") }),
  events: [], slots: [],
  description: "Acceptance routes probe: renders a single label",
  atomicLevel: "atom" as const,
  examples: { alpha: { label: "alpha" }, beta: { label: "beta" } },
};
export default function AccRoutesProbe({ props }: any) {
  return <div><span>{props.label}</span></div>;
}`;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

/** Исход readiness «политика профиля выполнена» (W4) — иначе гейт `readiness` не даёт вердикта. */
const READY_READINESS = {
  readinessMet: true,
  readinessReason: null,
  readinessCodes: [],
  readinessPolicyHash: readinessPolicyHashOf(ACCEPTANCE_POLICIES["default-v1"].readiness),
  readinessEvidence: {
    fontFaces: [], images: { total: 0, decoded: 0, failed: 0 }, pendingRequests: [],
    framesWaited: 2, animationsDisabled: true,
    themeResources: { tokens: [], icons: [], images: [] },
    // W2 (план 2026-08-07 §1.5): эхо барьера ресурсов обязательно при v3-политике профиля —
    // кадр с `met:true` без него гейт `readiness` объявляет `indeterminate` («флаг не доехал»).
    resourceBarrier: { expected: 1, decoded: 1, fontsReady: true, stableFrames: 2, lateAfterBarrier: [], durationMs: 12 },
  },
  observedCaptureEnvFingerprint: "env-fingerprint",
  observedCaptureEnv: null,
};

const imageBytes = (bytes: Uint8Array): ScreenshotResult => ({
  kind: "image-bytes",
  bytes, width: 10, height: 10, imageProduced: true,
  consoleErrors: [], pageErrors: [], captureClean: true,
  productErrors: [], infraNoise: [], runtimeWarnings: [],
  rendererBuild: null, browserVersion: "test/1",
  ...READY_READINESS,
} as unknown as ScreenshotResult);

/** Paint-джоба (W3): geometry-факты и кадр из одной сессии; layout совпадает с чернилами ⇒ `clean`. */
const PAINT_LAYOUT = { x: 64, y: 64, width: 140, height: 96 };
const paintResult = (bytes: Uint8Array): ScreenshotResult => ({
  kind: "paint", surface: "component", componentId: COMPONENT_ID, draftRev: 1, bundleHash: "bundle",
  designSystemMetaVersion: null, resolvedSpaceScale: {}, viewport: { width: 390, height: 844 }, dpr: 2,
  paintMargin: 64, bytes, width: 536, height: 448, imageProduced: true,
  captureClean: true, productErrors: [], infraNoise: [], runtimeWarnings: [],
  consoleErrors: [], pageErrors: [], rendererBuild: null, browserVersion: "test/1",
  rects: [], truncated: false, total: 0,
  details: [{ key: "root", instance: 0, layoutBounds: { ...PAINT_LAYOUT }, effectSources: [], clipChain: [] }],
  ...READY_READINESS,
} as unknown as ScreenshotResult);

const cleanInk = (): Promise<InkBboxResult> => Promise.resolve({
  ok: true, source: "alpha", image: { width: 536, height: 448 }, deviceScaleFactor: 2,
  pixelBounds: { x: 128, y: 128, width: 280, height: 192 }, bounds: { ...PAINT_LAYOUT },
  clamped: { left: false, right: false, top: false, bottom: false },
});

/** Детерминированный капчур: кадр зависит только от props, поэтому `determinism` даёт `pass`. */
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
    const bytes = new Uint8Array([...PNG, ...new TextEncoder().encode(JSON.stringify(opts.props ?? {}))]);
    if (opts.probe === "paint") {
      this.statuses.set(jobId, { status: "done", result: paintResult(bytes) });
    } else {
      this.statuses.set(jobId, { status: "done", result: imageBytes(bytes) });
    }
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

type Handler = (request: Request) => Promise<Response>;

const req = (path: string, method = "GET", body?: unknown) =>
  new Request(`http://test/api${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function setup(options: { matrix?: boolean; autoDrain?: boolean } = {}) {
  const dir = await mkdtemp(resolve(process.cwd(), ".acc-routes-test-"));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  dbs.push(db);
  const service = new FakeCapture();
  const orchestrator = options.matrix === false
    ? undefined
    : new AcceptanceOrchestrator({ db, dataDir: dir, service, inkBbox: cleanInk, autoDrain: options.autoDrain !== false });
  const handler = createTestHandler(db, { dataDir: dir, ...(orchestrator ? { acceptance: orchestrator } : {}) }) as Handler;
  const created = await handler(req("/components", "POST", {
    designSystem: "yandex-pay", id: COMPONENT_ID, name: "AccRoutesProbe", source: SOURCE,
    intent: "Renders a single acceptance probe label for pipeline route tests",
  }));
  expect(created.status, await created.clone().text()).toBe(201);
  return { dir, db, service, orchestrator, handler };
}

const jsonOf = async <T>(response: Response): Promise<T> => (await response.json()) as T;

interface CandidateBody { candidateId: string; componentId: string; rev: number; status: string; cached: boolean; sourceHash: string }
interface RunBody { runId: string; status: string; cases: number; cached: boolean; progress: { total: number; reused: number } }
interface RunView {
  status: string; progress: { total: number; completed: number; reused: number };
  failedCases: unknown[]; gates: Record<string, unknown>;
  /** W5b: группы ремедиаций терминального рана (пустой массив — «нечего чинить»). */
  remediationGroups: { key: string; cause: { code: string }; cases: string[] }[];
}

test("флаг OFF: весь набор acceptance-ручек отвечает 404", async () => {
  const { handler } = await setup({ matrix: false });
  const runId = "acc_00000000-0000-0000-0000-000000000000";
  const calls: [string, string, unknown?][] = [
    [`/components/${COMPONENT_ID}/candidates`, "POST"],
    [`/component-candidates/cand_${"0".repeat(64)}`, "GET"],
    [`/component-candidates/cand_${"0".repeat(64)}/reject`, "POST", { reason: "flag is off" }],
    ["/acceptance-runs", "POST", { candidateId: `cand_${"0".repeat(64)}` }],
    [`/acceptance-runs/${runId}`, "GET"],
    [`/acceptance-runs/${runId}/cases`, "GET"],
    [`/acceptance-runs/${runId}/evidence`, "GET"],
    [`/acceptance-runs/${runId}/cancel`, "POST", {}],
    // BR-06: продолжение живёт под тем же гейтом — без матрицы ручки нет вовсе.
    [`/acceptance-runs/${runId}/resume`, "POST", {}],
    // BR-10a: retry-disposition — тот же гейт: без ранов disposition считать не от чего.
    [`/acceptance-runs/${runId}/retry-disposition`, "GET"],
    [`/components/${COMPONENT_ID}/impact`, "POST", { candidateId: `cand_${"0".repeat(64)}`, baselineRunId: runId }],
  ];
  for (const [path, method, body] of calls) {
    const response = await handler(req(path, method, body));
    expect({ path, status: response.status }).toEqual({ path, status: 404 });
    expect(await jsonOf<{ error: { code: string } }>(response)).toMatchObject({ error: { code: "not_found" } });
  }
  // Тот же флаг гасит и ссылки кандидата в promote (A7): отказ типизован, а не «unknown field».
  const promote = await handler(req(`/components/${COMPONENT_ID}/promote`, "POST", { baseRev: 1, sourceHash: "0".repeat(64), candidateId: `cand_${"0".repeat(64)}` }));
  expect(promote.status).toBe(422);
  expect(await jsonOf<{ error: { code: string } }>(promote)).toMatchObject({ error: { code: "acceptance_matrix_disabled" } });
}, 30_000);

test("happy path: кандидат → ран → poll → cases → evidence-zip", async () => {
  const { handler, orchestrator } = await setup();

  const candidateResponse = await handler(req(`/components/${COMPONENT_ID}/candidates`, "POST"));
  expect(candidateResponse.status, await candidateResponse.clone().text()).toBe(200);
  const candidate = await jsonOf<CandidateBody>(candidateResponse);
  expect(candidate).toMatchObject({ componentId: COMPONENT_ID, rev: 1, status: "validated", cached: false });
  expect(candidate.candidateId).toMatch(/^cand_[0-9a-f]{64}$/);

  // Идемпотентность: тот же билд — та же строка, а не второй кандидат.
  const repeat = await jsonOf<CandidateBody>(await handler(req(`/components/${COMPONENT_ID}/candidates`, "POST")));
  expect(repeat.candidateId).toBe(candidate.candidateId);
  expect(repeat.cached).toBe(true);

  const read = await handler(req(`/component-candidates/${candidate.candidateId}`));
  expect(read.status).toBe(200);
  expect(await jsonOf<CandidateBody>(read)).toMatchObject({ candidateId: candidate.candidateId, sourceHash: candidate.sourceHash });

  const started = await handler(req("/acceptance-runs", "POST", { candidateId: candidate.candidateId }));
  expect(started.status, await started.clone().text()).toBe(202);
  const run = await jsonOf<RunBody>(started);
  expect(run.status).toBe("queued");
  expect(run.cases).toBe(2);
  expect(run.cached).toBe(false);

  await orchestrator!.settled();

  const polled = await handler(req(`/acceptance-runs/${run.runId}`));
  expect(polled.status).toBe(200);
  const view = await jsonOf<RunView>(polled);
  expect(view.status).toBe("pass");
  expect(view.progress).toMatchObject({ total: 2, completed: 2 });
  expect(view.failedCases).toEqual([]);
  expect(Object.keys(view.gates)).toEqual(expect.arrayContaining(["contract", "render", "determinism"]));
  // W5b: раздел отчёта существует всегда; на прошедшем ране он честно пуст, а прогресс остаётся
  // счётчиками — группы ремедиаций в него не подмешиваются.
  expect(view.remediationGroups).toEqual([]);
  expect(view.progress).not.toHaveProperty("remediationGroups");

  const casesResponse = await handler(req(`/acceptance-runs/${run.runId}/cases`));
  expect(casesResponse.status).toBe(200);
  const cases = await jsonOf<{ cases: { caseId: string; verdict: string; artifacts: { name: string; sha256: string; bytes: number }[] }[] }>(casesResponse);
  expect(cases.cases.map((item) => item.caseId).sort()).toEqual(["alpha", "beta"]);
  for (const item of cases.cases) {
    expect(item.verdict).toBe("pass");
    expect(item.artifacts.map((artifact) => artifact.name)).toContain("render.png");
    // Байты артефактов наружу не идут: только имя, адрес и размер.
    expect(item.artifacts.every((artifact) => /^[0-9a-f]{64}$/.test(artifact.sha256))).toBe(true);
  }

  const evidence = await handler(req(`/acceptance-runs/${run.runId}/evidence`));
  expect(evidence.status).toBe(200);
  expect(evidence.headers.get("content-type")).toBe("application/zip");
  const entries = unzipSync(new Uint8Array(await evidence.arrayBuffer()));
  expect(Object.keys(entries)).toEqual(expect.arrayContaining(["manifest.json", "SHA256SUMS", "alpha/render.png", "beta/render.png"]));
  const manifest = JSON.parse(strFromU8(entries["manifest.json"]!)) as { runId: string; verdict: string; cases: unknown[] };
  expect(manifest).toMatchObject({ runId: run.runId, verdict: "pass" });
  expect(manifest.cases.length).toBe(2);
  expect(strFromU8(entries.SHA256SUMS!)).toContain("  alpha/render.png");

  // Повторный ран на том же кандидате переиспользует результаты случаев (A3/D1).
  const second = await jsonOf<RunBody>(await handler(req("/acceptance-runs", "POST", { candidateId: candidate.candidateId })));
  await orchestrator!.settled();
  const secondView = await jsonOf<RunView>(await handler(req(`/acceptance-runs/${second.runId}`)));
  expect(secondView.status).toBe("pass");
  expect(secondView.progress.reused).toBe(2);
}, 120_000);

test("авторизация: чужой пользователь и share/capture-принципалы не видят кандидата и рана", async () => {
  const { db, dir, handler, orchestrator } = await setup();
  const candidate = await jsonOf<CandidateBody>(await handler(req(`/components/${COMPONENT_ID}/candidates`, "POST")));
  const run = await jsonOf<RunBody>(await handler(req("/acceptance-runs", "POST", { candidateId: candidate.candidateId })));
  await orchestrator!.settled();

  const stranger = await new UserRepo(db).create({ name: "Stranger", password: "stranger-password-1", actorId: BOOTSTRAP_ADMIN_ID });
  const call = (principal: Principal, path: string, method = "GET", body?: unknown) =>
    routeAcceptance(req(path, method, body), db, path.slice(1).split("/"), principal, dir, orchestrator);

  const strangerPrincipal: Principal = { kind: "user", userId: stranger.id, name: stranger.name, isAdmin: false };
  const share: Principal = { kind: "share", scope: { grantId: "g", prototypeId: "p", version: 1, allowedUrls: [] } };
  const capture: Principal = { kind: "capture", scope: { token: "t", allowedUrls: [] } };

  const expectStatus = async (promise: Promise<Response | null>, status: number, code: string) => {
    await expect(promise).rejects.toMatchObject({ status, code });
  };
  for (const path of [`/component-candidates/${candidate.candidateId}`, `/acceptance-runs/${run.runId}`, `/acceptance-runs/${run.runId}/cases`, `/acceptance-runs/${run.runId}/evidence`]) {
    await expectStatus(call(strangerPrincipal, path), 403, "forbidden");
    await expectStatus(call(share, path), 403, "forbidden");
    await expectStatus(call(capture, path), 403, "forbidden");
  }
  // R3b: reject — мутация чужого кандидата, поэтому тот же барьер и тем же кодом.
  const rejectPath = `/component-candidates/${candidate.candidateId}/reject`;
  for (const principal of [strangerPrincipal, share, capture]) {
    await expectStatus(call(principal, rejectPath, "POST", { reason: "not mine" }), 403, "forbidden");
  }
  // Админ читает чужой ран: тот же short-circuit `requireResourceOwner`, что и везде.
  const adminPrincipal: Principal = { kind: "user", userId: BOOTSTRAP_ADMIN_ID, name: "Test Admin", isAdmin: true };
  const asAdmin = await call(adminPrincipal, `/acceptance-runs/${run.runId}`);
  expect(asAdmin!.status).toBe(200);
}, 120_000);

test("постановка рана: unsupported_option, unknown_policy_profile и 503 под maintenance-lock", async () => {
  const { db, handler } = await setup();
  const candidate = await jsonOf<CandidateBody>(await handler(req(`/components/${COMPONENT_ID}/candidates`, "POST")));

  // Битая форма `caseSetId` — 400 до lookup'а кандидата (W2), а не «нет набора»: адрес набора
  // не должен работать оракулом.
  const badCaseSet = await handler(req("/acceptance-runs", "POST", { candidateId: candidate.candidateId, caseSetId: "cset_x" }));
  expect(badCaseSet.status).toBe(400);
  expect(await jsonOf<{ error: { code: string } }>(badCaseSet)).toMatchObject({ error: { code: "invalid_request" } });

  for (const body of [
    { candidateId: candidate.candidateId, manifestAssetId: "asset_x" },
    { candidateId: candidate.candidateId, concurrency: 4 },
    { candidateId: candidate.candidateId, cases: { concurrency: 4 } },
  ]) {
    const response = await handler(req("/acceptance-runs", "POST", body));
    expect({ body, status: response.status }).toEqual({ body, status: 422 });
    expect(await jsonOf<{ error: { code: string } }>(response)).toMatchObject({ error: { code: "unsupported_option" } });
  }

  const badPolicy = await handler(req("/acceptance-runs", "POST", { candidateId: candidate.candidateId, policy: "nope-v9" }));
  expect(badPolicy.status).toBe(422);
  expect(await jsonOf<{ error: { code: string } }>(badPolicy)).toMatchObject({ error: { code: "unknown_policy_profile" } });

  // §4.8: под lock'ом миграции ран не ставится — каталог не должен уехать под снятыми кадрами.
  const lock = acquireMaintenanceLock(db, "run_lock_test", "contract test");
  const locked = await handler(req("/acceptance-runs", "POST", { candidateId: candidate.candidateId }));
  expect(locked.status).toBe(503);
  releaseMaintenanceLock(db, lock.runId, lock.acquiredAt);
}, 120_000);

test("refresh: failed/{caseIds} принимаются, кривая форма — 400, чужой caseId — 422 unknown_case_id", async () => {
  // Без автопрокрутки ран остаётся queued: предмет теста — разбор `refresh` на постановке.
  const { handler } = await setup({ autoDrain: false });
  const candidate = await jsonOf<CandidateBody>(await handler(req(`/components/${COMPONENT_ID}/candidates`, "POST")));

  const unknown = await handler(req("/acceptance-runs", "POST", { candidateId: candidate.candidateId, refresh: { caseIds: ["alpha", "nope"] } }));
  expect(unknown.status).toBe(422);
  expect(await jsonOf<{ error: { code: string } }>(unknown)).toMatchObject({ error: { code: "unknown_case_id" } });

  for (const refresh of ["sometimes", 1, { caseIds: [] }, { caseIds: ["alpha"], mode: "all" }]) {
    const response = await handler(req("/acceptance-runs", "POST", { candidateId: candidate.candidateId, refresh }));
    expect({ refresh, status: response.status }).toEqual({ refresh, status: 400 });
  }

  const partial = await handler(req("/acceptance-runs", "POST", { candidateId: candidate.candidateId, refresh: { caseIds: ["alpha"] } }));
  expect(partial.status, await partial.clone().text()).toBe(202);
  expect((await jsonOf<RunBody>(partial)).status).toBe("queued");
}, 120_000);

test("cancel: queued отменяется, второй нетерминальный ран того же кандидата — 409", async () => {
  // Без автопрокрутки ран остаётся `queued` — ровно то состояние, в котором cancel разрешён (A6).
  const { handler } = await setup({ autoDrain: false });
  const candidate = await jsonOf<CandidateBody>(await handler(req(`/components/${COMPONENT_ID}/candidates`, "POST")));
  const run = await jsonOf<RunBody>(await handler(req("/acceptance-runs", "POST", { candidateId: candidate.candidateId })));
  expect(run.status).toBe("queued");

  const conflict = await handler(req("/acceptance-runs", "POST", { candidateId: candidate.candidateId }));
  expect(conflict.status).toBe(409);
  expect(await jsonOf<{ error: { code: string } }>(conflict)).toMatchObject({ error: { code: "acceptance_run_in_flight" } });

  // Evidence нетерминального рана — честный 409, а не пустой архив.
  const pending = await handler(req(`/acceptance-runs/${run.runId}/evidence`));
  expect(pending.status).toBe(409);
  expect(await jsonOf<{ error: { code: string } }>(pending)).toMatchObject({ error: { code: "evidence_not_ready" } });

  const cancelled = await handler(req(`/acceptance-runs/${run.runId}/cancel`, "POST", {}));
  expect(cancelled.status).toBe(200);
  expect(await jsonOf<RunView>(cancelled)).toMatchObject({ status: "cancelled" });

  const again = await handler(req(`/acceptance-runs/${run.runId}/cancel`, "POST", {}));
  expect(again.status).toBe(409);
  expect(await jsonOf<{ error: { code: string } }>(again)).toMatchObject({ error: { code: "run_not_cancellable" } });
}, 120_000);

/**
 * BR-06: HTTP-поверхность продолжения. Предмет — коды отказов и форма ответа; продолжаемость,
 * lineage и перенос гейтов живут в `server/acceptance/resume.test.ts`.
 */
test("resume: kill-switch, неподходящее состояние и повторное продолжение — типизированные 409", async () => {
  const { handler, orchestrator } = await setup({ autoDrain: false });
  const candidate = await jsonOf<CandidateBody>(await handler(req(`/components/${COMPONENT_ID}/candidates`, "POST")));
  const run = await jsonOf<RunBody>(await handler(req("/acceptance-runs", "POST", { candidateId: candidate.candidateId })));

  // Kill-switch отвечает **до** проверок состояния: агент получает один и тот же отказ.
  process.env.EASYUI_ACCEPTANCE_RESUME_DISABLED = "1";
  try {
    const off = await handler(req(`/acceptance-runs/${run.runId}/resume`, "POST", {}));
    expect(off.status).toBe(409);
    expect(await jsonOf<{ error: { code: string } }>(off)).toMatchObject({ error: { code: "acceptance_resume_disabled" } });
  } finally { delete process.env.EASYUI_ACCEPTANCE_RESUME_DISABLED; }

  // Бегущий/поставленный ран продолжать нечем — он ещё идёт.
  const running = await handler(req(`/acceptance-runs/${run.runId}/resume`, "POST", {}));
  expect(running.status).toBe(409);
  expect(await jsonOf<{ error: { code: string } }>(running)).toMatchObject({ error: { code: "run_not_resumable" } });

  // Тело — только `{}`: переопределять набор/профиль продолжением нельзя.
  orchestrator!.repo.sweepNonTerminalRuns();
  const withFields = await handler(req(`/acceptance-runs/${run.runId}/resume`, "POST", { policy: "pixel-strict-v1" }));
  expect(withFields.status).toBe(400);

  const resumed = await handler(req(`/acceptance-runs/${run.runId}/resume`, "POST", {}));
  expect(resumed.status, await resumed.clone().text()).toBe(202);
  const body = await jsonOf<{ runId: string; attempt: number; resumedFromRunId: string; resumedFrom: { statusReason: string } }>(resumed);
  expect(body.attempt).toBe(2);
  expect(body.resumedFromRunId).toBe(run.runId);
  expect(body.resumedFrom.statusReason).toBe("interrupted");

  // Повтор называет продолжение, а не создаёт второе.
  const again = await handler(req(`/acceptance-runs/${run.runId}/resume`, "POST", {}));
  expect(again.status).toBe(409);
  expect(await jsonOf<{ error: { code: string; runId: string } }>(again))
    .toMatchObject({ error: { code: "run_already_resumed", runId: body.runId } });

  // Ран-предок остался неизменным: продолжение — новая строка, а не правка терминального рана.
  const source = await jsonOf<RunView & { runId: string; attempt: number; resumedFromRunId: string | null }>(
    await handler(req(`/acceptance-runs/${run.runId}`)));
  expect(source).toMatchObject({ status: "error", statusReason: "interrupted", attempt: 1, resumedFromRunId: null });
}, 120_000);

/**
 * BR-10a: HTTP-поверхность отпечатка блокера и disposition. Предмет — согласованность трёх
 * ответов (ран, disposition, манифест архива), утверждения query-параметров и kill-switch;
 * сам расчёт слоёв живёт в `server/acceptance/retry-disposition.test.ts`.
 */
test("retry-disposition: один отпечаток в ране, ручке и манифесте; query — утверждения, не фильтры", async () => {
  const { dir, handler, orchestrator } = await setup();
  const candidate = await jsonOf<CandidateBody>(await handler(req(`/components/${COMPONENT_ID}/candidates`, "POST")));
  const run = await jsonOf<RunBody>(await handler(req("/acceptance-runs", "POST", { candidateId: candidate.candidateId })));
  await orchestrator!.settled();

  // Прошедший ран блокера не имеет — и отпечаток честно `null`, а не пустая строка.
  const passed = await jsonOf<{ blockerFingerprint: string | null }>(await handler(req(`/acceptance-runs/${run.runId}`)));
  expect(passed.blockerFingerprint).toBeNull();

  // Неопределённый случай — тоже блокер (фидбэк §13): вердикта нет, и агенту нужен тот же дедуп.
  orchestrator!.repo.updateCase(run.runId, "alpha", { verdict: "indeterminate" });
  const view = await jsonOf<{ blockerFingerprint: string }>(await handler(req(`/acceptance-runs/${run.runId}`)));
  expect(view.blockerFingerprint).toMatch(/^blk_[0-9a-f]{64}$/);

  const disposition = await handler(req(`/acceptance-runs/${run.runId}/retry-disposition`));
  expect(disposition.status, await disposition.clone().text()).toBe(200);
  expect(disposition.headers.get("cache-control")).toContain("no-store");
  const body = await jsonOf<{
    runId: string; blockerFingerprint: string; disposition: string; suggestedAction: string;
    changed: string[]; unchanged: string[]; basis: Record<string, unknown>; cases: unknown[];
  }>(disposition);
  // Инвариант волны: run view и disposition обязаны давать **одно** значение.
  expect(body.blockerFingerprint).toBe(view.blockerFingerprint);
  expect(body).toMatchObject({ runId: run.runId, disposition: "unchanged", suggestedAction: "do-not-retry", changed: [] });
  expect(body.basis.policyProfileHash).toEqual(expect.any(String));
  expect(body.cases.length).toBe(2);

  // Сводка несёт тот же отпечаток: она и есть основной вид для агента.
  const summary = await jsonOf<{ blockerFingerprint: string }>(await handler(req(`/acceptance-runs/${run.runId}?view=summary`)));
  expect(summary.blockerFingerprint).toBe(view.blockerFingerprint);

  // …и манифест архива — тоже: доказательство провала без ответа «тот же блокер или новый»
  // заставляет читателя сверять вердикты глазами.
  const evidence = await handler(req(`/acceptance-runs/${run.runId}/evidence`));
  expect(evidence.status).toBe(200);
  const entries = unzipSync(new Uint8Array(await evidence.arrayBuffer()));
  const manifest = JSON.parse(strFromU8(entries["manifest.json"]!)) as { blockerFingerprint?: string };
  expect(manifest.blockerFingerprint).toBe(view.blockerFingerprint);
  // Персистированный манифест при этом не тронут: поле вычисляется на чтении, поэтому
  // `evidence_manifest_hash` рана остаётся хэшем ровно того, что записано на диск.
  const stored = await readRunManifest(dir, run.runId);
  expect(stored).not.toBeNull();
  expect("blockerFingerprint" in (stored as unknown as object)).toBe(false);

  // Утверждения о ране: неверная пара — типизированный 409, битая форма — 400.
  const foreign = await handler(req(`/acceptance-runs/${run.runId}/retry-disposition?candidateId=cand_${"0".repeat(64)}`));
  expect(foreign.status).toBe(409);
  expect(await jsonOf<{ error: { code: string } }>(foreign)).toMatchObject({ error: { code: "candidate_mismatch" } });
  const otherSet = await handler(req(`/acceptance-runs/${run.runId}/retry-disposition?caseSetId=cset_${"0".repeat(64)}`));
  expect(otherSet.status).toBe(409);
  expect(await jsonOf<{ error: { code: string } }>(otherSet)).toMatchObject({ error: { code: "case_set_mismatch" } });
  expect((await handler(req(`/acceptance-runs/${run.runId}/retry-disposition?candidateId=nope`))).status).toBe(400);
  expect((await handler(req(`/acceptance-runs/${run.runId}/retry-disposition?whatever=1`))).status).toBe(400);
  // Своя же пара проходит.
  const asserted = await handler(req(`/acceptance-runs/${run.runId}/retry-disposition?candidateId=${candidate.candidateId}`));
  expect(asserted.status).toBe(200);
  // Ручка read-only: ни одного нового рана после всех обращений.
  expect(orchestrator!.repo.runsForCandidate(candidate.candidateId).length).toBe(1);

  // Kill-switch гасит обе поверхности сразу: ручку — 404, поле — отсутствием ключа.
  process.env.EASYUI_BLOCKER_FINGERPRINT_DISABLED = "1";
  try {
    expect((await handler(req(`/acceptance-runs/${run.runId}/retry-disposition`))).status).toBe(404);
    const off = await jsonOf<Record<string, unknown>>(await handler(req(`/acceptance-runs/${run.runId}`)));
    expect("blockerFingerprint" in off).toBe(false);
    const archive = unzipSync(new Uint8Array(await (await handler(req(`/acceptance-runs/${run.runId}/evidence`))).arrayBuffer()));
    expect("blockerFingerprint" in (JSON.parse(strFromU8(archive["manifest.json"]!)) as object)).toBe(false);
  } finally { delete process.env.EASYUI_BLOCKER_FINGERPRINT_DISABLED; }
}, 120_000);

// ------------------------------------------------------- case-set-манифесты (W2)

/**
 * Роуты case-set'ов (план 2026-08-03 §5 W2). Живут в этом файле по той же причине, что и
 * acceptance-роуты: им нужен настоящий компонент и настоящий кандидат, а фикстура здесь одна.
 */

const REFERENCE_SHA = "c".repeat(64);
const REFERENCE_ASSET = `asset_${REFERENCE_SHA}`;

const seedAsset = (db: Database): string => {
  db.run("INSERT INTO assets (id,sha256,mime,size,width,height,created_at) VALUES (?,?,'image/png',8,4,4,'now')", [REFERENCE_ASSET, REFERENCE_SHA]);
  return REFERENCE_ASSET;
};

const caseSetManifest = (overrides: Record<string, unknown> = {}) => ({
  manifestVersion: 1,
  componentId: COMPONENT_ID,
  source: { fileKey: "figma-file-key", componentSetNodeId: "54863:9518" },
  capture: { viewport: { width: 320, height: 200 }, deviceScaleFactor: 2, theme: "light" },
  dimensions: { tone: ["alpha", "beta"] },
  cases: [
    { id: "alpha", props: { label: "alpha" }, dims: { tone: "alpha" }, referenceAssetId: REFERENCE_ASSET, expectedGeometry: { width: 140, height: 96 } },
    { id: "beta", props: { label: "beta" }, dims: { tone: "beta" } },
    { id: "beta-copy", props: { label: "beta" }, aliasOf: "beta", dims: { tone: "beta" } },
  ],
  ...overrides,
});

interface CaseSetBody { caseSetId: string; cases: number; cached: boolean; warnings: string[]; coverage: { expectedTuples: number; presentTuples: number; missingTuples: unknown[]; duplicates: { caseIds: string[] }[] } }

test("case-sets: PUT идемпотентен, GET и coverage отдают набор, отказы типизованы", async () => {
  const { db, handler } = await setup({ autoDrain: false });
  seedAsset(db);

  const put = await handler(req(`/components/${COMPONENT_ID}/case-sets`, "PUT", { manifest: caseSetManifest() }));
  expect(put.status, await put.clone().text()).toBe(200);
  const created = await jsonOf<CaseSetBody>(put);
  expect(created.caseSetId).toMatch(/^cset_[0-9a-f]{64}$/);
  expect({ cases: created.cases, cached: created.cached }).toEqual({ cases: 3, cached: false });
  expect(created.coverage).toMatchObject({ expectedTuples: 2, presentTuples: 2, missingTuples: [] });
  expect(created.coverage.duplicates[0]!.caseIds).toEqual(["beta", "beta-copy"]);

  const again = await jsonOf<CaseSetBody>(await handler(req(`/components/${COMPONENT_ID}/case-sets`, "PUT", { manifest: caseSetManifest() })));
  expect({ id: again.caseSetId, cached: again.cached }).toEqual({ id: created.caseSetId, cached: true });

  const read = await handler(req(`/case-sets/${created.caseSetId}`));
  expect(read.status).toBe(200);
  expect(await jsonOf<{ componentId: string; caseCount: number; source: { fileKey: string } }>(read))
    .toMatchObject({ componentId: COMPONENT_ID, caseCount: 3, source: { fileKey: "figma-file-key" } });

  const coverage = await handler(req(`/case-sets/${created.caseSetId}/coverage`));
  expect(coverage.status).toBe(200);
  expect(await jsonOf<{ dimensions: Record<string, string[]>; missingTuples: unknown[] }>(coverage))
    .toMatchObject({ dimensions: { tone: ["alpha", "beta"] }, missingTuples: [] });

  // Неполное покрытие видно как missingTuples, а не как отказ.
  const partial = await jsonOf<CaseSetBody>(await handler(req(`/components/${COMPONENT_ID}/case-sets`, "PUT", {
    manifest: caseSetManifest({ cases: [{ id: "alpha", props: { label: "alpha" }, dims: { tone: "alpha" } }] }),
  })));
  expect(partial.coverage.missingTuples).toEqual([{ tone: "beta" }]);

  // Отказы: битый ассет, плохой charset, чужой componentId, дубль props без aliasOf.
  const refusals: [string, unknown, number, string][] = [
    ["asset", caseSetManifest({ cases: [{ id: "alpha", props: { label: "alpha" }, referenceAssetId: `asset_${"d".repeat(64)}` }] }), 422, "asset_not_found"],
    ["charset", caseSetManifest({ cases: [{ id: "54863:9537", props: { label: "alpha" } }] }), 422, "validation_failed"],
    ["component", caseSetManifest({ componentId: "someone-else" }), 422, "case_set_component_mismatch"],
    ["props", caseSetManifest({ cases: [{ id: "one", props: { label: "x" } }, { id: "two", props: { label: "x" } }] }), 422, "duplicate_case_props"],
  ];
  for (const [label, manifest, status, code] of refusals) {
    const response = await handler(req(`/components/${COMPONENT_ID}/case-sets`, "PUT", { manifest }));
    expect({ label, status: response.status }).toEqual({ label, status });
    expect(await jsonOf<{ error: { code: string } }>(response)).toMatchObject({ error: { code } });
  }

  // Неизвестный набор и битая форма id — одинаковый 404 (адрес набора не работает оракулом).
  for (const id of [`cset_${"0".repeat(64)}`, "cset_nope"]) {
    const missing = await handler(req(`/case-sets/${id}`));
    expect({ id, status: missing.status }).toEqual({ id, status: 404 });
  }
}, 120_000);

/**
 * Dry-run манифеста (план 2026-08-04 §W6). Ключевое свойство — **немутирующий**: после вызова
 * набора не существует, и следующий PUT остаётся первой публикацией (`cached: false`).
 */
test("case-sets validate: dry-run отдаёт caseSetId/cases/coverage и ничего не пишет", async () => {
  const { db, handler } = await setup({ autoDrain: false });
  seedAsset(db);

  const dry = await handler(req(`/components/${COMPONENT_ID}/case-sets/validate`, "POST", { manifest: caseSetManifest() }));
  expect(dry.status, await dry.clone().text()).toBe(200);
  const report = await jsonOf<{
    caseSetId: string; componentId: string; wouldBeCached: boolean;
    cases: { count: number; ids: string[] }; coverage: { expectedTuples: number; missingCount: number; truncated: boolean };
    warnings: string[];
  }>(dry);
  expect(report.caseSetId).toMatch(/^cset_[0-9a-f]{64}$/);
  expect({ id: report.componentId, cached: report.wouldBeCached }).toEqual({ id: COMPONENT_ID, cached: false });
  expect(report.cases).toEqual({ count: 3, ids: ["alpha", "beta", "beta-copy"] });
  expect(report.coverage).toMatchObject({ expectedTuples: 2, missingCount: 0, truncated: false });

  // Ничего не записано: набор по вычисленному адресу не читается, а PUT — всё ещё первый.
  expect((await handler(req(`/case-sets/${report.caseSetId}`))).status).toBe(404);
  const put = await jsonOf<CaseSetBody>(await handler(req(`/components/${COMPONENT_ID}/case-sets`, "PUT", { manifest: caseSetManifest() })));
  expect({ id: put.caseSetId, cached: put.cached }).toEqual({ id: report.caseSetId, cached: false });

  // После публикации тот же dry-run честно говорит, что PUT был бы идемпотентным повтором.
  const again = await jsonOf<{ wouldBeCached: boolean }>(
    await handler(req(`/components/${COMPONENT_ID}/case-sets/validate`, "POST", { manifest: caseSetManifest() })));
  expect(again.wouldBeCached).toBe(true);

  // Отказы — те же коды, что у PUT, и тоже без записи.
  const bomb = await handler(req(`/components/${COMPONENT_ID}/case-sets/validate`, "POST", {
    manifest: caseSetManifest({
      dimensions: Object.fromEntries(Array.from({ length: 8 }, (_, axis) =>
        [`axis${axis}`, Array.from({ length: 64 }, (_, index) => `v${index}`)])),
    }),
  }));
  expect(bomb.status).toBe(422);
  expect(await jsonOf<{ error: { code: string } }>(bomb)).toMatchObject({ error: { code: "case_set_coverage_too_large" } });

  const mismatch = await handler(req(`/components/${COMPONENT_ID}/case-sets/validate`, "POST", { manifest: caseSetManifest({ componentId: "someone-else" }) }));
  expect(mismatch.status).toBe(422);
  expect(await jsonOf<{ error: { code: string } }>(mismatch)).toMatchObject({ error: { code: "case_set_component_mismatch" } });

  // GET по dry-run-пути — 405: ручка мутационной формы, но не мутация.
  expect((await handler(req(`/components/${COMPONENT_ID}/case-sets/validate`))).status).toBe(405);
}, 120_000);

test("case-sets: гейт OFF даёт 404, чужой пользователь и share/capture — 403", async () => {
  const off = await setup({ matrix: false });
  for (const [path, method, body] of [
    [`/components/${COMPONENT_ID}/case-sets`, "PUT", { manifest: caseSetManifest() }],
    [`/components/${COMPONENT_ID}/case-sets/validate`, "POST", { manifest: caseSetManifest() }],
    [`/case-sets/cset_${"0".repeat(64)}`, "GET", undefined],
    [`/case-sets/cset_${"0".repeat(64)}/coverage`, "GET", undefined],
  ] as [string, string, unknown][]) {
    const response = await off.handler(req(path, method, body));
    expect({ path, status: response.status }).toEqual({ path, status: 404 });
  }

  const { db, handler, orchestrator } = await setup({ autoDrain: false });
  seedAsset(db);
  const created = await jsonOf<CaseSetBody>(await handler(req(`/components/${COMPONENT_ID}/case-sets`, "PUT", { manifest: caseSetManifest() })));
  const stranger = await new UserRepo(db).create({ name: "Case Set Stranger", password: "stranger-password-1", actorId: BOOTSTRAP_ADMIN_ID });
  const call = (principal: Principal, path: string, method = "GET", body?: unknown) =>
    routeCaseSets(req(path, method, body), db, path.slice(1).split("/"), principal, orchestrator);

  const principals: Principal[] = [
    { kind: "user", userId: stranger.id, name: stranger.name, isAdmin: false },
    { kind: "share", scope: { grantId: "g", prototypeId: "p", version: 1, allowedUrls: [] } },
    { kind: "capture", scope: { token: "t", allowedUrls: [] } },
  ];
  for (const principal of principals) {
    for (const path of [`/case-sets/${created.caseSetId}`, `/case-sets/${created.caseSetId}/coverage`]) {
      await expect(call(principal, path)).rejects.toMatchObject({ status: 403, code: "forbidden" });
    }
    await expect(call(principal, `/components/${COMPONENT_ID}/case-sets`, "PUT", { manifest: caseSetManifest() }))
      .rejects.toMatchObject({ status: 403, code: "forbidden" });
    // Dry-run авторизуется ровно как PUT: он читает чужой манифест против чужого компонента.
    await expect(call(principal, `/components/${COMPONENT_ID}/case-sets/validate`, "POST", { manifest: caseSetManifest() }))
      .rejects.toMatchObject({ status: 403, code: "forbidden" });
  }
}, 120_000);

test("ран по case-set'у: строки случаев несут эталон и ожидаемые габариты, чужой набор — 422", async () => {
  const { db, handler, orchestrator } = await setup();
  seedAsset(db);
  const created = await jsonOf<CaseSetBody>(await handler(req(`/components/${COMPONENT_ID}/case-sets`, "PUT", { manifest: caseSetManifest() })));
  const candidate = await jsonOf<CandidateBody>(await handler(req(`/components/${COMPONENT_ID}/candidates`, "POST")));

  const started = await handler(req("/acceptance-runs", "POST", { candidateId: candidate.candidateId, caseSetId: created.caseSetId }));
  expect(started.status, await started.clone().text()).toBe(202);
  const run = await jsonOf<RunBody>(started);
  // Три случая манифеста (не два examples кандидата) — набор действительно приехал из case-set'а.
  expect(run.cases).toBe(3);
  await orchestrator!.settled();

  const view = await jsonOf<RunView & { caseSetId: string }>(await handler(req(`/acceptance-runs/${run.runId}`)));
  expect(view.caseSetId).toBe(created.caseSetId);
  expect(view.status).toBe("pass");

  const cases = await jsonOf<{ cases: { caseId: string; referenceAssetId: string | null; aliasOfCaseId: string | null; verdict: string }[] }>(
    await handler(req(`/acceptance-runs/${run.runId}/cases`)));
  const byId = new Map(cases.cases.map((item) => [item.caseId, item]));
  expect([...byId.keys()].sort()).toEqual(["alpha", "beta", "beta-copy"]);
  expect(byId.get("alpha")!.referenceAssetId).toBe(REFERENCE_ASSET);
  expect(byId.get("beta")!.referenceAssetId).toBeNull();
  expect(byId.get("beta-copy")!.aliasOfCaseId).toBe("beta");
  // Ожидаемые габариты уехали в durable-строку случая (потребитель — гейты W3/W5a).
  const geometry = db.query("SELECT expected_geometry_json g FROM acceptance_cases WHERE run_id=? AND case_id='alpha'").get(run.runId) as { g: string | null };
  expect(JSON.parse(geometry.g!)).toEqual({ width: 140, height: 96 });

  // Набор другого компонента к этому кандидату не применим.
  db.run(`INSERT INTO component_case_sets (case_set_id,component_id,design_system,manifest_json,case_count,source_file_key,source_node_id,created_by,created_at)
    VALUES (?,?,?,?,?,NULL,NULL,'user_admin','now')`,
    [`cset_${"e".repeat(64)}`, "another-component", "yandex-pay",
      JSON.stringify({ ...caseSetManifest(), componentId: "another-component" }), 3]);
  const mismatch = await handler(req("/acceptance-runs", "POST", { candidateId: candidate.candidateId, caseSetId: `cset_${"e".repeat(64)}` }));
  expect(mismatch.status).toBe(422);
  expect(await jsonOf<{ error: { code: string } }>(mismatch)).toMatchObject({ error: { code: "case_set_mismatch" } });
}, 180_000);

// ------------------------------------------------------------------ импакт (W6)

interface ImpactBody {
  basis: string; candidateId: string; baselineRunId: string; baselineCandidateId: string;
  changedAssets: string[]; changedTokens: string[];
  affectedCases: string[]; unaffectedCases: string[]; recaptureCount: number; reason: string;
}

test("impact: dry-run отдаёт базис и план, кривая форма — 400, чужой baseline — 422", async () => {
  const { db, dir, handler, orchestrator } = await setup();
  const candidate = await jsonOf<CandidateBody>(await handler(req(`/components/${COMPONENT_ID}/candidates`, "POST")));
  const run = await jsonOf<RunBody>(await handler(req("/acceptance-runs", "POST", { candidateId: candidate.candidateId })));
  await orchestrator!.settled();

  // Кандидат против собственного рана: билд не менялся — узкий базис с пустым планом.
  const impact = await handler(req(`/components/${COMPONENT_ID}/impact`, "POST", {
    candidateId: candidate.candidateId, baselineRunId: run.runId,
  }));
  expect(impact.status, await impact.clone().text()).toBe(200);
  const report = await jsonOf<ImpactBody>(impact);
  expect(report).toMatchObject({
    basis: "asset-only", candidateId: candidate.candidateId, baselineRunId: run.runId,
    affectedCases: [], recaptureCount: 0,
  });
  expect(report.unaffectedCases.sort()).toEqual(["alpha", "beta"]);

  // `impact` рана, поставленного без baseline, честно `null` — а не пустой отчёт.
  const view = await jsonOf<{ impact: unknown }>(await handler(req(`/acceptance-runs/${run.runId}`)));
  expect(view.impact).toBeNull();

  for (const body of [
    {}, { candidateId: candidate.candidateId }, { candidateId: "nope", baselineRunId: run.runId },
    { candidateId: candidate.candidateId, baselineRunId: "nope" },
    { candidateId: candidate.candidateId, baselineRunId: run.runId, extra: 1 },
  ]) {
    const response = await handler(req(`/components/${COMPONENT_ID}/impact`, "POST", body));
    expect({ body, status: response.status }).toEqual({ body, status: 400 });
  }
  const wrongMethod = await handler(req(`/components/${COMPONENT_ID}/impact`, "GET"));
  expect(wrongMethod.status).toBe(405);

  // Чужой компонент в пути — 422 baseline_run_mismatch (ран принадлежит другому компоненту).
  db.run("INSERT INTO components (id,name,head_rev,created_at,updated_at,design_system,owner_id) VALUES ('acc-other','AccOther',1,'now','now','yandex-pay',?)", [BOOTSTRAP_ADMIN_ID]);
  const foreign = await handler(req("/components/acc-other/impact", "POST", {
    candidateId: candidate.candidateId, baselineRunId: run.runId,
  }));
  expect(foreign.status).toBe(404);

  // Частичный ран: постановка с `baselineRunId` возвращает отчёт сразу, а ран несёт `impact_json`.
  const partial = await handler(req("/acceptance-runs", "POST", { candidateId: candidate.candidateId, baselineRunId: run.runId }));
  expect(partial.status, await partial.clone().text()).toBe(202);
  const partialRun = await jsonOf<RunBody & { impact: ImpactBody }>(partial);
  expect(partialRun.impact.basis).toBe("asset-only");
  await orchestrator!.settled();
  const partialView = await jsonOf<{ impact: ImpactBody | null; progress: { reused: number } }>(await handler(req(`/acceptance-runs/${partialRun.runId}`)));
  expect(partialView.impact?.basis).toBe("asset-only");

  // Авторизация — общая для acceptance-ручек: чужой пользователь и share/capture получают 403.
  const stranger = await new UserRepo(db).create({ name: "ImpactStranger", password: "stranger-password-1", actorId: BOOTSTRAP_ADMIN_ID });
  const path = `/components/${COMPONENT_ID}/impact`;
  for (const principal of [
    { kind: "user", userId: stranger.id, name: stranger.name, isAdmin: false } as Principal,
    { kind: "share", scope: { grantId: "g", prototypeId: "p", version: 1, allowedUrls: [] } } as Principal,
    { kind: "capture", scope: { token: "t", allowedUrls: [] } } as Principal,
  ]) {
    await expect(routeAcceptance(req(path, "POST", { candidateId: candidate.candidateId, baselineRunId: run.runId }), db, path.slice(1).split("/"), principal, dir, orchestrator))
      .rejects.toMatchObject({ status: 403, code: "forbidden" });
  }
}, 180_000);

/**
 * Отклонение кандидата человеком (RFC §4.1, волна R3b).
 *
 * Предмет — терминальность решения на HTTP-поверхности: надгробие, его отражение в DTO, два
 * разведённых 409-кода и анти-воскрешение повторным `POST …/candidates`. Свипер и promote-предикат
 * проверяются в `acceptance/repo.test.ts` и `component-promote.test.ts` соответственно.
 */
test("reject: надгробие, rejected в DTO, повтор и promoted — разные 409, аудит", async () => {
  const { db, handler, orchestrator } = await setup();
  const candidate = await jsonOf<CandidateBody>(await handler(req(`/components/${COMPONENT_ID}/candidates`, "POST")));
  const encoded = `/component-candidates/${candidate.candidateId}/reject`;

  // Причина обязательна, чужие поля не игнорируются молча.
  for (const body of [{}, { reason: "  " }, { reason: "ok", note: "x" }]) {
    const bad = await handler(req(encoded, "POST", body));
    expect({ body, status: bad.status }).toEqual({ body, status: 400 });
  }

  const rejected = await handler(req(encoded, "POST", { reason: "  межстрочный интервал не по макету  " }));
  expect(rejected.status, await rejected.clone().text()).toBe(200);
  const view = await jsonOf<CandidateBody & { rejected: boolean; decision: { reason: string; actor: string; createdAt: string } }>(rejected);
  expect(view.rejected).toBe(true);
  expect(view.decision.reason).toBe("межстрочный интервал не по макету");
  // Хранимый enum не расширяется: `rejected` живёт рядом со `status`, а не вместо него.
  expect(view.status).toBe("validated");

  // Признак виден и на чтении кандидата.
  const read = await jsonOf<{ rejected: boolean; decision: { actor: string } | null }>(await handler(req(`/component-candidates/${candidate.candidateId}`)));
  expect(read.rejected).toBe(true);
  expect(read.decision).not.toBeNull();

  // Аудит-событие приёмки.
  const audit = db.query("SELECT action,subject_id subjectId,detail FROM audit_events WHERE action='candidate.rejected'").all() as { subjectId: string; detail: string }[];
  expect(audit).toHaveLength(1);
  expect(audit[0]!.subjectId).toBe(COMPONENT_ID);
  expect(JSON.parse(audit[0]!.detail)).toMatchObject({ candidateId: candidate.candidateId, rev: 1 });

  // Повтор терминален и несёт существующее решение.
  const again = await handler(req(encoded, "POST", { reason: "и ещё раз" }));
  expect(again.status).toBe(409);
  expect(await jsonOf<{ error: { code: string; reason: string; actor: string } }>(again))
    .toMatchObject({ error: { code: "candidate_already_rejected", reason: "межстрочный интервал не по макету" } });

  // Анти-воскрешение (§3.2а): повтор той же сборки возвращает ТОГО ЖЕ кандидата с надгробием.
  const repeat = await jsonOf<CandidateBody & { rejected: boolean }>(await handler(req(`/components/${COMPONENT_ID}/candidates`, "POST")));
  expect(repeat.candidateId).toBe(candidate.candidateId);
  expect(repeat.cached).toBe(true);
  expect(repeat.rejected).toBe(true);

  // `promoted`-кандидат отклонять нечем — и это ДРУГОЙ код, не `candidate_already_promoted`.
  const other = orchestrator!.repo.createCandidate({
    componentId: COMPONENT_ID, designSystem: "yandex-pay", rev: 1,
    sourceHash: `${"a".repeat(64)}`, bundleHash: "bundle-x", hostAbiVersion: 4, themeVersion: null,
    observedCatalogRevision: "catalog-x", policyProfileHash: candidate.sourceHash, createdBy: BOOTSTRAP_ADMIN_ID,
  }).candidate;
  orchestrator!.repo.markPromoted(other.candidate_id, 3);
  const promoted = await handler(req(`/component-candidates/${other.candidate_id}/reject`, "POST", { reason: "поздно" }));
  expect(promoted.status).toBe(409);
  expect(await jsonOf<{ error: { code: string; currentVersion: number } }>(promoted))
    .toMatchObject({ error: { code: "candidate_promoted", currentVersion: 3 } });
}, 60_000);

// ------------------------------------------------- компактная сводка рана (W8, P1-9)

/**
 * `?view=summary` (план 2026-08-04 §W8). Предмет — **форма и объём**: failed-ран на 25 случаев в
 * полном виде занимал около 1800 строк и переполнял контекст агента, поэтому бюджет сводки
 * («меньше 100 строк pretty-JSON») проверяется тестом наравне с полями.
 *
 * Ран собирается напрямую через репозиторий: съёмка 25 случаев здесь не предмет, а вердикты,
 * гейты и группы ремедиаций нужны ровно в том виде, в каком их пишет терминализация.
 */
const seedFailedRun = (orchestrator: AcceptanceOrchestrator, candidateId: string, options: { cases: number; failed: number }) => {
  const ids = Array.from({ length: options.cases }, (_, index) => `case-${String(index).padStart(2, "0")}`);
  const { run } = orchestrator.repo.createRun({
    candidateId, componentId: COMPONENT_ID, policyProfileId: "default-v1", policyProfileHash: "f".repeat(64),
    createdBy: BOOTSTRAP_ADMIN_ID,
    refresh: {
      requested: { frame: { all: false, failed: false, caseIds: [] }, verdict: { all: false, failed: true, caseIds: [] } },
      impact: { frame: { all: false, failed: false, caseIds: [] }, verdict: { all: false, failed: false, caseIds: [] } },
      effective: { frame: { all: false, failed: false, caseIds: [] }, verdict: { all: false, failed: true, caseIds: [] } },
    },
    cases: ids.map((caseId, index) => ({
      caseId, caseKey: caseId, propsHash: `${index}`.padStart(64, "0"),
      caseFingerprint: `${index}`.padStart(64, "a"), casePolicyHash: "c".repeat(64),
      frameFingerprint: `${index}`.padStart(64, "b"), comparisonFingerprint: `${index}`.padStart(64, "c"),
      verdictPolicyHash: "d".repeat(64),
    })),
  });
  ids.forEach((caseId, index) => {
    const failed = index < options.failed;
    orchestrator.repo.updateCase(run.run_id, caseId, {
      status: "done",
      verdict: failed ? "fail" : "pass",
      severity: failed ? { rank: 2, class: "raw", score: 12.5 } : null,
      gates: [
        { gate: "contract", status: "pass" },
        { gate: "render", status: "pass" },
        {
          gate: "visual", status: failed ? "fail" : "pass",
          // Полный мешок метрик — ровно то, что раздувало ответ: сводка обязана взять из него два числа.
          metrics: {
            rawDiffPct: failed ? 2.69 : 0, aaDiffPct: failed ? 1.27 : 0, maxChannelDelta: 64,
            regions: [{ x: 1, y: 2, width: 3, height: 4 }, { x: 5, y: 6, width: 7, height: 8 }],
            totalRegions: 2, bestOffset: { dx: 0, dy: 0, residualPct: 2.6 },
            thresholds: { maxRawDiffPct: 0.5 }, rawDiffPixels: 100, aaDiffPixels: 40, totalPixels: 4000,
          },
          ...(failed
            ? {
              detail: "Visual diff 2.69% exceeds the 0.5% budget (aa-tolerant 1.27%, max channel delta 64, 2 region(s))",
              causes: [{ code: "surface-tint", confidence: 0.9, detail: "the whole surface is tinted" }],
            }
            : {}),
        },
      ],
      reuseReceipt: {
        reuse: { candidate: true, frame: true, readiness: true, geometry: true, visualMetrics: false, verdict: false },
        fingerprints: { frame: `${index}`.padStart(64, "b"), comparison: `${index}`.padStart(64, "c"), verdictPolicy: "d".repeat(64), case: `${index}`.padStart(64, "a") },
        reuseReason: "rediff:reference",
      },
      finishedAt: "2026-08-04T10:00:00.000Z",
    });
  });
  orchestrator.repo.terminalizeRun(run.run_id, {
    status: "fail",
    gates: { contract: { pass: options.cases }, render: { pass: options.cases }, visual: { pass: options.cases - options.failed, fail: options.failed } },
    progress: {
      total: options.cases, completed: options.cases, reused: 0, frameReused: options.cases,
      verdictRecomputed: 0, rediffed: options.cases, failed: options.failed, running: 0,
      eta: { secondsRemaining: 0, basis: "measured" },
      remediationGroups: [
        {
          key: "k".repeat(64), cause: { code: "surface-tint", confidence: 0.9, detail: "the whole surface is tinted" },
          bboxSignature: null, sharedElementKey: "root", variantFamily: null,
          cases: ids.slice(0, options.failed), caseCount: options.failed,
          suggestion: "Compare the surface fill/background token of the component with the reference.",
        },
      ],
    },
  });
  return run.run_id;
};

interface SummaryView {
  view: string; runId: string; status: string; statusReason: string | null;
  progress: Record<string, number>; gates: Record<string, string>;
  refresh: { requested: string; impact: string; effective: string } | null;
  failedCases: { caseId: string; gate: string; raw: number | null; aa: number | null; cause: string }[];
  remediationGroups: Record<string, string>;
  evidenceUrl: string;
}

test("view=summary: форма сводки failed-рана и бюджет объёма (25 случаев < 100 строк)", async () => {
  const { handler, orchestrator } = await setup({ autoDrain: false });
  const candidate = await jsonOf<CandidateBody>(await handler(req(`/components/${COMPONENT_ID}/candidates`, "POST")));
  const runId = seedFailedRun(orchestrator!, candidate.candidateId, { cases: 25, failed: 8 });

  const response = await handler(req(`/acceptance-runs/${runId}?view=summary`));
  expect(response.status, await response.clone().text()).toBe(200);
  const summary = await jsonOf<SummaryView>(response);

  // Маркер контракта (C23): по нему клиент отличает сводку от полного рана старого сервера.
  expect(summary.view).toBe("summary");
  expect(summary).toMatchObject({ runId, status: "fail", statusReason: null, evidenceUrl: `/api/acceptance-runs/${runId}/evidence` });
  // Счётчики уровней reuse (D9) — в сводке целиком: ради них она и заводилась.
  expect(summary.progress).toMatchObject({ total: 25, completed: 25, reused: 0, frameReused: 25, verdictRecomputed: 0, rediffed: 25, failed: 8, running: 0 });
  expect(summary.progress).not.toHaveProperty("eta");
  expect(summary.gates).toEqual({ contract: "pass:25", render: "pass:25", visual: "pass:17 fail:8" });
  expect(summary.refresh).toEqual({ requested: "verdict:failed", impact: "none", effective: "verdict:failed" });
  expect(summary.failedCases).toHaveLength(8);
  expect(summary.failedCases[0]).toEqual({
    caseId: "case-00", gate: "visual", raw: 2.69, aa: 1.27,
    cause: "surface-tint: the whole surface is tinted",
  });
  // Метрики целиком в сводку не едут — за ними идут точечно, в `/cases?case=<id>`.
  expect(JSON.stringify(summary)).not.toContain("totalPixels");
  expect(Object.values(summary.remediationGroups)).toEqual(["surface-tint ×8: case-00, case-01, case-02, case-03, case-04, case-05, case-06, case-07"]);

  // Бюджет объёма (P1-9): полный вид того же рана — сотни строк, сводка — меньше сотни.
  const lines = JSON.stringify(summary, null, 2).split("\n").length;
  expect(lines).toBeLessThan(100);
  const full = await jsonOf<unknown>(await handler(req(`/acceptance-runs/${runId}`)));
  expect(JSON.stringify(full, null, 2).split("\n").length).toBeGreaterThan(lines * 4);
}, 120_000);

test("view: default остаётся полным ответом, неизвестное значение — 400", async () => {
  const { handler, orchestrator } = await setup({ autoDrain: false });
  const candidate = await jsonOf<CandidateBody>(await handler(req(`/components/${COMPONENT_ID}/candidates`, "POST")));
  const runId = seedFailedRun(orchestrator!, candidate.candidateId, { cases: 3, failed: 1 });

  // Регрессия формы полного вида: набор ключей и вложенность failedCases не менялись волной W8.
  const full = await jsonOf<Record<string, unknown>>(await handler(req(`/acceptance-runs/${runId}`)));
  expect(Object.keys(full).sort()).toEqual([
    // BR-06 (2026-08-08): аддитивная тройка родословной — `attempt`, `resumedFromRunId`, `resume`.
    "attempt",
    // BR-10a (2026-08-08): аддитивный `blockerFingerprint`; при поднятом kill-switch'е ключа нет.
    "blockerFingerprint",
    "candidateId", "caseSetId", "componentId", "createdAt", "eta", "evidenceManifestHash", "failedCases",
    "finishedAt", "gates", "idempotencyKey", "impact", "policy", "progress", "refresh", "remediationGroups",
    "resume", "resumedFromRunId",
    // W7 (2026-08-07): аддитивный раздел `warnings` — advisory-предупреждения рана.
    "runId", "startedAt", "status", "statusReason", "warnings",
  ]);
  expect(full).not.toHaveProperty("view");
  const failedCases = full.failedCases as { caseId: string; failedGates: { gate: string; metrics: Record<string, unknown> }[] }[];
  expect(failedCases[0]!.failedGates[0]!.metrics.totalPixels).toBe(4000);
  // `?view=full` — то же самое явно.
  expect(await jsonOf<Record<string, unknown>>(await handler(req(`/acceptance-runs/${runId}?view=full`)))).toEqual(full);

  const bad = await handler(req(`/acceptance-runs/${runId}?view=short`));
  expect(bad.status).toBe(400);
  expect(await jsonOf<{ error: { code: string } }>(bad)).toMatchObject({ error: { code: "invalid_request" } });
}, 120_000);

test("cases: ?case сужает ответ до одного случая, чужой id — 404, receipt едет в DTO", async () => {
  const { handler, orchestrator } = await setup({ autoDrain: false });
  const candidate = await jsonOf<CandidateBody>(await handler(req(`/components/${COMPONENT_ID}/candidates`, "POST")));
  const runId = seedFailedRun(orchestrator!, candidate.candidateId, { cases: 5, failed: 2 });

  const all = await jsonOf<{ cases: { caseId: string }[] }>(await handler(req(`/acceptance-runs/${runId}/cases`)));
  expect(all.cases).toHaveLength(5);

  const one = await handler(req(`/acceptance-runs/${runId}/cases?case=case-03`));
  expect(one.status).toBe(200);
  const body = await jsonOf<{ cases: { caseId: string; reuseReceipt: { reuse: Record<string, boolean>; fingerprints: Record<string, string> } | null }[] }>(one);
  expect(body.cases.map((item) => item.caseId)).toEqual(["case-03"]);
  // Квитанция уровней (P2-10): `reused` в прогрессе не отличает «ничего не считали» от
  // «вердикт пересчитан», квитанция обязана отвечать уровень за уровнем.
  expect(body.cases[0]!.reuseReceipt).toMatchObject({
    reuse: { candidate: true, frame: true, readiness: true, geometry: true, visualMetrics: false, verdict: false },
    fingerprints: { verdictPolicy: "d".repeat(64) },
  });

  const missing = await handler(req(`/acceptance-runs/${runId}/cases?case=nope`));
  expect(missing.status).toBe(404);
  expect(await jsonOf<{ error: { code: string } }>(missing)).toMatchObject({ error: { code: "not_found" } });
}, 120_000);

test("evidence-манифест несёт квитанцию reuse и эффективную вердиктную политику случая", async () => {
  const { db, dir, handler, orchestrator } = await setup();
  seedAsset(db);
  const created = await jsonOf<CaseSetBody>(await handler(req(`/components/${COMPONENT_ID}/case-sets`, "PUT", { manifest: caseSetManifest() })));
  const candidate = await jsonOf<CandidateBody>(await handler(req(`/components/${COMPONENT_ID}/candidates`, "POST")));
  const run = await jsonOf<RunBody>(await handler(req("/acceptance-runs", "POST", { candidateId: candidate.candidateId, caseSetId: created.caseSetId })));
  await orchestrator!.settled();

  const manifest = await readRunManifest(dir, run.runId);
  expect(manifest).not.toBeNull();
  const alpha = manifest!.cases.find((item) => item.caseId === "alpha")!;
  // Критерий P0-3: эффективная политика случая — снимком и хэшем, а не одним хэшем.
  expect(alpha.verdictPolicy!.hash).toMatch(/^[0-9a-f]{64}$/);
  // Квитанция — часть доказательства, а не только API-ответа; её `verdictPolicy` адресует ровно
  // тот снимок, что лежит рядом в манифесте.
  expect(alpha.reuseReceipt).toMatchObject({
    reuse: { candidate: false, frame: false, verdict: false },
    fingerprints: { verdictPolicy: alpha.verdictPolicy!.hash },
  });
  expect((alpha.reuseReceipt!.fingerprints as { case: string }).case).toMatch(/^[0-9a-f]{64}$/);
  expect(alpha.verdictPolicy!.snapshot).toMatchObject({
    policyProfileId: "default-v1", requireVisual: false,
    expectedGeometry: { width: 140, height: 96 },
  });
  // Снимок и хэш согласованы по построению — сверка тем же алгоритмом, что и в раннере.
  expect(verdictPolicyHashOf(alpha.verdictPolicy!.snapshot)).toBe(alpha.verdictPolicy!.hash);
  // Случай без per-case габаритов несёт свой снимок, а не снимок соседа.
  const beta = manifest!.cases.find((item) => item.caseId === "beta")!;
  expect(beta.verdictPolicy!.snapshot.expectedGeometry).toBeNull();
  expect(beta.verdictPolicy!.hash).not.toBe(alpha.verdictPolicy!.hash);
}, 180_000);
