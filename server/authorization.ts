import type { Database } from "bun:sqlite";
import type { Principal, UserPrincipal } from "./auth";
import { ApiError } from "./http";

/**
 * `adminRead` — админ видит любой прототип (план 2026-08-05 «Admin visibility», T2).
 * Признак сознательно отделён от `owner`: чтение расширяется, мутации (`requirePrototypeOwner`)
 * и owner-only поля ответа (figma, экспорт черновика) остаются за настоящим владельцем.
 */
export type PrototypeAccess = { ownerId: string | null; status: "private" | "published" | "archived"; owner: boolean; scoped: boolean; adminRead: boolean };

export function requireUser(principal: Principal): UserPrincipal {
  if (principal.kind !== "user") throw new ApiError(403, "forbidden", "This operation requires a user account");
  return principal;
}

export function prototypeAccess(db: Database, id: string, principal: Principal): PrototypeAccess {
  const row = db.query("SELECT owner_id ownerId,status FROM prototypes WHERE id=?").get(id) as { ownerId: string | null; status: PrototypeAccess["status"] } | null;
  if (!row) throw new ApiError(404, "prototype_not_found", "Prototype not found");
  const owner = principal.kind === "user" && (principal.userId === row.ownerId || (principal.isAdmin && row.ownerId===null));
  const scoped = (principal.kind === "share" && principal.scope.prototypeId === id) || principal.kind === "capture";
  const adminRead = principal.kind === "user" && principal.isAdmin;
  return { ownerId: row.ownerId, status: row.status, owner, scoped, adminRead };
}

export function requirePrototypeRead(db: Database, id: string, principal: Principal): PrototypeAccess {
  const access = prototypeAccess(db, id, principal);
  if (!access.owner && !access.scoped && !access.adminRead && access.status !== "published") throw new ApiError(404, "prototype_not_found", "Prototype not found");
  return access;
}

export function requirePrototypeOwner(db: Database, id: string, principal: Principal): UserPrincipal {
  const access = prototypeAccess(db, id, principal);
  if (access.owner && principal.kind === "user") return principal;
  if (access.status === "published" || access.scoped) throw new ApiError(403, "forbidden", "Only the prototype owner may perform this operation");
  throw new ApiError(404, "prototype_not_found", "Prototype not found");
}

const RESOURCE_LABEL: Record<ResourceTable, string> = { components: "Component", design_systems: "Design system", compositions: "Composition" };
/** Таблицы ресурсов с колонкой owner_id (волна 5 добавила `compositions`). */
export type ResourceTable = "components" | "design_systems" | "compositions";

export function resourceOwner(db: Database, table: ResourceTable, id: string): string {
  const row = db.query(`SELECT owner_id ownerId FROM ${table} WHERE id=?`).get(id) as { ownerId: string | null } | null;
  if (!row || !row.ownerId) throw new ApiError(404, "not_found", `${RESOURCE_LABEL[table]} not found`);
  return row.ownerId;
}

export function requireResourceOwner(db: Database, table: ResourceTable, id: string, principal: Principal): UserPrincipal {
  const user = requireUser(principal);
  if (!user.isAdmin && resourceOwner(db, table, id) !== user.userId) throw new ApiError(403, "forbidden", "Only the resource owner may perform this operation");
  return user;
}
