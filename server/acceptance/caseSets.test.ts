import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../migrations";
import { canonicalStringify } from "../../src/capture/canonicalJson";
import { ApiError } from "../http";
import {
  CASE_SET_MAX_DIMENSION_VALUES, CASE_SET_MAX_EXPECTED_TUPLES, COVERAGE_MISSING_TUPLES_LIMIT,
  type CaseSetManifest,
} from "../../src/acceptance/caseSetSchema";
import {
  buildCasesFromManifest, CaseSetRepo, caseDedupKeyOf, casePolicyHashOf, caseSetIdOf, coverageOf,
  dedupSlotsKeyOf, manifestOfRow, publishedPinByNameAndVersion, slotsHashOf, surfaceOfManifest,
  validateManifest,
} from "./caseSets";
import {
  CASE_FINGERPRINT_ALGO_VERSION,
  DEFAULT_RENDERER_FINGERPRINT, DEFAULT_READINESS_POLICY_HASH,
  caseFingerprint, caseFingerprintsOf, comparisonFingerprintOf, frameFingerprint, verdictPolicyHashOf,
  verdictPolicySnapshotOf,
} from "./ids";
import { ACCEPTANCE_POLICIES, acceptanceMaxCasesPerRun } from "./policies";

/**
 * Case-set-манифесты (план 2026-08-03 §5 W2, амендмент A2).
 *
 * Предмет — доменный слой: схема, валидации-отказы, контентная адресация, покрытие измерений и
 * построение набора случаев. HTTP-поверхность проверяет `server/acceptance-routes.test.ts`,
 * исполнение рана — `runner.test.ts` и e2e.
 */

const ASSET = `asset_${"a".repeat(64)}`;

const dbWithAsset = (): Database => {
  const db = new Database(":memory:");
  migrate(db);
  db.run("INSERT INTO assets (id,sha256,mime,size,width,height,created_at) VALUES (?,?,'image/png',10,4,4,'now')", [ASSET, "a".repeat(64)]);
  return db;
};

const manifest = (overrides: Partial<CaseSetManifest> = {}): Record<string, unknown> => ({
  manifestVersion: 1,
  componentId: "yp-badge",
  capture: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, theme: "light" },
  cases: [
    { id: "default", props: { tone: "neutral" } },
    { id: "accent", props: { tone: "accent" } },
  ],
  ...overrides,
});

const fails = (call: () => unknown, status: ApiError["status"], code: string): void => {
  try {
    call();
    throw new Error(`expected ${status} ${code}, got success`);
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect({ status: (error as ApiError).status, code: (error as ApiError).code }).toEqual({ status, code });
  }
};

// ------------------------------------------------------------------- адресация

test("case set id is the content address of the manifest: key order does not matter, content does", () => {
  const db = dbWithAsset();
  const left = validateManifest(db, "yp-badge", manifest());
  const right = validateManifest(db, "yp-badge", {
    cases: [{ props: { tone: "neutral" }, id: "default" }, { id: "accent", props: { tone: "accent" } }],
    capture: { deviceScaleFactor: 2, theme: "light", viewport: { height: 844, width: 390 } },
    componentId: "yp-badge", manifestVersion: 1,
  });
  expect(left.caseSetId).toMatch(/^cset_[0-9a-f]{64}$/);
  expect(right.caseSetId).toBe(left.caseSetId);

  const changed = validateManifest(db, "yp-badge", manifest({ requireVisual: true } as Partial<CaseSetManifest>));
  expect(changed.caseSetId).not.toBe(left.caseSetId);
  db.close();
});

test("PUT is idempotent by content: the same manifest returns the same row with cached=true", () => {
  const db = dbWithAsset();
  const { manifest: parsed } = validateManifest(db, "yp-badge", manifest());
  const repo = new CaseSetRepo(db);
  const first = repo.put({ componentId: "yp-badge", designSystem: "yandex-pay", manifest: parsed, createdBy: "user_a" });
  const second = repo.put({ componentId: "yp-badge", designSystem: "yandex-pay", manifest: parsed, createdBy: "user_b" });
  expect(first.cached).toBe(false);
  expect(second.cached).toBe(true);
  expect(second.row.case_set_id).toBe(first.row.case_set_id);
  // Иммутабельность: повтор от другого автора не переписал строку.
  expect(second.row.created_by).toBe("user_a");
  expect(second.row.case_count).toBe(2);
  expect(manifestOfRow(second.row)).toEqual(parsed);
  db.close();
});

test("the Figma source of the manifest is denormalized onto the row", () => {
  const db = dbWithAsset();
  const { manifest: parsed } = validateManifest(db, "yp-badge", manifest({
    source: { fileKey: "abc123", componentSetNodeId: "54863:9518" },
  } as Partial<CaseSetManifest>));
  const { row } = new CaseSetRepo(db).put({ componentId: "yp-badge", designSystem: "yandex-pay", manifest: parsed, createdBy: "user_a" });
  expect({ key: row.source_file_key, node: row.source_node_id }).toEqual({ key: "abc123", node: "54863:9518" });
  db.close();
});

// ------------------------------------------------------------------- валидации

test("a case id outside the evidence charset is rejected by the schema", () => {
  const db = dbWithAsset();
  // Figma node id ("54863:9537") не проходит: из caseId строятся имена записей evidence-архива.
  fails(() => validateManifest(db, "yp-badge", manifest({
    cases: [{ id: "54863:9537", props: { tone: "neutral" } }],
  } as unknown as Partial<CaseSetManifest>)), 422, "validation_failed");
  db.close();
});

test("an unknown manifest field is rejected instead of being silently ignored", () => {
  const db = dbWithAsset();
  fails(() => validateManifest(db, "yp-badge", { ...manifest(), captures: {} }), 422, "validation_failed");
  db.close();
});

test("the manifest must describe the component it is published under", () => {
  const db = dbWithAsset();
  fails(() => validateManifest(db, "yp-chip", manifest()), 422, "case_set_component_mismatch");
  db.close();
});

test("a reference asset that is not in the registry is a hard failure", () => {
  const db = dbWithAsset();
  const ok = validateManifest(db, "yp-badge", manifest({
    cases: [{ id: "default", props: { tone: "neutral" }, referenceAssetId: ASSET }],
  } as unknown as Partial<CaseSetManifest>));
  expect(ok.manifest.cases[0]!.referenceAssetId).toBe(ASSET);
  fails(() => validateManifest(db, "yp-badge", manifest({
    cases: [{ id: "default", props: { tone: "neutral" }, referenceAssetId: `asset_${"b".repeat(64)}` }],
  } as unknown as Partial<CaseSetManifest>)), 422, "asset_not_found");
  db.close();
});

test("duplicate case ids and duplicate props without aliasOf are refused", () => {
  const db = dbWithAsset();
  fails(() => validateManifest(db, "yp-badge", manifest({
    cases: [{ id: "default", props: { tone: "a" } }, { id: "default", props: { tone: "b" } }],
  } as unknown as Partial<CaseSetManifest>)), 422, "duplicate_case_id");
  fails(() => validateManifest(db, "yp-badge", manifest({
    cases: [{ id: "one", props: { tone: "a" } }, { id: "two", props: { tone: "a" } }],
  } as unknown as Partial<CaseSetManifest>)), 422, "duplicate_case_props");
  db.close();
});

test("aliasOf must name another non-alias case with identical props", () => {
  const db = dbWithAsset();
  const good = validateManifest(db, "yp-badge", manifest({
    cases: [{ id: "one", props: { tone: "a" } }, { id: "two", props: { tone: "a" }, aliasOf: "one" }],
  } as unknown as Partial<CaseSetManifest>));
  expect(good.manifest.cases[1]!.aliasOf).toBe("one");

  for (const cases of [
    [{ id: "one", props: { tone: "a" } }, { id: "two", props: { tone: "a" }, aliasOf: "missing" }],
    [{ id: "one", props: { tone: "a" } }, { id: "two", props: { tone: "a" }, aliasOf: "two" }],
    [{ id: "one", props: { tone: "a" } }, { id: "two", props: { tone: "a" }, aliasOf: "one" }, { id: "three", props: { tone: "a" }, aliasOf: "two" }],
    [{ id: "one", props: { tone: "a" } }, { id: "two", props: { tone: "b" }, aliasOf: "one" }],
  ]) {
    fails(() => validateManifest(db, "yp-badge", manifest({ cases } as unknown as Partial<CaseSetManifest>)), 422, "invalid_alias_target");
  }
  db.close();
});

test("per-case политика на алиасе отвергается: у алиаса нет своего вердикта (D16)", () => {
  // Вердикт алиаса идентичен вердикту цели (D10) — своей съёмки и своего сравнения у него нет.
  // Допуск, адресованный алиасу, объявляет намерение, которое не будет исполнено ничем; молчаливое
  // игнорирование здесь означало бы матрицу, выглядящую строже, чем она есть.
  const db = dbWithAsset();
  fails(() => validateManifest(db, "yp-badge", manifest({
    policy: { perCase: { two: { maxRawDiffPct: 0.1 } } },
    cases: [{ id: "one", props: { tone: "a" } }, { id: "two", props: { tone: "a" }, aliasOf: "one" }],
  } as unknown as Partial<CaseSetManifest>)), 422, "per_case_policy_on_alias");

  // На цели тот же допуск законен.
  const ok = validateManifest(db, "yp-badge", manifest({
    policy: { perCase: { one: { maxRawDiffPct: 0.1 } } },
    cases: [{ id: "one", props: { tone: "a" } }, { id: "two", props: { tone: "a" }, aliasOf: "one" }],
  } as unknown as Partial<CaseSetManifest>));
  expect(ok.manifest.policy?.perCase?.one?.maxRawDiffPct).toBe(0.1);
  db.close();
});

test("crop lineage rectangles must be non-negative with a positive size", () => {
  const db = dbWithAsset();
  const ok = validateManifest(db, "yp-badge", manifest({
    cases: [{ id: "default", props: { tone: "a" }, cropLineage: { parentNodeId: "54863:9518", rect: [0, 0, 140, 96] } }],
  } as unknown as Partial<CaseSetManifest>));
  expect(ok.manifest.cases[0]!.cropLineage?.rect).toEqual([0, 0, 140, 96]);
  for (const rect of [[-1, 0, 140, 96], [0, 0, 0, 96], [0, 0, 140, -96]]) {
    fails(() => validateManifest(db, "yp-badge", manifest({
      cases: [{ id: "default", props: { tone: "a" }, cropLineage: { rect } }],
    } as unknown as Partial<CaseSetManifest>)), 422, "validation_failed");
  }
  db.close();
});

test("the per-run case ceiling applies to the declared set, before aliases collapse it", () => {
  const db = dbWithAsset();
  const cases = Array.from({ length: 65 }, (_, index) => ({ id: `case-${index}`, props: { index } }));
  fails(() => validateManifest(db, "yp-badge", manifest({ cases } as unknown as Partial<CaseSetManifest>)), 422, "case_set_too_large");
  db.close();
});

test("dimension mismatches and schema drift are warnings, not failures", () => {
  const db = dbWithAsset();
  db.run(`INSERT INTO components (id,name,head_rev,design_system,deleted_at,created_at,updated_at)
    VALUES ('yp-badge','YpBadge',1,'yandex-pay',NULL,'now','now')`);
  db.run("INSERT INTO component_revisions (component_id,rev,source,design_system,message,created_at) VALUES ('yp-badge',1,'src','yandex-pay',NULL,'now')");
  db.run(`INSERT INTO component_publishes (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,message,published_at)
    VALUES ('yp-badge',1,1,'active','js',?,'sh','bh',4,NULL,'now')`,
    [JSON.stringify({ propsJsonSchema: { type: "object", properties: { tone: { type: "string" } }, required: ["tone"] } })]);

  const result = validateManifest(db, "yp-badge", manifest({
    dimensions: { tone: ["neutral", "accent"] },
    cases: [
      { id: "default", props: { tone: "neutral" }, dims: { tone: "neutral" } },
      { id: "accent", props: { tone: "accent", weird: 1 }, dims: { tone: "loud" } },
    ],
  } as unknown as Partial<CaseSetManifest>));
  expect(result.warnings.join("\n")).toContain('dims."tone" = "loud" is not one of the declared values');
  expect(result.warnings.join("\n")).toContain("props not in the published schema");
  db.close();
});

// -------------------------------------------------------------------- coverage

test("coverage is the Cartesian product of the declared dimensions", () => {
  const db = dbWithAsset();
  const { manifest: parsed } = validateManifest(db, "yp-badge", manifest({
    dimensions: { size: ["s", "m"], tone: ["neutral", "accent"] },
    cases: [
      { id: "s-neutral", props: { size: "s", tone: "neutral" }, dims: { size: "s", tone: "neutral" } },
      { id: "s-accent", props: { size: "s", tone: "accent" }, dims: { size: "s", tone: "accent" } },
      { id: "m-neutral", props: { size: "m", tone: "neutral" }, dims: { size: "m", tone: "neutral" } },
      { id: "m-neutral-copy", props: { size: "m", tone: "neutral" }, aliasOf: "m-neutral", dims: { size: "m", tone: "neutral" } },
    ],
  } as unknown as Partial<CaseSetManifest>));
  const coverage = coverageOf(parsed);
  expect({ expected: coverage.expectedTuples, present: coverage.presentTuples }).toEqual({ expected: 4, present: 3 });
  expect(coverage.missingTuples).toEqual([{ size: "m", tone: "accent" }]);
  expect(coverage.duplicates).toEqual([{ tuple: { size: "m", tone: "neutral" }, caseIds: ["m-neutral", "m-neutral-copy"] }]);
  db.close();
});

test("a manifest without dimensions gets a trivial coverage, not an invented product", () => {
  const db = dbWithAsset();
  const { manifest: parsed } = validateManifest(db, "yp-badge", manifest());
  expect(coverageOf(parsed)).toEqual({
    dimensions: {}, expectedTuples: 0, presentTuples: 2,
    missingTuples: [], missingCount: 0, truncated: false, duplicates: [], frameCases: 2,
  });
  db.close();
});

// ------------------------------------------------- лимиты и потолок произведения (W6)

/**
 * P1-7: лимит значений в измерении был **ниже** ёмкости рана, и семья из 49 состояний
 * шардировалась только из-за схемы. Инвариант живёт здесь, а не в схеме: `caseSetSchema.ts` —
 * общий с клиентом модуль и server-код (реестр политик) не импортирует.
 */
test("one canonical axis holds a whole run: CASE_SET_MAX_DIMENSION_VALUES >= acceptanceMaxCasesPerRun", () => {
  expect(CASE_SET_MAX_DIMENSION_VALUES).toBeGreaterThanOrEqual(acceptanceMaxCasesPerRun);
});

test("a 49-state family is one case set and one run: a single axis of 49 values passes", () => {
  const db = dbWithAsset();
  const states = Array.from({ length: 49 }, (_, index) => `s${index}`);
  const { manifest: parsed, caseSetId } = validateManifest(db, "yp-badge", manifest({
    dimensions: { state: states },
    cases: states.map((state) => ({ id: `case-${state}`, props: { state }, dims: { state } })),
  } as unknown as Partial<CaseSetManifest>));
  expect(caseSetId).toMatch(/^cset_[0-9a-f]{64}$/);
  const coverage = coverageOf(parsed);
  expect({ expected: coverage.expectedTuples, present: coverage.presentTuples, missing: coverage.missingCount })
    .toEqual({ expected: 49, present: 49, missing: 0 });
  // Один ран: 49 случаев помещаются в `acceptanceMaxCasesPerRun` без шардирования.
  expect(buildCasesFromManifest(parsed)).toHaveLength(49);
  db.close();
});

test("the Cartesian bomb is refused by multiplying axis lengths, before a single tuple exists", () => {
  const db = dbWithAsset();
  const values = Array.from({ length: 64 }, (_, index) => `v${index}`);
  const dimensions = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`axis${index}`, values]));
  // 64^8 ≈ 2.8·10^14 ячеек: материализация убила бы процесс, поэтому отказ — чистая арифметика.
  fails(() => validateManifest(db, "yp-badge", manifest({ dimensions } as unknown as Partial<CaseSetManifest>)),
    422, "case_set_coverage_too_large");
  // Тот же потолок на пути покрытия: манифест мимо PUT (или из старой строки) его не обходит.
  fails(() => coverageOf({
    ...(manifest() as unknown as CaseSetManifest), dimensions,
  }), 422, "case_set_coverage_too_large");

  // Ровно на потолке (4096 = 2^12) набор проходит: граница включающая.
  const twelveAxes = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`axis${index}`, index < 4 ? ["a", "b", "c", "d"] : ["a"]]));
  const { manifest: parsed } = validateManifest(db, "yp-badge", manifest({ dimensions: twelveAxes } as unknown as Partial<CaseSetManifest>));
  expect(coverageOf(parsed).expectedTuples).toBe(CASE_SET_MAX_EXPECTED_TUPLES / 16);
  db.close();
});

test("missingTuples is truncated to 64 cells with the full count alongside", () => {
  const db = dbWithAsset();
  const values = Array.from({ length: 64 }, (_, index) => `v${index}`);
  const { manifest: parsed } = validateManifest(db, "yp-badge", manifest({
    dimensions: { left: values, right: ["a", "b"] },
    cases: [{ id: "only", props: { left: "v0" }, dims: { left: "v0", right: "a" } }],
  } as unknown as Partial<CaseSetManifest>));
  const coverage = coverageOf(parsed);
  expect({ expected: coverage.expectedTuples, missing: coverage.missingCount, truncated: coverage.truncated })
    .toEqual({ expected: 128, missing: 127, truncated: true });
  expect(coverage.missingTuples).toHaveLength(COVERAGE_MISSING_TUPLES_LIMIT);
  // Усечение не выдумывает ячейки: каждая из отданных — настоящая координата произведения.
  for (const tuple of coverage.missingTuples) {
    expect(values).toContain(tuple.left);
    expect(["a", "b"]).toContain(tuple.right);
  }
  db.close();
});

// ------------------------------------------------------------ набор случаев рана

test("the run case set carries reference, expected geometry and the per-case policy hash", () => {
  const db = dbWithAsset();
  const { manifest: parsed } = validateManifest(db, "yp-badge", manifest({
    policy: { profile: "pixel-strict-v1", perCase: { accent: { maxRawDiffPct: 2 } } },
    cases: [
      { id: "default", props: { tone: "neutral" }, referenceAssetId: ASSET, expectedGeometry: { width: 140, height: 96 } },
      { id: "accent", props: { tone: "accent" } },
      { id: "accent-copy", props: { tone: "accent" }, aliasOf: "accent" },
    ],
  } as unknown as Partial<CaseSetManifest>));
  const cases = buildCasesFromManifest(parsed);
  expect(cases.map((item) => item.caseId)).toEqual(["default", "accent", "accent-copy"]);
  expect(cases[0]).toMatchObject({ referenceAssetId: ASSET, expectedGeometry: { width: 140, height: 96 }, aliasOfCaseId: null });
  expect(cases[2]).toMatchObject({ aliasOfCaseId: "accent" });
  // Допуск объявлен только для `accent` — у остальных случаев хэш политики другой и общий.
  expect(cases[1]!.casePolicyHash).toBe(casePolicyHashOf(parsed, "accent"));
  expect(cases[0]!.casePolicyHash).toBe(casePolicyHashOf(parsed, "default"));
  expect(cases[0]!.casePolicyHash).not.toBe(cases[1]!.casePolicyHash);
  db.close();
});

test("changing one case's tolerance changes only that case's policy hash", () => {
  const db = dbWithAsset();
  const before = validateManifest(db, "yp-badge", manifest({
    policy: { profile: "default-v1", perCase: { accent: { maxRawDiffPct: 2 } } },
  } as unknown as Partial<CaseSetManifest>)).manifest;
  const after = validateManifest(db, "yp-badge", manifest({
    policy: { profile: "default-v1", perCase: { accent: { maxRawDiffPct: 5 } } },
  } as unknown as Partial<CaseSetManifest>)).manifest;
  expect(casePolicyHashOf(after, "accent")).not.toBe(casePolicyHashOf(before, "accent"));
  expect(casePolicyHashOf(after, "default")).toBe(casePolicyHashOf(before, "default"));
  db.close();
});

test("requireVisual входит в case_policy_hash: обязательность визуала инвалидирует reuse (W5a)", () => {
  const db = dbWithAsset();
  const advisory = validateManifest(db, "yp-badge", manifest()).manifest;
  const required = validateManifest(db, "yp-badge", manifest({ requireVisual: true } as unknown as Partial<CaseSetManifest>)).manifest;
  // Без этого набор, переключённый на обязательный визуал, переиспользовал бы вердикты, где
  // визуальный гейт был advisory, — матрица выглядела бы пройденной (план §3 D10).
  for (const caseId of ["default", "accent"]) {
    expect(casePolicyHashOf(required, caseId)).not.toBe(casePolicyHashOf(advisory, caseId));
  }
  db.close();
});

test("the capture block of the manifest becomes the run surface", () => {
  const db = dbWithAsset();
  const { manifest: parsed } = validateManifest(db, "yp-badge", manifest({
    capture: { viewport: { width: 320, height: 200 }, deviceScaleFactor: 3, theme: "dark" },
  } as unknown as Partial<CaseSetManifest>));
  expect(surfaceOfManifest(parsed)).toEqual({ viewport: { width: 320, height: 200 }, dsf: 3, theme: "dark" });
  // Умолчания поверхности совпадают с `DEFAULT_CASE_SURFACE` examples-пути.
  const plain = validateManifest(db, "yp-badge", manifest()).manifest;
  expect(surfaceOfManifest({ ...plain, capture: { viewport: { width: 390, height: 844 } } })).toEqual({ viewport: { width: 390, height: 844 }, dsf: 2, theme: "light" });
  db.close();
});

test("caseSetIdOf and the stored row agree on the address", () => {
  const db = dbWithAsset();
  const { manifest: parsed, caseSetId } = validateManifest(db, "yp-badge", manifest());
  const { row } = new CaseSetRepo(db).put({ componentId: "yp-badge", designSystem: "yandex-pay", manifest: parsed, createdBy: "user_a" });
  expect(row.case_set_id).toBe(caseSetId);
  expect(caseSetIdOf(parsed)).toBe(caseSetId);
  db.close();
});

// ------------------------------------------------- инвалидация reuse на границе волны (D1)

test("algoVersion bump invalidates every fingerprint accumulated by earlier waves", () => {
  // Граница волны обязана обнулить накопленный reuse: в W2 во входы вошёл `case_policy_hash`,
  // в W3 — геометрия 2.0 (`probe:"paint"`, другой вердикт по тем же props), в W4 — реальные
  // readiness/env вместо заглушек, в W5a — визуальный гейт. Версия 6 (план 2026-08-04, D-B) —
  // расслоение отпечатка на кадр/сравнение/вердикт: это другая **модель** случая, а не другие
  // значения внутри прежней, поэтому прод-кэш инвалидируется целиком (санкционировано планом).
  // Версия 7 (план 2026-08-05 §A4) — слот-биндинги во входах кадра: тот же класс события.
  expect(CASE_FINGERPRINT_ALGO_VERSION).toBe(7);
  const frame = frameFingerprint({
    candidateId: `cand_${"0".repeat(64)}`, caseKey: "alpha", propsHash: "props-1",
    surface: { viewport: { width: 390, height: 844 }, dsf: 2, theme: "light" },
    readinessPolicyHash: DEFAULT_READINESS_POLICY_HASH, rendererFingerprint: DEFAULT_RENDERER_FINGERPRINT,
  });
  const comparison = comparisonFingerprintOf({
    referenceAssetId: null, expectedGeometry: null, maxDimensionDeltaPx: 8, paintMarginPx: 64, deviceScaleFactor: 2,
  });
  const verdictPolicy = verdictPolicyHashOf(verdictPolicySnapshotOf(ACCEPTANCE_POLICIES["default-v1"], { caseKey: "alpha", propsHash: "props-1" }));
  const base = { frame, comparison, verdictPolicy };
  expect(caseFingerprint({ ...base, algoVersion: 6 })).not.toBe(caseFingerprint({ ...base, algoVersion: 5 }));
  expect(caseFingerprint({ ...base, algoVersion: 5 })).not.toBe(caseFingerprint({ ...base, algoVersion: 4 }));
  expect(caseFingerprint({ ...base, algoVersion: 4 })).not.toBe(caseFingerprint({ ...base, algoVersion: 3 }));

  // Случай case-set'а с собственным эталоном и допуском отличается от одноимённого examples-случая.
  const fingerprintsOf = (item: Parameters<typeof caseFingerprintsOf>[0]["case"]): string => caseFingerprintsOf({
    candidateId: `cand_${"0".repeat(64)}`,
    surface: { viewport: { width: 390, height: 844 }, dsf: 2, theme: "light" },
    policy: ACCEPTANCE_POLICIES["default-v1"],
    case: item,
  }).case;
  const plain = { caseKey: "alpha", propsHash: "props-1" };
  expect(fingerprintsOf({ ...plain, casePolicy: { maxRawDiffPct: 0.1 } })).not.toBe(fingerprintsOf(plain));
  expect(fingerprintsOf({ ...plain, referenceAssetId: ASSET })).not.toBe(fingerprintsOf(plain));
});

// ------------------------------------------------- content-hug reference (W5, фидбэк P1)

/**
 * Ассет с настоящими габаритами: `crop_rect_out_of_bounds` меряет rect именно против них, а
 * warning «expectedGeometry похож на канву» — против них же.
 */
const dbWithSizedAsset = (id: string, width: number, height: number): Database => {
  const db = new Database(":memory:");
  migrate(db);
  db.run("INSERT INTO assets (id,sha256,mime,size,width,height,created_at) VALUES (?,?,'image/png',10,?,?,'now')",
    [id, id.slice("asset_".length), width, height]);
  return db;
};

const NODE_ASSET = `asset_${"b".repeat(64)}`;

test("W5: cropLineage.rect за пределами эталона отвергается при PUT, а не клампится при сравнении", () => {
  const db = dbWithSizedAsset(NODE_ASSET, 200, 160);
  // Вырезка помещается — набор валиден.
  validateManifest(db, "yp-badge", manifest({
    cases: [{ id: "default", props: { tone: "neutral" }, referenceAssetId: NODE_ASSET, cropLineage: { rect: [20, 10, 136, 32] } }],
  } as unknown as Partial<CaseSetManifest>));
  // Вырезка вылезает по высоте: сегодня воркер молча урезал бы её и сравнил не то, что объявлено.
  fails(() => validateManifest(db, "yp-badge", manifest({
    cases: [{ id: "default", props: { tone: "neutral" }, referenceAssetId: NODE_ASSET, cropLineage: { rect: [20, 150, 136, 32] } }],
  } as unknown as Partial<CaseSetManifest>)), 422, "crop_rect_out_of_bounds");
  // Уже вырезанный ассет: rect — provenance родительского узла, к байтам он не применяется,
  // поэтому и границами ассета не меряется (иначе честный provenance был бы невыразим).
  validateManifest(db, "yp-badge", manifest({
    cases: [{
      id: "default", props: { tone: "neutral" }, referenceAssetId: NODE_ASSET,
      cropLineage: { rect: [20, 150, 136, 32], sourceSurface: "content-hug" },
    }],
  } as unknown as Partial<CaseSetManifest>));
  db.close();
});

test("W5: content-hug + cropLineage требует sourceSurface \"figma-node\" — иначе crop_lineage_conflict", () => {
  const db = dbWithSizedAsset(NODE_ASSET, 200, 160);
  // «Ассет — экспорт узла, вырежи из него content-hug» — связное утверждение.
  validateManifest(db, "yp-badge", manifest({
    cases: [{
      id: "default", props: { tone: "neutral" }, referenceAssetId: NODE_ASSET,
      referenceSurface: "content-hug", expectedGeometry: { width: 136, height: 32 },
      cropLineage: { rect: [20, 10, 136, 32], sourceSurface: "figma-node" },
    }],
  } as unknown as Partial<CaseSetManifest>));
  // «Ассет уже content-hug» + «вырежи из него» — два взаимоисключающих утверждения об одном ассете.
  for (const sourceSurface of [undefined, "content-hug", "paint"]) {
    fails(() => validateManifest(db, "yp-badge", manifest({
      cases: [{
        id: "default", props: { tone: "neutral" }, referenceAssetId: NODE_ASSET,
        referenceSurface: "content-hug", expectedGeometry: { width: 136, height: 32 },
        cropLineage: { rect: [20, 10, 136, 32], ...(sourceSurface === undefined ? {} : { sourceSurface }) },
      }],
    } as unknown as Partial<CaseSetManifest>)), 422, "crop_lineage_conflict");
  }
  db.close();
});

test("W5: expectedGeometry, равный padded-канве эталона, ловится warning'ом (репро pay-card-button)", () => {
  // Ровно фидбэк P1: автор увидел `264×160` в диагностике упавшего сравнения и вписал канву в
  // `expectedGeometry` — геометрия начала судить layout-корень против канвы и упала 12/12.
  const db = dbWithSizedAsset(NODE_ASSET, 264, 160);
  const { warnings } = validateManifest(db, "yp-badge", manifest({
    capture: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, theme: "light" },
    cases: [{ id: "default", props: { tone: "neutral" }, referenceAssetId: NODE_ASSET, expectedGeometry: { width: 264, height: 160 } }],
  } as unknown as Partial<CaseSetManifest>));
  expect(warnings.some((line) => line.includes("LAYOUT ROOT") && line.includes("136×32"))).toBe(true);

  // Правильная запись того же случая: корень 136×32 + content-hug эталон — warning'а нет.
  const clean = dbWithSizedAsset(NODE_ASSET, 136, 32);
  const ok = validateManifest(clean, "yp-badge", manifest({
    capture: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, theme: "light" },
    cases: [{
      id: "default", props: { tone: "neutral" }, referenceAssetId: NODE_ASSET,
      referenceSurface: "content-hug", referencePlacement: { x: 64, y: 64 },
      expectedGeometry: { width: 136, height: 32 },
    }],
  } as unknown as Partial<CaseSetManifest>));
  expect(ok.warnings).toEqual([]);
  db.close();
  clean.close();
});

test("W5: новые поля доезжают до случая рана без подстановки дефолтов", () => {
  const db = dbWithSizedAsset(NODE_ASSET, 200, 160);
  const { manifest: parsed } = validateManifest(db, "yp-badge", manifest({
    cases: [
      {
        id: "hug", props: { tone: "neutral" }, referenceAssetId: NODE_ASSET,
        referenceSurface: "content-hug", referencePlacement: { x: 128, y: 128 },
        expectedGeometry: { width: 136, height: 32 },
        cropLineage: { rect: [20, 10, 136, 32], sourceSurface: "figma-node" },
      },
      { id: "legacy", props: { tone: "accent" }, referenceAssetId: NODE_ASSET, cropLineage: { rect: [20, 10, 136, 32] } },
    ],
  } as unknown as Partial<CaseSetManifest>));
  const [hug, legacy] = buildCasesFromManifest(parsed);
  expect(hug).toMatchObject({
    referenceSurface: "content-hug", referencePlacement: { x: 128, y: 128 },
    cropLineage: { rect: [20, 10, 136, 32], sourceSurface: "figma-node" },
  });
  // Legacy-случай не получает дефолтов: отсутствующее поле обязано остаться отсутствующим до
  // самого `comparisonFingerprint`, иначе отпечатки старых манифестов сдвинулись бы (C6/D13).
  expect(Object.keys(legacy!)).not.toContain("referenceSurface");
  expect(Object.keys(legacy!)).not.toContain("referencePlacement");
  expect(legacy!.cropLineage).toEqual({ rect: [20, 10, 136, 32] });
  db.close();
});

/**
 * Голден-неизменность (C25/D13). Манифест по мотивам `pay-card-button` из фидбэка, записанный
 * **до** W5. Его контентный адрес — часть продукта: раны ссылаются на `cset_`, и сдвиг адреса
 * означал бы, что исторический набор больше не резолвится, а повторный PUT плодит строки.
 * Литерал здесь — не «зафиксируем то, что вышло», а именно этот инвариант.
 */
const HISTORIC_MANIFEST = {
  manifestVersion: 1,
  componentId: "yp-badge",
  capture: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, theme: "light" },
  requireVisual: true,
  policy: { profile: "pixel-strict-v1", perCase: { primary: { maxRawDiffPct: 1 } } },
  dimensions: { variant: ["primary", "secondary"] },
  cases: [
    {
      id: "primary", props: { variant: "primary", label: "Оплатить" }, referenceAssetId: NODE_ASSET,
      expectedGeometry: { width: 136, height: 32 }, cropLineage: { parentNodeId: "12:34", rect: [20, 10, 136, 32] },
      dims: { variant: "primary" },
    },
    { id: "secondary", props: { variant: "secondary", label: "Оплатить" }, dims: { variant: "secondary" } },
  ],
} as const;

test("W5: голден-неизменность — исторический манифест сохраняет свой cset_ и остаётся cached", () => {
  const db = dbWithSizedAsset(NODE_ASSET, 200, 160);
  const { manifest: parsed, caseSetId } = validateManifest(db, "yp-badge", structuredClone(HISTORIC_MANIFEST));
  expect(caseSetId).toBe("cset_5455a1a56ae2bd8a278d6c697a66645b099ea649ed46516acb65930e0c9e1dbb");
  // И тот же инвариант в форме, не зависящей от литерала: адрес — это хэш **того, что прислали**,
  // а не того, что дописал парсер. Появись у нового поля `.default()`, равенство сломалось бы.
  expect(caseSetId).toBe(`cset_${new Bun.CryptoHasher("sha256").update(canonicalStringify(HISTORIC_MANIFEST)).digest("hex")}`);

  const repo = new CaseSetRepo(db);
  const first = repo.put({ componentId: "yp-badge", designSystem: "yandex-pay", manifest: parsed, createdBy: "user_a" });
  expect(first.cached).toBe(false);
  // Повторный PUT того же исторического манифеста — та же строка, а не новая версия набора.
  const again = validateManifest(db, "yp-badge", structuredClone(HISTORIC_MANIFEST));
  const second = repo.put({ componentId: "yp-badge", designSystem: "yandex-pay", manifest: again.manifest, createdBy: "user_a" });
  expect(second.cached).toBe(true);
  expect(second.row.case_set_id).toBe(caseSetId);

  // Новые поля появляются в адресе только тогда, когда их объявили: сам факт их существования в
  // схеме адрес не двигает (`.optional()` без `.default()`).
  const hug = validateManifest(db, "yp-badge", {
    ...structuredClone(HISTORIC_MANIFEST),
    cases: [
      { ...structuredClone(HISTORIC_MANIFEST.cases[0]), referenceSurface: "content-hug", cropLineage: { parentNodeId: "12:34", rect: [20, 10, 136, 32], sourceSurface: "figma-node" } },
      structuredClone(HISTORIC_MANIFEST.cases[1]),
    ],
  });
  expect(hug.caseSetId).not.toBe(caseSetId);
  db.close();
});

// ------------------------------------------- слот-биндинги (план 2026-08-05 §A1–A3, T1.1)

/**
 * Публикация компонента «как настоящая»: строка каталога + ревизия + публикация с `definition_meta`.
 * Ровно эти три таблицы читает `publishedPinByNameAndVersion`, и ДС берётся у **ревизии**.
 */
const seedPublish = (db: Database, input: {
  id: string; name: string; version?: number; status?: string; designSystem?: string;
  deleted?: boolean; meta?: Record<string, unknown>;
}): void => {
  const version = input.version ?? 1;
  const designSystem = input.designSystem ?? "yandex-pay";
  if (!db.query("SELECT 1 ok FROM components WHERE id=?").get(input.id)) {
    db.run(`INSERT INTO components (id,name,head_rev,design_system,deleted_at,created_at,updated_at)
      VALUES (?,?,?,?,?,'now','now')`, [input.id, input.name, version, designSystem, input.deleted ? "now" : null]);
  } else if (input.deleted) {
    db.run("UPDATE components SET deleted_at='now' WHERE id=?", [input.id]);
  }
  db.run("INSERT INTO component_revisions (component_id,rev,source,design_system,message,created_at) VALUES (?,?,'src',?,NULL,'now')",
    [input.id, version, designSystem]);
  db.run(`INSERT INTO component_publishes
    (component_id,version,rev,status,compiled_js,definition_meta,source_hash,bundle_hash,host_abi_version,message,published_at)
    VALUES (?,?,?,?,'js',?,?,?,2,NULL,'now')`,
    [input.id, version, version, input.status ?? "active", JSON.stringify(input.meta ?? {}),
      `sh-${input.id}-${version}`, `bh-${input.id}-${version}`]);
};

/** Субъект (`yp-badge`) с именованным слотом `items` + один опубликованный ребёнок. */
const dbWithSlotFamily = (): Database => {
  const db = dbWithAsset();
  seedPublish(db, {
    id: "yp-badge", name: "YpBadge",
    meta: { slots: ["items"], capabilities: { namedSlots: true } },
  });
  seedPublish(db, {
    id: "pay-child", name: "PayChild",
    meta: { propsJsonSchema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] } },
  });
  return db;
};

const slotManifest = (cases: unknown[]): Record<string, unknown> =>
  manifest({ cases } as unknown as Partial<CaseSetManifest>);

const child = (label: string, version = 1) => ({ type: "PayChild", version, props: { label } });

test("§A3: одинаковые props с разным содержимым слота — два случая, а не duplicate_case_props", () => {
  // Ровно репро фидбэка (PaySmsModule): два состояния Figma отличаются только детьми слота, у
  // родителя props идентичны. До §A3 такой манифест отвергался при PUT, а обойдя PUT — схлопывался
  // в один кадр внутри `buildCasesFromManifest`, и матрица «проходила», ничего не сняв.
  const db = dbWithSlotFamily();
  const { manifest: parsed, warnings } = validateManifest(db, "yp-badge", slotManifest([
    { id: "one-message", props: { title: "SMS" }, slotBindings: { items: [child("a")] } },
    { id: "two-messages", props: { title: "SMS" }, slotBindings: { items: [child("a"), child("b")] } },
  ]));
  expect(warnings).toEqual([]);
  const cases = buildCasesFromManifest(parsed);
  expect(cases.map((item) => [item.caseId, item.aliasOfCaseId]))
    .toEqual([["one-message", null], ["two-messages", null]]);
  // Число кадров едет наружу: агент берёт его как `expectedCases` promote'а.
  expect(coverageOf(parsed).frameCases).toBe(2);
  // Порядок детей — порядок рендера: перестановка это другой кадр, а не тот же набор.
  const swapped = validateManifest(db, "yp-badge", slotManifest([
    { id: "one-message", props: { title: "SMS" }, slotBindings: { items: [child("b"), child("a")] } },
  ]));
  expect(dedupSlotsKeyOf(swapped.manifest.cases[0]!.slotBindings))
    .not.toBe(dedupSlotsKeyOf(parsed.cases[1]!.slotBindings));
  db.close();
});

test("§A3: одинаковые props И одинаковые биндинги — по-прежнему duplicate_case_props", () => {
  const db = dbWithSlotFamily();
  fails(() => validateManifest(db, "yp-badge", slotManifest([
    { id: "one", props: { title: "SMS" }, slotBindings: { items: [child("a")] } },
    { id: "two", props: { title: "SMS" }, slotBindings: { items: [child("a")] } },
  ])), 422, "duplicate_case_props");
  // И порядок ключей слотов на это не влияет: ключ дедупа канонизован, как и адрес набора.
  fails(() => validateManifest(db, "yp-badge", slotManifest([
    { id: "one", props: { title: "SMS" }, slotBindings: { items: [child("a")], default: [child("b")] } },
    { id: "two", props: { title: "SMS" }, slotBindings: { default: [child("b")], items: [child("a")] } },
  ])), 422, "duplicate_case_props");
  db.close();
});

test("§A3: `props: {}` у ребёнка эквивалентен отсутствию props — дедуп их схлопывает", () => {
  const db = dbWithSlotFamily();
  seedPublish(db, { id: "pay-plain", name: "PayPlain" });
  fails(() => validateManifest(db, "yp-badge", slotManifest([
    { id: "one", props: { title: "t" }, slotBindings: { items: [{ type: "PayPlain", version: 1 }] } },
    { id: "two", props: { title: "t" }, slotBindings: { items: [{ type: "PayPlain", version: 1, props: {} }] } },
  ])), 422, "duplicate_case_props");
  db.close();
});

test("§A3: алиас обязан повторить и props, и биндинги цели", () => {
  const db = dbWithSlotFamily();
  const ok = validateManifest(db, "yp-badge", slotManifest([
    { id: "one", props: { title: "t" }, slotBindings: { items: [child("a")] } },
    { id: "copy", props: { title: "t" }, slotBindings: { items: [child("a")] }, aliasOf: "one" },
  ]));
  expect(buildCasesFromManifest(ok.manifest).map((item) => item.aliasOfCaseId)).toEqual([null, "one"]);

  for (const bindings of [{ items: [child("b")] }, undefined]) {
    fails(() => validateManifest(db, "yp-badge", slotManifest([
      { id: "one", props: { title: "t" }, slotBindings: { items: [child("a")] } },
      { id: "copy", props: { title: "t" }, ...(bindings ? { slotBindings: bindings } : {}), aliasOf: "one" },
    ])), 422, "invalid_alias_target");
  }
  db.close();
});

test("§A2: `$`- и `__eui`-префиксы в props ребёнка — отказ slot_props_dynamic", () => {
  const db = dbWithSlotFamily();
  for (const props of [
    { $asset: "asset_1" },
    { $cond: { when: "x" } },
    { __euiRef: 1 },
    { label: "a", nested: { deep: [{ $asset: "asset_1" }] } },
  ]) {
    fails(() => validateManifest(db, "yp-badge", slotManifest([
      { id: "one", props: { title: "t" }, slotBindings: { items: [{ type: "PayChild", version: 1, props }] } },
    ])), 422, "slot_props_dynamic");
  }
  db.close();
});

test("§A2: пин ребёнка резолвится по имени и точной версии; надгробие не резолвится", () => {
  const db = dbWithSlotFamily();
  seedPublish(db, { id: "pay-gone", name: "PayGone", meta: {} , deleted: true });
  expect(publishedPinByNameAndVersion(db, "PayChild", 1, "yandex-pay")).toMatchObject({
    componentId: "pay-child", version: 1, status: "active", bundleHash: "bh-pay-child-1", designSystem: "yandex-pay",
  });
  // Soft-deleted компонент: имя зарезервировано, но пин обязан не резолвиться.
  expect(publishedPinByNameAndVersion(db, "PayGone", 1, "yandex-pay")).toBeNull();
  fails(() => validateManifest(db, "yp-badge", slotManifest([
    { id: "one", props: { title: "t" }, slotBindings: { items: [{ type: "PayGone", version: 1 }] } },
  ])), 422, "slot_component_not_published");
  // Несуществующая версия существующего компонента — тот же отказ.
  fails(() => validateManifest(db, "yp-badge", slotManifest([
    { id: "one", props: { title: "t" }, slotBindings: { items: [child("a", 7)] } },
  ])), 422, "slot_component_not_published");
  db.close();
});

test("§A2: archived-ребёнок отвергается, superseded/deprecated проходят с warning'ом", () => {
  const db = dbWithSlotFamily();
  seedPublish(db, { id: "pay-old", name: "PayOld", version: 1, status: "superseded" });
  seedPublish(db, { id: "pay-old", name: "PayOld", version: 2, status: "active" });
  seedPublish(db, { id: "pay-dead", name: "PayDead", version: 1, status: "archived" });

  // Промоут авто-supersede'ит прежние версии — асимметричный гейт сломал бы идемпотентный повтор
  // PUT байт-в-байт того же манифеста ровно в момент выхода новой версии ребёнка.
  const superseded = validateManifest(db, "yp-badge", slotManifest([
    { id: "one", props: { title: "t" }, slotBindings: { items: [{ type: "PayOld", version: 1 }] } },
  ]));
  expect(superseded.warnings.join("\n")).toContain("slot_pin_superseded");
  // Повтор того же манифеста даёт тот же контентный адрес и тот же warning — публикация идемпотентна.
  const again = validateManifest(db, "yp-badge", slotManifest([
    { id: "one", props: { title: "t" }, slotBindings: { items: [{ type: "PayOld", version: 1 }] } },
  ]));
  expect(again.caseSetId).toBe(superseded.caseSetId);

  fails(() => validateManifest(db, "yp-badge", slotManifest([
    { id: "one", props: { title: "t" }, slotBindings: { items: [{ type: "PayDead", version: 1 }] } },
  ])), 422, "slot_component_not_published");
  db.close();
});

test("§A2: чужая ДС, ссылка на себя и props мимо схемы пина — три разных отказа", () => {
  const db = dbWithSlotFamily();
  seedPublish(db, { id: "sh-child", name: "ShChild", designSystem: "other-ds" });

  fails(() => validateManifest(db, "yp-badge", slotManifest([
    { id: "one", props: { title: "t" }, slotBindings: { items: [{ type: "ShChild", version: 1 }] } },
  ])), 422, "slot_component_design_system_mismatch");
  fails(() => validateManifest(db, "yp-badge", slotManifest([
    { id: "one", props: { title: "t" }, slotBindings: { items: [{ type: "YpBadge", version: 1 }] } },
  ])), 422, "slot_self_reference");
  // Схема запиненной версии ребёнка требует строковый `label`.
  fails(() => validateManifest(db, "yp-badge", slotManifest([
    { id: "one", props: { title: "t" }, slotBindings: { items: [{ type: "PayChild", version: 1, props: { label: 5 } }] } },
  ])), 422, "slot_props_invalid");
  fails(() => validateManifest(db, "yp-badge", slotManifest([
    { id: "one", props: { title: "t" }, slotBindings: { items: [{ type: "PayChild", version: 1, props: {} }] } },
  ])), 422, "slot_props_invalid");
  db.close();
});

test("§A2a: дефолтный слот легален и не требует объявления в slots компонента", () => {
  const db = dbWithSlotFamily();
  const nine = Array.from({ length: 9 }, (_, index) => child(`card-${index}`));
  const { manifest: parsed, warnings } = validateManifest(db, "yp-badge", slotManifest([
    { id: "carousel", props: { title: "t" }, slotBindings: { default: nine } },
  ]));
  expect(parsed.cases[0]!.slotBindings?.default).toHaveLength(9);
  // Ни `slot_unknown`, ни `slot_bindings_unsupported` (и их PUT-warning'ов) на дефолтном слоте нет.
  expect(warnings).toEqual([]);
  // Именованный слот вне объявленных — warning при PUT (жёсткий отказ — на старте рана, T2.1).
  const named = validateManifest(db, "yp-badge", slotManifest([
    { id: "one", props: { title: "t" }, slotBindings: { footer: [child("a")] } },
  ]));
  expect(named.warnings.join("\n")).toContain('slot "footer" is not among the named slots');
  db.close();
});

test("§A1: схема слот-биндингов — глубина 1, лимиты детей и слотов, charset ключа", () => {
  const db = dbWithSlotFamily();
  const cases = (slotBindings: unknown) => slotManifest([{ id: "one", props: { title: "t" }, slotBindings }]);
  // Вложенность: `strictObject` ребёнка не знает полей поддерева.
  fails(() => validateManifest(db, "yp-badge", cases({ items: [{ type: "PayChild", version: 1, slotBindings: { items: [child("a")] } }] })),
    422, "validation_failed");
  fails(() => validateManifest(db, "yp-badge", cases({ items: [{ type: "PayChild", version: 1, children: [child("a")] }] })),
    422, "validation_failed");
  // Версия обязательна и целая положительная.
  for (const bad of [{ type: "PayChild" }, { type: "PayChild", version: 0 }, { type: "PayChild", version: 1.5 }]) {
    fails(() => validateManifest(db, "yp-badge", cases({ items: [bad] })), 422, "validation_failed");
  }
  // Потолки: 12 детей в слоте, 8 слотов в случае, пустой слот.
  fails(() => validateManifest(db, "yp-badge", cases({ items: Array.from({ length: 13 }, (_, i) => child(`c${i}`)) })),
    422, "validation_failed");
  fails(() => validateManifest(db, "yp-badge", cases({ items: [] })), 422, "validation_failed");
  fails(() => validateManifest(db, "yp-badge", cases(Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [`slot-${i}`, [child("a")]])))), 422, "validation_failed");
  // Charset ключа слота — тот же, что у `definition.slots`.
  for (const key of ["Items", "items_1", "-items", "items-", "i".repeat(33)]) {
    fails(() => validateManifest(db, "yp-badge", cases({ [key]: [child("a")] })), 422, "validation_failed");
  }
  db.close();
});

test("§A3/C6: слот-free манифест ведёт себя ровно как раньше, а биндинги двигают адрес набора", () => {
  const db = dbWithSlotFamily();
  const plain = validateManifest(db, "yp-badge", manifest());
  // Само существование поля в схеме адрес не двигает (`.optional()` без `.default()`).
  expect(plain.caseSetId).toBe(caseSetIdOf(plain.manifest));
  expect(Object.keys(plain.manifest.cases[0]!)).not.toContain("slotBindings");
  expect(caseDedupKeyOf(plain.manifest.cases[0]!)).toBe(`${buildCasesFromManifest(plain.manifest)[0]!.propsHash}:-`);
  // Тот же манифест со слотом — другой набор.
  const bound = validateManifest(db, "yp-badge", slotManifest([
    { id: "default", props: { tone: "neutral" }, slotBindings: { items: [child("a")] } },
    { id: "accent", props: { tone: "accent" } },
  ]));
  expect(bound.caseSetId).not.toBe(plain.caseSetId);
  db.close();
});

test("§A3: slotsHash считается по резолвнутому кортежу и не зависит от лишних полей", () => {
  const resolved = [
    { slot: "items", index: 0, componentId: "pay-child", version: 1, bundleHash: "bh-1", propsHash: "ph-1" },
    { slot: "items", index: 1, componentId: "pay-child", version: 1, bundleHash: "bh-1", propsHash: "ph-2" },
  ];
  const hash = slotsHashOf(resolved);
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  // Проекция явная: `name`/`props` в прообраз не входят.
  expect(slotsHashOf(resolved.map((item) => ({ ...item, name: "PayChild", props: { label: "a" } })))).toBe(hash);
  // Порядок и байты ребёнка — входят.
  expect(slotsHashOf([resolved[1]!, resolved[0]!])).not.toBe(hash);
  expect(slotsHashOf([{ ...resolved[0]!, bundleHash: "bh-2" }, resolved[1]!])).not.toBe(hash);
  expect(slotsHashOf([])).not.toBe(hash);
});

test("откат сборки: нечитаемый сохранённый манифест — именованный отказ, а не голая 500", () => {
  const db = dbWithAsset();
  const { manifest: parsed } = validateManifest(db, "yp-badge", manifest());
  const { row } = new CaseSetRepo(db).put({ componentId: "yp-badge", designSystem: "yandex-pay", manifest: parsed, createdBy: "user_a" });
  // Ровно то, что увидела бы сборка, выпущенная до этой волны, прочитав манифест со `slotBindings`.
  db.run("UPDATE component_case_sets SET manifest_json=? WHERE case_set_id=?",
    [JSON.stringify({ ...parsed, unknownFutureField: 1 }), row.case_set_id]);
  fails(() => manifestOfRow(new CaseSetRepo(db).require(row.case_set_id)), 422, "case_set_manifest_unreadable");
  db.close();
});
