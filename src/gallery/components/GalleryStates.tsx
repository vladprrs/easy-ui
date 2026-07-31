import type { ReactElement } from "react";
import { panel, pillGhost, pillPrimary } from "../../app/chrome";
import { EmptyState, ErrorState, Skeleton } from "../../app/states";
import { agentAuthoring } from "../../app/strings/agentAuthoring";
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
 * состояние, а объяснение, почему агенту сначала понадобятся компоненты. Когда список
 * пуст, тот же смысл ветвлением уезжает в `GalleryEmpty` — двух пустых состояний
 * подряд на экране не бывает.
 */
export function NoUsableSystems({ onBuild }: { onBuild: () => void }): ReactElement {
  return <EmptyState
    circles={false}
    title={gallery.noUsableSystemsTitle}
    description={gallery.noUsableSystemsBody}
    primary={<button type="button" className={pillPrimary} onClick={onBuild}>{agentAuthoring.cta}</button>}
  />;
}

export interface GalleryEmptyProps {
  variant: "search" | "filtered" | "none";
  hasUsableSystems: boolean;
  onBuild: () => void;
  onImport: () => void;
  onReset: () => void;
}

export function GalleryEmpty(props: GalleryEmptyProps): ReactElement {
  const { variant, hasUsableSystems, onBuild, onImport, onReset } = props;
  // Поиск и фильтры: карточек нет, но каталог не пуст — единственный полезный
  // выход отсюда «снять фильтры», поэтому состояние узкое и с одной кнопкой.
  if (variant !== "none") {
    return <section className={`${panel} flex flex-wrap items-center gap-4 px-6 py-5`}>
      <p className="text-eui-slate-500">{variant === "search" ? gallery.emptySearch : gallery.emptyFiltered}</p>
      <button type="button" className={pillGhost} onClick={onReset}>{gallery.resetFilters}</button>
    </section>;
  }
  const importAction = <button type="button" className={pillGhost} onClick={onImport}>{gallery.importBundle}</button>;
  // Прототипов нет вообще. Агент остаётся главным действием и сам добавит недостающие
  // компоненты; ветвится только объяснение текущего состояния каталога.
  return hasUsableSystems
    ? <EmptyState
      title={gallery.emptyTitle}
      description={gallery.empty}
      primary={<button type="button" className={pillPrimary} onClick={onBuild}>{agentAuthoring.cta}</button>}
      secondary={importAction}
    />
    : <EmptyState
      title={gallery.noUsableSystemsTitle}
      description={gallery.noUsableSystemsBody}
      primary={<button type="button" className={pillPrimary} onClick={onBuild}>{agentAuthoring.cta}</button>}
      secondary={importAction}
    />;
}
