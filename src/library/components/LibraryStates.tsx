import { useEffect, type ReactElement } from "react";
import { headingDialog, headingPage, panel, panelPadded, pillGhost, pillPrimary } from "../../app/chrome";
import { library } from "../../app/strings/library";

/**
 * Состояния библиотеки (макет 07). Скелетоны пульсируют только прозрачностью:
 * бренд не определяет моушен, движения на экране нет.
 */
export function LibrarySkeletons(): ReactElement {
  return <div aria-live="polite">
    <p className="sr-only">{library.loading}</p>
    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
      {Array.from({ length: 6 }, (_, index) => <div key={index} className="rounded-panel bg-pay-lavender-tint pay-skeleton motion-reduce:animate-none">
        <div className="h-[170px] rounded-t-panel bg-pay-deep/[0.06]" />
        <div className="space-y-3 p-5">
          <div className="h-4 w-1/2 rounded-full bg-pay-deep/10" />
          <div className="h-3 w-3/4 rounded-full bg-pay-deep/[0.08]" />
          <div className="h-3 w-1/3 rounded-full bg-pay-deep/[0.08]" />
        </div>
      </div>)}
    </div>
  </div>;
}

export function LibraryFailed({ label, onRetry }: { label: string; onRetry: () => void }): ReactElement {
  return <div className={`${panelPadded} flex flex-col items-start`} role="alert">
    <span aria-hidden="true" className="pay-display grid h-[52px] w-[52px] place-items-center rounded-full bg-pay-red text-[28px] leading-none text-white">!</span>
    <p className="pay-display mt-4 text-[30px] leading-[0.9]">{label}</p>
    <button type="button" className={`${pillGhost} mt-5`} onClick={onRetry}>{library.retry}</button>
  </div>;
}

/** Мотив бренда: перекрывающиеся круги трёх брендовых цветов, без иллюстраций. */
function BrandCircles(): ReactElement {
  return <div aria-hidden="true" className="relative h-[88px] w-[132px]">
    <span className="absolute left-0 top-0 h-[88px] w-[88px] rounded-full bg-pay-lavender" />
    <span className="absolute left-[62px] top-[22px] h-[44px] w-[44px] rounded-full bg-pay-lavender-light" />
    <span className="absolute left-[52px] top-[4px] h-5 w-5 rounded-full bg-pay-red" />
  </div>;
}

/** Компонентов нет вообще: единственный выход — публикация через API. */
export function LibraryEmpty({ onPublish }: { onPublish: () => void }): ReactElement {
  return <section className={`${panelPadded} flex flex-col items-start py-10`}>
    <BrandCircles />
    <h2 className={`${headingPage} mt-7`}>{library.emptyTitle}</h2>
    <p className="mt-3 max-w-[42rem] text-eui-slate-500">{library.emptyDescription}</p>
    <button type="button" className={`${pillPrimary} mt-6`} onClick={onPublish}>{library.publishCta}</button>
  </section>;
}

/** Поиск и фильтры ничего не нашли: карточек нет, но каталог не пуст. */
export function LibraryNoMatches({ searching, onReset }: { searching: boolean; onReset: () => void }): ReactElement {
  return <section className={`${panel} flex flex-wrap items-center gap-4 px-6 py-5`}>
    <p className="text-eui-slate-500">{searching ? library.searchEmpty : library.emptyFiltered}</p>
    <button type="button" className={pillGhost} onClick={onReset}>{library.resetFilters}</button>
  </section>;
}

/**
 * Диалог публикации (макет 08). Авторинга компонентов в UI нет — вместо кнопки
 * в никуда экран честно показывает два запроса API и ссылку на описание.
 */
export function PublishDialog({ onClose }: { onClose: () => void }): ReactElement {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-pay-deep/55 p-6" onClick={onClose}>
    <section
      role="dialog"
      aria-modal="true"
      aria-label={library.publishDialogAria}
      className="w-full max-w-[460px] rounded-panel bg-white p-7"
      onClick={(event) => event.stopPropagation()}
    >
      <h2 className={headingDialog}>{library.publishDialogTitle}</h2>
      <p className="mt-3 text-sm text-eui-slate-500">{library.publishDialogBody}</p>
      <ol className="mt-5 space-y-3 text-sm">
        <li><span className="font-medium">1.</span> {library.emptyCreateStep} <code className="rounded-item bg-pay-lavender-tint px-1.5 py-0.5">POST /api/components</code></li>
        <li><span className="font-medium">2.</span> {library.emptyPublishStep} <code className="rounded-item bg-pay-lavender-tint px-1.5 py-0.5">POST /api/components/&#123;id&#125;/publish</code></li>
      </ol>
      <div className="mt-7 flex flex-wrap items-center gap-3">
        <a className={pillPrimary} href="/api/openapi.json">{library.emptyApiLink}</a>
        <button type="button" className={pillGhost} onClick={onClose}>{library.close}</button>
      </div>
    </section>
  </div>;
}
