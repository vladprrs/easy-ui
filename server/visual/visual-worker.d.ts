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
  /** BR-07: узел карты элементов в координатах канвы диффа (device px). */
  interface AttributionNode {
    key: string; path: string; markerKey: string; componentId: string | null;
    depth: number; hasText: boolean; ownership: "subject" | "dependency";
    x: number; y: number; width: number; height: number;
  }
  interface AttributionRegionFact {
    index: number;
    ownerElementKey: string | null; ownerMarkerKey: string | null; ownerPath: string | null;
    ownerDepth: number | null; ownerHasText: boolean; ownerComponentId: string | null;
    mismatchedPixels: number; unknownPixels: number;
    edgeInsidePixels: number; edgeOutsidePixels: number; alphaDominantPixels: number;
    meanMaxDelta: number; maxChannelDelta: number;
  }
  interface AttributionTotals {
    owners: { elementKey: string; markerKey: string | null; componentId: string | null; depth: number; mismatchedPixels: number }[];
    attributedPixels: number; unknownPixels: number; totalMismatchedPixels: number;
    coveragePct: number | null;
    dependencyPixels: number;
    dependencyByMarker: { markerKey: string; componentId: string | null; pixels: number }[];
    regions: AttributionRegionFact[];
    truncated?: boolean;
    ownership?: {
      subjectRawDiffPixels: number; dependencyRawDiffPixels: number;
      subjectAaDiffPixels: number; dependencyAaDiffPixels: number;
      byDependency: { markerKey: string; componentId: string | null; pixels: number }[];
    };
  }
  interface NormalizedMetrics {
    rawDiffPct: number; aaDiffPct: number;
    /** BR-07: атрибуция расхождения по карте элементов (условное поле). */
    attribution?: AttributionTotals;
    /** BR-04: тот же остаток по **поверхности сравнения** (`layoutRoot × dsf`), а не по канве с полем. */
    rawDiffPctOfSurface?: number; aaDiffPctOfSurface?: number; surfacePixels?: number;
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
  interface CandidateNormalizationFacts {
    sourceDims: Dims; window: { x: number; y: number; width: number; height: number }; dims: Dims;
  }
  interface NormalizeIndeterminate {
    ok: true; mode: "normalize"; indeterminate: true; reason: string;
    sourceDims: Dims; refDims: Dims; candDims: Dims; cropApplied: boolean;
    dimensionDelta?: { width: number; height: number; tolerancePx: number };
    /** BR-02: окно кандидатского растра, приведшее кадр к канве сравнения. */
    candidateNormalization?: CandidateNormalizationFacts;
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
    /** BR-02: окно кандидатского растра, приведшее кадр к канве сравнения. */
    candidateNormalization?: CandidateNormalizationFacts;
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
      /** BR-02: окно кандидатского растра в его же координатах (crop при `x,y ≥ 0`, pad при отрицательных). */
      candidateWindow?: { x: number; y: number; width: number; height: number };
      /** BR-04: при объявленной канве требовать **точного** совпадения размеров (delta 0). */
      exactCanvas?: boolean;
      /** BR-04: поверхность сравнения в device px — знаменатель `rawDiffPctOfSurface`. */
      surfaceDims?: Dims;
      /** §W4: matte сравнения — `"none"` либо `"#RRGGBB"`; применяется после placement/pad. */
      matte?: string;
      maxDimensionDeltaPx?: number; rawThreshold?: number; aaThreshold?: number;
      maxRegions?: number; offsetWindow?: number;
      /** R7a: считать edge-сигнал явно (`true`/`false` сильнее env-флага `EASYUI_VISUAL_SIGNALS_V2`). */
      edge?: boolean;
      /** BR-07/BR-08: карта элементов в координатах канвы + просьба посчитать владение. */
      attribution?: { nodes: AttributionNode[]; truncated?: boolean; ownership?: boolean };
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
  /** BR-07: атрибуция полной diff-маски по карте элементов (per-pixel owner-растр не строится). */
  export function attributeMask(input: {
    mask: Uint8Array; width: number; height: number; nodes: AttributionNode[];
    regionSeeds?: number[]; edgeMask?: Uint8Array | null;
    refData?: Uint8Array | Buffer | null; candData?: Uint8Array | Buffer | null; deltas?: Uint16Array | null;
  }): AttributionTotals;
  export function nodeRowIndex(nodes: AttributionNode[], width: number, height: number): (number[] | null)[];
  export function ownerAt(rows: (number[] | null)[], nodes: AttributionNode[], x: number, y: number): number;
  export const ATTRIBUTION_MAX_NODES: number;
  export function cropPng(png: unknown, rect: number[]): unknown;
  export function padPng(png: unknown, width: number, height: number): unknown;
  export function placePng(png: unknown, width: number, height: number, x: number, y: number): unknown;
  /** BR-02: окно кандидатского растра (crop/pad одной операцией). */
  export function windowPng(png: unknown, x: number, y: number, width: number, height: number): unknown;
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
