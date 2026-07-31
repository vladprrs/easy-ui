import type { Database } from "bun:sqlite";
import type { Principal } from "../auth";
import { requireUser } from "../authorization";
import { collectCorpus } from "../catalog/corpus";
import { matchCandidates, type MatchCandidate, type ProposedArtifact } from "../catalog/matcher";
import { CALIBRATED_POLICY } from "../catalog/policy";
import { catalogCandidatesQuerySchema, catalogCandidatesRequestSchema, parseQuery, parseWith, type CatalogCandidatesRequest } from "../contracts";
import { getIncludingRetired } from "../designSystems";
import { ApiError, json, noStore, readJson } from "../http";

/**
 * `POST|GET /api/catalog/candidates` — компактный поиск кандидатов на переиспользование
 * (спека §2, план 2026-07-31 §4 T4).
 *
 * Почему два метода. `POST` — полная форма со `proposed` (в т.ч. исходником), она же вход
 * гейта создания. `GET` существует ровно по одной причине: частый случай «поиск по одному
 * intent» не должен требовать заголовка `Origin` — `enforceOrigin` (`server/main.ts:78`)
 * срабатывает только на unsafe-методах, а агент/CLI в чужом процессе Origin не шлёт.
 * Плата за это — лимит длины `intent` в query (тот же, что и в теле: 500 символов).
 *
 * `requireUser` обязателен (план §1.2, A14): share- и capture-принципалы проходят
 * `main.ts:130` как не-анонимные и иначе получили бы полный индекс каталога чужой системы.
 *
 * Ответ компактный: **никогда** не `source` и не props-схемы. За деталями выбранного
 * кандидата вызывающий идёт в существующие version-роуты.
 */

/** Спека §2: 1..20, default 8. `limit` не влияет на blocking-набор гейта, только на выдачу. */
const DEFAULT_LIMIT = 8;

/** Компактная строка кандидата: `signals`/`propsDelta` наружу не идут — это выход гейта. */
function compact(candidate: MatchCandidate) {
  return {
    kind: candidate.kind, id: candidate.id, name: candidate.name, designSystem: candidate.designSystem,
    version: candidate.version, draft: candidate.draft, description: candidate.description,
    ...(candidate.atomicLevel === undefined ? {} : { atomicLevel: candidate.atomicLevel }),
    ...(candidate.scope === undefined ? {} : { scope: candidate.scope }),
    canonicalFor: candidate.canonicalFor,
    ...(candidate.replacement === undefined ? {} : { replacement: candidate.replacement }),
    deprecated: candidate.deprecated, recommendable: candidate.recommendable,
    headUsageCount: candidate.headUsageCount,
    score: candidate.score, blocking: candidate.blocking, reasons: candidate.reasons,
  };
}

function readInput(request: Request, url: URL): Promise<CatalogCandidatesRequest> | CatalogCandidatesRequest {
  if (request.method === "GET") {
    const { designSystem, intent, limit } = parseQuery(catalogCandidatesQuerySchema, url.searchParams);
    return { designSystem, intent, ...(limit === undefined ? {} : { limit }) };
  }
  return readJson(request).then((body) => parseWith(catalogCandidatesRequestSchema, body));
}

export async function routeCatalogCandidates(request: Request, db: Database, principal: Principal): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Method not allowed");
  requireUser(principal);
  const input = await readInput(request, new URL(request.url));

  const system = getIncludingRetired(db, input.designSystem);
  if (!system || system.retired) throw new ApiError(404, "not_found", "Design system not found");

  // Отступление D6: композиции v1 не вкладываются, их дедупликация — проект 3. Отказ типизован
  // отдельным кодом, чтобы вызывающий отличал «пока не умеем» от «запрос невалиден».
  if (input.proposed?.kind === "composition") {
    throw new ApiError(422, "unsupported_kind", "Composition candidates are not supported yet");
  }

  const proposed: ProposedArtifact = {
    kind: "component",
    designSystem: input.designSystem,
    intent: input.intent,
    ...(input.proposed?.id === undefined ? {} : { id: input.proposed.id }),
    ...(input.proposed?.name === undefined ? {} : { name: input.proposed.name }),
    ...(input.proposed?.description === undefined ? {} : { description: input.proposed.description }),
    ...(input.proposed?.atomicLevel === undefined ? {} : { atomicLevel: input.proposed.atomicLevel }),
    ...(input.proposed?.scope === undefined ? {} : { scope: input.proposed.scope }),
    ...(input.proposed?.canonicalFor === undefined ? {} : { canonicalFor: input.proposed.canonicalFor }),
    ...(input.proposed?.source === undefined ? {} : { source: input.proposed.source }),
    // `meta` объявляется только когда вызывающий дал хоть один её сигнал: пустой объект здесь
    // означал бы «props/io объявлены и пусты», и матчер посчитал бы сигналы применимыми.
    ...(input.proposed !== undefined && (input.proposed.propsJsonSchema !== undefined || input.proposed.events !== undefined || input.proposed.slots !== undefined)
      ? { meta: { propsJsonSchema: input.proposed.propsJsonSchema, events: input.proposed.events, slots: input.proposed.slots } }
      : {}),
  };

  // Корпус и матчинг — одной транзакцией: иначе `catalogRevision` мог бы описывать не тот
  // снапшот, по которому посчитаны кандидаты (та же причина, что у `routeLibraryCatalog`).
  const result = db.transaction(() => {
    const corpus = collectCorpus(db, input.designSystem);
    const matched = matchCandidates(corpus.candidates, proposed, CALIBRATED_POLICY, {
      limit: input.limit ?? DEFAULT_LIMIT,
      // D4: сам оцениваемый артефакт из корпуса исключается — иначе повторный поиск по
      // существующему id всегда возвращал бы его самого первым.
      ...(input.proposed?.id === undefined ? {} : { exclude: { designSystem: input.designSystem, id: input.proposed.id } }),
    });
    return { catalogRevision: corpus.catalogRevision, policyVersion: matched.policyVersion, candidates: matched.candidates.map(compact) };
  })();

  return json({ designSystem: input.designSystem, ...result }, 200, noStore);
}
