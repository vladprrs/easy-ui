import { z } from "zod";
import type { BaseComponentProps } from "@json-render/react";

export const definition = {
  props: z.strictObject({
    size: z.union([z.literal(4), z.literal(8), z.literal(12), z.literal(16), z.literal(20), z.literal(24)]).default(8),
    axis: z.enum(["vertical", "horizontal"]).default("vertical"),
  }),
  events: [],
  slots: [],
  atomicLevel: "atom" as const,
  layout: { version: 1 as const, spacer: true as const },
  description: "Deterministic Yandex Pay layout spacer for legacy documents; prefer gap on the parent for new layouts.",
  example: { size: 8, axis: "vertical" },
};

type Props = z.output<typeof definition.props>;

export default function YpSpacer({ props }: BaseComponentProps<Props>) {
  const size = props.size ?? 8;
  const axis = props.axis ?? "vertical";
  return (
    <span
      aria-hidden="true"
      style={{
        display: "block",
        width: axis === "horizontal" ? size : 1,
        minWidth: axis === "horizontal" ? size : 1,
        height: axis === "vertical" ? size : 1,
        minHeight: axis === "vertical" ? size : 1,
        flex: "0 0 auto",
      }}
    />
  );
}
