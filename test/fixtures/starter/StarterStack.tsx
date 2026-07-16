import { z } from "zod";
import type { ReactNode } from "react";
import type { EasyUIComponentProps } from "easy-ui/runtime";

export const definition = {
  props: z.strictObject({ gap: z.enum(["none", "xs", "sm", "md", "lg", "xl"]).default("md") }),
  description: "Starter vertical stack",
  atomicLevel: "molecule" as const,
  slots: ["default"],
  layout: { version: 1 as const, spacing: ["gap"] as const, flow: { kind: "flex" as const, direction: "vertical" as const } },
  example: { gap: "md" },
};

export default function StarterStack({ props, children }: EasyUIComponentProps<{ gap: string }> & { children?: ReactNode }) {
  return <div data-gap={props.gap}>{children}</div>;
}
