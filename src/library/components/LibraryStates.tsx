import { useEffect, type ReactElement } from "react";
import { headingDialog, panel, pillGhost, pillPrimary } from "../../app/chrome";
import { EmptyState, ErrorState, Skeleton } from "../../app/states";
import { library } from "../../app/strings/library";

/**
 * Состояния библиотеки (макет 07) — тонкие обёртки над примитивами
 * `app/states.tsx`. Своя копия скелетона расходилась с галереей высотой превью и
 * тинтами плиток; теперь различие выражается пропом, а не вторым компонентом.
 */
export function LibrarySkeletons(): ReactElement {
  return <Skeleton label={library.loading} previewHeight={170} />;
}

export function LibraryFailed({ label, onRetry }: { label: string; onRetry: () => void }): ReactElement {
  return <ErrorState title={label} retryLabel={library.retry} onRetry={onRetry} />;
}

/** Компонентов нет вообще: единственный выход — публикация через API. */
export function LibraryEmpty({ onPublish }: { onPublish: () => void }): ReactElement {
  return <EmptyState
    title={library.emptyTitle}
    description={library.emptyDescription}
    primary={<button type="button" className={pillPrimary} onClick={onPublish}>{library.publishCta}</button>}
  />;
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
