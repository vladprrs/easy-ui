import type { ReactElement } from "react";
import { PROTOTYPE_KINDS, type PrototypeKind } from "../../api/client";
import { chipActive, pillWhite, segmentActive, segmentIdle, segmentTrack } from "../../app/chrome";
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
}

const TABS: readonly [GalleryTab, string][] = [
  ["mine", gallery.tabMine],
  ["shared", gallery.tabShared],
  ["archive", gallery.tabArchive],
  ["service", gallery.tabService],
];

/**
 * Тулбар галереи (макет 01) живёт прямо на лавандовой канве, а не в панели:
 * сегмент разделов на приглушённом треке, поиск и фильтры — белые пилюли.
 */
export function GalleryToolbar(props: GalleryToolbarProps): ReactElement {
  const {
    tab,
    onTabChange,
    systems,
    selectedSystem,
    onSystemChange,
    kind,
    onKindChange,
    query,
    onQueryChange,
    sort,
    onSortChange,
    showSearch,
  } = props;
  // Архив показывает прототипы любого вида, поэтому чипы там перечисляют всю таксономию.
  const kinds = tab === "archive" ? [...PROTOTYPE_KINDS] : kindsForTab(tab, PROTOTYPE_KINDS);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className={`${segmentTrack} max-w-full flex-nowrap overflow-x-auto`} aria-label={gallery.tabsAria}>
          {TABS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={tab === id}
              onClick={() => onTabChange(id)}
              className={tab === id ? segmentActive : segmentIdle}
            >
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
        <label className="ml-auto flex shrink-0 items-center gap-2 text-sm text-eui-slate-500">
          <span className="sr-only sm:not-sr-only">{gallery.sortLabel}</span>
          <select
            className={`${pillWhite} appearance-none pr-4`}
            value={sort}
            onChange={(event) => onSortChange(event.target.value as GallerySort)}
          >
            <option value="updated">{gallery.sortUpdated}</option>
            <option value="name">{gallery.sortName}</option>
          </select>
        </label>
      </div>
      <div className="flex flex-nowrap gap-2 overflow-x-auto sm:flex-wrap" aria-label={gallery.designSystemsAria}>
        <button
          type="button"
          aria-pressed={selectedSystem === null}
          onClick={() => onSystemChange(null)}
          className={selectedSystem === null ? chipActive : `${pillWhite} px-3 py-1 text-xs`}
        >
          {gallery.allSystems}
        </button>
        {systems.map((system) => (
          <button
            key={system.id}
            type="button"
            aria-pressed={selectedSystem === system.id}
            onClick={() => onSystemChange(system.id)}
            className={selectedSystem === system.id ? chipActive : `${pillWhite} px-3 py-1 text-xs`}
          >
            {system.name}
          </button>
        ))}
      </div>
      <div className="flex flex-nowrap gap-2 overflow-x-auto sm:flex-wrap" aria-label={gallery.kindsAria}>
        <button
          type="button"
          aria-pressed={kind === null}
          onClick={() => onKindChange(null)}
          className={kind === null ? chipActive : `${pillWhite} px-3 py-1 text-xs`}
        >
          {gallery.allKinds}
        </button>
        {kinds.map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={kind === id}
            onClick={() => onKindChange(kind === id ? null : id)}
            className={kind === id ? chipActive : `${pillWhite} px-3 py-1 text-xs`}
          >
            {gallery.kindNames[id] ?? id}
          </button>
        ))}
      </div>
    </section>
  );
}
