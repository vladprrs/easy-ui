import type { Database } from "bun:sqlite";
import type { Principal } from "../auth";
import { requireUser } from "../authorization";
import { collectCorpus } from "../catalog/corpus";
import { matchReuseProposal, stageAndExtract } from "../catalog/gate";
import { matchCandidates, type MatchCandidate, type ProposedArtifact } from "../catalog/matcher";
import { compositionPropsJsonSchema, compositionStructure, slotNamesOf } from "../catalog/compositionSignature";
import { CALIBRATED_POLICY, COMPOSITION_MATCH_POLICY } from "../catalog/policy";
import { analyzeComposition, type CompositionVerdict } from "../../src/prototype/compositionAnalyze";
import { componentCanonicalRoles, componentLayoutContracts } from "../validation";
import { CompositionRepo } from "../repos/compositions";
import { analyzeDependencyImpact } from "./compositions";
import { checkSource } from "./components";
import { catalogCandidatesQuerySchema, catalogCandidatesRequestSchema, parseQuery, parseWith, type CatalogCandidatesRequest } from "../contracts";
import { getIncludingRetired } from "../designSystems";
import { ApiError, json, noStore, readJson } from "../http";
import { manifestById, sourceSignatureOf } from "../figma/sourcePackage";

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

// ─────────────────────── композиционные кандидаты (W9) ───────────────────────

/** Три исхода workbench'а (план 2026-08-03 §5 W9, спека §19.4). */
export type CompositionOutcome = "build-composition" | "extend-component" | "new-ownership-component";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Строка `matches`: почему этот артефакт вообще показан автору. */
const matchRow = (candidate: MatchCandidate) => ({
  kind: candidate.kind, id: candidate.id, name: candidate.name, version: candidate.version,
  score: candidate.score, blocking: candidate.blocking, recommendable: candidate.recommendable,
  why: candidate.reasons.length ? candidate.reasons.join("; ") : "ranked by intent and contract similarity",
});

/**
 * `POST /api/catalog/candidates` с `proposed.kind: "composition"` — **рекомендательный**
 * ответ workbench'а (план 2026-08-03 §5 W9). Гейт-семантика переиспользования
 * (`409 component_reuse_required`) на композиции в этой волне **не распространяется**: ответ
 * объясняет и предлагает, но ничего не запрещает. Включение enforce — отдельное решение,
 * ему нужен замер распределения score на композиционных парах (у калибровки T0 его нет).
 *
 * Корпус здесь собирается с композициями (`includeCompositions`), поэтому дубль существующей
 * композиции детектируется — ровно та дыра, которую нашло ревью (R1-M9). Пороги композиционных
 * пар отдельные и консервативнее (`COMPOSITION_MATCH_POLICY`).
 */
function compositionCandidates(db: Database, input: CatalogCandidatesRequest, proposed: NonNullable<CatalogCandidatesRequest["proposed"]>): Response {
  // Исходник — контракт компонента: у композиции тела в TSX нет, и молча его игнорировать
  // нечестно (вызывающий думал бы, что сигнал учтён).
  if (proposed.source !== undefined) {
    throw new ApiError(422, "validation_failed", "Composition candidates do not accept a TSX source", {
      issues: [{ path: ["proposed", "source"], message: "source applies to kind:\"component\" only; pass compositionDoc instead" }],
    });
  }

  const doc = isRecord(proposed.compositionDoc) ? proposed.compositionDoc : undefined;
  const structure = doc === undefined ? undefined : compositionStructure(doc);
  const docText = (key: string): string | undefined => (typeof doc?.[key] === "string" ? doc[key] as string : undefined);
  const docList = (key: string): string[] | undefined =>
    Array.isArray(doc?.[key]) ? (doc[key] as unknown[]).filter((item): item is string => typeof item === "string") : undefined;

  const name = proposed.name ?? docText("name");
  const description = proposed.description ?? docText("description");
  const atomicLevel = proposed.atomicLevel ?? docText("atomicLevel");
  const scope = proposed.scope ?? docText("scope");
  const canonicalFor = proposed.canonicalFor ?? docList("canonicalFor");
  const slots = doc === undefined ? proposed.slots : slotNamesOf(doc.slots);
  const propsJsonSchema = doc === undefined ? proposed.propsJsonSchema : compositionPropsJsonSchema(doc.params);
  const artifact: ProposedArtifact = {
    kind: "composition",
    designSystem: input.designSystem,
    intent: input.intent,
    ...(proposed.id === undefined ? {} : { id: proposed.id }),
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(atomicLevel === undefined ? {} : { atomicLevel }),
    ...(scope === undefined ? {} : { scope }),
    ...(canonicalFor === undefined ? {} : { canonicalFor }),
    // Как и у компонента: `meta` объявляется только когда сигнал реально есть, иначе
    // матчер посчитал бы props/slots «объявленными и пустыми».
    ...(propsJsonSchema === undefined && slots === undefined && proposed.events === undefined
      ? {}
      : { meta: { propsJsonSchema, events: proposed.events ?? [], slots } }),
    ...(structure === undefined ? {} : { structure: { shingles: structure.shingles, fingerprint: structure.fingerprint } }),
  };

  const elements = isRecord(doc?.spec) && isRecord((doc.spec as { elements?: unknown }).elements)
    ? (doc.spec as { elements: Record<string, { type?: unknown; props?: unknown }> }).elements
    : {};

  return db.transaction(() => {
    const corpus = collectCorpus(db, input.designSystem, { includeCompositions: true });
    const matched = matchCandidates(corpus.candidates, artifact, CALIBRATED_POLICY, {
      limit: input.limit ?? DEFAULT_LIMIT,
      policyByKind: { composition: COMPOSITION_MATCH_POLICY },
      ...(proposed.id === undefined ? {} : { exclude: { designSystem: input.designSystem, id: proposed.id } }),
    });

    // Вердикт W8g считается тем же анализатором, что и `POST /api/compositions/analyze`:
    // два разных ответа на один вопрос «выразимо ли это композицией» недопустимы.
    const analysis = doc === undefined ? undefined : analyzeComposition({
      doc,
      context: {
        componentRoles: componentCanonicalRoles(db, input.designSystem),
        componentLayouts: componentLayoutContracts(db, input.designSystem),
      },
    });

    const duplicate = matched.candidates.find((candidate) => candidate.kind === "composition" && candidate.blocking && candidate.recommendable);
    const componentMatch = matched.candidates.find((candidate) => candidate.kind === "component" && candidate.blocking && candidate.recommendable);
    const { outcome, explanation } = decideOutcome(duplicate, componentMatch, analysis?.verdict);

    return json({
      designSystem: input.designSystem,
      catalogRevision: corpus.catalogRevision,
      policyVersion: matched.policyVersion,
      candidates: matched.candidates.map(compact),
      outcome,
      explanation,
      matches: matched.candidates.map(matchRow),
      ...(analysis === undefined ? {} : {
        analyzerVerdict: analysis.verdict,
        analysis: { reasons: analysis.reasons, unsupported: analysis.unsupported, schemaValid: analysis.schemaValid, stats: analysis.stats },
      }),
      dependencyImpact: analyzeDependencyImpact(db, new CompositionRepo(db), elements, input.designSystem),
    }, 200, noStore);
  })();
}

/**
 * Порядок решает, а не «первое подходящее правило»:
 * 1. **точный дубль композиции** старше всего — если такая композиция уже есть, её надо
 *    переиспользовать, и вопрос «выразимо ли это» уже отвечен фактом её существования;
 * 2. **сильный мэтч компонента** — композиция была бы лишним уровнем косвенности;
 * 3. вердикт анализатора — он говорит про выразимость, а не про каталог;
 * 4. иначе — собирать композицию.
 */
function decideOutcome(
  duplicate: MatchCandidate | undefined,
  componentMatch: MatchCandidate | undefined,
  verdict: CompositionVerdict | undefined,
): { outcome: CompositionOutcome; explanation: string } {
  if (duplicate !== undefined) {
    return {
      outcome: "build-composition",
      explanation: `Reuse the existing composition "${duplicate.name}" (${duplicate.id}${duplicate.version ? `, version ${duplicate.version}` : ", unpublished head"}): ${duplicate.reasons.join("; ") || "it matches the proposal"}. Extend it with params or slots instead of authoring a second one.`,
    };
  }
  if (componentMatch !== undefined) {
    return {
      outcome: "extend-component",
      explanation: `The component "${componentMatch.name}" (${componentMatch.id}) already covers this contract: ${componentMatch.reasons.join("; ") || "it matches the proposal"}. Extend it rather than wrapping it in a composition.`,
    };
  }
  if (verdict === "needs-ownership-component") {
    return {
      outcome: "new-ownership-component",
      explanation: "The analyzer found behaviour that composition expansion cannot express (see analysis.unsupported): author an ownership component and expose its result as props.",
    };
  }
  if (verdict === "extend-component") {
    return {
      outcome: "extend-component",
      explanation: "The body reduces to a single component with prop variations (see analysis.reasons): extend that component instead of adding a composition layer.",
    };
  }
  return {
    outcome: "build-composition",
    explanation: verdict === "composition"
      ? "No catalog duplicate and the body is expressible declaratively: build the composition."
      : "No catalog duplicate matched the proposal: build the composition (pass compositionDoc to get an expressiveness verdict as well).",
  };
}

function readInput(request: Request, url: URL): Promise<CatalogCandidatesRequest> | CatalogCandidatesRequest {
  if (request.method === "GET") {
    const { designSystem, intent, limit } = parseQuery(catalogCandidatesQuerySchema, url.searchParams);
    return { designSystem, intent, ...(limit === undefined ? {} : { limit }) };
  }
  return readJson(request).then((body) => parseWith(catalogCandidatesRequestSchema, body));
}

export async function routeCatalogCandidates(request: Request, db: Database, principal: Principal, dataDir = "data"): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") throw new ApiError(405, "method_not_allowed", "Method not allowed");
  requireUser(principal);
  const input = await readInput(request, new URL(request.url));

  const system = getIncludingRetired(db, input.designSystem);
  if (!system || system.retired) throw new ApiError(404, "not_found", "Design system not found");

  // W9: композиционный кандидат — свой путь. Отказ `422 unsupported_kind` снят.
  if (input.proposed?.kind === "composition") return compositionCandidates(db, input, input.proposed);

  // Сигнатура источника (§W8, триаж S-M6): пакет + узлы предложения проецируются в ключи
  // компонентов и семантические роли теми же правилами, что и корпус.
  const proposedPackage = input.proposed?.sourcePackageId === undefined ? null : manifestById(db, input.proposed.sourcePackageId);
  const proposedSourceSignature = proposedPackage === null || input.proposed?.sourceNodeIds === undefined
    ? undefined
    : sourceSignatureOf(proposedPackage, input.proposed.sourceNodeIds);

  const source = input.proposed?.source;
  const extracted = source === undefined ? undefined : await stageAndExtract(
    dataDir,
    input.proposed?.id ?? "catalog-candidate",
    source,
    (path) => checkSource(source, path),
  );

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
    // §W8: сигнатура источника предложения. Неизвестный пакет **не** отказ: сигнал ранжирующий,
    // и отвергать поиск кандидатов из-за него значило бы делать из подсказки гейт.
    ...(proposedSourceSignature === undefined ? {} : { sourceSignature: proposedSourceSignature }),
  };

  // Корпус и матчинг — одной транзакцией: иначе `catalogRevision` мог бы описывать не тот
  // снапшот, по которому посчитаны кандидаты (та же причина, что у `routeLibraryCatalog`).
  const result = db.transaction(() => {
    if (source !== undefined && extracted?.meta !== undefined) {
      const matched = matchReuseProposal(db, {
        designSystem: input.designSystem,
        ...(input.proposed?.id === undefined ? {} : { artifactId: input.proposed.id }),
        name: input.proposed?.name ?? input.proposed?.id ?? "",
        intent: input.intent,
        source,
        meta: extracted.meta,
        limit: input.limit ?? DEFAULT_LIMIT,
      });
      return {
        catalogRevision: matched.catalogRevision,
        policyVersion: matched.policyVersion,
        candidates: matched.candidates.map(compact),
        overrideTemplate: { catalogRevision: matched.catalogRevision, candidateKeys: matched.candidateKeys },
      };
    }
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
