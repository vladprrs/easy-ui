// Ambient types for the untyped node worker script, so server tests can import
// its pure helpers (the worker itself is a standalone .mjs run under node).
declare module "*/screenshot-worker.mjs" {
  export function buildLaunchArgs(denyPort: number, capturePort: string | number): string[];
  export function matchAllowed(path: string, allowedUrls: readonly string[]): boolean;
  export function canonicalStringify(value: unknown): string;
}
