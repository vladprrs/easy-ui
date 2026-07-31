import type { ReactElement } from "react";
import { panel, pillGhost, pillPrimary } from "../../app/chrome";
import { EmptyState, ErrorState, Skeleton } from "../../app/states";
import { agentAuthoring } from "../../app/strings/agentAuthoring";
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

/** Компонентов нет вообще: агент добавит и опубликует их в ходе сборки прототипа. */
export function LibraryEmpty({ onBuild }: { onBuild: () => void }): ReactElement {
  return <EmptyState
    title={library.emptyTitle}
    description={library.emptyDescription}
    primary={<button type="button" className={pillPrimary} onClick={onBuild}>{agentAuthoring.cta}</button>}
  />;
}

/** Поиск и фильтры ничего не нашли: карточек нет, но каталог не пуст. */
export function LibraryNoMatches({ searching, onReset }: { searching: boolean; onReset: () => void }): ReactElement {
  return <section className={`${panel} flex flex-wrap items-center gap-4 px-6 py-5`}>
    <p className="text-eui-slate-500">{searching ? library.searchEmpty : library.emptyFiltered}</p>
    <button type="button" className={pillGhost} onClick={onReset}>{library.resetFilters}</button>
  </section>;
}
