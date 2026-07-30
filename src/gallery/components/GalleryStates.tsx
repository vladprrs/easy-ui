import type { ReactElement } from "react";
import { Link } from "react-router";
import { headingPage, panel, panelPadded, pillGhost, pillPrimary } from "../../app/chrome";
import { common } from "../../app/strings/common";
import { gallery } from "../../app/strings/gallery";

/**
 * Состояния галереи (макет 07). Бренд не определяет моушен, поэтому скелетоны
 * пульсируют только прозрачностью и ничего не двигают; плейсхолдеры — тинты
 * тёмного пурпура на лавандовом тинте, без серых Tailwind.
 */
export function GallerySkeletons(): ReactElement {
  return (
    <div aria-live="polite">
      <p className="sr-only">{gallery.loading}</p>
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="rounded-panel bg-pay-lavender-tint pay-skeleton motion-reduce:animate-none">
            <div className="h-[196px] rounded-t-panel bg-pay-deep/[0.06]" />
            <div className="space-y-3 p-5">
              <div className="h-4 w-1/2 rounded-full bg-pay-deep/10" />
              <div className="h-3 w-3/4 rounded-full bg-pay-deep/[0.08]" />
              <div className="h-3 w-1/3 rounded-full bg-pay-deep/[0.08]" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function GalleryFailed({ onRetry }: { onRetry: () => void }): ReactElement {
  return (
    <div className={`${panelPadded} flex flex-col items-start`} role="alert">
      <span aria-hidden="true" className="pay-display grid h-[52px] w-[52px] place-items-center rounded-full bg-pay-red text-[28px] leading-none text-white">!</span>
      <p className="pay-display mt-4 text-[30px] leading-[0.9]">{gallery.apiUnavailable}</p>
      <button type="button" className={`${pillGhost} mt-5`} onClick={onRetry}>
        {common.retry}
      </button>
    </div>
  );
}

export function NoUsableSystems(): ReactElement {
  return (
    <section className={panelPadded}>
      <h2 className="pay-display text-[30px] leading-[0.9]">{gallery.noUsableSystemsTitle}</h2>
      <p className="mt-3 text-eui-slate-500">{gallery.noUsableSystemsBody}</p>
      <Link className={`${pillPrimary} mt-6`} to="/library">
        {gallery.createDesignSystem}
      </Link>
    </section>
  );
}

/** Мотив бренда: перекрывающиеся круги трёх брендовых цветов, без иллюстраций. */
function BrandCircles(): ReactElement {
  return (
    <div aria-hidden="true" className="relative h-[88px] w-[132px]">
      <span className="absolute left-0 top-0 h-[88px] w-[88px] rounded-full bg-pay-lavender" />
      <span className="absolute left-[62px] top-[22px] h-[44px] w-[44px] rounded-full bg-pay-lavender-light" />
      <span className="absolute left-[52px] top-[4px] h-5 w-5 rounded-full bg-pay-red" />
    </div>
  );
}

export function GalleryEmpty(props: {
  variant: "search" | "filtered" | "none";
  canCreate: boolean;
  onCreate: () => void;
}): ReactElement {
  const { variant, canCreate, onCreate } = props;
  if (variant === "search") {
    return <p className={`${panel} px-6 py-5 text-eui-slate-500`}>{gallery.emptySearch}</p>;
  }
  if (variant === "filtered") {
    return <p className={`${panel} px-6 py-5 text-eui-slate-500`}>{gallery.emptyFiltered}</p>;
  }
  return (
    <section className={`${panelPadded} flex flex-col items-start py-10`}>
      <BrandCircles />
      <h2 className={`${headingPage} mt-7`}>{gallery.emptyTitle}</h2>
      <p className="mt-3 text-eui-slate-500">{gallery.empty}</p>
      {/* Вторая кнопка сюда не ставится: когда систем нет, «Создать дизайн-систему»
          уже показывает NoUsableSystems — дубль ссылки сбивал бы фокус состояния. */}
      {canCreate ? (
        <button type="button" className={`${pillPrimary} mt-6`} onClick={onCreate}>
          {gallery.newPrototype}
        </button>
      ) : null}
    </section>
  );
}
