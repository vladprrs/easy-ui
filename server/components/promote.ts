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
 * Идемпотентность/recovery: крах фазы A компенсируется `fail()`/`failStagingPublishes`, а
 * расширенный `already_published`-чек (`repos/components.ts:stage`) пропускает повторный
 * promote тех же `{baseRev, sourceHash}` — он создаёт версию с новым номером.
 */

export type PromoteSupersede = "auto" | "none";

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
};

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
  if (input.expectedCatalogRevision !== undefined) {
    const observed = currentCatalogRevision(db);
    if (observed !== input.expectedCatalogRevision) {
      throw new ApiError(409, "catalog_changed", "Catalog revision changed since the receipt was issued", { catalogRevision: observed });
    }
  }

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

  const warnings = [...extracted.warnings, ...(candidate.entry.parityWarnings ?? [])];
  if (!meta.atomicLevel) warnings.push("Atomic design level is not provided; component will be classified as Other");
  warnings.push(...architectureWarnings(db, input.id, meta, revision.source));
  warnings.push(...duplicateWarnings(db, { designSystem: revision.designSystem, id: input.id, name: repo.meta(input.id).name, source: revision.source, meta }));

  return {
    version: staged.version, rev: staged.rev, hostAbiVersion,
    sourceHash: actualSourceHash, bundleHash,
    themeVersion: getLatestDesignSystemContent(db, revision.designSystem).latestMetaVersion,
    catalogRevision: currentCatalogRevision(db),
    superseded, cached: candidate.cached, warnings,
  };
}
