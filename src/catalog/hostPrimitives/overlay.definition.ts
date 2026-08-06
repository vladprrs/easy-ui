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
    /**
     * Владение прокруткой контента (план 2026-08-06 §W5 T5a, строка 10 фидбэка).
     *
     * `false` (дефолт) — контент **клипается** высотным инвариантом `maxHeight`: оверлей не может
     * вытечь за StageViewport. `true` — та же граница высоты, но контент внутри прокручивается
     * (`overflow-y:auto`) и цепочка прокрутки не уходит наружу (`overscroll-behavior:contain`),
     * то есть модалка владеет своим скроллом сама.
     */
    scroll: z.boolean().default(false),
  }),
  slots: ["default"],
  atomicLevel: "atom",
  layoutNeutral: true,
  description: "Viewport-anchored content rendered into the current stage host.",
} satisfies ComponentDefinition;

export type OverlayProps = z.output<typeof overlayDefinition.props>;
