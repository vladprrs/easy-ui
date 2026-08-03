// Ambient types for the untyped node visual-diff worker and pngjs (no @types),
// so server tests can import the pure helpers. The worker itself runs under node.
declare module "*/visual-diff-worker.mjs" {
  interface DiffOk {
    ok: true;
    dimensionMismatch: boolean;
    refDims: { width: number; height: number };
    candDims: { width: number; height: number };
    exact?: { diffPixels: number; totalPixels: number };
    pixelmatch?: { diffPixels: number; totalPixels: number; options: { threshold: number; includeAA: boolean } };
    diffPngBase64?: string;
  }
  export function compare(referencePng: Uint8Array | Buffer, candidatePng: Uint8Array | Buffer, options?: { threshold?: number; includeAA?: boolean }): DiffOk;
  export function exactRgbaDiff(a: Uint8Array, b: Uint8Array): { diffPixels: number; totalPixels: number };

  /** Режим `normalize` (план 2026-08-03 §5 W5a): crop эталона, pad до общего холста, метрики случая. */
  interface Dims { width: number; height: number }
  interface DiffRegion { bbox: { x: number; y: number; width: number; height: number }; areaPct: number; meanDelta: number }
  interface NormalizedMetrics {
    rawDiffPct: number; aaDiffPct: number;
    rawDiffPixels: number; aaDiffPixels: number; totalPixels: number;
    maxChannelDelta: number;
    channelStats: {
      pixels: number;
      meanDelta: { r: number; g: number; b: number; a: number };
      meanMaxDelta: number; stdMaxDelta: number;
      alphaDominantPct: number; semiTransparentPct: number;
    };
    regions: DiffRegion[]; totalRegions: number;
    bestOffset: { dx: number; dy: number; residualPct: number; sampledPixels: number; step: number };
    thresholds: { raw: number; aa: number };
  }
  interface NormalizeIndeterminate {
    ok: true; mode: "normalize"; indeterminate: true; reason: string;
    sourceDims: Dims; refDims: Dims; candDims: Dims; cropApplied: boolean;
    dimensionDelta?: { width: number; height: number; tolerancePx: number };
  }
  interface NormalizeMeasured {
    ok: true; mode: "normalize"; indeterminate: false;
    sourceDims: Dims; refDims: Dims; candDims: Dims; cropApplied: boolean;
    canvas: Dims; padded: { reference: boolean; candidate: boolean };
    metrics: NormalizedMetrics;
    diffPngBase64: string;
    normalizedCandidatePngBase64: string;
  }
  export function normalizeAndCompare(
    referencePng: Uint8Array | Buffer,
    candidatePng: Uint8Array | Buffer,
    options?: {
      cropRect?: [number, number, number, number] | number[];
      maxDimensionDeltaPx?: number; rawThreshold?: number; aaThreshold?: number;
      maxRegions?: number; offsetWindow?: number;
    },
  ): NormalizeIndeterminate | NormalizeMeasured;
  export const RAW_THRESHOLD: number;
  export const AA_THRESHOLD: number;
  export const DEFAULT_MAX_DIMENSION_DELTA_PX: number;
  export const OFFSET_WINDOW_PX: number;
  export const MAX_REGIONS: number;
  export function cropPng(png: unknown, rect: number[]): unknown;
  export function padPng(png: unknown, width: number, height: number): unknown;
  export function channelStatsOf(
    refData: Uint8Array | Buffer, candData: Uint8Array | Buffer, mask: Uint8Array, total: number,
  ): NormalizedMetrics["channelStats"];
  export function bestOffsetOf(
    refData: Uint8Array | Buffer, candData: Uint8Array | Buffer, width: number, height: number,
    options?: { window?: number; deltaThreshold?: number },
  ): { dx: number; dy: number; residualPct: number; sampledPixels: number; step: number };
}

declare module "pngjs" {
  export class PNG {
    constructor(options?: { width?: number; height?: number });
    width: number;
    height: number;
    data: Buffer;
    static sync: {
      read(buffer: Uint8Array | Buffer): PNG;
      write(png: PNG): Buffer;
    };
  }
  const pngjs: { PNG: typeof PNG };
  export default pngjs;
}
