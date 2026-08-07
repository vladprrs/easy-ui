import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  createCompositionTrace, expandCompositions,
  type CompositionCatalogEntry, type CompositionDoc,
} from "../../src/prototype/composition";
import { analyzeComposition } from "../../src/prototype/compositionAnalyze";
import { COMPOSITION_TYPE } from "../../src/catalog/hostPrimitives/composition.definition";
import { hostPrimitiveNames } from "../../src/catalog/hostPrimitives/definitions";
import type { PrototypeDoc } from "../../src/prototype/schema";
import { ApiError, immutable, json, noStore, readJson } from "../http";
import { CompositionRepo, resolveCompositionPins, safeParseCompositionDocument } from "../repos/compositions";
import { componentCanonicalRoles, componentLayoutContracts } from "../validation";
import { componentUsages } from "../usageGraph";
import { requireActiveDesignSystem } from "../designSystems";
import { requireResourceOwner, requireUser } from "../authorization";
import { writeAuditEvent } from "../audit";
import type { Principal } from "../auth";
import { parseCandidateOverlayInput, resolveOverlayMap } from "../acceptance/caseSets";

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

/** Типы элементов тела, которые обязаны быть компонентами ДС (host-примитивы отсеяны). */
function bodyComponentTypes(elements: Record<string, { type?: unknown }>): string[] {
  const types = new Set<string>();
  for (const element of Object.values(elements)) {
    if (typeof element.type !== "string" || !element.type) continue;
    if (hostPrimitiveNames.has(element.type)) continue;
    types.add(element.type);
  }
  return [...types].sort();
}

/** Ссылки на вложенные композиции в теле кандидата. */
function nestedCompositionIds(elements: Record<string, { type?: unknown; props?: unknown }>): string[] {
  const ids = new Set<string>();
  for (const element of Object.values(elements)) {
    if (element.type !== COMPOSITION_TYPE) continue;
    const props = element.props;
    const id = props && typeof props === "object" ? (props as Record<string, unknown>).composition : undefined;
    if (typeof id === "string" && id) ids.add(id);
  }
  return [...ids].sort();
}

/**
 * Импакт зависимостей кандидата — **существующий** usages-механизм, без новых источников:
 * компоненты тела резолвятся по имени в ДС (`componentUsages`), вложенные композиции —
 * `CompositionRepo.usages`. Тип, которого в ДС нет, попадает в `unknownTypes`: это не
 * ошибка анализа (кандидат ещё не сохраняется), но автору её надо видеть.
 */
export function analyzeDependencyImpact(db: Database, repo: CompositionRepo, elements: Record<string, { type?: unknown; props?: unknown }>, designSystem: string) {
  const components: { componentId: string; name: string; headUsageCount: number; immutableUsageCount: number; safeToRemove: boolean }[] = [];
  const unknownTypes: string[] = [];
  for (const type of bodyComponentTypes(elements)) {
    const row = db.query(`SELECT c.id id FROM components c
      JOIN component_publishes cp ON cp.component_id=c.id AND cp.status='active'
      JOIN component_revisions cr ON cr.component_id=cp.component_id AND cr.rev=cp.rev
      WHERE c.name=? AND cr.design_system=? AND c.deleted_at IS NULL LIMIT 1`).get(type, designSystem) as { id: string } | null;
    if (!row) { unknownTypes.push(type); continue; }
    const report = componentUsages(db, row.id);
    components.push({
      componentId: report.componentId, name: report.name,
      headUsageCount: report.currentHeadUsages.length,
      immutableUsageCount: report.immutableUsages.length,
      safeToRemove: report.safeToRemove,
    });
  }
  const compositions: { id: string; headUsageCount: number; immutableUsageCount: number; safeToRemove: boolean }[] = [];
  for (const id of nestedCompositionIds(elements)) {
    try {
      const usages = repo.usages(id);
      compositions.push({
        id, headUsageCount: usages.currentHeadUsages.length,
        immutableUsageCount: usages.immutableUsages.length, safeToRemove: usages.safeToRemove,
      });
    } catch { unknownTypes.push(`${COMPOSITION_TYPE}:${id}`); }
  }
  return { components, compositions, unknownTypes: [...new Set(unknownTypes)].sort() };
}

/** Плоский вид `{root, elements}` одного экрана раскрытого probe-документа. */
const expandedFragment = (doc: PrototypeDoc) => {
  const screen = doc.screens[0]!;
  return { root: screen.spec.root, elements: screen.spec.elements as Record<string, unknown> };
};

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

  /**
   * W8g: анализ композиционного кандидата. Ручка **ничего не пишет**, поэтому она
   * сознательно работает и при выключенном kill-switch `EASYUI_COMPOSITION_V3`: агент
   * обязан уметь спросить «выразимо ли это композицией» до того, как включат запись v3 —
   * иначе выбор «composition vs TSX» пришлось бы делать вслепую. Документ здесь не
   * обязан проходить строгую схему (черновик анализируется как есть).
   *
   * `analyze` — **зарезервированный сегмент**: POST на него не адресует композицию с id
   * `analyze` (её остальные методы и ручки продолжают работать).
   */
  if (segments.length === 2 && segments[1] === "analyze" && request.method === "POST") {
    requireUser(principal);
    const input = body(await readJson(request));
    for (const key of Object.keys(input)) if (!["doc", "designSystem"].includes(key)) throw new ApiError(400, "invalid_request", `Unknown field: ${key}`);
    if (!Object.hasOwn(input, "doc")) throw new ApiError(400, "invalid_request", "doc is required");
    const designSystem = text(input.designSystem, "designSystem", false);
    if (designSystem !== undefined) requireActiveDesignSystem(db, designSystem, ["designSystem"]);
    const analysis = analyzeComposition({
      doc: input.doc,
      context: designSystem === undefined ? undefined : {
        componentRoles: componentCanonicalRoles(db, designSystem),
        componentLayouts: componentLayoutContracts(db, designSystem),
      },
    });
    const spec = (input.doc as { spec?: { elements?: Record<string, { type?: unknown; props?: unknown }> } } | null)?.spec;
    const elements = spec && typeof spec === "object" && spec.elements && typeof spec.elements === "object" ? spec.elements : {};
    return json({
      ...analysis,
      dependencyImpact: designSystem === undefined
        ? { components: [], compositions: [], unknownTypes: [] }
        : analyzeDependencyImpact(db, repo, elements, designSystem),
    }, 200, noStore);
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

  /**
   * W8g: preview-дерево ревизии композиции — **инструментированный прогон того же
   * раскрытия**, что и в save-пути прототипа (`expandCompositions` + trace-коллектор),
   * поэтому показанные ветки/case'ы/клоны — фактические, а не пересчитанные копией логики.
   * Слоты показываются декларативно: точки ссылки у превью нет, детей в слоты класть неоткуда
   * (`validateSlotContract: false`), поэтому `filled` всегда false, а fallback раскрывается.
   * Ручка ничего не пишет и работает независимо от `EASYUI_COMPOSITION_V3`.
   */
  if (tail[0] === "preview-tree" && tail.length === 1) {
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    requireUser(principal);
    const input = body(await readJson(request));
    for (const key of Object.keys(input)) if (!["params", "variant", "rev", "candidateOverlay"].includes(key)) throw new ApiError(400, "invalid_request", `Unknown field: ${key}`);
    const params = input.params === undefined ? {} : input.params;
    if (typeof params !== "object" || params === null || Array.isArray(params)) throw new ApiError(400, "invalid_request", "params must be an object");
    const variant = input.variant;
    if (variant !== undefined) {
      if (typeof variant !== "object" || variant === null || Array.isArray(variant)) throw new ApiError(400, "invalid_request", "variant must be an object");
      for (const [axis, value] of Object.entries(variant)) if (typeof value !== "string") throw new ApiError(400, "invalid_request", `variant.${axis} must be a string`);
    }
    const revision = repo.revision(id, input.rev === undefined ? undefined : int(input.rev, "rev"));
    const designSystem = revision.designSystem;
    // §W3 (план 2026-08-07), диагностическая поверхность: карта overlay резолвится и возвращается
    // **эхом**. Раскрытие композиции она не трогает — приёмочная поверхность графа ровно одна
    // (component case set), а composition-приёмки не существует в принципе (см. changelog).
    const candidateOverlay = input.candidateOverlay === undefined ? null : resolveOverlayMap({
      db, overlay: parseCandidateOverlayInput(input.candidateOverlay), designSystem, mode: "gating",
    });
    const nested = resolveCompositionPins(db, nestedCompositionIds(revision.doc.spec.elements), designSystem);
    const compositions: Record<string, CompositionCatalogEntry> = {
      ...nested.sources,
      // Head-ревизия ещё не опубликована: служебная version 1 нужна лишь трассе/диагностике.
      [id]: { doc: revision.doc, version: 1, designSystem, status: "active" },
    };
    const probe = {
      version: 1, id: "composition-preview", name: "Composition preview", designSystem,
      startScreen: "preview", state: {},
      screens: [{
        id: "preview", name: "Preview",
        spec: {
          root: "host",
          elements: {
            host: {
              type: COMPOSITION_TYPE,
              props: { composition: id, ...(Object.keys(params).length ? { params } : {}), ...(variant === undefined ? {} : { variant }) },
            },
          },
        },
      }],
    } as unknown as PrototypeDoc;
    const { trace, log } = createCompositionTrace();
    const expanded = expandCompositions(probe, {
      compositions, designSystem, trace, validateSlotContract: false,
      componentRoles: componentCanonicalRoles(db, designSystem),
      componentLayouts: componentLayoutContracts(db, designSystem),
    });
    const issues = [
      ...nested.missing.map((entry) => ({ path: ["spec", "elements"], message: entry.reason })),
      ...expanded.issues.map((issue) => ({ path: issue.path.split("/").filter(Boolean), message: issue.message, ...(issue.code ? { code: issue.code } : {}) })),
    ];
    return json({
      compositionId: id, rev: revision.rev, designSystem,
      resolvedParams: log.params.find((event) => event.compositionId === id)?.params ?? {},
      chosenBranches: log.branches.map((event) => ({ elementKey: event.elementKey, compositionId: event.compositionId, when: event.when, taken: event.taken })),
      switches: log.switches.map((event) => ({ elementKey: event.elementKey, prop: event.prop, param: event.param, case: event.case })),
      repeatExpansions: log.repeats.map((event) => ({ elementKey: event.elementKey, param: event.param, count: event.count })),
      slotBindings: log.slots.map((event) => ({ slot: event.slot, compositionId: event.compositionId, required: event.required, filled: event.filled, fallbackUsed: event.fallbackUsed })),
      layoutOwners: log.layouts.map((event) => ({ elementKey: event.elementKey, type: event.type, props: event.props })),
      expandedTree: expandedFragment(expanded.doc),
      ...(candidateOverlay === null ? {} : { candidateOverlay }),
      issues,
    }, 200, noStore);
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
