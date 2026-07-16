import { z } from "zod";
import type { ComponentDefinition } from "../../definitions";

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
} satisfies ComponentDefinition;

export type HotspotProps = z.output<typeof hotspotDefinition.props>;
