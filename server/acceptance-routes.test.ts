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
import type { AcceptanceCaptureService } from "./acceptance/gates/types";
import type { JobOutcome, JobStatus, ScreenshotResult } from "./screenshot/service";

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

const imageBytes = (bytes: Uint8Array): ScreenshotResult => ({
  kind: "image-bytes",
  bytes, width: 10, height: 10, imageProduced: true,
  consoleErrors: [], pageErrors: [], captureClean: true,
  productErrors: [], infraNoise: [], runtimeWarnings: [],
  rendererBuild: null, browserVersion: "test/1",
} as unknown as ScreenshotResult);

const geometryResult = (): ScreenshotResult => ({
  kind: "geometry", surface: "component", componentId: COMPONENT_ID, draftRev: 1, bundleHash: "bundle",
  designSystemMetaVersion: null, resolvedSpaceScale: {}, viewport: { width: 390, height: 844 }, dpr: 2,
  captureClean: true, productErrors: [], infraNoise: [], runtimeWarnings: [],
  rects: [], truncated: false, total: 0,
} as unknown as ScreenshotResult);

/** Детерминированный капчур: кадр зависит только от props, поэтому `determinism` даёт `pass`. */
class FakeCapture implements AcceptanceCaptureService {
  private statuses = new Map<string, JobStatus>();
  private outcomes = new Map<string, JobOutcome>();
  calls = 0;

  enqueueComponentCandidate(
    _id: string,
    _candidate: { rev: number; sourceHash: string },
    opts: { props?: Record<string, unknown>; probe?: "geometry"; viewport: unknown },
  ): Promise<{ jobId: string }> {
    const jobId = `job_${++this.calls}`;
    if (opts.probe === "geometry") {
      this.statuses.set(jobId, { status: "done", result: geometryResult() });
    } else {
      const bytes = new Uint8Array([...PNG, ...new TextEncoder().encode(JSON.stringify(opts.props ?? {}))]);
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
    : new AcceptanceOrchestrator({ db, dataDir: dir, service, autoDrain: options.autoDrain !== false });
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
interface RunView { status: string; progress: { total: number; completed: number; reused: number }; failedCases: unknown[]; gates: Record<string, unknown> }

test("флаг OFF: весь набор acceptance-ручек отвечает 404", async () => {
  const { handler } = await setup({ matrix: false });
  const runId = "acc_00000000-0000-0000-0000-000000000000";
  const calls: [string, string, unknown?][] = [
    [`/components/${COMPONENT_ID}/candidates`, "POST"],
    [`/component-candidates/cand_${"0".repeat(64)}`, "GET"],
    ["/acceptance-runs", "POST", { candidateId: `cand_${"0".repeat(64)}` }],
    [`/acceptance-runs/${runId}`, "GET"],
    [`/acceptance-runs/${runId}/cases`, "GET"],
    [`/acceptance-runs/${runId}/evidence`, "GET"],
    [`/acceptance-runs/${runId}/cancel`, "POST", {}],
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
  // Админ читает чужой ран: тот же short-circuit `requireResourceOwner`, что и везде.
  const adminPrincipal: Principal = { kind: "user", userId: BOOTSTRAP_ADMIN_ID, name: "Test Admin", isAdmin: true };
  const asAdmin = await call(adminPrincipal, `/acceptance-runs/${run.runId}`);
  expect(asAdmin!.status).toBe(200);
}, 120_000);

test("постановка рана: unsupported_option, unknown_policy_profile и 503 под maintenance-lock", async () => {
  const { db, handler } = await setup();
  const candidate = await jsonOf<CandidateBody>(await handler(req(`/components/${COMPONENT_ID}/candidates`, "POST")));

  for (const body of [
    { candidateId: candidate.candidateId, caseSetId: "cset_x" },
    { candidateId: candidate.candidateId, manifestAssetId: "asset_x" },
    { candidateId: candidate.candidateId, concurrency: 4 },
    { candidateId: candidate.candidateId, cases: { concurrency: 4 } },
    { candidateId: candidate.candidateId, refresh: "failed" },
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
