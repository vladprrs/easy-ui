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
  /** Разбиение остатка по edge-маске эталона (R7a). */
  interface EdgeResidualStats {
    residualPixels: number; insidePixels: number; outsidePixels: number;
    insidePct: number | null;
    edgePixels: number; edgeCoveragePct: number;
    sobelThreshold: number; dilationPx: number;
  }
  interface NormalizedMetrics {
    rawDiffPct: number; aaDiffPct: number;
    edgeResidual?: EdgeResidualStats;
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
    /** §W4: цвет применённого matte; ключа нет вовсе, если матирования не было. */
    matteApplied?: string;
  }
  interface NormalizeIndeterminate {
    ok: true; mode: "normalize"; indeterminate: true; reason: string;
    sourceDims: Dims; refDims: Dims; candDims: Dims; cropApplied: boolean;
    dimensionDelta?: { width: number; height: number; tolerancePx: number };
  }
  interface ReferenceNormalizationFacts {
    sourceDims: Dims; cropApplied: boolean; croppedDims: Dims;
    padTo: Dims | null; placement: { x: number; y: number } | null; refDims?: Dims;
  }
  interface NormalizeMeasured {
    ok: true; mode: "normalize"; indeterminate: false;
    sourceDims: Dims; refDims: Dims; candDims: Dims; cropApplied: boolean;
    canvas: Dims; padded: { reference: boolean; candidate: boolean };
    metrics: NormalizedMetrics;
    diffPngBase64: string;
    normalizedCandidatePngBase64: string;
    referenceNormalization?: ReferenceNormalizationFacts;
    /** Дериват эталона: сервер строил канву (`padReferenceTo`) либо матировал (§W4). */
    normalizedReferencePngBase64?: string;
  }
  export function normalizeAndCompare(
    referencePng: Uint8Array | Buffer,
    candidatePng: Uint8Array | Buffer,
    options?: {
      cropRect?: [number, number, number, number] | number[];
      /** W5: объявленная сервером каноническая канва и место эталона в ней. */
      padReferenceTo?: Dims; referencePlacement?: { x: number; y: number };
      /** §W4: matte сравнения — `"none"` либо `"#RRGGBB"`; применяется после placement/pad. */
      matte?: string;
      maxDimensionDeltaPx?: number; rawThreshold?: number; aaThreshold?: number;
      maxRegions?: number; offsetWindow?: number;
      /** R7a: считать edge-сигнал явно (`true`/`false` сильнее env-флага `EASYUI_VISUAL_SIGNALS_V2`). */
      edge?: boolean;
      edgeOptions?: { sobelThreshold?: number; dilation?: number };
    },
  ): NormalizeIndeterminate | NormalizeMeasured;
  /** Режим `signals` (план renderer-contract-2 §3 E6, §5 R7a). */
  interface SignalsIndeterminate {
    ok: true; mode: "signals"; dims: "irreconcilable"; indeterminate: true; reason: string;
    refDims: Dims; candDims: Dims;
    dimensionDelta: { width: number; height: number; tolerancePx: number };
  }
  interface SignalsMeasured {
    ok: true; mode: "signals"; dims: "equal" | "normalized"; indeterminate: false;
    refDims: Dims; candDims: Dims; canvas: Dims; padded: { reference: boolean; candidate: boolean };
    exact: { diffPixels: number; totalPixels: number };
    pixelmatch: { diffPixels: number; totalPixels: number; options: { threshold: number; includeAA: boolean } };
    edgeResidual: EdgeResidualStats;
    metrics: NormalizedMetrics;
    diffPngBase64: string;
  }
  export function compareWithSignals(
    referencePng: Uint8Array | Buffer,
    candidatePng: Uint8Array | Buffer,
    options?: {
      threshold?: number; includeAA?: boolean; maxDimensionDeltaPx?: number;
      maxRegions?: number; offsetWindow?: number;
      edgeOptions?: { sobelThreshold?: number; dilation?: number };
    },
  ): SignalsIndeterminate | SignalsMeasured;
  export function edgeMaskOf(
    data: Uint8Array | Buffer, width: number, height: number,
    options?: { sobelThreshold?: number; dilation?: number },
  ): { mask: Uint8Array; edgePixels: number; sobelThreshold: number; dilationPx: number };
  export function exactDiffMaskOf(
    refData: Uint8Array | Buffer, candData: Uint8Array | Buffer, total: number,
  ): { mask: Uint8Array; diffPixels: number };
  export function edgeResidualOf(
    diffMask: Uint8Array, edge: { mask: Uint8Array; edgePixels: number; sobelThreshold: number; dilationPx: number },
    total: number, canvasPixels: number,
  ): EdgeResidualStats;
  export function luminanceOf(data: Uint8Array | Buffer, total: number): Float32Array;
  export const EDGE_SOBEL_THRESHOLD: number;
  export const EDGE_DILATION_PX: number;
  export const EDGE_RESIDUAL_MIN_PCT: number;
  export const RAW_THRESHOLD: number;
  export const AA_THRESHOLD: number;
  export const DEFAULT_MAX_DIMENSION_DELTA_PX: number;
  export const OFFSET_WINDOW_PX: number;
  export const MAX_REGIONS: number;
  export function cropPng(png: unknown, rect: number[]): unknown;
  export function padPng(png: unknown, width: number, height: number): unknown;
  export function placePng(png: unknown, width: number, height: number, x: number, y: number): unknown;
  /** §W4: разбор объявленного matte (`"none"`/мусор → `null`) и композитинг над ним. */
  export function parseMatte(value: unknown): { r: number; g: number; b: number; hex: string } | null;
  export function matteOver(
    data: Uint8Array | Buffer, total: number, color: { r: number; g: number; b: number },
  ): Uint8Array | Buffer;
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
