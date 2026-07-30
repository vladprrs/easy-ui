import type { ReactElement, ReactNode } from "react";
import { headingPage, panelPadded, pillGhost } from "./chrome";

/**
 * Состояния экранов в бренде Пэй (макет 07): скелетон, ошибка, пустота.
 *
 * Галерея и библиотека держали три почти совпадающие копии этих блоков —
 * расходились кегли заголовков и высота превью, а `animate-pulse` соседствовал
 * с `pay-skeleton`. Здесь один ритм и одна геометрия; различия зон выражаются
 * пропсами (высота превью, число плиток), а не отдельными компонентами.
 *
 * Весь текст приходит пропсами: примитив общий для галереи, библиотеки, плеера и
 * редактора, у каждого из которых свой словарь в `strings/*`.
 */

export interface SkeletonProps {
  /** Читается скринридером вместо мельтешения плиток. */
  label: string;
  /** Сколько карточек-заглушек показать (по умолчанию — экран галереи). */
  count?: number;
  /** Высота блока превью: 196 в галерее, 170 в библиотеке. */
  previewHeight?: number;
  /** Классы сетки — зона решает сама, сколько колонок ей нужно. */
  gridClassName?: string;
}

/**
 * Скелетон пульсирует только прозрачностью (`.pay-skeleton`, 1→.55 за 1.2s):
 * бренд не определяет моушен, поэтому на экране ничего не двигается и не
 * переливается. Плейсхолдеры — тинты тёмного пурпура, серых Tailwind нет.
 */
export function Skeleton(props: SkeletonProps): ReactElement {
  const { label, count = 6, previewHeight = 196, gridClassName = "grid gap-5 sm:grid-cols-2 lg:grid-cols-3" } = props;
  return <div aria-live="polite">
    <p className="sr-only">{label}</p>
    <div className={gridClassName} aria-hidden="true">
      {Array.from({ length: count }, (_, index) => <div key={index} className="rounded-panel bg-white pay-skeleton motion-reduce:animate-none">
        <div className="rounded-t-panel bg-pay-deep/[0.06]" style={{ height: previewHeight }} />
        <div className="space-y-3 p-5">
          <div className="h-4 w-1/2 rounded-full bg-pay-deep/10" />
          <div className="h-3 w-3/4 rounded-full bg-pay-deep/[0.06]" />
          <div className="h-3 w-1/3 rounded-full bg-pay-deep/[0.06]" />
        </div>
      </div>)}
    </div>
  </div>;
}

export interface ErrorStateProps {
  title: string;
  description?: ReactNode;
  /** Кнопка «Повторить» рисуется только вместе с обработчиком. */
  retryLabel?: string;
  onRetry?: () => void;
  /** Дополнительные действия рядом с «Повторить» (ссылка в галерею и т.п.). */
  actions?: ReactNode;
}

/**
 * Ошибка загрузки. Красный круг с «!» — единственный акцент состояния (S2),
 * поэтому заголовок остаётся чернильным, а не вторым красным.
 */
export function ErrorState({ title, description, retryLabel, onRetry, actions }: ErrorStateProps): ReactElement {
  const retry = retryLabel !== undefined && onRetry !== undefined
    ? <button type="button" className={pillGhost} onClick={onRetry}>{retryLabel}</button>
    : null;
  return <div className={`${panelPadded} flex flex-col items-start`} role="alert">
    <span aria-hidden="true" className="pay-display grid h-[52px] w-[52px] place-items-center rounded-full bg-pay-red text-[28px] leading-none text-white">!</span>
    <p className="pay-display mt-4 text-[30px] leading-[0.9]">{title}</p>
    {description === undefined ? null : <p className="mt-3 text-eui-slate-500">{description}</p>}
    {retry === null && actions === undefined ? null : <div className="mt-5 flex flex-wrap items-center gap-3">
      {retry}
      {actions}
    </div>}
  </div>;
}

/** Мотив бренда: три перекрывающихся круга вместо иллюстрации (лаванда 88 · #C6B1FD 44 · красный 20). */
export function BrandCircles(): ReactElement {
  return <div aria-hidden="true" className="relative h-[88px] w-[132px]">
    <span className="absolute left-0 top-0 h-[88px] w-[88px] rounded-full bg-pay-lavender" />
    <span className="absolute left-[62px] top-[22px] h-[44px] w-[44px] rounded-full bg-pay-lavender-light" />
    <span className="absolute left-[52px] top-[4px] h-5 w-5 rounded-full bg-pay-red" />
  </div>;
}

export interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  /** Главное действие состояния; второе — только если оно ведёт в другое место. */
  primary?: ReactNode;
  secondary?: ReactNode;
  /** Мотив-круги можно снять там, где состояние живёт внутри узкой панели. */
  circles?: boolean;
}

export function EmptyState({ title, description, primary, secondary, circles = true }: EmptyStateProps): ReactElement {
  return <section className={`${panelPadded} flex flex-col items-start py-10`}>
    {circles ? <BrandCircles /> : null}
    <h2 className={`${headingPage} ${circles ? "mt-7" : ""}`}>{title}</h2>
    {description === undefined ? null : <p className="mt-3 max-w-[42rem] text-eui-slate-500">{description}</p>}
    {primary === undefined && secondary === undefined ? null : <div className="mt-6 flex flex-wrap items-center gap-3">
      {primary}
      {secondary}
    </div>}
  </section>;
}
