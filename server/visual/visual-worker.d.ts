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
