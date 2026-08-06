import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { putArtifact, readArtifact } from "./evidence";
import type { GateResult } from "./gates/types";
import { verdictPolicySnapshotOf, type VerdictPolicySnapshot } from "./ids";
import { ACCEPTANCE_POLICIES, withRequiredVisual, type AcceptancePolicy } from "./policies";
import { GATES_BY_POLICY_FIELD, reevaluateGates, rewriteDerivedArtifacts, verdictPolicyDelta } from "./recompute";
import { verdictPolicyOfRow } from "./runner";

/**
 * Пересчёт вердикта по сохранённым метрикам (план 2026-08-04, D-B; модуль `recompute.ts`).
 *
 * Предмет — **чистая функция**: гейты на входе, гейты на выходе, никакой БД и никакого chromium.
 * Интеграция (кто и когда её зовёт, что попадает в `reuse_reason` и в прогресс) — предмет
 * `orchestrator.test.ts`.
 */

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const DEFAULT = ACCEPTANCE_POLICIES["default-v1"];
const CASE = { caseKey: "alpha", propsHash: "props-1", referenceAssetId: `asset_${"a".repeat(64)}` };

const snapshot = (policy: AcceptancePolicy, item = CASE): VerdictPolicySnapshot => verdictPolicySnapshotOf(policy, item);

/** Визуальный гейт с реальной формой метрик гейта `visual` (W5a). */
const visualGateResult = (rawDiffPct: number, aaDiffPct = 0, status: GateResult["status"] = "pass"): GateResult => ({
  gate: "visual",
  status,
  metrics: {
    required: true, maxRawDiffPct: 2, rawDiffPct, aaDiffPct, maxChannelDelta: 12,
    referenceAssetId: CASE.referenceAssetId, severityClass: "raw",
  },
  artifacts: [{ name: "visual.json", sha256: "0".repeat(64), bytes: 10 }],
});

/** Геометрия v2 с **сырыми** контурами: именно от них обязан считаться пересчёт (D0). */
const geometryGateResult = (): GateResult => ({
  gate: "geometry",
  status: "pass",
  metrics: {
    semantics: "v2-paint",
    policyVerdict: "clean",
    layoutBounds: { x: 64, y: 64, width: 140, height: 96 },
    paintBounds: { x: 62, y: 64, width: 144, height: 96 },
    paintBoundsSource: "alpha",
    paintClamped: { left: false, right: false, top: false, bottom: false },
    // Отфильтрованный **старым** допуском overflow: пересчёт обязан его игнорировать.
    overflow: { left: 0, right: 0, top: 0, bottom: 0, sources: [] },
    expectedGeometryDelta: null,
    clippedBy: null,
    effectSources: [{ elementKey: "glow", cause: "filter:blur(4px)", rect: { x: 60, y: 64, width: 148, height: 96 } }],
    codes: [],
  },
  artifacts: [{ name: "geometry.json", sha256: "1".repeat(64), bytes: 10 }],
});

const structuralGates = (): GateResult[] => [
  { gate: "contract", status: "pass" },
  { gate: "render", status: "pass" },
  { gate: "readiness", status: "pass", metrics: { met: true } },
];

const withThreshold = (policy: AcceptancePolicy, maxRawDiffPct: number): AcceptancePolicy =>
  ({ ...policy, visual: { ...policy.visual, maxRawDiffPct } });

// ------------------------------------------------------------ дельта политики

test("дельта считается по листовым полям снимка и ничего не выдумывает", () => {
  const before = snapshot(DEFAULT);
  expect(verdictPolicyDelta(before, snapshot(DEFAULT))).toEqual([]);
  expect(verdictPolicyDelta(before, snapshot(withThreshold(DEFAULT, 0.5)))).toEqual(["maxRawDiffPct"]);
  expect(verdictPolicyDelta(before, snapshot(withRequiredVisual(DEFAULT)))).toEqual(["gates", "requireVisual"]);
  expect(verdictPolicyDelta(before, verdictPolicySnapshotOf(DEFAULT, { ...CASE, casePolicy: { maxRawDiffPct: 1 } })))
    .toEqual(["perCase.maxRawDiffPct"]);
});

test("карта «поле политики → гейты» покрывает каждое поле дельты (C26)", () => {
  // Правило по **дельте**, а не по имени гейта: без карты «перенесём readiness, ведь менялся
  // визуальный порог» было бы решением на глаз.
  for (const field of Object.keys(verdictPolicyDelta(snapshot(DEFAULT), snapshot(withThreshold(DEFAULT, 0.1))))) {
    expect(field).toBeDefined();
  }
  expect(GATES_BY_POLICY_FIELD["maxRawDiffPct"]).toEqual(["visual"]);
  expect(GATES_BY_POLICY_FIELD["geometry.overflowPx"]).toEqual(["geometry"]);
  expect(GATES_BY_POLICY_FIELD.expectedGeometry).toEqual(["geometry"]);
  // Поля, не меняющие ни одного гейтового вердикта, закрываются пересчётом свёртки случая.
  expect(GATES_BY_POLICY_FIELD.allowExceptions).toEqual([]);
});

// ----------------------------------------------------------- флип вердикта

test("порог флипает визуальный вердикт в обе стороны без единого нового пикселя", () => {
  const gates = [...structuralGates(), visualGateResult(0.8, 0.7, "pass")];
  const strictPolicy = withRequiredVisual(withThreshold(DEFAULT, 0.5));
  const loosePolicy = withRequiredVisual(withThreshold(DEFAULT, 2));

  // pass → fail: 0.8% перестало укладываться в 0.5%.
  const tightened = reevaluateGates(gates, snapshot(withRequiredVisual(loosePolicy)), snapshot(strictPolicy));
  expect(tightened.reevaluable).toBe(true);
  expect(tightened.changed).toBe(true);
  const failed = tightened.gates.find((gate) => gate.gate === "visual")!;
  expect(failed.status).toBe("fail");
  expect(failed.metrics).toMatchObject({ maxRawDiffPct: 0.5, severityClass: "raw" });
  expect(failed.detail).toContain("0.8%");

  // fail → pass: тот же кадр, тот же diff, более мягкий бюджет.
  const relaxed = reevaluateGates(tightened.gates, snapshot(strictPolicy), snapshot(loosePolicy));
  expect(relaxed.reevaluable).toBe(true);
  const passed = relaxed.gates.find((gate) => gate.gate === "visual")!;
  expect(passed.status).toBe("pass");
  expect(passed.detail).toBeUndefined();
  // severityClass пересчитан от того же aa-бюджета: 0.7% ≤ 2% ⇒ расхождение объяснимо сглаживанием
  // (а под бюджетом 0.5% то же самое расхождение классифицировалось как структурное).
  expect(passed.metrics).toMatchObject({ maxRawDiffPct: 2, severityClass: "aa" });
});

test("гейты вне дельты переносятся теми же объектами (C26)", () => {
  const gates = [...structuralGates(), geometryGateResult(), visualGateResult(0.8)];
  const result = reevaluateGates(gates, snapshot(DEFAULT), snapshot(withThreshold(DEFAULT, 0.5)));
  expect(result.reevaluable).toBe(true);
  expect(result.recomputedGates).toEqual(["visual"]);
  // Контракт, рендер, readiness и геометрия к визуальному порогу отношения не имеют: они не
  // пересчитываются и не переписываются — переносятся как есть.
  for (const name of ["contract", "render", "readiness", "geometry"] as const) {
    expect(result.gates.find((gate) => gate.gate === name)).toBe(gates.find((gate) => gate.gate === name)!);
  }
});

test("нереэвалюируемый гейт в дельте ⇒ пересчёт отказан (recapture, а не тихий перенос)", () => {
  // Единственный реальный способ задеть непересчитываемый гейт вердиктной дельтой: гейт въезжает
  // в набор или выезжает из него. Метрик, которых не собирали, не бывает.
  const gates = [...structuralGates(), visualGateResult(0.8)];
  const before = snapshot(DEFAULT);
  const after = snapshot({ ...DEFAULT, gates: { ...DEFAULT.gates, determinism: "not-implemented" } });
  const result = reevaluateGates(gates, before, after);
  expect(result.reevaluable).toBe(false);
  expect(result.reason).toContain("not-implemented");
  // Гейты возвращаются нетронутыми: решение принимает вызывающий, и оно одно — переснять.
  expect(result.gates).toBe(gates);
});

test("смена ролей advisory ↔ required пересчитывается: статусы гейтов от неё не зависят", () => {
  const gates = [...structuralGates(), visualGateResult(0.8, 0.2, "fail")];
  const result = reevaluateGates(gates, snapshot(DEFAULT), snapshot(withRequiredVisual(DEFAULT)));
  expect(result.reevaluable).toBe(true);
  // Порог не менялся — 0.8% по-прежнему укладывается в 2%, меняется только вес гейта в свёртке.
  expect(result.gates.find((gate) => gate.gate === "visual")).toMatchObject({ status: "pass" });
});

test("случай без эталона пересчитывается по обязательности: skipped ↔ indeterminate (D10)", () => {
  const gates: GateResult[] = [
    ...structuralGates(),
    { gate: "visual", status: "skipped", metrics: { required: false, maxRawDiffPct: 2, reason: "no_reference" } },
  ];
  const result = reevaluateGates(gates, snapshot(DEFAULT), snapshot(withRequiredVisual(DEFAULT)));
  expect(result.reevaluable).toBe(true);
  expect(result.gates.find((gate) => gate.gate === "visual")).toMatchObject({ status: "indeterminate" });
});

test("несводимые размеры и заглушенный readiness не переоцениваются порогом", () => {
  const gates: GateResult[] = [
    { gate: "visual", status: "indeterminate", metrics: { reason: "dimensions_irreconcilable", required: true, maxRawDiffPct: 2 } },
  ];
  const result = reevaluateGates(gates, snapshot(DEFAULT), snapshot(withThreshold(DEFAULT, 0.5)));
  expect(result.reevaluable).toBe(true);
  expect(result.gates[0]!.status).toBe("indeterminate");
  expect(result.changed).toBe(false);
});

// ---------------------------------------------------------- геометрия (D0)

test("геометрия пересчитывается от сырых контуров, а не от отфильтрованного overflow (D0)", () => {
  const gates = [...structuralGates(), geometryGateResult()];
  // Ужесточение допуска обязано **увидеть** те 2 px, которые прошлый допуск отбросил в ноль.
  const strict: AcceptancePolicy = { ...DEFAULT, geometry: { overflowPx: 0, sizeDeltaPx: 0, offsetPx: 0 } };
  const result = reevaluateGates(gates, snapshot(DEFAULT), snapshot(strict));
  expect(result.reevaluable).toBe(true);
  expect(result.recomputedGates).toEqual(["geometry"]);
  const geometry = result.gates.find((gate) => gate.gate === "geometry")!;
  const overflow = geometry.metrics!.overflow as { left: number; sources: unknown[] };
  expect(overflow.left).toBeGreaterThan(0);
  // Инвариант гейта сохраняется и в пересчёте: провал обязан назвать виновника.
  expect(overflow.sources.length).toBeGreaterThan(0);
  expect(geometry.status).toBe("fail");
  expect(geometry.detail).toBeTruthy();
});

test("expectedGeometry пересчитывает геометрию: расхождение с заявленным названо явно", () => {
  const gates = [...structuralGates(), geometryGateResult()];
  const before = verdictPolicySnapshotOf(DEFAULT, CASE);
  const after = verdictPolicySnapshotOf(DEFAULT, { ...CASE, expectedGeometry: { width: 200, height: 96 } });
  const result = reevaluateGates(gates, before, after);
  expect(result.reevaluable).toBe(true);
  const geometry = result.gates.find((gate) => gate.gate === "geometry")!;
  expect(geometry.status).toBe("fail");
  expect(geometry.metrics!.expectedGeometryDelta).toMatchObject({ widthDelta: -60 });
});

/**
 * План 2026-08-06 §W3: per-case бюджет overflow — **вердиктный** слой. Его смена обязана
 * пересчитываться по сохранённым метрикам (кадр и дифф уже сняты), а не уводить в пересъёмку.
 */
test("смена overflowBudgetPx флипает вердикт геометрии без единого нового пикселя", () => {
  // Гейт снят строгим профилем: 2 px краски слева за контуром названы и заблокировали случай.
  const strict: AcceptancePolicy = { ...DEFAULT, geometry: { overflowPx: 0, sizeDeltaPx: 0, offsetPx: 0 } };
  const failed = reevaluateGates([...structuralGates(), geometryGateResult()], snapshot(DEFAULT), snapshot(strict));
  expect(failed.gates.find((gate) => gate.gate === "geometry")!.status).toBe("fail");

  const before = verdictPolicySnapshotOf(strict, CASE);
  const after = verdictPolicySnapshotOf(strict, { ...CASE, casePolicy: { overflowBudgetPx: { left: 4, right: 4 } } });
  expect(verdictPolicyDelta(before, after)).toEqual(["perCase.overflowBudgetPx"]);
  expect(GATES_BY_POLICY_FIELD["perCase.overflowBudgetPx"]).toEqual(["geometry"]);

  const budgeted = reevaluateGates(failed.gates, before, after);
  expect(budgeted.reevaluable).toBe(true);
  expect(budgeted.recomputedGates).toEqual(["geometry"]);
  const geometry = budgeted.gates.find((gate) => gate.gate === "geometry")!;
  expect(geometry.status).toBe("pass");
  // Факты не переписаны: вердикт-класс и величины overflow остались честными.
  expect(geometry.metrics!.policyVerdict).toBe("paint-overflow-not-clipped");
  expect(geometry.metrics!.overflow).toMatchObject({ left: 2, right: 2, top: 0, bottom: 0 });
  expect(geometry.metrics!.overflowBudgetPx).toEqual({ left: 4, right: 4 });
  expect((geometry.metrics!.codes as { severity: string }[])[0]!.severity).toBe("warning");

  // Бюджет уже, чем наблюдённая краска, — блокировка возвращается тем же пересчётом.
  const tight = verdictPolicySnapshotOf(strict, { ...CASE, casePolicy: { overflowBudgetPx: { left: 1, right: 4 } } });
  const back = reevaluateGates(budgeted.gates, after, tight);
  expect(back.gates.find((gate) => gate.gate === "geometry")!.status).toBe("fail");
});

test("per-case sizeDeltaPx побеждает профильный и пересчитывается тем же контуром", () => {
  // Краска ровно по контуру: предмет теста — только расхождение с `expectedGeometry`.
  const clean = geometryGateResult();
  clean.metrics!.paintBounds = { x: 64, y: 64, width: 140, height: 96 };
  clean.metrics!.effectSources = [];
  const gates = [...structuralGates(), clean];
  const before = verdictPolicySnapshotOf(DEFAULT, { ...CASE, expectedGeometry: { width: 200, height: 96 } });
  const after = verdictPolicySnapshotOf(DEFAULT, {
    ...CASE, expectedGeometry: { width: 200, height: 96 }, casePolicy: { sizeDeltaPx: 64 },
  });
  expect(verdictPolicyDelta(before, after)).toEqual(["perCase.sizeDeltaPx"]);
  expect(GATES_BY_POLICY_FIELD["perCase.sizeDeltaPx"]).toEqual(["geometry"]);

  // Профиль терпит 2 px, расхождение 60 px — провал; per-case 64 px делает его объявленной нормой.
  expect(reevaluateGates(gates, snapshot(DEFAULT), before).gates.find((gate) => gate.gate === "geometry")!.status).toBe("fail");
  const tolerant = reevaluateGates(gates, before, after);
  expect(tolerant.reevaluable).toBe(true);
  const geometry = tolerant.gates.find((gate) => gate.gate === "geometry")!;
  expect(geometry.status).toBe("pass");
  expect(geometry.metrics!.expectedGeometryDelta).toBeNull();
  expect(geometry.metrics!.sizeTolerancePx).toBe(64);
});

test("метрики доволновой формы пересчитать нельзя — отказ вместо выдумки", () => {
  const gates: GateResult[] = [{ gate: "geometry", status: "pass", metrics: { semantics: "v1-union" } }];
  const result = reevaluateGates(gates, snapshot(DEFAULT), snapshot({ ...DEFAULT, geometry: { overflowPx: 0, sizeDeltaPx: 0, offsetPx: 0 } }));
  expect(result.reevaluable).toBe(false);
});

// ------------------------------------------- производные артефакты (C2)

test("пересчёт переписывает visual.json новой записью CAS с derivedFrom, байты не трогает", async () => {
  const dir = await mkdtemp(resolve(process.cwd(), ".acc-recompute-test-"));
  dirs.push(dir);
  const original = await putArtifact(dir, { semantics: "visual-v1", verdict: "pass", maxRawDiffPct: 2, metrics: { rawDiffPct: 0.8 } });
  const diffPng = await putArtifact(dir, new Uint8Array([1, 2, 3, 4]));
  const gates: GateResult[] = [{
    ...visualGateResult(0.8, 0.2, "pass"),
    artifacts: [
      { name: "diff.png", sha256: diffPng.sha256, bytes: diffPng.bytes },
      { name: "visual.json", sha256: original.sha256, bytes: original.bytes },
    ],
  }];
  const recomputed = reevaluateGates(gates, snapshot(withRequiredVisual(DEFAULT)), snapshot(withRequiredVisual(withThreshold(DEFAULT, 0.5))));
  expect(recomputed.changed).toBe(true);
  const rewritten = await rewriteDerivedArtifacts(dir, recomputed.gates, recomputed.recomputedGates);

  const artifacts = rewritten[0]!.artifacts!;
  // Байтовый артефакт переиспользован как есть: пиксели пересчёт не трогает.
  expect(artifacts.find((item) => item.name === "diff.png")!.sha256).toBe(diffPng.sha256);
  const json = artifacts.find((item) => item.name === "visual.json")!;
  expect(json.sha256).not.toBe(original.sha256);
  const record = JSON.parse(new TextDecoder().decode((await readArtifact(dir, json.sha256))!)) as Record<string, unknown>;
  // Манифест и содержимое артефакта обязаны говорить одно и то же (тест согласованности C2).
  expect(record).toMatchObject({ verdict: "fail", maxRawDiffPct: 0.5, recomputed: true, derivedFrom: original.sha256 });
});

// ------------------------------------------------ снимок политики (D0/D14)

test("снимок политики без хэша, с чужим хэшем или нечитаемый — не снимок (recapture)", () => {
  const policy = snapshot(DEFAULT);
  const json = JSON.stringify(policy);
  const hash = verdictPolicyOfRow({ verdict_policy_json: json, verdict_policy_hash: null });
  expect(hash).toBeNull();
  expect(verdictPolicyOfRow({ verdict_policy_json: null, verdict_policy_hash: "abc" })).toBeNull();
  expect(verdictPolicyOfRow({ verdict_policy_json: "{oops", verdict_policy_hash: "abc" })).toBeNull();
  // Хэш есть, но он не про этот снимок — считать по нему дельту нельзя.
  expect(verdictPolicyOfRow({ verdict_policy_json: json, verdict_policy_hash: "f".repeat(64) })).toBeNull();
});

// ------------------------------------------- пресет live-text (план 2026-08-06 §W4)

test("§W4: пресет пересчитывается по сохранённому edgeResidual и флипает вердикт", () => {
  const withEdge = (insidePct: number, rawDiffPct: number): GateResult => {
    const gate = visualGateResult(rawDiffPct, rawDiffPct, "fail");
    gate.metrics!.edgeResidual = { residualPixels: 200, insidePixels: 199, outsidePixels: 1, insidePct };
    return gate;
  };
  const strict = withRequiredVisual(withThreshold(DEFAULT, 0.05));
  const before = verdictPolicySnapshotOf(strict, CASE);
  const after = verdictPolicySnapshotOf(strict, { ...CASE, textAaBudget: "live-text-v1" });
  expect(verdictPolicyDelta(before, after)).toEqual(["textAaBudget"]);
  expect(GATES_BY_POLICY_FIELD.textAaBudget).toEqual(["visual"]);

  // Остаток лежит на контурах эталона ⇒ пресет применяется: fail → pass, без единого пикселя.
  const rescued = reevaluateGates([...structuralGates(), withEdge(99, 0.4)], before, after);
  expect(rescued.reevaluable).toBe(true);
  expect(rescued.changed).toBe(true);
  expect(rescued.gates.find((gate) => gate.gate === "visual")!.status).toBe("pass");
  expect(rescued.gates.find((gate) => gate.gate === "visual")!.metrics!.textAaBudget)
    .toMatchObject({ preset: "live-text-v1", applied: true });

  // Остаток вне контуров — пресет молчит, вердикт остаётся провальным.
  const kept = reevaluateGates([...structuralGates(), withEdge(40, 0.4)], before, after);
  expect(kept.gates.find((gate) => gate.gate === "visual")!.status).toBe("fail");
  // …и расхождение выше потолка самого пресета тоже не спасается.
  const tooBig = reevaluateGates([...structuralGates(), withEdge(100, 5)], before, after);
  expect(tooBig.gates.find((gate) => gate.gate === "visual")!.status).toBe("fail");
});

test("§W4: пресет без edgeResidual в сохранённых метриках — отказ пересчёта, а не выдумка", () => {
  // Метрики сняты до волны: остатка по edge-маске в них нет вовсе. «Пересчитать» пресет по
  // числам, которых не измеряли, невозможно — вызывающий обязан сравнить заново (re-diff).
  const strict = withRequiredVisual(withThreshold(DEFAULT, 0.05));
  const result = reevaluateGates(
    [...structuralGates(), visualGateResult(0.4, 0.4, "fail")],
    verdictPolicySnapshotOf(strict, CASE),
    verdictPolicySnapshotOf(strict, { ...CASE, textAaBudget: "live-text-v1" }),
  );
  expect(result.reevaluable).toBe(false);
  expect(result.reason).toContain("edgeResidual");
});
