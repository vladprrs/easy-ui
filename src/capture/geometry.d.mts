export interface GeometryLayoutContext {
  display: string;
  flexDirection: string;
  flexWrap: string;
  rowGap: string;
  columnGap: string;
}
export interface GeometryRect {
  key: string;
  instance: number;
  parentKey?: string;
  parentInstance?: number;
  domIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  hidden?: true;
  layoutContext: GeometryLayoutContext | null;
}
export type GeometryRole = "panel" | "frame" | "region:header" | "region:footer" | "region:statusBar";
export interface GeometryBox { x: number; y: number; width: number; height: number }
export interface GeometryRoleRect extends GeometryBox { source: "key" | "selector" | "surface"; key?: string }
export interface GeometrySafeArea { top: number; right: number; bottom: number; left: number }
export interface GeometryOwner { role: GeometryRole; areaPct: number; heightPct: number }
export interface GeometryViewportOwnership {
  frame: { width: number; height: number } | null;
  content: { width: number; height: number } | null;
  scroll: { width: number; height: number } | null;
  scrollable: boolean;
  owners: GeometryOwner[];
  unownedPct: number;
}
export interface GeometryIssue {
  code: "content-clipped-by-frame" | "overlapping-regions" | "footer-owns-page";
  severity: "warn";
  message: string;
  detail: Record<string, unknown>;
}
/**
 * Атрибуция источника, красящего за пределами своей in-flow border-box (план W3): потомок с
 * `filter`/`box-shadow`/`outline`/`transform` либо выпавший из потока (`position:absolute|fixed`).
 */
export interface GeometryEffectSource {
  /** Ключ ближайшего маркера-владельца (`data-eui-key`); пустая строка — элемент вне маркеров. */
  elementKey: string;
  elementPath: string;
  /** `filter:blur(68px)`, `box-shadow:…`, `position:absolute`, `transform:…`, `outline:…`. */
  cause: string;
  rect: GeometryBox;
}
/** Звено цепочки клипа: предок с `overflow:hidden|clip` или `clip-path`. */
export interface GeometryClipLink {
  key: string;
  elementPath: string;
  property: "overflow" | "clip-path";
  value: string;
  /** Клип реально режет объединение layout-боксов и источников эффектов. */
  effective: boolean;
  rect: GeometryBox;
}
/** Детальное измерение одного маркера: честный layout-контур + причины выхода краски за него. */
export interface GeometryDetail {
  key: string;
  instance: number;
  /**
   * Union border-box'ов **in-flow** потомков в CSS px относительно поверхности.
   *
   * С `GEOMETRY_CONTRACT_VERSION = 2` (W2) в union входят также живые текстовые узлы in-flow
   * элементов, а каждый бокс пересекается со стеком клипающих предков внутри поддерева маркера.
   */
  layoutBounds: GeometryBox | null;
  effectSources: GeometryEffectSource[];
  clipChain: GeometryClipLink[];
  /**
   * `"overlay"` — корнем измерения стала контентная обёртка host-примитива `Overlay`
   * (`[data-eui-overlay-content]`, план 2026-08-06 §W5 T5c.3). Поле присутствует только на этой
   * ветке: у обычного маркерного корня его нет вовсе.
   */
  rootSource?: "overlay";
}
/** Raw browser-side measurements; `analyzeGeometry` derives ownership and issues from them. */
export interface GeometryMeasurements {
  rects: GeometryRect[];
  truncated: boolean;
  total: number;
  safeArea: GeometrySafeArea;
  roleRects: Partial<Record<GeometryRole, GeometryRoleRect>>;
  frame: GeometryRoleRect;
  content: GeometryBox;
  scroll: { width: number; height: number };
  /** Присутствует только когда запрошен `detailKeys` (режим `probe:"paint"`, W3). */
  details?: GeometryDetail[];
  detailKeys?: string[];
}
export interface GeometryCollection extends GeometryMeasurements {
  viewportOwnership: GeometryViewportOwnership;
  issues: GeometryIssue[];
}
/**
 * Версия семантики измерения `layoutBounds` (план 2026-08-06 §1.3). Кадровый вход
 * `frameFingerprint`: смена значения инвалидирует накопленные кадры.
 */
export const GEOMETRY_CONTRACT_VERSION: number;
export const GEOMETRY_ROLES: GeometryRole[];
export const FOOTER_OWNERSHIP_RATIO: number;
export function roundCssPx(value: number): number;
export function unionRects(rects: Array<{left:number;top:number;right:number;bottom:number}>): {left:number;top:number;right:number;bottom:number;width:number;height:number}|null;
export function rectIntersection(a: GeometryBox | null | undefined, b: GeometryBox | null | undefined): GeometryBox | null;
export function unionArea(rects: Array<GeometryBox | null | undefined>): number;
export function analyzeGeometry(input?: {
  frame?: GeometryBox | null;
  content?: GeometryBox | null;
  scroll?: { width: number; height: number } | null;
  roleRects?: Partial<Record<GeometryRole, GeometryBox>>;
}): {
  viewportOwnership: GeometryViewportOwnership;
  issues: GeometryIssue[];
};
export function collectGeometry(options?: {
  limit?: number;
  roleKeys?: Partial<Record<GeometryRole, string>>;
  /** ≤20 ключей маркеров для детального измерения; пустой массив — корневой маркер (W3). */
  detailKeys?: string[];
  /**
   * Искать layout-корень среди `[data-eui-overlay-content]` (W5, viewport-поверхность). Выключено
   * — сбор ведёт себя ровно как до волны; включено и оверлей ровно один — корнем становится он.
   */
  overlayAwareRoot?: boolean;
}): GeometryMeasurements;
