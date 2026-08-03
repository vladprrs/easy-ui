import { expect, test } from "bun:test";
import pngjs from "pngjs";
import { inkBounds } from "../scripts/ink-bbox-worker.mjs";
import { spawnInkBboxWorker } from "./acceptance/inkBbox";

/**
 * ink-bbox (план 2026-08-03 §5 W3): bbox непрозрачных пикселей paint-кадра.
 *
 * Предмет — два свойства, на которых стоит весь вердикт геометрии: **единицы** (CSS px, деление
 * на `deviceScaleFactor` — иначе dsf=2 даёт ложный overflow ×2) и **`clamped`** (краска упёрлась
 * в край поля ⇒ измерение обрезано холстом, вердикт обязан быть `indeterminate`).
 */

const { PNG } = pngjs;

/** Синтетический кадр: прозрачный холст с непрозрачным прямоугольником. */
function framePng(width: number, height: number, ink: { x: number; y: number; width: number; height: number } | null): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(0);
  if (ink) {
    for (let y = ink.y; y < ink.y + ink.height; y += 1) {
      for (let x = ink.x; x < ink.x + ink.width; x += 1) {
        const offset = (y * width + x) * 4;
        png.data[offset] = 0x11; png.data[offset + 1] = 0x22; png.data[offset + 2] = 0x33; png.data[offset + 3] = 0xff;
      }
    }
  }
  return PNG.sync.write(png);
}

test("ink bbox normalises device pixels into CSS px and reports the ink rectangle", () => {
  const result = inkBounds(framePng(40, 40, { x: 8, y: 12, width: 16, height: 8 }), { deviceScaleFactor: 2 });
  expect(result.ok).toBe(true);
  expect(result.source).toBe("alpha");
  expect(result.pixelBounds).toEqual({ x: 8, y: 12, width: 16, height: 8 });
  // Ровно то деление, ради которого правило записано в D4: PNG px / dsf = CSS px.
  expect(result.bounds).toEqual({ x: 4, y: 6, width: 8, height: 4 });
  expect(result.clamped).toEqual({ left: false, right: false, top: false, bottom: false });

  const atOne = inkBounds(framePng(40, 40, { x: 8, y: 12, width: 16, height: 8 }), { deviceScaleFactor: 1 });
  expect(atOne.bounds).toEqual({ x: 8, y: 12, width: 16, height: 8 });
});

test("ink touching the canvas edge is reported as clamped, and an empty frame has no bounds", () => {
  const bleeding = inkBounds(framePng(20, 20, { x: 0, y: 5, width: 20, height: 5 }), { deviceScaleFactor: 1 });
  expect(bleeding.clamped).toMatchObject({ left: true, right: true, top: false, bottom: false });

  const empty = inkBounds(framePng(20, 20, null), { deviceScaleFactor: 2 });
  expect(empty.bounds).toBeNull();
  expect(empty.pixelBounds).toBeNull();
  expect(empty.clamped).toEqual({ left: false, right: false, top: false, bottom: false });
});

test("the spawned node worker returns the same measurement over stdin/stdout", async () => {
  const png = framePng(32, 32, { x: 4, y: 4, width: 8, height: 8 });
  const result = await spawnInkBboxWorker({ pngBase64: png.toString("base64"), options: { deviceScaleFactor: 2 } });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(result.bounds).toEqual({ x: 2, y: 2, width: 4, height: 4 });
  expect(result.image).toEqual({ width: 32, height: 32 });
});

test("a garbage payload fails loudly instead of inventing a bounding box", async () => {
  const result = await spawnInkBboxWorker({ pngBase64: Buffer.from("not a png").toString("base64"), options: { deviceScaleFactor: 1 } });
  expect(result.ok).toBe(false);
});
