import { createHash, timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { UserRecord } from "./users";
import { readSessionCookie, UserRepo } from "./users";

export type AnonymousPrincipal = { kind: "anonymous" };
export type UserPrincipal = { kind: "user"; userId: string; name: string; isAdmin: boolean };
export type SharePrincipal = { kind: "share"; scope: { grantId: string; prototypeId: string; version: number; allowedUrls: string[] } };
export type CapturePrincipal = { kind: "capture"; scope: { token: string; allowedUrls: string[] } };
export type Principal = AnonymousPrincipal | UserPrincipal | SharePrincipal | CapturePrincipal;

export const ANONYMOUS: AnonymousPrincipal = Object.freeze({ kind: "anonymous" });

const fromUser = (user: UserRecord): UserPrincipal => ({ kind: "user", userId: user.id, name: user.name, isAdmin: user.isAdmin });

/** Path-aware precedence is applied by passing only scopes that matched this request path. */
export function resolvePrincipal(input: { capture?: CapturePrincipal; share?: SharePrincipal; user?: UserRecord | null }): Principal {
  return input.capture ?? input.share ?? (input.user ? fromUser(input.user) : ANONYMOUS);
}

export function resolveSessionUser(db: Database, request: Request, secure: boolean): UserRecord | null {
  const raw = readSessionCookie(request, secure);
  return raw ? new UserRepo(db).resolveSession(raw) : null;
}

function decodeBasicCredentials(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header);
  if (!match || match[1]!.length % 4 !== 0) return undefined;
  try {
    const bytes = Buffer.from(match[1]!, "base64");
    if (bytes.toString("base64") !== match[1]) return undefined;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch { return undefined; }
}

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

export function isLegacyBasicAuthorized(request: Request, expectedCredentials: string): boolean {
  const received = decodeBasicCredentials(request.headers.get("authorization"));
  return received !== undefined && timingSafeEqual(digest(received), digest(expectedCredentials));
}

export function legacyBasicUnauthorizedResponse(): Response {
  return new Response("Unauthorized", { status: 401, headers: {
    "www-authenticate": 'Basic realm="easy-ui"', "cache-control": "no-store", vary: "Authorization",
  } });
}

export function applicationUnauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: { code: "unauthorized", message: "Authentication required" } }), {
    status: 401,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store", vary: "Cookie" },
  });
}

function addVary(headers: Headers, value: string): void {
  const current = headers.get("vary");
  if (!current?.split(",").some((part) => part.trim().toLowerCase() === value.toLowerCase())) headers.set("vary", current ? `${current}, ${value}` : value);
}

export function protectLegacyBasicResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  addVary(headers, "Authorization");
  const cache = headers.get("cache-control");
  if (cache) headers.set("cache-control", cache.replace(/\bpublic\b/gi, "private"));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function protectSessionResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  addVary(headers, "Cookie");
  headers.set("cache-control", "private, no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
