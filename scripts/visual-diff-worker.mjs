// Visual-diff worker: one comparison per process, JSON over stdin -> single JSON
// line on stdout. Runs under node with pngjs (decode/encode) + pixelmatch. Never
// invents a percentage: mismatched dimensions are reported as such with no diff
// pixels, and both honest metrics (exact-rgba + pixelmatch-v1) are returned from
// the same buffers so the caller can build a full evidence report.
//
// Два режима, оба через тот же stdin-контракт:
//   * по умолчанию (`compare`) — сравнение кадр-в-кадр, историческая семантика VDC v1;
//   * `mode: "normalize"` (`normalizeAndCompare`, план 2026-08-03 §5 W5a) — crop эталона по
//     `cropLineage`, pad до общего холста и полный набор метрик случая приёмки.
/* global process, Buffer */
import pixelmatch from "pixelmatch";
import pngjs from "pngjs";

const { PNG } = pngjs;

/** Count pixels whose RGBA bytes differ exactly (no tolerance). Requires equal length. */
export function exactRgbaDiff(a, b) {
  let diff = 0;
  const total = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) diff += 1;
  }
  return { diffPixels: diff, totalPixels: total };
}

export function compare(referencePng, candidatePng, options) {
  const ref = PNG.sync.read(referencePng);
  const cand = PNG.sync.read(candidatePng);
  const refDims = { width: ref.width, height: ref.height };
  const candDims = { width: cand.width, height: cand.height };
  if (ref.width !== cand.width || ref.height !== cand.height) {
    return { ok: true, dimensionMismatch: true, refDims, candDims };
  }
  const threshold = typeof options?.threshold === "number" ? options.threshold : 0.1;
  const includeAA = options?.includeAA === true;
  const out = new PNG({ width: ref.width, height: ref.height });
  const total = ref.width * ref.height;
  const pmDiff = pixelmatch(ref.data, cand.data, out.data, ref.width, ref.height, { threshold, includeAA });
  const exact = exactRgbaDiff(ref.data, cand.data);
  return {
    ok: true,
    dimensionMismatch: false,
    refDims,
    candDims,
    exact: { diffPixels: exact.diffPixels, totalPixels: exact.totalPixels },
    pixelmatch: { diffPixels: pmDiff, totalPixels: total, options: { threshold, includeAA } },
    diffPngBase64: PNG.sync.write(out).toString("base64"),
  };
}

// ---------------------------------------------------------------------------
// Режим `normalize` (план 2026-08-03 §2 A5, §5 W5a; триаж R1-M4).
//
// `compare` выше отказывается судить кадры разного размера (`dimensionMismatch` без метрик) —
// для приёмки семейств этого мало: эталон приезжает вырезкой из родительского узла Figma
// (`cropLineage`), а кандидат — paint-кадром с маргин-полем, поэтому «на пиксель» они не совпадут
// почти никогда. Нормализация делает ровно три вещи и ни одной больше:
//
//   1. **crop** эталона по `cropLineage.rect` (если он задан) — прямоугольник в пикселях эталона;
//   2. **pad** обеих картинок прозрачным до общего холста, выравнивание по левому-верхнему углу;
//   3. **отказ вместо выдумки**: если после crop размеры расходятся больше допуска, метрик нет
//      вовсе — `{indeterminate: true, reason}`. Это `indeterminate` вызывающего (диагностика
//      «увеличить маргин»/«эталон снят в другом масштабе»), а не обвинение компонента.
//
// Всё, что дальше — метрики поверх **одного** нормализованного холста: `rawDiffPct` (строгий
// порог, AA считается), `aaDiffPct` (мягкий порог, AA игнорируется — остаток структурного
// расхождения), `maxChannelDelta`, связные области diff-маски и `bestOffset` (сдвиг целиком —
// «съехало на 2px» не то же самое, что «перерисовано»).
// ---------------------------------------------------------------------------

/** Порог строгой метрики: считаем всё, включая пиксели сглаживания. */
export const RAW_THRESHOLD = 0.1;
/** Порог AA-терпимой метрики: pixelmatch сам исключает пиксели сглаживания. */
export const AA_THRESHOLD = 0.25;
/** Допуск расхождения габаритов после crop, px: больше — картинки несводимы. */
export const DEFAULT_MAX_DIMENSION_DELTA_PX = 8;
/** Полуширина окна перебора смещений, px. */
export const OFFSET_WINDOW_PX = 8;
/** Потолок выборки пикселей для перебора смещений: перебор обязан остаться дешёвым. */
const OFFSET_SAMPLE_BUDGET = 20_000;
/** Минимальная доля перекрытия при смещении: иначе «сдвиг за край» побеждал бы пустотой. */
const MIN_OFFSET_COVERAGE = 0.6;
/** Максимум связных областей в отчёте (план §5 W5a). */
export const MAX_REGIONS = 12;

const clampInt = (value, min, max) => Math.max(min, Math.min(max, Math.round(value)));
const round4 = (value) => Math.round((value + Number.EPSILON) * 10_000) / 10_000;

/** Вырезка прямоугольника `[x, y, width, height]` (в пикселях исходника) в новый PNG. */
export function cropPng(png, rect) {
  const x = clampInt(rect[0], 0, png.width);
  const y = clampInt(rect[1], 0, png.height);
  const width = clampInt(rect[2], 0, png.width - x);
  const height = clampInt(rect[3], 0, png.height - y);
  if (width <= 0 || height <= 0) return null;
  const out = new PNG({ width, height });
  for (let row = 0; row < height; row += 1) {
    const from = ((y + row) * png.width + x) * 4;
    png.data.copy(out.data, row * width * 4, from, from + width * 4);
  }
  return out;
}

/** Дополняет картинку прозрачным до холста `width×height`, выравнивая по левому-верхнему углу. */
export function padPng(png, width, height) {
  if (png.width === width && png.height === height) return png;
  const out = new PNG({ width, height });
  out.data.fill(0);
  const rows = Math.min(png.height, height);
  const cols = Math.min(png.width, width);
  for (let row = 0; row < rows; row += 1) {
    const from = row * png.width * 4;
    png.data.copy(out.data, row * width * 4, from, from + cols * 4);
  }
  return out;
}

/** Максимальная по-канальная дельта одного пикселя (включая альфу). */
const pixelDelta = (a, b, offset) => {
  let max = 0;
  for (let channel = 0; channel < 4; channel += 1) {
    const delta = Math.abs(a[offset + channel] - b[offset + channel]);
    if (delta > max) max = delta;
  }
  return max;
};

/**
 * Связные области diff-маски (4-связность, итеративный BFS — рекурсия на кадре 500×450
 * переполнила бы стек). Возвращает до `MAX_REGIONS` самых крупных: полный список областей — это
 * не отчёт, а вторая копия маски.
 */
export function diffRegions(mask, width, height, deltas, totalPixels, limit = MAX_REGIONS) {
  const seen = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  const regions = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (seen[start] === 1 || mask[start] === 0) continue;
    let head = 0; let tail = 0;
    queue[tail++] = start; seen[start] = 1;
    let minX = width; let minY = height; let maxX = -1; let maxY = -1;
    let area = 0; let deltaSum = 0;
    while (head < tail) {
      const index = queue[head++];
      const x = index % width; const y = (index / width) | 0;
      area += 1; deltaSum += deltas[index];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && seen[index - 1] === 0 && mask[index - 1] === 1) { seen[index - 1] = 1; queue[tail++] = index - 1; }
      if (x + 1 < width && seen[index + 1] === 0 && mask[index + 1] === 1) { seen[index + 1] = 1; queue[tail++] = index + 1; }
      if (y > 0 && seen[index - width] === 0 && mask[index - width] === 1) { seen[index - width] = 1; queue[tail++] = index - width; }
      if (y + 1 < height && seen[index + width] === 0 && mask[index + width] === 1) { seen[index + width] = 1; queue[tail++] = index + width; }
    }
    regions.push({
      bbox: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
      areaPct: round4((area / totalPixels) * 100),
      meanDelta: round4(deltaSum / area),
    });
  }
  regions.sort((left, right) => right.areaPct - left.areaPct);
  return { regions: regions.slice(0, limit), totalRegions: regions.length };
}

/**
 * Лучшее целочисленное смещение кандидата относительно эталона в окне ±`window` px.
 *
 * Знак: кандидат сэмплируется в точке `(x + dx, y + dy)` там, где эталон взят в `(x, y)`, то есть
 * положительный `dx` означает «кандидат нарисован правее эталона на dx px».
 *
 * Считается по подвыборке (шаг сетки подбирается под бюджет), поэтому `residualPct` — оценка, а не
 * точная метрика; её роль — отличить «съехало» от «перерисовано». Пиксели, ушедшие за холст,
 * из знаменателя **исключаются** (иначе край кадра всегда перевешивал бы находку), но смещение,
 * оставляющее меньше `MIN_OFFSET_COVERAGE` перекрытия, не рассматривается вовсе.
 */
export function bestOffsetOf(refData, candData, width, height, options = {}) {
  const window = options.window ?? OFFSET_WINDOW_PX;
  const threshold = options.deltaThreshold ?? 8;
  const step = Math.max(1, Math.ceil(Math.sqrt((width * height) / OFFSET_SAMPLE_BUDGET)));
  const gridPoints = Math.ceil(width / step) * Math.ceil(height / step);
  const minCoverage = Math.max(1, Math.floor(gridPoints * MIN_OFFSET_COVERAGE));
  let best = { dx: 0, dy: 0, residualPct: 100, sampled: 0 };
  for (let dy = -window; dy <= window; dy += 1) {
    for (let dx = -window; dx <= window; dx += 1) {
      let sampled = 0; let mismatched = 0;
      for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
          const sx = x + dx; const sy = y + dy;
          if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
          sampled += 1;
          const refOffset = (y * width + x) * 4;
          const candOffset = (sy * width + sx) * 4;
          let delta = 0;
          for (let channel = 0; channel < 4; channel += 1) {
            const value = Math.abs(refData[refOffset + channel] - candData[candOffset + channel]);
            if (value > delta) delta = value;
          }
          if (delta > threshold) mismatched += 1;
        }
      }
      if (sampled < minCoverage) continue;
      const residualPct = (mismatched / sampled) * 100;
      // Строгое `<`: при равенстве побеждает меньшее по модулю смещение (перебор идёт от -window,
      // поэтому дополнительно сравниваем расстояние).
      const better = residualPct < best.residualPct - 1e-9
        || (Math.abs(residualPct - best.residualPct) <= 1e-9 && Math.abs(dx) + Math.abs(dy) < Math.abs(best.dx) + Math.abs(best.dy));
      if (better) best = { dx, dy, residualPct, sampled };
    }
  }
  return { dx: best.dx, dy: best.dy, residualPct: round4(best.residualPct), sampledPixels: best.sampled, step };
}

/**
 * Нормализация размеров + метрики случая приёмки.
 *
 * `options`: `{ cropRect?: [x,y,w,h], maxDimensionDeltaPx?, rawThreshold?, aaThreshold?,
 * regionDeltaThreshold?, maxRegions?, offsetWindow? }`.
 */
export function normalizeAndCompare(referencePng, candidatePng, options = {}) {
  const refSource = PNG.sync.read(referencePng);
  const candidate = PNG.sync.read(candidatePng);
  const sourceDims = { width: refSource.width, height: refSource.height };
  const candDims = { width: candidate.width, height: candidate.height };

  const cropRect = Array.isArray(options.cropRect) && options.cropRect.length === 4 ? options.cropRect : null;
  const reference = cropRect ? cropPng(refSource, cropRect) : refSource;
  if (!reference) {
    return {
      ok: true, mode: "normalize", indeterminate: true,
      reason: `cropLineage.rect [${cropRect.join(", ")}] selects no pixels of the ${sourceDims.width}×${sourceDims.height} reference`,
      sourceDims, refDims: sourceDims, candDims, cropApplied: false,
    };
  }
  const refDims = { width: reference.width, height: reference.height };
  const tolerance = options.maxDimensionDeltaPx ?? DEFAULT_MAX_DIMENSION_DELTA_PX;
  const deltaWidth = Math.abs(refDims.width - candDims.width);
  const deltaHeight = Math.abs(refDims.height - candDims.height);
  if (deltaWidth > tolerance || deltaHeight > tolerance) {
    return {
      ok: true, mode: "normalize", indeterminate: true,
      reason: `reference ${refDims.width}×${refDims.height} and candidate ${candDims.width}×${candDims.height} differ by ${deltaWidth}×${deltaHeight}px, beyond the ${tolerance}px pad tolerance`,
      sourceDims, refDims, candDims, cropApplied: cropRect !== null,
      dimensionDelta: { width: deltaWidth, height: deltaHeight, tolerancePx: tolerance },
    };
  }

  const width = Math.max(refDims.width, candDims.width);
  const height = Math.max(refDims.height, candDims.height);
  const paddedRef = padPng(reference, width, height);
  const paddedCand = padPng(candidate, width, height);
  const total = width * height;

  const rawThreshold = options.rawThreshold ?? RAW_THRESHOLD;
  const aaThreshold = options.aaThreshold ?? AA_THRESHOLD;
  const diff = new PNG({ width, height });
  const rawPixels = pixelmatch(paddedRef.data, paddedCand.data, diff.data, width, height, { threshold: rawThreshold, includeAA: true });
  const aaPixels = pixelmatch(paddedRef.data, paddedCand.data, undefined, width, height, { threshold: aaThreshold, includeAA: false });

  // Маска — тот же прогон, что и `rawDiffPct` (`diffMask` рисует различия по прозрачному фону),
  // поэтому области и процент не могут разойтись между собой.
  const maskPng = new PNG({ width, height });
  pixelmatch(paddedRef.data, paddedCand.data, maskPng.data, width, height, { threshold: rawThreshold, includeAA: true, diffMask: true });
  const mask = new Uint8Array(total);
  const deltas = new Uint16Array(total);
  let maxChannelDelta = 0;
  for (let index = 0; index < total; index += 1) {
    const offset = index * 4;
    if (maskPng.data[offset + 3] > 0) mask[index] = 1;
    const delta = pixelDelta(paddedRef.data, paddedCand.data, offset);
    deltas[index] = delta;
    if (delta > maxChannelDelta) maxChannelDelta = delta;
  }
  const { regions, totalRegions } = diffRegions(mask, width, height, deltas, total, options.maxRegions ?? MAX_REGIONS);

  return {
    ok: true,
    mode: "normalize",
    indeterminate: false,
    sourceDims,
    refDims,
    candDims,
    cropApplied: cropRect !== null,
    canvas: { width, height },
    padded: { reference: refDims.width !== width || refDims.height !== height, candidate: candDims.width !== width || candDims.height !== height },
    metrics: {
      rawDiffPct: round4((rawPixels / total) * 100),
      aaDiffPct: round4((aaPixels / total) * 100),
      rawDiffPixels: rawPixels,
      aaDiffPixels: aaPixels,
      totalPixels: total,
      maxChannelDelta,
      regions,
      totalRegions,
      bestOffset: bestOffsetOf(paddedRef.data, paddedCand.data, width, height, {
        ...(options.offsetWindow === undefined ? {} : { window: options.offsetWindow }),
      }),
      thresholds: { raw: rawThreshold, aa: aaThreshold },
    },
    diffPngBase64: PNG.sync.write(diff).toString("base64"),
    normalizedCandidatePngBase64: PNG.sync.write(paddedCand).toString("base64"),
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  readStdin()
    .then((job) => (job.mode === "normalize" ? normalizeAndCompare : compare)(
      Buffer.from(job.referencePngBase64, "base64"), Buffer.from(job.candidatePngBase64, "base64"), job.options))
    .then((result) => { process.stdout.write(JSON.stringify(result) + "\n"); process.exit(0); })
    .catch((error) => { process.stdout.write(JSON.stringify({ ok: false, error: error?.message ?? String(error) }) + "\n"); process.exit(1); });
}
