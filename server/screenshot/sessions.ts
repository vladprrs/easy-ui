import { randomBytes } from "node:crypto";
import type { CaptureExpected } from "../../src/capture/protocol";

export type CaptureKind = "prototype" | "component";

export interface CaptureSession {
  token: string;
  kind: CaptureKind;
  /** Exact immutable snapshot of allowed decoded paths (exact or trailing-slash prefix). */
  allowedUrls: string[];
  expected: CaptureExpected;
  props?: Record<string, unknown>;
  expiresAt: number;
}

/** All loopback forms Bun's `server.requestIP()` may report. */
export function isLoopbackAddress(address: string | undefined | null): boolean {
  if (!address) return false;
  if (address === "::1" || address === "::ffff:127.0.0.1") return true;
  if (address.startsWith("127.")) return true;
  if (address.startsWith("::ffff:127.")) return true;
  return false;
}

/**
 * Path allowlist match. An entry ending in `/` is a directory prefix (static
 * assets / fonts); every other entry is an exact decoded path. Never allow a
 * bare `/` prefix (it would match everything).
 */
export function matchAllowed(path: string, allowedUrls: readonly string[]): boolean {
  for (const entry of allowedUrls) {
    if (entry === path) return true;
    if (entry.length > 1 && entry.endsWith("/") && path.startsWith(entry)) return true;
  }
  return false;
}

/** Job hard deadline (ms) plus the extra token lifetime beyond it. */
export const JOB_DEADLINE_MS = 60_000;
const TOKEN_TTL_MS = JOB_DEADLINE_MS + 30_000;

export class CaptureSessionStore {
  private readonly sessions = new Map<string, CaptureSession>();
  constructor(private readonly now: () => number = Date.now) {}

  mint(data: { kind: CaptureKind; allowedUrls: string[]; expected: CaptureExpected; props?: Record<string, unknown> }): CaptureSession {
    const token = randomBytes(32).toString("hex");
    const session: CaptureSession = { token, ...data, expiresAt: this.now() + TOKEN_TTL_MS };
    this.sessions.set(token, session);
    return session;
  }

  /** Authorizes a loopback GET/HEAD request bearing a live token for an allowed path. */
  authorize(input: { token: string | null; address: string | undefined | null; method: string; path: string }): boolean {
    if (!input.token) return false;
    const session = this.sessions.get(input.token);
    if (!session) return false;
    if (session.expiresAt <= this.now()) { this.sessions.delete(input.token); return false; }
    if (!isLoopbackAddress(input.address)) return false;
    if (input.method !== "GET" && input.method !== "HEAD") return false;
    return matchAllowed(input.path, session.allowedUrls);
  }

  get(token: string): CaptureSession | undefined { return this.sessions.get(token); }
  revoke(token: string): void { this.sessions.delete(token); }
  sweep(): void { const t = this.now(); for (const [token, s] of this.sessions) if (s.expiresAt <= t) this.sessions.delete(token); }
}
