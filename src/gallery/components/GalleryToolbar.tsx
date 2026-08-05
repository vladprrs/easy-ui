import type { ReactElement, ReactNode } from "react";
import { PROTOTYPE_KINDS, type PrototypeKind } from "../../api/client";
import { pillWhite, segmentActive, segmentIdle, segmentTrack } from "../../app/chrome";
import { gallery } from "../../app/strings/gallery";
import { kindsForTab, type GallerySort, type GalleryTab } from "../galleryModel";

export interface GalleryToolbarProps {
  tab: GalleryTab;
  onTabChange: (tab: GalleryTab) => void;
  systems: { id: string; name: string }[];
  selectedSystem: string | null;
  onSystemChange: (id: string | null) => void;
  kind: PrototypeKind | null;
  onKindChange: (kind: PrototypeKind | null) => void;
  query: string;
  onQueryChange: (query: string) => void;
  sort: GallerySort;
  onSortChange: (sort: GallerySort) => void;
  showSearch: boolean;
  /** Админу доступен сквозной раздел «Все» (чужие приватные прототипы). */
  isAdmin?: boolean;
}

const TABS: readonly [GalleryTab, string][] = [
  ["mine", gallery.tabMine],
  ["shared", gallery.tabShared],
  ["archive", gallery.tabArchive],
  ["service", gallery.tabService],
];

function tabsFor(isAdmin: boolean): readonly [GalleryTab, string][] {
  return isAdmin ? [...TABS, ["all", gallery.tabAll]] : TABS;
}

/** Белая пилюля-селект: выбранное значение читается прямо в пилюле, раскрывать нечего. */
function FilterSelect(props: { label: string; value: string; onChange: (value: string) => void; children: ReactNode }): ReactElement {
  return <label className="shrink-0">
    <span className="sr-only">{props.label}</span>
    <select className={`${pillWhite} max-w-[220px] appearance-none pr-4`} value={props.value} onChange={(event) => props.onChange(event.target.value)}>
      {props.children}
    </select>
  </label>;
}

/**
 * Тулбар галереи (макет 01) живёт прямо на лавандовой канве и занимает **один ряд**:
 * сегмент разделов · поиск · фильтры · сортировка.
 *
 * Фильтры — селекты, а не ряды чипов: чипы дизайн-систем и видов занимали над гридом
 * две строки, в которых выбранное значение всё равно приходилось искать глазами.
 * Фильтр вида показывается, только когда в текущем разделе есть из чего выбирать.
 */
export function GalleryToolbar(props: GalleryToolbarProps): ReactElement {
  const { tab, onTabChange, systems, selectedSystem, onSystemChange, kind, onKindChange, query, onQueryChange, sort, onSortChange, showSearch, isAdmin = false } = props;
  // Архив и «Все» показывают прототипы любого вида, поэтому фильтр там перечисляет всю таксономию.
  const kinds = kindsForTab(tab, PROTOTYPE_KINDS);
  const tabs = tabsFor(isAdmin);

  return (
    <section className="flex flex-wrap items-center gap-3">
      <div className={`${segmentTrack} max-w-full flex-nowrap overflow-x-auto`} aria-label={gallery.tabsAria}>
        {tabs.map(([id, label]) => (
          <button key={id} type="button" aria-pressed={tab === id} onClick={() => onTabChange(id)} className={tab === id ? segmentActive : segmentIdle}>
            {label}
          </button>
        ))}
      </div>
      {showSearch ? (
        <label className="max-sm:w-full sm:w-80">
          <span className="sr-only">{gallery.searchLabel}</span>
          <input
            type="search"
            className="w-full rounded-full bg-white px-5 py-2.5 text-sm text-eui-ink placeholder:text-eui-slate-400"
            value={query}
            placeholder={gallery.searchPlaceholder}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </label>
      ) : null}
      {systems.length > 1 ? (
        <FilterSelect label={gallery.systemFilterLabel} value={selectedSystem ?? ""} onChange={(value) => onSystemChange(value || null)}>
          <option value="">{`${gallery.systemFilterLabel}: ${gallery.filterAll}`}</option>
          {systems.map((system) => <option key={system.id} value={system.id}>{system.name}</option>)}
        </FilterSelect>
      ) : null}
      {kinds.length > 1 ? (
        <FilterSelect label={gallery.kindFilterLabel} value={kind ?? ""} onChange={(value) => onKindChange((value || null) as PrototypeKind | null)}>
          <option value="">{`${gallery.kindFilterLabel}: ${gallery.filterAll}`}</option>
          {kinds.map((id) => <option key={id} value={id}>{gallery.kindNames[id] ?? id}</option>)}
        </FilterSelect>
      ) : null}
      <label className="ml-auto flex shrink-0 items-center gap-2 text-sm text-eui-slate-500">
        <span className="sr-only">{gallery.sortLabel}</span>
        <select className={`${pillWhite} appearance-none pr-4`} value={sort} onChange={(event) => onSortChange(event.target.value as GallerySort)}>
          <option value="updated">{gallery.sortUpdated}</option>
          <option value="name">{gallery.sortName}</option>
        </select>
      </label>
    </section>
  );
}
