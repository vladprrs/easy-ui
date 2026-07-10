import type { BaseComponentProps } from "@json-render/react";
import { z } from "zod";

export const hotspotDefinition = {
  props: z.strictObject({
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
    ariaLabel: z.string().min(1),
  }),
  events: ["press"],
  description: "Transparent, keyboard-accessible absolute-positioned action area.",
};

type HotspotProps = z.output<typeof hotspotDefinition.props>;

export function Hotspot({ props, emit }: BaseComponentProps<HotspotProps>) {
  return (
    <button
      type="button"
      aria-label={props.ariaLabel}
      onClick={() => emit("press")}
      style={{
        position: "absolute",
        left: props.x,
        top: props.y,
        width: props.width,
        height: props.height,
        border: 0,
        padding: 0,
        background: "transparent",
      }}
    />
  );
}
