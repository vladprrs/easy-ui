import type { ReactElement } from "react";
import { headingHero, inset, panel, pillGhost, pillPrimary } from "../../app/chrome";
import { agentAuthoring } from "../../app/strings/agentAuthoring";
import { gallery } from "../../app/strings/gallery";

export interface GalleryHeroProps {
  count: number | null;
  showActions: boolean;
  onBuild: () => void;
  onImport: () => void;
  notice: string | null;
}

/**
 * Хиро галереи (макет 01): белая панель, заголовок дисплейной гарнитурой 76/0.84,
 * акцент — ровно один фрагмент (число прототипов) курсивом и красным. Второй
 * акцент на экране бренд запрещает, поэтому подзаголовок и кнопки нейтральны.
 */
export function GalleryHero(props: GalleryHeroProps): ReactElement {
  const { count, showActions, onBuild, onImport, notice } = props;

  return (
    <header className={`${panel} px-8 py-9 sm:px-12 sm:py-11`}>
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
        <div className="min-w-0">
          <h1 className={`${headingHero} max-sm:text-[46px]`}>
            <span className="pay-accent">{count === null ? gallery.heroFallback : gallery.heroAccent(count)}</span>{" "}
            {gallery.heroRest(count)}
          </h1>
          <p className="mt-4 text-[19px] font-medium text-eui-slate-700">{gallery.subtitle(count)}</p>
        </div>
        {/* Ровно два действия (макет 01): импорт и главный CTA. «Экспортировать всё» —
            редкое сервисное действие, оно живёт тихой строкой под гридом. */}
        {showActions ? (
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={pillGhost} onClick={onImport}>
              {gallery.importButton}
            </button>
            <button type="button" className={`${pillPrimary} max-sm:w-full`} onClick={onBuild}>
              {agentAuthoring.cta}
            </button>
          </div>
        ) : null}
      </div>
      {notice !== null ? (
        <p className={`${inset} mt-7 px-5 py-4 text-[13px]`} role="status">
          {notice}
        </p>
      ) : null}
    </header>
  );
}
