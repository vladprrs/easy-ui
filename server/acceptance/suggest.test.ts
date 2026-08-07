import { expect, test } from "bun:test";
import { ACCEPTANCE_POLICIES, policyProfileHash } from "./policies";
import { annotateCauses } from "./runner";
import type { GateResult } from "./gates/types";
import {
  SUGGEST_MAX_RAW_DIFF_PCT, declaredExceptionsOf, groupSuggestion, isPostBarrierRun,
  policyExceptionWarnings, suggestPolicy, suggestedPolicyEnabled,
  type PolicyExceptionHistoryRow, type SuggestGate, type SuggestedPolicy,
} from "./suggest";

// W7 (план 2026-08-07 §W7, P1.3): предложение минимальной правки бюджета и advisory-expiry.

const PROFILE = ACCEPTANCE_POLICIES["default-v1"];

/**
 * Метрики визуального гейта, на которых причиной становится **растровый остаток**: расхождение
 * мало, лучшего смещения нет (иначе первым назовётся `geometry-shift`), и весь остаток лежит на
 * контурах эталона (`edgeResidual.insidePct` ≥ 95).
 */
const rasterMetrics = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  required: true,
  maxRawDiffPct: PROFILE.visual.maxRawDiffPct,
  rawDiffPct: 0.6,
  aaDiffPct: 0.1,
  maxChannelDelta: 12,
  regions: [],
  totalRegions: 5,
  bestOffset: { dx: 0, dy: 0, residualPct: 0 },
  edgeResidual: { residualPixels: 120, insidePixels: 119, outsidePixels: 1, insidePct: 99 },
  referenceAssetId: "asset_ref",
  ...overrides,
});

/** Гейты провального случая: визуальный `fail` с причинами, посчитанными настоящим классификатором. */
function failingGates(metrics: Record<string, unknown>, extra: GateResult[] = []): GateResult[] {
  const gates: GateResult[] = [{ gate: "visual", status: "fail", metrics }, ...extra];
  annotateCauses(gates, 2, { caseId: "alpha", rendererFingerprint: "rf-current" });
  return gates;
}

const visualOf = (gates: GateResult[]): GateResult => gates.find((gate) => gate.gate === "visual")!;

test("textAa-провал: предложен минимальный накрывающий пресет, а не свободное число", () => {
  const gates = failingGates(rasterMetrics());
  expect(visualOf(gates).causes?.[0]?.code).toBe("text-raster-residual");

  const suggestion = visualOf(gates).suggestedPolicy;
  expect(suggestion).toMatchObject({
    kind: "textAaBudget",
    textAaBudget: "live-text-v1",
    scope: "case-id",
    caseIds: ["alpha"],
    requiresHumanJudgement: true,
  });
  // Предложение — производная фактов, а не пересказ: evidence несёт измерения, expiry — рендерер.
  expect(suggestion!.evidence).toMatchObject({
    topCause: "text-raster-residual", rawDiffPct: 0.6, edgeResidualInsidePct: 99,
    geometryClean: true, rendererFingerprint: "rf-current",
  });
  expect(suggestion!.expiry).toMatchObject({
    trigger: "renderer-or-source-fingerprint-change", rendererFingerprint: "rf-current", referenceAssetId: "asset_ref",
  });
  expect(suggestion!.target).toBe("cases[alpha].textAaBudget");
});

test("факт выше любого пресета: предложен минимальный per-case бюджет, накрывающий именно его", () => {
  // Пресет уже объявлен и **не** спас случай (1.23 % > 0.75 %) — второй раз он не предлагается.
  const gates = failingGates(rasterMetrics({
    rawDiffPct: 1.234, maxRawDiffPct: 0.5,
    textAaBudget: { preset: "live-text-v1", maxRawDiffPct: 0.75, minEdgeResidualPct: 95, applied: false },
  }));
  const suggestion = visualOf(gates).suggestedPolicy!;
  expect(suggestion.kind).toBe("maxRawDiffPct");
  // Минимальность: округление вверх до сотых, ни процентом больше.
  expect(suggestion.maxRawDiffPct).toBe(1.24);
  expect(suggestion.target).toBe("policy.perCase.alpha.maxRawDiffPct");
});

test("предложение никогда не мягче самого мягкого профиля реестра", () => {
  expect(SUGGEST_MAX_RAW_DIFF_PCT).toBe(2.0);
  const gates = failingGates(rasterMetrics({ rawDiffPct: SUGGEST_MAX_RAW_DIFF_PCT + 0.5 }));
  expect(visualOf(gates).suggestedPolicy).toBeUndefined();
});

test("структурная топ-причина: предложения нет (AC §9.2)", () => {
  // Сдвиг на 6 px: остаток после лучшего смещения кратно меньше сырого расхождения.
  const shifted = failingGates(rasterMetrics({
    rawDiffPct: 8, aaDiffPct: 7.5, bestOffset: { dx: -6, dy: 0, residualPct: 0.2 },
    edgeResidual: null,
  }));
  expect(visualOf(shifted).causes?.[0]?.code).toBe("geometry-shift");
  expect(visualOf(shifted).suggestedPolicy).toBeUndefined();

  // Растровая визуальная причина, но геометрия случая **не сошлась** (surface-mismatch W1a):
  // бюджет пикселей не waiver'ит несовпавшую поверхность.
  const surfaceMismatch = failingGates(rasterMetrics(), [{
    gate: "geometry", status: "fail",
    metrics: { verdictClass: "surface-mismatch", divergingSurfaces: ["root"] },
  }]);
  expect(visualOf(surfaceMismatch).causes?.[0]?.code).toBe("text-raster-residual");
  expect(visualOf(surfaceMismatch).suggestedPolicy).toBeUndefined();
});

test("небюджетируемая причина и недоказанный остаток: предложения нет", () => {
  // Заливка по всей поверхности — разница, а не шум.
  const tint = failingGates(rasterMetrics({
    rawDiffPct: 60, aaDiffPct: 59, totalRegions: 1, edgeResidual: null,
    channelStats: {
      pixels: 100, meanDelta: { r: 10, g: 10, b: 10, a: 0 },
      meanMaxDelta: 10, stdMaxDelta: 2, alphaDominantPct: 0, semiTransparentPct: 0,
    },
  }));
  expect(visualOf(tint).causes?.[0]?.code).toBe("surface-tint");
  expect(visualOf(tint).suggestedPolicy).toBeUndefined();

  // «Не измерено» — не «в допуске»: без `edgeResidual` пресет не предлагается (тот же инвариант,
  // что у гейта). Причина при этом всё равно называется — доволновой AA-эвристикой.
  const unmeasured = failingGates(rasterMetrics({
    edgeResidual: null, totalRegions: 5,
    regions: [{ bbox: { x: 0, y: 0, width: 2, height: 2 }, areaPct: 1, meanDelta: 10 }],
  }));
  expect(visualOf(unmeasured).causes?.[0]?.code).toBe("text-raster-residual");
  expect(visualOf(unmeasured).suggestedPolicy).toBeUndefined();
});

test("indeterminate и pass не получают предложения: объяснять и предлагать нечего", () => {
  const indeterminate: SuggestGate[] = [{
    gate: "visual", status: "indeterminate",
    metrics: { reason: "dimensions_irreconcilable" },
    causes: [{ code: "unclassified", confidence: 0.2, detail: "-" }],
  }];
  expect(suggestPolicy(indeterminate, { caseId: "alpha" })).toBeNull();
  expect(suggestPolicy([{ gate: "visual", status: "pass", metrics: rasterMetrics() }], { caseId: "alpha" })).toBeNull();
});

test("reused-строка: предложение пересчитывается вместе с причинами и не переживает их", () => {
  // Строка кэша принесла причины и предложение прошлой политики; после пересчёта метрики говорят
  // о структурном сдвиге — старое предложение обязано исчезнуть вместе со старой причиной.
  const stale = visualOf(failingGates(rasterMetrics())).suggestedPolicy!;
  expect(stale.kind).toBe("textAaBudget");
  const reused: GateResult[] = [{
    gate: "visual", status: "fail",
    metrics: rasterMetrics({ rawDiffPct: 8, aaDiffPct: 7.5, bestOffset: { dx: -6, dy: 0, residualPct: 0.2 }, edgeResidual: null }),
    causes: [{ code: "text-raster-residual", confidence: 0.88, detail: "stale" }],
    suggestedPolicy: stale,
  }];
  annotateCauses(reused, 2, { caseId: "alpha", rendererFingerprint: "rf-current" });
  expect(visualOf(reused).causes?.[0]?.code).toBe("geometry-shift");
  expect(visualOf(reused).suggestedPolicy).toBeUndefined();

  // И обратно: пересчёт, вернувший бюджетируемую причину, обязан вернуть и предложение — согласованное
  // с **пересчитанными** причинами, а не с теми, что лежали в кэше.
  const back: GateResult[] = [{
    gate: "visual", status: "fail", metrics: rasterMetrics(),
    causes: [{ code: "geometry-shift", confidence: 0.9, detail: "stale" }],
  }];
  annotateCauses(back, 2, { caseId: "alpha", rendererFingerprint: "rf-current" });
  expect(visualOf(back).causes?.[0]?.code).toBe("text-raster-residual");
  expect(visualOf(back).suggestedPolicy).toMatchObject({ kind: "textAaBudget", caseIds: ["alpha"] });
  expect(visualOf(back).suggestedPolicy!.evidence.topCause).toBe(visualOf(back).causes![0]!.code);
});

test("kill-switch EASYUI_SUGGESTED_POLICY_DISABLED=1 гасит предложение, но не причины", () => {
  expect(suggestedPolicyEnabled("1")).toBe(false);
  expect(suggestedPolicyEnabled(undefined)).toBe(true);
  const previous = process.env.EASYUI_SUGGESTED_POLICY_DISABLED;
  process.env.EASYUI_SUGGESTED_POLICY_DISABLED = "1";
  try {
    const gates = failingGates(rasterMetrics());
    expect(visualOf(gates).causes?.[0]?.code).toBe("text-raster-residual");
    expect(visualOf(gates).suggestedPolicy).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.EASYUI_SUGGESTED_POLICY_DISABLED;
    else process.env.EASYUI_SUGGESTED_POLICY_DISABLED = previous;
  }
});

// ------------------------------------------------------------------ группировка по remediationKey

test("группа ремедиаций получает одну правку на всех — и только при однородности", () => {
  const alpha = visualOf(failingGates(rasterMetrics())).suggestedPolicy!;
  const beta: SuggestedPolicy = { ...alpha, caseIds: ["beta"], target: "cases[beta].textAaBudget" };
  const group = groupSuggestion("rk_1", [alpha, beta])!;
  expect(group).toMatchObject({ scope: "remediation-group", remediationKey: "rk_1", kind: "textAaBudget" });
  expect(group.caseIds).toEqual(["alpha", "beta"]);

  const wide = visualOf(failingGates(rasterMetrics({
    rawDiffPct: 1.5, maxRawDiffPct: 0.5,
    textAaBudget: { preset: "live-text-v1", maxRawDiffPct: 0.75, minEdgeResidualPct: 95, applied: false },
  }))).suggestedPolicy!;
  const wider = visualOf(failingGates(rasterMetrics({
    rawDiffPct: 1.9, maxRawDiffPct: 0.5,
    textAaBudget: { preset: "live-text-v1", maxRawDiffPct: 0.75, minEdgeResidualPct: 95, applied: false },
  }))).suggestedPolicy!;
  // Значение группы накрывает **всех** её участников по построению.
  expect(groupSuggestion("rk_2", [wide, wider])!.maxRawDiffPct).toBe(1.9);
  // Разнородная группа предложения не получает: склейка соврала бы про её однородность.
  expect(groupSuggestion("rk_3", [alpha, wide])).toBeNull();
  expect(groupSuggestion("rk_4", [])).toBeNull();
});

// ------------------------------------------------------------------ advisory expiry (AC §9.3)

const CURRENT_HASH = policyProfileHash(PROFILE);
const PRE_WAVE_HASH = "0".repeat(64);

/** Случай, прошедший под объявленным пресетом. */
const budgetedCase = (caseId: string) => ({
  caseId, verdict: "pass" as string | null,
  gates: [{
    gate: "visual", status: "pass",
    metrics: {
      maxRawDiffPct: PROFILE.visual.maxRawDiffPct,
      textAaBudget: { preset: "live-text-v1", maxRawDiffPct: 0.75, minEdgeResidualPct: 95, applied: true },
    },
  }] as SuggestGate[],
});

const historyRow = (overrides: Partial<PolicyExceptionHistoryRow>): PolicyExceptionHistoryRow => ({
  runId: "acc_old", createdAt: "2026-08-01T00:00:00.000Z", rendererFingerprint: "rf-old",
  policyProfileId: "default-v1", policyProfileHash: CURRENT_HASH,
  caseId: "alpha", gates: budgetedCase("alpha").gates,
  ...overrides,
});

const currentRun = { runId: "acc_new", rendererFingerprint: "rf-current", policyProfileId: "default-v1", policyProfileHash: CURRENT_HASH };

test("дискриминатор пост-W2: baseline — только раны под сегодняшним хэшем профиля", () => {
  expect(isPostBarrierRun(currentRun)).toBe(true);
  expect(isPostBarrierRun({ ...currentRun, policyProfileHash: PRE_WAVE_HASH })).toBe(false);
  expect(isPostBarrierRun({ ...currentRun, policyProfileId: "gone-v1" })).toBe(false);
});

test("policy_exception_stale: рендерер сменился с тех пор, как исключение приняли", () => {
  const warnings = policyExceptionWarnings({
    run: currentRun, cases: [budgetedCase("alpha")], history: [historyRow({})],
  });
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatchObject({
    code: "policy_exception_stale", caseId: "alpha", exceptions: ["textAaBudget"],
    baselineRunId: "acc_old", baselineRendererFingerprint: "rf-old", rendererFingerprint: "rf-current",
  });

  // Тот же рендерер — исключение свежее, предупреждать не о чем.
  expect(policyExceptionWarnings({
    run: currentRun, cases: [budgetedCase("alpha")], history: [historyRow({ rendererFingerprint: "rf-current" })],
  })).toEqual([]);
});

test("доволновой baseline в сравнении не участвует: ложного stale на период пересъёмки нет (N8)", () => {
  // Ран с доволновой readiness-политикой несёт другой `policy_profile_hash` — и baseline'ом не
  // становится. Иначе W2, сдвинувшая rendererFingerprint, объявила бы устаревшими все бюджеты.
  expect(policyExceptionWarnings({
    run: currentRun,
    cases: [budgetedCase("alpha")],
    history: [historyRow({ policyProfileHash: PRE_WAVE_HASH })],
  })).toEqual([]);

  // Первым пост-W2 раном становится следующий: baseline — самый ранний **пост-W2**, а не самый ранний.
  const warnings = policyExceptionWarnings({
    run: currentRun,
    cases: [budgetedCase("alpha")],
    history: [
      historyRow({ runId: "acc_pre", policyProfileHash: PRE_WAVE_HASH, rendererFingerprint: "rf-ancient" }),
      historyRow({ runId: "acc_post", createdAt: "2026-08-06T00:00:00.000Z", rendererFingerprint: "rf-old" }),
    ],
  });
  expect(warnings.map((item) => item.baselineRunId)).toEqual(["acc_post"]);
});

test("без исключения, без рендерера и без прохождения предупреждения не выдаются", () => {
  // Случай без объявленного бюджета — обычный pass.
  const plain = { caseId: "alpha", verdict: "pass" as string | null, gates: [{ gate: "visual", status: "pass", metrics: { maxRawDiffPct: PROFILE.visual.maxRawDiffPct } }] as SuggestGate[] };
  expect(policyExceptionWarnings({ run: currentRun, cases: [plain], history: [historyRow({})] })).toEqual([]);
  // Провалившийся случай не «протухшее исключение», а провал.
  expect(policyExceptionWarnings({
    run: currentRun, cases: [{ ...budgetedCase("alpha"), verdict: "fail" }], history: [historyRow({})],
  })).toEqual([]);
  // «Неизвестно» (ран до v30) — не «другой».
  expect(policyExceptionWarnings({ run: { ...currentRun, rendererFingerprint: null }, cases: [budgetedCase("alpha")], history: [historyRow({})] })).toEqual([]);
  expect(policyExceptionWarnings({ run: currentRun, cases: [budgetedCase("alpha")], history: [historyRow({ rendererFingerprint: null })] })).toEqual([]);
});

test("объявленные исключения читаются из метрик, а не из недоступного манифеста", () => {
  expect(declaredExceptionsOf(budgetedCase("alpha").gates, PROFILE)).toEqual(["textAaBudget"]);
  expect(declaredExceptionsOf([
    { gate: "visual", status: "pass", metrics: { maxRawDiffPct: 0.9 } },
    { gate: "geometry", status: "pass", metrics: { sizeTolerancePx: 6, overflowBudgetPx: { top: 2 } } },
  ], PROFILE)).toEqual(["maxRawDiffPct", "sizeDeltaPx", "overflowBudgetPx"]);
  // Профильные значения исключением не являются.
  expect(declaredExceptionsOf([
    { gate: "visual", status: "pass", metrics: { maxRawDiffPct: PROFILE.visual.maxRawDiffPct } },
    { gate: "geometry", status: "pass", metrics: { sizeTolerancePx: PROFILE.geometry.sizeDeltaPx, overflowBudgetPx: null } },
  ], PROFILE)).toEqual([]);
});
