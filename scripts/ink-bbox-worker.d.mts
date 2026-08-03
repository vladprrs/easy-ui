/** Типы ink-bbox-воркера (план 2026-08-03 §5 W3); реализация — `ink-bbox-worker.mjs` (node + pngjs). */
export interface InkBboxRect { x: number; y: number; width: number; height: number }
export interface InkBboxClamp { left: boolean; right: boolean; top: boolean; bottom: boolean }
export interface InkBboxMeasurement {
  ok: true;
  source: "alpha";
  image: { width: number; height: number };
  deviceScaleFactor: number;
  /** bbox в пикселях PNG — доказательство измерения. */
  pixelBounds: InkBboxRect | null;
  /** bbox в **CSS px** (пиксели поделены на `deviceScaleFactor`) — контракт политики. */
  bounds: InkBboxRect | null;
  /** Чернила упёрлись в край кадра: измерение обрезано холстом, а не компонентом. */
  clamped: InkBboxClamp;
  opaquePixels?: number;
}
export const DEFAULT_ALPHA_THRESHOLD: number;
export function inkBounds(
  pngBuffer: Uint8Array,
  options?: { deviceScaleFactor?: number; alphaThreshold?: number },
): InkBboxMeasurement;
