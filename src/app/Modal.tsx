import { useCallback, useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { headingDialog, pillGhost, pillPrimary } from "./chrome";

/**
 * Модалка бренда Пэй (макет 08) — единственный корпус диалога в продукте.
 *
 * До этого примитива каждая модалка копировала бекдроп и панель руками, и почти
 * ни одна не закрывалась по Esc и не удерживала фокус: Tab уводил в фон, а после
 * закрытия фокус падал на <body>. Поэтому клавиатурный контракт живёт здесь, а не
 * в вызывающих экранах.
 *
 * Модалка монтируется только когда видима (`{open ? <Modal/> : null}`) — так
 * жизненный цикл фокуса совпадает с жизненным циклом компонента и не требует
 * отдельного пропа `open` с ветвлением внутри эффектов.
 *
 * Текст наружу: подписи приходят пропсами. Примитив ничего не знает о словарях
 * `strings/*`, поэтому русского в нём нет — иначе один и тот же ключ («Отмена»,
 * «Закрыть») жил бы и в словаре экрана, и здесь.
 */

/** Порядок важен: этот же список задаёт порядок Tab внутри панели. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

const focusablesIn = (root: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter((element) => element.tabIndex !== -1);

export interface ModalProps {
  /** Видимый заголовок; он же — `aria-labelledby` панели. */
  title: string;
  onClose: () => void;
  /**
   * Подпись крестика. Без неё крестик не рендерится: молчаливая иконка без
   * доступного имени хуже, чем её отсутствие (закрытие всегда есть на Esc и
   * на бекдропе).
   */
  closeLabel?: string;
  /** Ряд действий под содержимым — выравнивается вправо. */
  footer?: ReactNode;
  children?: ReactNode;
  /** Дополнительные классы панели (например `text-left` у вложенных форм). */
  className?: string;
}

export function Modal({ title, onClose, closeLabel, footer, children, className }: ModalProps): ReactElement {
  const panelRef = useRef<HTMLElement>(null);
  const titleId = useId();
  // Триггер запоминается на монтировании: к моменту размонтирования activeElement
  // уже внутри панели, и «вернуть фокус туда, откуда пришли» будет неоткуда взять.
  const triggerRef = useRef<Element | null>(null);

  useEffect(() => {
    triggerRef.current = document.activeElement;
    const panel = panelRef.current;
    if (panel) (focusablesIn(panel)[0] ?? panel).focus();
    return () => {
      const trigger = triggerRef.current;
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const items = focusablesIn(panel);
    if (!items.length) {
      // Панель без фокусируемого содержимого: держим фокус на ней самой,
      // иначе Tab уводит в фоновый документ под бекдропом.
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }, [onClose]);

  // Клик закрывает только по самому бекдропу: сверка с `currentTarget` отсекает
  // всплытие из панели, поэтому `stopPropagation` внутри содержимого не нужен.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-pay-deep/55 p-6"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`w-full max-w-[460px] rounded-panel bg-white p-7 ${className ?? ""}`}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id={titleId} className={headingDialog}>{title}</h2>
          {closeLabel === undefined ? null : (
            <button
              type="button"
              aria-label={closeLabel}
              className="-mr-1 -mt-1 shrink-0 rounded-full px-2 py-1 text-lg leading-none text-eui-slate-500 transition-colors duration-100 hover:text-eui-ink"
              onClick={onClose}
            >
              <span aria-hidden="true">✕</span>
            </button>
          )}
        </div>
        {children}
        {footer === undefined ? null : (
          <div className="mt-7 flex flex-wrap items-center justify-end gap-2">{footer}</div>
        )}
      </section>
    </div>,
    document.body,
  );
}

export interface ConfirmModalProps {
  title: string;
  /** Текст последствия: что именно произойдёт и обратимо ли это (S6). */
  body?: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  /** Подпись кнопки на время запроса; без неё подпись не меняется. */
  busyLabel?: string;
  busy?: boolean;
  error?: ReactNode;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * Подтверждение деструктива (S6). Отдельный компонент, а не проп у `Modal`:
 * у всех таких окон одинаковый корпус — заголовок, последствие, две кнопки, —
 * и повторять его в каждом вызове значит снова разъезжаться в подписях.
 */
export function ConfirmModal(props: ConfirmModalProps): ReactElement {
  const { title, body, confirmLabel, cancelLabel, busyLabel, busy = false, error, onConfirm, onClose } = props;
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={<>
        <button type="button" className={pillGhost} disabled={busy} onClick={onClose}>{cancelLabel}</button>
        <button type="button" className={pillPrimary} disabled={busy} onClick={onConfirm}>
          {busy && busyLabel !== undefined ? busyLabel : confirmLabel}
        </button>
      </>}
    >
      {body === undefined ? null : <p className="mt-3 text-sm text-eui-slate-500">{body}</p>}
      {error === undefined ? null : <p role="alert" className="mt-3 text-sm text-pay-red">{error}</p>}
    </Modal>
  );
}
