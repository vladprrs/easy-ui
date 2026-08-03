// Ambient types for the untyped client-side response cache of the authoring skill
// (`.claude/skills/author/cache.mjs`, план 2026-08-03 §5 W7), so server tests can import it.
declare module "*/author/cache.mjs" {
  export const CACHE_SCHEMA: string;
  export const TERMINAL_RUN_STATUSES: ReadonlySet<string>;
  export const FRESH_TTL_MS: number;
  export function canonicalJson(value: unknown): string;
  export function identityHash(baseUrl: string, user?: string | null): string;
  export function sortedQuery(search?: string): [string, string][];
  export function requestKey(input: {
    identity: string;
    method: string;
    path: string;
    query: readonly (readonly [string, string])[];
    bodyHash?: string | null;
    apiVersion: string;
  }): string;
  export function safeSegment(value: unknown, label?: string): string;
  export interface DriverCachePolicy {
    kind: "json" | "blob";
    mode: "immutable" | "fresh";
    ttlMs?: number;
    terminalOnly?: boolean;
    learns?: string;
  }
  export function classify(method: string, path: string): DriverCachePolicy | null;
  export function extractFingerprints(body: unknown): Record<string, unknown>;
  export interface DriverCacheSummary {
    status: "hit" | "miss" | "refresh" | "off";
    key?: string;
    reason?: string;
    hits?: number;
    misses?: number;
    refreshes?: number;
    writes?: number;
    dir?: string;
  }
  export interface DriverCacheHit {
    status: number;
    json?: unknown;
    bytes?: Buffer;
    key: string;
    entry: Record<string, unknown>;
  }
  export interface DriverCache {
    enabled: boolean;
    dir: string | null;
    identity?: string;
    apiVersion?: string;
    read(method: string, path: string, body?: unknown): Promise<DriverCacheHit | null>;
    write(
      method: string,
      path: string,
      body: unknown,
      response: { status: number; json?: unknown; bytes?: Uint8Array; etag?: string; contentType?: string },
    ): Promise<void>;
    receipt(verb: string, key: string, payload: Record<string, unknown>): Promise<void>;
    link(record: Record<string, unknown>): Promise<void>;
    learn(body: unknown): Promise<void> | void;
    summary(): DriverCacheSummary;
    line(): string;
    clear?(): Promise<void>;
  }
  export function nullCache(reason?: string): DriverCache;
  export function openCache(options: {
    dir?: string | null;
    baseUrl: string;
    user?: string | null;
    refresh?: boolean;
    refreshReason?: string;
    disabled?: boolean;
    disabledReason?: string;
    now?: () => number;
  }): Promise<DriverCache>;
}
