import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode } from "react";
import { pillGhost, popover, popoverItem, transition } from "./chrome";

/**
 * Меню-поповер бренда Пэй (макет 08) — общий для меню карточки галереи и «···»
 * плеера.
 *
 * Почему children, а не массив items. Пункты у обоих применений разнородные:
 * в галерее это `Link` react-router, кнопки экспорта с локальным busy-состоянием
 * и подменю версий с собственной загрузкой; в плеере — тумблеры и условные
 * пункты. Массив данных пришлось бы расширять до «отрендерь мне произвольный
 * узел», то есть до тех же children, но с лишним слоем схемы. Поэтому меню
 * владеет только оболочкой и клавиатурой, а роверинг считает по DOM —
 * `[role="menuitem"]` внутри панели. Это же автоматически включает в обход
 * пункты раскрытого подменю, не заводя вложенных структур состояния.
 *
 * Подписи приходят пропсами: примитив общий для зон с разными словарями.
 */

/**
 * Императивное закрытие меню изнутри содержимого.
 *
 * Без него потребители закрывали поповер пересозданием `Menu` через `key` — это
 * сбрасывало не только открытость, но и всё внутреннее состояние содержимого
 * (свёрнутые ветки дерева сценариев, раскрытые подменю). Контекст отдаёт ту же
 * функцию, что и Esc: закрыть **и вернуть фокус на триггер**, — иначе после
 * выбора пункта фокус оставался бы на исчезнувшем узле и падал на <body>.
 */
const MenuCloseContext = createContext<(() => void) | null>(null);

const noop = () => {};

/**
 * Закрыть меню-предок. Вне `Menu` — no-op, чтобы тот же пункт можно было
 * рендерить и вне поповера.
 *
 * Почему хук, а не проп-функция в children: пункт бывает вложен в подменю или в
 * собственный компонент вызывающей стороны, и протаскивать `close` вручную через
 * каждый такой слой значит заводить проп, который существует только ради одного
 * листа дерева.
 */
export function useMenuClose(): () => void {
  return useContext(MenuCloseContext) ?? noop;
}

const menuItemsIn = (panel: HTMLElement): HTMLElement[] =>
  [...panel.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .filter((item) => !item.hasAttribute("disabled") && item.getAttribute("aria-disabled") !== "true");

export interface MenuProps {
  /** Доступное имя триггера. */
  label: string;
  /** Видимое содержимое триггера; по умолчанию — глиф «···» из набора S5. */
  trigger?: ReactNode;
  triggerClassName?: string;
  /** Классы панели поверх пресета `popover` (ширина, выравнивание). */
  panelClassName?: string;
  /** Доступное имя самой панели, если оно должно отличаться от подписи триггера. */
  panelLabel?: string;
  /**
   * Плеер глушит глобальные ← → пока поповер открыт (план W4 §2) — состояние
   * раскрытия нужно ему наружу.
   */
  onOpenChange?: (open: boolean) => void;
  /** Мутация в полёте: Esc и клик вне не закрывают меню, пока она не осела. */
  locked?: boolean;
  children: ReactNode;
}

export function Menu({ label, trigger, triggerClassName, panelClassName, panelLabel, onOpenChange, locked = false, children }: MenuProps): ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  // Открытие с клавиатуры (↓ на триггере) обязано увести фокус в первый пункт,
  // открытие мышью — нет: иначе курсор и фокус расходятся по разным пунктам.
  const focusFirstRef = useRef(false);
  const lockedRef = useRef(locked);
  useEffect(() => { lockedRef.current = locked; }, [locked]);

  const change = useCallback((next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  }, [onOpenChange]);

  const closeAndReturn = useCallback(() => {
    change(false);
    triggerRef.current?.focus();
  }, [change]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (lockedRef.current) return;
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      change(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, change]);

  useEffect(() => {
    if (!open || !focusFirstRef.current) return;
    focusFirstRef.current = false;
    const panel = panelRef.current;
    if (panel) menuItemsIn(panel)[0]?.focus();
  }, [open]);

  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (!panel) return;
    if (event.key === "Escape") {
      if (lockedRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      closeAndReturn();
      return;
    }
    const items = menuItemsIn(panel);
    if (!items.length) return;
    const active = document.activeElement;
    const index = items.findIndex((item) => item === active);
    const focusAt = (next: number) => {
      event.preventDefault();
      items[(next + items.length) % items.length]?.focus();
    };
    if (event.key === "ArrowDown") focusAt(index + 1);
    else if (event.key === "ArrowUp") focusAt(index < 0 ? items.length - 1 : index - 1);
    else if (event.key === "Home") focusAt(0);
    else if (event.key === "End") focusAt(items.length - 1);
    else if (event.key === " " && active instanceof HTMLElement && active.tagName !== "BUTTON") {
      // На ссылках пробел скроллит страницу вместо активации — у пунктов меню
      // Enter и Space обязаны работать одинаково.
      event.preventDefault();
      active.click();
    }
  };

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    focusFirstRef.current = true;
    const panel = panelRef.current;
    if (open && panel) menuItemsIn(panel)[0]?.focus();
    else change(true);
  };

  return <div ref={rootRef} className="relative">
    <button
      ref={triggerRef}
      type="button"
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      className={triggerClassName ?? `${pillGhost} px-3 py-1.5`}
      onClick={() => change(!open)}
      onKeyDown={onTriggerKeyDown}
    >
      {trigger ?? <span aria-hidden="true" className="text-lg leading-none">···</span>}
    </button>
    {open ? <div
      ref={panelRef}
      id={panelId}
      role="menu"
      aria-label={panelLabel ?? label}
      onKeyDown={onPanelKeyDown}
      className={`${popover} absolute right-0 z-20 mt-2 w-64 ${panelClassName ?? ""}`}
    >
      <MenuCloseContext.Provider value={closeAndReturn}>{children}</MenuCloseContext.Provider>
    </div> : null}
  </div>;
}

/** Класс пункта — для чужих узлов (`Link` react-router) с `role="menuitem"`. */
export const menuItemClass = popoverItem;
/** Деструктивный пункт: красный и полужирный — единственный акцент меню (S2). */
export const menuItemDestructiveClass = `${popoverItem} font-medium text-pay-red`;

export interface MenuItemProps {
  children: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  destructive?: boolean;
  /**
   * Закрыть меню после выбора. По умолчанию выключено: часть пунктов —
   * тумблеры и переключатели, которым закрытие поповера противопоказано.
   */
  closeOnSelect?: boolean;
  className?: string;
}

export function MenuItem({ children, onSelect, disabled = false, destructive = false, closeOnSelect = false, className }: MenuItemProps): ReactElement {
  const close = useMenuClose();
  return <button
    type="button"
    role="menuitem"
    disabled={disabled}
    className={`${destructive ? menuItemDestructiveClass : menuItemClass} disabled:opacity-50 ${className ?? ""}`}
    onClick={() => { onSelect?.(); if (closeOnSelect) close(); }}
  >{children}</button>;
}

/** 1px лавандовая линия — одна из двух разрешённых «границ» бренда. */
export function MenuSeparator(): ReactElement {
  return <div role="separator" className="my-1 border-t border-pay-lavender" />;
}

/** Надпись над группой пунктов; сама фокус не принимает. */
export function MenuGroupLabel({ children }: { children: ReactNode }): ReactElement {
  return <p className="px-3 pb-1 pt-2 text-xs font-medium text-eui-slate-500">{children}</p>;
}

export interface MenuSubmenuProps {
  label: ReactNode;
  children: ReactNode;
  /** Вызывается один раз при первом раскрытии — там висит ленивая загрузка. */
  onOpen?: () => void;
}

/**
 * Подменю внутри поповера. Признак раскрытия — смена глифа `▸`→`▾` (S5):
 * вращать стрелку нельзя, движение в бренде не используется, а сам факт
 * раскрытия зрячему пользователю терять нельзя.
 */
export function MenuSubmenu({ label, children, onOpen }: MenuSubmenuProps): ReactElement {
  const [open, setOpen] = useState(false);
  const toggle = () => {
    if (!open) onOpen?.();
    setOpen(!open);
  };
  return <div>
    <button
      type="button"
      role="menuitem"
      aria-expanded={open}
      className={`${menuItemClass} justify-between`}
      onClick={toggle}
    >
      <span>{label}</span>
      <span aria-hidden="true" className={`text-eui-slate-400 ${transition}`}>{open ? "▾" : "▸"}</span>
    </button>
    {open ? <div className="pb-1 pl-3">{children}</div> : null}
  </div>;
}
