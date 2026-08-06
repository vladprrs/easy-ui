// Visual-diff worker: one comparison per process, JSON over stdin -> single JSON
// line on stdout. Runs under node with pngjs (decode/encode) + pixelmatch. Never
// invents a percentage: mismatched dimensions are reported as such with no diff
// pixels, and both honest metrics (exact-rgba + pixelmatch-v1) are returned from
// the same buffers so the caller can build a full evidence report.
//
// Три режима, все через тот же stdin-контракт:
//   * по умолчанию (`compare`) — сравнение кадр-в-кадр, историческая семантика VDC v1;
//   * `mode: "normalize"` (`normalizeAndCompare`, план 2026-08-03 §5 W5a) — crop эталона по
//     `cropLineage`, pad до общего холста, опциональный matte (план 2026-08-06 §W4) и полный
//     набор метрик случая приёмки;
//   * `mode: "signals"` (`compareWithSignals`, план 2026-08-03-renderer-contract-2 §3 E6, §5 R7a) —
//     четыре сигнала визуального рана (`dims`/`exact`/`perceptual`/`edgeResidual`) плюс метрики,
//     которых требует классификатор причин. Включается флагом `EASYUI_VISUAL_SIGNALS_V2=1`.
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

/**
 * Кладёт картинку в прозрачный холст `width×height` со смещением `(x, y)` (план 2026-08-04 §W5).
 *
 * Отдельная функция, а не параметр `padPng`: у выравнивания по левому-верхнему углу и у
 * размещения по объявленному placement'у разный смысл. Первое — техническое дополнение до общего
 * холста после того, как размеры уже сведены; второе — **построение** канонической канвы из
 * content-hug эталона, и промахнуться в нём на margin значит сравнить компонент с пустотой.
 *
 * `null` — вырезка не помещается: выдумывать обрезку здесь нельзя, это `indeterminate` наверху.
 */
export function placePng(png, width, height, x, y) {
  if (x < 0 || y < 0 || png.width + x > width || png.height + y > height) return null;
  const out = new PNG({ width, height });
  out.data.fill(0);
  for (let row = 0; row < png.height; row += 1) {
    const from = row * png.width * 4;
    png.data.copy(out.data, ((y + row) * width + x) * 4, from, from + png.width * 4);
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

// ------------------------------------------------------------------ matte (план 2026-08-06 §W4 T4a)
//
// Зачем. Капчур снимается **прозрачным** (`omitBackground:true`), а Figma-экспорт эталона почти
// всегда лежит поверх непрозрачного холста. На таких парах каждый пиксель полупрозрачной тени,
// скругления и AA расходится по альфе — и вердикт говорит о фоне, которого у кандидата нет, а не
// о компоненте. Matte снимает ровно этот класс: обе картинки кладутся на **один объявленный
// цвет**, и дальше меряется то, что видно.
//
// Где. Только на сравнении и ровно один раз: после crop/placement/pad, до любой метрики. Раньше
// placement — матировали бы не ту область; позже метрик — метрики считались бы по разным входам.
//
// Что после. Альфа обеих картинок ≡ 255 по построению, поэтому альфа-расхождений не остаётся
// вовсе (это и обесточивает классификатор `alpha-compositing`: см. `matteApplied`).

/** `"#rrggbb"` → `{r,g,b}`; `"none"`/пусто/мусор → `null` (дефолт «не матировать» — здесь). */
export function parseMatte(value) {
  if (typeof value !== "string" || value === "none") return null;
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) return null;
  return {
    r: parseInt(value.slice(1, 3), 16),
    g: parseInt(value.slice(3, 5), 16),
    b: parseInt(value.slice(5, 7), 16),
    hex: `#${value.slice(1).toLowerCase()}`,
  };
}

/**
 * Композитинг «source over opaque background» по **straight** (не premultiplied) альфе:
 * `out = src·a + bg·(1−a)`, альфа результата 255. PNG отдаёт straight-альфу, поэтому домножать
 * на неё повторно нельзя — иначе полупрозрачный пиксель темнел бы дважды.
 *
 * Мутирует переданный буфер: обе картинки к этому моменту уже собственные копии воркера
 * (`padPng`/`placePng`), а лишний проход по кадру 780×1688 — это чистая цена без читателя.
 * Идемпотентна: после первого прохода `a = 1`, и второй ничего не меняет.
 */
export function matteOver(data, total, color) {
  for (let index = 0; index < total; index += 1) {
    const offset = index * 4;
    const alpha = data[offset + 3] / 255;
    if (alpha === 1) continue;
    const inverse = 1 - alpha;
    data[offset] = Math.round(data[offset] * alpha + color.r * inverse);
    data[offset + 1] = Math.round(data[offset + 1] * alpha + color.g * inverse);
    data[offset + 2] = Math.round(data[offset + 2] * alpha + color.b * inverse);
    data[offset + 3] = 255;
  }
  return data;
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
 * Статистика расхождения по каналам внутри diff-маски (план §5 W5b: вход классификаторов причин).
 *
 * Считается **только по пикселям маски** — усреднение по всему холсту размывало бы находку до
 * нуля на любом кадре с полем. Три вещи, которых нет в `rawDiffPct`/`maxChannelDelta` и без
 * которых причину не назвать:
 *
 * - `meanMaxDelta`/`stdMaxDelta` — «равномерная заливка» (`surface-tint`) отличима от
 *   «локального дефекта»: у тинта разброс дельты внутри маски мал;
 * - `alphaDominantPct` — доля пикселей, где расходится именно альфа, а не цвет
 *   (`alpha-compositing`);
 * - `semiTransparentPct` — доля пикселей, где хотя бы одна сторона полупрозрачна (композитинг
 *   поверх подложки, а не другой цвет).
 */
export function channelStatsOf(refData, candData, mask, total) {
  let pixels = 0;
  let sumR = 0; let sumG = 0; let sumB = 0; let sumA = 0;
  let sumMax = 0; let sumMaxSq = 0;
  let alphaDominant = 0; let semiTransparent = 0;
  for (let index = 0; index < total; index += 1) {
    if (mask[index] === 0) continue;
    const offset = index * 4;
    const dr = Math.abs(refData[offset] - candData[offset]);
    const dg = Math.abs(refData[offset + 1] - candData[offset + 1]);
    const db = Math.abs(refData[offset + 2] - candData[offset + 2]);
    const da = Math.abs(refData[offset + 3] - candData[offset + 3]);
    const max = Math.max(dr, dg, db, da);
    pixels += 1;
    sumR += dr; sumG += dg; sumB += db; sumA += da;
    sumMax += max; sumMaxSq += max * max;
    if (da > Math.max(dr, dg, db)) alphaDominant += 1;
    const refAlpha = refData[offset + 3]; const candAlpha = candData[offset + 3];
    if ((refAlpha > 0 && refAlpha < 255) || (candAlpha > 0 && candAlpha < 255)) semiTransparent += 1;
  }
  if (pixels === 0) {
    return {
      pixels: 0, meanDelta: { r: 0, g: 0, b: 0, a: 0 },
      meanMaxDelta: 0, stdMaxDelta: 0, alphaDominantPct: 0, semiTransparentPct: 0,
    };
  }
  const meanMax = sumMax / pixels;
  const variance = Math.max(0, sumMaxSq / pixels - meanMax * meanMax);
  return {
    pixels,
    meanDelta: {
      r: round4(sumR / pixels), g: round4(sumG / pixels),
      b: round4(sumB / pixels), a: round4(sumA / pixels),
    },
    meanMaxDelta: round4(meanMax),
    stdMaxDelta: round4(Math.sqrt(variance)),
    alphaDominantPct: round4((alphaDominant / pixels) * 100),
    semiTransparentPct: round4((semiTransparent / pixels) * 100),
  };
}

// ------------------------------------------------------------------ edge-маска (R7a, E6)
//
// Зачем. Расхождение «на границе того, что нарисовано» и расхождение «внутри залитой области» —
// разные события: первое производит растеризатор (хинтинг глифа, субпиксельный origin, скругление
// антиалиасом), второе — изменившийся макет, цвет или ассет. Отличать их «по проценту» нельзя:
// 0,3 % могут быть и тем, и другим. Отличать можно по геометрии остатка: растровый шум **лежит на
// контурах эталона**, регрессия — нет.
//
// Как. Маска считается **по эталону** (кандидат в ней не участвует — иначе кандидат сам себе
// назначал бы допустимую зону): яркость с учётом альфы → Sobel → порог по модулю градиента →
// дилатация на `EDGE_DILATION_PX` пикселей. Дилатация обязательна: сдвиг растра на 1 px уводит
// пиксель ровно на соседний, и без расширения контур не покрывал бы собственный остаток.
//
// Один механизм (T-M9). Эта же маска — вход классификатора `text-raster-residual`
// (`server/visual/causes.ts`): двух детекторов одного явления не существует.

/** Порог модуля градиента Sobel (0..~1020) для признания пикселя контуром эталона. */
export const EDGE_SOBEL_THRESHOLD = 24;
/** Радиус дилатации контура, px: остаток сдвига на 1 px обязан попадать внутрь маски. */
export const EDGE_DILATION_PX = 1;
/**
 * T из E6: доля остатка внутри edge-маски, с которой расхождение объявляется растровым.
 * Калибровка на реальных парах (playwright, DPR 2) — план §4, факт R7a: сдвиг текста на 1 px даёт
 * 99–100 %, сдвиг плашки на 4 px — 55–70 %, смена заливки — единицы процентов.
 */
export const EDGE_RESIDUAL_MIN_PCT = 95;

/** Яркость с учётом альфы: прозрачное поле — ноль, поэтому граница контента тоже даёт градиент. */
export function luminanceOf(data, total) {
  const lum = new Float32Array(total);
  for (let index = 0; index < total; index += 1) {
    const offset = index * 4;
    const alpha = data[offset + 3] / 255;
    lum[index] = (0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2]) * alpha;
  }
  return lum;
}

/**
 * Контурная маска кадра: Sobel по яркости, порог, дилатация 3×3 (`dilation` итераций).
 * Края холста обрабатываются повтором крайнего пикселя — «рамки» из-за границы кадра не возникает.
 */
export function edgeMaskOf(data, width, height, options = {}) {
  const threshold = options.sobelThreshold ?? EDGE_SOBEL_THRESHOLD;
  const dilation = options.dilation ?? EDGE_DILATION_PX;
  const total = width * height;
  const lum = luminanceOf(data, total);
  const at = (x, y) => lum[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))];
  let mask = new Uint8Array(total);
  let edgePixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const tl = at(x - 1, y - 1); const tc = at(x, y - 1); const tr = at(x + 1, y - 1);
      const ml = at(x - 1, y); const mr = at(x + 1, y);
      const bl = at(x - 1, y + 1); const bc = at(x, y + 1); const br = at(x + 1, y + 1);
      const gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
      const gy = (bl + 2 * bc + br) - (tl + 2 * tc + tr);
      if (Math.sqrt(gx * gx + gy * gy) >= threshold) { mask[y * width + x] = 1; edgePixels += 1; }
    }
  }
  for (let pass = 0; pass < dilation; pass += 1) {
    const grown = new Uint8Array(total);
    edgePixels = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let hit = 0;
        for (let dy = -1; dy <= 1 && hit === 0; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const sx = x + dx; const sy = y + dy;
            if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
            if (mask[sy * width + sx] === 1) { hit = 1; break; }
          }
        }
        if (hit === 1) { grown[y * width + x] = 1; edgePixels += 1; }
      }
    }
    mask = grown;
  }
  return { mask, edgePixels, sobelThreshold: threshold, dilationPx: dilation };
}

/** Маска «пиксель отличается хоть чем-то» (exact-rgba): честный остаток без порогов и допусков. */
export function exactDiffMaskOf(refData, candData, total) {
  const mask = new Uint8Array(total);
  let diffPixels = 0;
  for (let index = 0; index < total; index += 1) {
    const offset = index * 4;
    if (refData[offset] !== candData[offset] || refData[offset + 1] !== candData[offset + 1]
      || refData[offset + 2] !== candData[offset + 2] || refData[offset + 3] !== candData[offset + 3]) {
      mask[index] = 1; diffPixels += 1;
    }
  }
  return { mask, diffPixels };
}

/**
 * Разбиение остатка на «внутри контура эталона» и «вне». Остаток берётся exact-rgba: любой другой
 * набор (например, переживший порог pixelmatch) уже отфильтрован и не описывает растровый шум,
 * ради которого сигнал существует.
 *
 * `insidePct === null` при пустом остатке: доли у несуществующего множества нет, и «100 %» здесь
 * было бы выдумкой.
 */
export function edgeResidualOf(diffMask, edge, total, canvasPixels) {
  let inside = 0; let outside = 0;
  for (let index = 0; index < total; index += 1) {
    if (diffMask[index] === 0) continue;
    if (edge.mask[index] === 1) inside += 1; else outside += 1;
  }
  const residualPixels = inside + outside;
  return {
    residualPixels, insidePixels: inside, outsidePixels: outside,
    insidePct: residualPixels === 0 ? null : round4((inside / residualPixels) * 100),
    edgePixels: edge.edgePixels,
    edgeCoveragePct: canvasPixels === 0 ? 0 : round4((edge.edgePixels / canvasPixels) * 100),
    sobelThreshold: edge.sobelThreshold,
    dilationPx: edge.dilationPx,
  };
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
 * `options`: `{ cropRect?: [x,y,w,h], padReferenceTo?: {width,height}, referencePlacement?: {x,y},
 * maxDimensionDeltaPx?, rawThreshold?, aaThreshold?, regionDeltaThreshold?, maxRegions?,
 * offsetWindow? }`.
 *
 * Порядок нормализации эталона фиксирован и однократен: crop (если вызывающий его запросил) →
 * размещение в канонической канве `padReferenceTo` по `referencePlacement`. Ни того, ни другого
 * воркер не «додумывает»: двойной crop — ровно та ловушка, из-за которой `136×32` превращался в
 * `116×12` (фидбэк P1).
 */
export function normalizeAndCompare(referencePng, candidatePng, options = {}) {
  const refSource = PNG.sync.read(referencePng);
  const candidate = PNG.sync.read(candidatePng);
  const sourceDims = { width: refSource.width, height: refSource.height };
  const candDims = { width: candidate.width, height: candidate.height };

  const cropRect = Array.isArray(options.cropRect) && options.cropRect.length === 4 ? options.cropRect : null;
  let reference = cropRect ? cropPng(refSource, cropRect) : refSource;
  if (!reference) {
    return {
      ok: true, mode: "normalize", indeterminate: true,
      reason: `cropLineage.rect [${cropRect.join(", ")}] selects no pixels of the ${sourceDims.width}×${sourceDims.height} reference`,
      sourceDims, refDims: sourceDims, candDims, cropApplied: false,
    };
  }
  // W5: `padReferenceTo` — **объявленная** вызывающим каноническая канва, а не выведенная здесь.
  // Воркер не знает ни `expectedGeometry`, ни margin'а рендерера, поэтому вывод размеров на его
  // стороне был бы догадкой; сервер считает канву сам и присылает её числом.
  const croppedDims = { width: reference.width, height: reference.height };
  const padTo = options.padReferenceTo ?? null;
  const placement = options.referencePlacement ?? { x: 0, y: 0 };
  if (padTo) {
    const placed = placePng(reference, padTo.width, padTo.height, placement.x, placement.y);
    if (!placed) {
      return {
        ok: true, mode: "normalize", indeterminate: true,
        reason: `reference ${croppedDims.width}×${croppedDims.height} placed at (${placement.x}, ${placement.y})`
          + ` does not fit the ${padTo.width}×${padTo.height} canonical canvas`,
        sourceDims, refDims: croppedDims, candDims, cropApplied: cropRect !== null,
        referenceNormalization: { sourceDims, cropApplied: cropRect !== null, croppedDims, padTo, placement },
      };
    }
    reference = placed;
  }
  const refDims = { width: reference.width, height: reference.height };
  const referenceNormalization = {
    sourceDims, cropApplied: cropRect !== null, croppedDims,
    padTo, placement: padTo ? placement : null, refDims,
  };
  const tolerance = options.maxDimensionDeltaPx ?? DEFAULT_MAX_DIMENSION_DELTA_PX;
  const deltaWidth = Math.abs(refDims.width - candDims.width);
  const deltaHeight = Math.abs(refDims.height - candDims.height);
  if (deltaWidth > tolerance || deltaHeight > tolerance) {
    return {
      ok: true, mode: "normalize", indeterminate: true,
      reason: `reference ${refDims.width}×${refDims.height} and candidate ${candDims.width}×${candDims.height} differ by ${deltaWidth}×${deltaHeight}px, beyond the ${tolerance}px pad tolerance`,
      sourceDims, refDims, candDims, cropApplied: cropRect !== null,
      dimensionDelta: { width: deltaWidth, height: deltaHeight, tolerancePx: tolerance },
      referenceNormalization,
    };
  }

  const width = Math.max(refDims.width, candDims.width);
  const height = Math.max(refDims.height, candDims.height);
  const paddedRef = padPng(reference, width, height);
  const paddedCand = padPng(candidate, width, height);
  const total = width * height;

  // Matte — последний шаг нормализации и первый шаг перед метриками (§W4 T4a): обе картинки, один
  // цвет, один проход. Порядок `crop → place/pad → matte → метрики` фиксирован именно здесь.
  const matte = parseMatte(options.matte);
  if (matte) {
    matteOver(paddedRef.data, total, matte);
    matteOver(paddedCand.data, total, matte);
  }

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

  // Edge-сигнал в режиме нормализации — **только** под флагом волны (R7a, opt-in): при
  // выключенном флаге результат воркера обязан быть доволновым байт-в-байт, иначе evidence
  // приёмки менялся бы без решения о включении.
  const edgeResidual = signalsV2Requested(options)
    ? edgeResidualOf(
      exactDiffMaskOf(paddedRef.data, paddedCand.data, total).mask,
      edgeMaskOf(paddedRef.data, width, height, options.edgeOptions),
      total, total,
    )
    : null;

  return {
    ok: true,
    mode: "normalize",
    indeterminate: false,
    sourceDims,
    refDims,
    candDims,
    cropApplied: cropRect !== null,
    referenceNormalization,
    canvas: { width, height },
    padded: { reference: refDims.width !== width || refDims.height !== height, candidate: candDims.width !== width || candDims.height !== height },
    metrics: {
      rawDiffPct: round4((rawPixels / total) * 100),
      aaDiffPct: round4((aaPixels / total) * 100),
      rawDiffPixels: rawPixels,
      aaDiffPixels: aaPixels,
      totalPixels: total,
      maxChannelDelta,
      channelStats: channelStatsOf(paddedRef.data, paddedCand.data, mask, total),
      regions,
      totalRegions,
      bestOffset: bestOffsetOf(paddedRef.data, paddedCand.data, width, height, {
        ...(options.offsetWindow === undefined ? {} : { window: options.offsetWindow }),
      }),
      thresholds: { raw: rawThreshold, aa: aaThreshold },
      ...(edgeResidual === null ? {} : { edgeResidual }),
      // Факт матирования — в метриках, а не только в задании: по нему потребитель отличает
      // «альфа совпала» от «альфы больше нет вовсе» (обесточенный `alpha-compositing`, §W4-4).
      // Условный ключ: без matte результат воркера обязан остаться доволновым байт-в-байт.
      ...(matte ? { matteApplied: matte.hex } : {}),
    },
    diffPngBase64: PNG.sync.write(diff).toString("base64"),
    normalizedCandidatePngBase64: PNG.sync.write(paddedCand).toString("base64"),
    // Дериват эталона отдаётся, когда сервер действительно **строил** эталон: собрал канву
    // (`padTo`) либо матировал его (§W4-5). Для legacy-пути без обоих лишний PNG-энкод на случай —
    // чистая цена без читателя (D13: доволновое поведение).
    ...(padTo || matte ? { normalizedReferencePngBase64: PNG.sync.write(paddedRef).toString("base64") } : {}),
  };
}

/** Запрошен ли edge-сигнал: явная опция задания сильнее env-флага процесса. */
function signalsV2Requested(options) {
  if (options?.edge === true) return true;
  if (options?.edge === false) return false;
  return process.env.EASYUI_VISUAL_SIGNALS_V2 === "1";
}

// ---------------------------------------------------------------------------
// Режим `signals` (план renderer-contract-2 §3 **E6**, §5 **R7a**).
//
// Разделение метрик. До волны визуальный ран судился одним числом — процентом pixelmatch, — и
// это число отвечало сразу на два вопроса («изменился ли рендер» и «изменился ли продукт»),
// то есть ни на один. Здесь их четыре, и каждый отвечает за своё:
//
//   dims       — сводимы ли кадры вообще (`equal` / `normalized` / `irreconcilable`);
//   exact      — отличается ли хоть один байт (exact-rgba, без порогов);
//   perceptual — pixelmatch с порогом рана (историческая метрика, она же вердикт бюджета);
//   edge       — где лежит остаток: на контурах эталона или вне их.
//
// Нормализация размеров переиспользует `padPng` из W5a: кадры разных габаритов в пределах
// допуска сводятся к общему холсту (`dims: "normalized"`), за допуском — `irreconcilable`
// **без метрик** (у `indeterminate` не бывает процента).
//
// Метрики для классификатора причин (`regions`/`channelStats`/`bestOffset`) считаются здесь же и
// по тем же порогам, что в режиме `normalize`: иначе одна и та же причина называлась бы
// по-разному на двух путях.
// ---------------------------------------------------------------------------
export function compareWithSignals(referencePng, candidatePng, options = {}) {
  const reference = PNG.sync.read(referencePng);
  const candidate = PNG.sync.read(candidatePng);
  const refDims = { width: reference.width, height: reference.height };
  const candDims = { width: candidate.width, height: candidate.height };
  const equal = refDims.width === candDims.width && refDims.height === candDims.height;

  if (!equal) {
    const tolerance = options.maxDimensionDeltaPx ?? DEFAULT_MAX_DIMENSION_DELTA_PX;
    const deltaWidth = Math.abs(refDims.width - candDims.width);
    const deltaHeight = Math.abs(refDims.height - candDims.height);
    if (deltaWidth > tolerance || deltaHeight > tolerance) {
      return {
        ok: true, mode: "signals", dims: "irreconcilable", indeterminate: true,
        reason: `reference ${refDims.width}×${refDims.height} and candidate ${candDims.width}×${candDims.height} differ by ${deltaWidth}×${deltaHeight}px, beyond the ${tolerance}px pad tolerance`,
        refDims, candDims,
        dimensionDelta: { width: deltaWidth, height: deltaHeight, tolerancePx: tolerance },
      };
    }
  }

  const width = Math.max(refDims.width, candDims.width);
  const height = Math.max(refDims.height, candDims.height);
  const paddedRef = padPng(reference, width, height);
  const paddedCand = padPng(candidate, width, height);
  const total = width * height;

  const threshold = typeof options.threshold === "number" ? options.threshold : 0.1;
  const includeAA = options.includeAA === true;

  const diffPng = new PNG({ width, height });
  const perceptualPixels = pixelmatch(paddedRef.data, paddedCand.data, diffPng.data, width, height, { threshold, includeAA });
  const exact = exactDiffMaskOf(paddedRef.data, paddedCand.data, total);

  // Маска причин здесь — **exact-rgba**, а не порог pixelmatch (в отличие от режима `normalize`,
  // где опорной метрикой случая объявлен `rawDiffPct`). Причина — факт калибровки R7a: смена
  // заливки `#f2f1f0 → #e8f0ff` на половине холста даёт `rawDiffPct` **0 %** по pixelmatch и
  // 52 % по exact. Судить такой ран порогом pixelmatch значило бы не увидеть регрессию вовсе,
  // а объяснять причину по пустой маске — молчать о ней. `aaDiffPct` при этом остаётся
  // перцептивной метрикой рана, поэтому пара (raw, aa) сохраняет смысл «весь остаток / то, что
  // от него видно глазу».
  const mask = exact.mask;
  const deltas = new Uint16Array(total);
  let maxChannelDelta = 0;
  for (let index = 0; index < total; index += 1) {
    const delta = pixelDelta(paddedRef.data, paddedCand.data, index * 4);
    deltas[index] = delta;
    if (delta > maxChannelDelta) maxChannelDelta = delta;
  }
  const { regions, totalRegions } = diffRegions(mask, width, height, deltas, total, options.maxRegions ?? MAX_REGIONS);
  const edge = edgeMaskOf(paddedRef.data, width, height, options.edgeOptions);

  return {
    ok: true,
    mode: "signals",
    dims: equal ? "equal" : "normalized",
    indeterminate: false,
    refDims, candDims,
    canvas: { width, height },
    padded: { reference: refDims.width !== width || refDims.height !== height, candidate: candDims.width !== width || candDims.height !== height },
    exact: { diffPixels: exact.diffPixels, totalPixels: total },
    pixelmatch: { diffPixels: perceptualPixels, totalPixels: total, options: { threshold, includeAA } },
    edgeResidual: edgeResidualOf(exact.mask, edge, total, total),
    metrics: {
      rawDiffPct: round4((exact.diffPixels / total) * 100),
      aaDiffPct: round4((perceptualPixels / total) * 100),
      rawDiffPixels: exact.diffPixels,
      aaDiffPixels: perceptualPixels,
      totalPixels: total,
      maxChannelDelta,
      channelStats: channelStatsOf(paddedRef.data, paddedCand.data, mask, total),
      regions,
      totalRegions,
      bestOffset: bestOffsetOf(paddedRef.data, paddedCand.data, width, height, {
        ...(options.offsetWindow === undefined ? {} : { window: options.offsetWindow }),
      }),
      // `raw: 0` — у exact-rgba порога нет вовсе (маска «отличается хоть чем-то»).
      thresholds: { raw: 0, aa: threshold },
    },
    diffPngBase64: PNG.sync.write(diffPng).toString("base64"),
  };
}

const MODES = { normalize: normalizeAndCompare, signals: compareWithSignals };

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  readStdin()
    .then((job) => (MODES[job.mode] ?? compare)(
      Buffer.from(job.referencePngBase64, "base64"), Buffer.from(job.candidatePngBase64, "base64"), job.options))
    .then((result) => { process.stdout.write(JSON.stringify(result) + "\n"); process.exit(0); })
    .catch((error) => { process.stdout.write(JSON.stringify({ ok: false, error: error?.message ?? String(error) }) + "\n"); process.exit(1); });
}
