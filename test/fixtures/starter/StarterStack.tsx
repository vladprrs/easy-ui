import { z } from "zod";
import type { ReactNode } from "react";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ gap: z.enum(["none", "xs", "sm", "md", "lg", "xl"]).default("md") }),
  description: "Starter vertical stack",
  atomicLevel: "molecule" as const,
  // Atomic policy: a TSX molecule must justify itself. Flow layout with a spacing scale is not
  // expressible by composition slots, so this stack stays irreducible code.
  ownership: { reason: "Owns vertical flow layout and the gap spacing scale, which composition slots cannot express" },
  slots: ["default"],
  layout: { version: 1 as const, spacing: ["gap"] as Array<"gap" | "padding" | "paddingX" | "paddingY">, flow: { kind: "flex" as const, direction: "vertical" as const } },
  example: { gap: "md" },
};

export default function StarterStack({ props, children }: EasyUIComponentProps<{ gap: string }> & { children?: ReactNode }) {
  return <div data-gap={props.gap}>{children}</div>;
}
