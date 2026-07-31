import type { ReactElement } from "react";
import { pillGhost } from "../../app/chrome";
import { library } from "../../app/strings/library";

export interface PreviewDisclosureButtonProps {
  /** Раскрыто ли превью, которым управляет кнопка. */
  expanded: boolean;
  /** `id` зоны превью; связывается только когда зона существует в DOM. */
  controls: string;
  onToggle: () => void;
  className?: string;
}

/**
 * Единственная кнопка «Показать превью» библиотеки (план 2026-07-31 §4.5).
 *
 * Ею раскрывается всё, что не грузится само: атомы и лэйаут-нейтральные обёртки — и в компактном
 * индексе, и на карточке витрины, куда атом мог попасть повышением в «Рекомендуем». Кнопка одна,
 * чтобы клавиатурный контракт (`aria-expanded`/`aria-controls`) и строка были ровно одни.
 */
export function PreviewDisclosureButton({ expanded, controls, onToggle, className }: PreviewDisclosureButtonProps): ReactElement {
  return <button
    type="button"
    className={`${pillGhost} ${className ?? ""}`}
    aria-expanded={expanded}
    aria-controls={expanded ? controls : undefined}
    onClick={onToggle}
  >{library.compactShowPreview}</button>;
}
