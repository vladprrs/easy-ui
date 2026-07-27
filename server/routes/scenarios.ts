import type { Database } from "bun:sqlite";
import { z } from "zod";
import { scenarioIdSchema, scenarioInputSchema, type ScenarioInput } from "../../src/prototype/scenario";
import { ApiError, json, noStore, readJson } from "../http";
import { ScenarioRepo } from "../repos/scenarios";
import { requirePrototypeOwner, requirePrototypeRead } from "../authorization";
import { writeAuditEvent } from "../audit";
import type { Principal } from "../auth";

/**
 * REST-поверхность сценариев прототипа (волна 6 §«Волна 6»).
 *
 * Живёт под `/api/prototypes/{id}/scenarios`, но отдельным модулем: авторизация
 * зеркалит остальные подроуты прототипа (чтение — `requirePrototypeRead`, запись —
 * `requirePrototypeOwner`), а тела валидируются zod-контрактом из `src/prototype/scenario.ts`.
 *
 * Прогонов здесь нет сознательно: раннер клиентский (`src/player/scenarioRunner.ts`),
 * серверный headless-replay вырезан триажем ревью плана.
 */

const objectBody = (value: unknown): Record<string, unknown> => {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  if (!parsed.success) throw new ApiError(400, "invalid_request", "Request body must be an object");
  return parsed.data;
};

function parseInput(body: Record<string, unknown>): ScenarioInput {
  // `id` живёт в теле POST рядом с payload сценария, но самой схемой не описан.
  const rest = Object.fromEntries(Object.entries(body).filter(([key]) => key !== "id"));
  const parsed = scenarioInputSchema.safeParse(rest);
  if (!parsed.success) throw new ApiError(422, "validation_failed", "Scenario is invalid", { issues: parsed.error.issues });
  return parsed.data;
}

function parseId(value: unknown): string {
  if (value === undefined) return `scenario-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const parsed = scenarioIdSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(422, "validation_failed", "Scenario is invalid", { issues: [{ path: ["id"], message: "id must be a slug of at most 64 characters" }] });
  return parsed.data;
}

/** Диспетчер `/api/prototypes/{id}/scenarios[/{scenarioId}]`; для прочих путей возвращает null. */
export async function routeScenarios(request: Request, db: Database, segments: string[], principal: Principal): Promise<Response | null> {
  if (segments[0] !== "prototypes" || segments[2] !== "scenarios") return null;
  const prototypeId = segments[1]!;
  const scenarioId = segments[3];
  if (segments.length > 4) throw new ApiError(404, "not_found", "API route not found");
  const repo = new ScenarioRepo(db);

  if (scenarioId === undefined) {
    if (request.method === "GET") {
      requirePrototypeRead(db, prototypeId, principal);
      return json({ scenarios: repo.list(prototypeId) }, 200, noStore);
    }
    if (request.method === "POST") {
      const actor = requirePrototypeOwner(db, prototypeId, principal);
      const body = objectBody(await readJson(request));
      const id = parseId(body.id);
      const scenario = repo.create(prototypeId, id, parseInput(body), actor.userId);
      writeAuditEvent(db, { actorId: actor.userId, action: "prototype.scenario.saved", subjectType: "prototype", subjectId: prototypeId, detail: { scenarioId: id, steps: scenario.steps.length } });
      return json(scenario, 201, { ...noStore, location: `/api/prototypes/${encodeURIComponent(prototypeId)}/scenarios/${encodeURIComponent(id)}` });
    }
    throw new ApiError(405, "method_not_allowed", "Method not allowed");
  }

  if (request.method === "GET") {
    requirePrototypeRead(db, prototypeId, principal);
    return json(repo.get(prototypeId, scenarioId), 200, noStore);
  }
  if (request.method === "PUT") {
    const actor = requirePrototypeOwner(db, prototypeId, principal);
    const scenario = repo.update(prototypeId, scenarioId, parseInput(objectBody(await readJson(request))));
    writeAuditEvent(db, { actorId: actor.userId, action: "prototype.scenario.saved", subjectType: "prototype", subjectId: prototypeId, detail: { scenarioId, steps: scenario.steps.length } });
    return json(scenario, 200, noStore);
  }
  if (request.method === "DELETE") {
    const actor = requirePrototypeOwner(db, prototypeId, principal);
    repo.delete(prototypeId, scenarioId);
    writeAuditEvent(db, { actorId: actor.userId, action: "prototype.scenario.deleted", subjectType: "prototype", subjectId: prototypeId, detail: { scenarioId } });
    return new Response(null, { status: 204, headers: noStore });
  }
  throw new ApiError(405, "method_not_allowed", "Method not allowed");
}
