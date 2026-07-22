import type { ReactElement } from "react";
import { chip, chipActive, inputBase } from "../../app/chrome";
import { gallery } from "../../app/strings/gallery";
import type { GallerySort, GalleryTab } from "../galleryModel";

export interface GalleryToolbarProps {
  tab: GalleryTab;
  onTabChange: (tab: GalleryTab) => void;
  systems: { id: string; name: string }[];
  selectedSystem: string | null;
  onSystemChange: (id: string | null) => void;
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
];

export function GalleryToolbar(props: GalleryToolbarProps): ReactElement {
  const {
    tab,
    onTabChange,
    systems,
    selectedSystem,
    onSystemChange,
    query,
    onQueryChange,
    sort,
    onSortChange,
    showSearch,
  } = props;

  return (
    <section className="mt-6 rounded-3xl bg-eui-lav p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="inline-flex rounded-full bg-white p-1" aria-label={gallery.tabsAria}>
          {TABS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={tab === id}
              onClick={() => onTabChange(id)}
              className={
                tab === id
                  ? chipActive + " rounded-full px-4 py-2 text-sm"
                  : "rounded-full px-4 py-2 text-sm font-medium text-eui-ink transition-colors hover:bg-eui-lav focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-eui-brand"
              }
            >
              {label}
            </button>
          ))}
        </div>
        {showSearch ? (
          <label className="flex w-full flex-col gap-1.5 text-sm font-medium sm:w-72">
            {gallery.searchLabel}
            <span className="relative block">
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                fill="none"
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-eui-slate-400"
              >
                <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.6" />
                <path d="m14 14 3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              <input
                type="search"
                className={`${inputBase} w-full bg-white pl-9`}
                value={query}
                placeholder={gallery.searchPlaceholder}
                onChange={(event) => onQueryChange(event.target.value)}
              />
            </span>
          </label>
        ) : null}
      </div>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div
          className="flex flex-nowrap gap-2 overflow-x-auto sm:flex-wrap"
          aria-label={gallery.designSystemsAria}
        >
          <button
            type="button"
            aria-pressed={selectedSystem === null}
            onClick={() => onSystemChange(null)}
            className={selectedSystem === null ? chipActive : chip}
          >
            {gallery.allSystems}
          </button>
          {systems.map((system) => (
            <button
              key={system.id}
              type="button"
              aria-pressed={selectedSystem === system.id}
              onClick={() => onSystemChange(system.id)}
              className={selectedSystem === system.id ? chipActive : chip}
            >
              {system.name}
            </button>
          ))}
        </div>
        <label className="mt-3 flex shrink-0 items-center gap-2 text-sm font-medium sm:mt-0">
          {gallery.sortLabel}
          <select
            className={`${inputBase} bg-white`}
            value={sort}
            onChange={(event) => onSortChange(event.target.value as GallerySort)}
          >
            <option value="updated">{gallery.sortUpdated}</option>
            <option value="name">{gallery.sortName}</option>
          </select>
        </label>
      </div>
    </section>
  );
}
