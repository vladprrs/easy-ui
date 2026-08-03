// Ink-bbox worker: one PNG per process, JSON over stdin -> single JSON line on
// stdout. Runs under node with pngjs (bun is the server runtime, but the image
// subprocesses are node — canon: scripts/visual-diff-worker.mjs).
//
// Задача одна: найти bounding box **непрозрачных** пикселей кадра, снятого в режиме
// `probe:"paint"` (прозрачная поверхность + маргин-поле вокруг компонента). Это и есть
// `paintBounds` контракта геометрии 2.0 (план 2026-08-03 §3 D4).
//
// Два свойства, которые обязаны держаться именно здесь:
//   * **CSS px, а не device px** — координаты делятся на `deviceScaleFactor` (триаж R1-M2:
//     иначе dsf=2 давал бы ложный overflow ×2). Пиксельные значения тоже возвращаются
//     (`pixelBounds`) — как доказательство, а не как контракт.
//   * **`clamped`** — чернила упёрлись в край изображения, то есть маргин-поле оказалось мало
//     и bbox обрезан холстом. Вызывающий обязан отдать `indeterminate`, а не вердикт.
/* global process, Buffer */
import pngjs from "pngjs";

const { PNG } = pngjs;

/** Порог альфы: всё, что не полностью прозрачно, считается краской. */
export const DEFAULT_ALPHA_THRESHOLD = 0;

/**
 * bbox непрозрачных пикселей. Возвращает `null` в `bounds`, если краски нет вовсе — пустой кадр
 * не имеет контура, и выдумывать его нельзя (`indeterminate` решает вызывающий).
 */
export function inkBounds(pngBuffer, options = {}) {
  const png = PNG.sync.read(pngBuffer);
  const dsf = typeof options.deviceScaleFactor === "number" && options.deviceScaleFactor > 0 ? options.deviceScaleFactor : 1;
  const threshold = typeof options.alphaThreshold === "number" ? options.alphaThreshold : DEFAULT_ALPHA_THRESHOLD;
  const { width, height, data } = png;
  let minX = width; let minY = height; let maxX = -1; let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      if (data[row + x * 4 + 3] <= threshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const round = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
  if (maxX < 0) {
    return {
      ok: true, source: "alpha", image: { width, height }, deviceScaleFactor: dsf,
      pixelBounds: null, bounds: null,
      clamped: { left: false, right: false, top: false, bottom: false },
      opaquePixels: 0,
    };
  }
  const pixelBounds = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  return {
    ok: true,
    source: "alpha",
    image: { width, height },
    deviceScaleFactor: dsf,
    pixelBounds,
    // CSS px относительно левого верхнего угла снятой поверхности — та же система координат,
    // в которой капчур отдаёт `layoutBounds`.
    bounds: {
      x: round(pixelBounds.x / dsf), y: round(pixelBounds.y / dsf),
      width: round(pixelBounds.width / dsf), height: round(pixelBounds.height / dsf),
    },
    clamped: {
      left: minX === 0, top: minY === 0,
      right: maxX === width - 1, bottom: maxY === height - 1,
    },
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
    .then((job) => inkBounds(Buffer.from(job.pngBase64, "base64"), job.options ?? {}))
    .then((result) => { process.stdout.write(JSON.stringify(result) + "\n"); process.exit(0); })
    .catch((error) => { process.stdout.write(JSON.stringify({ ok: false, error: error?.message ?? String(error) }) + "\n"); process.exit(1); });
}
