import type { Database } from "bun:sqlite";
import { ApiError } from "../http";
import { figmaSchema, resolveProvenanceRaw } from "../figma";
import { ComponentRepo } from "../repos/components";
import { collectAndValidateComponentAssetRefs } from "../validation";
import { getLatestDesignSystemContent } from "../designSystems";
import { libraryCatalog } from "../routes/libraryCatalog";
import { architectureWarnings, checkSource } from "../routes/components";
import { compileComponent, typecheckComponent } from "./compile";
import { importValidated, materializeClientSource, materializeSource, sha256 } from "./pipeline";
import {
  assetRefsOf,
  candidateExpired,
  getCandidateBundle,
  readCandidate,
  sourceShapeHashOf,
  writeCandidate,
  type CandidateEntry,
} from "./candidates";

/**
 * Validate-префлайт head-ревизии (план 2026-08-02 P8): прогон publish-проверок БЕЗ создания
 * версии и без изменения public state. Набор проверок зафиксирован здесь и в контракте
 * (`server/contracts.ts`): provenance-поля → asset-refs → extraction+smoke → typecheck →
 * compile → import-верификация + parity-warnings. Гарантия «publish не упадёт на 422»
 * ограничена этим набором: canonical-role, reuse-гейт и прочие каталого-временные проверки
 * (`assertPublishRoleAvailable`, duplicateWarnings, atomic policy) остаются на publish и
 * receipt'ом НЕ покрываются.
 *
 * Ресурсы (1-CPU прод): конкурентность 1 на пользователя + общий cap, тяжёлая часть
 * (extract/typecheck/compile/import) кэшируется в candidate-кэше по `sourceHash`
 * (файлы, TTL 24 ч, потолок байт — `server/components/candidates.ts`).
 */

export const VALIDATE_USER_CONCURRENT = 1;
export const VALIDATE_GLOBAL_CONCURRENT = 2;

const inFlightUsers = new Set<string>();
let globalInFlight = 0;

/**
 * Опции слота. `system: true` — приоритетная схема плана §5 W1c: приёмка (`routes/acceptance.ts`,
 * оркестратор) конкурирует за **общий** cap `VALIDATE_GLOBAL_CONCURRENT`, но per-user множество
 * не трогает. Иначе владелец компонента, запустивший 8–15-минутный acceptance-run, получал бы
 * `429 validate_in_flight` на собственный интерактивный validate всё это время: `inFlightUsers`
 * ключуется userId, а системный путь ходит под тем же пользователем.
 *
 * Третьего слота сознательно нет (на 1 CPU это +1 тяжёлый typecheck поверх capture) — системный
 * вызов честно занимает один из двух общих.
 */
export type ValidateSlotOptions = { system?: boolean };

/** Троттлинг префлайта. 429 `validate_in_flight` — повтор той же учётки; 429 `queue_full` — общий cap. */
export async function withValidateSlot<T>(userId: string, run: () => Promise<T>, options: ValidateSlotOptions = {}): Promise<T> {
  const system = options.system === true;
  if (!system && inFlightUsers.has(userId)) throw new ApiError(429, "validate_in_flight", "A component validate run is already in flight for this user; retry after it finishes");
  if (globalInFlight >= VALIDATE_GLOBAL_CONCURRENT) throw new ApiError(429, "queue_full", "Component validate queue is full; retry later");
  if (!system) inFlightUsers.add(userId);
  globalInFlight++;
  try { return await run(); }
  finally { if (!system) inFlightUsers.delete(userId); globalInFlight--; }
}

/**
 * Provenance хранимой ревизии против текущей strict-схемы. Write-путь (`parseFigmaInput`)
 * отсекает неподдерживаемые поля на входе, но ревизия может прийти из импорта бандла или
 * пережить сужение схемы — publish-time 422 на `pageNodeId` (план §1.6) ловится теперь
 * здесь, до подготовки. Код `validation_failed` общий, поле — в `issues[].path`/`pointer`.
 */
function validateStoredFigma(db: Database, raw: string | null): void {
  if (raw === null) return;
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch {
    throw new ApiError(422, "validation_failed", "Stored figma provenance is not valid JSON", {
      issues: [{ path: ["figma"], message: "figma_json is not valid JSON" }],
    });
  }
  const parsed = figmaSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.flatMap((issue) =>
      issue.code === "unrecognized_keys"
        ? issue.keys.map((key) => ({ path: ["figma", key], message: `Unsupported figma provenance field: ${key}` }))
        : [{ path: ["figma", ...issue.path.map((part) => String(part))], message: issue.message }],
    );
    throw new ApiError(422, "validation_failed", "Stored figma provenance is invalid", { issues });
  }
  for (const assetId of parsed.data.referenceScreenshots ?? []) {
    if (!db.query("SELECT 1 ok FROM assets WHERE id=?").get(assetId)) {
      throw new ApiError(422, "asset_not_found", "A referenced screenshot asset does not exist", {
        issues: [{ path: ["figma", "referenceScreenshots"], message: `unknown asset: ${assetId}` }],
      });
    }
  }
}

const RENDER_FALLBACK = /\bprops\??\.([A-Za-z_$][\w$]*)\s*\?\?/g;

/**
 * Parity-warning «schema `.default()` ↔ render `??`-fallback» (P8, дешёвый compile-time
 * вариант §9.1 improvements-дока). Схемные дефолты читаются из `propsJsonSchema` (zod
 * сериализует `.default()` в ключ `default`), render-фолбэки — регэкспом по `props.x ?? …`.
 * Warn-only: компонент с дефолтом только в рендере молча расходится между потребителем,
 * который парсит пропсы схемой, и тем, кто рендерит сырые.
 */
export function parityWarnings(propsJsonSchema: unknown, source: string): string[] {
  const schemaDefaults = new Set<string>();
  const properties = (propsJsonSchema as { properties?: unknown } | undefined)?.properties;
  if (properties !== null && typeof properties === "object") {
    for (const [name, sub] of Object.entries(properties as Record<string, unknown>)) {
      if (sub !== null && typeof sub === "object" && Object.hasOwn(sub, "default")) schemaDefaults.add(name);
    }
  }
  const renderFallbacks = new Set<string>();
  for (const match of source.matchAll(RENDER_FALLBACK)) renderFallbacks.add(match[1]!);
  const warnings: string[] = [];
  for (const name of [...renderFallbacks].sort()) {
    if (schemaDefaults.has(name)) {
      warnings.push(`Parity: prop "${name}" has both a schema .default() and a render-time ?? fallback; the two values must stay identical or parse-time and render-time defaults will diverge`);
    } else {
      warnings.push(`Parity: prop "${name}" has a render-time ?? fallback but no schema .default(); consumers parsing props through the schema and consumers rendering raw props see different defaults`);
    }
  }
  return warnings;
}

type ComputedCandidate = CandidateEntry & { bundleJs?: string };

/**
 * Тяжёлая, источнико-чистая часть префлайта — зеркало шагов `publishComponent`
 * (`server/routes/components.ts`) над тем же durable-модулем, но без stage/activate:
 * проваленные ApiError (422/413/400) складываются в кэш как отрицательный результат,
 * неожиданные ошибки (500) не кэшируются вовсе.
 */
async function computeCandidate(dataDir: string, id: string, rev: number, source: string, sourceHash: string): Promise<ComputedCandidate> {
  // `sourceShapeHash`/`assetRefs` (W6) кладутся в **обе** ветви (ok и failure): они источнико-чисты
  // и считаются до тяжёлого префлайта, поэтому провал extraction не должен лишать импакт-анализ
  // доказательства формы.
  const base = {
    version: 1 as const,
    sourceHash,
    sourceShapeHash: sourceShapeHashOf(source),
    assetRefs: [...assetRefsOf(source)].sort(),
    componentIds: [id],
    createdAt: new Date().toISOString(),
  };
  try {
    const path = await materializeSource(dataDir, id, rev, source);
    const extracted = await checkSource(source, path, true);
    await typecheckComponent(path);
    let clientPath = path;
    if (extracted.serverOnly?.conformanceProps === true) {
      try { clientPath = await materializeClientSource(dataDir, id, rev, source, true); }
      catch (error) {
        throw new ApiError(422, "validation_failed", "Component is invalid", {
          issues: [{ path: ["source"], message: error instanceof Error ? error.message : String(error) }],
        });
      }
    }
    const compiled = await compileComponent(clientPath, { capabilities: extracted.meta?.capabilities });
    // Import-верификация тем же in-process импортом, что делает publish, но ключом
    // `validated@<sourceHash>`: publish-кэш `id@rev` не заселяется (см. pipeline.ts).
    try { await importValidated(sourceHash, path); }
    catch (error) {
      throw new ApiError(422, "validation_failed", "Component import verification failed", {
        issues: [{ path: ["source"], message: error instanceof Error ? error.message : String(error) }],
      });
    }
    return {
      ...base,
      ok: true,
      extracted,
      parityWarnings: parityWarnings(extracted.meta?.propsJsonSchema, source),
      bundleHash: compiled.bundleHash,
      hostAbiVersion: compiled.hostAbiVersion,
      bundleJs: compiled.compiledJs,
    };
  } catch (error) {
    if (error instanceof ApiError && (error.status === 422 || error.status === 413 || error.status === 400)) {
      return {
        ...base,
        ok: false,
        failure: {
          status: error.status,
          code: error.code,
          message: error.message,
          issues: error.details.issues as { path: (string | number)[]; message: string }[] | undefined,
        },
      };
    }
    throw error;
  }
}

async function getOrComputeCandidate(dataDir: string, id: string, rev: number, source: string, sourceHash: string): Promise<{ entry: CandidateEntry; cached: boolean }> {
  const existing = await readCandidate(dataDir, sourceHash);
  if (existing !== null && !candidateExpired(existing)) {
    // Бэкфил доказательств формы (W6) на записи, собранные до волны: они источнико-чисты, а
    // исходник у нас на руках — иначе первый ран после апгрейда навсегда остался бы без базиса.
    const shape = existing.sourceShapeHash === undefined || existing.assetRefs === undefined
      ? { sourceShapeHash: sourceShapeHashOf(source), assetRefs: [...assetRefsOf(source)].sort() }
      : {};
    const componentIds = existing.componentIds.includes(id) ? existing.componentIds : [...existing.componentIds, id];
    if (!existing.componentIds.includes(id) || Object.keys(shape).length > 0) {
      await writeCandidate(dataDir, { ...existing, ...shape, componentIds });
    }
    return { entry: { ...existing, ...shape, componentIds: [...new Set(componentIds)].sort() }, cached: true };
  }
  const computed = await computeCandidate(dataDir, id, rev, source, sourceHash);
  const { bundleJs, ...entry } = computed;
  await writeCandidate(dataDir, entry, bundleJs);
  return { entry, cached: false };
}

export type ValidateReceipt = {
  ok: true;
  cached: boolean;
  sourceHash: string;
  bundleHash: string;
  hostAbiVersion: number;
  themeVersion: number | null;
  catalogRevision: string;
  warnings: string[];
};

/**
 * Префлайт **только head-ревизии** (publish работает только с head; rev-адресный publish —
 * promote из RFC, план §5 R1-B3). Дешёвые db-зависимые проверки (provenance, asset-refs)
 * идут до кэша и на каждый вызов: их результат от состояния БД, а не от исходника.
 */
export async function validateComponentHead(db: Database, dataDir: string, id: string, userId: string, slot: ValidateSlotOptions = {}): Promise<ValidateReceipt> {
  const repo = new ComponentRepo(db);
  const head = repo.source(id);
  // Источник — **сырая** форма резолвера (RFC §6, триаж раунд2-B4): parsed-обёртка вернула бы
  // `null` на непарсящейся seq-записи, и префлайт ослеп бы ровно на той поломке, которую обязан
  // ловить 422-й.
  validateStoredFigma(db, resolveProvenanceRaw(db, id, head.rev));
  collectAndValidateComponentAssetRefs(db, head.source);
  const sourceHash = sha256(head.source);
  const { entry, cached } = await withValidateSlot(userId, () => getOrComputeCandidate(dataDir, id, head.rev, head.source, sourceHash), slot);
  if (!entry.ok) {
    const failure = entry.failure!;
    throw new ApiError(failure.status, failure.code, failure.message, failure.issues === undefined ? {} : { issues: failure.issues });
  }
  const extracted = entry.extracted!;
  const warnings = [...extracted.warnings, ...(entry.parityWarnings ?? [])];
  if (!extracted.meta!.atomicLevel) warnings.push("Atomic design level is not provided; component will be classified as Other");
  warnings.push(...architectureWarnings(db, id, extracted.meta!, head.source));
  const theme = getLatestDesignSystemContent(db, head.designSystem);
  // Тот же снапшот-контракт, что у `GET /api/catalog/library`: ревизия описывает каталог
  // на момент ответа, поэтому считается свежо, а не читается из кэша кандидата.
  const revision = db.transaction(() => libraryCatalog(db).catalogRevision)();
  return {
    ok: true,
    cached,
    sourceHash,
    bundleHash: entry.bundleHash!,
    hostAbiVersion: entry.hostAbiVersion!,
    themeVersion: theme.latestMetaVersion,
    catalogRevision: revision,
    warnings,
  };
}

// Реэкспорт lookup'а для следующей части W2 (draft-preview читает кандидата из screenshot-сервиса).
export { getCandidateBundle };

export type DraftCandidate = {
  rev: number;
  designSystem: string;
  assetIds: string[];
  sourceHash: string;
  /** Успешная запись candidate-кэша (extract + compile метаданные; сам бандл — в файле). */
  entry: CandidateEntry & { ok: true };
  cached: boolean;
};

/**
 * Обеспечение candidate-bundle для draft-preview (план 2026-08-02, P1b.1 — семантика
 * холодного кэша): если кандидат вычищен GC или не собирался, превью собирает его сам
 * через тот же `getOrComputeCandidate` под троттлингом P8 (`withValidateSlot`) и тем же
 * кэшем по `sourceHash`. Проваленный префлайт приезжает тем же ApiError, что отдаёт
 * validate, — превью сломанного драфта сообщает причину, а не «нет бандла».
 */
export async function ensureDraftCandidate(db: Database, dataDir: string, id: string, userId: string): Promise<DraftCandidate> {
  const repo = new ComponentRepo(db);
  const head = repo.source(id);
  const assetIds = collectAndValidateComponentAssetRefs(db, head.source);
  const sourceHash = sha256(head.source);
  const { entry, cached } = await withValidateSlot(userId, () => getOrComputeCandidate(dataDir, id, head.rev, head.source, sourceHash));
  if (!entry.ok) {
    const failure = entry.failure!;
    throw new ApiError(failure.status, failure.code, failure.message, failure.issues === undefined ? {} : { issues: failure.issues });
  }
  return { rev: head.rev, designSystem: head.designSystem, assetIds, sourceHash, entry: entry as CandidateEntry & { ok: true }, cached };
}

/**
 * Кандидат по **явной ревизии** (амендмент A10): acceptance-run снимает кадры того билда,
 * который был зафиксирован при создании кандидата, а не текущего head'а — за 8–15 минут
 * run'а head может уехать. Отличия от {@link ensureDraftCandidate}:
 * - исходник читается по `rev` (`repo.source(id, rev)`), а не по head;
 * - пересборки нет: бандл обязан лежать в candidate-кэше (материализован при создании
 *   кандидата), иначе `409 candidate_evicted` — пересобирать произвольный rev под
 *   validate-слотом здесь запрещено;
 * - проверяется физическое существование `bundle.js`, а не только запись `result.json`.
 * `sourceHash` кандидата сверяется с хэшем исходника ревизии: расхождение означает, что
 * пара `{rev, sourceHash}` не с этого компонента/ревизии.
 */
export async function getCandidateForRev(
  db: Database,
  dataDir: string,
  id: string,
  rev: number,
  sourceHash: string,
): Promise<DraftCandidate> {
  const repo = new ComponentRepo(db);
  const revision = repo.source(id, rev);
  if (sha256(revision.source) !== sourceHash) {
    throw new ApiError(409, "candidate_stale", `Candidate sourceHash does not match revision ${rev} of ${id}`);
  }
  const assetIds = collectAndValidateComponentAssetRefs(db, revision.source);
  const found = await getCandidateBundle(dataDir, id, sourceHash);
  if (!found) throw new ApiError(409, "candidate_evicted", "Candidate bundle is no longer available; re-create the candidate");
  return { rev: revision.rev, designSystem: revision.designSystem, assetIds, sourceHash, entry: found.entry as CandidateEntry & { ok: true }, cached: true };
}
