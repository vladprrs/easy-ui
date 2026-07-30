import type { ReactElement } from "react";
import { panel, pillPrimary } from "../../app/chrome";
import { library } from "../../app/strings/library";

export interface LibraryHeroProps {
  /** `null`, пока каталог грузится: счётчиков в подзаголовке ещё нет. */
  counts: { components: number; systems: number } | null;
  onPublish: () => void;
}

/**
 * Хиро библиотеки (макет 06): белая панель, заголовок дисплейной гарнитурой 56,
 * акцент — ровно один фрагмент («живых») курсивом и красным.
 */
export function LibraryHero({ counts, onPublish }: LibraryHeroProps): ReactElement {
  return <header className={`${panel} px-8 py-9 sm:px-12 sm:py-11`}>
    <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
      <div className="min-w-0">
        <h1 className="pay-display text-[56px] leading-[0.86] text-eui-ink max-sm:text-[38px]">
          {library.heroPrefix} <span className="pay-accent">{library.heroAccent}</span> {library.heroRest}
        </h1>
        <p className="mt-4 max-w-[46rem] text-[19px] font-medium text-eui-slate-700">
          {counts && counts.components ? library.subtitle(counts.components, counts.systems) : library.subtitleEmpty}
        </p>
      </div>
      <button type="button" className={`${pillPrimary} max-sm:w-full`} onClick={onPublish}>{library.publishCta}</button>
    </div>
  </header>;
}
