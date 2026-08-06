import { expect, test } from "bun:test";
import pngjs from "pngjs";
import { normalizeAndCompare } from "../scripts/visual-diff-worker.mjs";
import { spawnNormalizedDiffWorker } from "./visual/diff-runner";

/**
 * Нормализующий visual-diff (план 2026-08-03 §2 A5, §5 W5a; триаж R1-M4).
 *
 * Предмет — три свойства, ради которых режим вообще заведён:
 * 1. **crop по `cropLineage`**: эталон-вырезка из макета приводится к кадру случая;
 * 2. **`indeterminate` вместо выдуманного процента**: несводимые размеры не получают метрик;
 * 3. **`bestOffset`**: «съехало на N px» отличимо от «перерисовано» — иначе автору нечего чинить.
 */

const { PNG } = pngjs;

/** Синтетический кадр: холст `fill`, поверх — прямоугольник `color`. */
function framePng(
  width: number, height: number,
  rect: { x: number; y: number; width: number; height: number; color: [number, number, number, number] } | null,
  fill: [number, number, number, number] = [0, 0, 0, 0],
): Buffer {
  const png = new PNG({ width, height });
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    png.data[offset] = fill[0]; png.data[offset + 1] = fill[1]; png.data[offset + 2] = fill[2]; png.data[offset + 3] = fill[3];
  }
  if (rect) {
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const offset = (y * width + x) * 4;
        png.data[offset] = rect.color[0]; png.data[offset + 1] = rect.color[1];
        png.data[offset + 2] = rect.color[2]; png.data[offset + 3] = rect.color[3];
      }
    }
  }
  return PNG.sync.write(png);
}

const INK: [number, number, number, number] = [0x20, 0x40, 0xc0, 0xff];
const OTHER: [number, number, number, number] = [0xc0, 0x20, 0x20, 0xff];

test("identical frames diff to zero and still carry the full metric set", () => {
  const frame = framePng(40, 32, { x: 8, y: 6, width: 16, height: 12, color: INK });
  const result = normalizeAndCompare(frame, frame);
  expect(result.indeterminate).toBe(false);
  if (result.indeterminate) throw new Error(result.reason);

  expect(result.metrics.rawDiffPct).toBe(0);
  expect(result.metrics.aaDiffPct).toBe(0);
  expect(result.metrics.maxChannelDelta).toBe(0);
  expect(result.metrics.regions).toEqual([]);
  expect(result.metrics.totalRegions).toBe(0);
  expect(result.metrics.bestOffset).toMatchObject({ dx: 0, dy: 0, residualPct: 0 });
  expect(result.canvas).toEqual({ width: 40, height: 32 });
  expect(result.padded).toEqual({ reference: false, candidate: false });
  // Оба артефакта — байты, а не описание байтов: их кладёт в CAS гейт.
  expect(Buffer.from(result.diffPngBase64, "base64").length).toBeGreaterThan(0);
  expect(PNG.sync.read(Buffer.from(result.normalizedCandidatePngBase64, "base64")).width).toBe(40);
});

test("a whole-frame shift is reported as an offset, not as an opaque percentage", () => {
  const reference = framePng(40, 32, { x: 8, y: 6, width: 16, height: 12, color: INK });
  const shifted = framePng(40, 32, { x: 11, y: 8, width: 16, height: 12, color: INK });
  const result = normalizeAndCompare(reference, shifted);
  expect(result.indeterminate).toBe(false);
  if (result.indeterminate) throw new Error(result.reason);

  expect(result.metrics.rawDiffPct).toBeGreaterThan(0);
  // Кандидат сдвинут на +3/+2, поэтому совпадение достигается сэмплом кандидата со смещением +3/+2.
  expect(result.metrics.bestOffset).toMatchObject({ dx: 3, dy: 2 });
  expect(result.metrics.bestOffset.residualPct).toBe(0);
  expect(result.metrics.maxChannelDelta).toBeGreaterThan(0);
  // Сдвиг прямоугольника даёт связные области по краям — их не больше потолка отчёта.
  expect(result.metrics.regions.length).toBeGreaterThan(0);
  expect(result.metrics.regions.length).toBeLessThanOrEqual(12);
  for (const region of result.metrics.regions) {
    expect(region.areaPct).toBeGreaterThan(0);
    expect(region.meanDelta).toBeGreaterThan(0);
  }
});

test("cropLineage.rect cuts the reference down to the case frame before comparing", () => {
  // Эталон — «макет»: нужный компонент лежит вырезкой [20,10,40,32] внутри большого холста.
  const parent = framePng(80, 60, { x: 28, y: 16, width: 16, height: 12, color: INK }, [0, 0, 0, 0]);
  const candidate = framePng(40, 32, { x: 8, y: 6, width: 16, height: 12, color: INK });

  const cropped = normalizeAndCompare(parent, candidate, { cropRect: [20, 10, 40, 32] });
  expect(cropped.indeterminate).toBe(false);
  if (cropped.indeterminate) throw new Error(cropped.reason);
  expect(cropped.cropApplied).toBe(true);
  expect(cropped.refDims).toEqual({ width: 40, height: 32 });
  expect(cropped.sourceDims).toEqual({ width: 80, height: 60 });
  expect(cropped.metrics.rawDiffPct).toBe(0);

  // Без crop те же байты несводимы — и это `indeterminate`, а не «100% расхождения».
  const raw = normalizeAndCompare(parent, candidate);
  expect(raw.indeterminate).toBe(true);
  if (!raw.indeterminate) throw new Error("expected an indeterminate verdict");
  expect(raw.reason).toContain("beyond the");
});

test("irreconcilable sizes yield indeterminate with a named reason and no metrics", () => {
  const reference = framePng(200, 200, { x: 10, y: 10, width: 40, height: 40, color: INK });
  const candidate = framePng(40, 32, { x: 8, y: 6, width: 16, height: 12, color: INK });
  const result = normalizeAndCompare(reference, candidate);

  expect(result.indeterminate).toBe(true);
  if (!result.indeterminate) throw new Error("expected an indeterminate verdict");
  expect(result).not.toHaveProperty("metrics");
  expect(result.dimensionDelta).toMatchObject({ width: 160, height: 168, tolerancePx: 8 });
  expect(result.reason).toContain("200×200");
  expect(result.reason).toContain("40×32");

  // Пустая вырезка — тоже отказ, а не сравнение с нулевым холстом.
  const empty = normalizeAndCompare(reference, candidate, { cropRect: [500, 500, 40, 32] });
  expect(empty.indeterminate).toBe(true);
  if (!empty.indeterminate) throw new Error("expected an indeterminate verdict");
  expect(empty.reason).toContain("selects no pixels");
});

test("sizes inside the pad tolerance are reconciled by padding to a common canvas", () => {
  const reference = framePng(40, 32, { x: 8, y: 6, width: 16, height: 12, color: INK });
  const candidate = framePng(44, 34, { x: 8, y: 6, width: 16, height: 12, color: INK });
  const result = normalizeAndCompare(reference, candidate);

  expect(result.indeterminate).toBe(false);
  if (result.indeterminate) throw new Error(result.reason);
  expect(result.canvas).toEqual({ width: 44, height: 34 });
  expect(result.padded).toEqual({ reference: true, candidate: false });
  // Добивка прозрачным совпала с прозрачным полем кандидата ⇒ расхождения нет вовсе.
  expect(result.metrics.rawDiffPct).toBe(0);

  // Тот же зазор при более строгом допуске — уже несводимость.
  const strict = normalizeAndCompare(reference, candidate, { maxDimensionDeltaPx: 1 });
  expect(strict.indeterminate).toBe(true);
});

test("a recoloured region is a raw difference: aa-tolerant metric sees it too", () => {
  const reference = framePng(40, 32, { x: 8, y: 6, width: 16, height: 12, color: INK });
  const recoloured = framePng(40, 32, { x: 8, y: 6, width: 16, height: 12, color: OTHER });
  const result = normalizeAndCompare(reference, recoloured);

  expect(result.indeterminate).toBe(false);
  if (result.indeterminate) throw new Error(result.reason);
  const area = (16 * 12) / (40 * 32) * 100;
  expect(result.metrics.rawDiffPct).toBeCloseTo(area, 2);
  expect(result.metrics.aaDiffPct).toBeGreaterThan(0);
  expect(result.metrics.regions).toHaveLength(1);
  expect(result.metrics.regions[0]!.bbox).toEqual({ x: 8, y: 6, width: 16, height: 12 });
  expect(result.metrics.thresholds).toEqual({ raw: 0.1, aa: 0.25 });
});

test("edge-сигнал в режиме normalize строго opt-in (R7a): без флага результат доволновой", () => {
  const reference = framePng(24, 24, { x: 4, y: 4, width: 8, height: 8, color: INK });
  const candidate = framePng(24, 24, { x: 5, y: 4, width: 8, height: 8, color: INK });
  const off = normalizeAndCompare(reference, candidate, { edge: false });
  if (off.indeterminate) throw new Error(off.reason);
  expect(off.metrics.edgeResidual).toBeUndefined();

  const on = normalizeAndCompare(reference, candidate, { edge: true });
  if (on.indeterminate) throw new Error(on.reason);
  // Сдвиг фигуры на 1 px: остаток обязан лежать на её собственных контурах.
  expect(on.metrics.edgeResidual!.insidePct).toBe(100);
  expect(on.metrics.edgeResidual!.outsidePixels).toBe(0);
});

test("the spawned node worker returns the same normalized verdict over stdin/stdout", async () => {
  const reference = framePng(24, 24, { x: 4, y: 4, width: 8, height: 8, color: INK });
  const candidate = framePng(24, 24, { x: 4, y: 4, width: 8, height: 8, color: INK });
  const result = await spawnNormalizedDiffWorker({
    mode: "normalize",
    referencePngBase64: reference.toString("base64"),
    candidatePngBase64: candidate.toString("base64"),
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(result.indeterminate).toBe(false);
  if (result.indeterminate) throw new Error(result.reason);
  expect(result.metrics.rawDiffPct).toBe(0);
  expect(result.mode).toBe("normalize");

  const garbage = await spawnNormalizedDiffWorker({
    mode: "normalize",
    referencePngBase64: Buffer.from("not a png").toString("base64"),
    candidatePngBase64: candidate.toString("base64"),
  });
  expect(garbage.ok).toBe(false);
});

test("channelStats describe the mask itself: uniform tint vs alpha-only divergence (W5b)", () => {
  // Равномерный тинт: дельта одинаковая во всех пикселях маски ⇒ нулевой разброс.
  const base = framePng(20, 20, null, [10, 10, 10, 255]);
  const tinted = framePng(20, 20, null, [110, 110, 110, 255]);
  const tint = normalizeAndCompare(base, tinted);
  if (tint.indeterminate) throw new Error(tint.reason);
  expect(tint.metrics.channelStats.pixels).toBe(400);
  expect(tint.metrics.channelStats.stdMaxDelta).toBe(0);
  expect(tint.metrics.channelStats.meanMaxDelta).toBe(100);
  expect(tint.metrics.channelStats.alphaDominantPct).toBe(0);

  // Расхождение только по альфе: цвет тот же, прозрачность другая.
  const opaque = framePng(20, 20, { x: 4, y: 4, width: 8, height: 8, color: [0, 0, 255, 255] });
  const translucent = framePng(20, 20, { x: 4, y: 4, width: 8, height: 8, color: [0, 0, 255, 128] });
  const alpha = normalizeAndCompare(opaque, translucent);
  if (alpha.indeterminate) throw new Error(alpha.reason);
  expect(alpha.metrics.channelStats.alphaDominantPct).toBe(100);
  expect(alpha.metrics.channelStats.semiTransparentPct).toBe(100);
  expect(alpha.metrics.channelStats.meanDelta.a).toBeGreaterThan(0);
});

// ------------------------------------------------------ matte сравнения (план 2026-08-06 §W4 T4a)

test("§W4: matte кладёт обе картинки на объявленный цвет — прозрачность перестаёт быть расхождением", () => {
  // Ровно продуктовый случай строки 7 фидбэка: эталон экспортирован поверх белого, кандидат снят
  // прозрачным (`omitBackground:true`). Без matte расходится каждый пиксель поля — по альфе.
  const reference = framePng(20, 20, { x: 4, y: 4, width: 8, height: 8, color: INK }, [255, 255, 255, 255]);
  const candidate = framePng(20, 20, { x: 4, y: 4, width: 8, height: 8, color: INK }, [0, 0, 0, 0]);

  const bare = normalizeAndCompare(reference, candidate);
  if (bare.indeterminate) throw new Error(bare.reason);
  expect(bare.metrics.rawDiffPct).toBeGreaterThan(50);
  expect(bare.metrics.matteApplied).toBeUndefined();

  const matted = normalizeAndCompare(reference, candidate, { matte: "#FFFFFF" });
  if (matted.indeterminate) throw new Error(matted.reason);
  expect(matted.metrics.rawDiffPct).toBe(0);
  expect(matted.metrics.channelStats.pixels).toBe(0);
  // Цвет нормализован к нижнему регистру: метрика — факт, а не эхо ввода.
  expect(matted.metrics.matteApplied).toBe("#ffffff");
  // Матированный эталон уезжает в evidence и **без** `padTo` (W4-5): сервер его действительно строил.
  expect(matted.normalizedReferencePngBase64).toBeDefined();
  const normalized = PNG.sync.read(Buffer.from(matted.normalizedReferencePngBase64!, "base64"));
  for (let index = 3; index < normalized.data.length; index += 4) expect(normalized.data[index]).toBe(255);
});

test("§W4: matte над полупрозрачным пикселем — straight-alpha over, а не замена цвета", () => {
  // Полупрозрачный синий над белым обязан дать ровно `src·a + bg·(1−a)`; проверяем оба слагаемых,
  // иначе premultiplied-ошибка (двойное домножение на альфу) прошла бы незамеченной.
  const translucent = framePng(4, 4, null, [0, 0, 255, 128]);
  const expected = framePng(4, 4, null, [128, 128, 255, 255]);
  const result = normalizeAndCompare(translucent, expected, { matte: "#ffffff" });
  if (result.indeterminate) throw new Error(result.reason);
  // 255·(1−128/255) = 127, 0·a + 255·(1−a) = 127 ⇒ округление даёт 127 против объявленных 128.
  expect(result.metrics.maxChannelDelta).toBeLessThanOrEqual(1);

  // Тот же вход без matte: полупрозрачность расходится с непрозрачностью на всём холсте.
  const bare = normalizeAndCompare(translucent, expected);
  if (bare.indeterminate) throw new Error(bare.reason);
  expect(bare.metrics.channelStats.semiTransparentPct).toBe(100);
  expect(bare.metrics.rawDiffPct).toBe(100);
});

test("§W4: matte идемпотентен и после него альфа ≡ 255 у обеих картинок", () => {
  const reference = framePng(12, 12, { x: 2, y: 2, width: 4, height: 4, color: [255, 0, 0, 64] }, [0, 0, 0, 0]);
  const candidate = framePng(12, 12, { x: 2, y: 2, width: 4, height: 4, color: [255, 0, 0, 64] }, [0, 0, 0, 0]);
  const once = normalizeAndCompare(reference, candidate, { matte: "#102030" });
  if (once.indeterminate) throw new Error(once.reason);
  const matted = Buffer.from(once.normalizedCandidatePngBase64, "base64");
  const decoded = PNG.sync.read(matted);
  for (let index = 3; index < decoded.data.length; index += 4) expect(decoded.data[index]).toBe(255);

  // Второй проход того же цвета ничего не меняет: над непрозрачным пикселем `a = 1`.
  const twice = normalizeAndCompare(matted, matted, { matte: "#102030" });
  if (twice.indeterminate) throw new Error(twice.reason);
  expect(twice.metrics.rawDiffPct).toBe(0);
  expect(PNG.sync.read(Buffer.from(twice.normalizedCandidatePngBase64, "base64")).data.equals(decoded.data)).toBe(true);

  // `"none"` и мусор — это «не матировать», а не отказ: дефолт применяет потребитель.
  const none = normalizeAndCompare(reference, candidate, { matte: "none" });
  if (none.indeterminate) throw new Error(none.reason);
  expect(none.metrics.matteApplied).toBeUndefined();
  expect(none.normalizedReferencePngBase64).toBeUndefined();
});

test("§W4: порядок нормализации — crop → place/pad → matte → метрики", () => {
  // Эталон content-hug (только сам компонент) кладётся в канву 20×20 со смещением (4,4); поле
  // канвы после matte обязано совпасть с матированным прозрачным полем кандидата, то есть дать 0.
  const hug = framePng(8, 8, null, [0, 0, 255, 255]);
  const candidate = framePng(20, 20, { x: 4, y: 4, width: 8, height: 8, color: [0, 0, 255, 255] }, [0, 0, 0, 0]);
  const placed = normalizeAndCompare(hug, candidate, {
    padReferenceTo: { width: 20, height: 20 }, referencePlacement: { x: 4, y: 4 }, matte: "#ff00ff",
  });
  if (placed.indeterminate) throw new Error(placed.reason);
  expect(placed.metrics.rawDiffPct).toBe(0);
  expect(placed.metrics.matteApplied).toBe("#ff00ff");
  // Матирование до размещения раскрасило бы поле канвы иначе у эталона и кандидата.
  expect(placed.referenceNormalization!.placement).toEqual({ x: 4, y: 4 });
});
