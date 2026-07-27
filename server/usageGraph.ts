import type { Database } from "bun:sqlite";
import { ApiError } from "./http";
import { DEFAULT_PROTOTYPE_KIND } from "../src/api/client";
import { COMPOSITION_TYPE } from "../src/catalog/hostPrimitives/composition.definition";

// Граф использования компонентов (волна 3 §3.1). Источник правды — таблица пинов
// `prototype_revision_components`: она пишется на save/publish и точно отражает, какая
// ревизия какую версию компонента исполняет. Документ головной ревизии разбирается
// поверх пинов только ради точных ключей экранов/элементов — сам факт использования
// определяется пином, а не парсингом.
//
// Две принципиально разные оси:
//   currentHeadUsages — пины на головных ревизиях (что «живо» сейчас и что сломается,
//                       если компонент убрать);
//   immutableUsages   — пины на ревизиях, на которые ссылаются публикации
//                       (`prototype_publishes`): их бандлы обязаны исполняться вечно,
//                       поэтому такие пины никогда не делают компонент безопасным к удалению.

export interface ComponentScreenUsage { screenId: string; screenName: string; elementKeys: string[] }
export interface ComponentHeadUsage {
  prototypeId: string;
  name: string;
  kind: string;
  rev: number;
  componentVersion: number;
  screens: ComponentScreenUsage[];
}
export interface ComponentImmutableUsage { prototypeId: string; name: string; version: number; componentVersion: number }
export interface ComponentUsageReport {
  componentId: string;
  name: string;
  currentHeadUsages: ComponentHeadUsage[];
  immutableUsages: ComponentImmutableUsage[];
  versionsInUse: number[];
  safeToRemove: boolean;
}

/** Узел дерева `?format=tree`: прототип → экран → элемент. SPA-ссылки строит клиент. */
export interface UsageTreeNode { kind: "prototype" | "screen" | "element"; id: string; label: string; children?: UsageTreeNode[] }
export interface ComponentUsageTree extends Omit<ComponentUsageReport, "currentHeadUsages"> { format: "tree"; nodes: UsageTreeNode[] }

interface StoredScreen { id?: unknown; name?: unknown; spec?: { elements?: Record<string, { type?: unknown }> } }

/**
 * Внутренние элементы композиций, закреплённых за ревизией: `id композиции → ключи
 * элементов нужного типа`. Нужно, потому что документ хранится авторским — компонент,
 * использованный только внутри композиции, в самом документе не встречается, хотя пин
 * на него есть (пины считаются с раскрытого документа). Без этого drill-down по такому
 * компоненту был бы пустым.
 */
function compositionInnerKeys(db: Database, prototypeId: string, rev: number, componentName: string): Map<string, string[]> {
  const rows = db.query(`SELECT prc.composition_id compositionId,cr.doc
    FROM prototype_revision_compositions prc
    JOIN composition_publishes cp ON cp.composition_id=prc.composition_id AND cp.version=prc.composition_version
    JOIN composition_revisions cr ON cr.composition_id=cp.composition_id AND cr.rev=cp.rev
    WHERE prc.prototype_id=? AND prc.rev=?`).all(prototypeId, rev) as { compositionId: string; doc: string }[];
  const result = new Map<string, string[]>();
  for (const row of rows) {
    let doc: { spec?: { elements?: Record<string, { type?: unknown }> } };
    try { doc = JSON.parse(row.doc) as typeof doc; } catch { continue; }
    const elements = doc?.spec?.elements;
    if (!elements || typeof elements !== "object") continue;
    const keys = Object.entries(elements).filter(([, element]) => element?.type === componentName).map(([key]) => key).sort();
    if (keys.length) result.set(row.compositionId, keys);
  }
  return result;
}

/**
 * Ключи элементов головного документа, чей `type` совпадает с именем компонента, плюс
 * ключи внутри раскрытых композиций. Разбор намеренно оборонительный (без zod): даже
 * если сохранённый документ не проходит строгую схему, использование компонента остаётся
 * видимым — это диагностический граф.
 */
function screensUsing(docJson: string, componentName: string, compositionKeys?: Map<string, string[]>): ComponentScreenUsage[] {
  let doc: { screens?: unknown };
  try { doc = JSON.parse(docJson) as { screens?: unknown }; } catch { return []; }
  if (!Array.isArray(doc.screens)) return [];
  const result: ComponentScreenUsage[] = [];
  for (const raw of doc.screens as StoredScreen[]) {
    const elements = raw?.spec?.elements;
    if (!elements || typeof elements !== "object") continue;
    const elementKeys = Object.entries(elements)
      .flatMap(([key, element]) => {
        if (element?.type === componentName) return [key];
        // Раскрытая композиция: ключи вида `<hostKey>$<inner>` — тот же контракт, что и в рантайме.
        if (element?.type !== COMPOSITION_TYPE || !compositionKeys?.size) return [];
        const reference = (element as { props?: { composition?: unknown } }).props?.composition;
        if (typeof reference !== "string") return [];
        return (compositionKeys.get(reference) ?? []).map((inner) => `${key}$${inner}`);
      })
      .sort();
    if (!elementKeys.length) continue;
    result.push({
      screenId: typeof raw.id === "string" ? raw.id : "",
      screenName: typeof raw.name === "string" ? raw.name : typeof raw.id === "string" ? raw.id : "",
      elementKeys,
    });
  }
  return result;
}

function componentRow(db: Database, componentId: string): { id: string; name: string } {
  // Tombstone тоже должен иметь читаемый граф использования, поэтому deleted_at не фильтруется.
  const row = db.query("SELECT id,name FROM components WHERE id=?").get(componentId) as { id: string; name: string } | null;
  if (!row) throw new ApiError(404, "not_found", "Component not found");
  return row;
}

export function componentUsages(db: Database, componentId: string): ComponentUsageReport {
  const component = componentRow(db, componentId);
  const heads = db.query(`SELECT p.id prototypeId,p.name,p.kind,p.head_rev rev,prc.component_version componentVersion,r.doc
    FROM prototype_revision_components prc
    JOIN prototypes p ON p.id=prc.prototype_id AND p.head_rev=prc.rev
    JOIN prototype_revisions r ON r.prototype_id=prc.prototype_id AND r.rev=prc.rev
    WHERE prc.component_id=? ORDER BY p.name,p.id`).all(componentId) as
    { prototypeId: string; name: string; kind: string | null; rev: number; componentVersion: number; doc: string }[];
  const currentHeadUsages: ComponentHeadUsage[] = heads.map((row) => ({
    prototypeId: row.prototypeId,
    name: row.name,
    kind: row.kind ?? DEFAULT_PROTOTYPE_KIND,
    rev: row.rev,
    componentVersion: row.componentVersion,
    screens: screensUsing(row.doc, component.name, compositionInnerKeys(db, row.prototypeId, row.rev, component.name)),
  }));
  const immutableUsages = db.query(`SELECT pp.prototype_id prototypeId,p.name,pp.version,prc.component_version componentVersion
    FROM prototype_publishes pp
    JOIN prototypes p ON p.id=pp.prototype_id
    JOIN prototype_revision_components prc ON prc.prototype_id=pp.prototype_id AND prc.rev=pp.rev
    WHERE prc.component_id=? ORDER BY pp.prototype_id,pp.version`).all(componentId) as ComponentImmutableUsage[];
  const versionsInUse = [...new Set([
    ...currentHeadUsages.map((usage) => usage.componentVersion),
    ...immutableUsages.map((usage) => usage.componentVersion),
  ])].sort((a, b) => a - b);
  return {
    componentId: component.id,
    name: component.name,
    currentHeadUsages,
    immutableUsages,
    versionsInUse,
    // Публикация делает пин вечным: наличие любой immutable-ссылки снимает «безопасно удалить».
    safeToRemove: currentHeadUsages.length === 0 && immutableUsages.length === 0,
  };
}

export function componentUsageTree(db: Database, componentId: string): ComponentUsageTree {
  const { currentHeadUsages, ...rest } = componentUsages(db, componentId);
  const nodes: UsageTreeNode[] = currentHeadUsages.map((usage) => ({
    kind: "prototype",
    id: usage.prototypeId,
    label: usage.name,
    children: usage.screens.map((screen) => ({
      kind: "screen",
      id: screen.screenId,
      label: screen.screenName || screen.screenId,
      children: screen.elementKeys.map((key) => ({ kind: "element", id: key, label: key } satisfies UsageTreeNode)),
    } satisfies UsageTreeNode)),
  }));
  return { format: "tree", ...rest, nodes };
}

// --- Aggregate index with an invalidation stamp ---------------------------------------------

export interface CatalogUsagePrototype { prototypeId: string; name: string; kind: string; rev: number }
export interface CatalogUsageEntry { componentId: string; name: string; designSystem: string; headUsageCount: number; prototypes: CatalogUsagePrototype[] }
export interface CatalogUsageIndex { components: CatalogUsageEntry[] }

/**
 * Ключ инвалидации кэша агрегата: `MAX(prototypes.updated_at)`. Любая запись прототипа
 * (save/restore/publish/lifecycle) двигает `updated_at`, поэтому индекс не может остаться
 * протухшим. К штампу добавлен `COUNT(*)`: удаление прототипа не двигает максимум времени,
 * но меняет количество строк.
 */
export const USAGE_CACHE_INVALIDATION_KEY = "MAX(prototypes.updated_at)";

function usageCacheStamp(db: Database): string {
  const row = db.query("SELECT MAX(updated_at) stamp,COUNT(*) total FROM prototypes").get() as { stamp: string | null; total: number };
  return `${row.stamp ?? ""}|${row.total}`;
}

interface CacheEntry { stamp: string; bySystem: Map<string, CatalogUsageIndex> }
const cache = new WeakMap<Database, CacheEntry>();

const ALL_SYSTEMS = " all";

function computeCatalogUsages(db: Database, designSystem?: string): CatalogUsageIndex {
  const rows = db.query(`SELECT c.id componentId,c.name,c.design_system designSystem,
      p.id prototypeId,p.name prototypeName,p.kind,p.head_rev rev
    FROM components c
    LEFT JOIN prototype_revision_components prc ON prc.component_id=c.id
    LEFT JOIN prototypes p ON p.id=prc.prototype_id AND p.head_rev=prc.rev
    WHERE c.deleted_at IS NULL${designSystem === undefined ? "" : " AND c.design_system=?"}
    ORDER BY c.id,p.name,p.id`).all(...(designSystem === undefined ? [] : [designSystem])) as
    { componentId: string; name: string; designSystem: string; prototypeId: string | null; prototypeName: string | null; kind: string | null; rev: number | null }[];
  const byComponent = new Map<string, CatalogUsageEntry>();
  for (const row of rows) {
    let entry = byComponent.get(row.componentId);
    if (!entry) {
      entry = { componentId: row.componentId, name: row.name, designSystem: row.designSystem, headUsageCount: 0, prototypes: [] };
      byComponent.set(row.componentId, entry);
    }
    if (row.prototypeId === null || entry.prototypes.some((item) => item.prototypeId === row.prototypeId)) continue;
    entry.prototypes.push({ prototypeId: row.prototypeId, name: row.prototypeName ?? row.prototypeId, kind: row.kind ?? DEFAULT_PROTOTYPE_KIND, rev: row.rev ?? 0 });
  }
  for (const entry of byComponent.values()) entry.headUsageCount = entry.prototypes.length;
  return { components: [...byComponent.values()] };
}

export function catalogUsages(db: Database, designSystem?: string): CatalogUsageIndex {
  const stamp = usageCacheStamp(db);
  let entry = cache.get(db);
  if (!entry || entry.stamp !== stamp) { entry = { stamp, bySystem: new Map() }; cache.set(db, entry); }
  const key = designSystem ?? ALL_SYSTEMS;
  const hit = entry.bySystem.get(key);
  if (hit) return hit;
  const computed = computeCatalogUsages(db, designSystem);
  entry.bySystem.set(key, computed);
  return computed;
}

/** `componentId → headUsageCount` для манифеста каталога (тот же кэш). */
export function headUsageCounts(db: Database, designSystem?: string): Map<string, number> {
  return new Map(catalogUsages(db, designSystem).components.map((entry) => [entry.componentId, entry.headUsageCount]));
}
