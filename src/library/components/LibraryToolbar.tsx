import type { ReactElement } from "react";
import { chipActive, pillWhite, segmentActive, segmentIdle, segmentTrack } from "../../app/chrome";
import { library } from "../../app/strings/library";
import { libraryStatusLabel, type LibraryStatusKey } from "../libraryModel";

export type LibraryTab = "components" | "compositions";

export interface LibraryToolbarProps {
  tab: LibraryTab;
  onTabChange: (tab: LibraryTab) => void;
  systems: { id: string; name: string; count: number }[];
  /** `null` — «Все системы»: грид смешивает системы и показывает чип системы на карточке. */
  selectedSystem: string | null;
  onSystemChange: (id: string | null) => void;
  statusKeys: LibraryStatusKey[];
  activeStatus: LibraryStatusKey | null;
  onStatusChange: (key: LibraryStatusKey | null) => void;
  query: string;
  onQueryChange: (query: string) => void;
  showFilters: boolean;
}

/**
 * Тулбар библиотеки (макет 06) живёт прямо на лавандовой канве: сегмент разделов
 * на приглушённом треке, поиск и фильтры — белые пилюли.
 *
 * Фильтр статуса — одиночный выбор, а не набор тумблеров: пересечение нескольких
 * статусов пользователю ничего не объясняло, а «ни один не выбран» читалось как баг.
 */
export function LibraryToolbar(props: LibraryToolbarProps): ReactElement {
  const { tab, onTabChange, systems, selectedSystem, onSystemChange, statusKeys, activeStatus, onStatusChange, query, onQueryChange, showFilters } = props;
  return <section className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center gap-3">
      <div className={`${segmentTrack} max-w-full flex-nowrap overflow-x-auto`} aria-label={library.sectionsAria}>
        <button type="button" aria-pressed={tab === "components"} className={tab === "components" ? segmentActive : segmentIdle} onClick={() => onTabChange("components")}>{library.tabComponents}</button>
        <button type="button" aria-pressed={tab === "compositions"} className={tab === "compositions" ? segmentActive : segmentIdle} onClick={() => onTabChange("compositions")}>{library.tabCompositions}</button>
      </div>
      {showFilters ? <label className="max-sm:w-full sm:w-80">
        <span className="sr-only">{library.searchLabel}</span>
        <input
          type="search"
          className="w-full rounded-full bg-white px-5 py-2.5 text-sm text-eui-ink placeholder:text-eui-slate-400"
          value={query}
          placeholder={library.searchPlaceholder}
          onChange={(event) => onQueryChange(event.target.value)}
        />
      </label> : null}
    </div>
    {showFilters ? <div className="flex flex-nowrap gap-2 overflow-x-auto sm:flex-wrap" aria-label={library.designSystemsAria}>
      <button type="button" aria-pressed={selectedSystem === null} className={selectedSystem === null ? chipActive : `${pillWhite} px-3 py-1 text-xs`} onClick={() => onSystemChange(null)}>{library.allSystems}</button>
      {systems.map((system) => <button
        key={system.id}
        type="button"
        aria-pressed={selectedSystem === system.id}
        className={selectedSystem === system.id ? chipActive : `${pillWhite} px-3 py-1 text-xs`}
        onClick={() => onSystemChange(system.id)}
      >{system.name} · {system.count}</button>)}
    </div> : null}
    {showFilters && statusKeys.length ? <div className="flex flex-nowrap gap-2 overflow-x-auto sm:flex-wrap" aria-label={library.statusFiltersAria}>
      <button type="button" aria-pressed={activeStatus === null} className={activeStatus === null ? chipActive : `${pillWhite} px-3 py-1 text-xs`} onClick={() => onStatusChange(null)}>{library.allStatuses}</button>
      {statusKeys.map((key) => <button
        key={key}
        type="button"
        aria-pressed={activeStatus === key}
        className={activeStatus === key ? chipActive : `${pillWhite} px-3 py-1 text-xs`}
        onClick={() => onStatusChange(activeStatus === key ? null : key)}
      >{libraryStatusLabel[key]}</button>)}
    </div> : null}
  </section>;
}
