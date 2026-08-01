// Шаблон атома yandex-pay-v2. Каждое стилевое значение здесь — ЗАГЛУШКА:
// реальные значения берутся из выписки Figma-ноды (notes/<id>.md), цвета — через color()
// с точным Figma-литералом в fallback, ключ токена должен существовать в теме.
import { z } from "zod";
import { color, space } from "easy-ui/runtime/v4"; // ровно ОДИН runtime-специфаер на модуль
import type { EasyUIComponentProps } from "easy-ui/runtime"; // type-only импорт — допустим

export const definition = {
  props: z.strictObject({
    text: z.string(),
    kind: z.enum(["primary", "secondary"]).default("primary"), // = component property из Figma
    disabled: z.boolean().default(false),
  }),
  events: { press: z.strictObject({}) }, // typed event; для выбора — payload с id
  description: "Primary action button for payment flows", // продуктовое описание, не техническое
  atomicLevel: "atom" as const,
  capabilities: { typedEvents: true } as const,
  interactive: true,
  accessibleLabelProps: ["text"],
  examples: {
    // минимум: дефолтный вид Figma + по набору на существенный вариант
    primary: { text: "Оплатить" },
    secondary: { text: "Отмена", kind: "secondary" },
    disabled: { text: "Оплатить", disabled: true },
  },
};

type Props = z.input<typeof definition.props>;

export default function PayButton({ props, emit }: EasyUIComponentProps<Props>) {
  // Renderer НЕ применяет Zod-дефолты: каждый .default(X) схемы → парный ?? X
  const kind = props.kind ?? "primary";
  const disabled = props.disabled ?? false;

  const palette = {
    primary: {
      background: color("button-primary-bg", "#7d40ff" /* ← из Figma variable */),
      foreground: color("button-primary-fg", "#ffffff"),
    },
    secondary: {
      background: color("button-secondary-bg", "#f2f3f5"),
      foreground: color("text-primary", "rgba(0,0,0,.86)"),
    },
  }[kind] ?? { background: color("button-primary-bg", "#7d40ff"), foreground: color("button-primary-fg", "#ffffff") };

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => emit("press", {})}
      style={{
        // метрики контрола — литералами из выписки Figma (не покрываются шкалой spacing)
        height: 56,
        borderRadius: 16,
        padding: `0 ${space("lg")}`,
        width: "fit-content", // hug, как в Figma; fill — только если так в макете

        border: "none",
        background: palette.background,
        color: palette.foreground,
        opacity: disabled ? 0.4 : 1, // ← значение состояния из Figma-варианта
        font: `500 16px/20px 'YS Text','Helvetica Neue',Arial,sans-serif`, // вес только из загруженных начертаний
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {props.text}
    </button>
  );
}
