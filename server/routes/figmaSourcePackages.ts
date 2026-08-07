/**
 * HTTP-поверхность пакета исходников Figma (план
 * `docs/plans/2026-08-07-migration-feedback-wave.md` §W8, миграция v36).
 *
 * ```
 * POST /api/figma-source-packages                     — загрузка манифеста (идемпотентна по SHA)
 * GET  /api/figma-source-packages?designSystem=&fileKey= — список пакетов системы
 * GET  /api/figma-source-packages/:packageId          — пакет + манифест
 * POST /api/figma-source-packages/:packageId/case-set-skeleton — черновик case-set (НЕ пишется)
 * ```
 *
 * Границы модуля:
 *
 * - **Kill-switch набора** — `EASYUI_SOURCE_PACKAGE_DISABLED=1`: все четыре ручки отвечают `404`,
 *   как `snap-plan` и сага коммита; `capabilities.features.figmaSourcePackage` рапортует ровно это.
 * - **POST, а не PUT, при контентном адресе.** Прецедент — `POST /api/assets`: адрес считает
 *   **сервер** по присланным байтам, поэтому клиенту нечего положить в путь. Повтор того же
 *   манифеста возвращает `200` с `deduplicated: true` (та же семантика, что у ассетов), новый —
 *   `201` с `Location`.
 * - **Авторизация:** `requireUser` + владелец дизайн-системы на записи (пакет — источник её
 *   каталога), любой аутентифицированный пользователь на чтении. `share`/`capture`-принципалы
 *   получают 403 через `requireUser`: анонимный барьер `createHandler` их пропускает.
 * - **Байтов здесь нет.** Экспорт — `assetId` реестра; загрузка PNG остаётся за `POST /api/assets`.
 */
import type { Database } from "bun:sqlite";
import type { Principal } from "../auth";
import { requireResourceOwner, requireUser } from "../authorization";
import { requireActiveDesignSystem } from "../designSystems";
import { ApiError, json, noStore, readJson } from "../http";
import { parseWith, skeletonRequestSchema } from "../contracts";
import {
  caseSetSkeletonOf, isSourcePackageId, manifestOfRow, sourcePackageEnabled, sourcePackageIdOf,
  sourcePackageManifestSchema, sourcePackageView, SourcePackageRepo, validateSourcePackage,
} from "../figma/sourcePackage";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function objectBody(request: Request): Promise<Record<string, unknown>> {
  const raw = await readJson(request);
  if (!isObject(raw)) throw new ApiError(400, "invalid_request", "Request body must be an object");
  return raw;
}

function requirePackage(db: Database, packageId: string) {
  // Форма проверяется **до** lookup'а: произвольная строка иначе отличала бы «нет строки» от
  // «не тот формат» и давала бы оракул по чужим пакетам.
  if (!isSourcePackageId(packageId)) throw new ApiError(404, "source_package_not_found", "Source package not found");
  const row = new SourcePackageRepo(db).get(packageId);
  if (row === null) throw new ApiError(404, "source_package_not_found", "Source package not found");
  return row;
}

async function uploadPackage(request: Request, db: Database, principal: Principal): Promise<Response> {
  const body = await objectBody(request);
  for (const key of Object.keys(body)) {
    if (key !== "manifest") throw new ApiError(400, "invalid_request", `Unknown field: ${key}`);
  }
  const manifest = parseWith(sourcePackageManifestSchema, body.manifest, "Source package manifest is invalid");
  requireActiveDesignSystem(db, manifest.designSystem, ["manifest", "designSystem"]);
  const actor = requireResourceOwner(db, "design_systems", manifest.designSystem, principal);
  validateSourcePackage(db, manifest);
  const { row, deduplicated } = new SourcePackageRepo(db).insert(manifest, actor.userId);
  const view = { ...sourcePackageView(row), ...(deduplicated ? { deduplicated: true } : {}) };
  return json(view, deduplicated ? 200 : 201,
    deduplicated ? noStore : { ...noStore, location: `/api/figma-source-packages/${row.package_id}` });
}

function listPackages(request: Request, db: Database): Response {
  const searchParams = new URL(request.url).searchParams;
  const designSystem = searchParams.get("designSystem");
  if (designSystem === null) throw new ApiError(400, "invalid_request", "designSystem is required");
  const fileKey = searchParams.get("fileKey");
  const rawLimit = searchParams.get("limit");
  const limit = rawLimit === null ? 20 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, "invalid_request", "limit must be an integer between 1 and 100");
  const rows = new SourcePackageRepo(db).list(designSystem, { ...(fileKey === null ? {} : { fileKey }), limit });
  return json({
    designSystem,
    packages: rows.map((row) => {
      // Список не тащит манифесты: 256 экспортов × N строк — это ответ на мегабайты там, где
      // спрашивали «какие пакеты есть».
      const view = sourcePackageView(row);
      delete view.manifest;
      return view;
    }),
  }, 200, noStore);
}

async function skeleton(request: Request, db: Database, packageId: string, principal: Principal): Promise<Response> {
  const row = requirePackage(db, packageId);
  requireUser(principal);
  const body = await objectBody(request);
  const known = new Set(["componentId", "viewport", "deviceScaleFactor", "theme", "nodeIds"]);
  for (const key of Object.keys(body)) if (!known.has(key)) throw new ApiError(400, "invalid_request", `Unknown field: ${key}`);
  const options = parseWith(skeletonRequestSchema, body, "Skeleton request is invalid");
  const draft = caseSetSkeletonOf(manifestOfRow(row), {
    componentId: options.componentId,
    ...(options.viewport === undefined ? {} : { viewport: options.viewport }),
    ...(options.deviceScaleFactor === undefined ? {} : { deviceScaleFactor: options.deviceScaleFactor }),
    ...(options.theme === undefined ? {} : { theme: options.theme }),
    ...(options.nodeIds === undefined ? {} : { nodeIds: options.nodeIds }),
  });
  // Скелет — **черновик**: он не сохраняется и case set'ом не становится, пока автор не пришлёт
  // его обратно в `PUT /api/components/:id/case-sets`.
  return json({ packageId: row.package_id, componentId: options.componentId, manifest: draft, saved: false }, 200, noStore);
}

/**
 * Диспетчер. `segments` — путь после `/api`. Возвращает `null` для чужих путей, `404` для всего
 * набора при выключенном kill-switch'е.
 */
export async function routeFigmaSourcePackages(
  request: Request,
  db: Database,
  segments: string[],
  principal: Principal,
): Promise<Response | null> {
  if (segments[0] !== "figma-source-packages") return null;
  if (!sourcePackageEnabled()) throw new ApiError(404, "not_found", "API route not found");
  requireUser(principal);

  if (segments.length === 1) {
    if (request.method === "GET") return listPackages(request, db);
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    return uploadPackage(request, db, principal);
  }
  const packageId = segments[1]!;
  if (segments.length === 2) {
    if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    return json(sourcePackageView(requirePackage(db, packageId)), 200, noStore);
  }
  if (segments.length === 3 && segments[2] === "case-set-skeleton") {
    if (request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Method not allowed");
    return skeleton(request, db, packageId, principal);
  }
  throw new ApiError(404, "not_found", "API route not found");
}

/** Идентичность пакета считается тем же кодом, что и на записи (для тестов и CLI). */
export { sourcePackageIdOf };
