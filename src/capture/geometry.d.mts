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
}
export interface GeometryCollection extends GeometryMeasurements {
  viewportOwnership: GeometryViewportOwnership;
  issues: GeometryIssue[];
}
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
export function collectGeometry(options?: {limit?:number; roleKeys?: Partial<Record<GeometryRole, string>>}): GeometryMeasurements;
