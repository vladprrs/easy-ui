import { z } from "zod";
import type { BaseComponentProps } from "@json-render/react";
import { space } from "easy-ui/runtime/v3";

const spaceToken = z.enum(["none", "xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl"]);

export const definition = {
  props: z.strictObject({
    bg: z.enum(["primary", "primaryLight", "secondary", "transparent"]).default("transparent"),
    overflow: z.enum(["visible", "hidden"]).default("visible"),
    radius: z.union([z.literal(0), z.literal(8), z.literal(12), z.literal(16), z.literal(20), z.literal(24)]).default(0),
    shadow: z.enum(["none", "low", "medium", "high"]).default("none"),
    padding: spaceToken.default("none"),
  }),
  events: [],
  slots: ["default"],
  atomicLevel: "atom" as const,
  layout: { version: 1 as const, spacing: ["padding"] as ("padding")[] },
  description: "Yandex Pay decorated surface primitive with source-matched backgrounds, radii, clipping, elevation and tokenized padding.",
  example: { bg: "primary", radius: 16, shadow: "low" },
};

type P = z.output<typeof definition.props>;
const bg = { primary: "var(--background-color-primary,#fff)", primaryLight: "var(--fill-color-default-50,#f2f3f5)", secondary: "var(--background-color-secondary,#f7f8fa)", transparent: "transparent" } as const;
const shadow = { none: "none", low: "var(--shadow-low,0 2px 8px rgba(0,0,0,.08))", medium: "var(--shadow-medium,0 8px 24px rgba(0,0,0,.12))", high: "var(--shadow-high,0 16px 40px rgba(0,0,0,.16))" } as const;

export default function YpBlock({ props, children }: BaseComponentProps<P>) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        background: bg[props.bg ?? "transparent"],
        overflow: props.overflow ?? "visible",
        borderRadius: props.radius ?? 0,
        boxShadow: shadow[props.shadow ?? "none"],
        padding: space(props.padding ?? "none"),
      }}
    >
      {children}
    </div>
  );
}
