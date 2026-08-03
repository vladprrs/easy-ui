import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../migrations";
import { ApiError } from "../http";
import type { CaseSetManifest } from "../../src/acceptance/caseSetSchema";
import {
  buildCasesFromManifest, CaseSetRepo, casePolicyHashOf, caseSetIdOf, coverageOf, manifestOfRow,
  surfaceOfManifest, validateManifest,
} from "./caseSets";
import {
  CASE_FINGERPRINT_ALGO_VERSION, CASE_POLICY_HASH_V0,
  DEFAULT_CAPTURE_ENV_FINGERPRINT, DEFAULT_READINESS_POLICY_HASH,
  caseFingerprint, caseFingerprintV0,
} from "./ids";

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
  expect(coverageOf(parsed)).toEqual({ dimensions: {}, expectedTuples: 0, presentTuples: 2, missingTuples: [], duplicates: [] });
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
  // readiness/env вместо заглушек, в W5a — визуальный гейт (тот же случай теперь может получить
  // пиксельный вердикт), поэтому старый результат относится к другой модели случая (план §3 D1).
  // Версия 5 — последняя запланированная: дальше отпечатки стабильны (reuse-KPI меряется на W6).
  expect(CASE_FINGERPRINT_ALGO_VERSION).toBe(5);
  const base = {
    candidateId: `cand_${"0".repeat(64)}`, caseKey: "alpha", propsHash: "props-1",
    surface: { viewport: { width: 390, height: 844 }, dsf: 2, theme: "light" },
    readinessPolicyHash: DEFAULT_READINESS_POLICY_HASH, captureEnvFingerprint: DEFAULT_CAPTURE_ENV_FINGERPRINT,
    casePolicyHash: CASE_POLICY_HASH_V0, referenceAssetId: null,
  };
  expect(caseFingerprint({ ...base, algoVersion: 5 })).not.toBe(caseFingerprint({ ...base, algoVersion: 4 }));
  expect(caseFingerprint({ ...base, algoVersion: 4 })).not.toBe(caseFingerprint({ ...base, algoVersion: 3 }));
  expect(caseFingerprint({ ...base, algoVersion: 3 })).not.toBe(caseFingerprint({ ...base, algoVersion: 2 }));
  expect(caseFingerprint({ ...base, algoVersion: 2 })).not.toBe(caseFingerprint({ ...base, algoVersion: 1 }));
  // Случай case-set'а с собственной политикой и эталоном отличается от одноимённого examples-случая.
  expect(caseFingerprintV0({ ...base, casePolicyHash: "cset-policy" })).not.toBe(caseFingerprintV0(base));
  expect(caseFingerprintV0({ ...base, referenceAssetId: ASSET })).not.toBe(caseFingerprintV0(base));
});
