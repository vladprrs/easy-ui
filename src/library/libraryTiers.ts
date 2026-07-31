import type { LibraryCatalogEntry } from "../api/client";
import { atomicRank } from "../designSystems/types";
import type { PreviewPriority } from "./preview/previewScheduler";

// Ярусы библиотеки (план 2026-07-31 §4.5). Нижние ярусы (`high`/`molecules`/`atoms`/`retired`)
// **исчерпывающи и взаимно исключительны**: каждая запись каталога попадает ровно в один из них.
// `recommended` — не ярус, а витрина: она поднимает наверх копии тех же записей.

export type LibraryTier = "recommended" | "high" | "molecules" | "atoms" | "retired";

export interface LibraryTiers {
  recommended: LibraryCatalogEntry[];
  high: LibraryCatalogEntry[];
  molecules: LibraryCatalogEntry[];
  atoms: LibraryCatalogEntry[];
  retired: LibraryCatalogEntry[];
}

export const RECOMMENDED_LIMIT = 12;

/** Идентичность записи read-model — пара `(designSystem, id)`, как на сервере (`libraryKey`). */
export const libraryEntryKey = (entry: LibraryCatalogEntry): string => `${entry.designSystem} ${entry.id}`;

const HIGH_LEVELS = new Set(["page", "template", "organism"]);

/** Уровень сборки для сортировки: запись без `atomicLevel` беднее самого мелкого атома. */
const assemblyRank = (entry: LibraryCatalogEntry): number => (entry.atomicLevel ? atomicRank[entry.atomicLevel] : 0);

/** verified → 0, visualPending → 1, остальное → 2: проверенное показываем раньше ожидающего съёмки. */
const visualRank = (entry: LibraryCatalogEntry): number => (entry.status.verified ? 0 : entry.status.visualPending ? 1 : 2);

const isRetired = (entry: LibraryCatalogEntry): boolean => entry.deprecated || entry.replacement !== undefined;

/**
 * `layoutNeutral` перевешивает уровень сборки: у обёртки без собственной геометрии превью
 * показывать нечего независимо от того, организм это или атом, поэтому её место — в компактном
 * индексе рядом с атомами.
 */
const isAtomTier = (entry: LibraryCatalogEntry): boolean => entry.atomicLevel === "atom" || entry.layoutNeutral;

export function tierOf(entry: LibraryCatalogEntry): Exclude<LibraryTier, "recommended"> {
  if (isRetired(entry)) return "retired";
  if (isAtomTier(entry)) return "atoms";
  if (entry.atomicLevel !== undefined && HIGH_LEVELS.has(entry.atomicLevel)) return "high";
  return "molecules";
}

/**
 * Порядок витрины «рекомендуем» (спека §6): объявленная роль → использование → визуальный статус →
 * уровень сборки → локализованное имя. Последняя ступень — ключ записи: без неё две системы с
 * одноимённым компонентом дали бы неполный порядок, зависящий от порядка входа.
 */
function compareRecommended(a: LibraryCatalogEntry, b: LibraryCatalogEntry): number {
  return (Number(b.canonicalFor.length > 0) - Number(a.canonicalFor.length > 0))
    || (b.headUsageCount - a.headUsageCount)
    || (visualRank(a) - visualRank(b))
    || (assemblyRank(b) - assemblyRank(a))
    || a.name.localeCompare(b.name, "ru")
    || libraryEntryKey(a).localeCompare(libraryEntryKey(b), "ru");
}

/**
 * Топ-12 записей витрины. Мёртвое (deprecated/rejected/blocked) не рекомендуем; заодно не
 * рекомендуем запись с объявленной заменой — она уже уехала в ярус `retired`, и витрина обязана
 * дублировать только живые секции. Повтор одной и той же записи схлопывается по ключу: витрина
 * дублирует нижние ярусы, и дубль внутри неё самой был бы второй карточкой того же компонента.
 */
export function rankRecommended(entries: readonly LibraryCatalogEntry[], limit = RECOMMENDED_LIMIT): LibraryCatalogEntry[] {
  const seen = new Set<string>();
  const eligible: LibraryCatalogEntry[] = [];
  for (const entry of entries) {
    if (isRetired(entry) || entry.status.rejected || entry.status.blocked) continue;
    const key = libraryEntryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    eligible.push(entry);
  }
  return eligible.sort(compareRecommended).slice(0, limit);
}

/** Имя внутри яруса — единственный порядок, который видит пользователь; ключ добивает его до полного. */
const compareByName = (a: LibraryCatalogEntry, b: LibraryCatalogEntry): number =>
  a.name.localeCompare(b.name, "ru") || libraryEntryKey(a).localeCompare(libraryEntryKey(b), "ru");

export function partitionTiers(entries: readonly LibraryCatalogEntry[]): LibraryTiers {
  const tiers: LibraryTiers = { recommended: rankRecommended(entries), high: [], molecules: [], atoms: [], retired: [] };
  for (const entry of entries) tiers[tierOf(entry)].push(entry);
  for (const tier of ["high", "molecules", "atoms", "retired"] as const) tiers[tier].sort(compareByName);
  return tiers;
}

/** Откуда пришёл запрос на превью: ярус карточки либо явное действие/префетч. */
export type PreviewIntent = LibraryTier | "explicit" | "prefetch";

/**
 * Приоритет задачи планировщика (план §4.5). Явный выбор (поиск, раскрытие атома в компактном
 * индексе) и атомы — 0: атом грузится только по действию пользователя, поэтому его очередь короткая
 * и ждать он не должен. Списанное грузим последним, вместе с префетчем за краем вьюпорта.
 */
export function previewPriorityFor(entry: LibraryCatalogEntry, intent: PreviewIntent): PreviewPriority {
  if (intent === "explicit") return 0;
  if (intent === "prefetch" || intent === "retired") return 3;
  if (intent === "atoms" || entry.atomicLevel === "atom") return 0;
  if (intent === "molecules") return 2;
  return 1;
}
