import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { readinessGate } from "./readiness";
import { renderReadinessKey } from "./render";
import type { CandidateSubject, GateContext } from "./types";
import { ACCEPTANCE_POLICIES } from "../policies";
import { readinessPolicyHashOf } from "../ids";
import { barrierAwareReadinessPolicy } from "../../capture/resourceBarrier";

/**
 * W2 (план 2026-08-07 §1.5): факт исполнения барьера ресурсов едет **эхом** в
 * `readiness.evidence.resourceBarrier` и обязателен для гейта при v3-политике.
 *
 * Предмет теста — ровно один вопрос: отличима ли «политика не доехала до поверхности» от
 * «барьер исполнен и всё чисто». Без этой проверки кадр, снятый шеллом, который проигнорировал
 * bootstrap (старый бандл, сброшенный `__EUI_CAPTURE_BOOTSTRAP__`), молча получал бы `pass` —
 * то есть волна считалась бы раскатанной там, где она не исполняется.
 */

const dirs: string[] = [];
afterAll(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });

const CASE_ID = "alpha";

async function context(options: {
  policyId?: keyof typeof ACCEPTANCE_POLICIES;
  met?: boolean;
  evidence?: Record<string, unknown>;
}): Promise<GateContext> {
  const dir = await mkdtemp(resolve(process.cwd(), ".readiness-test-"));
  dirs.push(dir);
  const policy = ACCEPTANCE_POLICIES[options.policyId ?? "default-v1"];
  const shared = new Map<string, unknown>();
  shared.set(renderReadinessKey(CASE_ID), {
    readinessMet: options.met ?? true,
    readinessReason: null,
    readinessCodes: [],
    readinessPolicyHash: readinessPolicyHashOf(policy.readiness),
    readinessEvidence: options.evidence ?? {},
    observedCaptureEnvFingerprint: null,
    observedCaptureEnv: null,
  });
  return {
    db: null as unknown as Database,
    dataDir: dir,
    service: null as unknown as GateContext["service"],
    policy,
    runId: "acc_00000000-0000-4000-8000-000000000000",
    candidate: { componentId: "c", rev: 1, sourceHash: "src" } as unknown as CandidateSubject,
    case: { caseId: CASE_ID, caseKey: CASE_ID, props: {}, propsHash: "ph", aliasOfCaseId: null } as GateContext["case"],
    surface: { viewport: { width: 390, height: 844 }, dsf: 2, theme: "light" },
    determinismSampled: false,
    shared,
    sleep: () => Promise.resolve(),
    now: () => Date.now(),
  };
}

const BARRIER_EVIDENCE = {
  resourceBarrier: { expected: 3, decoded: 3, fontsReady: true, stableFrames: 2, lateAfterBarrier: [], durationMs: 640 },
};

test("v3-политика без эха барьера не получает pass, даже при met:true", async () => {
  const result = await readinessGate.run(await context({ met: true, evidence: {} }));
  expect(result.status).toBe("indeterminate");
  expect(result.detail).toContain("resource barrier");
  expect(result.metrics?.resourceBarrier).toBeNull();
});

test("v3-политика с эхом барьера проходит и кладёт блок в метрики", async () => {
  const result = await readinessGate.run(await context({ met: true, evidence: BARRIER_EVIDENCE }));
  expect(result.status).toBe("pass");
  expect(result.metrics?.resourceBarrier).toMatchObject({ expected: 3, decoded: 3, fontsReady: true });
});

test("доволновая политика эха не требует: отказ ровно там, где барьер объявлен", () => {
  // Отдельная проверка предиката, а не второго профиля: оба профиля волной переведены на v3, и
  // «политика без барьера» существует теперь только под kill-switch'ем.
  const preWave = barrierAwareReadinessPolicy("acceptance-default", true);
  expect(preWave.resourceBarrier).toBeUndefined();
  expect(ACCEPTANCE_POLICIES["default-v1"].readiness.resourceBarrier).toBeDefined();
});
