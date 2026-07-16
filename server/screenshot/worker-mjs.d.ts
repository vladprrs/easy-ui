// Ambient types for the untyped node worker script, so server tests can import
// its pure helpers (the worker itself is a standalone .mjs run under node).
declare module "*/screenshot-worker.mjs" {
  export function buildLaunchArgs(denyPort: number, capturePort: string | number): string[];
  export function matchAllowed(path: string, allowedUrls: readonly string[]): boolean;
  export function canonicalStringify(value: unknown): string;
  export function readyToExpected(ready: Record<string, unknown>): Record<string, unknown>;
}

declare module "*/geometry.mjs" {
  export interface GeometryLayoutContext { display:string; flexDirection:string; flexWrap:string; rowGap:string; columnGap:string }
  export interface GeometryRect { key:string; instance:number; parentKey?:string; parentInstance?:number; domIndex:number; x:number; y:number; width:number; height:number; hidden?:true; layoutContext:GeometryLayoutContext|null }
  export interface GeometryCollection { rects:GeometryRect[]; truncated:boolean; total:number }
  export function unionRects(rects:Array<{left:number;top:number;right:number;bottom:number}>):{left:number;top:number;right:number;bottom:number;width:number;height:number}|null;
  export function collectGeometry(options?:{limit?:number}):GeometryCollection;
}
