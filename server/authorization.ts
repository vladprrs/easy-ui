import type { Database } from "bun:sqlite";
import type { Principal, UserPrincipal } from "./auth";
import { ApiError } from "./http";

export type PrototypeAccess = { ownerId: string | null; status: "private" | "published" | "archived"; owner: boolean; scoped: boolean };

export function requireUser(principal: Principal): UserPrincipal {
  if (principal.kind !== "user") throw new ApiError(403, "forbidden", "This operation requires a user account");
  return principal;
}

export function prototypeAccess(db: Database, id: string, principal: Principal): PrototypeAccess {
  const row = db.query("SELECT owner_id ownerId,status FROM prototypes WHERE id=?").get(id) as { ownerId: string | null; status: PrototypeAccess["status"] } | null;
  if (!row) throw new ApiError(404, "prototype_not_found", "Prototype not found");
  const owner = principal.kind === "user" && (principal.userId === row.ownerId || (principal.isAdmin && row.ownerId===null));
  const scoped = (principal.kind === "share" && principal.scope.prototypeId === id) || principal.kind === "capture";
  return { ownerId: row.ownerId, status: row.status, owner, scoped };
}

export function requirePrototypeRead(db: Database, id: string, principal: Principal): PrototypeAccess {
  const access = prototypeAccess(db, id, principal);
  if (!access.owner && !access.scoped && access.status !== "published") throw new ApiError(404, "prototype_not_found", "Prototype not found");
  return access;
}

export function requirePrototypeOwner(db: Database, id: string, principal: Principal): UserPrincipal {
  const access = prototypeAccess(db, id, principal);
  if (access.owner && principal.kind === "user") return principal;
  if (access.status === "published" || access.scoped) throw new ApiError(403, "forbidden", "Only the prototype owner may perform this operation");
  throw new ApiError(404, "prototype_not_found", "Prototype not found");
}

export function resourceOwner(db: Database, table: "components" | "design_systems", id: string): string {
  const row = db.query(`SELECT owner_id ownerId FROM ${table} WHERE id=?`).get(id) as { ownerId: string | null } | null;
  if (!row || !row.ownerId) throw new ApiError(404, "not_found", table === "components" ? "Component not found" : "Design system not found");
  return row.ownerId;
}

export function requireResourceOwner(db: Database, table: "components" | "design_systems", id: string, principal: Principal): UserPrincipal {
  const user = requireUser(principal);
  if (!user.isAdmin && resourceOwner(db, table, id) !== user.userId) throw new ApiError(403, "forbidden", "Only the resource owner may perform this operation");
  return user;
}
