import type { ReactElement } from "react";
import { headingPage, kicker, pillGhost, pillPrimary, plate } from "../../app/chrome";
import { gallery } from "../../app/strings/gallery";

export interface GalleryHeroProps {
  count: number | null;
  showActions: boolean;
  canCreate: boolean;
  onCreate: () => void;
  onImport: () => void;
  notice: string | null;
}

export function GalleryHero(props: GalleryHeroProps): ReactElement {
  const { count, showActions, canCreate, onCreate, onImport, notice } = props;

  return (
    <header>
      <p className={kicker}>{gallery.kicker}</p>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <h1 className={headingPage}>{gallery.title}</h1>
          {count !== null ? (
            <p className="text-sm text-eui-slate-500">{gallery.countLabel(count)}</p>
          ) : null}
        </div>
        {showActions ? (
          <div className="flex flex-wrap items-center gap-2">
            <a className={pillGhost} href="/api/bundles/export">
              {gallery.exportAll}
            </a>
            <button type="button" className={pillGhost} onClick={onImport}>
              {gallery.importButton}
            </button>
            {canCreate ? (
              <button type="button" className={`${pillPrimary} w-full sm:w-auto`} onClick={onCreate}>
                {gallery.newPrototype}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <p className="mt-2 text-eui-slate-500">{gallery.subtitle}</p>
      {notice !== null ? (
        <p className={`${plate} mt-5 text-sm text-eui-brand`} role="status">
          {notice}
        </p>
      ) : null}
    </header>
  );
}
