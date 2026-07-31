import type { Database } from "bun:sqlite";
import type { Principal } from "../auth";
import { parseQuery, reuseAuditQuerySchema } from "../contracts";
import { ApiError, json, noStore } from "../http";
import { ReuseDecisionRepo } from "../repos/reuseDecisions";

/**
 * `GET /api/catalog/reuse-decisions` — админское чтение аудита гейта переиспользования
 * (спека §5, план 2026-07-31 §4 T10).
 *
 * Отдаёт четыре выборки спеки — `force_new`, повторяющиеся блокировки в агрегации по
 * actor/artifact, конфликты канонической роли, артефакты каталога без единого reuse-review —
 * плюс счётчики `would_block`, из которых берётся критерий выхода из shadow (§5.4).
 *
 * Только чтение: таблица append-only и защищена триггерами БД, ретенция живёт отдельным
 * путём (`ReuseDecisionRepo.prune`) и здесь недоступна.
 *
 * Доступ строго админский. `principal.kind !== "user"` даёт 401/403 раньше проверки флага:
 * share- и capture-принципалы проходят проверку анонимности в `main.ts` как не-анонимные, а
 * содержимое аудита (кто, что и по какому intent пытался создать) — не их материал.
 */

const DEFAULT_LIMIT = 100;
const DEFAULT_MIN_ATTEMPTS = 2;

export function routeReuseDecisions(request: Request, db: Database, principal: Principal): Response {
  if (request.method !== "GET") throw new ApiError(405, "method_not_allowed", "Method not allowed");
  if (principal.kind !== "user") {
    if (principal.kind === "anonymous") throw new ApiError(401, "unauthorized", "Authentication required");
    throw new ApiError(403, "forbidden", "Administrator access required");
  }
  if (!principal.isAdmin) throw new ApiError(403, "forbidden", "Administrator access required");

  const query = parseQuery(reuseAuditQuerySchema, new URL(request.url).searchParams);
  const limit = query.limit ?? DEFAULT_LIMIT;
  const minAttempts = query.minAttempts ?? DEFAULT_MIN_ATTEMPTS;
  const filter = {
    ...(query.since === undefined ? {} : { since: query.since }),
    ...(query.designSystem === undefined ? {} : { designSystem: query.designSystem }),
    ...(query.actorId === undefined ? {} : { actorId: query.actorId }),
    limit,
  };
  const repo = new ReuseDecisionRepo(db);

  // Одна транзакция на все выборки: иначе секции отчёта описывали бы разные снапшоты таблицы
  // и агрегаты не сходились бы с перечислениями под ними.
  const report = db.transaction(() => ({
    gateActiveSince: repo.gateActiveSince(),
    totals: repo.summary(filter),
    forceNew: repo.forceNew(filter),
    repeatedBlocked: repo.repeatedBlocked({ ...filter, minAttempts }),
    canonicalRoleConflicts: repo.canonicalRoleConflicts(filter),
    wouldBlock: repo.wouldBlock(filter),
    // Анти-джойн каталога не знает ни актора, ни окна: у этих артефактов решений нет вовсе.
    unreviewed: repo.unreviewedArtifacts({ ...(query.designSystem === undefined ? {} : { designSystem: query.designSystem }), limit }),
  }))();

  return json({
    generatedAt: new Date().toISOString(),
    gateActiveSince: report.gateActiveSince,
    filter: {
      ...(query.since === undefined ? {} : { since: query.since }),
      ...(query.designSystem === undefined ? {} : { designSystem: query.designSystem }),
      ...(query.actorId === undefined ? {} : { actorId: query.actorId }),
      limit, minAttempts,
    },
    totals: report.totals,
    forceNew: report.forceNew,
    repeatedBlocked: report.repeatedBlocked,
    canonicalRoleConflicts: report.canonicalRoleConflicts,
    wouldBlock: report.wouldBlock,
    unreviewed: report.unreviewed,
  }, 200, noStore);
}
