import type { ReactElement, ReactNode } from "react";
import { transition } from "./chrome";

/**
 * Тумблер бренда Пэй (макет 08). Заменяет нативные чекбоксы продукта: они
 * приносили в интерфейс системный серый и системный фокус, которых в бренде нет.
 *
 * Единственное движение в системе, которое разрешено этому примитиву, — сдвиг
 * кноба: он кодирует состояние, а не украшает переход. Всё остальное — только
 * смена цвета трека за ≤120ms.
 *
 * Подпись обязательна и приходит пропсом: она же служит доступным именем, а
 * `role="switch"` + `aria-checked` сообщают состояние вместо цвета.
 */
export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Видимая подпись справа от трека; по правилу W4 включает состояние. */
  label: ReactNode;
  disabled?: boolean;
  /** Подсказка под тумблером, связанная через `aria-describedby`. */
  describedBy?: string;
  className?: string;
}

export function Toggle({ checked, onChange, label, disabled = false, describedBy, className }: ToggleProps): ReactElement {
  return <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-describedby={describedBy}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={`inline-flex items-center gap-2 text-sm font-medium text-eui-ink disabled:opacity-50 ${className ?? ""}`}
  >
    <span
      aria-hidden="true"
      className={`relative h-[22px] w-[38px] shrink-0 rounded-full ${transition} ${checked ? "bg-pay-red" : "bg-pay-lavender"}`}
    >
      <span className={`absolute top-[3px] h-4 w-4 rounded-full bg-white transition-[left] duration-100 ${checked ? "left-[19px]" : "left-[3px]"}`} />
    </span>
    <span>{label}</span>
  </button>;
}
