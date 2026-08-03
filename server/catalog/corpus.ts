/**
 * Сборка корпуса матчинга (план 2026-07-31 §3.1) и ревизии каталога (§3.4).
 *
 * **Всё синхронно, без единого `await`.** Эту функцию вызывает гейт создания изнутри
 * `db.transaction(() => …)`, где любой `await` молча коммитит транзакцию bun:sqlite и ломает
 * откат (план §1.2, подтверждено замером ревьюера). Поэтому здесь только `db.query().all()`
 * и чистые вычисления.
 *
 * Три источника:
 * 1. **Активные публикации — из авторитетных таблиц** (`activeCatalogRows` + `definition_meta`
 *    + `headUsageCounts` + deprecated-статус). Не из кэша отпечатков: иначе на день 1 после
 *    деплоя гейт не увидел бы ни одного прод-компонента и молча fail-open (план §1.2, A2).
 * 2. **Head-драфты** — компоненты без активной публикации. У драфта нет `definition_meta`,
 *    поэтому поле `meta` не передаётся **вовсе**: матчер обязан считать props/io/структурный
 *    отпечаток неприменимыми и перенормировать веса, иначе обход «создать драфт → опубликовать»
 *    переоткрывается молча (§3.2).
 * 3. **Шинглы** — через content-addressed кэш `component_fingerprints` с write-through.
 *    Промах кэша не меняет результат: корпус на холодной БД обязан быть идентичен корпусу
 *    после прогрева (критерий §3.6, покрыт тестом).
 *
 * Ревизия каталога считается **той же функцией**, что и в `GET /api/catalog/library`
 * (`catalogRevision`), и по **нефильтрованному** каталогу: два клиента с разными
 * `designSystem` обязаны видеть одну ревизию на одном состоянии БД. Побайтовое равенство с
 * ревизией библиотеки закреплено тестом.
 */

import type { Database } from "bun:sqlite";
import { catalogRevision, type CatalogRevisionSource } from "../catalogRevision";
import type { DefinitionMeta } from "../components/types";
import { ComponentFingerprintRepo, sourceSha256 } from "../repos/componentFingerprints";
import { activeCatalogRows } from "../routes/components";
import { headUsageCounts } from "../usageGraph";
import { sourceShingles } from "./fingerprint";
import type { CorpusCandidate } from "./matcher";
import { activeCompositionRevisionSources } from "./compositionRevisionSources";
import { compositionPropsJsonSchema, compositionStructure, slotNamesOf } from "./compositionSignature";

export interface CorpusSnapshot {
  /** Кандидаты **запрошенной** дизайн-системы: матчинг за её пределы не выходит (спека §3). */
  candidates: CorpusCandidate[];
  /** sha256 discovery-проекции **всего** каталога — та же строка, что отдаёт библиотека. */
  catalogRevision: string;
}

/** Идентичность каталога — пара `(designSystem, componentId)` (см. `libraryKey`). */
const key = (designSystem: string, id: string): string => `${designSystem} ${id}`;

/**
 * `(designSystem, componentId)` с **последней** публикацией в deprecated/superseded.
 * Семантика зеркалит `publishGroups` библиотеки: «устарел» — про последнюю публикацию пары,
 * а не про её активную версию (компонент живёт в каталоге старой active-версией).
 */
const DEPRECATED_STATUSES = new Set(["deprecated", "superseded"]);
function deprecatedKeys(db: Database): Set<string> {
  const rows = db.query(`SELECT p.component_id id, r.design_system ds, p.version, p.status
    FROM component_publishes p JOIN component_revisions r ON r.component_id=p.component_id AND r.rev=p.rev`)
    .all() as { id: string; ds: string; version: number; status: string }[];
  const latest = new Map<string, { version: number; status: string }>();
  for (const row of rows) {
    const group = latest.get(key(row.ds, row.id));
    if (group === undefined || row.version > group.version) latest.set(key(row.ds, row.id), { version: row.version, status: row.status });
  }
  const deprecated = new Set<string>();
  for (const [id, group] of latest) if (DEPRECATED_STATUSES.has(group.status)) deprecated.add(id);
  return deprecated;
}

type SourceRow = { id: string; version: number; rev: number; source: string };

/**
 * Исходники активных публикаций запрошенной системы: `component_revisions.source` по
 * `(component_id, rev)` активной публикации. Ограничение системой намеренное — читать
 * исходники всего каталога ради корпуса одной системы незачем.
 */
function activeSources(db: Database, designSystem: string): Map<string, { rev: number; source: string }> {
  const rows = db.query(`SELECT p.component_id id, p.version, p.rev, r.source
    FROM component_publishes p JOIN component_revisions r ON r.component_id=p.component_id AND r.rev=p.rev
    WHERE p.status='active' AND r.design_system=?`).all(designSystem) as SourceRow[];
  return new Map(rows.map((row) => [`${row.id} ${row.version}`, { rev: row.rev, source: row.source }]));
}

type DraftRow = { id: string; name: string; rev: number; source: string };

/**
 * Head-драфты: компоненты без **единой** активной публикации. Фильтры `c.deleted_at IS NULL`
 * и `ds.retired = 0` обязательны — надгробие и компонент отставленной системы не являются
 * целью переиспользования.
 */
function draftRows(db: Database, designSystem: string): DraftRow[] {
  return db.query(`SELECT c.id, c.name, r.rev, r.source
    FROM components c
    JOIN component_revisions r ON r.component_id=c.id AND r.rev=c.head_rev
    JOIN design_systems ds ON ds.id=r.design_system AND ds.retired=0
    WHERE c.deleted_at IS NULL AND r.design_system=?
      AND NOT EXISTS (SELECT 1 FROM component_publishes p WHERE p.component_id=c.id AND p.status='active')
    ORDER BY c.id`).all(designSystem) as DraftRow[];
}

/** Шинглы из кэша либо на лету + write-through. Результат от наличия кэша не зависит. */
function shinglesOf(cache: ComponentFingerprintRepo, id: string, rev: number, source: string): Set<string> {
  return new Set(cache.getOrCompute(id, rev, sourceSha256(source), () => [...sourceShingles(source)]));
}

/**
 * Head-ревизии живых композиций системы (W9, R1-M9). Берётся именно head, а не активная
 * публикация: композиция-дубль чаще всего ещё не опубликована, и корпус из одних публикаций
 * был бы слеп ровно к тому случаю, ради которого волна делается. `version` — последняя активная
 * публикация (0 у неопубликованной), `draft` — «активной публикации нет».
 */
interface CompositionRow { id: string; name: string; rev: number; doc: string; version: number | null }

function compositionRows(db: Database, designSystem: string): CompositionRow[] {
  return db.query(`SELECT c.id, c.name, r.rev, r.doc,
      (SELECT MAX(p.version) FROM composition_publishes p WHERE p.composition_id=c.id AND p.status='active') version
    FROM compositions c
    JOIN composition_revisions r ON r.composition_id=c.id AND r.rev=c.head_rev
    JOIN design_systems ds ON ds.id=c.design_system AND ds.retired=0
    WHERE c.deleted_at IS NULL AND c.design_system=?
    ORDER BY c.id`).all(designSystem) as CompositionRow[];
}

/** `(composition_id → число головных ревизий прототипов)`: одна агрегация вместо N запросов. */
function compositionHeadUsage(db: Database): Map<string, number> {
  const rows = db.query(`SELECT prc.composition_id id, COUNT(*) n
    FROM prototype_revision_compositions prc
    JOIN prototypes p ON p.id=prc.prototype_id AND p.head_rev=prc.rev
    GROUP BY prc.composition_id`).all() as { id: string; n: number }[];
  return new Map(rows.map((row) => [row.id, row.n]));
}

/** Композиции с последней публикацией в deprecated/superseded — та же семантика, что у компонентов. */
function deprecatedCompositions(db: Database): Set<string> {
  const rows = db.query(`SELECT composition_id id, version, status FROM composition_publishes`)
    .all() as { id: string; version: number; status: string }[];
  const latest = new Map<string, { version: number; status: string }>();
  for (const row of rows) {
    const group = latest.get(row.id);
    if (group === undefined || row.version > group.version) latest.set(row.id, { version: row.version, status: row.status });
  }
  const deprecated = new Set<string>();
  for (const [id, group] of latest) if (DEPRECATED_STATUSES.has(group.status)) deprecated.add(id);
  return deprecated;
}

/**
 * Композиционная часть корпуса. Документ читается **как есть** (без строгого парсинга схемы):
 * сигнатура обязана считаться и по черновику, а исключение на одной битой ревизии не имеет
 * права ронять поиск кандидатов по всей системе.
 */
export function collectCompositionCandidates(db: Database, designSystem: string): CorpusCandidate[] {
  const usage = compositionHeadUsage(db);
  const deprecated = deprecatedCompositions(db);
  const candidates: CorpusCandidate[] = [];
  for (const row of compositionRows(db, designSystem)) {
    let doc: Record<string, unknown>;
    try { doc = JSON.parse(row.doc) as Record<string, unknown>; } catch { continue; }
    const structure = compositionStructure(doc);
    const meta = doc as { description?: unknown; atomicLevel?: unknown; scope?: unknown; canonicalFor?: unknown; replacement?: unknown };
    const canonicalFor = Array.isArray(meta.canonicalFor) ? meta.canonicalFor.filter((role): role is string => typeof role === "string") : [];
    candidates.push({
      kind: "composition", id: row.id, name: row.name, designSystem,
      version: row.version ?? 0,
      draft: row.version === null,
      description: typeof meta.description === "string" ? meta.description : "",
      ...(typeof meta.atomicLevel === "string" ? { atomicLevel: meta.atomicLevel } : {}),
      ...(typeof meta.scope === "string" ? { scope: meta.scope } : {}),
      canonicalFor,
      ...(typeof meta.replacement === "string" ? { replacement: meta.replacement } : {}),
      deprecated: deprecated.has(row.id),
      headUsageCount: usage.get(row.id) ?? 0,
      meta: { propsJsonSchema: compositionPropsJsonSchema(doc.params), events: [], slots: slotNamesOf(doc.slots) },
      // Слот шинглов TSX у композиции пуст: её тело описывает `structure`.
      shingles: new Set<string>(),
      ...(structure === undefined ? {} : { structure: { shingles: structure.shingles, fingerprint: structure.fingerprint } }),
    });
  }
  return candidates;
}

export interface CollectCorpusOptions {
  /**
   * Включать ли композиции системы (W9). **Дефолт `false` осознанно**: тот же корпус потребляет
   * гейт создания компонента (`matchReuseProposal`), а гейт умеет выдавать 409
   * `component_reuse_required`. Композиционная семантика гейта в W9 не включается, поэтому
   * композиции видны только там, где ответ рекомендательный — в discovery-роуте кандидатов.
   */
  includeCompositions?: boolean;
}

export function collectCorpus(db: Database, designSystem: string, options: CollectCorpusOptions = {}): CorpusSnapshot {
  const rows = activeCatalogRows(db);
  const usage = headUsageCounts(db);
  const deprecated = deprecatedKeys(db);
  const sources = activeSources(db, designSystem);
  const cache = new ComponentFingerprintRepo(db);

  const revisionSources: CatalogRevisionSource[] = [];
  const candidates: CorpusCandidate[] = [];

  for (const row of rows) {
    const meta = JSON.parse(row.definition_meta) as DefinitionMeta;
    // Проекция ревизии перечисляет поля явно (см. `catalogRevision.ts`) и собирается по всему
    // каталогу, а не по одной системе.
    revisionSources.push({
      kind: "component", designSystem: row.design_system, id: row.id, version: row.version,
      description: meta.description ?? "",
      ...(meta.atomicLevel === undefined ? {} : { atomicLevel: meta.atomicLevel }),
      ...(meta.scope === undefined ? {} : { scope: meta.scope }),
      canonicalFor: meta.canonicalFor ?? [],
      ...(meta.replacement === undefined ? {} : { replacement: meta.replacement }),
      meta: { propsJsonSchema: meta.propsJsonSchema, events: meta.events, slots: meta.slots },
    });
    if (row.design_system !== designSystem) continue;

    const revision = sources.get(`${row.id} ${row.version}`);
    candidates.push({
      kind: "component", id: row.id, name: row.name, designSystem: row.design_system, version: row.version,
      draft: false,
      description: meta.description ?? "",
      ...(meta.atomicLevel === undefined ? {} : { atomicLevel: meta.atomicLevel }),
      ...(meta.scope === undefined ? {} : { scope: meta.scope }),
      canonicalFor: meta.canonicalFor ?? [],
      ...(meta.replacement === undefined ? {} : { replacement: meta.replacement }),
      deprecated: deprecated.has(key(row.design_system, row.id)),
      headUsageCount: usage.get(row.id) ?? 0,
      meta: { propsJsonSchema: meta.propsJsonSchema, events: meta.events, slots: meta.slots },
      // Публикация без ревизии-источника физически невозможна (FK component_publishes →
      // component_revisions), но пустое множество здесь честнее исключения: сигнал исходника
      // просто станет неприменимым.
      shingles: revision === undefined ? new Set<string>() : shinglesOf(cache, row.id, revision.rev, revision.source),
    });
  }

  for (const row of draftRows(db, designSystem)) {
    candidates.push({
      kind: "component", id: row.id, name: row.name, designSystem, version: 0,
      // `meta` не передаётся вовсе: у драфта нет `definition_meta`. Драфт ловится шинглами и
      // именем, а не структурным отпечатком — честная граница §5 плана.
      draft: true,
      description: "",
      canonicalFor: [],
      deprecated: false,
      headUsageCount: usage.get(row.id) ?? 0,
      shingles: shinglesOf(cache, row.id, row.rev, row.source),
    });
  }

  if (options.includeCompositions === true) candidates.push(...collectCompositionCandidates(db, designSystem));

  revisionSources.push(...activeCompositionRevisionSources(db));
  return { candidates, catalogRevision: catalogRevision(revisionSources) };
}
