import type { ReactElement } from "react";
import { Link } from "react-router";
import { panel, pillGhost, pillPrimary } from "../../app/chrome";
import { EmptyState, ErrorState, Skeleton } from "../../app/states";
import { common } from "../../app/strings/common";
import { gallery } from "../../app/strings/gallery";

/**
 * Состояния галереи (макет 07) — тонкие обёртки над примитивами `app/states.tsx`.
 *
 * Здесь остаётся только словарь и ветвление зоны: геометрия, ритм скелетона и
 * мотив-круги общие для галереи, библиотеки и остальных экранов, поэтому свои
 * копии этих блоков галерея больше не держит.
 */
export function GallerySkeletons(): ReactElement {
  return <Skeleton label={gallery.loading} />;
}

export function GalleryFailed({ onRetry }: { onRetry: () => void }): ReactElement {
  return <ErrorState title={gallery.apiUnavailable} retryLabel={common.retry} onRetry={onRetry} />;
}

/**
 * Систем с компонентами нет, но прототипы в галерее есть: это уже не пустое
 * состояние, а объяснение, почему пропала кнопка «Новый прототип». Когда список
 * пуст, тот же смысл ветвлением уезжает в `GalleryEmpty` — двух пустых состояний
 * подряд на экране не бывает.
 */
export function NoUsableSystems(): ReactElement {
  return <EmptyState
    circles={false}
    title={gallery.noUsableSystemsTitle}
    description={gallery.noUsableSystemsBody}
    primary={<Link className={pillPrimary} to="/library">{gallery.createDesignSystem}</Link>}
  />;
}

export interface GalleryEmptyProps {
  variant: "search" | "filtered" | "none";
  canCreate: boolean;
  onCreate: () => void;
  onImport: () => void;
  onReset: () => void;
}

export function GalleryEmpty(props: GalleryEmptyProps): ReactElement {
  const { variant, canCreate, onCreate, onImport, onReset } = props;
  // Поиск и фильтры: карточек нет, но каталог не пуст — единственный полезный
  // выход отсюда «снять фильтры», поэтому состояние узкое и с одной кнопкой.
  if (variant !== "none") {
    return <section className={`${panel} flex flex-wrap items-center gap-4 px-6 py-5`}>
      <p className="text-eui-slate-500">{variant === "search" ? gallery.emptySearch : gallery.emptyFiltered}</p>
      <button type="button" className={pillGhost} onClick={onReset}>{gallery.resetFilters}</button>
    </section>;
  }
  const importAction = <button type="button" className={pillGhost} onClick={onImport}>{gallery.importBundle}</button>;
  // Прототипов нет вообще. Ветка одна и та же по форме, разные только препятствие
  // и главное действие: либо создаём прототип, либо сначала дизайн-систему.
  return canCreate
    ? <EmptyState
      title={gallery.emptyTitle}
      description={gallery.empty}
      primary={<button type="button" className={pillPrimary} onClick={onCreate}>{gallery.newPrototype}</button>}
      secondary={importAction}
    />
    : <EmptyState
      title={gallery.noUsableSystemsTitle}
      description={gallery.noUsableSystemsBody}
      primary={<Link className={pillPrimary} to="/library">{gallery.createDesignSystem}</Link>}
      secondary={importAction}
    />;
}
