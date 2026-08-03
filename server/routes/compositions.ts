import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { CompositionDoc } from "../../src/prototype/composition";
import { hostPrimitiveNames } from "../../src/catalog/hostPrimitives/definitions";
import { ApiError, immutable, json, noStore, readJson } from "../http";
import { CompositionRepo, safeParseCompositionDocument } from "../repos/compositions";
import { requireActiveDesignSystem } from "../designSystems";
import { requireResourceOwner, requireUser } from "../authorization";
import { writeAuditEvent } from "../audit";
import type { Principal } from "../auth";

/**
 * REST-поверхность версионированных композиций (волна 5 §5.4).
 * Зеркалит роуты компонентов: та же авторизация, тот же CAS по `baseRev`,
 * те же коды ошибок и те же audit-события — только артефакт другой (документ, не бандл).
 */

const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const body = (value: unknown) => {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  if (!parsed.success) throw new ApiError(400, "invalid_request", "Request body must be an object");
  return parsed.data;
};
const int = (value: unknown, name: string) => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new ApiError(400, "invalid_request", `${name} must be a positive integer`);
  return value;
};
const baseRevOf = (input: Record<string, unknown>) => {
  if (!Object.hasOwn(input, "baseRev")) throw new ApiError(400, "base_rev_required", "baseRev is required");
  return int(input.baseRev, "baseRev");
};
const text = (value: unknown, name: string, required = true) => {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") throw new ApiError(400, "invalid_request", `${name} must be a string`);
  return value;
};

/**
 * Kill-switch D9 (план 2026-08-03 §3): **запись** композиций `version: 3` требует
 * `EASYUI_COMPOSITION_V3=1`. Env читается на запросе — как `surfacesWriteEnabled` (D16):
 * оператор включает флаг в Dokploy без пересборки образа. Чтение и **раскрытие** уже
 * сохранённых v3-документов работает всегда: после первой v3-записи откат образа
 * невозможен без чистки данных, поэтому обратный путь не должен зависеть от флага.
 */
export const compositionV3WriteEnabled = (raw: string | undefined = process.env.EASYUI_COMPOSITION_V3): boolean => raw === "1";

function parseDoc(value: unknown): CompositionDoc {
  const parsed = safeParseCompositionDocument(value);
  if (!parsed.success) throw new ApiError(422, "validation_failed", "Composition document is invalid", { issues: parsed.error.issues });
  if (parsed.data.version === 3 && !compositionV3WriteEnabled()) {
    throw new ApiError(422, "composition_v3_disabled", "Composition v3 documents are disabled on this server (EASYUI_COMPOSITION_V3)", {
      issues: [{ path: ["doc", "version"], message: "composition version 3 requires EASYUI_COMPOSITION_V3=1 on the server" }],
    });
  }
  // CompositionRepo keeps the historical v1 type surface for the rest of the server. v2 is
  // structurally identical at the persistence boundary and is discriminated at publish time.
  return parsed.data as CompositionDoc;
}

/**
 * Каждый тип элемента композиции обязан быть host-примитивом или **опубликованным**
 * компонентом этой дизайн-системы: иначе раскрытие в save-пути прототипа не найдёт пин.
 */
function assertKnownTypes(db: Database, doc: CompositionDoc, designSystem: string): void {
  const types = [...new Set(Object.values(doc.spec.elements).map((element) => element.type))].filter((type) => !hostPrimitiveNames.has(type));
  const unknown = types.filter((type) => !db.query(`SELECT 1 ok FROM components c
    JOIN component_publishes cp ON cp.component_id=c.id AND cp.status='active'
    JOIN component_revisions cr ON cr.component_id=cp.component_id AND cr.rev=cp.rev
    WHERE c.name=? AND cr.design_system=? AND c.deleted_at IS NULL LIMIT 1`).get(type, designSystem));
  if (unknown.length) {
    throw new ApiError(422, "validation_failed", "Composition document is invalid", {
      issues: unknown.map((type) => ({ path: ["spec", "elements"], message: `Unknown or unpublished component type in design system '${designSystem}': ${type}` })),
    });
  }
}

export async function routeCompositions(request: Request, db: Database, segments: string[], principal: Principal): Promise<Response> {
  const repo = new CompositionRepo(db);
  const url = new URL(request.url);
  const includeDeleted = url.searchParams.get("includeDeleted") === "1";

  if (segments.length === 1) {
    if (request.method === "GET") return json(repo.list(includeDeleted), 200, noStore);
    if (request.method === "POST") {
      const actor = requireUser(principal);
      const input = body(await readJson(request));
      for (const key of Object.keys(input)) if (!["id", "doc", "designSystem", "message"].includes(key)) throw new ApiError(400, "invalid_request", `Unknown field: ${key}`);
      const id = text(input.id, "id")!;
      if (!slug.test(id)) throw new ApiError(422, "validation_failed", "Composition is invalid", { issues: [{ path: ["id"], message: "id must be a slug" }] });
      const designSystem = text(input.designSystem, "designSystem")!;
      requireActiveDesignSystem(db, designSystem, ["designSystem"]);
      requireResourceOwner(db, "design_systems", designSystem, principal);
      const doc = parseDoc(input.doc);
      assertKnownTypes(db, doc, designSystem);
      const result = repo.create(id, doc, designSystem, text(input.message, "message", false), actor.userId);
      writeAuditEvent(db, { actorId: actor.userId, action: "composition.revision.saved", subjectType: "composition", subjectId: id, detail: { rev: 1 } });
      return json(result, 201, { ...noStore, location: `/api/compositions/${encodeURIComponent(id)}` });
    }
    throw new ApiError(405, "method_not_allowed", "Method not allowed");
  }

  const id = segments[1]!, tail = segments.slice(2);
  if (!tail.length) {
    if (request.method === "GET") return json(repo.meta(id, includeDeleted), 200, noStore);
    if (request.method === "PUT") {
      const actor = requireResourceOwner(db, "compositions", id, principal);
      const input = body(await readJson(request));
      const base = baseRevOf(input);
      const doc = parseDoc(input.doc);
      assertKnownTypes(db, doc, repo.row(id).design_system);
      const result = repo.save(id, doc, base, text(input.message, "message", false), actor.userId);
      writeAuditEvent(db, { actorId: actor.userId, action: "composition.revision.saved", subjectType: "composition", subjectId: id, detail: { rev: result.rev } });
      return json(result, 200, noStore);
    }
    if (request.method === "DELETE") {
      const actor = requireResourceOwner(db, "compositions", id, principal);
      const input = body(await readJson(request));
      const base = baseRevOf(input);
      if (input.force !== undefined && typeof input.force !== "boolean") throw new ApiError(400, "invalid_request", "force must be a boolean");
      // Композиция, живущая в головных ревизиях, не удаляется молча — по образцу компонентов.
      const usages = repo.usages(id);
      if (usages.currentHeadUsages.length) {
        if (input.force !== true) throw new ApiError(409, "composition_in_use", "Composition is used by head revisions of prototypes", { usages });
        if (!actor.isAdmin) throw new ApiError(403, "admin_required", "Only an admin may force-delete a composition that is still in use");
      }
      repo.delete(id, base, text(input.reason, "reason", false));
      writeAuditEvent(db, { actorId: actor.userId, action: "composition.deleted", subjectType: "composition", subjectId: id, detail: { forced: input.force === true, headUsages: usages.currentHeadUsages.length } });
      return new Response(null, { status: 204, headers: noStore });
    }
    throw new ApiError(405, "method_not_allowed", "Method not allowed");
  }

  if (tail[0] === "usages" && tail.length === 1) {
    if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    return json(repo.usages(id), 200, noStore);
  }
  if (tail[0] === "revisions") {
    if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    if (tail.length === 1) return json(repo.revisions(id), 200, noStore);
    if (tail.length === 2) return json(repo.revision(id, int(Number(tail[1]), "rev")), 200, noStore);
  }
  if (tail[0] === "publish" && tail.length === 1) {
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    const actor = requireResourceOwner(db, "compositions", id, principal);
    const input = body(await readJson(request));
    const result = repo.publish(id, baseRevOf(input), text(input.message, "message", false));
    writeAuditEvent(db, { actorId: actor.userId, action: "composition.version.published", subjectType: "composition", subjectId: id, detail: { version: result.version } });
    return json(result, 201, { ...noStore, location: `/api/compositions/${encodeURIComponent(id)}/versions/${result.version}` });
  }
  if (tail[0] === "versions") {
    if (tail.length === 3 && tail[2] === "status") {
      if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Method not allowed");
      const actor = requireResourceOwner(db, "compositions", id, principal);
      const version = int(Number(tail[1]), "version");
      const input = body(await readJson(request));
      if (!Object.hasOwn(input, "baseStatusRev")) throw new ApiError(400, "invalid_request", "baseStatusRev is required");
      const supersededBy = input.supersededBy === undefined ? undefined : int(input.supersededBy, "supersededBy");
      const result = repo.setStatus(id, version, { status: text(input.status, "status")!, reason: text(input.reason, "reason", false), supersededBy, baseStatusRev: int(input.baseStatusRev, "baseStatusRev") });
      writeAuditEvent(db, { actorId: actor.userId, action: "composition.status.changed", subjectType: "composition", subjectId: id, detail: { version, ...result } });
      return json(result, 200, noStore);
    }
    if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    if (tail.length === 1) return json(repo.versions(id), 200, noStore);
    if (tail.length === 2) return json(repo.version(id, int(Number(tail[1]), "version")), 200, immutable);
  }
  throw new ApiError(404, "not_found", "API route not found");
}
