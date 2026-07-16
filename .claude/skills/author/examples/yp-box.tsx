import { z } from "zod";
import type { BaseComponentProps } from "@json-render/react";
import { space } from "easy-ui/runtime/v3";

const spaceToken = z.enum(["none", "xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl"]);

export const definition = {
  props: z.strictObject({
    mode: z.enum(["box", "row", "col"]).default("row"),
    shrink: z.boolean().default(false),
    wrap: z.boolean().default(false),
    inline: z.boolean().default(false),
    justify: z.enum(["start", "center", "end", "between", "around", "evenly"]).default("start"),
    align: z.enum(["start", "center", "end", "baseline"]).default("start"),
    verticalAlign: z.enum(["default", "bottom"]).default("default"),
    width: z.enum(["auto", "full"]).default("auto"),
    height: z.enum(["auto", "fitContent", "full"]).default("auto"),
    gap: spaceToken.default("none"),
    padding: spaceToken.default("none"),
    paddingX: spaceToken.default("none"),
    paddingY: spaceToken.default("none"),
  }),
  events: [],
  slots: ["default"],
  atomicLevel: "atom" as const,
  layoutNeutral: true as const,
  layout: {
    version: 1 as const,
    spacing: ["gap", "padding", "paddingX", "paddingY"] as ("gap" | "padding" | "paddingX" | "paddingY")[],
    flow: {
      kind: "flex" as const,
      direction: { prop: "mode", vertical: ["col"], horizontal: ["row"], none: ["box"] },
      wrap: { prop: "wrap", enabled: [true] },
    },
  },
  description: "Yandex Pay JSON-safe Box, Row and Col layout primitive with tokenized gap and padding.",
  example: {},
};

type P = z.output<typeof definition.props>;
const jc = { start: "flex-start", center: "center", end: "flex-end", between: "space-between", around: "space-around", evenly: "space-evenly" } as const;
const ai = { start: "flex-start", center: "center", end: "flex-end", baseline: "baseline" } as const;

export default function YpBox({ props, children }: BaseComponentProps<P>) {
  const mode = props.mode ?? "row";
  const box = mode === "box";
  const height = props.height ?? "auto";
  return (
    <div
      style={{
        display: (props.inline ?? false) ? (box ? "inline-block" : "inline-flex") : (box ? "block" : "flex"),
        flex: (props.shrink ?? false) ? "0 0 auto" : "1 1 auto",
        maxWidth: "100%",
        flexDirection: mode === "col" ? "column" : "row",
        flexWrap: (props.wrap ?? false) ? "wrap" : "nowrap",
        justifyContent: jc[props.justify ?? "start"],
        alignItems: ai[props.align ?? "start"],
        verticalAlign: (props.verticalAlign ?? "default") === "bottom" ? "bottom" : undefined,
        width: (props.width ?? "auto") === "full" ? "100%" : undefined,
        height: height === "full" ? "100%" : height === "fitContent" ? "fit-content" : undefined,
        gap: space(props.gap ?? "none"),
        padding: space(props.padding ?? "none"),
        paddingInline: space(props.paddingX ?? "none"),
        paddingBlock: space(props.paddingY ?? "none"),
      }}
    >
      {children}
    </div>
  );
}
