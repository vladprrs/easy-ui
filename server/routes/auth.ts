import type { Database } from "bun:sqlite";
import type { Principal } from "../auth";
import { loginRequestSchema, parseWith } from "../contracts";
import { ApiError, json, noStore, readJson } from "../http";
import { clearSessionCookie, readSessionCookie, serializeSessionCookie, UserRepo } from "../users";

const DUMMY_PASSWORD_HASH = await Bun.password.hash("easy-ui-dummy-password-for-constant-work", "argon2id");
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 5;
const MAX_ADDRESS_ATTEMPTS = 30;

export class LoginRateLimiter {
  private attempts = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now) {}
  consume(key: string, limit = MAX_ATTEMPTS): void {
    const cutoff = this.now() - WINDOW_MS;
    const current = (this.attempts.get(key) ?? []).filter((at) => at > cutoff);
    if (current.length >= limit) throw new ApiError(429, "rate_limited", "Too many login attempts");
    current.push(this.now());
    this.attempts.set(key, current);
  }
}

export function validateNext(next: string | undefined, origin: URL): string | undefined {
  if (next === undefined) return undefined;
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\")) throw new ApiError(422, "validation_failed", "next must be a same-origin relative path", { issues: [{ path: ["next"], message: "must be a same-origin relative path" }] });
  const resolved = new URL(next, origin);
  if (resolved.origin !== origin.origin) throw new ApiError(422, "validation_failed", "next must be a same-origin relative path", { issues: [{ path: ["next"], message: "must be a same-origin relative path" }] });
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

export async function routeAuth(
  request: Request,
  db: Database,
  segments: string[],
  context: { principal: Principal; publicOrigin: URL; clientAddress: string; limiter: LoginRateLimiter },
): Promise<Response | null> {
  if (segments[0] !== "auth" || segments.length !== 2) return null;
  const secure = context.publicOrigin.protocol === "https:";
  if (segments[1] === "login") {
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    const input = parseWith(loginRequestSchema, await readJson(request));
    const next = validateNext(input.next, context.publicOrigin);
    context.limiter.consume(`address\0${context.clientAddress}`, MAX_ADDRESS_ATTEMPTS);
    context.limiter.consume(`account\0${context.clientAddress}\0${input.name.toLocaleLowerCase("en-US")}`);
    const repo = new UserRepo(db);
    const user = await repo.verify(input.name, input.password, DUMMY_PASSWORD_HASH);
    if (!user) throw new ApiError(401, "invalid_credentials", "Invalid name or password");
    const session = repo.createSession(user.id);
    return json({ user: { userId: user.id, name: user.name, isAdmin: user.isAdmin }, ...(next ? { next } : {}) }, 200, { ...noStore, "set-cookie": serializeSessionCookie(session.token, secure) });
  }
  if (segments[1] === "logout") {
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    const raw = readSessionCookie(request, secure);
    if (raw) new UserRepo(db).revokeSession(raw);
    return new Response(null, { status: 204, headers: { ...noStore, "set-cookie": clearSessionCookie(secure) } });
  }
  if (segments[1] === "me") {
    if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    if (context.principal.kind !== "user") throw new ApiError(401, "unauthorized", "Authentication required");
    return json({ userId: context.principal.userId, name: context.principal.name, isAdmin: context.principal.isAdmin }, 200, noStore);
  }
  return null;
}
