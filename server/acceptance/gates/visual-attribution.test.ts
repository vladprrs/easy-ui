import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import pngjs from "pngjs";
import { migrate } from "../../migrations";
import { putArtifact, readArtifact } from "../evidence";
import { ACCEPTANCE_POLICIES } from "../policies";
import { rendererReport } from "../../capture/renderer";
import type { NormalizedDiffJob, NormalizedDiffMeasured, NormalizedDiffMetrics } from "../../visual/diff-runner";
import type { CaseElementMap } from "../../visual/attribution";
import type { CandidateSubject, GateContext } from "./types";
import { elementMapKey, paintShaKey } from "./geometry2";
import { visualGate } from "./visual";

/**
 * Гейт `visual` под волной снятия блокеров: атрибуция (BR-07), профили политики рендерера (BR-07)
 * и два вердикта по владению (BR-08).
 *
 * Метрики диффа здесь **подставляются** швом `ctx.runDiff`: предмет теста — решения гейта
 * (кластеры, исключения, субъектный вердикт), а не арифметика воркера (её держит
 * `server/visual/attribution.test.ts` на настоящих пикселях).
 */

const { PNG } = pngjs;
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  delete process.env.EASYUI_VISUAL_ATTRIBUTION_V2_DISABLED;
  delete process.env.EASYUI_COMPARISON_OWNERSHIP_DISABLED;
  delete process.env.EASYUI_RENDERER_POLICY_FINGERPRINT;
  delete process.env.EASYUI_RENDERER_POLICY_PROFILES_DISABLED;
});

const blankPng = (): Buffer => {
  const png = new PNG({ width: 4, height: 4 });
  png.data.fill(0);
  return PNG.sync.write(png);
};

const sha256 = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

async function putAsset(db: Database, dataDir: string, bytes: Buffer): Promise<string> {
  const sha = sha256(new Uint8Array(bytes));
  const id = `asset_${sha}`;
  await mkdir(resolve(dataDir, "assets"), { recursive: true });
  await writeFile(resolve(dataDir, "assets", sha), bytes);
  db.run(
    "INSERT OR IGNORE INTO assets (id,sha256,mime,size,width,height,original_name,created_at) VALUES (?,?,?,?,?,?,?,?)",
    [id, sha, "image/png", bytes.byteLength, null, null, "reference.png", new Date().toISOString()],
  );
  return id;
}

/** Карта элементов случая, какую в бою кладёт гейт `geometry` (`elementMapKey`). */
const ELEMENT_MAP: CaseElementMap = {
  subjectComponentId: "wrapper",
  markers: [
    { markerKey: "c", componentId: "wrapper" },
    { markerKey: "s0", componentId: "child-a", slot: "items", index: 0, version: 1 },
    { markerKey: "s1", componentId: "child-b", slot: "items", index: 1, version: 1 },
  ],
  nodes: [
    { path: "div.wrap", bbox: { x: 0, y: 0, width: 40, height: 20 }, hasText: false, markerKey: "c", depth: 1, componentId: "wrapper", ownership: "subject" },
    { path: "div.wrap>span.a", bbox: { x: 2, y: 2, width: 10, height: 8 }, hasText: true, markerKey: "s0", depth: 3, componentId: "child-a", ownership: "dependency" },
    { path: "div.wrap>span.b", bbox: { x: 20, y: 2, width: 10, height: 8 }, hasText: true, markerKey: "s1", depth: 3, componentId: "child-b", ownership: "dependency" },
  ],
  truncated: false,
  total: 3,
};

interface MetricsOverride {
  rawDiffPct?: number;
  attribution?: NormalizedDiffMetrics["attribution"];
  edgeInside?: number;
}

/** Метрики воркера: минимальный честный набор + атрибуция волны. */
function metricsOf(over: MetricsOverride = {}): NormalizedDiffMetrics {
  return {
    rawDiffPct: over.rawDiffPct ?? 4,
    aaDiffPct: over.rawDiffPct ?? 4,
    rawDiffPixels: 400, aaDiffPixels: 400, totalPixels: 10_000,
    maxChannelDelta: 90,
    channelStats: { pixels: 400, meanDelta: { r: 4, g: 4, b: 4, a: 0 }, meanMaxDelta: 12, stdMaxDelta: 40, alphaDominantPct: 0, semiTransparentPct: 0 },
    regions: [{ bbox: { x: 4, y: 4, width: 20, height: 16 }, areaPct: 4, meanDelta: 12 }],
    totalRegions: 1,
    bestOffset: { dx: 0, dy: 0, residualPct: 4, sampledPixels: 100, step: 1 },
    thresholds: { raw: 0.1, aa: 0.25 },
    edgeResidual: { residualPixels: 400, insidePixels: over.edgeInside ?? 400, outsidePixels: 400 - (over.edgeInside ?? 400), insidePct: 100, edgePixels: 500, edgeCoveragePct: 5, sobelThreshold: 24, dilationPx: 1 },
    ...(over.attribution === undefined ? {} : { attribution: over.attribution }),
  };
}

const attributionOf = (
  regions: NonNullable<NormalizedDiffMetrics["attribution"]>["regions"],
  over: Partial<NonNullable<NormalizedDiffMetrics["attribution"]>> = {},
): NonNullable<NormalizedDiffMetrics["attribution"]> => ({
  owners: [{ elementKey: "s0//div.wrap>span.a", markerKey: "s0", componentId: "child-a", depth: 3, mismatchedPixels: 400 }],
  attributedPixels: 400, unknownPixels: 0, totalMismatchedPixels: 400, coveragePct: 100,
  dependencyPixels: 400,
  dependencyByMarker: [{ markerKey: "s0", componentId: "child-a", pixels: 400 }],
  regions,
  ...over,
});

const regionFact = (over: Partial<NonNullable<NormalizedDiffMetrics["attribution"]>["regions"][number]> = {}):
NonNullable<NormalizedDiffMetrics["attribution"]>["regions"][number] => ({
  index: 0, ownerElementKey: "s0//div.wrap>span.a", ownerMarkerKey: "s0", ownerPath: "div.wrap>span.a",
  ownerDepth: 3, ownerHasText: true, ownerComponentId: "child-a",
  mismatchedPixels: 400, unknownPixels: 0, edgeInsidePixels: 400, edgeOutsidePixels: 0,
  alphaDominantPixels: 0, meanMaxDelta: 12, maxChannelDelta: 90, ...over,
});

interface ContextOptions {
  metrics?: NormalizedDiffMetrics;
  comparison?: Record<string, unknown>;
  elementMap?: CaseElementMap | null;
  maxRawDiffPct?: number;
}

async function context(options: ContextOptions = {}) {
  const dir = await mkdtemp(resolve(process.cwd(), ".visual-attr-test-"));
  dirs.push(dir);
  const db = new Database(":memory:");
  migrate(db);
  const shared = new Map<string, unknown>();
  const stored = await putArtifact(dir, new Uint8Array(blankPng()));
  shared.set(paintShaKey("alpha"), stored.sha256);
  if (options.elementMap !== null) shared.set(elementMapKey("alpha"), options.elementMap ?? ELEMENT_MAP);
  const jobs: NormalizedDiffJob[] = [];
  const referenceAssetId = await putAsset(db, dir, blankPng());
  const ctx: GateContext = {
    db, dataDir: dir,
    service: null as unknown as GateContext["service"],
    policy: ACCEPTANCE_POLICIES["pixel-strict-v1"],
    runId: "acc_00000000-0000-4000-8000-000000000000",
    candidate: { componentId: "wrapper", rev: 1, sourceHash: "src" } as unknown as CandidateSubject,
    case: {
      caseId: "alpha", caseKey: "alpha", props: {}, propsHash: "ph", aliasOfCaseId: null, referenceAssetId,
      ...(options.maxRawDiffPct === undefined ? {} : { casePolicy: { maxRawDiffPct: options.maxRawDiffPct } }),
      ...(options.comparison === undefined ? {} : { comparison: options.comparison as never }),
    },
    surface: { viewport: { width: 390, height: 844 }, dsf: 2, theme: "light" },
    determinismSampled: false,
    shared,
    sleep: () => Promise.resolve(),
    now: () => Date.now(),
    runDiff: async (job) => {
      jobs.push(job);
      return {
        ok: true, mode: "normalize", indeterminate: false,
        sourceDims: { width: 4, height: 4 }, refDims: { width: 4, height: 4 }, candDims: { width: 4, height: 4 },
        cropApplied: false, canvas: { width: 100, height: 100 }, padded: { reference: false, candidate: false },
        metrics: options.metrics ?? metricsOf(),
        diffPngBase64: blankPng().toString("base64"),
        normalizedCandidatePngBase64: blankPng().toString("base64"),
      } satisfies NormalizedDiffMeasured;
    },
  };
  return { ctx, db, dir, jobs };
}

test("карта элементов уезжает в воркер в координатах канвы и возвращается кластерами с владельцем", async () => {
  const { ctx, db, jobs, dir } = await context({
    metrics: metricsOf({ attribution: attributionOf([regionFact()]) }),
  });
  const result = await visualGate.run(ctx);

  // Контракт транспорта: узлы переведены `×dsf` (окна у случая нет), владение размечено slot-деревом.
  expect(jobs[0]!.options!.attribution!.nodes).toEqual([
    { key: "c//div.wrap", path: "div.wrap", markerKey: "c", componentId: "wrapper", depth: 1, hasText: false, ownership: "subject", x: 0, y: 0, width: 80, height: 40 },
    { key: "s0//div.wrap>span.a", path: "div.wrap>span.a", markerKey: "s0", componentId: "child-a", depth: 3, hasText: true, ownership: "dependency", x: 4, y: 4, width: 20, height: 16 },
    { key: "s1//div.wrap>span.b", path: "div.wrap>span.b", markerKey: "s1", componentId: "child-b", depth: 3, hasText: true, ownership: "dependency", x: 40, y: 4, width: 20, height: 16 },
  ]);
  // Владение не запрошено: случай его не объявлял.
  expect(jobs[0]!.options!.attribution!.ownership).toBeUndefined();

  const metrics = result.metrics as Record<string, unknown>;
  expect(metrics.attribution).toMatchObject({ attributedPixels: 400, unknownPixels: 0, coveragePct: 100, truncated: false });
  expect(metrics.clusters).toEqual([expect.objectContaining({
    ownerElementKey: "s0//div.wrap>span.a", ownerComponentId: "child-a",
    paintClass: "live-text", structural: false, mismatchedPixels: 400,
  })]);
  // Квитанция сравнения (E1) — в метриках и в артефакте.
  expect(metrics.comparisonReceipt).toMatchObject({
    colorProfile: "srgb", referenceMatte: null, referenceFlattened: false,
    rendererFingerprint: rendererReport().fingerprint, deviceScaleFactor: 2,
  });
  const record = JSON.parse(new TextDecoder().decode(
    (await readArtifact(dir, result.artifacts!.find((item) => item.name === "visual.json")!.sha256))!,
  )) as { comparisonReceipt: Record<string, unknown>; clusters: unknown[] };
  expect(record.comparisonReceipt.colorProfile).toBe("srgb");
  expect(record.clusters).toHaveLength(1);
  db.close();
});

test("kill-switch: карта не уезжает в воркер, метрики и evidence доволновые byte-for-byte", async () => {
  process.env.EASYUI_VISUAL_ATTRIBUTION_V2_DISABLED = "1";
  const { ctx, db, jobs } = await context();
  const result = await visualGate.run(ctx);
  expect(jobs[0]!.options).not.toHaveProperty("attribution");
  expect(result.metrics).not.toHaveProperty("attribution");
  expect(result.metrics).not.toHaveProperty("clusters");
  db.close();
});

test("re-diff без свежей карты элементов: атрибуции нет, а не выдуманная", async () => {
  const { ctx, db, jobs } = await context({ elementMap: null });
  const result = await visualGate.run(ctx);
  expect(jobs[0]!.options).not.toHaveProperty("attribution");
  expect(result.metrics).not.toHaveProperty("clusters");
  db.close();
});

// ------------------------------------------------------- профили политики рендерера

test("объяснённый профилем остаток даёт pass_with_exceptions-заготовку: exceptions[] на прошедшем гейте", async () => {
  process.env.EASYUI_RENDERER_POLICY_FINGERPRINT = rendererReport().fingerprint;
  const { ctx, db } = await context({
    maxRawDiffPct: 0.1,
    metrics: metricsOf({ rawDiffPct: 0.4, attribution: attributionOf([regionFact()]) }),
  });
  const result = await visualGate.run(ctx);
  expect(result.status).toBe("pass");
  expect(result.exceptions).toEqual(["renderer-policy:live-text-aa-v1:s0//div.wrap>span.a:live-text:4%"]);
  expect((result.metrics as Record<string, unknown>).rendererPolicy)
    .toMatchObject({ applied: true, profileId: "live-text-aa-v1" });
  db.close();
});

test("structural-кластер рядом с AA-кластером в одном случае ⇒ fail (§16 фидбэка)", async () => {
  process.env.EASYUI_RENDERER_POLICY_FINGERPRINT = rendererReport().fingerprint;
  const { ctx, db } = await context({
    maxRawDiffPct: 0.1,
    metrics: {
      ...metricsOf({
        rawDiffPct: 0.4,
        attribution: attributionOf([
          regionFact(),
          regionFact({ index: 1, ownerHasText: false, edgeInsidePixels: 10, edgeOutsidePixels: 390, unknownPixels: 20 }),
        ]),
      }),
      regions: [
        { bbox: { x: 4, y: 4, width: 20, height: 16 }, areaPct: 4, meanDelta: 12 },
        { bbox: { x: 40, y: 4, width: 20, height: 16 }, areaPct: 4, meanDelta: 60 },
      ],
      totalRegions: 2,
    },
  });
  const result = await visualGate.run(ctx);
  expect(result.status).toBe("fail");
  expect(result.exceptions).toBeUndefined();
  const clusters = (result.metrics as { clusters: { structural: boolean }[] }).clusters;
  expect(clusters.map((item) => item.structural)).toEqual([false, true]);
  expect((result.metrics as Record<string, unknown>).rendererPolicy)
    .toMatchObject({ applied: false, reason: "structural_cluster" });
  db.close();
});

// ------------------------------------------------------- BR-08: два вердикта

test("обёртка + два dependency-ребёнка: subject pass, integration fail с группировкой по зависимости", async () => {
  const { ctx, db, jobs } = await context({
    comparison: { ownership: "subject-and-integration", subjectComponentId: "wrapper" },
    maxRawDiffPct: 1,
    metrics: metricsOf({
      rawDiffPct: 4,
      attribution: attributionOf([regionFact()], {
        ownership: {
          subjectRawDiffPixels: 0, dependencyRawDiffPixels: 400,
          subjectAaDiffPixels: 0, dependencyAaDiffPixels: 400,
          byDependency: [
            { markerKey: "s0", componentId: "child-a", pixels: 240 },
            { markerKey: "s1", componentId: "child-b", pixels: 160 },
          ],
        },
      }),
    }),
  });
  const result = await visualGate.run(ctx);
  expect(jobs[0]!.options!.attribution!.ownership).toBe(true);
  // Вердикт случая — интеграционный: субъектный ничей провал не отменяет.
  expect(result.status).toBe("fail");
  expect((result.metrics as Record<string, unknown>).ownership).toMatchObject({
    subjectComponentId: "wrapper",
    subject: { rawDiffPct: 0, failed: false },
    integration: { rawDiffPct: 4, failed: true },
    byDependency: [
      { markerKey: "s0", componentId: "child-a", pixels: 240 },
      { markerKey: "s1", componentId: "child-b", pixels: 160 },
    ],
  });
  db.close();
});

test("mismatch в фоне/гэпе родителя — провал субъекта: маска зависимостей его не покрывает", async () => {
  const { ctx, db } = await context({
    comparison: { ownership: "subject-and-integration" },
    maxRawDiffPct: 1,
    metrics: metricsOf({
      rawDiffPct: 4,
      attribution: attributionOf([regionFact({ ownerElementKey: "c//div.wrap", ownerMarkerKey: "c", ownerComponentId: "wrapper" })], {
        dependencyPixels: 0, dependencyByMarker: [],
        ownership: {
          subjectRawDiffPixels: 400, dependencyRawDiffPixels: 0,
          subjectAaDiffPixels: 400, dependencyAaDiffPixels: 0, byDependency: [],
        },
      }),
    }),
  });
  const result = await visualGate.run(ctx);
  expect((result.metrics as Record<string, unknown>).ownership).toMatchObject({
    // Субъектом без явного `subjectComponentId` остаётся компонент рана.
    subjectComponentId: "wrapper",
    subject: { rawDiffPct: 4, failed: true },
    integration: { rawDiffPct: 4, failed: true },
  });
  db.close();
});

test("kill-switch владения: второго вердикта нет, поле остаётся декларацией без эффекта", async () => {
  process.env.EASYUI_COMPARISON_OWNERSHIP_DISABLED = "1";
  const { ctx, db, jobs } = await context({
    comparison: { ownership: "subject-and-integration" },
    metrics: metricsOf({ attribution: attributionOf([regionFact()]) }),
  });
  const result = await visualGate.run(ctx);
  expect(jobs[0]!.options!.attribution!.ownership).toBeUndefined();
  expect(result.metrics).not.toHaveProperty("ownership");
  // Атрибуция при этом жива — оси у тумблеров разные.
  expect(result.metrics).toHaveProperty("clusters");
  db.close();
});

test("advisory-визуал профиль не рассматривает: exceptions[] уронили бы ран, который проходил", async () => {
  process.env.EASYUI_RENDERER_POLICY_FINGERPRINT = rendererReport().fingerprint;
  const { ctx, db } = await context({
    maxRawDiffPct: 0.1,
    metrics: metricsOf({ rawDiffPct: 0.4, attribution: attributionOf([regionFact()]) }),
  });
  // `default-v1`: гейт advisory — его провал ран не роняет, значит и спасать нечего.
  ctx.policy = ACCEPTANCE_POLICIES["default-v1"];
  const result = await visualGate.run(ctx);
  expect(result.status).toBe("fail");
  expect(result.exceptions).toBeUndefined();
  expect(result.metrics).not.toHaveProperty("rendererPolicy");
  db.close();
});
