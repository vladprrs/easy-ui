import type { Database } from "bun:sqlite";
import { ApiError } from "../http";
import { ComponentRepo } from "../repos/components";
import { recordValidation } from "../validationRecords";
import { getLatestDesignSystemContent } from "../designSystems";
import { libraryCatalog } from "../routes/libraryCatalog";
import { architectureWarnings, reserveHostPrimitiveName } from "../routes/components";
import { assertAtomicPolicy } from "../atomicPolicy";
import { assertPublishRoleAvailable, duplicateWarnings, type ReuseGateMode, type ReuseOverride } from "../catalog/gate";
import { importPublished, materializeSource, sha256 } from "./pipeline";
import { ensureDraftCandidate } from "./validate";
import { getCandidateBundle } from "./candidates";
import type { AcceptanceRepo, CandidateRow } from "../acceptance/repo";
import { isTerminalRunStatus } from "../acceptance/repo";
import {
  ACCEPTANCE_POLICIES, PROMOTABLE_RUN_STATUSES, PROMOTION_POLICY_PROFILES,
  isAcceptancePolicyId, isPromotionPolicyProfile, policyProfileHash,
} from "../acceptance/policies";

/**
 * Promote (RFC candidate-acceptance-pipeline §4.3, волна R1) — **сага**, не одна транзакция:
 * bun:sqlite не переживает `await` внутри транзакции, а публикация в этом продукте по
 * построению асинхронна (`stage → import → activate` с компенсацией `fail()`).
 *
 * Отличие от `publishComponent`: **typecheck и compile не выполняются**. Артефакты берутся
 * из candidate-кэша validate-префлайта (P8) по `sourceHash`; холодный кэш пересобирается тем
 * же `ensureDraftCandidate` под троттлингом `withValidateSlot`. `importPublished` (ключ
 * `id@rev`) выполняется **всегда** — свою import-верификацию promote не пропускает.
 *
 * Фаза A (вне транзакций): предпроверки → каталого-временные проверки publish-пути →
 * `stage` готовыми артефактами → `importPublished`.
 * Фаза B (одна короткая синхронная транзакция): `activate` + `pinAssets` + `recordValidation`
 * + auto-supersede прочих active-версий через инварианты `setStatus`.
 *
 * Волна W1c (план 2026-08-03 §5, амендмент A9): необязательные ссылки `candidateId`/
 * `acceptanceRunId` сверяются в фазе A.1 (`resolveAcceptanceRefs`) и записываются в фазе B —
 * плоскими TEXT-receipts на строке версии плюс перевод кандидата в `promoted`.
 *
 * Идемпотентность/recovery: крах фазы A компенсируется `fail()`/`failStagingPublishes`, а
 * расширенный `already_published`-чек (`repos/components.ts:stage`) пропускает повторный
 * promote тех же `{baseRev, sourceHash}` — он создаёт версию с новым номером.
 */

export type PromoteSupersede = "auto" | "none";

/**
 * Ссылки на durable-приёмку (амендмент A9 плана 2026-08-03, RFC §4.3 шаг 5). Приезжают только при
 * `EASYUI_ACCEPTANCE_MATRIX=1` — иначе роут отказывает `422 acceptance_matrix_disabled` ещё до саги.
 *
 * `repo` передаётся как зависимость, а не резолвится здесь: promote обязан работать и без
 * матричного стека, а импорт живого оркестратора в сагу сделал бы флаг неоткатываемым.
 */
export type PromoteAcceptance = {
  repo: AcceptanceRepo;
  candidateId?: string;
  acceptanceRunId?: string;
};

export type PromoteInput = {
  id: string;
  baseRev: number;
  sourceHash: string;
  expectedCatalogRevision?: string;
  supersede: PromoteSupersede;
  message?: string;
  actor: { userId: string; isAdmin: boolean };
  mode: ReuseGateMode;
  override?: ReuseOverride;
  /** A9: ссылки на кандидата/ран приёмки; отсутствие поля — receipt-only promote (R1). */
  acceptance?: PromoteAcceptance;
};

export type PromoteResult = {
  version: number;
  rev: number;
  hostAbiVersion: number;
  sourceHash: string;
  bundleHash: string;
  themeVersion: number | null;
  catalogRevision: string;
  /** Версии, автоматически переведённые в `superseded` (пусто при `supersede: "none"`). */
  superseded: number[];
  /** true — артефакты приехали из тёплого candidate-кэша (typecheck+compile не выполнялись). */
  cached: boolean;
  warnings: string[];
  /** A9-receipts, записанные в строку версии (null — promote без матричной приёмки). */
  candidateId: string | null;
  acceptanceRunId: string | null;
  /**
   * Provenance политики публикации (план 2026-08-04 W3, C18): под каким профилем получен вердикт,
   * каким хэшем профиль был на момент рана и каков он сейчас. `stale: true` — определение профиля
   * менялось после рана: это **не** отказ (см. `resolveAcceptanceRefs`), а warning + запись обоих
   * хэшей сюда и в аудит-событие `component.promoted`. `null` — promote без ссылки на ран.
   */
  acceptancePolicy: PromoteAcceptancePolicy | null;
};

export type PromoteAcceptancePolicy = {
  profileId: string;
  runPolicyProfileHash: string;
  currentPolicyProfileHash: string | null;
  stale: boolean;
};

/**
 * Аварийный откат W3 (`EASYUI_PROMOTE_POLICY_STRICT`, объявлен в `docker-compose.yml`, по
 * умолчанию **выключен**): `1` возвращает докритическое поведение — равенство
 * `run.policy_profile_hash === candidate.policy_profile_hash`, то есть возврат дефекта P0-2
 * (кандидат всегда штампуется `default-v1`, поэтому `pixel-strict-v1`-раны снова перестанут
 * промоутиться). Существует ровно для одного сценария: promotion-предикат оказался неверным на
 * проде, и старое поведение — меньшее зло до отката образа.
 */
export const promotePolicyStrictEnabled = (): boolean => {
  const value = process.env.EASYUI_PROMOTE_POLICY_STRICT ?? "";
  return value !== "" && value !== "0";
};

/**
 * Сверка A9-ссылок запроса с durable-строками приёмки — **до** любых записей (фаза A.1).
 *
 * Инварианты (RFC §4.3, план §5 W1c):
 * - кандидат/ран чужого компонента невидимы (`404`): адрес строки не несёт владельца, и
 *   типизованный отказ был бы оракулом по чужой приёмке;
 * - `{rev, source_hash}` кандидата обязаны совпасть с `{baseRev, sourceHash}` запроса — иначе
 *   promote публиковал бы билд, который приёмка не видела (`409 revision_conflict`);
 * - живой (`queued|running`) ран кандидата запрещает публикацию (`409 acceptance_run_in_flight`):
 *   вердикт ещё не сложен;
 * - ран обязан принадлежать этому кандидату (`422 acceptance_run_mismatch`) и быть терминальным
 *   `pass|pass_with_exceptions` (`422 acceptance_run_not_passed`);
 * - профиль рана обязан входить в `PROMOTION_POLICY_PROFILES` (`422 acceptance_policy_mismatch`).
 *
 * **Чего здесь больше нет** (план 2026-08-04 W3, D-A): равенства `policy_profile_hash` рана и
 * кандидата. Кандидат штампуется хэшем `default-v1` при создании (политику он не выбирает —
 * RFC-инвариант «policy вне идентичности кандидата»), поэтому равенство хэшей делало любой
 * `pixel-strict-v1`-ран непромоутабельным (P0-2 фидбэка 2026-08-04). Штамп кандидата остаётся
 * информационным. Аварийный возврат старого поведения — `EASYUI_PROMOTE_POLICY_STRICT=1`.
 *
 * Расхождение `run.policy_profile_hash` с текущим определением профиля (профиль правили после
 * рана) — **не отказ** (C18): вердикт получен по политике, которая тогда действовала, и запрет
 * публикации здесь наказывал бы за чужую правку кода. Оба хэша уезжают в `acceptancePolicy`
 * ответа и аудит-события, плюс warning.
 */
function resolveAcceptanceRefs(
  acceptance: PromoteAcceptance,
  input: { id: string; baseRev: number; sourceHash: string },
  headRev: number,
): { candidate: CandidateRow; runId: string | null; policy: PromoteAcceptancePolicy | null; warnings: string[] } {
  const { repo } = acceptance;
  const run = acceptance.acceptanceRunId === undefined ? null : repo.requireRun(acceptance.acceptanceRunId);
  if (run !== null && run.component_id !== input.id) throw new ApiError(404, "not_found", "Acceptance run not found");
  // Кандидат берётся из запроса; при одиноком `acceptanceRunId` — из самого рана (ран без
  // кандидата не существует по схеме v25).
  const candidateId = acceptance.candidateId ?? run?.candidate_id;
  if (candidateId === undefined) throw new ApiError(404, "not_found", "Candidate not found");
  const candidate = repo.requireCandidate(candidateId);
  if (candidate.component_id !== input.id) throw new ApiError(404, "not_found", "Candidate not found");
  if (candidate.rev !== input.baseRev || candidate.source_hash !== input.sourceHash) {
    throw new ApiError(409, "revision_conflict", "Acceptance candidate describes another revision of this component", { currentRev: headRev });
  }
  const inFlight = repo.inFlightRun(candidate.candidate_id);
  if (inFlight) {
    throw new ApiError(409, "acceptance_run_in_flight", "Candidate has a non-terminal acceptance run; wait for it to finish before promoting", { runId: inFlight.run_id });
  }
  if (run === null) return { candidate, runId: null, policy: null, warnings: [] };
  if (run.candidate_id !== candidate.candidate_id) {
    throw new ApiError(422, "acceptance_run_mismatch", `Acceptance run belongs to another candidate, not ${candidate.candidate_id}`, { runId: run.run_id });
  }
  const strict = promotePolicyStrictEnabled();
  if (strict) {
    // Аварийный откат: докритическое равенство хэшей (см. `promotePolicyStrictEnabled`).
    if (run.policy_profile_hash !== candidate.policy_profile_hash) {
      throw new ApiError(422, "acceptance_run_mismatch", `Acceptance run was executed under another policy profile than candidate ${candidate.candidate_id}`, { runId: run.run_id });
    }
  } else if (!isPromotionPolicyProfile(run.policy_profile_id)) {
    throw new ApiError(422, "acceptance_policy_mismatch",
      `Acceptance run was executed under policy profile ${run.policy_profile_id}, which is not allowed to back a promotion`,
      { runId: run.run_id, runPolicyProfileId: run.policy_profile_id, allowed: [...PROMOTION_POLICY_PROFILES] });
  }
  if (!isTerminalRunStatus(run.status) || !PROMOTABLE_RUN_STATUSES.has(run.status)) {
    throw new ApiError(422, "acceptance_run_not_passed", `Acceptance run is ${run.status}; only pass or pass_with_exceptions may back a promote`, { runId: run.run_id });
  }
  // C18: сверка хэша рана с **текущим** определением профиля. Профиль неизвестен коду только на
  // strict-пути (иначе предикат выше уже отказал) — тогда текущего хэша нет, и `stale` не
  // утверждается: «сравнить не с чем» ≠ «разошлось».
  const current = isAcceptancePolicyId(run.policy_profile_id)
    ? policyProfileHash(ACCEPTANCE_POLICIES[run.policy_profile_id])
    : null;
  const stale = current !== null && current !== run.policy_profile_hash;
  const policy: PromoteAcceptancePolicy = {
    profileId: run.policy_profile_id,
    runPolicyProfileHash: run.policy_profile_hash,
    currentPolicyProfileHash: current,
    stale,
  };
  const warnings = stale
    ? [`Acceptance policy profile ${run.policy_profile_id} changed after run ${run.run_id} was executed (run hash ${run.policy_profile_hash}, current ${current}); the verdict is accepted under the policy that was in force then`]
    : [];
  return { candidate, runId: run.run_id, policy, warnings };
}

/**
 * Rejected-предикат (RFC §4.3.1, R3b) — **флаг-независимый** хелпер над `db`.
 *
 * Формулируется по субъекту, а не по ссылке: проверка «нет решения для переданного `candidateId`»
 * обходится тривиально — R1-путь promote (receipt-based, `{baseRev, sourceHash}`) `candidateId` не
 * передаёт вовсе, и отклонённая сборка публиковалась бы мимо надгробия. Поэтому спрашивается:
 * **есть ли отклонённый кандидат для `(component_id, design_system, rev = baseRev)`**.
 *
 * Семантика намеренно широкая: человек отклонил сборку этой ревизии — блокируется **вся ревизия**,
 * включая пересборки с другим `build_fingerprint` (иная тема/ABI). Выход — новая ревизия
 * компонента: надгробий на неё нет по определению.
 *
 * Живёт здесь, а не в `acceptance/repo.ts`: тот инжектится только при `EASYUI_ACCEPTANCE_MATRIX=1`
 * (`main.ts`), то есть предикат был бы выключен ровно в той конфигурации, где он и обходится
 * R1-путём (триаж раунд3-m-4). Таблицы `component_candidates`/`candidate_decisions` заводят
 * безусловные миграции v25/v27, поэтому запрос корректен при любом положении флага.
 *
 * `design_system` в кортеже избыточен (ревизия уже пинует дизайн-систему компонента) — оставлен
 * для симметрии с составом `candidate_id`.
 */
export function assertRevisionNotRejected(db: Database, componentId: string, designSystem: string, rev: number): void {
  const row = db.query(`SELECT c.candidate_id candidateId, d.reason, d.actor, d.created_at createdAt
    FROM candidate_decisions d
    JOIN component_candidates c ON c.candidate_id = d.candidate_id
    WHERE d.decision='rejected' AND c.component_id=? AND c.design_system=? AND c.rev=?
    ORDER BY d.created_at LIMIT 1`)
    .get(componentId, designSystem, rev) as { candidateId: string; reason: string; actor: string; createdAt: string } | null;
  if (!row) return;
  throw new ApiError(409, "candidate_rejected",
    `Revision ${rev} of ${componentId} was rejected by ${row.actor}; promote a new revision instead`,
    { candidateId: row.candidateId, decision: { reason: row.reason, actor: row.actor, createdAt: row.createdAt } });
}

/** Свежая ревизия каталога — тот же снапшот-контракт, что у validate-receipt и library. */
const currentCatalogRevision = (db: Database): string => db.transaction(() => libraryCatalog(db).catalogRevision)();

export async function promoteComponent(db: Database, dataDir: string, input: PromoteInput): Promise<PromoteResult> {
  const repo = new ComponentRepo(db);

  // --- Фаза A.1: предпроверки -------------------------------------------------
  reserveHostPrimitiveName(repo.meta(input.id).name);
  // CAS головы — единый канонический `409 revision_conflict {currentRev}` всей кодовой базы.
  repo.cas(input.id, input.baseRev);
  const revision = repo.source(input.id);
  const actualSourceHash = sha256(revision.source);
  if (actualSourceHash !== input.sourceHash) {
    throw new ApiError(409, "source_hash_mismatch", "sourceHash does not match the head revision source", {
      sourceHash: actualSourceHash, currentRev: revision.rev,
    });
  }
  // R3b: решение человека терминально и проверяется до любых мутаций — на обоих путях promote и
  // независимо от `EASYUI_ACCEPTANCE_MATRIX` (иначе receipt-путь R1 публиковал бы отклонённое).
  assertRevisionNotRejected(db, input.id, revision.designSystem, input.baseRev);
  if (input.expectedCatalogRevision !== undefined) {
    const observed = currentCatalogRevision(db);
    if (observed !== input.expectedCatalogRevision) {
      throw new ApiError(409, "catalog_changed", "Catalog revision changed since the receipt was issued", { catalogRevision: observed });
    }
  }
  // A9: ссылки на приёмку сверяются здесь же, до подготовки артефактов — отказ обязан быть
  // дешёвым и не оставлять за собой ни stage-строки, ни пересборки бандла.
  const acceptanceRefs = input.acceptance === undefined
    ? null
    : resolveAcceptanceRefs(input.acceptance, input, revision.rev);

  // --- Фаза A.2: артефакты кандидата ------------------------------------------
  // Тёплый кэш отдаёт extraction/bundle без typecheck+compile; холодный — пересобирает
  // head тем же путём, что draft-preview (`withValidateSlot`, ключ — sourceHash).
  let candidate = await ensureDraftCandidate(db, dataDir, input.id, input.actor.userId);
  let bundle = await getCandidateBundle(dataDir, input.id, actualSourceHash);
  if (bundle === null) {
    // Гонка с GC кэша между записью и чтением: одна пересборка, затем терминальный отказ.
    candidate = await ensureDraftCandidate(db, dataDir, input.id, input.actor.userId);
    bundle = await getCandidateBundle(dataDir, input.id, actualSourceHash);
  }
  if (bundle === null) {
    throw new ApiError(409, "candidate_unavailable", "Candidate bundle is unavailable; run validate again and retry promote");
  }
  if (candidate.rev !== input.baseRev || candidate.sourceHash !== actualSourceHash) {
    throw new ApiError(409, "revision_conflict", "Component revision has changed", { currentRev: candidate.rev });
  }
  const extracted = candidate.entry.extracted!;
  const meta = extracted.meta!;
  const hostAbiVersion = candidate.entry.hostAbiVersion!;
  const bundleHash = candidate.entry.bundleHash!;

  // --- Фаза A.3: каталого-временные проверки publish-пути ----------------------
  // Reuse-гейт создания (`component_reuse_required`) на publish-пути не стоит — promote его
  // тоже не добавляет; каноническая роль, атомарная политика и ассеты перепрогоняются.
  assertAtomicPolicy(db, "component", input.id, meta);
  assertPublishRoleAvailable(db, {
    designSystem: revision.designSystem, id: input.id, canonicalFor: meta.canonicalFor ?? [],
    actor: input.actor, mode: input.mode, sourceHash: actualSourceHash, intent: meta.description,
    ...(input.override === undefined ? {} : { override: input.override }),
  });

  // --- Фаза A.4: stage готовыми артефактами + import-верификация ---------------
  // Durable-модуль материализуется ДО stage: отказ записи не должен оставлять staging-строку.
  const path = await materializeSource(dataDir, input.id, revision.rev, revision.source);
  const staged = repo.stage(input.id, input.baseRev, {
    compiledJs: bundle.bundleJs, bundleHash, sourceHash: actualSourceHash, meta, hostAbiVersion,
  }, input.message);
  try { await importPublished(input.id, staged.rev, path); }
  catch (error) {
    repo.fail(input.id, staged.version);
    const detail = error instanceof Error ? error.message : String(error);
    recordValidation(db, { resourceType: "component", resourceId: input.id, rev: staged.rev, catalogHash: bundleHash, ok: false, issues: [{ path: "/source", message: detail }] });
    throw new ApiError(422, "validation_failed", "Promoted component import failed", { issues: [{ path: ["source"], message: detail }] });
  }

  // --- Фаза B: одна короткая синхронная транзакция -----------------------------
  let superseded: number[];
  try {
    superseded = db.transaction((): number[] => {
      repo.activate(input.id, staged.version);
      // Без пинов версия остаётся с пустым `assets` в DTO, ломает export и теряет
      // RESTRICT-защиту ассетов (находка V2).
      repo.pinAssets(input.id, staged.version, candidate.assetIds);
      // A9-receipts + перевод кандидата в `promoted` — в той же короткой транзакции, что и
      // activate: версия, ссылающаяся на кандидата, и кандидат, знающий свою версию, обязаны
      // появляться и откатываться вместе.
      if (acceptanceRefs !== null) {
        input.acceptance!.repo.linkPublish(input.id, staged.version, {
          candidateId: acceptanceRefs.candidate.candidate_id,
          acceptanceRunId: acceptanceRefs.runId,
        });
        input.acceptance!.repo.markPromoted(acceptanceRefs.candidate.candidate_id, staged.version, acceptanceRefs.runId);
      }
      recordValidation(db, {
        resourceType: "component", resourceId: input.id, rev: staged.rev, catalogHash: bundleHash,
        ok: true, issues: extracted.warnings.map((message) => ({ path: "/", message })),
      });
      if (input.supersede === "none") return [];
      // Выборка — ВНУТРИ транзакции, новая версия исключается по номеру; переходы идут через
      // инварианты `setStatus` (CAS+инкремент `status_rev`, cycle-check, supersededBy).
      const done: number[] = [];
      for (const other of repo.otherActiveVersions(input.id, staged.version)) {
        repo.setStatus(input.id, other.version, {
          status: "superseded", supersededBy: staged.version,
          reason: `auto: promoted v${staged.version}`, baseStatusRev: other.statusRev,
        });
        done.push(other.version);
      }
      return done;
    })();
  } catch (error) {
    // Транзакция откатилась целиком — версия осталась в `staging`; компенсируем как publish.
    repo.fail(input.id, staged.version);
    throw error;
  }

  const warnings = [...extracted.warnings, ...(candidate.entry.parityWarnings ?? []), ...(acceptanceRefs?.warnings ?? [])];
  if (!meta.atomicLevel) warnings.push("Atomic design level is not provided; component will be classified as Other");
  warnings.push(...architectureWarnings(db, input.id, meta, revision.source));
  warnings.push(...duplicateWarnings(db, { designSystem: revision.designSystem, id: input.id, name: repo.meta(input.id).name, source: revision.source, meta }));

  return {
    version: staged.version, rev: staged.rev, hostAbiVersion,
    sourceHash: actualSourceHash, bundleHash,
    themeVersion: getLatestDesignSystemContent(db, revision.designSystem).latestMetaVersion,
    catalogRevision: currentCatalogRevision(db),
    superseded, cached: candidate.cached, warnings,
    candidateId: acceptanceRefs?.candidate.candidate_id ?? null,
    acceptanceRunId: acceptanceRefs?.runId ?? null,
    acceptancePolicy: acceptanceRefs?.policy ?? null,
  };
}
