import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { barrierIncompleteOf, readinessBlocksVisual, readinessGate } from "./readiness";
import { renderReadinessKey } from "./render";
import type { CandidateSubject, GateContext } from "./types";
import { ACCEPTANCE_POLICIES } from "../policies";
import { readinessPolicyHashOf } from "../ids";
import { barrierAwareReadinessPolicy } from "../../capture/resourceBarrier";
import type { ReadinessPolicy } from "../../../src/capture/readinessPolicy";

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
  reason?: string | null;
  codes?: { code: string; severity: string; detail: string; ref?: string }[];
  /** BR-03: политика случая целиком (для проверки поведения под v4-свитчём). */
  readiness?: ReadinessPolicy;
}): Promise<GateContext> {
  const dir = await mkdtemp(resolve(process.cwd(), ".readiness-test-"));
  dirs.push(dir);
  const base = ACCEPTANCE_POLICIES[options.policyId ?? "default-v1"];
  const policy = options.readiness === undefined ? base : { ...base, readiness: options.readiness };
  const shared = new Map<string, unknown>();
  shared.set(renderReadinessKey(CASE_ID), {
    readinessMet: options.met ?? true,
    readinessReason: options.reason ?? null,
    readinessCodes: options.codes ?? [],
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

// ------------------------------------- BR-03: сужение вердикта на барьерных причинах (§3, ревью M7)

/** Доказательство v4: барьер объявил три ресурса, доказал два, один приехал после барьера. */
const LATE_EVIDENCE = {
  resourceBarrier: {
    expected: 3, decoded: 2, fontsReady: true, stableFrames: 2,
    lateAfterBarrier: ["/api/assets/asset_late"], durationMs: 700,
    policyVersion: 4,
    registry: { iconsExpected: 4, iconsObserved: 4, waitedMs: 12, timedOut: false },
    resources: [{
      assetId: "asset_late", ownerElementKey: "root/0", ownerComponentId: null,
      channel: "icon-registry", discoveredAt: "request", url: "/api/assets/asset_late",
      requested: false, loaded: false, decoded: false, completedBeforeStableFrame: false, phase: "rediff",
    }],
  },
};

test("BR-03: барьерная причина сужает вердикт до indeterminate с resource_barrier_incomplete", async () => {
  const ctx = await context({
    met: false,
    reason: "resource_late_after_barrier",
    codes: [{ code: "resource_late_after_barrier", severity: "error", detail: "late", ref: "/api/assets/asset_late" }],
    evidence: LATE_EVIDENCE,
  });
  const result = await readinessGate.run(ctx);
  expect(result.status).toBe("indeterminate");
  const codes = result.metrics?.codes as { code: string; ref?: string }[];
  expect(codes.map((code) => code.code)).toContain("resource_barrier_incomplete");
  expect(codes.find((code) => code.code === "resource_barrier_incomplete")?.ref)
    .toBe("resource_late_after_barrier(/api/assets/asset_late)");
  // Пер-ресурсная запись доезжает до метрик гейта: недогруженный ассет назван поимённо.
  expect((result.metrics?.resourceBarrier as { resources: unknown[] }).resources).toHaveLength(1);

  // **Инвариант волны** (ревью minor раунда 2): сужение статуса гейта не трогает D5 — `met`
  // остаётся `false`, поэтому раннер пропускает сравнивающие гейты случая. «Capture не становится
  // visual evidence» держится именно на этом, а не на статусе гейта.
  expect(readinessBlocksVisual(ctx)).toBe(true);
});

test("BR-03: не-барьерная причина остаётся fail, даже вместе с барьерной", async () => {
  const fonts = await readinessGate.run(await context({
    met: false, reason: "fonts_timeout", evidence: LATE_EVIDENCE,
    codes: [{ code: "font_load_failed", severity: "error", detail: "fonts" }],
  }));
  expect(fonts.status).toBe("fail");
  // Одна барьерная причина не имеет права прятать вторую, не барьерную.
  const mixed = await readinessGate.run(await context({
    met: false, reason: "resource_late_after_barrier,fonts_timeout", evidence: LATE_EVIDENCE,
    codes: [{ code: "resource_late_after_barrier", severity: "error", detail: "late" }],
  }));
  expect(mixed.status).toBe("fail");
  // Исчерпанный бюджет барьера — свойство страницы, а не инфраструктуры: тоже `fail` (см. §3).
  const timeout = await readinessGate.run(await context({
    met: false, reason: "resource_barrier_timeout", evidence: LATE_EVIDENCE,
    codes: [{ code: "resource_barrier_timeout", severity: "error", detail: "budget" }],
  }));
  expect(timeout.status).toBe("fail");
});

test("BR-03: под v4-свитчём (политика v3) барьерная причина судится доволновым fail", async () => {
  const result = await readinessGate.run(await context({
    met: false, reason: "resource_late_after_barrier",
    readiness: barrierAwareReadinessPolicy("acceptance-default", false, true),
    codes: [{ code: "resource_late_after_barrier", severity: "error", detail: "late" }],
    evidence: { resourceBarrier: { expected: 3, decoded: 2, fontsReady: true, stableFrames: 2, lateAfterBarrier: ["/api/assets/asset_late"], durationMs: 700 } },
  }));
  expect(result.status).toBe("fail");
  expect((result.metrics?.codes as { code: string }[]).map((code) => code.code)).not.toContain("resource_barrier_incomplete");
});

test("BR-03: expected≠decoded — третья барьерная причина контракта", () => {
  expect(barrierIncompleteOf("resource_decode_failed", { expected: 3, decoded: 2 }))
    .toEqual({ incomplete: true, expectedMismatch: true });
  // Причин нет вовсе — сужение держится на самом расхождении.
  expect(barrierIncompleteOf(null, { expected: 3, decoded: 2 }).incomplete).toBe(true);
  expect(barrierIncompleteOf(null, { expected: 3, decoded: 3 }).incomplete).toBe(false);
  expect(barrierIncompleteOf("layout_unstable", { expected: 3, decoded: 3 }).incomplete).toBe(false);
});
