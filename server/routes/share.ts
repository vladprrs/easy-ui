import type { Database } from "bun:sqlite";
import { z } from "zod";
import { createShareRequestSchema, parseWith } from "../contracts";
import { ApiError, json, noStore, readJson } from "../http";
import { MAX_SHARE_TTL_SECONDS, MIN_SHARE_TTL_SECONDS, SHARE_COOKIE, ShareRepo } from "../share/repo";
import type { Principal } from "../auth";
import { requirePrototypeOwner } from "../authorization";
import { writeAuditEvent } from "../audit";

export const shareResponseHeaders = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  vary: "Cookie",
} as const;

export function protectShareResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  const vary = headers.get("vary");
  if (!vary?.split(",").some((value) => value.trim().toLowerCase() === "cookie")) {
    headers.set("vary", vary ? `${vary}, Cookie` : "Cookie");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function shareCookie(session: string, secure: boolean): string {
  return `${SHARE_COOKIE}=${session}; HttpOnly; SameSite=Lax; Path=/${secure ? "; Secure" : ""}`;
}

export async function exchangeShareToken(
  request: Request,
  token: string,
  repo: ShareRepo,
  publicOrigin: URL,
): Promise<Response> {
  if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Method not allowed");
  const exchanged = repo.exchange(token);
  const mobileValues = new URL(request.url).searchParams.getAll("mobile");
  let location = exchanged.location;
  if (mobileValues.length === 1 && (mobileValues[0] === "0" || mobileValues[0] === "1")) {
    let locationWasAbsolute = true;
    try {
      new URL(location);
    } catch {
      locationWasAbsolute = false;
    }
    const locationUrl = new URL(location, publicOrigin.origin);
    locationUrl.searchParams.set("mobile", mobileValues[0]);
    location = locationWasAbsolute ? locationUrl.toString() : `${locationUrl.pathname}${locationUrl.search}`;
  }
  return new Response(null, {
    status: 303,
    headers: {
      ...shareResponseHeaders,
      location,
      "set-cookie": shareCookie(exchanged.session, publicOrigin.protocol === "https:"),
    },
  });
}

const shareIdSchema = z.string().regex(/^share_[0-9a-f-]{36}$/);

/** Owner-only routes; main.ts invokes this only after the BasicAuth gate. */
export async function routeShares(
  request: Request,
  db: Database,
  segments: string[],
  principal: Principal,
  options: { publicOrigin: URL; serveDist?: string },
): Promise<Response | null> {
  if (segments[0] !== "prototypes" || segments[2] !== "share") return null;
  const prototypeId = segments[1];
  if (!prototypeId) return null;
  const actor = requirePrototypeOwner(db, prototypeId, principal);
  const repo = new ShareRepo(db, options);
  if (segments.length === 3) {
    if (request.method === "GET") return json({ shares: repo.list(prototypeId) }, 200, noStore);
    if (request.method === "POST") {
      const input = parseWith(createShareRequestSchema, await readJson(request));
      const result=repo.create(prototypeId, input.version, input.ttlSeconds); writeAuditEvent(db,{actorId:actor.userId,action:"share.created",subjectType:"prototype",subjectId:prototypeId,detail:{grantId:result.id,version:result.version}}); return json(result, 201, noStore);
    }
    throw new ApiError(405, "method_not_allowed", "Method not allowed");
  }
  if (segments.length === 4) {
    if (request.method !== "DELETE") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    const grantId = parseWith(shareIdSchema, segments[3], "Share id is invalid");
    repo.revoke(prototypeId, grantId);
    writeAuditEvent(db,{actorId:actor.userId,action:"share.revoked",subjectType:"prototype",subjectId:prototypeId,detail:{grantId}});
    return new Response(null, { status: 204, headers: noStore });
  }
  return null;
}

export { MIN_SHARE_TTL_SECONDS, MAX_SHARE_TTL_SECONDS };
