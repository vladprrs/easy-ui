// Ambient types for the long-lived pool worker script (план §5 R9a). Как и strict-воркер, это
// standalone `.mjs` под node; серверные тесты импортируют из него только чистые хелперы.
declare module "*/screenshot-pool-worker.mjs" {
  export const POOL_DEFAULTS: Readonly<{ maxJobs: number; ttlMs: number; rssLimitMb: number }>;
  export interface PoolLimits { maxJobs: number; ttlMs: number; rssLimitMb: number }
  export function poolLimits(env?: Record<string, string | undefined>): PoolLimits;
  export function launchKeyOf(job: { captureOrigin: string; determinismArgs?: readonly string[] }): string;
  export interface PoolRecycleState {
    browserAlive: boolean; launchKey: string | null; requestedKey?: string;
    jobs: number; startedAt: number; rssMb: number | null; lastJobOk: boolean;
  }
  export function recycleReason(state: PoolRecycleState, limits: PoolLimits, now: number):
    "origin_changed" | "job_failed" | "job_budget" | "ttl" | "rss" | null;
  export function treeRssMb(rootPid?: number): Promise<number | null>;
  /** W2: тот же производный потолок handshake'а, что и у per-job воркера (зеркало). */
  export function handshakeTimeoutMs(job: { bootstrap?: { readiness?: { timeoutMs?: number } } } | undefined): number;
}
