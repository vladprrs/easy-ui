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
  buildCasesFromManifest, CaseSetRepo, caseDedupKeyOf, casePolicyHashOf, caseSetIdOf, casesOfRun, coverageOf,
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

// --------------------------------------------- per-case допуски W3 (план 2026-08-06)

test("W3: sizeDeltaPx и overflowBudgetPx принимаются, а их конфликт — 422 case_policy_conflict", () => {
  const db = dbWithAsset();
  const ok = validateManifest(db, "yp-badge", manifest({
    policy: { perCase: { default: { sizeDeltaPx: 8, overflowBudgetPx: { top: 4, bottom: 12 } } } },
  } as unknown as Partial<CaseSetManifest>));
  expect(ok.manifest.policy?.perCase?.default).toEqual({ sizeDeltaPx: 8, overflowBudgetPx: { top: 4, bottom: 12 } });

  // Бланкетное разрешение и per-side бюджет — два разных намерения об одном вердикте: выбрать
  // за автора сервер не вправе, поэтому отказ, а не «бюджет побеждает».
  fails(() => validateManifest(db, "yp-badge", manifest({
    policy: { perCase: { default: { allowPaintOverflow: true, overflowBudgetPx: { top: 4 } } } },
  } as unknown as Partial<CaseSetManifest>)), 422, "case_policy_conflict");
  // По отдельности оба легальны, в том числе `allowPaintOverflow: false`… — конфликт объявлен по
  // присутствию поля, а не по его значению (объявленное «нельзя» тоже спорит с бюджетом).
  validateManifest(db, "yp-badge", manifest({
    policy: { perCase: { default: { allowPaintOverflow: true, sizeDeltaPx: 8 } } },
  } as unknown as Partial<CaseSetManifest>));
  fails(() => validateManifest(db, "yp-badge", manifest({
    policy: { perCase: { default: { allowPaintOverflow: false, overflowBudgetPx: { top: 4 } } } },
  } as unknown as Partial<CaseSetManifest>)), 422, "case_policy_conflict");

  // Схема: потолки и «хотя бы одна сторона» — отказ схемы, а не тихая нормализация.
  for (const perCase of [
    { default: { sizeDeltaPx: 65 } }, { default: { sizeDeltaPx: 1.5 } },
    { default: { overflowBudgetPx: {} } }, { default: { overflowBudgetPx: { top: 257 } } },
    { default: { overflowBudgetPx: { middle: 4 } } },
  ]) {
    fails(() => validateManifest(db, "yp-badge", manifest({ policy: { perCase } } as unknown as Partial<CaseSetManifest>)),
      422, "validation_failed");
  }
  db.close();
});

test("W3: новые поля живут в вердиктном слое — кадр и сравнение случая не сдвигаются", () => {
  const db = dbWithAsset();
  const base = manifest({
    cases: [{ id: "default", props: { tone: "neutral" }, referenceAssetId: ASSET, expectedGeometry: { width: 140, height: 96 } }],
  } as unknown as Partial<CaseSetManifest>);
  const withPolicy = manifest({
    cases: [{ id: "default", props: { tone: "neutral" }, referenceAssetId: ASSET, expectedGeometry: { width: 140, height: 96 } }],
    policy: { perCase: { default: { sizeDeltaPx: 8, overflowBudgetPx: { top: 4 } } } },
  } as unknown as Partial<CaseSetManifest>);

  const fingerprints = (source: Record<string, unknown>) => {
    const [item] = buildCasesFromManifest(validateManifest(db, "yp-badge", source).manifest);
    return caseFingerprintsOf({
      candidateId: `cand_${"0".repeat(64)}`,
      surface: surfaceOfManifest(validateManifest(db, "yp-badge", source).manifest),
      policy: ACCEPTANCE_POLICIES["default-v1"],
      case: item!,
    });
  };
  const before = fingerprints(base);
  const after = fingerprints(withPolicy);
  // Кадр и сравнение обязаны совпасть байт-в-байт: допуски не двигают ни съёмку, ни канву.
  expect(after.frame).toBe(before.frame);
  expect(after.comparison).toBe(before.comparison);
  // Вердиктный слой — единственное, что разъехалось, и он же двигает итоговый отпечаток.
  expect(after.verdictPolicy).not.toBe(before.verdictPolicy);
  expect(after.case).not.toBe(before.case);
  db.close();
});

test("W3: манифест без новых полей даёт прежний cset_ id и прежний case_policy_hash", () => {
  // Регресс контентной адресации: поля строго `.optional()` без `.default()`, поэтому существующие
  // манифесты обязаны адресоваться теми же байтами, что и до волны.
  const db = dbWithAsset();
  const source = manifest({ policy: { perCase: { default: { maxRawDiffPct: 0.5 } } } } as unknown as Partial<CaseSetManifest>);
  const result = validateManifest(db, "yp-badge", source);
  // Значения сняты на коммите до волны (ff97ae6) — это и есть смысл регресса.
  expect(result.caseSetId).toBe("cset_cc83bec97d9df4eff6ba762771067407a87df77f7d0795f34885e4c96029d2c0");
  expect(casePolicyHashOf(result.manifest, "default")).toBe("aef33dbe0debf46e8007d62c9e9cc258d2d9613cb7135508d637b877912832c1");
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

test("§W5: capture.surface даёт ключ mode только у viewport — hug-наборы не двигают ни один хэш", () => {
  const db = dbWithAsset();
  const hug = validateManifest(db, "yp-badge", manifest()).manifest;
  const declaredHug = validateManifest(db, "yp-badge", manifest({
    capture: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, theme: "light", surface: "hug" },
  } as unknown as Partial<CaseSetManifest>)).manifest;
  const viewport = validateManifest(db, "yp-badge", manifest({
    capture: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, theme: "light", surface: "viewport" },
  } as unknown as Partial<CaseSetManifest>)).manifest;

  // 1. Отсутствие поля и явный `"hug"` дают **одну и ту же** поверхность без ключа `mode`: пре-образ
  //    `frameFingerprint` существующих наборов остаётся байт-в-байт прежним.
  expect(surfaceOfManifest(hug)).toEqual({ viewport: { width: 390, height: 844 }, dsf: 2, theme: "light" });
  expect(Object.hasOwn(surfaceOfManifest(declaredHug), "mode")).toBe(false);
  expect(surfaceOfManifest(declaredHug)).toEqual(surfaceOfManifest(hug));
  // 2. Кадры hug-случаев не сдвинулись волной: тот же случай — тот же frame_fingerprint.
  const frameOf = (parsed: CaseSetManifest) => caseFingerprintsOf({
    candidateId: "cand_surface", surface: surfaceOfManifest(parsed), policy: ACCEPTANCE_POLICIES["default-v1"],
    case: buildCasesFromManifest(parsed)[0]!,
  }).frame;
  expect(frameOf(declaredHug)).toBe(frameOf(hug));
  // 3. …а viewport-поверхность — другая сцена, и кадр обязан быть другим (иначе hug-кадр
  //    переиспользовался бы для модалки).
  expect(surfaceOfManifest(viewport)).toMatchObject({ mode: "viewport" });
  expect(frameOf(viewport)).not.toBe(frameOf(hug));
  // 4. Контентный адрес набора меняется вместе с полем — иначе два разных набора делили бы id.
  expect(caseSetIdOf(declaredHug)).not.toBe(caseSetIdOf(hug));
  expect(caseSetIdOf(viewport)).not.toBe(caseSetIdOf(hug));
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

test("§A1: схема слот-биндингов — лимиты детей и слотов, charset ключа, неизвестные поля", () => {
  const db = dbWithSlotFamily();
  const cases = (slotBindings: unknown) => slotManifest([{ id: "one", props: { title: "t" }, slotBindings }]);
  // §W6: поддерево теперь легально по форме (его смысл судят проверки ниже), а вот произвольное
  // поле ребёнка — по-прежнему отказ схемы: `strictObject` ничего не игнорирует молча.
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

// ------------------------------------------- вложенные слоты (план 2026-08-06 §W6)

/**
 * Субъект + двухуровневая цепочка публикаций: `PayRow` сам объявляет именованный слот `action`,
 * `PayButton` — лист. Ровно эта форма и есть сценарий фидбэка «Lead Block получает реальное
 * содержимое вложенной кнопки».
 */
const dbWithNestedSlotFamily = (): Database => {
  const db = dbWithSlotFamily();
  seedPublish(db, { id: "pay-row", name: "PayRow", meta: { slots: ["action"], capabilities: { namedSlots: true } } });
  // Второй слот-родитель нужен, чтобы строить цепочки глубже двух уровней: повтор одного и того же
  // компонента по пути — это `slot_self_reference`, а не «просто глубина».
  seedPublish(db, { id: "pay-row-b", name: "PayRowB", meta: { slots: ["action"], capabilities: { namedSlots: true } } });
  seedPublish(db, { id: "pay-row-c", name: "PayRowC", meta: { slots: ["action"], capabilities: { namedSlots: true } } });
  seedPublish(db, { id: "pay-btn", name: "PayButton", meta: {} });
  seedPublish(db, { id: "pay-leaf", name: "PayLeaf", meta: {} });
  return db;
};

const nestedCase = (id = "one") => ({
  id, props: { title: "t" },
  slotBindings: {
    items: [{
      type: "PayRow", version: 1,
      slotBindings: { action: [{ type: "PayButton", version: 1, props: { label: "Pay" } }] },
    }],
  },
});

test("§W6: набор глубины 1 хэшируется байт-в-байт как до волны вложенности", () => {
  // Голдены сняты на НЕИЗМЕНЁННОМ коде перед волной: поле `children` обязано попадать в прообраз
  // только условным спредом, иначе волна тихо инвалидировала бы каждый прод-кадр со слотами.
  const depth1 = [
    { slot: "header", index: 0, componentId: "c1", version: 1, bundleHash: "bh1", propsHash: "ph1" },
    { slot: "default", index: 0, componentId: "c2", version: 2, bundleHash: "bh2", propsHash: "ph2" },
  ];
  expect(slotsHashOf(depth1)).toBe("c7cae4bbd293f7d29635a1acfb67bed2d34ab99f453340301568af4a569c4b9a");
  // Пустой массив детей нормализуется в отсутствие ключа — «отсутствует, а не пусто».
  expect(slotsHashOf(depth1.map((item) => ({ ...item, children: [] })))).toBe(slotsHashOf(depth1));
  expect(dedupSlotsKeyOf({
    items: [{ type: "A", version: 1, props: { a: 1 } }], default: [{ type: "B", version: 2 }],
  })).toBe("2d38f4c47bbc6326414b14efedf34b31adf6f419689627c9c2a3e22eba4a6284");

  const db = dbWithNestedSlotFamily();
  // Адрес набора снят на неизменённом коде для ровно этого литерала манифеста.
  const flat = validateManifest(db, "yp-badge", {
    manifestVersion: 1, componentId: "yp-badge", capture: { viewport: { width: 390, height: 844 } },
    cases: [{ id: "one", props: { title: "SMS" }, slotBindings: { items: [{ type: "PayChild", version: 1, props: { label: "a" } }] } }],
  });
  expect(flat.caseSetId).toBe("cset_59037b99c6de3f2de19c58fbd95e77da52f38bda1f9c17eec783a3d5c3e01a70");
  // Поддерево двигает и ключ дедупа, и адрес набора.
  const nested = validateManifest(db, "yp-badge", slotManifest([nestedCase()]));
  expect(nested.caseSetId).not.toBe(flat.caseSetId);
  expect(dedupSlotsKeyOf(nested.manifest.cases[0]!.slotBindings)).not.toBe(dedupSlotsKeyOf(flat.manifest.cases[0]!.slotBindings));
  db.close();
});

test("§W6/B1: граничный манифест 8 слотов × 12 детей (96 узлов) принимается и читается manifestOfRow", () => {
  const db = dbWithNestedSlotFamily();
  const wide = Object.fromEntries(Array.from({ length: 8 }, (_, slot) =>
    [`slot-${slot}`, Array.from({ length: 12 }, (_, index) => child(`s${slot}-${index}`))]));
  const { manifest: parsed } = validateManifest(db, "yp-badge", slotManifest([{ id: "wide", props: { title: "t" }, slotBindings: wide }]));
  // Тотал равен прежнему максимуму, проверка строго `≤`: манифест, легальный до волны, легален и после.
  const { row } = new CaseSetRepo(db).put({ componentId: "yp-badge", designSystem: "yandex-pay", manifest: parsed, createdBy: "user_a" });
  const read = manifestOfRow(new CaseSetRepo(db).require(row.case_set_id));
  expect(Object.keys(read.cases[0]!.slotBindings!)).toHaveLength(8);
  expect(read.cases[0]!.slotBindings!["slot-7"]).toHaveLength(12);
  db.close();
});

test("§W6: глубина, тотал узлов и цикл — 422 с адресом узла", () => {
  const db = dbWithNestedSlotFamily();
  const rows = ["PayRow", "PayRowB", "PayRowC"];
  const nest = (depth: number, level = 0): Record<string, unknown> => depth === 0
    ? { type: "PayButton", version: 1 }
    : { type: rows[level % rows.length]!, version: 1, slotBindings: { action: [nest(depth - 1, level + 1)] } };

  // Три уровня (PayRow → PayRow → PayButton) — предел, четвёртый — отказ.
  expect(validateManifest(db, "yp-badge", slotManifest([{ id: "deep", props: { title: "t" }, slotBindings: { items: [nest(2)] } }])).warnings)
    .toEqual([]);
  fails(() => validateManifest(db, "yp-badge", slotManifest([{ id: "deep", props: { title: "t" }, slotBindings: { items: [nest(3)] } }])),
    422, "slot_depth_exceeded");

  // 97-й узел дерева случая — отказ (96 = 8×12 остаётся легальным, тест выше).
  const wide = Object.fromEntries(Array.from({ length: 8 }, (_, slot) =>
    [`slot-${slot}`, Array.from({ length: 12 }, (_, index) => child(`s${slot}-${index}`))]));
  const overflowing = {
    ...wide,
    "slot-0": [{ type: "PayRow", version: 1, slotBindings: { action: [{ type: "PayButton", version: 1 }] } },
      ...(wide["slot-0"] as unknown[]).slice(1)],
  };
  fails(() => validateManifest(db, "yp-badge", slotManifest([{ id: "big", props: { title: "t" }, slotBindings: overflowing }])),
    422, "slot_nodes_exceeded");

  // Цикл считается по всему пути: субъект внутри поддерева и повтор предка — один и тот же отказ.
  fails(() => validateManifest(db, "yp-badge", slotManifest([{
    id: "cycle", props: { title: "t" },
    slotBindings: { items: [{ type: "PayRow", version: 1, slotBindings: { action: [{ type: "YpBadge", version: 1 }] } }] },
  }])), 422, "slot_self_reference");
  fails(() => validateManifest(db, "yp-badge", slotManifest([{
    id: "cycle2", props: { title: "t" },
    slotBindings: { items: [{ type: "PayRow", version: 1, slotBindings: { action: [{ type: "PayRow", version: 1 }] } }] },
  }])), 422, "slot_self_reference");
  db.close();
});

test("§W6: вложенный слот судится по definition запиненного родителя — отказ уже при PUT", () => {
  const db = dbWithNestedSlotFamily();
  // Слот, которого у родителя нет: ждать старта рана незачем — его публикация иммутабельна.
  fails(() => validateManifest(db, "yp-badge", slotManifest([{
    id: "one", props: { title: "t" },
    slotBindings: { items: [{ type: "PayRow", version: 1, slotBindings: { trailing: [{ type: "PayButton", version: 1 }] } }] },
  }])), 422, "slot_unknown");
  // Родитель без `capabilities.namedSlots` именованный слот вообще не принимает…
  fails(() => validateManifest(db, "yp-badge", slotManifest([{
    id: "one", props: { title: "t" },
    slotBindings: { items: [{ type: "PayRow", version: 1, slotBindings: { action: [{ type: "PayButton", version: 1,
      slotBindings: { icon: [{ type: "PayLeaf", version: 1 }] } }] } }] },
  }])), 422, "slot_bindings_unsupported");
  // …но дефолтный слот exempt на любом уровне (§A2a).
  expect(validateManifest(db, "yp-badge", slotManifest([{
    id: "one", props: { title: "t" },
    slotBindings: { items: [{ type: "PayRow", version: 1, slotBindings: { default: [{ type: "PayButton", version: 1 }] } }] },
  }])).warnings).toEqual([]);
  db.close();
});

test("§W4: comparison.matte и textAaBudget доезжают до случая, а их отсутствие остаётся отсутствием", () => {
  const db = dbWithAsset();
  const parsed = validateManifest(db, "yp-badge", manifest({
    cases: [
      { id: "matted", props: { tone: "neutral" }, comparison: { matte: "#ffffff" }, textAaBudget: "live-text-v1" },
      { id: "plain", props: { tone: "accent" } },
    ],
  } as unknown as Partial<CaseSetManifest>)).manifest;
  const [matted, plain] = buildCasesFromManifest(parsed);
  expect(matted).toMatchObject({ comparison: { matte: "#ffffff" }, textAaBudget: "live-text-v1" });
  // Тот же инвариант отсутствия, что у W5-полей: дефолт применяет потребитель, не маппинг.
  expect(Object.keys(plain!)).not.toContain("comparison");
  expect(Object.keys(plain!)).not.toContain("textAaBudget");

  // Схема строгая: цвет словом, неизвестное имя пресета и опечатка в поле — отказ, а не дефолт.
  for (const bad of [
    { comparison: { matte: "white" } },
    { comparison: { matteColor: "#ffffff" } },
    { textAaBudget: "live-text-v2" },
  ]) {
    fails(() => validateManifest(db, "yp-badge", manifest({
      cases: [{ id: "default", props: { tone: "neutral" }, ...bad }],
    } as unknown as Partial<CaseSetManifest>)), 422, "validation_failed");
  }
  db.close();
});

// ------------------------------------------- поверхности геометрии (W1a, план 2026-08-07)

const surfaceCase = (extra: Record<string, unknown>): Record<string, unknown> =>
  manifest({ cases: [{ id: "default", props: { tone: "neutral" }, ...extra }] } as unknown as Partial<CaseSetManifest>);

test("W1a: доволновой манифест байт-в-байт — адрес набора и все три слоя отпечатка", () => {
  const db = dbWithAsset();
  // Литерал, а не пересчёт: контентный адрес набора, вычисленный **схемой из HEAD до волны**
  // (`git show HEAD:src/acceptance/caseSetSchema.ts`) на том же манифесте.
  // Само существование `expectedSurfaces`/`comparisonSurface`/`clipExpectation` в схеме адрес
  // двигать не вправе — это и есть инвариант «`.optional()` без `.default()`».
  const plain = validateManifest(db, "yp-badge", manifest());
  expect(plain.caseSetId).toBe("cset_ecbd02d58ff8146ed311e0f130d385aff5005916857dbe3deb951f16100e0806");
  expect(Object.keys(plain.manifest.cases[0]!).sort()).toEqual(["id", "props"]);

  // Легаси-случай с `expectedGeometry`: нормализация в `{layoutUnion}` до отпечатков не доезжает.
  const legacy = validateManifest(db, "yp-badge", surfaceCase({ expectedGeometry: { width: 480, height: 88 } }));
  const built = buildCasesFromManifest(legacy.manifest)[0]!;
  expect(built.expectedSurfaces).toBeUndefined();
  expect(built.comparisonSurface).toBeUndefined();
  expect(built.clipExpectation).toBeUndefined();
  const fingerprints = caseFingerprintsOf({
    candidateId: `cand_${"0".repeat(64)}`, surface: surfaceOfManifest(legacy.manifest),
    policy: ACCEPTANCE_POLICIES["default-v1"], case: built,
  });
  // BR-04 (план 2026-08-08 §4): при активной capture-группе слой сравнения несёт
  // `comparisonPolicyVersion` — семантика сравнения изменилась, не тронув ни одного поля манифеста,
  // и сохранённые под старой метрики обязаны перестать переиспользоваться. Инвариант W1a от этого
  // не страдает: **адрес набора** и кадровый слой остаются доволновыми (проверки выше и ниже), а
  // включение группы стоит ровно re-diff'а. Второй вызов доказывает и обратное: с выключенной
  // группой пре-образ сравнения снова доволновой байт-в-байт.
  const comparisonInput = {
    referenceAssetId: null,
    expectedGeometry: { width: 480, height: 88 },
    maxDimensionDeltaPx: ACCEPTANCE_POLICIES["default-v1"].visual.maxDimensionDeltaPx,
    paintMarginPx: 64, deviceScaleFactor: 2,
  };
  expect(fingerprints.comparison).toBe(comparisonFingerprintOf({ ...comparisonInput, comparisonPolicyVersion: 2 }));
  const previous = process.env.EASYUI_CAPTURE_V4_DISABLED;
  process.env.EASYUI_CAPTURE_V4_DISABLED = "1";
  try {
    const legacyFingerprints = caseFingerprintsOf({
      candidateId: `cand_${"0".repeat(64)}`, surface: surfaceOfManifest(legacy.manifest),
      policy: ACCEPTANCE_POLICIES["default-v1"], case: built,
    });
    expect(legacyFingerprints.comparison).toBe(comparisonFingerprintOf(comparisonInput));
    expect(legacyFingerprints.frame).toBe(fingerprints.frame);
  } finally {
    if (previous === undefined) delete process.env.EASYUI_CAPTURE_V4_DISABLED;
    else process.env.EASYUI_CAPTURE_V4_DISABLED = previous;
  }
  expect("expectedSurfaces" in fingerprints.verdictPolicySnapshot).toBe(false);
  db.close();
});

test("W1a: объявленные поверхности протягиваются как объявлены и двигают адрес набора", () => {
  const db = dbWithAsset();
  const declared = validateManifest(db, "yp-badge", surfaceCase({
    expectedSurfaces: { root: { width: 343, height: 88 }, layoutUnion: { width: 480, height: 88 } },
    comparisonSurface: "layoutUnion",
    clipExpectation: "root-does-not-clip-layout",
  }));
  expect(declared.caseSetId).not.toBe(validateManifest(db, "yp-badge", surfaceCase({})).caseSetId);
  const built = buildCasesFromManifest(declared.manifest)[0]!;
  expect(built.expectedSurfaces).toEqual({ root: { width: 343, height: 88 }, layoutUnion: { width: 480, height: 88 } });
  expect(built.comparisonSurface).toBe("layoutUnion");
  expect(built.clipExpectation).toBe("root-does-not-clip-layout");
  db.close();
});

test("W1a: три отказа декларации поверхностей", () => {
  const db = dbWithAsset();
  fails(() => validateManifest(db, "yp-badge", surfaceCase({
    expectedGeometry: { width: 480, height: 88 },
    expectedSurfaces: { layoutUnion: { width: 480, height: 88 } },
  })), 422, "case_surface_conflict");

  fails(() => validateManifest(db, "yp-badge", surfaceCase({
    expectedSurfaces: { root: { width: 343, height: 88 } },
    comparisonSurface: "referenceExport",
  })), 422, "case_comparison_surface_undeclared");

  fails(() => validateManifest(db, "yp-badge", surfaceCase({
    expectedSurfaces: { layoutUnion: { width: 480, height: 88 } },
    clipExpectation: "root-does-not-clip-layout",
  })), 422, "case_clip_expectation_requires_root");

  // Схема: пустая карта поверхностей — забытое намерение, а не «поверхностей нет».
  fails(() => validateManifest(db, "yp-badge", surfaceCase({ expectedSurfaces: {} })), 422, "validation_failed");
  db.close();
});

// ------------------------- candidate dependency overlay (план 2026-08-07 §1.2/§W3)

const CAND_LEAF = `cand_${"1".repeat(64)}`;
const CAND_MID = `cand_${"2".repeat(64)}`;
const CAND_OTHER = `cand_${"3".repeat(64)}`;

/** Компонент **без единой публикации** — ровно тот случай, который до волны был невыразим. */
const seedUnpublished = (db: Database, input: { id: string; name: string; designSystem?: string }): void => {
  const designSystem = input.designSystem ?? "yandex-pay";
  db.run(`INSERT INTO components (id,name,head_rev,design_system,deleted_at,created_at,updated_at)
    VALUES (?,?,1,?,NULL,'now','now')`, [input.id, input.name, designSystem]);
  db.run("INSERT INTO component_revisions (component_id,rev,source,design_system,message,created_at) VALUES (?,1,'src',?,NULL,'now')",
    [input.id, designSystem]);
};

const seedCandidate = (db: Database, input: {
  candidateId: string; componentId: string; designSystem?: string; rev?: number; expiresAt?: string;
}): void => {
  db.query(`INSERT INTO component_candidates
    (candidate_id,component_id,design_system,rev,source_hash,bundle_hash,host_abi_version,theme_version,build_fingerprint,
     observed_catalog_revision,policy_profile_hash,status,created_by,created_at,expires_at)
    VALUES (?,?,?,?,?,?,4,NULL,'bf','cat','ph','validated','u','2026-08-07T00:00:00.000Z',?)`)
    .run(input.candidateId, input.componentId, input.designSystem ?? "yandex-pay", input.rev ?? 1,
      `src-${input.componentId}`, `bundle-${input.componentId}`,
      input.expiresAt ?? new Date(Date.now() + 3600_000).toISOString());
};

/** Родитель со слотом `items` + два **никогда не публиковавшихся** ребёнка с кандидатами. */
const dbWithOverlayFamily = (): Database => {
  const db = dbWithSlotFamily();
  seedUnpublished(db, { id: "pay-leaf", name: "PayLeaf" });
  seedUnpublished(db, { id: "pay-mid", name: "PayMid" });
  seedCandidate(db, { candidateId: CAND_LEAF, componentId: "pay-leaf" });
  seedCandidate(db, { candidateId: CAND_MID, componentId: "pay-mid" });
  return db;
};

/** AC §5.1: неопубликованный родитель + два неопубликованных ребёнка (вложенный слот) — один набор. */
const overlayManifest = (overrides: Record<string, unknown> = {}): Record<string, unknown> => manifest({
  candidateOverlay: { "pay-leaf": CAND_LEAF, "pay-mid": CAND_MID },
  cases: [{
    id: "graph",
    props: { title: "SMS" },
    slotBindings: {
      items: [{
        overlay: "pay-mid",
        props: { tone: "accent" },
        slotBindings: { items: [{ overlay: "pay-leaf", props: { label: "inner" } }] },
      }],
    },
  }],
  ...overrides,
} as unknown as Partial<CaseSetManifest>);

test("§W3: неопубликованный родитель + два неопубликованных ребёнка живут в одном манифесте", () => {
  const db = dbWithOverlayFamily();
  const { manifest: parsed, warnings } = validateManifest(db, "yp-badge", overlayManifest());
  expect(warnings).toEqual([]);
  // Резолв идёт мимо `publishedPinByNameAndVersion`: та по построению не видит неопубликованное.
  expect(publishedPinByNameAndVersion(db, "PayLeaf", 1, null)).toBeNull();

  const cases = casesOfRun({
    db, componentId: "yp-badge", designSystem: "yandex-pay", candidateEntry: null,
    manifest: parsed, mode: "gating",
  });
  const [item] = cases;
  // Граф — durable-кортежи, отсортированные по componentId.
  expect(item!.candidateOverlay).toEqual([
    { componentId: "pay-leaf", candidateId: CAND_LEAF, rev: 1, sourceHash: "src-pay-leaf", bundleHash: "bundle-pay-leaf" },
    { componentId: "pay-mid", candidateId: CAND_MID, rev: 1, sourceHash: "src-pay-mid", bundleHash: "bundle-pay-mid" },
  ]);
  const outer = item!.slotBindings![0]!;
  // Версии у overlay-узла нет **вовсе** (не сентинел): её место занимает `candidate.candidateId`.
  expect("version" in outer).toBe(false);
  expect(outer.candidate).toEqual({ candidateId: CAND_MID, rev: 1, sourceHash: "src-pay-mid" });
  expect(outer.componentId).toBe("pay-mid");
  expect(outer.name).toBe("PayMid");
  expect(outer.bundleHash).toBe("bundle-pay-mid");
  expect(outer.children![0]!.componentId).toBe("pay-leaf");
  expect(outer.children![0]!.candidate!.candidateId).toBe(CAND_LEAF);
  // `slotsHash` считается по кандидатам, а не по несуществующим версиям.
  expect(item!.slotsHash).toBe(slotsHashOf(item!.slotBindings!));
  db.close();
});

test("§W3: незадействованный узел overlay — 422 candidate_overlay_unused", () => {
  const db = dbWithOverlayFamily();
  fails(() => validateManifest(db, "yp-badge", overlayManifest({
    // `pay-leaf` объявлен, но дерево до него не дотягивается — тихий сдвиг frameFingerprint.
    cases: [{ id: "graph", props: { title: "SMS" }, slotBindings: { items: [{ overlay: "pay-mid" }] } }],
  })), 422, "candidate_overlay_unused");
  // Субъект приёмки — тоже «никогда не задействован»: его голова приезжает кандидатом рана.
  fails(() => validateManifest(db, "yp-badge", overlayManifest({
    candidateOverlay: { "pay-leaf": CAND_LEAF, "pay-mid": CAND_MID, "yp-badge": CAND_OTHER },
  })), 422, "candidate_overlay_unused");
  db.close();
});

test("§W3: остальные декларативные отказы карты overlay", () => {
  const db = dbWithOverlayFamily();
  // Ребёнок ссылается на необъявленный узел.
  fails(() => validateManifest(db, "yp-badge", manifest({
    cases: [{ id: "graph", props: { title: "t" }, slotBindings: { items: [{ overlay: "pay-mid" }] } }],
  } as unknown as Partial<CaseSetManifest>)), 422, "candidate_overlay_unknown");
  // Один кандидат под двумя компонентами: кандидат component-scoped по построению.
  fails(() => validateManifest(db, "yp-badge", overlayManifest({
    candidateOverlay: { "pay-leaf": CAND_LEAF, "pay-mid": CAND_LEAF },
  })), 422, "candidate_overlay_duplicate");
  // Потолок графа.
  const many: Record<string, string> = {};
  for (let index = 0; index < 9; index += 1) many[`node-${index}`] = `cand_${String(index).repeat(64)}`;
  fails(() => validateManifest(db, "yp-badge", overlayManifest({ candidateOverlay: many })), 422, "candidate_overlay_limit");
  // Узел не компонент каталога / чужая дизайн-система.
  fails(() => validateManifest(db, "yp-badge", overlayManifest({
    candidateOverlay: { "pay-leaf": CAND_LEAF, "pay-mid": CAND_MID, ghost: CAND_OTHER },
    cases: [{
      id: "graph", props: { title: "t" },
      slotBindings: { items: [{ overlay: "pay-mid" }, { overlay: "pay-leaf" }, { overlay: "ghost" }] },
    }],
  })), 422, "candidate_overlay_component_not_found");
  seedUnpublished(db, { id: "sh-alien", name: "ShAlien", designSystem: "other-ds" });
  fails(() => validateManifest(db, "yp-badge", overlayManifest({
    candidateOverlay: { "pay-leaf": CAND_LEAF, "pay-mid": CAND_MID, "sh-alien": CAND_OTHER },
    cases: [{
      id: "graph", props: { title: "t" },
      slotBindings: { items: [{ overlay: "pay-mid" }, { overlay: "pay-leaf" }, { overlay: "sh-alien" }] },
    }],
  })), 422, "candidate_overlay_design_system_mismatch");
  // Цикл считается по всему пути — overlay-узел не исключение.
  fails(() => validateManifest(db, "yp-badge", overlayManifest({
    cases: [{
      id: "graph", props: { title: "t" },
      slotBindings: { items: [{ overlay: "pay-mid", slotBindings: { items: [{ overlay: "pay-mid" }, { overlay: "pay-leaf" }] } }] },
    }],
  })), 422, "slot_self_reference");
  db.close();
});

test("§W3: живость кандидата — warning при PUT и 409 на постановке рана", () => {
  const db = dbWithOverlayFamily();
  db.run("DELETE FROM component_candidates WHERE candidate_id=?", [CAND_LEAF]);
  const { manifest: parsed, warnings } = validateManifest(db, "yp-badge", overlayManifest());
  // Манифест контентно адресован и обязан переживать 24-часовой TTL кандидатского кэша.
  expect(warnings.some((line) => line.startsWith("candidate_overlay_unresolved:"))).toBe(true);
  fails(() => casesOfRun({
    db, componentId: "yp-badge", designSystem: "yandex-pay", candidateEntry: null, manifest: parsed, mode: "gating",
  }), 409, "candidate_overlay_evicted");

  seedCandidate(db, { candidateId: CAND_LEAF, componentId: "pay-leaf", expiresAt: "2026-01-01T00:00:00.000Z" });
  fails(() => casesOfRun({
    db, componentId: "yp-badge", designSystem: "yandex-pay", candidateEntry: null, manifest: parsed, mode: "gating",
  }), 409, "candidate_overlay_expired");
  // Реконструкция набора бегущего рана слепа к TTL: вопрос — «чем ран был поставлен».
  expect(casesOfRun({
    db, componentId: "yp-badge", designSystem: "yandex-pay", candidateEntry: null, manifest: parsed, mode: "reconstruction",
  })[0]!.candidateOverlay).toHaveLength(2);
  db.close();
});

test("§W3: kill-switch отказывает манифесту с overlay, не трогая остальные", () => {
  const db = dbWithOverlayFamily();
  process.env.EASYUI_CANDIDATE_OVERLAY_DISABLED = "1";
  try {
    fails(() => validateManifest(db, "yp-badge", overlayManifest()), 422, "candidate_overlay_disabled");
    expect(validateManifest(db, "yp-badge", manifest()).caseSetId).toMatch(/^cset_/);
  } finally {
    delete process.env.EASYUI_CANDIDATE_OVERLAY_DISABLED;
  }
  db.close();
});

test("§W3: overlay-free манифест байт-в-байт прежний — cset_ и frameFingerprint не двигаются", () => {
  const db = dbWithOverlayFamily();
  // Контентный адрес: поле `.optional()` без `.default()` не появляется в `parsed.data`.
  expect(validateManifest(db, "yp-badge", manifest()).caseSetId)
    .toBe("cset_" + Bun.CryptoHasher.hash("sha256", canonicalStringify({
      manifestVersion: 1,
      componentId: "yp-badge",
      capture: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, theme: "light" },
      cases: [{ id: "default", props: { tone: "neutral" } }, { id: "accent", props: { tone: "accent" } }],
    }), "hex"));

  // Кадровый слой: пустой/отсутствующий overlay нормализуется в «поля нет».
  const base = {
    candidateId: `cand_${"0".repeat(64)}`, caseKey: "alpha", propsHash: "props-1",
    surface: { viewport: { width: 390, height: 844 }, dsf: 2, theme: "light" },
    readinessPolicyHash: DEFAULT_READINESS_POLICY_HASH, rendererFingerprint: DEFAULT_RENDERER_FINGERPRINT,
  };
  expect(frameFingerprint({ ...base, candidateOverlay: [] })).toBe(frameFingerprint(base));
  expect(frameFingerprint({
    ...base,
    candidateOverlay: [{ componentId: "pay-leaf", candidateId: CAND_LEAF, rev: 1, sourceHash: "s", bundleHash: "b" }],
  })).not.toBe(frameFingerprint(base));
  db.close();
});

test("§W3: каталог неизменен — overlay не создаёт ни публикации, ни ревизии", () => {
  const db = dbWithOverlayFamily();
  const snapshot = () => JSON.stringify([
    db.query("SELECT component_id,version,status FROM component_publishes ORDER BY component_id,version").all(),
    db.query("SELECT component_id,rev FROM component_revisions ORDER BY component_id,rev").all(),
  ]);
  const before = snapshot();
  const { manifest: parsed } = validateManifest(db, "yp-badge", overlayManifest());
  casesOfRun({ db, componentId: "yp-badge", designSystem: "yandex-pay", candidateEntry: null, manifest: parsed, mode: "gating" });
  expect(snapshot()).toBe(before);
  db.close();
});

// ------------------------------------- BR-02/BR-03: поле краски по сторонам и hint предзагрузки

const paddingCase = (extra: Record<string, unknown>, capture?: Record<string, unknown>): Record<string, unknown> =>
  manifest({
    ...(capture === undefined ? {} : { capture }),
    cases: [{ id: "default", props: { tone: "neutral" }, ...extra }],
  } as unknown as Partial<CaseSetManifest>);

test("BR-02: paintPaddingPx и preloadAssets протягиваются как объявлены и двигают адрес набора", () => {
  const db = dbWithAsset();
  const padding = { top: 64, right: 128, bottom: 64, left: 0 };
  const declared = validateManifest(db, "yp-badge", paddingCase({ paintPaddingPx: padding, preloadAssets: [ASSET] }));
  // Контентный адрес: новое поле — новый набор, старые наборы не перевыпускаются (`.optional()`
  // без `.default()`).
  expect(declared.caseSetId).not.toBe(validateManifest(db, "yp-badge", paddingCase({})).caseSetId);
  const built = buildCasesFromManifest(declared.manifest)[0]!;
  expect(built.paintPaddingPx).toEqual(padding);
  expect(built.preloadAssets).toEqual([ASSET]);
  // Случай без декларации не получает ни дефолта, ни ключа: инвариант отсутствия.
  expect(buildCasesFromManifest(validateManifest(db, "yp-badge", paddingCase({})).manifest)[0]!.paintPaddingPx).toBeUndefined();
  db.close();
});

test("BR-02: неполный объект сторон и значение за потолком — отказ схемы", () => {
  const db = dbWithAsset();
  // Все четыре стороны обязательны: «забытая сторона = 0» — это опечатка с пиксельными
  // последствиями, а не декларация.
  fails(() => validateManifest(db, "yp-badge", paddingCase({ paintPaddingPx: { top: 64, right: 64, bottom: 64 } })),
    422, "validation_failed");
  fails(() => validateManifest(db, "yp-badge", paddingCase({ paintPaddingPx: { top: 64, right: 257, bottom: 64, left: 64 } })),
    422, "validation_failed");
  fails(() => validateManifest(db, "yp-badge", paddingCase({ paintPaddingPx: { top: 64, right: 64.5, bottom: 64, left: 64 } })),
    422, "validation_failed");
  db.close();
});

test("BR-02: бюджет площади кадра — 422 capture_budget_exceeded, а не падение рендерера", () => {
  const db = dbWithAsset();
  // (1000 + 2×256)² × 3² = 20.6 Мпикс при бюджете 20: поле по кругу стоит ×9 после dsf, и до
  // волны эта арифметика не проверялась нигде — кадр падал уже внутри рендерера.
  fails(() => validateManifest(db, "yp-badge", paddingCase(
    { paintPaddingPx: { top: 256, right: 256, bottom: 256, left: 256 } },
    { viewport: { width: 1000, height: 1000 }, deviceScaleFactor: 3, theme: "light" },
  )), 422, "capture_budget_exceeded");
  // Тот же вьюпорт и то же поле при dsf 1 — 2.3 Мпикс, в бюджете.
  expect(validateManifest(db, "yp-badge", paddingCase(
    { paintPaddingPx: { top: 256, right: 256, bottom: 256, left: 256 } },
    { viewport: { width: 1000, height: 1000 }, deviceScaleFactor: 1, theme: "light" },
  )).caseSetId).toMatch(/^cset_[0-9a-f]{64}$/);
  db.close();
});

test("BR-02 kill-switch: манифест с paintPaddingPx отвергается 422 capture_padding_disabled", () => {
  const db = dbWithAsset();
  process.env.EASYUI_CAPTURE_V4_DISABLED = "1";
  try {
    fails(() => validateManifest(db, "yp-badge", paddingCase({ paintPaddingPx: { top: 64, right: 64, bottom: 64, left: 64 } })),
      422, "capture_padding_disabled");
    // Принять и молча проигнорировать поле нельзя: набор контентно адресован, и кадр под тем же
    // `cset_` оказался бы снят не тем полем, которое объявлено.
    expect(validateManifest(db, "yp-badge", paddingCase({})).caseSetId).toMatch(/^cset_/);
  } finally { delete process.env.EASYUI_CAPTURE_V4_DISABLED; }
  db.close();
});
