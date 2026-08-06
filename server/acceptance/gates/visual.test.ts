import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import pngjs from "pngjs";
import { migrate } from "../../migrations";
import { putArtifact, readArtifact } from "../evidence";
import { ACCEPTANCE_POLICIES } from "../policies";
import { spawnNormalizedDiffWorker } from "../../visual/diff-runner";
import type { CandidateSubject, GateContext } from "./types";
import type { CropSourceSurface, ReferenceSurface, TextAaBudget } from "../../../src/acceptance/caseSetSchema";
import { CAUSE_THRESHOLDS } from "../../visual/causes";
import { geometryFactsKey, paintShaKey, type GeometryFacts } from "./geometry2";
import { TEXT_AA_PRESETS, referenceCanvasOf, visualGate, visualSeverityClass } from "./visual";

/**
 * Гейт `visual` (план 2026-08-03 §2 A5, §5 W5a).
 *
 * Предмет — **обязательность и честность вердикта**, а не арифметика diff'а (её держит
 * `server/visual-diff-normalize.test.ts`):
 * - без эталона: `skipped` у необязательного гейта, `indeterminate` у обязательного (D10 —
 *   `skipped` допустим только необязательным);
 * - несводимые размеры: `indeterminate` с названной причиной, а не `fail`;
 * - порог случая: per-case `maxRawDiffPct` манифеста перекрывает профильный.
 */

const { PNG } = pngjs;
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const INK: [number, number, number, number] = [0x20, 0x40, 0xc0, 0xff];

function framePng(
  width: number, height: number,
  rect: { x: number; y: number; width: number; height: number; color: [number, number, number, number] } | null,
): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(0);
  if (rect) {
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        const offset = (y * width + x) * 4;
        png.data[offset] = rect.color[0]; png.data[offset + 1] = rect.color[1];
        png.data[offset + 2] = rect.color[2]; png.data[offset + 3] = rect.color[3];
      }
    }
  }
  return PNG.sync.write(png);
}

const CANDIDATE = framePng(40, 32, { x: 8, y: 6, width: 16, height: 12, color: INK });
/** Тот же кадр с перекрашенным прямоугольником: 15% холста — заведомо выше любого бюджета. */
const RECOLOURED = framePng(40, 32, { x: 8, y: 6, width: 16, height: 12, color: [0xc0, 0x20, 0x20, 0xff] });
/** Кадр другого размера: свести с кандидатом нельзя ни crop'ом, ни pad'ом. */
const OVERSIZED = framePng(200, 160, { x: 20, y: 20, width: 40, height: 40, color: INK });

const sha256 = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** Кладёт байты в asset-store так же, как это делает ingest: строка в `assets` + файл по sha. */
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

interface ContextOptions {
  policyId?: keyof typeof ACCEPTANCE_POLICIES;
  referenceAssetId?: string | null;
  casePolicy?: { maxRawDiffPct?: number };
  cropLineage?: { rect: [number, number, number, number]; sourceSurface?: CropSourceSurface };
  /** Кандидатный кадр в CAS; `null` — гейт вызывается без снятого paint-кадра. */
  candidate?: Buffer | null;
  runDiff?: GateContext["runDiff"];
  /** W5: поверхность эталона и его место в канонической канве. */
  referenceSurface?: ReferenceSurface;
  referencePlacement?: { x: number; y: number };
  expectedGeometry?: { width: number; height: number };
  /** Факты кадра, которые в бою кладёт гейт `geometry` (W5-фолбэк канвы). */
  geometryFacts?: GeometryFacts;
  dsf?: number;
  /** W4: контракт сравнения и именованный пресет бюджета растрового текста. */
  comparison?: { matte?: string };
  textAaBudget?: TextAaBudget;
}

async function context(options: ContextOptions = {}) {
  const dir = await mkdtemp(resolve(process.cwd(), ".visual-gate-test-"));
  dirs.push(dir);
  const db = new Database(":memory:");
  migrate(db);
  const shared = new Map<string, unknown>();
  if (options.geometryFacts) shared.set(geometryFactsKey("alpha"), options.geometryFacts);
  const candidate = options.candidate === undefined ? CANDIDATE : options.candidate;
  if (candidate) {
    const stored = await putArtifact(dir, new Uint8Array(candidate));
    shared.set(paintShaKey("alpha"), stored.sha256);
  }
  const ctx: GateContext = {
    db,
    dataDir: dir,
    service: null as unknown as GateContext["service"],
    policy: ACCEPTANCE_POLICIES[options.policyId ?? "default-v1"],
    runId: "acc_00000000-0000-4000-8000-000000000000",
    candidate: { componentId: "visual-probe", rev: 1, sourceHash: "src" } as unknown as CandidateSubject,
    case: {
      caseId: "alpha", caseKey: "alpha", props: {}, propsHash: "ph", aliasOfCaseId: null,
      ...(options.referenceAssetId === undefined ? {} : { referenceAssetId: options.referenceAssetId }),
      ...(options.casePolicy ? { casePolicy: options.casePolicy } : {}),
      ...(options.cropLineage ? { cropLineage: options.cropLineage } : {}),
      ...(options.referenceSurface ? { referenceSurface: options.referenceSurface } : {}),
      ...(options.referencePlacement ? { referencePlacement: options.referencePlacement } : {}),
      ...(options.expectedGeometry ? { expectedGeometry: options.expectedGeometry } : {}),
      ...(options.comparison ? { comparison: options.comparison } : {}),
      ...(options.textAaBudget ? { textAaBudget: options.textAaBudget } : {}),
    },
    surface: { viewport: { width: 390, height: 844 }, dsf: options.dsf ?? 2, theme: "light" },
    determinismSampled: false,
    shared,
    sleep: () => Promise.resolve(),
    now: () => Date.now(),
    runDiff: options.runDiff ?? spawnNormalizedDiffWorker,
  };
  return { ctx, db, dir };
}

test("случай без эталона: skipped у необязательного гейта и indeterminate у обязательного", async () => {
  const advisory = await context();
  const skipped = await visualGate.run(advisory.ctx);
  expect(skipped.status).toBe("skipped");
  expect(skipped.metrics).toMatchObject({ required: false, reason: "no_reference" });
  advisory.db.close();

  // `pixel-strict-v1` требует визуального вердикта: `skipped` замаскировал бы непроверенный случай.
  const strict = await context({ policyId: "pixel-strict-v1" });
  const indeterminate = await visualGate.run(strict.ctx);
  expect(indeterminate.status).toBe("indeterminate");
  expect(indeterminate.metrics).toMatchObject({ required: true, reason: "no_reference" });
  expect(indeterminate.detail).toContain("referenceAssetId");
  strict.db.close();
});

test("эталон == кандидат: pass, метрики и оба артефакта в CAS", async () => {
  const { ctx, db, dir } = await context({ policyId: "pixel-strict-v1" });
  const referenceAssetId = await putAsset(db, dir, CANDIDATE);
  ctx.case.referenceAssetId = referenceAssetId;

  const result = await visualGate.run(ctx);
  expect(result.status).toBe("pass");
  expect(result.metrics).toMatchObject({
    required: true, maxRawDiffPct: 0.5, rawDiffPct: 0, aaDiffPct: 0, maxChannelDelta: 0,
    referenceAssetId, severityClass: "aa", totalRegions: 0,
  });
  expect(result.metrics!.bestOffset).toMatchObject({ dx: 0, dy: 0, residualPct: 0 });
  expect(result.artifacts?.map((item) => item.name).sort()).toEqual(["diff.png", "normalized-candidate.png", "visual.json"]);
  // Эталон в CAS **не** копируется (A5): в манифест кейса едет его asset-id.
  const record = JSON.parse(new TextDecoder().decode(
    (await readArtifact(dir, result.artifacts!.find((item) => item.name === "visual.json")!.sha256))!,
  )) as { verdict: string; referenceAssetId: string; metrics: { rawDiffPct: number } };
  expect(record).toMatchObject({ verdict: "pass", referenceAssetId });
  expect(record.metrics.rawDiffPct).toBe(0);
  db.close();
});

test("сломанный эталон: fail с метриками, severity-класс из aaDiffPct", async () => {
  const { ctx, db, dir } = await context();
  ctx.case.referenceAssetId = await putAsset(db, dir, RECOLOURED);

  const result = await visualGate.run(ctx);
  expect(result.status).toBe("fail");
  const metrics = result.metrics as { rawDiffPct: number; aaDiffPct: number; maxChannelDelta: number; severityClass: string; regions: unknown[] };
  expect(metrics.rawDiffPct).toBeGreaterThan(2);
  expect(metrics.aaDiffPct).toBeGreaterThan(2);
  expect(metrics.maxChannelDelta).toBeGreaterThan(0);
  // Расхождение не объясняется сглаживанием ⇒ класс `raw` (тяжелее `aa` по рангу D10).
  expect(metrics.severityClass).toBe("raw");
  expect(metrics.regions).toHaveLength(1);
  expect(result.detail).toContain("exceeds the 2%");
  db.close();
});

test("per-case maxRawDiffPct манифеста перекрывает профильный порог", async () => {
  const lenient = await context({ casePolicy: { maxRawDiffPct: 90 } });
  lenient.ctx.case.referenceAssetId = await putAsset(lenient.db, lenient.dir, RECOLOURED);
  const passed = await visualGate.run(lenient.ctx);
  expect(passed.status).toBe("pass");
  expect(passed.metrics).toMatchObject({ maxRawDiffPct: 90 });
  lenient.db.close();

  const strict = await context({ casePolicy: { maxRawDiffPct: 0 } });
  strict.ctx.case.referenceAssetId = await putAsset(strict.db, strict.dir, framePng(40, 32, { x: 8, y: 6, width: 16, height: 13, color: INK }));
  const failed = await visualGate.run(strict.ctx);
  expect(failed.status).toBe("fail");
  expect(failed.metrics).toMatchObject({ maxRawDiffPct: 0 });
  strict.db.close();
});

test("несводимые размеры — indeterminate с причиной, а не fail без метрик", async () => {
  const { ctx, db, dir } = await context({ policyId: "pixel-strict-v1" });
  ctx.case.referenceAssetId = await putAsset(db, dir, OVERSIZED);

  const result = await visualGate.run(ctx);
  expect(result.status).toBe("indeterminate");
  expect(result.metrics).toMatchObject({ reason: "dimensions_irreconcilable" });
  expect(result.metrics).not.toHaveProperty("rawDiffPct");
  expect(result.detail).toContain("could not be reconciled");
  expect(result.artifacts?.map((item) => item.name)).toEqual(["visual.json"]);
  db.close();
});

test("cropLineage.rect приводит эталон-вырезку к кадру случая", async () => {
  const parent = new PNG({ width: 200, height: 160 });
  parent.data.fill(0);
  // Вставляем кандидатный кадр в макет по смещению (20, 10) — это и есть `cropLineage.rect`.
  const inner = PNG.sync.read(CANDIDATE);
  for (let y = 0; y < inner.height; y += 1) {
    const from = y * inner.width * 4;
    inner.data.copy(parent.data, ((10 + y) * 200 + 20) * 4, from, from + inner.width * 4);
  }
  const { ctx, db, dir } = await context({ cropLineage: { rect: [20, 10, 40, 32] } });
  ctx.case.referenceAssetId = await putAsset(db, dir, PNG.sync.write(parent));

  const result = await visualGate.run(ctx);
  expect(result.status).toBe("pass");
  expect(result.metrics).toMatchObject({ cropApplied: true, rawDiffPct: 0, sourceDims: { width: 200, height: 160 } });
  db.close();
});

test("без снятого paint-кадра и при отказе воркера вердикт не выдаётся", async () => {
  const noFrame = await context({ candidate: null });
  noFrame.ctx.case.referenceAssetId = await putAsset(noFrame.db, noFrame.dir, CANDIDATE);
  const missing = await visualGate.run(noFrame.ctx);
  expect(missing.status).toBe("indeterminate");
  expect(missing.metrics).toMatchObject({ reason: "no_candidate_frame" });
  noFrame.db.close();

  const broken = await context({ runDiff: () => Promise.resolve({ ok: false as const, error: "worker died" }) });
  broken.ctx.case.referenceAssetId = await putAsset(broken.db, broken.dir, CANDIDATE);
  const failedWorker = await visualGate.run(broken.ctx);
  expect(failedWorker.status).toBe("indeterminate");
  expect(failedWorker.metrics).toMatchObject({ reason: "diff_worker_error" });
  expect(failedWorker.detail).toContain("worker died");
  broken.db.close();
});

test("severity-класс: расхождение в пределах AA-бюджета — aa, структурное — raw", () => {
  expect(visualSeverityClass({ rawDiffPct: 3, aaDiffPct: 0.2 }, 2)).toBe("aa");
  expect(visualSeverityClass({ rawDiffPct: 3, aaDiffPct: 2.9 }, 2)).toBe("raw");
});

// ------------------------------------------- content-hug reference (W5, фидбэк P1)

/**
 * Ловушка `pay-card-button` из фидбэка целиком.
 *
 * Кандидат — paint-канва `264×160` с компонентом `136×32` в точке `(64, 64)`; эталон — штатный
 * content-hug экспорт Figma-узла `136×32`. До W5 это давало `dimensions_irreconcilable`, автор
 * подсматривал размеры канвы в упавшем ране и паддил PNG вручную.
 */
const HUG_REFERENCE = framePng(136, 32, { x: 0, y: 0, width: 136, height: 32, color: INK });
const PAINT_CANDIDATE = framePng(264, 160, { x: 64, y: 64, width: 136, height: 32, color: INK });

test("W5: content-hug 136×32 сравнивается с paint-канвой 264×160 без ручного паддинга", async () => {
  const { ctx, db, dir } = await context({
    policyId: "pixel-strict-v1", candidate: PAINT_CANDIDATE, dsf: 1,
    referenceSurface: "content-hug", expectedGeometry: { width: 136, height: 32 },
  });
  ctx.case.referenceAssetId = await putAsset(db, dir, HUG_REFERENCE);

  const result = await visualGate.run(ctx);
  expect(result.status).toBe("pass");
  expect(result.metrics).toMatchObject({ rawDiffPct: 0, refDims: { width: 264, height: 160 } });
  // Канва — `expectedGeometry + 2×margin`, место — `margin × dsf`: ровно то, что делает съёмка.
  expect(result.metrics!.referenceNormalization).toMatchObject({
    referenceSurface: "content-hug", cropApplied: false,
    padTo: { width: 264, height: 160 }, placement: { x: 64, y: 64 },
    marginPx: 64, deviceScaleFactor: 1,
    layoutRoot: { width: 136, height: 32 }, layoutRootSource: "expectedGeometry",
    sourceDims: { width: 136, height: 32 },
  });
  // Дериват эталона — в артефактах случая, рядом с иммутабельной ссылкой на исходный ассет.
  expect(result.artifacts?.map((item) => item.name).sort())
    .toEqual(["diff.png", "normalized-candidate.png", "normalized-reference.png", "visual.json"]);
  const record = JSON.parse(new TextDecoder().decode(
    (await readArtifact(dir, result.artifacts!.find((item) => item.name === "visual.json")!.sha256))!,
  )) as { referenceSource: { assetId: string; sha256: string }; normalizedReferenceSha256: string };
  expect(record.referenceSource).toEqual({ assetId: ctx.case.referenceAssetId!, sha256: sha256(new Uint8Array(HUG_REFERENCE)) });
  expect(record.normalizedReferenceSha256).toBe(result.artifacts!.find((item) => item.name === "normalized-reference.png")!.sha256);
  db.close();
});

test("W5: тот же эталон без referenceSurface остаётся несводимым — legacy-поведение не тронуто (D13)", async () => {
  const { ctx, db, dir } = await context({ policyId: "pixel-strict-v1", candidate: PAINT_CANDIDATE, dsf: 1 });
  ctx.case.referenceAssetId = await putAsset(db, dir, HUG_REFERENCE);

  const result = await visualGate.run(ctx);
  expect(result.status).toBe("indeterminate");
  expect(result.metrics).toMatchObject({ reason: "dimensions_irreconcilable" });
  // Паддинга не было вовсе: manifest без новых полей сравнивается ровно как до волны.
  expect(result.metrics!.referenceNormalization).toMatchObject({ referenceSurface: "paint", padTo: null, placement: null });
  db.close();
});

test("W5: crop не применяется дважды — 136×32 не превращается в 116×12", async () => {
  // Эталон уже вырезан агентом; `cropLineage` остался provenance'ом родительского узла.
  const lineage = { rect: [20, 20, 136, 32] as [number, number, number, number] };
  const provenance = await context({
    policyId: "pixel-strict-v1", candidate: PAINT_CANDIDATE, dsf: 1,
    referenceSurface: "content-hug", expectedGeometry: { width: 136, height: 32 },
    cropLineage: { ...lineage, sourceSurface: "content-hug" },
  });
  provenance.ctx.case.referenceAssetId = await putAsset(provenance.db, provenance.dir, HUG_REFERENCE);
  const kept = await visualGate.run(provenance.ctx);
  expect(kept.status).toBe("pass");
  expect(kept.metrics).toMatchObject({ cropApplied: false, rawDiffPct: 0 });
  expect(kept.metrics!.referenceNormalization).toMatchObject({
    sourceSurface: "content-hug", cropApplied: false, croppedDims: { width: 136, height: 32 },
  });
  provenance.db.close();

  // Тот же rect, объявленный как координаты **родительского узла**, режется ровно один раз — и
  // именно поэтому его нельзя применять к уже вырезанному ассету: получилось бы 116×12.
  const doubled = await context({
    policyId: "pixel-strict-v1", candidate: PAINT_CANDIDATE, dsf: 1,
    referenceSurface: "content-hug", expectedGeometry: { width: 136, height: 32 },
    cropLineage: { ...lineage, sourceSurface: "figma-node" },
  });
  doubled.ctx.case.referenceAssetId = await putAsset(doubled.db, doubled.dir, HUG_REFERENCE);
  const cut = await visualGate.run(doubled.ctx);
  expect(cut.metrics!.referenceNormalization).toMatchObject({ cropApplied: true, croppedDims: { width: 116, height: 12 } });
  expect(cut.status).toBe("fail");
  doubled.db.close();
});

test("W5: без expectedGeometry канва берётся из измеренного layoutBounds, а без обоих — indeterminate", async () => {
  const measured = await context({
    policyId: "pixel-strict-v1", candidate: PAINT_CANDIDATE, dsf: 1, referenceSurface: "content-hug",
    geometryFacts: { layoutBounds: { width: 136, height: 32 }, paintMargin: 64, deviceScaleFactor: 1 },
  });
  measured.ctx.case.referenceAssetId = await putAsset(measured.db, measured.dir, HUG_REFERENCE);
  const result = await visualGate.run(measured.ctx);
  expect(result.status).toBe("pass");
  expect(result.metrics!.referenceNormalization).toMatchObject({ layoutRootSource: "layoutBounds", padTo: { width: 264, height: 160 } });
  measured.db.close();

  // Ни объявленного корня, ни измеренного (re-diff без свежей геометрии): сравнивать компонент с
  // канвой, построенной наугад, значило бы выдать вердикт о пустоте.
  const blind = await context({ policyId: "pixel-strict-v1", candidate: PAINT_CANDIDATE, dsf: 1, referenceSurface: "content-hug" });
  blind.ctx.case.referenceAssetId = await putAsset(blind.db, blind.dir, HUG_REFERENCE);
  const unresolved = await visualGate.run(blind.ctx);
  expect(unresolved.status).toBe("indeterminate");
  expect(unresolved.metrics).toMatchObject({ reason: "reference_canvas_unresolved" });
  expect(unresolved.detail).toContain("expectedGeometry");
  blind.db.close();
});

test("W5: канва считается в device px, а placement по умолчанию — margin × dsf", async () => {
  const { ctx, db } = await context({
    candidate: null, dsf: 2, referenceSurface: "content-hug", expectedGeometry: { width: 136, height: 32 },
  });
  expect(referenceCanvasOf(ctx)).toMatchObject({
    padTo: { width: 528, height: 320 }, placement: { x: 128, y: 128 }, deviceScaleFactor: 2,
  });
  // Явный placement перекрывает умолчание — на нём же держится смена comparison-отпечатка (C12).
  ctx.case.referencePlacement = { x: 100, y: 90 };
  expect(referenceCanvasOf(ctx)!.placement).toEqual({ x: 100, y: 90 });
  db.close();
});

// --------------------------------------- matte и пресет live-text (план 2026-08-06 §W4)

/** Эталон «как из Figma»: тот же компонент, но поверх непрозрачного белого. */
const OPAQUE_REFERENCE = (() => {
  const png = new PNG({ width: 40, height: 32 });
  for (let index = 0; index < 40 * 32; index += 1) {
    const offset = index * 4;
    png.data[offset] = 255; png.data[offset + 1] = 255; png.data[offset + 2] = 255; png.data[offset + 3] = 255;
  }
  for (let y = 6; y < 18; y += 1) {
    for (let x = 8; x < 24; x += 1) {
      const offset = (y * 40 + x) * 4;
      png.data[offset] = INK[0]; png.data[offset + 1] = INK[1]; png.data[offset + 2] = INK[2]; png.data[offset + 3] = INK[3];
    }
  }
  return PNG.sync.write(png);
})();

test("§W4: прозрачный кандидат против непрозрачного эталона проходит только с matte", async () => {
  // Без matte вердикт говорит о фоне, которого у кандидата нет вовсе: капчур прозрачный
  // (`omitBackground:true`), эталон — экспорт поверх белого.
  const bare = await context({ policyId: "pixel-strict-v1" });
  bare.ctx.case.referenceAssetId = await putAsset(bare.db, bare.dir, OPAQUE_REFERENCE);
  const failed = await visualGate.run(bare.ctx);
  expect(failed.status).toBe("fail");
  expect(failed.metrics!.rawDiffPct as number).toBeGreaterThan(50);
  expect(failed.metrics).not.toHaveProperty("matteApplied");
  bare.db.close();

  const matted = await context({ policyId: "pixel-strict-v1", comparison: { matte: "#FFFFFF" } });
  matted.ctx.case.referenceAssetId = await putAsset(matted.db, matted.dir, OPAQUE_REFERENCE);
  const passed = await visualGate.run(matted.ctx);
  expect(passed.status).toBe("pass");
  expect(passed.metrics).toMatchObject({ rawDiffPct: 0, matteApplied: "#ffffff" });
  // Матированный эталон уезжает в evidence — иначе «сравнили с чем-то» осталось бы недоказуемым.
  expect(passed.artifacts?.map((item) => item.name).sort())
    .toEqual(["diff.png", "normalized-candidate.png", "normalized-reference.png", "visual.json"]);
  matted.db.close();

  // `matte: "none"` — объявленное «не матировать»: путь ровно доволновой.
  const none = await context({ policyId: "pixel-strict-v1", comparison: { matte: "none" } });
  none.ctx.case.referenceAssetId = await putAsset(none.db, none.dir, OPAQUE_REFERENCE);
  const untouched = await visualGate.run(none.ctx);
  expect(untouched.status).toBe("fail");
  expect(untouched.metrics).not.toHaveProperty("matteApplied");
  none.db.close();
});

/**
 * Пара «живой текст» / «перекрашенный блок» (§W4 T4b).
 *
 * Глиф — маленькая фигура, сдвинутая на 1 px: весь остаток лежит на её собственных контурах.
 * Перекраска — блок **внутри** залитой области, где у эталона нет градиента вовсе, поэтому
 * остаток вне edge-маски. Оба расхождения по проценту почти одинаковы — и различает их только
 * геометрия остатка, ради которой пресет и существует.
 */
const GLYPH_REFERENCE = framePng(100, 100, { x: 10, y: 10, width: 8, height: 8, color: INK });
const GLYPH_SHIFTED = framePng(100, 100, { x: 11, y: 10, width: 8, height: 8, color: INK });
const FILLED_REFERENCE = framePng(100, 100, { x: 10, y: 10, width: 40, height: 40, color: INK });
const FILLED_RECOLOURED = (() => {
  const png = PNG.sync.read(FILLED_REFERENCE);
  for (let y = 25; y < 31; y += 1) {
    for (let x = 25; x < 31; x += 1) {
      const offset = (y * 100 + x) * 4;
      png.data[offset] = 0xc0; png.data[offset + 1] = 0x20; png.data[offset + 2] = 0x20; png.data[offset + 3] = 0xff;
    }
  }
  return PNG.sync.write(png);
})();

test("§W4: пресет live-text-v1 спасает растровый остаток и не спасает перекраску блока", async () => {
  // Бюджет случая заведомо ниже расхождения: оба случая до пресета — `fail`.
  const glyph = await context({ candidate: GLYPH_SHIFTED, casePolicy: { maxRawDiffPct: 0.05 }, textAaBudget: "live-text-v1" });
  glyph.ctx.case.referenceAssetId = await putAsset(glyph.db, glyph.dir, GLYPH_REFERENCE);
  const rescued = await visualGate.run(glyph.ctx);
  expect(rescued.status).toBe("pass");
  expect(rescued.metrics!.rawDiffPct as number).toBeGreaterThan(0.05);
  expect(rescued.metrics!.rawDiffPct as number).toBeLessThanOrEqual(TEXT_AA_PRESETS["live-text-v1"].maxRawDiffPct);
  expect(rescued.metrics!.textAaBudget).toMatchObject({ preset: "live-text-v1", applied: true });
  expect(rescued.detail).toContain("live-text-v1");
  glyph.db.close();

  // Тот же кадр **без** объявленного пресета судится ровно бюджетом: пресет не включается сам.
  const unclaimed = await context({ candidate: GLYPH_SHIFTED, casePolicy: { maxRawDiffPct: 0.05 } });
  unclaimed.ctx.case.referenceAssetId = await putAsset(unclaimed.db, unclaimed.dir, GLYPH_REFERENCE);
  const strict = await visualGate.run(unclaimed.ctx);
  expect(strict.status).toBe("fail");
  expect(strict.metrics).not.toHaveProperty("textAaBudget");
  unclaimed.db.close();

  // Перекраска внутри залитой области: тот же порядок процентов, но остаток лежит вне контуров.
  const recoloured = await context({ candidate: FILLED_RECOLOURED, casePolicy: { maxRawDiffPct: 0.05 }, textAaBudget: "live-text-v1" });
  recoloured.ctx.case.referenceAssetId = await putAsset(recoloured.db, recoloured.dir, FILLED_REFERENCE);
  const rejected = await visualGate.run(recoloured.ctx);
  expect(rejected.status).toBe("fail");
  expect(rejected.metrics!.rawDiffPct as number).toBeLessThanOrEqual(TEXT_AA_PRESETS["live-text-v1"].maxRawDiffPct);
  expect(rejected.metrics!.textAaBudget).toMatchObject({ preset: "live-text-v1", applied: false });
  expect((rejected.metrics!.edgeResidual as { insidePct: number }).insidePct)
    .toBeLessThan(TEXT_AA_PRESETS["live-text-v1"].minEdgeResidualPct);
  recoloured.db.close();
});

test("§W4: порог пресета — та же константа, что у классификатора причин (один источник правды)", () => {
  // Разъехавшись, вердикт и его объяснение противоречили бы друг другу: гейт спасал бы случай как
  // растровый остаток, а таксономия называла бы его регрессией (или наоборот).
  expect(TEXT_AA_PRESETS["live-text-v1"].minEdgeResidualPct).toBe(CAUSE_THRESHOLDS.edgeResidualInsidePct);
  expect(TEXT_AA_PRESETS["live-text-v1"].maxRawDiffPct).toBe(0.75);
});

test("§W4: edge-сигнал приезжает в метрики каждого случая, а вердикт без пресета не меняется", async () => {
  const { ctx, db, dir } = await context({ policyId: "pixel-strict-v1" });
  ctx.case.referenceAssetId = await putAsset(db, dir, CANDIDATE);
  const result = await visualGate.run(ctx);
  expect(result.status).toBe("pass");
  // Кадры совпали побайтно: остатка нет, и доли у пустого множества тоже нет.
  expect(result.metrics!.edgeResidual).toMatchObject({ residualPixels: 0, insidePct: null });
  db.close();
});
