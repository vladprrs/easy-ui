import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

// Фикстура W9 (drift-аудит): схема объявляет дефолт, capability — нет, компонент компенсирует
// дефолт сам. Ровно тот случай, который обязан давать предупреждение `runtime_default_drift`.
export const definition = {
  props: z.strictObject({
    label: z.string().min(1).describe("Badge label"),
    size: z.enum(["sm", "md", "lg"]).default("md").describe("Badge size"),
  }),
  events: [],
  slots: [],
  description: "Badge whose schema declares a default the host does not apply",
  example: { label: "Drift" },
};

type Props = z.input<typeof definition.props>;

export default function DriftBadge({ props }: EasyUIComponentProps<Props>) {
  const size = props.size ?? "md";
  return <output data-drift-badge data-size={size}>{props.label}</output>;
}
