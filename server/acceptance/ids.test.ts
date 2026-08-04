import { expect, test } from "bun:test";
import type { AcceptanceCase } from "./cases";
import {
  CASE_FINGERPRINT_ALGO_VERSION, COMPARISON_PAINT_MARGIN_PX, FIELD_LAYERS,
  caseFingerprintsOf, comparisonFingerprintOf, frameFingerprint, readinessPolicyHashOf,
  verdictPolicyHashOf, verdictPolicySnapshotOf,
  type CaseSurface, type LayeredField,
} from "./ids";
import { ACCEPTANCE_POLICIES, withRequiredVisual, type AcceptancePolicy } from "./policies";
import { rendererFingerprint } from "../capture/renderer";

/**
 * Трёхслойный отпечаток случая (план `docs/plans/2026-08-04-acceptance-pipeline-feedback.md`,
 * решение D-B, волна W1).
 *
 * Предмет файла — **алгебра идентичности**, а не поведение раннера: какой вход в какой слой
 * входит и что именно инвалидирует. Дыра, ради которой слои и заводились (порог политики внутри
 * плоского `case_fingerprint` ⇒ смена одного числа роняет весь накопленный reuse), проверяется
 * здесь на уровне хэшей, а её продуктовые следствия — в `orchestrator.test.ts`.
 */

const SURFACE: CaseSurface = { viewport: { width: 390, height: 844 }, dsf: 2, theme: "light" };
const CANDIDATE = `cand_${"0".repeat(64)}`;
const ASSET_A = `asset_${"a".repeat(64)}`;
const ASSET_B = `asset_${"b".repeat(64)}`;
const DEFAULT = ACCEPTANCE_POLICIES["default-v1"];

const fingerprints = (
  item: Parameters<typeof caseFingerprintsOf>[0]["case"],
  policy: AcceptancePolicy = DEFAULT,
) => caseFingerprintsOf({ candidateId: CANDIDATE, surface: SURFACE, policy, case: item });

const PLAIN = { caseKey: "alpha", propsHash: "props-1" };

// ------------------------------------------------------- версия алгоритма

test("версия алгоритма отпечатка случая === 6 (расслоение на кадр/сравнение/вердикт)", () => {
  // Литерал, а не ссылка на константу: тест обязан падать при **любом** изменении значения, в том
  // числе случайном. Bump 5→6 санкционирован планом 2026-08-04 (D-B) — второй bump после пакета
  // renderer-contract-2, и он принадлежит другому плану, чей инвариант «bump ровно один» не нарушен.
  expect(CASE_FINGERPRINT_ALGO_VERSION).toBe(6);
});

// ------------------------------------------------------------ слои и дельты

test("порог политики меняет вердиктный слой и итоговый отпечаток, но не кадр и не сравнение", () => {
  // Ровно тот случай из фидбэка (P0-3): «поменяли порог — пересняли 25 кадров». Порог обязан
  // менять вердиктный слой и только его; кадр и эталон к порогу отношения не имеют.
  const stricter: AcceptancePolicy = { ...DEFAULT, visual: { ...DEFAULT.visual, maxRawDiffPct: 0.1 } };
  const before = fingerprints(PLAIN);
  const after = fingerprints(PLAIN, stricter);

  expect(after.frame).toBe(before.frame);
  expect(after.comparison).toBe(before.comparison);
  expect(after.verdictPolicy).not.toBe(before.verdictPolicy);
  expect(after.case).not.toBe(before.case);
});

test("per-case допуск случая ведёт себя как порог профиля: только вердиктный слой", () => {
  const before = fingerprints({ ...PLAIN, referenceAssetId: ASSET_A });
  const after = fingerprints({ ...PLAIN, referenceAssetId: ASSET_A, casePolicy: { maxRawDiffPct: 0.25 } });
  expect(after.frame).toBe(before.frame);
  expect(after.comparison).toBe(before.comparison);
  expect(after.verdictPolicy).not.toBe(before.verdictPolicy);
});

test("смена эталона меняет слой сравнения, но не кадр (анти-репро C0)", () => {
  // Инвариант, ради которого re-diff отделён от recompute: новый эталон обязан быть **измерен**
  // заново, а не пересчитан арифметически по метрикам старого сравнения.
  const before = fingerprints({ ...PLAIN, referenceAssetId: ASSET_A });
  const after = fingerprints({ ...PLAIN, referenceAssetId: ASSET_B });
  expect(after.frame).toBe(before.frame);
  expect(after.comparison).not.toBe(before.comparison);
  expect(after.verdictPolicy).toBe(before.verdictPolicy);
});

test("cropLineage — вход сравнения: его смена не трогает кадр", () => {
  const before = fingerprints({ ...PLAIN, referenceAssetId: ASSET_A, cropLineage: { rect: [0, 0, 24, 20] } });
  const after = fingerprints({ ...PLAIN, referenceAssetId: ASSET_A, cropLineage: { rect: [0, 0, 24, 12] } });
  expect(after.frame).toBe(before.frame);
  expect(after.comparison).not.toBe(before.comparison);
});

test("expectedGeometry — двухслойное поле (D1): и сравнение, и вердикт", () => {
  // Оно определяет и допуск геометрии, и (с W5) `padTo` нормализации content-hug эталона. Поэтому
  // его смена обязана уводить визуал в re-diff, а не в пересчёт по старым метрикам.
  const before = fingerprints({ ...PLAIN, referenceAssetId: ASSET_A, expectedGeometry: { width: 140, height: 96 } });
  const after = fingerprints({ ...PLAIN, referenceAssetId: ASSET_A, expectedGeometry: { width: 141, height: 96 } });
  expect(after.frame).toBe(before.frame);
  expect(after.comparison).not.toBe(before.comparison);
  expect(after.verdictPolicy).not.toBe(before.verdictPolicy);
  expect(FIELD_LAYERS.expectedGeometry).toEqual(["comparison", "verdict"]);
});

test("props, поверхность и readiness-политика — кадровый слой", () => {
  const before = fingerprints(PLAIN);
  expect(fingerprints({ ...PLAIN, propsHash: "props-2" }).frame).not.toBe(before.frame);
  expect(caseFingerprintsOf({
    candidateId: CANDIDATE, surface: { ...SURFACE, dsf: 1 }, policy: DEFAULT, case: PLAIN,
  }).frame).not.toBe(before.frame);
  // `pixel-strict-v1` несёт строгую readiness — она входит в кадр, и её смена честно требует
  // пересъёмки (в отличие от порогов того же профиля).
  expect(fingerprints(PLAIN, ACCEPTANCE_POLICIES["pixel-strict-v1"]).frame).not.toBe(before.frame);
});

test("`--policy` инвалидирует reuse и на examples-, и на case-set-пути (C8)", () => {
  // До этой волны examples-путь хэшировал заглушку `CASE_POLICY_HASH_V0`, а case-set-путь — профиль
  // **из манифеста**, а не рана: strict-ран переиспользовал вердикты мягкого профиля на обоих.
  const examples = { caseKey: "alpha", propsHash: "props-1" };
  const caseSetCase = {
    caseKey: "alpha", propsHash: "props-1", referenceAssetId: ASSET_A,
    casePolicy: { maxRawDiffPct: 1 }, declaredPolicyProfile: "default-v1",
  };
  for (const item of [examples, caseSetCase]) {
    const soft = fingerprints(item);
    const strict = fingerprints(item, ACCEPTANCE_POLICIES["pixel-strict-v1"]);
    expect(strict.verdictPolicy).not.toBe(soft.verdictPolicy);
    expect(strict.case).not.toBe(soft.case);
  }
});

test("requireVisual набора меняет вердиктный слой, а не кадр (W5a-инвариант остаётся)", () => {
  const soft = fingerprints({ ...PLAIN, referenceAssetId: ASSET_A });
  const hard = fingerprints({ ...PLAIN, referenceAssetId: ASSET_A }, withRequiredVisual(DEFAULT));
  expect(hard.frame).toBe(soft.frame);
  expect(hard.comparison).toBe(soft.comparison);
  expect(hard.verdictPolicy).not.toBe(soft.verdictPolicy);
});

test("maxDimensionDeltaPx — вход сравнения, а не вердикта: он решает, состоится ли сравнение", () => {
  const before = comparisonFingerprintOf({
    referenceAssetId: ASSET_A, expectedGeometry: null, maxDimensionDeltaPx: 8,
    paintMarginPx: COMPARISON_PAINT_MARGIN_PX, deviceScaleFactor: 2,
  });
  const after = comparisonFingerprintOf({
    referenceAssetId: ASSET_A, expectedGeometry: null, maxDimensionDeltaPx: 4,
    paintMarginPx: COMPARISON_PAINT_MARGIN_PX, deviceScaleFactor: 2,
  });
  expect(after).not.toBe(before);
});

test("W5-слоты канонизуются отсутствием: незаполненные поля не двигают отпечаток legacy-манифестов", () => {
  // D18/C6: W5 добавит `referenceSurface`/`referencePlacement`/`cropLineage.sourceSurface`. Пока
  // их никто не заполняет, отпечаток обязан совпадать с «полем нет вовсе» — иначе выкатка W5
  // молча инвалидировала бы весь прод-кэш.
  const bare = comparisonFingerprintOf({
    referenceAssetId: ASSET_A, maxDimensionDeltaPx: 8, paintMarginPx: 64, deviceScaleFactor: 2,
  });
  const explicitUndefined = comparisonFingerprintOf({
    referenceAssetId: ASSET_A, referenceSurface: null, referencePlacement: null, cropLineage: null,
    expectedGeometry: null, maxDimensionDeltaPx: 8, paintMarginPx: 64, deviceScaleFactor: 2,
  });
  expect(explicitUndefined).toBe(bare);
  const filled = comparisonFingerprintOf({
    referenceAssetId: ASSET_A, referenceSurface: "content-hug",
    maxDimensionDeltaPx: 8, paintMarginPx: 64, deviceScaleFactor: 2,
  });
  expect(filled).not.toBe(bare);
});

test("W5: нормализация content-hug эталона форсирует re-diff, а не recompute (C12)", () => {
  // C0/C12/D1: `referenceSurface`, `referencePlacement` и `cropLineage.sourceSurface` участвуют в
  // построении нормализованного эталона, значит их смена меняет **метрики**, а не только вердикт.
  // Промах обязан приходиться на слой сравнения: кадр цел (re-diff), но старый rawDiffPct мёртв.
  const paint = { ...PLAIN, referenceAssetId: ASSET_A, expectedGeometry: { width: 136, height: 32 } };
  const base = fingerprints(paint);

  const hug = fingerprints({ ...paint, referenceSurface: "content-hug" });
  expect(hug.frame).toBe(base.frame);
  expect(hug.verdictPolicy).toBe(base.verdictPolicy);
  expect(hug.comparison).not.toBe(base.comparison);
  expect(hug.case).not.toBe(base.case);

  const placed = fingerprints({ ...paint, referenceSurface: "content-hug", referencePlacement: { x: 128, y: 128 } });
  expect(placed.frame).toBe(base.frame);
  expect(placed.verdictPolicy).toBe(base.verdictPolicy);
  expect(placed.comparison).not.toBe(hug.comparison);

  // `sourceSurface` решает, режется эталон или нет, — то есть с чем именно сравнивают.
  const lineage = { rect: [20, 10, 136, 32] as const };
  const cropped = fingerprints({ ...paint, cropLineage: { ...lineage } });
  const provenanceOnly = fingerprints({ ...paint, cropLineage: { ...lineage, sourceSurface: "content-hug" } });
  expect(provenanceOnly.frame).toBe(cropped.frame);
  expect(provenanceOnly.comparison).not.toBe(cropped.comparison);
});

test("W5: поля content-hug классифицированы как comparison, а не как кадр", () => {
  const layerOf = (field: LayeredField): readonly string[] => (FIELD_LAYERS as Record<string, readonly string[]>)[field]!;
  expect(layerOf("referenceSurface")).toEqual(["comparison"]);
  expect(layerOf("referencePlacement")).toEqual(["comparison"]);
});

test("расчёт отпечатков детерминирован и собирается из своих же слоёв", () => {
  const item = { ...PLAIN, referenceAssetId: ASSET_A };
  const first = fingerprints(item);
  const second = fingerprints(item);
  expect(second).toEqual(first);
  const readinessHash = readinessPolicyHashOf(DEFAULT.readiness);
  expect(first.frame).toBe(frameFingerprint({
    candidateId: CANDIDATE, caseKey: item.caseKey, propsHash: item.propsHash, surface: SURFACE,
    readinessPolicyHash: readinessHash,
    rendererFingerprint: rendererFingerprint(readinessHash),
  }));
  expect(first.verdictPolicy).toBe(verdictPolicyHashOf(verdictPolicySnapshotOf(DEFAULT, item)));
  expect(first.verdictPolicySnapshot.maxRawDiffPct).toBe(DEFAULT.visual.maxRawDiffPct);
});

// --------------------------------------------- тотальность разбиения (D3)

/**
 * Полный набор полей случая. `Required<AcceptanceCase>` — не украшение: новое поле в
 * `AcceptanceCase` **не соберётся**, пока не появится здесь, а появившись — попадёт в проверку
 * ниже и потребует классификации в `FIELD_LAYERS`.
 */
const CASE_SAMPLE: Required<AcceptanceCase> = {
  caseId: "alpha",
  caseKey: "alpha",
  props: {},
  propsHash: "props-1",
  aliasOfCaseId: null,
  referenceAssetId: null,
  expectedGeometry: null,
  casePolicyHash: "case-policy-v0",
  declaredPolicyProfile: null,
  casePolicy: {},
  cropLineage: { rect: [0, 0, 1, 1] },
  // W5: content-hug reference. Оба поля — входы построения нормализованного эталона, значит
  // comparison по инварианту D1 (проверка слоя — тестом ниже).
  referenceSurface: "paint",
  referencePlacement: { x: 0, y: 0 },
  dims: {},
  geometryDetailKeys: [],
};

test("каждое поле политики, случая и поверхности классифицировано по слоям (D3)", () => {
  const policyFields = Object.keys(DEFAULT).flatMap((key) => (
    key === "visual" || key === "geometry"
      ? Object.keys(DEFAULT[key as "visual" | "geometry"]).map((leaf) => `${key}.${leaf}`)
      : [key]
  ));
  const fields = [
    ...policyFields,
    ...Object.keys(CASE_SAMPLE),
    ...Object.keys(SURFACE).map((key) => `surface.${key}`),
  ];
  const layers = FIELD_LAYERS as Record<string, readonly string[]>;
  const unclassified = fields.filter((field) => layers[field] === undefined);
  // Неклассифицированное поле — это тихий stale-reuse: оно меняет случай, но не меняет ни один
  // отпечаток. Поэтому тест падает на **самом факте** пропуска, а не на его последствии.
  expect(unclassified).toEqual([]);

  for (const value of Object.values(layers)) {
    expect(value.length).toBeGreaterThan(0);
    // `report-only` — обоснованное «нигде», и оно не смешивается со слоями: поле либо влияет,
    // либо нет, третьего не бывает.
    if (value.includes("report-only")) expect(value).toEqual(["report-only"]);
  }
});

test("классификация не даёт полю сравнения уехать в кадр и наоборот", () => {
  const layerOf = (field: LayeredField): readonly string[] => (FIELD_LAYERS as Record<string, readonly string[]>)[field]!;
  expect(layerOf("referenceAssetId")).toEqual(["comparison"]);
  expect(layerOf("cropLineage")).toEqual(["comparison"]);
  expect(layerOf("visual.maxDimensionDeltaPx")).toEqual(["comparison"]);
  expect(layerOf("visual.maxRawDiffPct")).toEqual(["verdict"]);
  expect(layerOf("readiness")).toEqual(["frame"]);
  expect(layerOf("propsHash")).toEqual(["frame"]);
});
