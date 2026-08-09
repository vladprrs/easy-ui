import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import pngjs from "pngjs";
import { migrate } from "../../migrations";
import { putArtifact } from "../evidence";
import { ACCEPTANCE_POLICIES } from "../policies";
import { spawnNormalizedDiffWorker } from "../../visual/diff-runner";
import type { CandidateSubject, GateContext } from "./types";
import type { ReferenceSurface } from "../../../src/acceptance/caseSetSchema";
import type { ExpectedSurfaces, GeometrySurface } from "../../../src/acceptance/surfaces";
import { geometryFactsKey, paintShaKey, type GeometryFacts } from "./geometry2";
import { referenceCanvasOf, visualGate } from "./visual";

/**
 * **V0-D2 (план 2026-08-08 §4, EUI-BR-04) — трассировка «content-hug < 24 px».**
 *
 * Тесты здесь **не** описывают желаемое поведение: они фиксируют ФАКТИЧЕСКОЕ, чтобы развилка (a)
 * «клэмп у нас» / (b) «не воспроизводится» решалась числами, а не пересказом симптома. Всё, что
 * помечено `// RED (BR-04): фикс в V2`, — поведение, которое волна V2 обязана изменить осознанно.
 *
 * Единицы: `expectedGeometry`/`expectedSurfaces`/`paintMargin` — CSS px; канва, `padTo`,
 * `placement`, `refDims`/`candDims` — device px (× `dsf`). Эталон сервером **не** масштабируется.
 */

const { PNG } = pngjs;
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const INK: [number, number, number, number] = [0x20, 0x40, 0xc0, 0xff];

function framePng(
  width: number, height: number,
  rect: { x: number; y: number; width: number; height: number } | null,
): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(0);
  if (rect) {
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        const offset = (y * width + x) * 4;
        png.data[offset] = INK[0]; png.data[offset + 1] = INK[1];
        png.data[offset + 2] = INK[2]; png.data[offset + 3] = INK[3];
      }
    }
  }
  return PNG.sync.write(png);
}

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

/* ------------------------------------------------------------------ фикстуры 16 px кейса */

/**
 * Кандидатский кадр 16 px content-hug компонента при `dsf: 2`.
 *
 * Арифметика съёмки (`server/screenshot/service.ts:194,950` + `CaptureComponent`):
 * `(root 16 + 2 × paintMargin 64) CSS px × dsf 2 = 288 device px`, компонент — `16 × 2 = 32`
 * device px в точке `(64 × 2, 64 × 2) = (128, 128)`.
 */
const CANDIDATE_288 = framePng(288, 288, { x: 128, y: 128, width: 32, height: 32 });
/** «Голый» экспорт узла 1×: ровно 16×16 device px — то, что отдаёт Figma без @2x. */
const REFERENCE_16 = framePng(16, 16, { x: 0, y: 0, width: 16, height: 16 });
/** Тот же экспорт @2x: 32×32 device px — единственный масштаб, который сервер умеет сводить. */
const REFERENCE_32 = framePng(32, 32, { x: 0, y: 0, width: 32, height: 32 });

interface ContextOptions {
  policyId?: keyof typeof ACCEPTANCE_POLICIES;
  candidate?: Buffer | null;
  dsf?: number;
  referenceSurface?: ReferenceSurface;
  expectedGeometry?: { width: number; height: number };
  expectedSurfaces?: ExpectedSurfaces;
  comparisonSurface?: GeometrySurface;
  geometryFacts?: GeometryFacts;
  casePolicy?: { maxRawDiffPct?: number };
}

async function context(options: ContextOptions = {}) {
  const dir = await mkdtemp(resolve(process.cwd(), ".hug-canvas-test-"));
  dirs.push(dir);
  const db = new Database(":memory:");
  migrate(db);
  const shared = new Map<string, unknown>();
  if (options.geometryFacts) shared.set(geometryFactsKey("alpha"), options.geometryFacts);
  const candidate = options.candidate === undefined ? CANDIDATE_288 : options.candidate;
  if (candidate) {
    const stored = await putArtifact(dir, new Uint8Array(candidate));
    shared.set(paintShaKey("alpha"), stored.sha256);
  }
  const ctx: GateContext = {
    db,
    dataDir: dir,
    service: null as unknown as GateContext["service"],
    policy: ACCEPTANCE_POLICIES[options.policyId ?? "pixel-strict-v1"],
    runId: "acc_00000000-0000-4000-8000-000000000000",
    candidate: { componentId: "hug-probe", rev: 1, sourceHash: "src" } as unknown as CandidateSubject,
    case: {
      caseId: "alpha", caseKey: "alpha", props: {}, propsHash: "ph", aliasOfCaseId: null,
      ...(options.referenceSurface ? { referenceSurface: options.referenceSurface } : {}),
      ...(options.expectedGeometry ? { expectedGeometry: options.expectedGeometry } : {}),
      ...(options.expectedSurfaces ? { expectedSurfaces: options.expectedSurfaces } : {}),
      ...(options.comparisonSurface ? { comparisonSurface: options.comparisonSurface } : {}),
      ...(options.casePolicy ? { casePolicy: options.casePolicy } : {}),
    },
    surface: { viewport: { width: 390, height: 844 }, dsf: options.dsf ?? 2, theme: "light" },
    determinismSampled: false,
    shared,
    sleep: () => Promise.resolve(),
    now: () => Date.now(),
    runDiff: spawnNormalizedDiffWorker,
  };
  return { ctx, db, dir };
}

/* --------------------------------------------------- 1. ветка legacy без объявленной поверхности */

test("BR-04 legacy: 16 px hug-экспорт против paint-кадра — indeterminate по дельте размеров, а не по «минимуму 24»", async () => {
  // Ни `referenceSurface`, ни `comparisonSurface` — `needsReferenceCanvas` false ⇒ `padTo: null`
  // (visual.ts:198-203, 328). Воркер сравнивает 16×16 с 288×288.
  const { ctx, db, dir } = await context();
  ctx.case.referenceAssetId = await putAsset(db, dir, REFERENCE_16);

  const result = await visualGate.run(ctx);
  expect(result.status).toBe("indeterminate");
  expect(result.metrics).toMatchObject({
    reason: "dimensions_irreconcilable",
    refDims: { width: 16, height: 16 },
    candDims: { width: 288, height: 288 },
    // 288 − 16 = 272 при допуске 4 (`pixel-strict-v1`): visual-diff-worker.mjs:513-529.
    dimensionDelta: { width: 272, height: 272, tolerancePx: 4 },
  });
  expect(result.metrics!.referenceNormalization).toMatchObject({ padTo: null, placement: null });
  // RED (BR-04): фикс в V2 — снаружи это и читается как «канву нормализовали не туда»; на деле
  // канвы не строили вовсе, потому что случай её не запросил.
  db.close();
});

/* ------------------------------------- 2. откуда берётся число 24 у 16 px корня: 16 + допуск 8 */

test("BR-04: «внутренний минимум 24 px» = 16 + maxDimensionDeltaPx(8) — допуск сводимости, а не клэмп канвы", async () => {
  // Тот же 16 px компонент, снятый без поля (dsf 1). Профиль `default-v1`: допуск 8 px.
  // 16 + 8 = 24 — верхняя граница «сводимых» размеров; канва диффа = max(ref, cand) = 24×24
  // (visual-diff-worker.mjs:527-528). Ровно это потребитель и видит как «нормализовали до 24».
  const within = await context({
    policyId: "default-v1", dsf: 1, candidate: framePng(24, 24, { x: 0, y: 0, width: 16, height: 16 }),
    casePolicy: { maxRawDiffPct: 90 },
  });
  within.ctx.case.referenceAssetId = await putAsset(within.db, within.dir, REFERENCE_16);
  const reconciled = await visualGate.run(within.ctx);
  expect(reconciled.metrics!.reason).toBeUndefined();
  expect(reconciled.metrics).toMatchObject({
    refDims: { width: 16, height: 16 }, candDims: { width: 24, height: 24 },
    canvas: { width: 24, height: 24 },
    padded: { reference: true, candidate: false },
  });
  // RED (BR-04): фикс в V2 — 16 px эталон молча дополнен нулями до 24×24 и осуждён на этой канве;
  // относительный допуск здесь 8/16 = 50 %.
  within.db.close();

  // На 1 px дальше — обрыв: тот же кейс становится indeterminate. Никакого «минимума 24» в коде
  // нет, есть окно [root − 8 … root + 8].
  const beyond = await context({
    policyId: "default-v1", dsf: 1, candidate: framePng(25, 25, { x: 0, y: 0, width: 16, height: 16 }),
    casePolicy: { maxRawDiffPct: 90 },
  });
  beyond.ctx.case.referenceAssetId = await putAsset(beyond.db, beyond.dir, REFERENCE_16);
  const broken = await visualGate.run(beyond.ctx);
  expect(broken.status).toBe("indeterminate");
  expect(broken.metrics).toMatchObject({ reason: "dimensions_irreconcilable", dimensionDelta: { width: 9, height: 9, tolerancePx: 8 } });
  beyond.db.close();
});

/* ---------------------------------------------- 3. ветка content-hug: канва строится точно, без клэмпа */

test("BR-04 content-hug: канва 16 px корня — ровно (16 + 2×64) × 2 = 288, без минимума и без округления вверх", async () => {
  const { ctx, db } = await context({ candidate: null, dsf: 2, referenceSurface: "content-hug", expectedGeometry: { width: 16, height: 16 } });
  // visual.ts:227-237 — padTo = round((16 + 2×64) × 2) = 288; placement = round(64 × 2) = 128.
  expect(referenceCanvasOf(ctx)).toMatchObject({
    padTo: { width: 288, height: 288 }, placement: { x: 128, y: 128 },
    marginPx: 64, deviceScaleFactor: 2,
    layoutRoot: { width: 16, height: 16 }, layoutRootSource: "expectedGeometry",
  });
  db.close();

  // Тот же корень при фактическом маргине съёмки 8 CSS px: (16 + 16) × 2 = 64. Клэмпа нет и здесь.
  const tight = await context({
    candidate: null, dsf: 2, referenceSurface: "content-hug",
    geometryFacts: { layoutBounds: { x: 8, y: 8, width: 16, height: 16 }, paintMargin: 8, deviceScaleFactor: 2 },
  });
  expect(referenceCanvasOf(tight.ctx)).toMatchObject({
    padTo: { width: 64, height: 64 }, placement: { x: 16, y: 16 }, marginPx: 8, layoutRootSource: "layoutBounds",
  });
  tight.db.close();

  // Экстремум: 1 CSS px корень при dsf 1 и margin 0 — канва 1×1. Нижней границы у канвы нет вовсе.
  const atom = await context({
    candidate: null, dsf: 1, referenceSurface: "content-hug",
    geometryFacts: { layoutBounds: { x: 0, y: 0, width: 1, height: 1 }, paintMargin: 0, deviceScaleFactor: 1 },
  });
  expect(referenceCanvasOf(atom.ctx)).toMatchObject({ padTo: { width: 1, height: 1 }, placement: { x: 0, y: 0 } });
  atom.db.close();
});

test("BR-04 content-hug: @2x-эталон 32×32 сводится с кадром 288×288 и даёт чистый pass", async () => {
  const { ctx, db, dir } = await context({ dsf: 2, referenceSurface: "content-hug", expectedGeometry: { width: 16, height: 16 } });
  ctx.case.referenceAssetId = await putAsset(db, dir, REFERENCE_32);

  const result = await visualGate.run(ctx);
  expect(result.status).toBe("pass");
  expect(result.metrics).toMatchObject({
    rawDiffPct: 0,
    sourceDims: { width: 32, height: 32 },
    refDims: { width: 288, height: 288 },
    candDims: { width: 288, height: 288 },
    canvas: { width: 288, height: 288 },
  });
  expect(result.metrics!.referenceNormalization).toMatchObject({
    referenceSurface: "content-hug", cropApplied: false,
    croppedDims: { width: 32, height: 32 }, padTo: { width: 288, height: 288 }, placement: { x: 128, y: 128 },
    marginPx: 64, deviceScaleFactor: 2, layoutRoot: { width: 16, height: 16 },
  });
  db.close();
});

test("BR-04 content-hug: 1×-эталон 16×16 при dsf 2 сводится по размерам и вообще НЕ проваливается — вдвое меньший эталон проходит pixel-strict", async () => {
  const { ctx, db, dir } = await context({ dsf: 2, referenceSurface: "content-hug", expectedGeometry: { width: 16, height: 16 } });
  ctx.case.referenceAssetId = await putAsset(db, dir, REFERENCE_16);

  const result = await visualGate.run(ctx);
  // Размеры сведены (канва 288), но эталон занимает 16×16 device px там, где кандидат рисует 32×32:
  // сервер нигде не приводит эталон к `deviceScaleFactor`.
  expect(result.metrics!.reason).toBeUndefined();
  expect(result.metrics).toMatchObject({ refDims: { width: 288, height: 288 }, canvas: { width: 288, height: 288 } });
  expect(result.metrics!.totalPixels).toBe(288 * 288);
  // RED (BR-04): фикс в V2 — расхождение «эталон вдвое меньше компонента» весит 0.469 % канвы,
  // потому что 82944 её пикселей — это поле 64 CSS px вокруг 16 px корня. Бюджет 0.5 % профиля
  // `pixel-strict-v1` такой случай пропускает.
  expect(result.metrics!.rawDiffPct).toBe(0.469);
  expect(result.status).toBe("pass");
  db.close();
});

test("BR-04 разведение процента: у 16 px корня ВЕСЬ компонент — 1.23 % канвы, поэтому полностью неверный кадр проходит default-v1", async () => {
  // Кандидат тот же 288×288, эталон — @2x-экспорт, целиком перекрашенный: каждый пиксель
  // компонента отличается. Максимально возможный `rawDiffPct` этого кейса — доля площади
  // компонента в канве: (16×2)² / (16 + 2×64)² × 100 = 1024 / 82944 × 100 = 1.2346 %.
  const inverted = (() => {
    const png = new PNG({ width: 32, height: 32 });
    for (let index = 0; index < 32 * 32; index += 1) {
      const offset = index * 4;
      png.data[offset] = 0xff; png.data[offset + 1] = 0x00; png.data[offset + 2] = 0x00; png.data[offset + 3] = 0xff;
    }
    return PNG.sync.write(png);
  })();
  const { ctx, db, dir } = await context({
    policyId: "default-v1", dsf: 2, referenceSurface: "content-hug", expectedGeometry: { width: 16, height: 16 },
  });
  ctx.case.referenceAssetId = await putAsset(db, dir, inverted);

  const result = await visualGate.run(ctx);
  expect(result.metrics!.rawDiffPixels).toBe(1024);
  expect(result.metrics!.totalPixels).toBe(82944);
  expect(result.metrics!.rawDiffPct).toBe(1.2346);
  // RED (BR-04): фикс в V2 — бюджет 2 % профиля `default-v1` для 16 px content-hug кейса
  // недостижим сверху: гейт физически не может выдать `fail`, каким бы ни был компонент.
  expect(result.status).toBe("pass");
  expect(result.metrics!.maxChannelDelta).toBe(223);
  db.close();
});

/* ------------------------------------- 4. ветка surfaces v3 (объявленная поверхность сравнения) */

test("BR-04 surfaces v3: comparisonSurface referenceExport 16×16 строит ту же канву 288, без минимума", async () => {
  const { ctx, db, dir } = await context({
    dsf: 2, referenceSurface: "content-hug",
    expectedSurfaces: { referenceExport: { width: 16, height: 16 } }, comparisonSurface: "referenceExport",
  });
  // visual.ts:174-191 — declaredSurfaceCanvasOf: round((16 + 2×64) × 2) = 288, placement 128.
  expect(referenceCanvasOf(ctx)).toMatchObject({
    padTo: { width: 288, height: 288 }, placement: { x: 128, y: 128 },
    marginPx: 64, layoutRoot: { width: 16, height: 16 }, layoutRootSource: "surface:referenceExport",
  });
  ctx.case.referenceAssetId = await putAsset(db, dir, REFERENCE_32);
  const result = await visualGate.run(ctx);
  expect(result.status).toBe("pass");
  expect(result.metrics).toMatchObject({ rawDiffPct: 0, refDims: { width: 288, height: 288 } });
  expect(result.metrics!.referenceNormalization).toMatchObject({ layoutRootSource: "surface:referenceExport" });
  db.close();
});

test("BR-04 surfaces v3: comparisonSurface root 16×16 — арифметика та же, ветка одна", async () => {
  const { ctx, db, dir } = await context({
    dsf: 2, expectedSurfaces: { root: { width: 16, height: 16 } }, comparisonSurface: "root",
  });
  expect(referenceCanvasOf(ctx)).toMatchObject({
    padTo: { width: 288, height: 288 }, placement: { x: 128, y: 128 }, layoutRootSource: "surface:root",
  });
  ctx.case.referenceAssetId = await putAsset(db, dir, REFERENCE_32);
  const result = await visualGate.run(ctx);
  expect(result.status).toBe("pass");
  expect(result.metrics).toMatchObject({ rawDiffPct: 0 });
  db.close();
});

test("BR-04 surfaces v3: объявленная поверхность без габаритов ⇒ reference_canvas_unresolved (канва не додумывается)", async () => {
  // `comparisonSurface` объявлен, `expectedSurfaces[surface]` — нет (на PUT это ловит
  // `case_comparison_surface_undeclared`, но гейт обязан быть честным и в обход).
  const { ctx, db, dir } = await context({ dsf: 2, comparisonSurface: "referenceExport" });
  expect(referenceCanvasOf(ctx)).toBeNull();
  ctx.case.referenceAssetId = await putAsset(db, dir, REFERENCE_32);
  const result = await visualGate.run(ctx);
  expect(result.status).toBe("indeterminate");
  expect(result.metrics).toMatchObject({ reason: "reference_canvas_unresolved" });
  db.close();
});

/* ------------------------------------------------------------ 5. итог трассировки в одном месте */

test("BR-04 итог: ни один шаг нормализации не имеет нижней границы канвы — «минимум 24 px» в коде отсутствует", async () => {
  // Полная цепочка для 16 px корня, dsf 2, margin 64:
  //   referenceCanvasOf → padTo 288×288 @ (128,128)   [visual.ts:227-237 / 180-190]
  //   cropRect          → null                        [visual.ts:132-137]
  //   placePng          → refDims 288×288             [visual-diff-worker.mjs:505-512]
  //   normalizeAndCompare → canvas max(288,288)=288   [visual-diff-worker.mjs:527-528]
  const traced: Array<{ root: number; dsf: number; margin: number; padTo: number }> = [];
  for (const [root, dsf, margin] of [[16, 2, 64], [16, 1, 64], [16, 2, 8], [8, 2, 0], [1, 1, 0]] as const) {
    const { ctx, db } = await context({
      candidate: null, dsf, referenceSurface: "content-hug",
      geometryFacts: { layoutBounds: { x: margin, y: margin, width: root, height: root }, paintMargin: margin, deviceScaleFactor: dsf },
    });
    traced.push({ root, dsf, margin, padTo: referenceCanvasOf(ctx)!.padTo.width });
    db.close();
  }
  expect(traced).toEqual([
    { root: 16, dsf: 2, margin: 64, padTo: 288 },
    { root: 16, dsf: 1, margin: 64, padTo: 144 },
    { root: 16, dsf: 2, margin: 8, padTo: 64 },
    { root: 8, dsf: 2, margin: 0, padTo: 16 },
    { root: 1, dsf: 1, margin: 0, padTo: 1 },
  ]);
});
