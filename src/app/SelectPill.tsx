import type { ReactElement } from "react";
import { transition } from "./chrome";

/**
 * Селект-пилюля бренда Пэй (макет 08).
 *
 * Внутри остаётся нативный `<select>`: на телефоне он открывает системный
 * список — это единственный доступный способ выбора одним пальцем, и менять его
 * на поповер значило бы чинить внешний вид ценой мобильной доступности (ревью
 * m6). Меняется только оболочка: `appearance-none` снимает системную стрелку и
 * рамку, а вместо них — брендовая пилюля и текстовая каретка `▾` красным.
 *
 * Каретка лежит поверх поля, поэтому обязана быть `pointer-events-none`: иначе
 * клик по стрелке — самое очевидное место — не открывал бы список.
 */
export interface SelectPillOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectPillProps {
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectPillOption[];
  /** Доступное имя поля; видимой подписи у пилюли нет. */
  label: string;
  id?: string;
  disabled?: boolean;
  describedBy?: string;
  className?: string;
}

export function SelectPill(props: SelectPillProps): ReactElement {
  const { value, onChange, options, label, id, disabled = false, describedBy, className } = props;
  return <span className={`relative inline-flex items-center ${className ?? ""}`}>
    <select
      id={id}
      aria-label={label}
      aria-describedby={describedBy}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      className={`appearance-none rounded-full bg-pay-lavender py-2 pl-4 pr-9 text-sm font-medium text-eui-ink ${transition} hover:brightness-95 disabled:opacity-50 disabled:hover:brightness-100`}
    >
      {options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
    </select>
    <span aria-hidden="true" className="pointer-events-none absolute right-3.5 text-[18px] leading-none text-pay-red">▾</span>
  </span>;
}
