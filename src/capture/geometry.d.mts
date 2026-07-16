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
export interface GeometryCollection { rects: GeometryRect[]; truncated: boolean; total: number }
export function roundCssPx(value: number): number;
export function unionRects(rects: Array<{left:number;top:number;right:number;bottom:number}>): {left:number;top:number;right:number;bottom:number;width:number;height:number}|null;
export function collectGeometry(options?: {limit?:number}): GeometryCollection;
