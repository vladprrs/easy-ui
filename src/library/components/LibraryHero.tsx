import type { ReactElement } from "react";
import { panel } from "../../app/chrome";
import { library } from "../../app/strings/library";

export interface LibraryHeroProps {
  /** `null`, пока каталог грузится; после загрузки выбирает пустой подзаголовок. */
  componentCount: number | null;
}

/**
 * Хиро библиотеки объясняет ценность для продакта; технические счётчики остаются в секциях.
 */
export function LibraryHero({ componentCount }: LibraryHeroProps): ReactElement {
  return <header className={`${panel} px-8 py-9 sm:px-12 sm:py-11`}>
    <div className="min-w-0">
      <h1 className="pay-display text-[56px] leading-[0.86] text-eui-ink max-sm:text-[38px]">
        {library.heroTitle}
      </h1>
      <p className="mt-4 max-w-[46rem] text-[19px] font-medium text-eui-slate-700">
        {componentCount !== null && componentCount > 0 ? library.subtitle : library.subtitleEmpty}
      </p>
    </div>
  </header>;
}
