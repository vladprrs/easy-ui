/**
 * HTTP-поверхность миграционного коммита (план `docs/plans/2026-08-07-migration-feedback-wave.md`
 * §1.3/§W4, миграция v35).
 *
 * ```
 * POST /api/migration-commits             — создать сагу (идемпотентно по ключу) и довести её
 *                                           до `complete` или до первого `needs-*`; `dryRun: true`
 *                                           ничего не пишет
 * GET  /api/migration-commits/:id         — статус + квитанция
 * POST /api/migration-commits/:id/advance — продолжить из `needs-*`
 * POST /api/migration-commits/:id/cancel  — выйти из любого `needs-*` в `cancelled`
 * ```
 *
 * Границы этого модуля:
 *
 * - **Гейт всего набора** — матричная приёмка (`EASYUI_ACCEPTANCE_MATRIX=1`, резолвится один раз в
 *   `startServer` наличием оркестратора, триаж O-m13) и kill-switch волны
 *   `EASYUI_MIGRATION_COMMIT_DISABLED=1`. Оба выключенных состояния — `404`, как у `promote` и
 *   `snap-plan`; `capabilities.features.migrationCommit` рапортует ровно это.
 * - **Watchdog на каждом запросе** (триаж O-M7): периодических таймеров в сервере нет, поэтому
 *   sweep зависших фаз исполняется здесь, до всякой маршрутизации, — включая GET.
 * - **Авторизация**: владелец компонента (или админ) + владелец галерейного прототипа. `share`/
 *   `capture`-принципалы получают 403 (`requireUser` внутри `requireResourceOwner`).
 * - **Провал фазы — не ошибка HTTP.** Сага, вставшая в `needs-*`, отвечает `200`/`201` с
 *   квитанцией: координатору нужно прочитать, **где** она встала, а не получить голый 4xx.
 *   HTTP-отказы остаются за отказами самого запроса (форма тела, 409 in-flight, 404).
 */
import type { Database } from "bun:sqlite";
import type { Principal } from "../auth";
import { requireResourceOwner, requirePrototypeOwner } from "../authorization";
import { ApiError, json, noStore, readJson } from "../http";
import { ComponentRepo } from "../repos/components";
import { requireActiveDesignSystem } from "../designSystems";
import { isCandidateId, isRunId } from "../acceptance/ids";
import { PROMOTE_MAX_ACCEPTANCE_RUNS } from "../components/promote";
import { validateViewport } from "../screenshot/service";
import type { AcceptanceOrchestrator } from "../acceptance/orchestrator";
import type { ReuseGateMode } from "../catalog/gate";
import {
  advanceCommit, cancelCommit, createCommit, driveCommit, isCommitId, migrationCommitEnabled, planCommit,
  receiptOf, requireCommitRow, sweepStaleMigrationCommits,
  type MigrationCommitContext, type MigrationCommitGalleryRequest, type MigrationCommitRequest,
} from "../migration/commit";

const KNOWN_FIELDS = new Set([
  "idempotencyKey", "componentId", "baseRev", "sourceHash", "candidateId", "acceptanceRunIds", "expectedCases",
  "supersede", "message", "gallery", "auditDesignSystem", "dryRun",
]);
const KNOWN_GALLERY_FIELDS = new Set([
  "prototypeId", "baseRev", "screenFragment", "message", "viewport", "deviceScaleFactor", "theme", "readiness",
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const body = async (request: Request): Promise<Record<string, unknown>> => {
  const raw = await readJson(request);
  if (!isObject(raw)) throw new ApiError(400, "invalid_request", "Request body must be an object");
  return raw;
};

function positiveInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new ApiError(400, "invalid_request", `${name} must be a positive integer`);
  return value;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new ApiError(400, "invalid_request", `${name} must be a non-empty string`);
  return value;
}

/** Ключ идемпотентности — обязателен (триаж O-M8): nullable UNIQUE в SQLite ничего не ограничивает. */
function idempotencyKey(value: unknown): string {
  const key = text(value, "idempotencyKey");
  if (key.length > 200) throw new ApiError(400, "invalid_request", "idempotencyKey must be at most 200 characters");
  return key;
}

function parseGallery(value: unknown): MigrationCommitGalleryRequest {
  if (!isObject(value)) throw new ApiError(400, "invalid_request", "gallery must be an object");
  for (const key of Object.keys(value)) if (!KNOWN_GALLERY_FIELDS.has(key)) throw new ApiError(400, "invalid_request", `Unknown field: gallery.${key}`);
  const gallery: MigrationCommitGalleryRequest = { prototypeId: text(value.prototypeId, "gallery.prototypeId") };
  if (value.baseRev !== undefined) gallery.baseRev = positiveInt(value.baseRev, "gallery.baseRev");
  if (value.screenFragment !== undefined) gallery.screenFragment = value.screenFragment;
  if (value.message !== undefined) gallery.message = text(value.message, "gallery.message");
  if (value.viewport !== undefined || value.deviceScaleFactor !== undefined) {
    // Нормализация — той же функцией, что у постановки джобы и `snap-plan`: план регрессии обязан
    // считать тот же отпечаток кадра, что посчитает съёмка.
    const { viewport, dsf } = validateViewport(value.viewport, value.deviceScaleFactor);
    gallery.viewport = viewport;
    gallery.deviceScaleFactor = dsf;
  }
  if (value.theme !== undefined) {
    if (value.theme !== "light" && value.theme !== "dark") throw new ApiError(400, "invalid_request", "gallery.theme must be light or dark");
    gallery.theme = value.theme;
  }
  if (value.readiness !== undefined) {
    if (value.readiness !== "barrier") throw new ApiError(400, "invalid_request", "gallery.readiness must be \"barrier\"");
    gallery.readiness = "barrier";
  }
  return gallery;
}

function parseRequest(raw: Record<string, unknown>): { request: MigrationCommitRequest; dryRun: boolean } {
  for (const key of Object.keys(raw)) if (!KNOWN_FIELDS.has(key)) throw new ApiError(400, "invalid_request", `Unknown field: ${key}`);
  const sourceHash = text(raw.sourceHash, "sourceHash");
  if (!/^[0-9a-f]{64}$/.test(sourceHash)) throw new ApiError(400, "invalid_request", "sourceHash must be a sha256 hex digest");
  const request: MigrationCommitRequest = {
    idempotencyKey: idempotencyKey(raw.idempotencyKey),
    componentId: text(raw.componentId, "componentId"),
    baseRev: positiveInt(raw.baseRev, "baseRev"),
    sourceHash,
  };
  if (raw.candidateId !== undefined) {
    if (typeof raw.candidateId !== "string" || !isCandidateId(raw.candidateId)) throw new ApiError(400, "invalid_request", "candidateId must be a candidate id");
    request.candidateId = raw.candidateId;
  }
  if (raw.acceptanceRunIds !== undefined) {
    if (!Array.isArray(raw.acceptanceRunIds) || raw.acceptanceRunIds.length === 0) throw new ApiError(400, "invalid_request", "acceptanceRunIds must be a non-empty array of acceptance run ids");
    if (raw.acceptanceRunIds.length > PROMOTE_MAX_ACCEPTANCE_RUNS) throw new ApiError(400, "invalid_request", `acceptanceRunIds accepts at most ${PROMOTE_MAX_ACCEPTANCE_RUNS} runs`);
    for (const value of raw.acceptanceRunIds) if (typeof value !== "string" || !isRunId(value)) throw new ApiError(400, "invalid_request", "acceptanceRunIds must contain acceptance run ids");
    if (new Set(raw.acceptanceRunIds as string[]).size !== raw.acceptanceRunIds.length) throw new ApiError(400, "invalid_request", "acceptanceRunIds must not repeat a run");
    request.acceptanceRunIds = raw.acceptanceRunIds as string[];
  }
  if (raw.expectedCases !== undefined) request.expectedCases = positiveInt(raw.expectedCases, "expectedCases");
  if (raw.supersede !== undefined) {
    if (raw.supersede !== "auto" && raw.supersede !== "none") throw new ApiError(400, "invalid_request", "supersede must be \"auto\" or \"none\"");
    request.supersede = raw.supersede;
  }
  if (raw.message !== undefined) request.message = text(raw.message, "message");
  if (raw.gallery !== undefined) request.gallery = parseGallery(raw.gallery);
  if (raw.auditDesignSystem !== undefined) request.auditDesignSystem = text(raw.auditDesignSystem, "auditDesignSystem");
  if (raw.dryRun !== undefined && typeof raw.dryRun !== "boolean") throw new ApiError(400, "invalid_request", "dryRun must be a boolean");
  return { request, dryRun: raw.dryRun === true };
}

export interface MigrationCommitRouteOptions {
  dataDir: string;
  mode: ReuseGateMode;
  /** Матричная приёмка: её наличие — гейт набора; репозиторий уезжает в promote-фазу. */
  acceptance?: AcceptanceOrchestrator;
  serveDist?: string;
}

/**
 * Диспетчер `/api/migration-commits*`. Возвращает `null`, если путь не наш (набор ручек
 * выключен — это уже `404`, а не `null`: молчаливый проход дальше сделал бы отказ неотличимым от
 * опечатки в пути).
 */
export async function routeMigrationCommits(
  request: Request, db: Database, segments: string[], principal: Principal, options: MigrationCommitRouteOptions,
): Promise<Response | null> {
  if (segments[0] !== "migration-commits") return null;
  if (!options.acceptance) throw new ApiError(404, "not_found", "Migration commits require EASYUI_ACCEPTANCE_MATRIX=1");
  if (!migrationCommitEnabled()) throw new ApiError(404, "not_found", "Migration commits are disabled (EASYUI_MIGRATION_COMMIT_DISABLED)");

  // Watchdog: на каждом запросе к набору, до маршрутизации (триаж O-M7, R7).
  sweepStaleMigrationCommits(db);

  const context = (actor: { userId: string; isAdmin: boolean }): MigrationCommitContext => ({
    db, dataDir: options.dataDir, actor, mode: options.mode,
    ...(options.acceptance ? { acceptanceRepo: options.acceptance.repo } : {}),
    ...(options.serveDist === undefined ? {} : { serveDist: options.serveDist }),
  });

  if (segments.length === 1) {
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    const { request: parsed, dryRun } = parseRequest(await body(request));
    const actor = requireResourceOwner(db, "components", parsed.componentId, principal);
    const component = new ComponentRepo(db).row(parsed.componentId);
    requireActiveDesignSystem(db, component.design_system, ["componentId"]);
    requireResourceOwner(db, "design_systems", component.design_system, principal);
    // Галерея — отдельный ресурс с отдельным владельцем: сага не имеет права записать чужой
    // прототип только потому, что компонент свой.
    if (parsed.gallery) requirePrototypeOwner(db, parsed.gallery.prototypeId, principal);
    if (parsed.auditDesignSystem !== undefined) requireActiveDesignSystem(db, parsed.auditDesignSystem, ["auditDesignSystem"]);

    if (dryRun) return json(await planCommit(context(actor), parsed, component.design_system), 200, noStore);

    const created = createCommit(db, parsed, { designSystem: component.design_system, ownerId: actor.userId });
    if (created.cached) return json({ ...receiptOf(created.row), idempotentReplay: true }, 200, noStore);
    const row = await driveCommit(context(actor), created.row.commit_id, "preflight");
    return json(receiptOf(row), 201, { ...noStore, location: `/api/migration-commits/${row.commit_id}` });
  }

  const id = segments[1]!;
  if (!isCommitId(id)) throw new ApiError(404, "not_found", "Migration commit not found");
  const tail = segments.slice(2);
  const row = requireCommitRow(db, id);
  const actor = requireResourceOwner(db, "components", row.component_id, principal);

  if (tail.length === 0) {
    if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    return json(receiptOf(row), 200, noStore);
  }
  if (tail.length === 1 && tail[0] === "advance") {
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    if (row.gallery_prototype_id) requirePrototypeOwner(db, row.gallery_prototype_id, principal);
    return json(receiptOf(await advanceCommit(context(actor), id)), 200, noStore);
  }
  if (tail.length === 1 && tail[0] === "cancel") {
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    const raw = request.headers.get("content-type") ? await body(request) : {};
    for (const key of Object.keys(raw)) if (key !== "reason") throw new ApiError(400, "invalid_request", `Unknown field: ${key}`);
    const reason = raw.reason === undefined ? undefined : text(raw.reason, "reason");
    return json(receiptOf(cancelCommit(db, id, reason)), 200, noStore);
  }
  throw new ApiError(404, "not_found", "API route not found");
}
