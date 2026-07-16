import { z } from "zod";
import { spaceTokens } from "../../designSystems/types";
import type { ComponentDefinition } from "../definitions";

export const overlayPlacements = [
  "top",
  "bottom",
  "center",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
] as const;

export const overlayDefinition = {
  props: z.strictObject({
    placement: z.enum(overlayPlacements),
    inset: z.enum(spaceTokens).default("md"),
    scrim: z.boolean().default(false),
  }),
  slots: ["default"],
  atomicLevel: "atom",
  layoutNeutral: true,
  description: "Viewport-anchored content rendered into the current stage host.",
} satisfies ComponentDefinition;

export type OverlayProps = z.output<typeof overlayDefinition.props>;
