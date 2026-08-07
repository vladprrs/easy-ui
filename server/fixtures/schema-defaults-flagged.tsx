import { z } from "zod";
import type { EasyUIComponentProps } from "easy-ui/runtime";

// Та же схема, что у `schema-defaults-drift.tsx`, но компонент объявил
// `capabilities.runtimeSchemaDefaults`: дефолт применяет хост, фолбэка в коде нет,
// предупреждения о дрейфе быть не должно.
export const definition = {
  props: z.strictObject({
    label: z.string().min(1).describe("Badge label"),
    size: z.enum(["sm", "md", "lg"]).default("md").describe("Badge size"),
  }),
  events: [],
  slots: [],
  capabilities: { runtimeSchemaDefaults: true } as const,
  description: "Badge that lets the host apply schema defaults",
  example: { label: "Flagged" },
};

type Props = z.output<typeof definition.props>;

export default function FlaggedBadge({ props }: EasyUIComponentProps<Props>) {
  return <output data-flagged-badge data-size={props.size}>{props.label}</output>;
}
