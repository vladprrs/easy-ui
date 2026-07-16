import { z } from "zod";
import type { ComponentDefinition } from "../../definitions";

export const imageObjectFits = ["contain", "cover", "fill", "none", "scale-down"] as const;

export const imageDefinition = {
  props: z.strictObject({
    src: z.string().min(1),
    alt: z.string(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    objectFit: z.enum(imageObjectFits).default("contain"),
  }),
  atomicLevel: "atom",
  description: "Host-rendered image with explicit alternative text and neutral object fitting.",
} satisfies ComponentDefinition;

export type ImageProps = z.output<typeof imageDefinition.props>;
