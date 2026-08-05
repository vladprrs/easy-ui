/**
 * HTTP-поверхность case-set-манифестов (план `docs/plans/2026-08-03-family-acceptance-and-composition-v3.md`
 * §5 W2, амендмент A2; RFC §3.3/§4.2).
 *
 * ```
 * PUT  /api/components/:id/case-sets     — валидация + идемпотентная публикация манифеста
 * POST /api/components/:id/case-sets/validate — те же проверки без записи (dry-run, W6)
 * GET  /api/case-sets/:caseSetId         — манифест + метаданные строки
 * GET  /api/case-sets/:caseSetId/coverage — покрытие измерений семьи
 * ```
 *
 * Границы — те же, что у acceptance-роутов (`routes/acceptance.ts`), и по тем же причинам:
 *
 * - **Гейт всего набора** — наличие оркестратора (`EASYUI_ACCEPTANCE_MATRIX=1`); флаг выключен →
 *   ручек нет вовсе (404). Ветвление по env внутри роута запрещено: два источника истины.
 * - **Авторизация**: `requireUser` + владелец компонента (или админ); `share`/`capture`-принципалы
 *   получают 403 всегда — иначе анонимный барьер `createHandler` открыл бы чужие матрицы.
 * - **Форма `caseSetId` проверяется до lookup'а**: произвольная строка иначе отличала бы «нет
 *   строки» от «не тот формат» и давала бы оракул по чужим наборам.
 * - **PUT, а не POST**: публикация манифеста идемпотентна по построению (контентный адрес), и
 *   повтор обязан возвращать тот же `caseSetId`, а не плодить строки.
 */
import type { Database } from "bun:sqlite";
import { isCaseSetId } from "../../src/acceptance/caseSetSchema";
import type { Principal } from "../auth";
import { requireResourceOwner, requireUser } from "../authorization";
import { ApiError, json, noStore, readJson } from "../http";
import { ComponentRepo } from "../repos/components";
import type { AcceptanceOrchestrator } from "../acceptance/orchestrator";
import {
  buildCasesFromManifest, CaseSetRepo, caseSetIdOf, coverageOf, manifestOfRow, validateManifest, type CaseSetRow,
} from "../acceptance/caseSets";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function caseSetView(row: CaseSetRow): Record<string, unknown> {
  return {
    caseSetId: row.case_set_id,
    componentId: row.component_id,
    designSystem: row.design_system,
    caseCount: row.case_count,
    source: row.source_file_key === null ? null : {
      fileKey: row.source_file_key,
      componentSetNodeId: row.source_node_id,
    },
    createdBy: row.created_by,
    createdAt: row.created_at,
    manifest: JSON.parse(row.manifest_json),
  };
}

async function putCaseSet(request: Request, db: Database, componentId: string, principal: Principal): Promise<Response> {
  if (request.method !== "PUT") throw new ApiError(405, "method_not_allowed", "Method not allowed");
  const actor = requireResourceOwner(db, "components", componentId, principal);
  const body = await readJson(request);
  if (!isObject(body)) throw new ApiError(400, "invalid_request", "Request body must be an object");
  for (const key of Object.keys(body)) {
    if (key !== "manifest") throw new ApiError(400, "invalid_request", `Unknown field: ${key}`);
  }
  if (body.manifest === undefined) throw new ApiError(400, "invalid_request", "manifest is required");

  const { manifest, warnings } = validateManifest(db, componentId, body.manifest);
  // ДС берётся у компонента, а не из манифеста: манифест описывает случаи, а принадлежность
  // компонента системе — свойство каталога, и дублировать его в клиентском теле нельзя.
  const designSystem = new ComponentRepo(db).row(componentId).design_system;
  const { row, cached } = new CaseSetRepo(db).put({ componentId, designSystem, manifest, createdBy: actor.userId });
  return json({
    caseSetId: row.case_set_id,
    componentId: row.component_id,
    designSystem: row.design_system,
    cases: row.case_count,
    cached,
    coverage: coverageOf(manifest),
    warnings,
  }, 200, noStore);
}

/**
 * Dry-run манифеста (план 2026-08-04 §W6, P1-7): те же проверки, что у PUT, **без записи**.
 *
 * Единственным способом узнать вердикт сервера по манифесту была мутирующая публикация, и автор
 * 49-случайной семьи либо публиковал заведомо черновой набор (плодя `cset_`-строки, на которые
 * потом ссылаются раны), либо угадывал. Ручка отвечает ровно тем же, чем ответил бы PUT, плюс
 * `wouldBeCached` — существует ли такой набор уже (то есть был бы PUT идемпотентным повтором).
 *
 * `cases` здесь — не число, а `{count, ids}`: dry-run обязан показать **набор случаев рана**,
 * который построил бы оркестратор (`buildCasesFromManifest` — тот же код, включая отказ
 * `empty_case_set`), а не только его мощность.
 */
async function validateCaseSet(request: Request, db: Database, componentId: string, principal: Principal): Promise<Response> {
  if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Method not allowed");
  requireResourceOwner(db, "components", componentId, principal);
  const body = await readJson(request);
  if (!isObject(body)) throw new ApiError(400, "invalid_request", "Request body must be an object");
  for (const key of Object.keys(body)) {
    if (key !== "manifest") throw new ApiError(400, "invalid_request", `Unknown field: ${key}`);
  }
  if (body.manifest === undefined) throw new ApiError(400, "invalid_request", "manifest is required");

  const { manifest, warnings } = validateManifest(db, componentId, body.manifest);
  // PUT-parity: тот же `validateManifest` и то же построение набора, что у публикации и старта
  // рана. Плата за расхождение — dry-run, который «проходит», а ран отказывает (или наоборот).
  // T2.1 заменит вызов на `casesOfRun` (разрешение слот-пинов) — контракт ручки от этого не меняется.
  const cases = buildCasesFromManifest(manifest);
  const caseSetId = caseSetIdOf(manifest);
  const frames = cases.filter((item) => item.aliasOfCaseId === null);
  return json({
    caseSetId,
    componentId,
    designSystem: new ComponentRepo(db).row(componentId).design_system,
    cases: { count: cases.length, ids: cases.map((item) => item.caseId) },
    // Кадры набора (план 2026-08-05 §A5): случаи, которые действительно снимаются. Два состояния с
    // одинаковыми props и разным содержимым слотов обязаны быть здесь **двумя** записями — ровно
    // это отличает исправленный дедуп от прежнего схлопывания в один кадр.
    frames: { count: frames.length, ids: frames.map((item) => item.caseId) },
    coverage: coverageOf(manifest),
    warnings,
    // Существование строки — единственное, что отличает dry-run от последующего PUT: набор
    // контентно адресован, поэтому «уже опубликован» — это ответ про кэш, а не про конфликт.
    wouldBeCached: new CaseSetRepo(db).get(caseSetId) !== undefined,
  }, 200, noStore);
}

/** Строка набора + проверка владения компонентом, которому она принадлежит. */
function requireOwnedCaseSet(db: Database, caseSetId: string, principal: Principal): CaseSetRow {
  requireUser(principal);
  if (!isCaseSetId(caseSetId)) throw new ApiError(404, "not_found", "Case set not found");
  const row = new CaseSetRepo(db).require(caseSetId);
  requireResourceOwner(db, "components", row.component_id, principal);
  return row;
}

/**
 * Диспетчер case-set-роутов. `segments` — путь после `/api`. Возвращает `null` для чужих путей;
 * `orchestrator === undefined` означает выключенный `EASYUI_ACCEPTANCE_MATRIX` (404 на весь набор).
 */
export async function routeCaseSets(
  request: Request,
  db: Database,
  segments: string[],
  principal: Principal,
  orchestrator?: AcceptanceOrchestrator,
): Promise<Response | null> {
  const isComponentCaseSets = segments[0] === "components" && segments[2] === "case-sets" && segments.length === 3;
  const isCaseSetValidate = segments[0] === "components" && segments[2] === "case-sets"
    && segments[3] === "validate" && segments.length === 4;
  const isCaseSetRead = segments[0] === "case-sets";
  if (!isComponentCaseSets && !isCaseSetValidate && !isCaseSetRead) return null;
  if (!orchestrator) throw new ApiError(404, "not_found", "Acceptance matrix is disabled");

  if (isCaseSetValidate) return validateCaseSet(request, db, segments[1]!, principal);
  if (isComponentCaseSets) return putCaseSet(request, db, segments[1]!, principal);
  if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Method not allowed");
  if (segments.length === 2) return json(caseSetView(requireOwnedCaseSet(db, segments[1]!, principal)), 200, noStore);
  if (segments.length === 3 && segments[2] === "coverage") {
    const row = requireOwnedCaseSet(db, segments[1]!, principal);
    return json({ caseSetId: row.case_set_id, componentId: row.component_id, ...coverageOf(manifestOfRow(row)) }, 200, noStore);
  }
  throw new ApiError(404, "not_found", "API route not found");
}
