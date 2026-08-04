import type { LibraryCatalogEntry } from "../api/client";
import { atomicRank } from "../designSystems/types";
import type { PreviewPriority } from "./preview/previewScheduler";

// Ярусы библиотеки (план 2026-07-31 §4.5). Все пять ярусов **взаимно исключительны и в сумме
// исчерпывают каталог**: каждая запись рендерится ровно один раз. `recommended` — не копия нижних
// секций, а повышение: попав на витрину, запись уходит из своего яруса. Иначе один и тот же
// компонент был бы двумя ссылками с одинаковым именем и двумя превью под одним ключом реестра
// смонтированных (бюджет ≤12 и его perf-гейт считали бы такую пару за одну карточку).

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

/**
 * `accepted` → 0, иначе 1 (RFC candidate-acceptance §7, волна R3c). Ступень стоит **перед**
 * визуальной: пройденная приёмка — более сильное свидетельство пригодности, чем совпавший
 * baseline. Пока promote с кандидатом не вошёл в практику, признак пуст у всего каталога и
 * ступень нейтральна — порядок витрины остаётся ровно прежним.
 */
const acceptanceRank = (entry: LibraryCatalogEntry): number => (entry.status.accepted ? 0 : 1);

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
 * Порядок витрины «рекомендуем» (спека §6 + R3c): объявленная роль → использование → приёмка →
 * визуальный статус → уровень сборки → локализованное имя. Последняя ступень — ключ записи: без неё две системы с
 * одноимённым компонентом дали бы неполный порядок, зависящий от порядка входа.
 */
function compareRecommended(a: LibraryCatalogEntry, b: LibraryCatalogEntry): number {
  return (Number(b.canonicalFor.length > 0) - Number(a.canonicalFor.length > 0))
    || (b.headUsageCount - a.headUsageCount)
    || (acceptanceRank(a) - acceptanceRank(b))
    || (visualRank(a) - visualRank(b))
    || (assemblyRank(b) - assemblyRank(a))
    || a.name.localeCompare(b.name, "ru")
    || libraryEntryKey(a).localeCompare(libraryEntryKey(b), "ru");
}

/**
 * Топ-12 записей витрины. Мёртвое (deprecated/rejected/blocked) не рекомендуем; заодно не
 * рекомендуем запись с объявленной заменой — витрина показывает то, что стоит брать. Повтор одной
 * и той же записи схлопывается по ключу: дубль внутри витрины был бы второй карточкой того же
 * компонента. Дедуп против нижних секций делает `partitionTiers` — повышение, а не копирование.
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
  const recommended = rankRecommended(entries);
  // Повышение: ключи витрины вычитаются из нижних ярусов, поэтому запись рендерится ровно один раз.
  const promoted = new Set(recommended.map(libraryEntryKey));
  const tiers: LibraryTiers = { recommended, high: [], molecules: [], atoms: [], retired: [] };
  for (const entry of entries) {
    if (promoted.has(libraryEntryKey(entry))) continue;
    tiers[tierOf(entry)].push(entry);
  }
  for (const tier of ["high", "molecules", "atoms", "retired"] as const) tiers[tier].sort(compareByName);
  return tiers;
}

/** Откуда пришёл запрос на превью: ярус карточки либо явное действие/префетч. */
export type PreviewIntent = LibraryTier | "explicit" | "prefetch";

/**
 * Приоритет задачи планировщика (план §4.5), либо `null` — «сам не встаёт в очередь».
 *
 * Приоритет 0 значит «выбрано пользователем», а не «атом»: атомы и лэйаут-нейтральные обёртки не
 * загружаются автоматически **ни в каком ярусе** (спека §5), включая витрину «Рекомендуем» —
 * иначе повышенный атом грузился бы раньше организмов. Поверхность, получившая `null`, рисует
 * кнопку «Показать превью» (`PreviewDisclosureButton`), и уже её нажатие даёт интент `explicit`
 * с приоритетом 0: такая очередь короткая, и ждать пользователь не должен.
 * Списанное грузим последним, вместе с префетчем за краем вьюпорта.
 */
export function previewPriorityFor(entry: LibraryCatalogEntry, intent: PreviewIntent): PreviewPriority | null {
  if (intent === "explicit") return 0;
  if (isAtomTier(entry) || intent === "atoms") return null;
  if (intent === "prefetch" || intent === "retired") return 3;
  if (intent === "molecules") return 2;
  return 1;
}
