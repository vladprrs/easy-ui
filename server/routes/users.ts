import type { Database } from "bun:sqlite";
import type { Principal } from "../auth";
import { createUserRequestSchema, parseWith, updateUserRequestSchema } from "../contracts";
import { ApiError, json, noStore, readJson } from "../http";
import { UserRepo } from "../users";

export async function routeUsers(request: Request, db: Database, segments: string[], principal: Principal): Promise<Response | null> {
  if (segments[0] !== "users" || segments.length > 2) return null;
  if (principal.kind !== "user") throw new ApiError(401, "unauthorized", "Authentication required");
  if (!principal.isAdmin) throw new ApiError(403, "forbidden", "Administrator access required");
  const repo = new UserRepo(db);
  if (segments.length === 2) {
    if (request.method !== "PATCH") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    const input = parseWith(updateUserRequestSchema, await readJson(request));
    return json(repo.setAdmin({ id: segments[1], isAdmin: input.isAdmin, actorId: principal.userId }), 200, noStore);
  }
  if (request.method === "GET") return json({ users: repo.list() }, 200, noStore);
  if (request.method === "POST") {
    const input = parseWith(createUserRequestSchema, await readJson(request));
    return json(await repo.create({ ...input, actorId: principal.userId }), 201, noStore);
  }
  throw new ApiError(405, "method_not_allowed", "Method not allowed");
}
