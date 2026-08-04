/**
 * Разделение метрик визуального рана: сигналы + edge-маска
 * (план `docs/plans/2026-08-03-renderer-contract-2.md` §3 **E6**, §5 **R7a**).
 *
 * Предмет — четыре свойства, ради которых волна существует:
 *
 * 1. **растровый остаток отличается от регрессии геометрически, а не по проценту** — сдвиг текста
 *    на 1 px даёт `pass/renderer_residual`, сдвиг плашки на 4 px — `fail/regression` с причиной
 *    `geometry-shift`, смена заливки — `fail/regression` с причиной `surface-tint`;
 * 2. **инвариант**: остаток **вне** edge-маски не даёт `renderer_residual` ни при каком бюджете —
 *    иначе реклассификация прятала бы регрессии (риск §9);
 * 3. **несводимые размеры** дают `indeterminate` без процента (`dimensions_irreconcilable`),
 *    а сводимые нормализацией — судятся как обычно;
 * 4. **opt-in**: при выключенном `EASYUI_VISUAL_SIGNALS_V2` поведение доволновое буквально —
 *    вердикт по проценту pixelmatch, `class`/`signals` в отчёте `null`, и та самая пара кадров,
 *    которую волна признаёт регрессией, по-прежнему проходит.
 *
 * Пары кадров синтетические, но **пороги калиброваны на реальных** (chromium, DPR 1 и 2 — факт
 * R7a в §4 плана): числа синтетики лежат в тех же классах, что измеренные на настоящем растре.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import pngjs from "pngjs";
import { openDatabase } from "./db";
import { prototypeDocSchema } from "../src/prototype/schema";
import { AssetRepo } from "./repos/assets";
import { createTestHandler } from "./test-auth";
import { ScreenshotService, type RunJob } from "./screenshot/service";
import { VisualService, evaluateSignalsVerdict } from "./visual/service";
import { VisualRepo } from "./visual/repo";
import type { RunSignalsDiff, SignalsDiffMeasured } from "./visual/diff-runner";
import { compareWithSignals, edgeMaskOf, edgeResidualOf, exactDiffMaskOf } from "../scripts/visual-diff-worker.mjs";
import { CAUSE_THRESHOLDS } from "./visual/causes";

const { PNG } = pngjs;

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

// ───────────────────────────────────────────────────────────── синтетические кадры

type Rgba = [number, number, number, number];
const WHITE: Rgba = [255, 255, 255, 255];

/** Пустой холст заданного цвета — основа всех пар. */
function canvas(width: number, height: number, fill: Rgba = WHITE): InstanceType<typeof PNG> {
  const png = new PNG({ width, height });
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    png.data[offset] = fill[0]; png.data[offset + 1] = fill[1]; png.data[offset + 2] = fill[2]; png.data[offset + 3] = fill[3];
  }
  return png;
}

function fillRect(png: InstanceType<typeof PNG>, x0: number, y0: number, width: number, height: number, color: Rgba): void {
  for (let y = y0; y < y0 + height; y += 1) {
    for (let x = x0; x < x0 + width; x += 1) {
      if (x < 0 || y < 0 || x >= png.width || y >= png.height) continue;
      const offset = (y * png.width + x) * 4;
      png.data[offset] = color[0]; png.data[offset + 1] = color[1]; png.data[offset + 2] = color[2]; png.data[offset + 3] = color[3];
    }
  }
}

/**
 * «Текст»: ряд вертикальных штрихов с полутоновыми краями (антиалиасинг) — растр, у которого
 * почти вся площадь расхождения при сдвиге на 1 px лежит на собственных контурах.
 */
function textLike(width: number, height: number, shift: number): Buffer {
  const png = canvas(width, height);
  for (let stroke = 0; stroke < 8; stroke += 1) {
    const x = 6 + stroke * 9 + shift;
    fillRect(png, x, 8, 1, 24, [160, 160, 160, 255]);   // край глифа (AA)
    fillRect(png, x + 1, 8, 2, 24, [32, 32, 32, 255]);  // тело глифа
    fillRect(png, x + 3, 8, 1, 24, [160, 160, 160, 255]);
  }
  return PNG.sync.write(png);
}

/** «Плашка»: заливка со скруглением не нужна — предмет проверки в том, куда попал остаток. */
function badge(width: number, height: number, shift: number): Buffer {
  const png = canvas(width, height);
  fillRect(png, 10 + shift, 10, 40, 20, [255, 219, 77, 255]);
  return PNG.sync.write(png);
}

/** Заливка половины холста: та самая пара, которую бюджет pixelmatch не видит (факт калибровки). */
function surface(width: number, height: number, color: Rgba): Buffer {
  const png = canvas(width, height);
  fillRect(png, 0, 0, 50, height, color);
  return PNG.sync.write(png);
}

/** Кадр с контуром в одном месте и расхождением — в другом (инвариант «остаток вне маски»). */
function blobOutsideEdges(width: number, height: number, withBlob: boolean): Buffer {
  const png = canvas(width, height);
  fillRect(png, 4, 4, 20, 20, [20, 20, 20, 255]);
  if (withBlob) fillRect(png, 60, 45, 8, 8, [250, 250, 250, 255]);
  return PNG.sync.write(png);
}

const signalsOf = (reference: Buffer, candidate: Buffer, threshold = 0.1) =>
  compareWithSignals(reference, candidate, { threshold, includeAA: false }) as SignalsDiffMeasured;

// ───────────────────────────────────────────────────────────── edge-маска (воркер)

describe("edge-маска эталона", () => {
  test("маска строится по контурам и расширяется на 1 px — иначе сдвиг на 1 px не покрыт", () => {
    const png = PNG.sync.read(badge(80, 60, 0));
    const plain = edgeMaskOf(png.data, 80, 60, { dilation: 0 });
    const dilated = edgeMaskOf(png.data, 80, 60, {});
    expect(plain.edgePixels).toBeGreaterThan(0);
    expect(dilated.edgePixels).toBeGreaterThan(plain.edgePixels);
    // Контур — тонкая кайма, а не половина холста: иначе «внутри маски» перестало бы что-то значить.
    expect(dilated.edgePixels / (80 * 60)).toBeLessThan(0.2);
  });

  test("однотонный кадр контуров не имеет вовсе", () => {
    const flat = canvas(40, 40, [200, 200, 200, 255]);
    expect(edgeMaskOf(flat.data, 40, 40, {}).edgePixels).toBe(0);
  });

  test("пустой остаток даёт insidePct = null, а не выдуманные 100 %", () => {
    const png = PNG.sync.read(badge(80, 60, 0));
    const mask = exactDiffMaskOf(png.data, png.data, 80 * 60);
    const residual = edgeResidualOf(mask.mask, edgeMaskOf(png.data, 80, 60, {}), 80 * 60, 80 * 60);
    expect(residual.residualPixels).toBe(0);
    expect(residual.insidePct).toBeNull();
  });
});

describe("сигналы пары кадров", () => {
  test("сдвиг текста на 1 px: остаток целиком на контурах эталона", () => {
    const result = signalsOf(textLike(80, 60, 0), textLike(80, 60, 1));
    expect(result.dims).toBe("equal");
    expect(result.exact.diffPixels).toBeGreaterThan(0);
    expect(result.edgeResidual.insidePct).toBeGreaterThanOrEqual(CAUSE_THRESHOLDS.edgeResidualInsidePct);
  });

  test("сдвиг плашки на 4 px: остаток шире контура, доля внутри маски ниже T", () => {
    const result = signalsOf(badge(80, 60, 0), badge(80, 60, 4));
    expect(result.edgeResidual.insidePct).toBeLessThan(CAUSE_THRESHOLDS.edgeResidualInsidePct);
    expect(result.metrics.bestOffset.dx).toBe(4);
  });

  test("смена заливки: pixelmatch молчит, exact-rgba и edge-сигнал — нет", () => {
    const result = signalsOf(surface(80, 60, [242, 241, 240, 255]), surface(80, 60, [232, 240, 255, 255]));
    // Ровно тот случай, ради которого волна и затевалась: перцептивная метрика в нуле…
    expect(result.pixelmatch.diffPixels).toBe(0);
    // …а половина холста перекрашена, и остаток лежит не на контурах.
    expect(result.exact.diffPixels).toBeGreaterThan(0);
    expect(result.edgeResidual.insidePct).toBeLessThan(10);
  });

  test("несводимые размеры: indeterminate без метрик", () => {
    const result = compareWithSignals(badge(80, 60, 0), badge(200, 60, 0), {});
    expect(result.indeterminate).toBe(true);
    expect(result.dims).toBe("irreconcilable");
    expect((result as { metrics?: unknown }).metrics).toBeUndefined();
  });

  test("расхождение габаритов в пределах допуска сводится нормализацией, а не отбрасывается", () => {
    const result = compareWithSignals(badge(80, 60, 0), badge(84, 60, 0), {}) as SignalsDiffMeasured;
    expect(result.indeterminate).toBe(false);
    expect(result.dims).toBe("normalized");
    expect(result.canvas).toEqual({ width: 84, height: 60 });
  });
});

// ───────────────────────────────────────────────────────────── вердикт E6

describe("evaluateSignalsVerdict (E6)", () => {
  test("совпавшие кадры — pass/identical", () => {
    const verdict = evaluateSignalsVerdict(signalsOf(badge(80, 60, 0), badge(80, 60, 0)), 0, 1);
    expect(verdict.status).toBe("pass");
    expect(verdict.runClass).toBe("identical");
  });

  test("сдвиг текста на 1 px в бюджете рана — pass/renderer_residual", () => {
    const verdict = evaluateSignalsVerdict(signalsOf(textLike(80, 60, 0), textLike(80, 60, 1)), 5, 1);
    expect(verdict.status).toBe("pass");
    expect(verdict.runClass).toBe("renderer_residual");
    expect(verdict.signals.edgeResidual?.outsidePixels).toBe(0);
  });

  test("сдвиг плашки на 4 px — fail/regression с причиной geometry-shift", () => {
    const verdict = evaluateSignalsVerdict(signalsOf(badge(80, 60, 0), badge(80, 60, 4)), 5, 1);
    expect(verdict.status).toBe("fail");
    expect(verdict.runClass).toBe("regression");
    expect(verdict.signals.causes?.[0]?.code).toBe("geometry-shift");
  });

  test("изменённая заливка — fail/regression с причиной surface-tint, хотя pixelmatch её не видит", () => {
    const verdict = evaluateSignalsVerdict(
      signalsOf(surface(80, 60, [242, 241, 240, 255]), surface(80, 60, [232, 240, 255, 255])), 5, 1);
    expect(verdict.signals.perceptual?.diffPercent).toBe(0);
    expect(verdict.status).toBe("fail");
    expect(verdict.runClass).toBe("regression");
    expect(verdict.signals.causes?.[0]?.code).toBe("surface-tint");
  });

  test("инвариант: остаток вне edge-маски не даёт renderer_residual ни при каком бюджете", () => {
    const signals = signalsOf(blobOutsideEdges(80, 60, false), blobOutsideEdges(80, 60, true));
    expect(signals.edgeResidual.insidePixels).toBe(0);
    const verdict = evaluateSignalsVerdict(signals, 100, 1);
    expect(verdict.runClass).not.toBe("renderer_residual");
    expect(verdict.status).toBe("fail");
  });

  test("несводимые размеры — indeterminate/dimensions_irreconcilable без процента", () => {
    const diff = compareWithSignals(badge(80, 60, 0), badge(200, 60, 0), {});
    const verdict = evaluateSignalsVerdict(diff, 0, 1);
    expect(verdict.status).toBe("error");
    expect(verdict.runClass).toBe("indeterminate");
    expect(verdict.outcomeCode).toBe("dimensions_irreconcilable");
    expect(verdict.signals.exact).toBeNull();
    expect(verdict.signals.perceptual).toBeNull();
    expect(verdict.signals.reason).toContain("beyond");
  });
});

// ───────────────────────────────────────────────────────────── ран целиком

const inProcessSignalsDiff: RunSignalsDiff = async (job) =>
  compareWithSignals(
    Buffer.from(job.referencePngBase64, "base64"),
    Buffer.from(job.candidatePngBase64, "base64"),
    job.options,
  ) as Awaited<ReturnType<RunSignalsDiff>>;

const candidateRunJob = (png: Buffer): RunJob => async () =>
  ({ ok: true, pngBase64: png.toString("base64"), width: png.readUInt32BE(16), height: png.readUInt32BE(20), consoleErrors: [], pageErrors: [], browserVersion: "test/1" });

async function waitReport(service: VisualService, runId: string) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const view = service.get(runId);
    if (view?.kind === "report") return view.report;
    await Bun.sleep(10);
  }
  throw new Error("run did not finalize");
}

async function withEnv<T>(vars: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { return await body(); }
  finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

/** Ран с эталоном `reference` и кадром кандидата `candidate` (капчур подменён). */
async function prepare(protoId: string, reference: Buffer, candidate: Buffer) {
  const dir = await mkdtemp(resolve(process.cwd(), ".visual-signals-test-"));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  const handler = createTestHandler(db, { dataDir: dir });
  const original = prototypeDocSchema.parse(await Bun.file("test/fixtures/host-content.json").json());
  const created = await handler(new Request("http://test/api/prototypes", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ doc: { ...original, id: protoId, name: protoId } }),
  }));
  expect(created.status).toBe(201);
  const asset = (await new AssetRepo(db, dir).ingest(new Uint8Array(reference), "image/png")).asset;
  const repo = new VisualRepo(db, dir);
  const row = repo.upsertReferencePrivileged(
    { scope: "prototype-screen", prototypeId: protoId, screenId: "welcome", refRevision: 1, viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, theme: "light" },
    asset.id, null, null,
  );
  const screenshots = new ScreenshotService({ db, dataDir: dir, serveDist: "dist", captureOrigin: "http://127.0.0.1:8787", chromiumAvailable: true, runJob: candidateRunJob(candidate) });
  return { referenceId: row.id, service: new VisualService({ db, dataDir: dir, screenshots, runSignalsDiff: inProcessSignalsDiff }) };
}

describe("VisualService под EASYUI_VISUAL_SIGNALS_V2", () => {
  test("сдвиг текста на 1 px в бюджете рана: pass с классом renderer_residual и сигналами в отчёте", async () => {
    const { service, referenceId } = await prepare("signals-text", textLike(80, 60, 0), textLike(80, 60, 1));
    const report = await withEnv({ EASYUI_VISUAL_SIGNALS_V2: "1" }, async () =>
      waitReport(service, service.check(referenceId, { threshold: 5 }).runId));
    expect(report.status).toBe("pass");
    expect(report.class).toBe("renderer_residual");
    expect(report.signals?.dims).toBe("equal");
    expect(report.signals?.edgeResidual?.insidePct).toBeGreaterThanOrEqual(CAUSE_THRESHOLDS.edgeResidualInsidePct);
    // Перцептивная метрика по-прежнему на своём месте: её читают существующие потребители.
    expect(report.metric).toBe("pixelmatch-v1");
    expect(report.metrics["exact-rgba"]?.diffPixels).toBeGreaterThan(0);
  });

  test("сдвиг плашки на 4 px: fail/regression, первая причина — geometry-shift", async () => {
    const { service, referenceId } = await prepare("signals-badge", badge(80, 60, 0), badge(80, 60, 4));
    const report = await withEnv({ EASYUI_VISUAL_SIGNALS_V2: "1" }, async () =>
      waitReport(service, service.check(referenceId, { threshold: 5 }).runId));
    expect(report.status).toBe("fail");
    expect(report.class).toBe("regression");
    expect(report.signals?.causes?.[0]?.code).toBe("geometry-shift");
    expect(report.diff).not.toBeNull();
  });

  test("изменённая заливка: fail/regression с surface-tint там, где доволновой ран отдавал pass", async () => {
    const reference = surface(80, 60, [242, 241, 240, 255]);
    const candidate = surface(80, 60, [232, 240, 255, 255]);

    const off = await prepare("signals-fill-off", reference, candidate);
    const before = await withEnv({ EASYUI_VISUAL_SIGNALS_V2: undefined }, async () =>
      waitReport(off.service, off.service.check(off.referenceId, {}).runId));
    expect(before.status).toBe("pass");
    expect(before.class).toBeNull();
    expect(before.signals).toBeNull();

    const on = await prepare("signals-fill-on", reference, candidate);
    const after = await withEnv({ EASYUI_VISUAL_SIGNALS_V2: "1" }, async () =>
      waitReport(on.service, on.service.check(on.referenceId, {}).runId));
    expect(after.status).toBe("fail");
    expect(after.class).toBe("regression");
    expect(after.signals?.causes?.[0]?.code).toBe("surface-tint");
  });

  test("несводимые размеры: error/dimensions_irreconcilable, процента нет", async () => {
    const { service, referenceId } = await prepare("signals-dims", badge(80, 60, 0), badge(200, 60, 0));
    const report = await withEnv({ EASYUI_VISUAL_SIGNALS_V2: "1" }, async () =>
      waitReport(service, service.check(referenceId, {}).runId));
    expect(report.status).toBe("error");
    expect(report.class).toBe("indeterminate");
    expect(report.outcomeCode).toBe("dimensions_irreconcilable");
    expect(report.diffPercent).toBeNull();
    expect(report.metric).toBeNull();
  });

  test("флаг выключен — доволновое поведение буквально: тот же вердикт, class/signals пусты", async () => {
    const { service, referenceId } = await prepare("signals-legacy", badge(80, 60, 0), badge(80, 60, 4));
    const report = await withEnv({ EASYUI_VISUAL_SIGNALS_V2: undefined }, async () =>
      waitReport(service, service.check(referenceId, {}).runId));
    expect(report.status).toBe("fail");
    expect(report.class).toBeNull();
    expect(report.signals).toBeNull();
    expect(report.diffPercent).toBeGreaterThan(0);
  });
});
